import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { captureSimulation } from "../../src/simulation/captures.js"
import {
  completeSimulationTask,
  createSimulationTask,
  inspectSimulationTask,
  listSimulationTasks,
  readSimulationTask,
} from "../../src/simulation/tasks.js"
import { createPrepTask } from "../../src/tasks/store.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-frozen-inventory-"))
  roots.push(root)
  const vault = join(root, "vault")
  const courses = []
  for (const code of ["CS101", "ECON101"]) {
    await mkdir(join(vault, code, "Week 01 - Oct 5"), { recursive: true })
    await writeFile(
      join(vault, code, "Week 01 - Oct 5/reading.md"),
      `---\navailable_at: 2026-10-05\n---\nPRIVATE_FROZEN_BODY_${code}: substantive marginal cost and evidence distinctions.\n`,
    )
    const capture = await captureSimulation(vault, code, "2026-10-06")
    const task = await createSimulationTask(vault, capture.id, { kind: "prep", week: "2026-10-05" })
    courses.push({ code, capture, task })
  }
  const own = courses[0],
    other = courses[1]
  if (!own || !other) throw new Error("Expected two synthetic courses")
  return { root, vault, own, other }
}

it("discovers frozen recipes after restart without current sources, ordinary task IDs or output-state claims", async () => {
  const { root, vault, own, other } = await fixture()
  const ordinary = await createPrepTask(vault, "CS101", "2026-10-05")
  const id = own.task.id
  const recipe = await readSimulationTask(vault, id)
  const directory = join(vault, "_meta/simulations/tasks", id)
  const recipeBefore = await readFile(join(directory, "record.json"))
  const candidate = join(root, "candidate.md")
  await writeFile(
    candidate,
    `Task: ${id}\n\n${own.task.requirements
      .map(
        (heading) => `## ${heading}\nSynthetic recovery mechanics only. \`${own.task.sources[0]}\``,
      )
      .join("\n\n")}`,
  )
  await completeSimulationTask(vault, id, candidate)
  const receiptBefore = await readFile(join(directory, "completion.json"))
  await writeFile(join(directory, "output.md"), "PRIVATE_CHANGED_OUTPUT_SENTINEL")
  await expect(inspectSimulationTask(vault, id)).rejects.toThrow("output changed")
  await rename(join(vault, "CS101"), join(root, "retained-CS101"))
  const config = join(root, "config.json")
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "UNSET_FROZEN_INVENTORY_TOKEN" },
      vault: { path: vault },
      courses: { allowlist: [] },
    }),
  )
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "SystemRoot", "COMSPEC", "PATHEXT"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  )
  const cli = (args: string[]) =>
    spawnSync(process.execPath, [resolve("dist/cli.js"), ...args, "--config", config, "--json"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 30_000,
    })
  const result = cli(["simulate", "task", "list", "--course", "cs101"])
  expect(result.status, result.stderr).toBe(0)
  const listed = JSON.parse(result.stdout)
  expect(listed).toMatchObject({ inventoryComplete: true, unreadableRecords: 0 })
  expect(listed.tasks).toEqual([
    {
      id,
      captureId: own.capture.id,
      createdAt: recipe.task.createdAt,
      kind: "prep",
      period: recipe.task.period,
      inspectionCommand: ["simulate", "task", "show", id, "--config", config, "--json"],
    },
  ])
  for (const excluded of [
    other.task.id,
    ordinary.id,
    "PRIVATE_FROZEN_BODY",
    "PRIVATE_CHANGED_OUTPUT",
    '"workflow"',
    '"status"',
  ])
    expect(result.stdout).not.toContain(excluded)
  expect(listed.limitation).toContain("not completion receipts")
  expect(cli(["simulate", "task", "show", id]).status).toBe(1)
  expect(cli(["simulate", "task", "list"]).status).toBe(1)
  expect(cli(["simulate", "task", "list", "--course", " "]).status).toBe(1)
  expect(await readFile(join(directory, "record.json"))).toEqual(recipeBefore)
  expect(await readFile(join(directory, "completion.json"))).toEqual(receiptBefore)
  expect(await readFile(join(directory, "output.md"), "utf8")).toBe(
    "PRIVATE_CHANGED_OUTPUT_SENTINEL",
  )
  expect((await listSimulationTasks(vault, "UNKNOWN")).tasks).toEqual([])
})

it("reports malformed, linked, oversized and substituted frozen recipes without echo or repair", async () => {
  const { vault, own } = await fixture()
  const directory = join(vault, "_meta/simulations/tasks")
  const malformed = join(directory, randomUUID())
  await mkdir(malformed)
  await writeFile(join(malformed, "record.json"), "PRIVATE_FROZEN_MALFORMED_SENTINEL")
  await symlink(malformed, join(directory, randomUUID()))
  const oversized = join(directory, randomUUID())
  await mkdir(oversized)
  await writeFile(join(oversized, "record.json"), "")
  await truncate(join(oversized, "record.json"), 20_000_001)
  const substituted = join(directory, randomUUID())
  await mkdir(substituted)
  await writeFile(
    join(substituted, "record.json"),
    await readFile(join(directory, own.task.id, "record.json")),
  )
  const listed = await listSimulationTasks(vault, "CS101")
  expect(listed).toMatchObject({ inventoryComplete: false, unreadableRecords: 4 })
  expect(listed.tasks.map((task) => task.id)).toEqual([own.task.id])
  expect(JSON.stringify(listed)).not.toContain("PRIVATE_FROZEN_MALFORMED")
  expect(await readFile(join(malformed, "record.json"), "utf8")).toBe(
    "PRIVATE_FROZEN_MALFORMED_SENTINEL",
  )
})

it("marks a recipe whose frozen capture binding broke unreadable rather than recreating its source context", async () => {
  const { vault, own } = await fixture()
  const capturePath = join(vault, own.capture.path)
  const record = JSON.parse(await readFile(capturePath, "utf8"))
  record.hash = "0".repeat(64)
  const changed = JSON.stringify(record)
  await writeFile(capturePath, changed)
  const recipePath = join(vault, "_meta/simulations/tasks", own.task.id, "record.json")
  const before = await readFile(recipePath)
  const listed = await listSimulationTasks(vault, "CS101")
  expect(listed).toMatchObject({ tasks: [], inventoryComplete: false, unreadableRecords: 1 })
  expect(await readFile(capturePath, "utf8")).toBe(changed)
  expect(await readFile(recipePath)).toEqual(before)
})
