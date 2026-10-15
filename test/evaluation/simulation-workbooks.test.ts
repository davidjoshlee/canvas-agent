import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import JSZip from "jszip"
import { afterEach, expect, it } from "vitest"
import { captureSimulation } from "../../src/evaluation/captures.js"
import { createSimulationTask } from "../../src/evaluation/tasks.js"
import {
  createSimulationWorkbook,
  readSimulationWorkbooks,
} from "../../src/evaluation/workbooks.js"
import { createWorkbook, parseWorkbookInput } from "../../src/tasks/tools.js"

const roots: string[] = []
const data = {
  sheets: [
    {
      name: "Pricing",
      rows: [
        ["Label", "Value"],
        ["Incremental contribution", 500],
        ["Literal formula", "=1+2"],
      ],
    },
  ],
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-frozen-workbooks-"))
  roots.push(root)
  const vault = join(root, "vault"),
    source = "CS101/Assignments/prompt.md"
  await mkdir(join(vault, "CS101/Assignments"), { recursive: true })
  await writeFile(
    join(vault, source),
    "---\navailable_at: 2026-10-05\ntype: assignment\n---\nAnalyze the supplied synthetic pricing results. PRIVATE_PROMPT_BODY.",
  )
  const snapshot = await captureSimulation(vault, "CS101", "2026-10-09")
  const task = await createSimulationTask(vault, snapshot.id, {
    kind: "assignment",
    source,
    mode: "draft",
  })
  const file = join(root, "sheets.json")
  await writeFile(file, JSON.stringify(data))
  return { root, vault, source, task, file }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it("preserves old hash-bound directory-date bundles but requires fixed dates for the new renderer", async () => {
  const { vault, task, file } = await fixture()
  const created = await createSimulationWorkbook(vault, task.id, file)
  const path = join(vault, created.output)
  const metadataPath = join(path, "..", "record.json")
  const record = JSON.parse(await readFile(metadataPath, "utf8"))
  expect(record.rendererVersion).toBe(1)
  const zip = await JSZip.loadAsync(await readFile(path))
  zip.forEach((_name, entry) => {
    if (entry.dir) entry.date = new Date("2026-10-12T12:00:00Z")
  })
  const older = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  })
  record.hash = createHash("sha256").update(older).digest("hex")
  record.size = older.length
  await writeFile(path, older)
  await writeFile(metadataPath, JSON.stringify(record))
  await expect(readSimulationWorkbooks(vault, task.id)).rejects.toThrow(/bytes changed/)
  delete record.rendererVersion
  const metadata = JSON.stringify(record)
  await writeFile(metadataPath, metadata)
  expect(
    (await readSimulationWorkbooks(vault, task.id)).records[0]?.rendererVersion,
  ).toBeUndefined()
  expect(await readFile(path)).toEqual(older)
  expect(await readFile(metadataPath, "utf8")).toBe(metadata)
})

it("creates reproducible private values-only companions and verifies them after live-source edits", async () => {
  const { vault, source, task, file } = await fixture()
  const before = await readFile(join(vault, "_meta/simulations/tasks", task.id, "record.json"))
  const created = await createSimulationWorkbook(vault, task.id, file, source)
  const again = await createSimulationWorkbook(vault, task.id, file, source)
  expect(again.id).not.toBe(created.id)
  expect(again.hash).toBe(created.hash)
  expect(created.attributionVerified).toBe(false)
  expect(created.output).toContain(`_meta/simulations/tasks/${task.id}/workbooks/`)
  expect((await lstat(join(vault, created.output))).mode & 0o777).toBe(0o600)
  const zip = await JSZip.loadAsync(await readFile(join(vault, created.output)))
  const xml = await zip.file("xl/worksheets/sheet1.xml")?.async("string")
  expect(xml).toContain("<v>500</v>")
  expect(xml).toContain("=1+2")
  expect(xml).not.toContain("<f>")
  expect(Object.keys(zip.files).some((name) => /vba|externalLinks/i.test(name))).toBe(false)
  await writeFile(join(vault, source), "Changed live prompt must not replace fixed evidence.")
  expect((await readSimulationWorkbooks(vault, task.id)).records).toHaveLength(2)
  expect(await readFile(join(vault, "_meta/simulations/tasks", task.id, "record.json"))).toEqual(
    before,
  )
})

it("refuses invalid/out-of-scope inputs and leaves held locks untouched", async () => {
  const { vault, task, file } = await fixture()
  await expect(
    createSimulationWorkbook(vault, task.id, file, "OTHER101/reading.md"),
  ).rejects.toThrow(/selected frozen/)
  await writeFile(file, '{"sheets":[{"name":"Bad/Name","rows":[]}]}')
  await expect(createSimulationWorkbook(vault, task.id, file)).rejects.toThrow(/Sheet names/)
  expect((await readSimulationWorkbooks(vault, task.id)).records).toEqual([])
  await writeFile(file, JSON.stringify(data))
  const lock = join(vault, "_meta/simulations/tasks", task.id, "workbooks.lock")
  await mkdir(lock)
  await expect(createSimulationWorkbook(vault, task.id, file)).rejects.toThrow()
  expect((await lstat(lock)).isDirectory()).toBe(true)
})

it("rejects workbook/input tampering, incomplete bundles and symlinked evidence", async () => {
  const { root, vault, task, file } = await fixture()
  const created = await createSimulationWorkbook(vault, task.id, file)
  const workbook = join(vault, created.output),
    input = join(workbook, "..", "input.json")
  const original = await readFile(workbook)
  await writeFile(workbook, "Changed workbook.")
  await expect(readSimulationWorkbooks(vault, task.id)).rejects.toThrow(/bytes changed/)
  await writeFile(workbook, original)
  const originalInput = await readFile(input)
  await writeFile(input, JSON.stringify({ sheets: [{ name: "Pricing", rows: [[999]] }] }))
  await expect(readSimulationWorkbooks(vault, task.id)).rejects.toThrow(/bytes changed/)
  await writeFile(input, originalInput)
  const other = join(root, "outside.json")
  await writeFile(other, "PRIVATE_OUTSIDE_CONTENT")
  await rm(input)
  await symlink(other, input)
  await expect(readSimulationWorkbooks(vault, task.id)).rejects.toThrow(/Symbolic links/)
  expect(await readFile(other, "utf8")).toBe("PRIVATE_OUTSIDE_CONTENT")
  await unlink(input) // Remove only the synthetic symlink, not its target.
  await writeFile(input, originalInput)
  await mkdir(
    join(
      vault,
      "_meta/simulations/tasks",
      task.id,
      "workbooks",
      "00000000-0000-4000-8000-000000000000",
    ),
  )
  await expect(readSimulationWorkbooks(vault, task.id)).rejects.toThrow(/incomplete/)
})

it("enforces row/column bounds and makes reproducible ZIP dates independent of the current clock", async () => {
  expect(() =>
    parseWorkbookInput({
      sheets: [{ name: "EmptyRows", rows: Array.from({ length: 50_001 }, () => []) }],
    }),
  ).toThrow(/row limit/)
  expect(() =>
    parseWorkbookInput({
      sheets: [{ name: "Wide", rows: [Array.from({ length: 16_385 }, () => 1)] }],
    }),
  ).toThrow(/column limit/)
  const parsed = parseWorkbookInput(data)
  expect(await createWorkbook(parsed)).toEqual(await createWorkbook(parsed))
})

it("uses the compiled workbook/inspection commands without printing cells or malformed JSON", async () => {
  const { root, vault, task, file, source } = await fixture()
  const config = join(root, "config.json")
  const cli = (args: string[]) =>
    spawnSync(process.execPath, [resolve("dist/cli.js"), ...args, "--config", config, "--json"], {
      encoding: "utf8",
    })
  expect(
    cli(["init", "--vault", vault, "--canvas-url", "https://canvas.example.test"]).status,
  ).toBe(0)
  const created = cli(["simulate", "task", "workbook", task.id, "--file", file, "--source", source])
  expect(created.status, created.stderr).toBe(0)
  expect(JSON.parse(created.stdout).sheets).toEqual(["Pricing"])
  expect(created.stdout).not.toContain("Incremental contribution")
  expect(created.stdout).not.toContain("PRIVATE_PROMPT_BODY")
  const checked = cli(["simulate", "task", "workbooks", task.id])
  expect(checked.status, checked.stderr).toBe(0)
  expect(JSON.parse(checked.stdout).records).toHaveLength(1)
  await writeFile(file, "PRIVATE_INVALID_WORKBOOK_JSON")
  const failed = cli(["simulate", "task", "workbook", task.id, "--file", file])
  expect(failed.status).toBe(1)
  expect(failed.stdout + failed.stderr).not.toContain("PRIVATE_INVALID_WORKBOOK_JSON")
  expect(cli(["simulate", "task", "workbook", task.id, "--file", join(root, ".env")]).status).toBe(
    1,
  )
}, 15_000)
