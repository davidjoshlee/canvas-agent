import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"

import { z } from "zod"
import { assertNoSymlinks } from "../shared/fs-safety.js"

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const digest = z.string().regex(/^[a-f0-9]{64}$/)
// Read-only compatibility for snapshots already bound into saved tasks.
// There is deliberately no source discovery or import writer here.
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
