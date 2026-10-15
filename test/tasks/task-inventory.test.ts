import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, expect, it } from "vitest"
import { completeTask } from "../../src/tasks/completion.js"
import { listCourseTasks } from "../../src/tasks/inventory.js"
import { createPrepTask } from "../../src/tasks/store.js"
import { inspectWorkspace } from "../../src/vault/workspace.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-task-inventory-"))
  roots.push(root)
  const vault = join(root, "vault")
  for (const course of ["CS101", "ECON101"]) {
    await mkdir(join(vault, course, "Week 01 - Oct 5"), { recursive: true })
    await writeFile(
      join(vault, course, "Week 01 - Oct 5/reading.md"),
      `${course} SOURCE_BODY_SENTINEL: compare marginal costs and benefits.\n`,
    )
  }
  const own = await createPrepTask(vault, "CS101", "2026-10-05")
  const other = await createPrepTask(vault, "ECON101", "2026-10-05")
  return { root, vault, own, other }
}

it("discovers a pending task after losing its ID without exposing bodies or another course", async () => {
  const { root, vault, own, other } = await fixture()
  const config = join(root, "config.json")
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "UNSET_TEST_INVENTORY_TOKEN" },
      vault: { path: vault },
      courses: { allowlist: [] },
    }),
  )
  const taskPath = join(vault, "_meta/tasks", own.id, "task.json")
  const briefPath = join(vault, "_meta/tasks", own.id, "TASK.md")
  const before = await Promise.all([taskPath, briefPath].map((path) => readFile(path)))
  const result = spawnSync(
    process.execPath,
    [
      resolve("dist/cli.js"),
      "task",
      "list",
      "--course",
      "CS101",
      "--status",
      "pending",
      "--config",
      config,
      "--json",
    ],
    { encoding: "utf8", timeout: 30_000 },
  )
  expect(result.status, result.stderr).toBe(0)
  const inventory = JSON.parse(result.stdout)
  expect(inventory).toMatchObject({
    course: "CS101",
    inventoryComplete: true,
    unreadableRecords: 0,
  })
  expect(inventory.tasks.map((task: { id: string }) => task.id)).toEqual([own.id])
  expect(result.stdout).not.toContain(other.id)
  expect(result.stdout).not.toContain("SOURCE_BODY_SENTINEL")
  expect(result.stdout).not.toContain("instructions")
  expect(await Promise.all([taskPath, briefPath].map((path) => readFile(path)))).toEqual(before)
})

it("filters validated saved completion without claiming current sources or output verification", async () => {
  const { root, vault, own } = await fixture()
  const candidate = join(root, "candidate.md")
  await writeFile(
    candidate,
    `Task: ${own.id}\n\n${own.requirements.map((heading) => `## ${heading}\nSynthetic structural acceptance only: compare the supplied marginal evidence. \`${own.sources[0]?.path}\``).join("\n\n")}`,
  )
  await completeTask(vault, own.id, candidate)
  await writeFile(
    join(vault, own.sources[0]?.path ?? ""),
    "Changed after completion; old snapshot remains private.",
  )
  expect((await listCourseTasks(vault, "CS101", "pending")).tasks).toEqual([])
  const result = await listCourseTasks(vault, "CS101", "completed")
  expect(result.tasks).toHaveLength(1)
  expect(result.tasks[0]).toMatchObject({ id: own.id, status: "completed" })
  expect(result.limitation).toContain("not verified")
})

it("reports malformed, linked and oversized records as an incomplete inventory without rewriting them", async () => {
  const { vault, own } = await fixture()
  const malformed = join(vault, "_meta/tasks", randomUUID())
  await mkdir(malformed)
  await writeFile(join(malformed, "task.json"), "PRIVATE_MALFORMED_SENTINEL")
  await symlink(malformed, join(vault, "_meta/tasks", randomUUID()), "dir")
  const oversized = join(vault, "_meta/tasks", randomUUID())
  await mkdir(oversized)
  await writeFile(join(oversized, "task.json"), "")
  await truncate(join(oversized, "task.json"), 50_000_001)
  const result = await listCourseTasks(vault, "CS101")
  expect(result.tasks.map((task) => task.id)).toEqual([own.id])
  expect(result.inventoryComplete).toBe(false)
  expect(result.unreadableRecords).toBe(3)
  expect(JSON.stringify(result)).not.toContain("PRIVATE_MALFORMED_SENTINEL")
  expect(await readFile(join(malformed, "task.json"), "utf8")).toBe("PRIVATE_MALFORMED_SENTINEL")
  expect((await inspectWorkspace(vault)).notices).toContain(
    "Private task inventory is incomplete; inspect saved records",
  )
  await expect(listCourseTasks(vault, "unknown")).rejects.toThrow(/No course matches/)
})

it("reads and completes the original recipe in fresh processes when interruption left no TASK.md", async () => {
  const { root, vault, own } = await fixture()
  const config = join(root, "config.json")
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "UNSET_TEST_INVENTORY_TOKEN" },
      vault: { path: vault },
      courses: { allowlist: [] },
    }),
  )
  const briefPath = join(vault, "_meta/tasks", own.id, "TASK.md")
  const retainedBrief = join(root, "retained-brief.md")
  await rename(briefPath, retainedBrief)
  const recordPath = join(vault, "_meta/tasks", own.id, "task.json")
  const before = await readFile(recordPath)
  const cli = (args: string[]) =>
    spawnSync(process.execPath, [resolve("dist/cli.js"), ...args, "--config", config], {
      encoding: "utf8",
      timeout: 30_000,
    })
  const recovered = cli(["task", "show", own.id, "--json"])
  expect(recovered.status, recovered.stderr).toBe(0)
  const record = JSON.parse(recovered.stdout)
  expect(record).toMatchObject({ id: own.id, status: "pending", briefStatus: "missing" })
  expect(record.taskFile).toBeUndefined()
  expect(record.sources).toEqual(own.sources)
  expect(record.workflow).toEqual(own.workflow)
  expect(await readFile(recordPath)).toEqual(before)
  await expect(stat(briefPath)).rejects.toMatchObject({ code: "ENOENT" })
  const text = cli(["task", "show", own.id])
  expect(text.status).toBe(1)
  expect(text.stderr).toContain("--json")
  const candidate = join(root, "candidate.md")
  await writeFile(
    candidate,
    `Task: ${own.id}\n\n${own.requirements.map((heading) => `## ${heading}\nSynthetic structural recovery only; supplied evidence remains unchanged. \`${own.sources[0]?.path}\``).join("\n\n")}`,
  )
  const completed = cli(["task", "complete", own.id, "--file", candidate, "--json"])
  expect(completed.status, completed.stderr).toBe(0)
  expect(JSON.parse(cli(["task", "show", own.id, "--json"]).stdout)).toMatchObject({
    id: own.id,
    status: "completed",
    briefStatus: "missing",
  })
  await expect(stat(briefPath)).rejects.toMatchObject({ code: "ENOENT" })
  // Missing is recoverable; a linked brief is not silently ignored or repaired.
  await symlink(retainedBrief, briefPath)
  const unsafe = cli(["task", "show", own.id, "--json"])
  expect(unsafe.status).toBe(1)
  expect(unsafe.stderr).not.toContain("SOURCE_BODY_SENTINEL")
})

it("recovers a recipe after its actual writer process is killed before saving the brief", async () => {
  const { root, vault, own, other } = await fixture()
  const protectedPaths = [
    join(vault, own.sources[0]?.path ?? ""),
    join(vault, "_meta/tasks", own.id, "task.json"),
    join(vault, "_meta/tasks", other.id, "task.json"),
  ]
  const protectedBytes = await Promise.all(protectedPaths.map((path) => readFile(path)))
  const config = join(root, "interrupted-config.json")
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "UNSET_TEST_KILLED_TOKEN" },
      vault: { path: vault },
      courses: { allowlist: [] },
    }),
  )
  // Test-only interception pauses the real compiled writer at a deterministic
  // boundary, after task.json but before TASK.md. No production fault hook.
  const program = `
    import fs from "node:fs/promises";
    import {syncBuiltinESMExports} from "node:module";
    import {basename,dirname} from "node:path";
    const write=fs.writeFile;
    fs.writeFile=async(path,...args)=>{
      if(String(path).endsWith("/TASK.md")) {
        const hold=setInterval(()=>{},1000);
        process.send({id:basename(dirname(String(path)))});
        await new Promise(()=>{});
        clearInterval(hold);
      }
      return write(path,...args);
    };
    syncBuiltinESMExports();
    const {createPrepTask}=await import(${JSON.stringify(pathToFileURL(resolve("dist/tasks/store.js")).href)});
    await createPrepTask(process.argv[1],"CS101","2026-10-05");
  `
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "SystemRoot", "COMSPEC", "PATHEXT"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  )
  const child = spawn(process.execPath, ["--input-type=module", "-e", program, vault], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  })
  const exited = once(child, "exit")
  let id: string
  try {
    id = await new Promise<string>((resolveId, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Writer did not reach saved-recipe boundary")),
        10_000,
      )
      child.once("message", (message) => {
        clearTimeout(timeout)
        resolveId((message as { id: string }).id)
      })
      child.once("error", (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once("exit", () => {
        clearTimeout(timeout)
        reject(new Error("Writer exited before interruption"))
      })
    })
  } finally {
    child.kill("SIGKILL")
    expect((await exited)[1]).toBe("SIGKILL")
  }
  const recordPath = join(vault, "_meta/tasks", id, "task.json")
  const before = await readFile(recordPath)
  const cli = (args: string[]) =>
    spawnSync(process.execPath, [resolve("dist/cli.js"), ...args, "--config", config, "--json"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 30_000,
    })
  const listed = cli(["task", "list", "--course", "CS101", "--status", "pending"])
  expect(listed.status, listed.stderr).toBe(0)
  expect(JSON.parse(listed.stdout).tasks.map((task: { id: string }) => task.id)).toContain(id)
  const shown = cli(["task", "show", id])
  expect(shown.status, shown.stderr).toBe(0)
  const task = JSON.parse(shown.stdout)
  expect(task).toMatchObject({ id, status: "pending", briefStatus: "missing" })
  expect(await readFile(recordPath)).toEqual(before)
  const candidate = join(root, "interrupted-candidate.md")
  await writeFile(
    candidate,
    `Task: ${id}\n\n${task.requirements
      .map(
        (heading: string) =>
          `## ${heading}\nSynthetic process-interruption recovery only. \`${task.sources[0].path}\``,
      )
      .join("\n\n")}`,
  )
  const completed = cli(["task", "complete", id, "--file", candidate])
  expect(completed.status, completed.stderr).toBe(0)
  expect(JSON.parse(cli(["task", "show", id]).stdout)).toMatchObject({
    id,
    status: "completed",
    briefStatus: "missing",
  })
  await expect(stat(join(vault, "_meta/tasks", id, "TASK.md"))).rejects.toMatchObject({
    code: "ENOENT",
  })
  expect(await Promise.all(protectedPaths.map((path) => readFile(path)))).toEqual(protectedBytes)
}, 30_000)
