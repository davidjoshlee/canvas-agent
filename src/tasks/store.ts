/** Compatibility exports for callers saved before task responsibilities were split. */

export { readTask, TaskRecordSchema } from "./artifacts/records.js"
export { createAssignmentTask, createPrepTask } from "./authoring/creation.js"
export {
  hasPrepMaterial,
  readGuidanceSnapshot,
  readSelectedGuidance,
  readStudentWork,
  resolvePrepDestination,
  resolveSessionRoot,
  selectAssignmentInputs,
  selectAssignmentPrompt,
  selectLegacyPrepInputs,
  selectPrepInputs,
  validateDiscussionMessage,
  verifySourceSnapshot,
} from "./authoring/recipes.js"
