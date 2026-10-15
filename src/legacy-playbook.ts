import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { assertNoSymlinks } from "./fs-safety.js"
import { inspectWorkspace, selectCourse } from "./workspace.js"

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const LegacyPlaybookSchema = z
  .object({
    version: z.literal(1),
    course: z.string(),
    root: z.string(),
    courseId: z.string().regex(/^[1-9]\d*$/),
    origin: z.string().url(),
    source: z.string(),
    sourceHash: digest,
    text: z.string().max(1_000_000),
    importedAt: z.string().datetime(),
    historicalAuthorshipVerified: z.literal(false),
    historicalDatesVerified: z.literal(false),
    hash: digest,
  })
  .strict()
  .superRefine((value, context) => {
    const { hash, ...body } = value
    let originValid = false
    try {
      originValid = new URL(value.origin).origin === value.origin
    } catch {}
    if (
      sha(JSON.stringify(body)) !== hash ||
      !originValid ||
      value.source !== `${value.root}/_meta/course-playbook.md` ||
      Buffer.byteLength(value.text) > 1_000_000
    )
      context.addIssue({ code: "custom", message: "Legacy playbook binding mismatch" })
  })
export type LegacyPlaybook = z.infer<typeof LegacyPlaybookSchema>
async function readText(path: string, privateFile = false) {
  await assertNoSymlinks(path)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > 1_000_000 || (privateFile && info.mode & 0o077))
      throw new Error("Legacy playbook is not a bounded permitted regular file")
    const bytes = Buffer.alloc(1_000_001)
    let count = 0
    while (count < bytes.length) {
      const chunk = await file.read(bytes, count, bytes.length - count, count)
      if (!chunk.bytesRead) break
      count += chunk.bytesRead
    }
    if (count > 1_000_000 || bytes.subarray(0, count).includes(0))
      throw new Error("Legacy playbook exceeds text bounds")
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count))
    } catch {
      throw new Error("Legacy playbook is not valid UTF-8")
    }
  } finally {
    await file.close()
  }
}
function directory(vault: string, course: { root: string; canvasId?: string }) {
  if (!course.canvasId || !/^[1-9]\d*$/.test(course.canvasId))
    throw new Error("Legacy playbook requires a known Canvas course identity")
  return join(resolve(vault), "_meta/canvas-playbooks", course.canvasId, sha(course.root))
}
async function inspect(vault: string, query: string, canvasBase: string) {
  const course = selectCourse(await inspectWorkspace(vault), query)
  directory(vault, course)
  const source = `${course.root}/_meta/course-playbook.md`
  const raw = await readText(join(resolve(vault), source))
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/)
  if (!match) throw new Error("Legacy School playbook needs supported frontmatter")
  let metadata: unknown
  try {
    metadata = parseYaml(match[1] ?? "")
  } catch {
    throw new Error("Legacy playbook frontmatter is invalid; inspect privately")
  }
  const schema = z
    .object({
      canvas_id: z.literal("course-playbook"),
      canvas_url: z.string().url(),
      type: z.literal("course-playbook.md"),
      ai_policy: z.literal("allowed"),
      redistribution: z.literal("allowed"),
    })
    .safeParse(metadata)
  if (!schema.success)
    throw new Error("Legacy playbook identity/policy is unsupported or restricted")
  const url = new URL(schema.data.canvas_url),
    base = new URL(canvasBase)
  if (
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/$/, "") !== `/courses/${course.canvasId}`
  )
    throw new Error("Legacy playbook Canvas URL does not match the chosen account/course")
  const text = raw.slice(match[0].length)
  if (!text.trim()) throw new Error("Legacy playbook has no readable learning context")
  return { course, source, sourceHash: sha(raw), text, origin: url.origin }
}
export async function inspectLegacyPlaybook(vault: string, query: string, canvasBase: string) {
  const value = await inspect(vault, query, canvasBase)
  return {
    course: value.course.code,
    source: value.source,
    sourceHash: value.sourceHash,
    bytes: Buffer.byteLength(value.text),
    historicalAuthorshipVerified: false,
    historicalDatesVerified: false,
    limitation:
      "Current legacy file only. Old date headings/comments are unverified reference text, not authenticated feedback events or instructor permission. No source was changed or imported.",
  }
}
async function readImported(path: string) {
  let value: unknown
  const text = await readText(path, true)
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error("Legacy playbook snapshot is invalid; inspect privately")
  }
  const parsed = LegacyPlaybookSchema.safeParse(value)
  if (!parsed.success) throw new Error("Legacy playbook snapshot binding is invalid")
  return parsed.data
}
export async function importLegacyPlaybook(vault: string, query: string, canvasBase: string) {
  const value = await inspect(vault, query, canvasBase)
  const target = directory(vault, value.course),
    path = join(target, `${value.sourceHash}.json`)
  await assertNoSymlinks(target, true)
  await mkdir(target, { recursive: true, mode: 0o700 })
  await assertNoSymlinks(target)
  if ((await lstat(target)).mode & 0o077)
    throw new Error("Legacy playbook snapshot directory is not private")
  const body = {
    version: 1 as const,
    course: value.course.code,
    root: value.course.root,
    courseId: value.course.canvasId as string,
    origin: value.origin,
    source: value.source,
    sourceHash: value.sourceHash,
    text: value.text,
    importedAt: new Date().toISOString(),
    historicalAuthorshipVerified: false as const,
    historicalDatesVerified: false as const,
  }
  const record = LegacyPlaybookSchema.parse({ ...body, hash: sha(JSON.stringify(body)) })
  try {
    const file = await open(path, "wx", 0o600)
    try {
      await file.writeFile(JSON.stringify(record))
      await file.sync()
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const existing = await readImported(path)
    if (
      existing.sourceHash !== record.sourceHash ||
      existing.text !== record.text ||
      existing.root !== record.root ||
      existing.courseId !== record.courseId ||
      existing.origin !== record.origin
    )
      throw new Error("Existing legacy snapshot differs; it was preserved")
    return {
      course: existing.course,
      source: existing.source,
      sourceHash: existing.sourceHash,
      hash: existing.hash,
      reused: true,
    }
  }
  return {
    course: record.course,
    source: record.source,
    sourceHash: record.sourceHash,
    hash: record.hash,
    reused: false,
  }
}
export async function readImportedPlaybooks(
  vault: string,
  course: { code: string; root: string; canvasId?: string },
) {
  if (!course.canvasId) return []
  const target = directory(vault, course)
  await assertNoSymlinks(target, true)
  const files = await readdir(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  })
  if (files.length > 50) throw new Error("Imported playbook inventory exceeds 50 snapshots")
  const records: LegacyPlaybook[] = []
  for (const file of files.sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue
    const record = await readImported(join(target, file))
    if (
      record.sourceHash !== file.slice(0, -5) ||
      record.root !== course.root ||
      record.courseId !== course.canvasId
    )
      throw new Error("Imported playbook course/filename binding changed")
    records.push(record)
    if (Buffer.byteLength(JSON.stringify(records)) > 5_000_000)
      throw new Error("Imported playbook context exceeds 5 MB")
  }
  return records
}
