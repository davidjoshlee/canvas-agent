import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { parse as parseYaml } from "yaml"
import { assertNoSymlinks } from "./fs-safety.js"
import {
  rebaseMigrationReferences,
  validateWikiTargets,
  type WikiTargetHint,
} from "./migration-references.js"

const legacy = new Set([
  "00-syllabus.md",
  "modules",
  "assignments",
  "files",
  "prep",
  "guidance",
  "drafts",
  "final",
  "announcements",
])
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
}
const segment = (value: string) =>
  Array.from(value, (character) => (character.charCodeAt(0) < 32 ? " - " : character))
    .join("")
    .replace(/[\\/:*?"<>|]/g, " - ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "Untitled"
type Document = {
  path: string
  hash: string
  meta: Record<string, unknown>
  content: string
}
export type MigrationMove = {
  source: string
  destination: string
  hash: string
  reason: string
  destinationHash?: string
  referenceChanges?: number
}
export type LayoutPlan = {
  root: string
  phase: "document-layout"
  moves: MigrationMove[]
  conflicts: string[]
  warnings: string[]
  ready: boolean
  wikiTargets: WikiTargetHint[]
}
function parse(bytes: Buffer) {
  const text = bytes.toString("utf8"),
    match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/)
  if (!match) return { meta: {}, content: text }
  try {
    const meta: unknown = parseYaml(match[1] ?? "")
    return {
      meta:
        typeof meta === "object" && meta && !Array.isArray(meta)
          ? (meta as Record<string, unknown>)
          : {},
      content: text.slice(match[0].length),
    }
  } catch {
    return { meta: {}, content: text }
  }
}
function dates(meta: Record<string, unknown>, key: string): string | undefined {
  const nested =
    meta.dates && typeof meta.dates === "object" ? (meta.dates as Record<string, unknown>) : {}
  const value = meta[key] ?? nested[key]
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return
  if (new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10))
    return
  return value.slice(0, 10)
}
function monday(value: string) {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  return date.toISOString().slice(0, 10)
}
function label(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`))
}
function textValue(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : ""
}
async function optional(path: string): Promise<Buffer | undefined> {
  await assertNoSymlinks(path, true)
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024)
      throw new Error("Migration requires bounded regular files")
    return readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
}
/** Explicit course folders only; no class body is emitted, guessed course identity or index mutation. */
export async function planLayoutMigration(
  rootPath: string,
  courses: string[],
  options: { wikiTargets?: readonly WikiTargetHint[] } = {},
): Promise<LayoutPlan> {
  const root = resolve(rootPath),
    moves: MigrationMove[] = [],
    conflicts: string[] = [],
    warnings: string[] = []
  const wikiTargets = validateWikiTargets(options.wikiTargets)
  if (wikiTargets.some((hint) => !courses.includes(hint.target.split("/")[0] ?? "")))
    throw new Error("Wiki targets must stay in the explicitly selected course folders")
  let documentCount = 0,
    totalBytes = 0,
    entryCount = 0
  await assertNoSymlinks(root)
  if (!courses.length)
    throw new Error("Layout migration requires explicitly selected course folders")
  for (const course of [...new Set(courses)].sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{1,150}$/.test(course) || course === "old")
      throw new Error("Migration course must be one safe immediate vault folder")
    const base = join(root, course),
      documents: Document[] = []
    await assertNoSymlinks(base)
    async function visit(path: string, depth = 0) {
      if (++entryCount > 20_000 || depth > 64)
        throw new Error("Migration inventory exceeds safe entry/depth limits")
      await assertNoSymlinks(path)
      const stat = await lstat(path)
      if (stat.isDirectory()) {
        for (const child of await readdir(path)) {
          if (child.startsWith(".") || child.startsWith("_")) continue
          // On case-insensitive filesystems, old `assignments` and modern
          // `Assignments` share one directory. Never re-migrate modern bundles.
          if (
            relative(base, path) === "assignments" &&
            /^(?:\d{4}-\d{2}-\d{2}|Undated) - /i.test(child)
          )
            continue
          await visit(join(path, child), depth + 1)
        }
      } else if (stat.isFile()) {
        const bytes = await optional(path)
        if (!bytes) return
        totalBytes += bytes.length
        if (++documentCount > 5000 || totalBytes > 512 * 1024 * 1024)
          throw new Error("Migration exceeds 5000 files or 512 MB total")
        documents.push({
          path: relative(root, path).split(sep).join("/"),
          hash: sha(bytes),
          ...(extname(path).toLowerCase() === ".md" ? parse(bytes) : { meta: {}, content: "" }),
        })
      } else throw new Error("Migration contains unsupported filesystem entries")
    }
    for (const name of await readdir(base)) if (legacy.has(name)) await visit(join(base, name))
    const modules = documents.filter(
      (doc) => textValue(doc.meta.type) === "modules" && !doc.meta.module_canvas_id,
    )
    const weekDates = [
      ...new Set(
        modules.flatMap((doc) => {
          const date = dates(doc.meta, "session_at") ?? dates(doc.meta, "unlock_at")
          return date ? [monday(date)] : []
        }),
      ),
    ].sort()
    const periods = new Map<string, string>()
    for (const doc of modules) {
      const date = dates(doc.meta, "session_at") ?? dates(doc.meta, "unlock_at")
      if (date)
        periods.set(
          textValue(doc.meta.canvas_id),
          `Week ${String(weekDates.indexOf(monday(date)) + 1).padStart(2, "0")} - ${label(monday(date))}`,
        )
    }
    const assignmentRoots = new Map<string, string>()
    for (const doc of documents.filter((doc) => /^assignments?$/.test(textValue(doc.meta.type)))) {
      const title = segment(
          basename(doc.path)
            .replace(/\.md$/i, "")
            .replace(/^\d+[ -]+/, ""),
        ),
        due = dates(doc.meta, "due_at")
      assignmentRoots.set(
        textValue(doc.meta.canvas_id),
        `Assignments/${due ?? "Undated"} - ${title}`,
      )
    }
    for (const doc of documents) {
      const local = doc.path.slice(course.length + 1),
        top = local.split("/")[0] ?? "",
        meta = Object.keys(doc.meta).length
          ? doc.meta
          : (documents.find((other) => other.path === `${doc.path}.md`)?.meta ?? {})
      const kind = textValue(meta.type),
        moduleId = textValue(
          meta.module_canvas_id ?? (kind === "modules" ? meta.canvas_id : undefined),
        ),
        period = periods.get(moduleId)
      const assignment = assignmentRoots.get(textValue(meta.canvas_id).replace(/-feedback$/, ""))
      let target: string
      if (top === "00-syllabus.md") target = "Resources/Syllabus.md"
      else if (assignment && /^assignments?$/.test(kind)) target = `${assignment}/00 Prompt.md`
      else if (assignment && /feedback/.test(kind)) target = `${assignment}/Feedback.md`
      else if (
        assignment &&
        (top === "drafts" || kind === "drafts" || top === "final" || kind === "final")
      )
        target = `${assignment}/${top === "final" || kind === "final" ? "Finals" : "Drafts"}/${basename(doc.path)}`
      else if (top === "guidance" || kind === "guidance")
        target = `Resources/Guidance/${basename(doc.path)}`
      else if (top === "prep" || kind === "prep")
        target = `${period ?? "Other"}/Prep/${basename(doc.path)}`
      else if (top === "announcements" || kind === "announcements")
        target = `Other/Announcements/${basename(doc.path)}`
      else if (top === "files" || kind === "files")
        target = `${period ? `${period}/Materials` : "Resources/Files"}/${basename(doc.path)}`
      else if (top === "modules" && period) target = `${period}/Other/${basename(doc.path)}`
      else {
        target = `Other/${basename(doc.path)}`
        warnings.push(`Unclassified legacy document kept at class-level Other: ${doc.path}`)
      }
      moves.push({
        source: doc.path,
        destination: `${course}/${target}`,
        hash: doc.hash,
        reason: period ? "explicit module/date relationship" : "legacy category",
      })
    }
  }
  const names = new Set<string>()
  for (const move of moves) {
    const key = move.destination.normalize("NFC").toLowerCase()
    if (names.has(key)) conflicts.push(`Multiple legacy files target ${move.destination}`)
    names.add(key)
    if (await optional(join(root, move.destination)))
      conflicts.push(`Destination already exists: ${move.destination}`)
  }
  // Current path references are rebased explicitly; historical literals stay unchanged.
  for (const move of moves) {
    const bytes = await optional(join(root, move.source))
    if (!bytes) throw new Error("Migration source disappeared during preview")
    try {
      const result = await rebaseMigrationReferences(bytes, move, moves, root, { wikiTargets })
      if (sha(result.bytes) !== move.hash) {
        move.destinationHash = sha(result.bytes)
        move.referenceChanges = result.changes
      }
    } catch (error) {
      conflicts.push(`Reference rebasing blocked for ${move.source}: ${(error as Error).message}`)
    }
  }
  return {
    root,
    phase: "document-layout",
    moves,
    conflicts,
    warnings,
    ready: !conflicts.length,
    wikiTargets,
  }
}
/** Recoverable, exclusive copies; originals are archived privately, never overwritten/deleted. */
export async function applyLayoutMigration(plan: LayoutPlan, courses: string[]) {
  const fresh = await planLayoutMigration(plan.root, courses, { wikiTargets: plan.wikiTargets })
  if (JSON.stringify(fresh) !== JSON.stringify(plan))
    throw new Error("Migration plan is stale; preview it again")
  if (!fresh.ready) throw new Error("Migration has conflicts; no files were moved")
  const archive = join(plan.root, "_meta/vault-migrations", randomUUID()),
    lock = join(plan.root, "_meta/vault-migration.lock")
  await assertNoSymlinks(lock, true)
  await mkdir(dirname(lock), { recursive: true })
  await assertNoSymlinks(dirname(lock))
  try {
    await mkdir(lock)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Vault migration is locked; inspect the prior operation first")
    throw error
  }
  const done: MigrationMove[] = []
  const copies: MigrationMove[] = []
  try {
    await assertNoSymlinks(archive, true)
    await mkdir(archive, { recursive: true, mode: 0o700 })
    await assertNoSymlinks(archive)
    await writeFile(join(archive, "plan.json"), JSON.stringify(plan), { flag: "wx", mode: 0o600 })
    // Stage rewrites while every original target still exists. Never overwrite a
    // source to rebase it, or rewrite captured provenance to claim new history.
    for (const move of plan.moves.filter((entry) => entry.destinationHash)) {
      const original = await optional(join(plan.root, move.source))
      if (!original || sha(original) !== move.hash)
        throw new Error("Migration source changed before staging")
      const result = await rebaseMigrationReferences(original, move, plan.moves, plan.root, {
        wikiTargets: plan.wikiTargets,
      })
      if (sha(result.bytes) !== move.destinationHash)
        throw new Error("Migration reference rewrite changed")
      const staged = join(archive, "rewritten", move.source)
      await assertNoSymlinks(staged, true)
      await mkdir(dirname(staged), { recursive: true, mode: 0o700 })
      await assertNoSymlinks(dirname(staged))
      await writeFile(staged, result.bytes, { flag: "wx", mode: 0o600 })
    }
    for (const move of plan.moves) {
      const source = join(plan.root, move.source),
        destination = join(plan.root, move.destination),
        backup = join(archive, "originals", move.source)
      if (!inside(plan.root, source) || !inside(plan.root, destination))
        throw new Error("Migration path escapes the vault")
      const bytes = await optional(source)
      if (!bytes || sha(bytes) !== move.hash)
        throw new Error("Migration source changed; inspect the journal before retrying")
      await assertNoSymlinks(destination, true)
      await mkdir(dirname(destination), { recursive: true })
      await assertNoSymlinks(dirname(destination))
      await copyFile(
        move.destinationHash ? join(archive, "rewritten", move.source) : source,
        destination,
        constants.COPYFILE_EXCL,
      )
      copies.push(move)
      const copied = await optional(destination)
      if (!copied || sha(copied) !== (move.destinationHash ?? move.hash))
        throw new Error("Migration copy did not preserve original bytes")
      await assertNoSymlinks(backup, true)
      await mkdir(dirname(backup), { recursive: true, mode: 0o700 })
      await assertNoSymlinks(dirname(backup))
      await assertNoSymlinks(source)
      const current = await optional(source)
      if (!current || sha(current) !== move.hash)
        throw new Error("Migration source changed before archival")
      await rename(source, backup)
      done.push(move)
      await writeFile(join(archive, "progress.json"), JSON.stringify({ moved: done }), {
        mode: 0o600,
      })
    }
    await writeFile(
      join(archive, "complete.json"),
      JSON.stringify({ moved: done.length, phase: plan.phase }),
      { flag: "wx", mode: 0o600 },
    )
    return {
      moved: done.length,
      archive,
      limitation:
        "Document layout with current reference rebasing only. Existing School Agent index/global layout markers and historical provenance were not changed. Root/index rebasing remains separate; create fresh tasks after moved source paths.",
    }
  } catch {
    const recovery: string[] = []
    for (const move of [...done].reverse()) {
      try {
        const source = join(plan.root, move.source),
          backup = join(archive, "originals", move.source)
        const saved = await optional(backup)
        if (!saved || sha(saved) !== move.hash) throw new Error("Backup bytes changed")
        if (await optional(source)) throw new Error("Source was recreated; preserving it")
        await assertNoSymlinks(dirname(source))
        await copyFile(backup, source, constants.COPYFILE_EXCL)
        const restored = await optional(source)
        if (!restored || sha(restored) !== move.hash) throw new Error("Restored bytes differ")
      } catch {
        recovery.push(`Original needs manual recovery: ${move.source}`)
      }
    }
    for (const move of [...copies].reverse()) {
      try {
        const source = await optional(join(plan.root, move.source))
        const destination = join(plan.root, move.destination),
          copied = await optional(destination)
        if (
          !source ||
          sha(source) !== move.hash ||
          !copied ||
          sha(copied) !== (move.destinationHash ?? move.hash)
        )
          throw new Error("Files changed; preserving both")
        await unlink(destination)
      } catch {
        recovery.push(`Destination preserved for review: ${move.destination}`)
      }
    }
    await writeFile(join(archive, "interrupted.json"), JSON.stringify({ moved: done, recovery }), {
      flag: "wx",
      mode: 0o600,
    }).catch(() => {})
    throw new Error(
      `Migration interrupted; originals restored where safe and backups preserved in ${archive}. ${recovery.join("; ")} Inspect that journal before retrying; no global layout marker was advanced`,
    )
  } finally {
    await rmdir(lock)
  }
}
