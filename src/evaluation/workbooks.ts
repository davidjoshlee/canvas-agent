import { createHash, randomUUID } from "node:crypto"
import { mkdir, rmdir, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { assertNoSymlinks, readBoundedFile } from "../shared/fs-safety.js"
import { createWorkbook, parseWorkbookInput } from "../tasks/workbook.js"
import { inspectSimulationTask, readSimulationTask } from "./tasks.js"
import {
  readSimulationWorkbooksForRecord,
  SimulationWorkbookRecordSchema,
} from "./workbook-inventory.js"

export {
  SimulationWorkbookEvidenceSchema,
  SimulationWorkbookRecordSchema,
} from "./workbook-inventory.js"

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
const recordSchema = SimulationWorkbookRecordSchema

function json(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new Error("Workbook evidence must contain valid UTF-8 JSON; inspect locally")
  }
}
async function scope(vault: string, id: string) {
  const task = await readSimulationTask(vault, id)
  const directory = join(resolve(vault), "_meta/simulations/tasks", id, "workbooks")
  await assertNoSymlinks(directory, true)
  return { task, directory, recipeHash: hash(JSON.stringify(task)) }
}

/** Verify stored values-only companions against their input, bytes and frozen recipe. */
export async function readSimulationWorkbooks(vault: string, id: string) {
  const { task, directory, recipeHash } = await scope(vault, id)
  const evaluation = task.workbookVersion ? await inspectSimulationTask(vault, id) : undefined
  return readSimulationWorkbooksForRecord(vault, id, task, evaluation, directory, recipeHash)
}

/** Explicit JSON values to a private companion, never an automatic student submission. */
export async function createSimulationWorkbook(
  vault: string,
  id: string,
  file: string,
  sourcePath?: string,
) {
  if (
    !isAbsolute(file) ||
    /(?:^|\/)(?:\.env|credentials?|secrets?|passwords?|tokens?)(?:\.|$)/i.test(file)
  )
    throw new Error("Workbook input must be an absolute non-credential JSON file")
  const { task, directory, recipeHash } = await scope(vault, id)
  const source =
    sourcePath === undefined
      ? undefined
      : task.task.sources.find((item) => item.path === sourcePath)
  if (sourcePath !== undefined && !source)
    throw new Error("Workbook source is not selected frozen evidence")
  const parsed = parseWorkbookInput(json(await readBoundedFile(file, 5 * 1024 * 1024)))
  const input = JSON.stringify(parsed),
    bytes = await createWorkbook(parsed)
  const record = recordSchema.parse({
    version: 1,
    rendererVersion: 1,
    id: randomUUID(),
    taskId: id,
    simulationId: task.simulationId,
    snapshotHash: task.snapshotHash,
    recipeHash,
    at: new Date().toISOString(),
    output: "pending",
    hash: hash(bytes),
    inputHash: hash(input),
    size: bytes.length,
    sheets: parsed.sheets.map((sheet) => sheet.name),
    ...(source ? { source: { path: source.path, hash: source.hash } } : {}),
  })
  record.output = `_meta/simulations/tasks/${id}/workbooks/${record.id}/workbook.xlsx`
  const metadata = JSON.stringify(record),
    lock = `${directory}.lock`
  await assertNoSymlinks(lock, true)
  await mkdir(lock, { mode: 0o700 })
  try {
    const current = await readSimulationWorkbooks(vault, id)
    if (current.recipeHash !== recipeHash)
      throw new Error("Evaluation changed during workbook creation")
    const evaluation =
      task.workbookVersion === 1 ? await inspectSimulationTask(vault, id) : undefined
    const reserveAutomatic = evaluation?.state === "pending-host" ? 1 : 0
    if (
      current.records.length + reserveAutomatic >= 20 ||
      current.totalBytes + bytes.length + Buffer.byteLength(input + metadata) > 50_000_000
    )
      throw new Error("Evaluation workbook count or byte limit reached")
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await assertNoSymlinks(directory)
    const destination = join(directory, record.id)
    await mkdir(destination, { mode: 0o700 })
    await assertNoSymlinks(destination)
    await writeFile(join(destination, "input.json"), input, { flag: "wx", mode: 0o600 })
    await writeFile(join(destination, "workbook.xlsx"), bytes, { flag: "wx", mode: 0o600 })
    await writeFile(join(destination, "record.json"), metadata, { flag: "wx", mode: 0o600 })
  } finally {
    await rmdir(lock)
  }
  return {
    ...record,
    attributionVerified: false,
    note: "Private values-only evaluation workbook; no formulas/macros execute. Source context does not establish input grounding or academic correctness. ZIP timestamps are fixed for reproducibility, not execution-time evidence.",
  }
}
