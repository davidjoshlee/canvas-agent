/** Compatibility exports for callers saved before task responsibilities were split. */

export { createAssignmentTask, createPrepTask } from "./creation.js"
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
} from "./recipes.js"
export { readTask, TaskRecordSchema } from "./records.js"
