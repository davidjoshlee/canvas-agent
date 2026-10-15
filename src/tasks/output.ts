import { readSavedSimulationOutput } from "../evaluation/tasks.js"
import { checkArtifactPrivacy, readSavedCompletedOutput } from "./completion.js"
import { type TaskScope, taskLocations } from "./locations.js"

/** Existing output integrity only; neither generation nor academic approval. */
export async function readTaskOutput(config: string, vault: string, id: string, scope: TaskScope) {
  if (scope !== "ordinary" && scope !== "frozen") throw new Error("Unknown task output scope")
  const saved = scope === "ordinary" ? await readSavedCompletedOutput(vault, id) : null
  const frozen = scope === "frozen" ? await readSavedSimulationOutput(vault, id) : null
  const task = saved?.task ?? frozen?.record.task
  if (!task) throw new Error("Saved task output is unavailable")
  const output = saved?.output ?? frozen?.record.completion.output
  const workbook = saved?.task.workbook?.path ?? frozen?.record.completion.workbook?.output
  let text: string
  if (saved) {
    if (saved.bytes.includes(0)) throw new Error("Saved output is not safe UTF-8")
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(saved.bytes)
    } catch {
      throw new Error("Saved output is not safe UTF-8")
    }
  } else text = frozen?.text ?? ""
  checkArtifactPrivacy(text, task)
  return {
    id: task.id,
    ...taskLocations(config, vault, id, scope, output, workbook),
    state: scope === "ordinary" ? "completed" : "completed-pending-human",
    outputHash: task.outputHash ?? frozen?.record.completion.outputHash,
    outputIntegrityVerified: true,
    text,
    sourceCurrentnessVerified: false,
    academicCorrectnessVerified: false,
    permissionVerified: false,
    note: "Read-only saved output. These bytes match the checked task completion metadata; this is not authenticated authorship, current source coverage, academic correctness, approval or Canvas submission. No replacement task, artifact or receipt was written. Frozen verdict remains pending-human.",
  }
}
