import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { assertNoSymlinks } from "./fs-safety.js"
import { renderPortableDocument } from "./portable-document.js"

const schema = z
  .object({
    canvasOrigin: z.url().refine((value) => {
      const url = new URL(value)
      return (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      )
    }, "Compatible ingestion needs a credential-free Canvas URL"),
    aiPolicy: z.enum(["allowed", "prohibited"]),
    redistribution: z.enum(["allowed", "restricted"]),
  })
  .strict()
export type IngestCompatibility = z.infer<typeof schema>
const sha = (value: string) => createHash("sha256").update(value).digest("hex")
const provenanceSchema = z
  .object({
    version: z.literal(1),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    originalPath: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (path) =>
          !path.startsWith("/") &&
          !path.includes("\\") &&
          !path
            .split("/")
            .some(
              (part) =>
                !part ||
                part === "." ||
                part === ".." ||
                part.startsWith("_") ||
                part.startsWith("."),
            ),
      ),
    originalHash: z.string().regex(/^[a-f0-9]{64}$/),
    availableAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict()
export async function readIngestProvenance(path: string) {
  await assertNoSymlinks(path)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 100_000) throw new Error("Unsafe compatible provenance")
    const buffer = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length !== stat.size) throw new Error("Compatible provenance changed while reading")
    try {
      const data = provenanceSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))),
      )
      return { data, hash: createHash("sha256").update(buffer.subarray(0, length)).digest("hex") }
    } catch {
      throw new Error("Compatible provenance is malformed; contents withheld")
    }
  } finally {
    await file.close()
  }
}

export function assertCompatibleOriginalPolicy(
  bytes: Uint8Array,
  extension: string,
  declarations: IngestCompatibility,
): void {
  if (![".md", ".markdown", ".txt"].includes(extension)) return
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  if (!text.startsWith("---")) return
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1]
  if (header === undefined || Buffer.byteLength(header) > 100_000)
    throw new Error("Compatible ingestion cannot classify original policy metadata")
  let metadata: unknown
  try {
    metadata = parseYaml(header)
  } catch {
    throw new Error("Compatible ingestion cannot classify original policy metadata")
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("Compatible ingestion cannot classify original policy metadata")
  const data = metadata as Record<string, unknown>
  for (const field of ["ai_policy", "policy", "redistribution"]) {
    const value = data[field]
    if (value === undefined || value === null || value === "") continue
    if (
      !["allowed", "allow", "permitted"].includes(String(value).trim().toLowerCase()) &&
      ((field === "ai_policy" && declarations.aiPolicy !== "prohibited") ||
        (field === "redistribution" && declarations.redistribution !== "restricted") ||
        (field === "policy" &&
          (declarations.aiPolicy !== "prohibited" || declarations.redistribution !== "restricted")))
    )
      throw new Error(
        "Original policy metadata is restricted or unknown; compatible ingestion cannot override it",
      )
  }
}

/** Explicit declarations only: never infer permission from course/API success. */
export function ingestCompatibility(input: IngestCompatibility, courseId?: string) {
  const parsed = schema.safeParse(input)
  if (!parsed.success)
    throw new Error(
      "School-compatible ingest requires a safe Canvas URL and explicit AI-policy/redistribution declarations",
    )
  if (!courseId || !/^\d{1,20}$/.test(courseId))
    throw new Error("School-compatible ingest requires a mapped numeric Canvas course ID")
  const value = { ...parsed.data, canvasOrigin: new URL(parsed.data.canvasOrigin).origin }
  return {
    ...value,
    courseUrl: `${value.canvasOrigin}/courses/${courseId}`,
    suffix: `.school-${sha(JSON.stringify({ ...value, courseId })).slice(0, 12)}`,
  }
}

export function renderCompatibleIngestion(input: {
  compatibility: ReturnType<typeof ingestCompatibility>
  originalPath: string
  originalHash: string
  body: string
  title: string
  asOf?: string
  week?: string
  module?: string
}) {
  const identity = sha(
    JSON.stringify({
      path: input.originalPath,
      hash: input.originalHash,
      course: input.compatibility.courseUrl,
      week: input.week,
      asOf: input.asOf,
      module: input.module,
      title: input.title,
      policy: input.compatibility.suffix,
    }),
  )
  const document = renderPortableDocument({
    canvasId: `manual-${identity}`,
    canvasUrl: input.compatibility.courseUrl,
    kind: "file",
    title: input.title,
    body: input.body,
    source: "user",
    status: "final",
    aiPolicy: input.compatibility.aiPolicy,
    redistribution: input.compatibility.redistribution,
    dates: {
      ...(input.week ? { date: input.week } : {}),
      ...(input.asOf ? { created_at: input.asOf } : {}),
    },
    ...(input.module ? { moduleCanvasId: input.module } : {}),
  })
  return {
    markdown: document.markdown,
    provenance: provenanceSchema.parse({
      version: 1,
      hash: sha(document.markdown),
      originalPath: input.originalPath,
      originalHash: input.originalHash,
      ...(input.asOf ? { availableAt: input.asOf } : {}),
    }),
  }
}
