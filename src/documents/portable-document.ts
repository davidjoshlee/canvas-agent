import { createHash } from "node:crypto"
import { z } from "zod"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
// This is a portable document contract, not inferred instructor permission.
const metadataSchema = z
  .object({
    canvas_id: z.string().min(1).max(200),
    canvas_url: z.url().refine((value) => {
      const url = new URL(value)
      return (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        ![...url.searchParams.keys()].some((key) =>
          /^(?:access_token|token|auth|signature|x-amz-signature|x-goog-signature)$/i.test(key),
        )
      )
    }, "Portable links cannot contain credentials or non-web protocols"),
    type: z.string().min(1).max(100),
    dates: z.record(z.string().max(100), z.string().max(1000).nullable()),
    module_canvas_id: z.string().min(1).max(200).optional(),
    content_hash: digest,
    source: z.enum(["sync", "agent", "user"]),
    status: z.enum(["draft", "approved", "final", "auto-final"]),
    ai_policy: z.enum(["allowed", "prohibited"]),
    redistribution: z.enum(["allowed", "restricted"]),
    model: z.string().min(1).max(200).optional(),
  })
  .strict()

/** Canvas-only facts live beside the document, never in strict School YAML.
 * There are deliberately no policy/status/source overrides in this schema.
 */
export const PortableContextSchema = z
  .object({
    hash: digest,
    title: z.string().min(1).max(4096),
    kind: z.enum([
      "course",
      "syllabus",
      "assignment",
      "page",
      "file",
      "module",
      "discussion",
      "announcement",
    ]),
    modulePosition: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    relatedPaths: z.array(z.string().min(1).max(4096)).max(5000).optional(),
    originalPath: z.string().min(1).max(4096).optional(),
    originalHash: digest.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Boolean(value.originalPath) !== Boolean(value.originalHash))
      ctx.addIssue({ code: "custom", message: "Original provenance requires both path and hash" })
    const paths = [
      ...(value.relatedPaths ?? []),
      ...(value.originalPath ? [value.originalPath] : []),
    ]
    for (const path of paths) {
      if (
        path.startsWith("/") ||
        path.includes("\\") ||
        path
          .split("/")
          .some(
            (part) =>
              !part ||
              part === "." ||
              part === ".." ||
              part.startsWith("_") ||
              part.startsWith("."),
          )
      )
        ctx.addIssue({
          code: "custom",
          message: "Portable context needs safe course-relative inventory paths",
        })
    }
  })

type Metadata = z.infer<typeof metadataSchema>
export type PortableContext = z.infer<typeof PortableContextSchema>
export interface PortableDocument {
  markdown: string
  context: PortableContext
}
export interface PortableDocumentInput {
  canvasId: string
  canvasUrl: string
  kind: PortableContext["kind"]
  title: string
  /** Finished source body, without YAML. Module roots use the typed item shape. */
  body: string
  dates?: Metadata["dates"]
  moduleCanvasId?: string
  source: Metadata["source"]
  status: Metadata["status"]
  /** Required explicit technical eligibility; never inferred from Canvas success. */
  aiPolicy: Metadata["ai_policy"]
  redistribution: Metadata["redistribution"]
  model?: string
  modulePosition?: number
  relatedPaths?: string[]
  originalPath?: string
  originalHash?: string
}
const kinds = {
  course: "courses",
  syllabus: "syllabus",
  assignment: "assignments",
  page: "modules",
  file: "files",
  module: "modules",
  discussion: "modules",
  announcement: "announcements",
} as const
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

/** No I/O or defaults that grant eligibility. Context must be persisted with its
 * full-document hash before a caller claims that a synced sidecar is usable.
 */
export function renderPortableDocument(input: PortableDocumentInput): PortableDocument {
  if (
    typeof input.body !== "string" ||
    Buffer.byteLength(input.body) > 5 * 1024 * 1024 ||
    input.body.includes("\0")
  )
    throw new Error("Portable document body must be bounded safe text")
  const body = `${input.body.replace(/\r\n/g, "\n").replace(/\n*$/, "")}\n`
  const metadata = metadataSchema.parse({
    canvas_id: input.canvasId,
    canvas_url: input.canvasUrl,
    type: kinds[input.kind],
    dates: input.dates ?? {},
    content_hash: sha(body),
    source: input.source,
    status: input.status,
    ai_policy: input.aiPolicy,
    redistribution: input.redistribution,
    ...(input.moduleCanvasId === undefined ? {} : { module_canvas_id: input.moduleCanvasId }),
    ...(input.model === undefined ? {} : { model: input.model }),
  })
  // JSON scalar/flow forms are valid YAML and prevent source-supplied YAML keys.
  const yaml = Object.entries(metadata)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n")
  const markdown = `---\n${yaml}\n---\n${body}`
  if (Buffer.byteLength(markdown) > 5 * 1024 * 1024)
    throw new Error("Portable document exceeds the 5 MB limit")
  const context = PortableContextSchema.parse({
    hash: sha(markdown),
    title: input.title,
    kind: input.kind,
    ...(input.modulePosition === undefined ? {} : { modulePosition: input.modulePosition }),
    ...(input.relatedPaths === undefined ? {} : { relatedPaths: input.relatedPaths }),
    ...(input.originalPath === undefined ? {} : { originalPath: input.originalPath }),
    ...(input.originalHash === undefined ? {} : { originalHash: input.originalHash }),
  })
  if (Buffer.byteLength(JSON.stringify(context)) > 1_000_000)
    throw new Error("Portable context exceeds the 1 MB limit")
  return { markdown, context }
}
