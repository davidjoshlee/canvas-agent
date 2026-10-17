import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import { assertNoSymlinks } from "../shared/fs-safety.js"
import { inspectSimulationTask, readSimulationTask } from "./tasks.js"
import { readSimulationWorkbooksForRecord } from "./workbook-inventory.js"

export {
  SimulationWorkbookEvidenceSchema,
  SimulationWorkbookRecordSchema,
} from "./workbook-inventory.js"

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")

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
