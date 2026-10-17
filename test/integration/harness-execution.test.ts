import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import JSZip from "jszip"
import { afterEach, expect, it } from "vitest"
import { readTask } from "../../src/tasks/artifacts/records.js"
import { calculateTask, markLegacyTask } from "../helpers/legacy-execution.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const retired = [
  ["calculate"],
  ["check-numbers"],
  ["workbook"],
  ["simulate", "task", "calculate"],
  ["simulate", "task", "check-numbers"],
  ["simulate", "task", "workbook"],
]
it.each(retired)(
  "rejects the retired execution path %s before loading configuration",
  (...args) => {
    const result = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), ...args, "--config", "/does-not-exist.json"],
      { encoding: "utf8" },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("unknown command")
    expect(result.stderr).not.toContain("ENOENT")
  },
)
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-harness-execution-"))
  roots.push(root)
  const vault = join(root, "vault"),
    config = join(root, "config.json")
  const cli = (args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), ...args, "--config", config, "--json"],
      { encoding: "utf8", timeout: 30000 },
    )
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  }
  cli(["init", "--vault", vault, "--canvas-url", "https://canvas.example.test"])
  const prompt = "CS101/Assignments/Case/prompt.md"
  await mkdir(join(vault, "CS101/Assignments/Case"), { recursive: true })
  await writeFile(
    join(vault, prompt),
    "---\ntype: assignment\navailable_at: 2026-10-01\n---\nExplain the supplied framework. Source inputs: unit cost 2 and volume 3.\n",
  )
  const candidate = join(root, "candidate.md")
  const writeCandidate = async (task: { id: string; requirements: string[] }) => {
    await writeFile(
      candidate,
      [
        `Task: ${task.id}`,
        ...task.requirements.map(
          (heading) =>
            `## ${heading}\n${heading === "Sources" ? `\`${prompt}\`` : "Synthetic harness-authored explanation based on the supplied framework."}`,
        ),
        "### Harness results\n| Label | Value |\n| --- | --- |\n| Total | 6 |\n\n## Computations\n- Total — 6",
      ].join("\n\n"),
    )
  }
  return { root, vault, config, prompt, cli, candidate, writeCandidate }
}
it("hands ordinary execution to the harness and preserves its spreadsheet through completion, revision and approval", async () => {
  const f = await fixture()
  const created = f.cli(["assignment", "CS101", "--source", f.prompt, "--mode", "draft"])
  const task = f.cli(["task", "show", created.id])
  expect(task.hostExecutionVersion).toBe(1)
  expect(task.workbookVersion).toBeUndefined()
  expect(task.workflow.instructions.join("\n")).toContain("The coding harness owns reasoning")
  expect(task.workflow.instructions.join("\n")).not.toContain("bounded calculate command")
  const zip = new JSZip()
  zip.file(
    "xl/worksheets/sheet1.xml",
    '<worksheet><sheetData><row><c r="A1"><f>2*3</f><v>6</v></c></row></sheetData></worksheet>',
  )
  const companion = join(f.vault, "CS101/Assignments/Case/harness-results.xlsx"),
    bytes = await zip.generateAsync({ type: "nodebuffer" })
  await writeFile(companion, bytes)
  await f.writeCandidate(task)
  const completed = f.cli(["task", "complete", task.id, "--file", f.candidate])
  expect(completed.task.workbook).toBeUndefined()
  const saved = await readFile(join(f.vault, completed.output))
  expect(
    (await readdir(join(f.vault, completed.task.destination))).filter((name) =>
      name.endsWith(".xlsx"),
    ),
  ).toEqual([])
  expect(await readdir(join(f.vault, "_meta/tasks", task.id))).not.toContain("calculations.jsonl")
  const gate = f.cli(["gate", "review", task.id])
  expect(gate.automaticWorkbook.state).toBe("harness-owned")
  const review = f.cli(["correctness", "prepare", task.id])
  expect(await readFile(review.handoffPath, "utf8")).toContain("empty legacy log does not mean")
  const revision = f.cli(["revise", task.id, "--feedback", "Clarify the recommendation."])
  expect(f.cli(["task", "show", revision.id]).hostExecutionVersion).toBe(1)
  const approved = f.cli(["approve", task.id])
  expect(approved.workbook).toBeUndefined()
  expect(await readFile(join(f.vault, approved.output))).toEqual(saved)
  expect(await readFile(companion)).toEqual(bytes)
  const file = join(f.vault, "_meta/tasks", task.id, "task.json"),
    record = JSON.parse(await readFile(file, "utf8"))
  record.workbookVersion = 1
  await writeFile(file, JSON.stringify(record))
  await expect(readTask(f.vault, task.id)).rejects.toThrow("Invalid task")
})
it("completes a new frozen draft without calculations or a generated workbook, using only saved sources", async () => {
  const f = await fixture(),
    capture = f.cli(["simulate", "capture", "CS101", "--as-of", "2026-10-02"])
  const task = f.cli([
    "simulate",
    "task",
    "create",
    capture.id,
    "--kind",
    "assignment",
    "--source",
    f.prompt,
    "--mode",
    "draft",
  ])
  const shown = f.cli(["simulate", "task", "show", task.id])
  expect(shown.task.hostExecutionVersion).toBe(1)
  expect(shown.task.workbookVersion).toBeUndefined()
  await f.writeCandidate(shown.task)
  await writeFile(join(f.vault, f.prompt), "Changed live source must not enrich the frozen task.")
  const result = f.cli(["simulate", "task", "complete", task.id, "--file", f.candidate])
  expect(result.workbook).toBeUndefined()
  expect(f.cli(["simulate", "task", "workbooks", task.id]).records).toEqual([])
  expect(f.cli(["simulate", "task", "calculations", task.id]).records).toEqual([])
  const files = await readdir(join(f.vault, "_meta/simulations/tasks", task.id))
  expect(files).not.toContain("output.xlsx")
  expect(files).not.toContain("calculations")
})
it("reads and completes an older workbook recipe and preserves its logs and companion while revisions use the new contract", async () => {
  const f = await fixture(),
    created = f.cli(["assignment", "CS101", "--source", f.prompt, "--mode", "draft"])
  await markLegacyTask(f.vault, created.id)
  const config = { ...JSON.parse(await readFile(f.config, "utf8")), vault: { path: f.vault } }
  await calculateTask(config, {
    taskId: created.id,
    operation: "multiply",
    values: "2,3",
    source: f.prompt,
  })
  const recipeFile = join(f.vault, "_meta/tasks", created.id, "task.json"),
    recipe = await readFile(recipeFile)
  const task = await readTask(f.vault, created.id)
  expect(task.workflow?.instructions.join("\n")).toContain("bounded calculate command")
  expect(await readFile(recipeFile)).toEqual(recipe)
  await f.writeCandidate(task)
  const completed = f.cli(["task", "complete", task.id, "--file", f.candidate]),
    workbook = await readFile(join(f.vault, completed.task.workbook.path))
  const logFile = join(f.vault, "_meta/tasks", task.id, "calculations.jsonl"),
    log = await readFile(logFile)
  const review = f.cli(["correctness", "prepare", task.id])
  expect(await readFile(review.handoffPath, "utf8")).toContain('"result": 6')
  const approved = f.cli(["approve", task.id])
  expect(await readFile(join(f.vault, approved.workbook.path))).toEqual(workbook)
  const revision = f.cli([
      "revise",
      task.id,
      "--feedback",
      "Use the same sources and clarify the conclusion.",
    ]),
    revised = await readTask(f.vault, revision.id)
  expect(revised.hostExecutionVersion).toBe(1)
  expect(revised.workbookVersion).toBeUndefined()
  expect(await readFile(logFile)).toEqual(log)
  expect(await readFile(join(f.vault, completed.task.workbook.path))).toEqual(workbook)
})
