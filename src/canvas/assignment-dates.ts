import { z } from "zod"

const date = z.string().datetime({ offset: true }).nullable().optional()
export const AssignmentDatesSchema = z
  .object({
    version: z.literal(1),
    effectiveDueAt: date,
    hasOverrides: z.boolean().optional(),
    alternativesCaptured: z.boolean(),
    alternatives: z
      .array(z.object({ base: z.boolean().optional(), dueAt: date }).strict())
      .max(1000),
  })
  .strict()
  .refine(
    (value) => value.alternativesCaptured || value.alternatives.length === 0,
    "Uncaptured date alternatives must be empty",
  )
export type AssignmentDates = z.infer<typeof AssignmentDatesSchema>

/** Keep requester-effective due_at distinct from all_dates. Drop identities,
 * titles and targeting data; visible alternatives do not establish applicability. */
export function captureAssignmentDates(value: Record<string, unknown>): AssignmentDates {
  const alternatives = value.all_dates == null ? undefined : value.all_dates
  if (alternatives !== undefined && !Array.isArray(alternatives))
    throw new Error("Assignment date evidence is unsupported; no payload was echoed")
  if (Array.isArray(alternatives) && alternatives.length > 1000)
    throw new Error("Assignment date evidence is unsupported; no payload was echoed")
  const parsed = AssignmentDatesSchema.safeParse({
    version: 1,
    ...(value.due_at !== undefined ? { effectiveDueAt: value.due_at } : {}),
    ...(value.has_overrides !== undefined ? { hasOverrides: value.has_overrides } : {}),
    alternativesCaptured: Array.isArray(alternatives),
    alternatives: Array.isArray(alternatives)
      ? alternatives.map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return null
          return {
            ...(item.base !== undefined ? { base: item.base } : {}),
            ...(item.due_at !== undefined ? { dueAt: item.due_at } : {}),
          }
        })
      : [],
  })
  if (!parsed.success)
    throw new Error("Assignment date evidence is unsupported; no payload was echoed")
  return parsed.data
}
