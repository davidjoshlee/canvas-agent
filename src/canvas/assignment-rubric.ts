import { z } from "zod"

const description = z.string().max(12_000).nullable().optional()
const identity = z
  .union([z.string().max(256), z.number().finite()])
  .nullable()
  .optional()
const points = z.number().finite().nullable().optional()
const rating = z.object({ id: identity, description, long_description: description, points })
const criterion = z.object({
  id: identity,
  description,
  long_description: description,
  points,
  criterion_use_range: z.boolean().nullable().optional(),
  ratings: z.array(rating).max(100).nullable().optional(),
})
function criteria(value: unknown) {
  if (value === undefined || value === null) return []
  const parsed = z.array(criterion).max(200).safeParse(value)
  if (!parsed.success)
    throw new Error(
      "Assignment rubric has unsupported fields or exceeds bounds; no rubric body was echoed",
    )
  return parsed.data
}
/** Definition links only, never assessment comments or private grading objects. */
export function assignmentRubricHtml(value: unknown): string[] {
  return criteria(value)
    .flatMap((item) => [
      item.description,
      item.long_description,
      ...(item.ratings ?? []).flatMap((entry) => [entry.description, entry.long_description]),
    ])
    .filter((text): text is string => typeof text === "string")
}
/** Preserve supplied weights/ratings; unknown values stay unknown, not invented scores. */
export function renderAssignmentRubric(value: unknown, clean: (text: string) => string): string {
  const items = criteria(value)
  if (!items.length) return ""
  const display = (value: string | null | undefined) =>
    value === undefined || value === null ? "not provided" : JSON.stringify(clean(value))
  const output = [
    "## Rubric criteria (definition, not a grading assessment)",
    ...items.flatMap((item, index) => [
      `### Criterion ${index + 1}`,
      `Criterion ID: ${item.id === undefined || item.id === null ? "not provided" : JSON.stringify(item.id)}`,
      `Description: ${display(item.description)}`,
      `Details: ${display(item.long_description)}`,
      `Maximum points: ${item.points ?? "not provided"}`,
      `Use point range: ${item.criterion_use_range ?? "not provided"}`,
      ...(item.ratings ?? []).flatMap((entry, ratingIndex) => [
        `#### Rating ${ratingIndex + 1}`,
        `Rating ID: ${entry.id === undefined || entry.id === null ? "not provided" : JSON.stringify(entry.id)}`,
        `Rating points: ${entry.points ?? "not provided"}`,
        `Rating description: ${display(entry.description)}`,
        `Rating details: ${display(entry.long_description)}`,
      ]),
    ]),
  ].join("\n\n")
  if (Buffer.byteLength(output) > 1_000_000)
    throw new Error("Assignment rubric rendering exceeds 1 MB")
  return output
}
