import { spawn, spawnSync } from "node:child_process"
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import JSZip from "jszip"
import { afterEach, expect, it } from "vitest"
import { markLegacyTask } from "../helpers/legacy-execution.js"

const roots: string[] = []
type BundleSummary = {
  path: string
  hash: string
  files: Array<{ path: string; role: string; purpose: string; hash: string }>
  executions: Array<{ command: string }>
}
type TaskView = {
  id: string
  status?: string
  requirements?: string[]
  workingDirectory?: string
  bundleHash?: string
  bundle?: BundleSummary | null
  parentBundle?: { taskId: string; hash: string } | null
  output?: string
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-task-bundle-"))
  roots.push(root)
  const vault = join(root, "vault")
  const config = join(root, "config.json")
  const cli = <T = unknown>(args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), ...args, "--config", config, "--json"],
      { encoding: "utf8", timeout: 30_000 },
    )
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      json: result.stdout ? (JSON.parse(result.stdout) as T) : undefined,
    }
  }
  const cliAsync = (args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolveResult, reject) => {
        const child = spawn(
          process.execPath,
          [resolve("dist/cli.js"), ...args, "--config", config, "--json"],
          {
            stdio: ["ignore", "pipe", "pipe"],
          },
        )
        let stdout = ""
        let stderr = ""
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk))
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk))
        child.once("error", reject)
        child.once("close", (status) => resolveResult({ status, stdout, stderr }))
      },
    )
  const ok = <T = unknown>(args: string[]) => {
    const result = cli<T>(args)
    expect(result.status, result.stderr).toBe(0)
    return result.json as T
  }
  ok(["init", "--vault", vault, "--canvas-url", "https://canvas.example.test"])
  const prompt = "CS101/Assignments/Case/prompt.md"
  await mkdir(join(vault, "CS101/Assignments/Case"), { recursive: true })
  await writeFile(join(vault, prompt), "---\ntype: assignment\n---\nExplain this synthetic case.")
  const created = ok<{ id: string; workingDirectory: string }>([
    "assignment",
    "CS101",
    "--source",
    prompt,
    "--mode",
    "draft",
  ])
  expect(created.workingDirectory).toBe(join(vault, "_meta/tasks", created.id, "work"))
  const task = ok<TaskView>(["task", "show", created.id])
  expect(task.workingDirectory).toBe(join(vault, "_meta/tasks", created.id, "work"))
  const authored = join(root, "authored")
  await mkdir(authored)
  const workbook = new JSZip()
  workbook.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
  )
  workbook.file(
    "_rels/.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  )
  workbook.file(
    "xl/workbook.xml",
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  )
  workbook.file(
    "xl/_rels/workbook.xml.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  )
  workbook.file(
    "xl/worksheets/sheet1.xml",
    '<worksheet><sheetData><row><c r="A1"><v>42</v></c></row></sheetData></worksheet>',
  )
  const workbookBytes = await workbook.generateAsync({ type: "nodebuffer" })
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
    "base64",
  )
  const candidate = [
    `Task: ${created.id}`,
    ...task.requirements.map(
      (heading: string) =>
        `## ${heading}\n${heading === "Sources" ? `\`${prompt}\`` : "Synthetic host-authored response based on the supplied case."}`,
    ),
  ].join("\n\n")
  await writeFile(join(authored, "candidate.md"), candidate)
  await writeFile(join(authored, "model.xlsx"), workbookBytes)
  await writeFile(join(authored, "preview.png"), pngBytes)
  const commandMarker = join(root, "execution-was-run")
  await writeFile(join(authored, "analysis.js"), "export const answer = 42\n")
  await writeFile(join(authored, "run.log"), "Synthetic execution log\n")
  await writeFile(join(authored, "notes.txt"), "Synthetic supporting note\n")
  const manifest = {
    version: 1,
    taskId: created.id,
    primary: "candidate.md",
    files: [
      { path: "model.xlsx", role: "deliverable", purpose: "Supporting model workbook" },
      { path: "preview.png", role: "deliverable", purpose: "One pixel synthetic preview" },
      { path: "notes.txt", role: "supporting", purpose: "Supporting note" },
      { path: "analysis.js", role: "code", purpose: "Reproducible analysis" },
      { path: "run.log", role: "log", purpose: "Execution record" },
    ],
    executions: [
      {
        command: `node -e "require('fs').writeFileSync('${commandMarker}', 'executed')"`,
        inputFiles: ["analysis.js"],
        outputFiles: ["model.xlsx"],
        exitCode: 0,
        log: "run.log",
      },
    ],
    checks: [{ description: "Synthetic check", result: "passed in host" }],
  }
  const manifestPath = join(authored, "manifest.json")
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  return {
    root,
    vault,
    config,
    cli,
    cliAsync,
    ok,
    created,
    task,
    authored,
    manifestPath,
    manifest,
    prompt,
    workbookBytes,
    pngBytes,
    commandMarker,
  }
}

it("saves an immutable, inspectable bundle and approval delivers only declared deliverables", async () => {
  const f = await fixture()
  const completed = f.ok<{ bundle: BundleSummary; output: string }>([
    "task",
    "complete",
    f.created.id,
    "--manifest",
    f.manifestPath,
  ])
  expect(completed.bundle.files.map((file) => file.path)).toEqual([
    "candidate.md",
    "model.xlsx",
    "preview.png",
    "notes.txt",
    "analysis.js",
    "run.log",
  ])
  expect(completed.bundle.executions[0].command).toContain("writeFileSync")
  expect(await readFile(f.commandMarker).catch(() => null)).toBeNull()

  const saved = f.ok<TaskView>(["task", "show", f.created.id])
  expect(saved.bundle).toMatchObject({ path: completed.bundle.path, hash: completed.bundle.hash })
  expect(saved.workingDirectory).toBeTruthy()
  const inspected = f.ok<unknown>(["inspect", f.created.id])
  expect(JSON.stringify(inspected)).toContain(completed.bundle.hash)

  // Authored files can be removed after completion; private, hash-bound copies remain authoritative.
  await rm(f.authored, { recursive: true })
  for (const file of completed.bundle.files) {
    const snap = join(f.vault, "_meta/tasks", f.created.id, "bundle/files", file.path)
    expect((await readFile(snap)).length).toBeGreaterThan(0)
  }
  const revised = f.ok<{ id: string }>([
    "revise",
    f.created.id,
    "--feedback",
    "Clarify the recommendation.",
  ])
  const revision = f.ok<TaskView>(["task", "show", revised.id])
  expect(revision.parentBundle).toMatchObject({ taskId: f.created.id, hash: completed.bundle.hash })

  const approved = f.ok<{ bundle: { directory: string }; output: string }>([
    "approve",
    f.created.id,
  ])
  expect(approved.bundle).toBeTruthy()
  const finalRoot = join(f.vault, approved.output).replace(/\.md$/, "-bundle")
  expect(await readFile(join(finalRoot, "candidate.md"), "utf8")).toContain(`Task: ${f.created.id}`)
  expect(await readFile(join(finalRoot, "model.xlsx"))).toEqual(f.workbookBytes)
  expect(await readFile(join(finalRoot, "preview.png"))).toEqual(f.pngBytes)
  await expect(readFile(join(finalRoot, "analysis.js"))).rejects.toMatchObject({ code: "ENOENT" })
  await expect(readFile(join(finalRoot, "run.log"))).rejects.toMatchObject({ code: "ENOENT" })
  await expect(readFile(join(finalRoot, "notes.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  const finals = join(f.vault, "CS101/Assignments/Case/Finals")
  const finalNames = await readdir(finals)
  await rm(join(finalRoot, "candidate.md"))
  const retry = f.cli(["approve", f.created.id])
  expect(retry.status).toBe(1)
  expect(retry.stderr).toMatch(/bundle|deliverable|missing|modified/i)
  expect(await readdir(finals)).toEqual(finalNames)
})

it("refuses review gate evaluation when a registered companion has changed", async () => {
  const f = await fixture()
  const completed = f.ok<{ bundle: BundleSummary }>([
    "task",
    "complete",
    f.created.id,
    "--manifest",
    f.manifestPath,
  ])
  const gate = f.ok<{ path: string; bundle: BundleSummary }>(["gate", "review", f.created.id])
  expect(gate.bundle?.hash).toBe(completed.bundle.hash)
  const companion = join(f.vault, "_meta/tasks", f.created.id, "bundle/files/model.xlsx")
  await writeFile(companion, "changed companion bytes")
  const rejected = f.cli(["gate", "review", f.created.id])
  expect(rejected.status).toBe(1)
  expect(rejected.stderr).toMatch(/bundle file integrity|modified/i)
})

it("makes identical retries byte-stable and rejects a changed bundle after completion", async () => {
  const f = await fixture()
  const args = ["task", "complete", f.created.id, "--manifest", f.manifestPath]
  const first = f.ok<{ bundle: BundleSummary }>(args)
  const taskJson = join(f.vault, "_meta/tasks", f.created.id, "task.json")
  const before = await readFile(taskJson)
  expect(f.ok<{ bundle: BundleSummary }>(args).bundle.hash).toBe(first.bundle.hash)
  expect(await readFile(taskJson)).toEqual(before)
  await writeFile(join(f.authored, "model.xlsx"), "changed workbook bytes\n")
  const changed = f.cli(args)
  expect(changed.status).toBe(1)
  expect(changed.stderr).toMatch(/bundle|artifact|changed/i)
  expect(await readFile(taskJson)).toEqual(before)
})

it("recovers cleanly after stale source evidence is corrected and the same bundle is retried", async () => {
  const f = await fixture()
  const sourcePath = join(f.vault, f.prompt)
  const original = await readFile(sourcePath)
  await writeFile(sourcePath, "Changed after task capture; this evidence is stale.")
  const args = ["task", "complete", f.created.id, "--manifest", f.manifestPath]
  const stale = f.cli(args)
  expect(stale.status).toBe(1)
  expect(stale.stderr).toMatch(/stale|source|changed/i)
  await writeFile(join(f.authored, "model.xlsx"), Buffer.from("different bundle bytes"))
  const changed = f.cli(args)
  expect(changed.status).toBe(1)
  expect(changed.stderr).toMatch(/different bundle|reserved|bundle/i)
  await writeFile(join(f.authored, "model.xlsx"), f.workbookBytes)
  await writeFile(sourcePath, original)
  const completed = f.ok<{ bundle: BundleSummary }>(args)
  expect(completed.bundle.files.map((file) => file.path)).toContain("model.xlsx")
  expect(await readFile(f.commandMarker).catch(() => null)).toBeNull()
})

it("refuses a modified private snapshot across task reads and lifecycle writes", async () => {
  const f = await fixture()
  const completed = f.ok<{ output: string }>([
    "task",
    "complete",
    f.created.id,
    "--manifest",
    f.manifestPath,
  ])
  const taskFile = join(f.vault, "_meta/tasks", f.created.id, "task.json")
  const taskBytes = await readFile(taskFile)
  const courseAssignmentDir = join(f.vault, "CS101/Assignments/Case")
  const finalsDirectory = join(courseAssignmentDir, "Finals")
  const finalsBefore = await lstat(finalsDirectory).catch(() => null)
  const snapshot = join(f.vault, "_meta/tasks", f.created.id, "bundle/files/model.xlsx")
  await writeFile(snapshot, Buffer.concat([f.workbookBytes, Buffer.from("tampered")]))
  const attempts = [
    ["task", "show", f.created.id],
    ["task", "output", f.created.id],
    ["inspect", f.created.id],
    ["revise", f.created.id, "--feedback", "Should not create a revision."],
    ["approve", f.created.id],
  ]
  for (const args of attempts) {
    const result = f.cli(args)
    expect(result.status, args.join(" ")).toBe(1)
    expect(result.stderr).toMatch(/bundle|artifact|hash|modified|integrity/i)
  }
  expect(await readFile(taskFile)).toEqual(taskBytes)
  expect(await readFile(join(f.vault, completed.output))).toBeTruthy()
  expect(await lstat(finalsDirectory).catch(() => null)).toEqual(finalsBefore)
})

it("resumes bundle approval from its reservation after receipt loss and repairs a missing deliverable", async () => {
  const f = await fixture()
  f.ok<{ bundle: BundleSummary }>(["task", "complete", f.created.id, "--manifest", f.manifestPath])
  const approved = f.ok<{ output: string; bundle: { directory: string } }>([
    "approve",
    f.created.id,
  ])
  const finals = join(f.vault, "CS101/Assignments/Case/Finals")
  const namesBefore = await readdir(finals)
  const receipt = join(f.vault, "_meta/tasks", f.created.id, "approval.json")
  await rm(receipt)
  await rm(join(f.vault, approved.bundle.directory, "model.xlsx"))

  const retried = f.ok<{ output: string; bundle: { directory: string } }>(["approve", f.created.id])
  expect(retried.output).toBe(approved.output)
  expect(retried.bundle.directory).toBe(approved.bundle.directory)
  expect(await readFile(join(f.vault, approved.bundle.directory, "model.xlsx"))).toEqual(
    f.workbookBytes,
  )
  expect(await readdir(finals)).toEqual(namesBefore)
})

it("rejects changed Final bytes while resuming approval without a receipt", async () => {
  const f = await fixture()
  f.ok<{ bundle: BundleSummary }>(["task", "complete", f.created.id, "--manifest", f.manifestPath])
  const approved = f.ok<{ output: string; bundle: { directory: string } }>([
    "approve",
    f.created.id,
  ])
  const finals = join(f.vault, "CS101/Assignments/Case/Finals")
  const namesBefore = await readdir(finals)
  await rm(join(f.vault, "_meta/tasks", f.created.id, "approval.json"))
  const edited = Buffer.from("student-edited Final deliverable\n")
  const changedPath = join(f.vault, approved.bundle.directory, "preview.png")
  await writeFile(changedPath, edited)

  const retry = f.cli(["approve", f.created.id])
  expect(retry.status).toBe(1)
  expect(retry.stderr).toMatch(/different bytes|already exists|Final file/i)
  expect(await readFile(changedPath)).toEqual(edited)
  expect(await readdir(finals)).toEqual(namesBefore)
  await expect(
    readFile(join(f.vault, "_meta/tasks", f.created.id, "approval.json")),
  ).rejects.toMatchObject({ code: "ENOENT" })
})

it("resumes a bundle approval that already published a legacy automatic workbook", async () => {
  const f = await fixture()
  await markLegacyTask(f.vault, f.created.id)
  const candidatePath = join(f.authored, "candidate.md")
  await writeFile(
    candidatePath,
    `${await readFile(candidatePath, "utf8")}\n\n### Results\n| Label | Value |\n| --- | --- |\n| Total | 6 |\n`,
  )
  f.ok(["task", "complete", f.created.id, "--manifest", f.manifestPath])
  type Approved = { output: string; workbook: { path: string; hash: string } }
  const approved = f.ok<Approved>(["approve", f.created.id])
  const originalWorkbook = await readFile(join(f.vault, approved.workbook.path))
  await rm(join(f.vault, "_meta", "tasks", f.created.id, "approval.json"))
  const retry = f.ok<Approved>(["approve", f.created.id])
  expect(retry.output).toBe(approved.output)
  expect(retry.workbook).toEqual(approved.workbook)
  expect(await readFile(join(f.vault, retry.workbook.path))).toEqual(originalWorkbook)
})

it("rejects traversal, symlinks and credential-bearing files without persisting a task bundle", async () => {
  const f = await fixture()
  const original = JSON.parse(await readFile(f.manifestPath, "utf8"))
  const taskDir = join(f.vault, "_meta/tasks", f.created.id)
  const writeManifest = async (value: unknown) => writeFile(f.manifestPath, JSON.stringify(value))
  const run = () => f.cli(["task", "complete", f.created.id, "--manifest", f.manifestPath])

  await writeManifest({ ...original, taskId: "different-task-id" })
  expect(run().status).toBe(1)
  expect(await readFile(join(taskDir, "bundle/record.json")).catch(() => null)).toBeNull()

  await writeManifest({
    ...original,
    executions: undefined,
    files: [{ path: "../outside.txt", role: "supporting", purpose: "escape" }],
  })
  expect(run().status).toBe(1)
  expect(await readFile(join(taskDir, "bundle/record.json")).catch(() => null)).toBeNull()

  await writeFile(join(f.root, "outside-secret.txt"), "synthetic-secret")
  await symlink(join(f.root, "outside-secret.txt"), join(f.authored, "linked.txt"))
  await writeManifest({
    ...original,
    executions: undefined,
    files: [{ path: "linked.txt", role: "supporting", purpose: "linked" }],
  })
  expect(run().status).toBe(1)
  expect((await lstat(join(f.authored, "linked.txt"))).isSymbolicLink()).toBe(true)

  await writeFile(join(f.authored, ".env"), "TOKEN=synthetic-secret\n")
  await writeManifest({
    ...original,
    executions: undefined,
    files: [{ path: ".env", role: "supporting", purpose: "credentials" }],
  })
  expect(run().status).toBe(1)
  expect(await readFile(join(taskDir, "bundle/record.json")).catch(() => null)).toBeNull()

  await writeFile(join(f.authored, "notes.txt"), "password=synthetic-secret\n")
  await writeManifest({
    ...original,
    executions: undefined,
    files: [{ path: "notes.txt", role: "supporting", purpose: "notes" }],
  })
  expect(run().status).toBe(1)
  expect(await readFile(join(taskDir, "bundle/record.json")).catch(() => null)).toBeNull()
})

it("uses canonical vault scope while allowing a bundle authored in its own private working directory", async () => {
  const f = await fixture()
  const other = join(f.vault, "OTHER101", "Assignments", "Private")
  await mkdir(other, { recursive: true })
  const candidate = await readFile(join(f.authored, "candidate.md"))
  const manifest = JSON.stringify({
    version: 1,
    taskId: f.created.id,
    primary: "candidate.md",
    files: [],
  })
  await writeFile(join(other, "candidate.md"), candidate)
  await writeFile(join(other, "manifest.json"), manifest)
  const refused = f.cli([
    "task",
    "complete",
    f.created.id,
    "--manifest",
    await realpath(join(other, "manifest.json")),
  ])
  expect(refused.status).toBe(1)
  expect(refused.stderr).toContain("working directory")
  expect(f.ok<TaskView>(["task", "show", f.created.id]).status).toBe("pending")

  const work = join(f.vault, "_meta", "tasks", f.created.id, "work")
  await writeFile(join(work, "candidate.md"), candidate)
  await writeFile(join(work, "manifest.json"), manifest)
  const completed = f.ok<TaskView>([
    "task",
    "complete",
    f.created.id,
    "--manifest",
    await realpath(join(work, "manifest.json")),
  ])
  expect(completed.bundle?.files).toHaveLength(1)
})

it("keeps the legacy --file lifecycle working and rejects combining it with --manifest", async () => {
  const f = await fixture()
  const legacy = f.cli([
    "task",
    "complete",
    f.created.id,
    "--file",
    join(f.authored, "candidate.md"),
  ])
  expect(legacy.status, legacy.stderr).toBe(0)
  expect(legacy.json.bundle).toBeUndefined()
  const both = f.cli([
    "task",
    "complete",
    f.created.id,
    "--file",
    join(f.authored, "candidate.md"),
    "--manifest",
    f.manifestPath,
  ])
  expect(both.status).toBe(1)
  expect(both.stderr).toMatch(/mutually exclusive|either.*file|manifest/i)
})

it("arbitrates concurrent legacy and bundle completion so one immutable completion intent wins", async () => {
  const f = await fixture()
  const [fileResult, bundleResult] = await Promise.all([
    f.cliAsync(["task", "complete", f.created.id, "--file", join(f.authored, "candidate.md")]),
    f.cliAsync(["task", "complete", f.created.id, "--manifest", f.manifestPath]),
  ])
  expect([fileResult.status, bundleResult.status].filter((status) => status === 0)).toHaveLength(1)
  expect([fileResult.status, bundleResult.status].filter((status) => status !== 0)).toHaveLength(1)
  const task = f.ok<TaskView>(["task", "show", f.created.id])
  expect(task.status).toBe("completed")
  expect(Boolean(task.bundleHash)).toBe(bundleResult.status === 0)
  const output = f.ok<{ outputIntegrityVerified: boolean; text: string }>([
    "task",
    "output",
    f.created.id,
  ])
  expect(output.outputIntegrityVerified).toBe(true)
  expect(output.text).toContain(`Task: ${f.created.id}`)
})
