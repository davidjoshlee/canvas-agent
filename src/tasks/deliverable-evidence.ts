import { z } from "zod"
import type { SourceRecord } from "../shared/types.js"
import { detectDeliverable } from "./deliverable.js"

const item = z
  .object({ id: z.string().min(1).max(100), text: z.string().min(1).max(20_000) })
  .strict()
const scopeLabel = z
  .string()
  .regex(/^PART (?:[IVXLCDM]+|[A-Z]|\d{1,10})$/)
  .max(50)
export const DeliverableEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      version: z.literal(1),
      kind: z.literal("none"),
      suppressed: z.boolean(),
      scope: scopeLabel.optional(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.enum(["questions", "requirements"]),
      items: z.array(item).min(1).max(40),
      sourcePath: z.string().min(1),
      cue: z.string().min(1).max(100),
      scope: scopeLabel.optional(),
    })
    .strict(),
])
export type DeliverableEvidence = z.infer<typeof DeliverableEvidenceSchema>

export function captureTaskDeliverable(
  kind: "prep" | "assignment",
  mode: "outline" | "draft" | "review" | "discuss" | undefined,
  sources: SourceRecord[],
  guidance: SourceRecord[],
  scopeVersion?: 1,
  parserVersion: 1 | 2 | 3 = 1,
): DeliverableEvidence {
  if (kind === "prep" && mode !== undefined)
    throw new Error("Preparation deliverables do not accept an assignment mode")
  if (mode === "discuss") return { version: 1, kind: "none", suppressed: false }
  // School examines the prompt followed by selected course texts, including
  // attached case/question PDFs whose filenames need not mention questions.
  // Captured student work is never an authoritative requirements source.
  const candidates = sources.filter((source) => source.type !== "student-work")
  let scope: string | undefined
  if (scopeVersion && kind === "assignment") {
    const parts = [
      ...new Set(
        [...(sources[0]?.text ?? "").matchAll(/\bpart\s+([ivxlcdm]+|[a-z]|\d+)\b/gi)].map(
          (match) => `PART ${(match[1] ?? "").toUpperCase()}`,
        ),
      ),
    ]
    // A unique named part in the prompt can scope an attached multi-part case.
    // Multiple mentions do not authorize silently narrowing to the first part.
    if (parts.length === 1) scope = parts[0]
  }
  if (scope && /^PART \d/.test(scope) && parserVersion < 3)
    throw new Error(
      "Numeric named parts require scope review; the multipart parser supports Roman or letter labels",
    )
  const evidence = captureDeliverable(candidates, guidance, scope, parserVersion)
  if (scope && evidence.kind === "none" && !evidence.suppressed)
    throw new Error(
      "The assignment's named part has no detected deliverable; inspect source coverage and scope",
    )
  return scope ? DeliverableEvidenceSchema.parse({ ...evidence, scope }) : evidence
}

/** Pure snapshot derivation; callers remain responsible for source/policy scope. */
export function captureDeliverable(
  sources: Pick<SourceRecord, "path" | "text">[],
  guidance: Pick<SourceRecord, "path" | "text">[],
  scope?: string,
  parserVersion: 1 | 2 | 3 = 1,
): DeliverableEvidence {
  if (
    sources.length + guidance.length > 500 ||
    [...sources, ...guidance].reduce((size, source) => size + Buffer.byteLength(source.text), 0) >
      5_000_000
  )
    throw new Error("Deliverable evidence exceeds source bounds; narrow the task")
  if (scope !== undefined && !/^PART (?:[IVXLCDM]+|[A-Z]|\d{1,10})$/i.test(scope))
    throw new Error("Deliverable part scope is unsupported")
  // Only captured active guidance can disable the heuristic, not source text
  // claiming to be instructions or merely mentioning the word 'none'.
  if (
    guidance.some((source) =>
      /^##\s+Deliverable\s*\r?\n\s*none\s*(?=\r?\n##\s|$)/im.test(source.text),
    )
  )
    return { version: 1, kind: "none", suppressed: true }
  const detected = detectDeliverable(sources, scope, parserVersion)
  if (detected.kind === "none") return { version: 1, kind: "none", suppressed: false }
  const candidate = { version: 1, ...detected }
  const parsed = DeliverableEvidenceSchema.safeParse(candidate)
  if (!parsed.success || Buffer.byteLength(JSON.stringify(candidate)) > 500_000)
    throw new Error("Detected deliverable exceeds evidence bounds; narrow the task")
  return parsed.data
}
