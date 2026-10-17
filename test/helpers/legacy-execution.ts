/** Synthetic archived-format fixtures. These writers are test-only and never ship in the CLI. */
import { createHash, randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ToolkitConfig } from "../../src/shared/types.js"
import { SimulationCalculationRecordSchema } from "../../src/simulation/calculations.js"
import { createSimulationTask, readSimulationTask } from "../../src/simulation/tasks.js"
import { SimulationWorkbookRecordSchema } from "../../src/simulation/workbook-inventory.js"
import { readTask } from "../../src/tasks/artifacts/records.js"
import { createAssignmentTask } from "../../src/tasks/authoring/creation.js"
import { workflowForRequirements } from "../../src/tasks/authoring/workflows.js"
import { calculateValues } from "../../src/tasks/compatibility/calculation-core.js"
import { createWorkbook, parseWorkbookInput } from "../../src/tasks/compatibility/workbook.js"

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")

export async function markLegacyTask(vault: string, id: string, frozen = false) {
  const file = join(
    vault,
    frozen ? "_meta/simulations/tasks" : "_meta/tasks",
    id,
    frozen ? "record.json" : "task.json",
  )
  const record = JSON.parse(await readFile(file, "utf8"))
  const task = frozen ? record.task : record
  delete task.hostExecutionVersion
  delete record.hostExecutionVersion
  task.workflow.instructions = task.workflow.instructions.filter(
    (value: string) => !value.startsWith("The coding harness owns reasoning"),
  )
  const legacyCalculationInstruction = workflowForRequirements({
    kind: "assignment",
    mode: "draft",
    sections: [],
    questions: [],
  }).instructions.find((value) => value.startsWith("For derived quantitative values"))
  task.workflow.instructions = task.workflow.instructions.map((value: string) =>
    value.startsWith("Use the coding harness and its tools to execute calculations")
      ? legacyCalculationInstruction
      : value,
  )
  if (task.assignment?.mode === "draft") {
    task.workbookVersion = 1
    if (frozen) record.workbookVersion = 1
  }
  await writeFile(file, JSON.stringify(record))
}
export async function createLegacyAssignmentTask(...args: Parameters<typeof createAssignmentTask>) {
  const task = await createAssignmentTask(...args)
  await markLegacyTask(args[0], task.id)
  return readTask(args[0], task.id)
}
export async function createLegacySimulationTask(...args: Parameters<typeof createSimulationTask>) {
  const task = await createSimulationTask(...args)
  await markLegacyTask(args[0], task.id, true)
  return task
}
export async function calculateTask(
  config: ToolkitConfig,
  args: { taskId: string; operation: string; values: string; rate?: number; source?: string },
) {
  const task = await readTask(config.vault.path, args.taskId)
  const input = args.values.split(",").map(Number)
  const source = task.sources.find((source) => source.path === args.source)
  const record = {
    version: 1,
    time: new Date().toISOString(),
    operation: args.operation,
    input,
    result: calculateValues(args.operation, input, args.rate),
    ...(args.rate === undefined ? {} : { rate: args.rate }),
    ...(source ? { source: { path: source.path, hash: source.hash } } : {}),
  }
  await appendFile(
    join(config.vault.path, "_meta/tasks", task.id, "calculations.jsonl"),
    `${JSON.stringify(record)}\n`,
    { mode: 0o600 },
  )
  return record
}
export async function calculateSimulationBatch(
  vault: string,
  id: string,
  items: Array<{ operation: string; values: number[]; rate?: number; source?: string }>,
) {
  const task = await readSimulationTask(vault, id)
  const record = SimulationCalculationRecordSchema.parse({
    version: 1,
    id: randomUUID(),
    taskId: id,
    simulationId: task.simulationId,
    snapshotHash: task.snapshotHash,
    recipeHash: hash(JSON.stringify(task)),
    at: new Date().toISOString(),
    results: items.map((item) => {
      const source = task.task.sources.find((source) => source.path === item.source)
      return {
        operation: item.operation,
        input: item.values,
        result: calculateValues(item.operation, item.values, item.rate),
        ...(item.rate === undefined ? {} : { rate: item.rate }),
        ...(source ? { source: { path: source.path, hash: source.hash } } : {}),
      }
    }),
  })
  const directory = join(vault, "_meta/simulations/tasks", id, "calculations")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, `${record.id}.json`), JSON.stringify(record), {
    flag: "wx",
    mode: 0o600,
  })
  return { ...record, attributionVerified: false }
}
export async function createSimulationWorkbook(
  vault: string,
  id: string,
  file: string,
  sourcePath?: string,
) {
  const task = await readSimulationTask(vault, id)
  const parsed = parseWorkbookInput(JSON.parse(await readFile(file, "utf8")))
  const input = JSON.stringify(parsed),
    bytes = await createWorkbook(parsed),
    entryId = randomUUID()
  const source = task.task.sources.find((source) => source.path === sourcePath)
  const output = `_meta/simulations/tasks/${id}/workbooks/${entryId}/workbook.xlsx`
  const record = SimulationWorkbookRecordSchema.parse({
    version: 1,
    rendererVersion: 1,
    id: entryId,
    taskId: id,
    simulationId: task.simulationId,
    snapshotHash: task.snapshotHash,
    recipeHash: hash(JSON.stringify(task)),
    at: new Date().toISOString(),
    output,
    hash: hash(bytes),
    inputHash: hash(input),
    size: bytes.length,
    sheets: parsed.sheets.map((sheet) => sheet.name),
    ...(source ? { source: { path: source.path, hash: source.hash } } : {}),
  })
  const directory = join(vault, "_meta/simulations/tasks", id, "workbooks", entryId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, "input.json"), input, { flag: "wx", mode: 0o600 })
  await writeFile(join(directory, "workbook.xlsx"), bytes, { flag: "wx", mode: 0o600 })
  await writeFile(join(directory, "record.json"), JSON.stringify(record), {
    flag: "wx",
    mode: 0o600,
  })
  return { ...record, attributionVerified: false }
}
