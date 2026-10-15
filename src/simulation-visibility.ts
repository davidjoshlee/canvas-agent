import { z } from "zod"

const documentSchema = z
  .object({
    path: z.string().min(1).max(4096),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    type: z.string().max(256),
    canvasId: z.string().max(256).optional(),
    moduleCanvasId: z.string().max(256).optional(),
    members: z.array(z.string().max(4096)).max(10_000),
    explicitSignals: z
      .array(
        z
          .object({
            field: z.enum([
              "available_at",
              "unlock_at",
              "published_at",
              "posted_at",
              "dates.available_at",
              "dates.unlock_at",
              "dates.published_at",
              "dates.posted_at",
            ]),
            value: z.string(),
          })
          .strict(),
      )
      .max(8),
    invalid: z.boolean(),
    dates: z
      .object({
        unlock_at: z.string().optional(),
        session_at: z.string().optional(),
        due_at: z.string().optional(),
        created_at: z.string().optional(),
      })
      .strict(),
  })
  .strict()
const inventorySchema = z
  .object({
    version: z.literal(1),
    documents: z.array(documentSchema).max(10_000),
  })
  .strict()
export type VisibilityDocument = z.infer<typeof documentSchema>
export type VisibilityInventory = z.infer<typeof inventorySchema>
export const inferredSignalFields = [
  "school.module_release",
  "school.due_at",
  "school.created_at",
] as const

/** Strict calendar dates/ISO instants only, normalized to School's UTC day clock. */
export function visibilityDay(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d))?$/.test(value)
  )
    return undefined
  const day = value.slice(0, 10)
  const date = new Date(`${day}T00:00:00.000Z`)
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== day) return undefined
  const instant = Date.parse(value)
  return Number.isFinite(instant) ? new Date(instant).toISOString().slice(0, 10) : undefined
}
const moduleDocument = (document: VisibilityDocument) =>
  /module|session|milestone/i.test(document.type)
const shift = (day: string, days: number) =>
  new Date(Date.parse(day) + days * 86_400_000).toISOString().slice(0, 10)

export function validateVisibilityInventory(value: unknown, root: string): VisibilityInventory {
  const parsed = inventorySchema.safeParse(value)
  if (!parsed.success) throw new Error("Invalid structural visibility inventory")
  const paths = new Set<string>()
  for (const document of parsed.data.documents) {
    if (
      !document.path.startsWith(`${root}/`) ||
      document.path.includes("\\") ||
      document.path
        .split("/")
        .some((part) => part === ".." || part.startsWith(".") || part === "_meta") ||
      paths.has(document.path) ||
      Object.values(document.dates).some((value) => !visibilityDay(value)) ||
      document.explicitSignals.some((signal) => !visibilityDay(signal.value)) ||
      new Set(document.explicitSignals.map((signal) => signal.field)).size !==
        document.explicitSignals.length
    )
      throw new Error("Invalid structural visibility inventory scope or date")
    paths.add(document.path)
  }
  for (const document of parsed.data.documents)
    if (
      new Set(document.members).size !== document.members.length ||
      document.members.some((path) => !paths.has(path))
    )
      throw new Error("Invalid structural visibility membership scope")
  return parsed.data
}

/** School fallback order only. Explicit release signals are handled separately. */
export function inferVisibility(
  document: VisibilityDocument,
  inventory: VisibilityInventory,
): { field: string; value: string } | undefined {
  let module: VisibilityDocument | undefined
  if (document.dates.session_at) module = document
  else if (document.moduleCanvasId) {
    const matches = inventory.documents.filter(
      (item) => moduleDocument(item) && item.canvasId === document.moduleCanvasId,
    )
    if (matches.length > 1) throw new Error("Structural visibility module identity is ambiguous")
    module = matches[0]
  } else {
    const matches = inventory.documents.filter(
      (item) => moduleDocument(item) && item.members.includes(document.path),
    )
    if (matches.length > 1) throw new Error("Structural visibility membership is ambiguous")
    module = matches[0]
  }
  if (module) {
    const unlock = visibilityDay(module.dates.unlock_at)
    const session = visibilityDay(module.dates.session_at)
    if (unlock || session)
      return { field: "school.module_release", value: unlock ?? shift(session as string, -7) }
  }
  const due = visibilityDay(document.dates.due_at)
  if (due) return { field: "school.due_at", value: due }
  const floor = inventory.documents
    .flatMap((item) => [
      ...(moduleDocument(item) ? [visibilityDay(item.dates.session_at)] : []),
      ...(/^assignments?(?:\.md)?$/i.test(item.type) ? [visibilityDay(item.dates.due_at)] : []),
    ])
    .filter((day): day is string => Boolean(day))
    .sort()[0]
  const created = visibilityDay(document.dates.created_at)
  if (floor && created && created > shift(floor, -14))
    return { field: "school.created_at", value: created }
  return undefined
}
