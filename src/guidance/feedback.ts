import { createHash } from "node:crypto"
import { z } from "zod"
import {
  type LearningHistory,
  LearningHistorySchema,
  readCoursePlaybook,
} from "../feedback/history.js"

export const ProposalFeedbackAssignmentsSchema = z
  .array(
    z
      .string()
      .regex(/^[1-9]\d*$/)
      .max(40),
  )
  .min(1)
  .max(5)
  .refine((ids) => new Set(ids).size === ids.length, "Feedback assignment scope must be unique")
export const ProposalFeedbackSchema = LearningHistorySchema.superRefine((history, ctx) => {
  if (
    history.records.length > 5 ||
    history.observations ||
    history.legacyPlaybooks ||
    history.records.some((row) => !row.currentAtCapture) ||
    Buffer.byteLength(JSON.stringify(history)) > 500_000
  )
    ctx.addIssue({
      code: "custom",
      message:
        "Proposal feedback exceeds five current records/500 KB or contains unsupported history",
    })
})

/** Only scoped current cached values; not instructor authorship or grade chronology. */
export async function captureProposalFeedback(
  vault: string,
  course: { code: string; root: string; canvasId?: string },
  assignments?: string[],
): Promise<LearningHistory | undefined> {
  if (assignments) ProposalFeedbackAssignmentsSchema.parse(assignments)
  if (!course.canvasId) {
    if (assignments) throw new Error("Explicit proposal feedback needs a known Canvas course ID")
    return undefined
  }
  const { history } = await readCoursePlaybook(vault, course.code, assignments)
  if (
    history.course !== course.code ||
    history.root !== course.root ||
    history.courseId !== course.canvasId
  )
    throw new Error("Proposal feedback course binding changed")
  const records = history.records
    .filter(
      (row) =>
        row.currentAtCapture &&
        (row.data.score !== null ||
          row.data.grade !== null ||
          row.data.comments.length ||
          row.data.rubric.length),
    )
    .sort(
      (a, b) =>
        (b.checkedAt ?? "").localeCompare(a.checkedAt ?? "") ||
        a.assignmentId.localeCompare(b.assignmentId),
    )
    .slice(0, 5)
  if (!records.length) return undefined
  const body = {
    version: 1 as const,
    course: history.course,
    root: history.root,
    courseId: history.courseId,
    records,
  }
  return ProposalFeedbackSchema.parse({
    ...body,
    hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  })
}

/** An unchanged cache refresh is not new feedback; selected IDs/value hashes still must match. */
export function sameProposalFeedback(left?: LearningHistory, right?: LearningHistory): boolean {
  const identity = (history?: LearningHistory) =>
    history
      ? {
          course: history.course,
          root: history.root,
          courseId: history.courseId,
          records: history.records
            .map(({ assignmentId, dataHash }) => ({ assignmentId, dataHash }))
            .sort((a, b) => a.assignmentId.localeCompare(b.assignmentId)),
        }
      : null
  return JSON.stringify(identity(left)) === JSON.stringify(identity(right))
}

export const proposalFeedbackInstruction =
  "The separate private learningHistory contains at most five current-at-capture cached own-feedback values, selected by local checked time (not grading chronology). Use supported lessons to inform this private proposal, distinguishing graded-deliverable expectations from weekly prep shape. Do not infer instructor authorship, current grades, historical access or AI permission, predict grades, override current sources/guidance, cite private metadata paths or publish/share feedback. Proposed files stay inactive and excluded from reading copies; review/redact private observations before any manual activation or sharing."
