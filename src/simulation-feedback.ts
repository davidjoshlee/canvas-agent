import { z } from "zod"
import {
  FeedbackDataSchema,
  feedbackDirectory,
  feedbackHash,
  readOwnFeedback,
  validateFeedbackArchive,
} from "./canvas-feedback.js"

export const ReviewFeedbackSchema = z
  .object({
    courseId: z.string().regex(/^[1-9]\d*$/),
    assignmentId: z.string().regex(/^[1-9]\d*$/),
    checkedAt: z.string().datetime(),
    dataHash: z.string().regex(/^[a-f0-9]{64}$/),
    data: FeedbackDataSchema,
    use: z.literal("review-only"),
    currentGradeVerified: z.literal(false),
    authorshipVerified: z.literal(false),
    accountSubjectVerified: z.literal(false),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.data.courseId !== record.courseId ||
      record.data.assignmentId !== record.assignmentId ||
      feedbackHash(record.data) !== record.dataHash ||
      record.data.rubric.some((entry) => !entry.criterion.trim()) ||
      new Set(record.data.rubric.map((entry) => entry.criterion)).size !== record.data.rubric.length
    )
      context.addIssue({ code: "custom", message: "Review feedback scope/hash differs" })
  })
export type ReviewFeedback = z.infer<typeof ReviewFeedbackSchema>
export async function captureReviewFeedback(
  vault: string,
  course: { code: string; canvasId?: string },
  assignments: string[],
) {
  if (
    assignments.length > 20 ||
    new Set(assignments).size !== assignments.length ||
    assignments.some((value) => !/^[1-9]\d*$/.test(value))
  )
    throw new Error("Comparison needs at most 20 distinct exact feedback assignment IDs")
  if (assignments.length && !course.canvasId)
    throw new Error("Review feedback needs a known selected Canvas course identity")
  const records: ReviewFeedback[] = []
  for (const id of assignments) {
    const feedback = await readOwnFeedback(vault, course.code, id)
    records.push(
      ReviewFeedbackSchema.parse({
        courseId: course.canvasId,
        assignmentId: id,
        checkedAt: feedback.checkedAt,
        dataHash: feedback.dataHash,
        data: feedback.feedback,
        use: "review-only",
        currentGradeVerified: false,
        authorshipVerified: false,
        accountSubjectVerified: false,
      }),
    )
  }
  return records
}
export function reviewFeedbackPath(record: ReviewFeedback) {
  return `_meta/canvas-feedback/${record.courseId}/${record.assignmentId}/${record.dataHash}.json`
}
export async function verifyReviewFeedback(
  vault: string,
  course: { canvasId?: string },
  records: ReviewFeedback[],
) {
  for (const record of records) {
    const parsed = ReviewFeedbackSchema.safeParse(record)
    if (!parsed.success || record.courseId !== course.canvasId)
      throw new Error("Comparison review feedback course/binding changed")
    const data = await validateFeedbackArchive(
      feedbackDirectory(vault, record.courseId, record.assignmentId),
      record.dataHash,
    )
    if (
      feedbackHash(data) !== record.dataHash ||
      JSON.stringify(data) !== JSON.stringify(record.data)
    )
      throw new Error("Captured review feedback archive changed")
  }
}
export function feedbackCriterionRows(records: ReviewFeedback[], assignmentId?: string) {
  return records
    .filter((record) => record.assignmentId === assignmentId)
    .flatMap((record) =>
      record.data.rubric.map((entry) => ({
        reference: reviewFeedbackPath(record),
        criterion: entry.criterion,
      })),
    )
}
