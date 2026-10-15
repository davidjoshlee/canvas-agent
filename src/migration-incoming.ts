import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir } from "node:fs/promises"
import { dirname, isAbsolute, join, relative } from "node:path"
import { assertNoSymlinks } from "./fs-safety.js"
import { rebaseMigrationReferences } from "./migration-references.js"

/** Explicitly opted-in, read-only scan. Never rewrites an unselected course. */
export async function inspectIncomingMigrationReferences(
  root: string,
  courses: Array<{ canvas_id: string; vault_path: string | null }>,
  selected: string[],
  moves: Array<{ source: string; destination: string; hash: string }>,
) {
  const records: Array<[string, string]> = [],
    findings: Array<{ courseId: string; path: string; changes: number }> = []
  let total = 0,
    entries = 0
  const hidden = (name: string) =>
    name.startsWith(".") ||
    (name.startsWith("_") && name !== "_index.md") ||
    /^(?:credentials?|secrets?|passwords?|tokens?)(?:\.|$)/i.test(name) ||
    /archive|\.proposed\.|proposed-/i.test(name)
  async function visit(path: string, courseId: string, depth: number) {
    if (depth > 64 || ++entries > 20_000)
      throw new Error("Incoming reference scan exceeds entry/depth limits")
    await assertNoSymlinks(path)
    const stat = await lstat(path)
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort())
        if (!hidden(name)) await visit(join(path, name), courseId, depth + 1)
      return
    }
    if (!stat.isFile()) throw new Error("Unsupported entry in incoming reference scope")
    if (!/\.(?:md|markdown|txt|html?)$/i.test(path)) return
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes: Buffer
    try {
      const current = await file.stat()
      if (!current.isFile() || current.size > 5_000_000 || total + current.size > 64_000_000)
        throw new Error("Incoming reference scan exceeds text limits")
      bytes = await file.readFile()
    } finally {
      await file.close()
    }
    total += bytes.length
    const source = relative(root, path).split("\\").join("/")
    const hash = createHash("sha256").update(bytes).digest("hex")
    records.push([source, hash])
    const checked = await rebaseMigrationReferences(
      bytes,
      { source, destination: source, hash },
      moves,
      root,
      { affectedOnly: true },
    )
    if (checked.changes) findings.push({ courseId, path: source, changes: checked.changes })
  }
  for (const course of courses) {
    if (selected.includes(course.canvas_id)) continue
    if (!course.vault_path || !isAbsolute(course.vault_path) || dirname(course.vault_path) !== root)
      throw new Error(
        "Unselected index root is outside the explicit vault; incoming scan cannot verify it",
      )
    await visit(course.vault_path, course.canvas_id, 0)
  }
  return {
    digest: createHash("sha256").update(JSON.stringify(records)).digest("hex"),
    documents: records.length,
    findings,
    limits:
      "Explicit Markdown/reference-definition/HTML/qualified wiki links and structured related_paths only. Short-name wiki links, historical comments/code, private/hidden/archive paths and binary documents remain unverified. No unselected files are changed.",
  }
}
