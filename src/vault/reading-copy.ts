import { createHash, randomUUID } from "node:crypto"
import type { Stats } from "node:fs"
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { assertNoSymlinks } from "../shared/fs-safety.js"
import { inspectWorkspace } from "./workspace.js"

const formats = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".csv",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".mp3",
  ".m4a",
  ".mp4",
  ".mov",
])
const STATE = "_meta/reading-copy.json",
  LOCK = "_meta/reading-copy.lock"
const MAX_FILE = 50 * 1024 * 1024,
  MAX_TOTAL = 512 * 1024 * 1024,
  MAX_FILES = 5000
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const State = z
  .object({
    version: z.literal(1),
    enabled: z.boolean().default(true),
    destination: z.string().min(1),
    files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  })
  .strict()
type MirrorState = z.infer<typeof State>
export type ReadingPlan = {
  root: string
  destination: string
  files: { source: string; output: string; bytes: number; hash: string }[]
  skipped: number
  totalBytes: number
}
const within = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
}
async function canonical(path: string): Promise<string> {
  const full = resolve(path)
  await assertNoSymlinks(full, true)
  try {
    return await realpath(full)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    const parent = dirname(full)
    if (parent === full) throw error
    return join(await canonical(parent), basename(full))
  }
}
function privateName(name: string): boolean {
  return (
    name.startsWith(".") ||
    name.startsWith("_") ||
    /^(?:old|archive|archives|simulations|agents\.md|school\.md|credentials?|secrets?|passwords?|tokens?)(?:\.|$)/i.test(
      name,
    ) ||
    /\.auth\.json$|\.proposed\./i.test(name)
  )
}
function safeName(name: string) {
  if (
    !name ||
    isAbsolute(name) ||
    name.includes("\\") ||
    name.split("/").some((part) => !part || part === ".." || part === "." || privateName(part))
  )
    throw new Error("Unsafe reading-copy output path")
}
function validateFiles(files: Record<string, string>) {
  const keys = Object.keys(files)
  if (
    keys.length > MAX_FILES + 1 ||
    new Set(keys.map((key) => key.normalize("NFC").toLowerCase())).size !== keys.length
  )
    throw new Error("Reading-copy state contains too many or colliding output paths")
  for (const name of keys) safeName(name)
}
async function optional(path: string, limit = MAX_FILE): Promise<Buffer | undefined> {
  await assertNoSymlinks(path, true)
  let stat: Stats
  try {
    stat = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (!stat.isFile() || stat.size > limit)
    throw new Error("Reading-copy path is not a bounded regular file")
  return readFile(path)
}
function textDocument(bytes: Buffer): { allowed: boolean; content: string } {
  const text = bytes.toString("utf8")
  if (bytes.includes(0) || !Buffer.from(text).equals(bytes)) return { allowed: false, content: "" }
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/)
  if (!match) return { allowed: !/^---(?:\s*\r?\n|$)/.test(text), content: text }
  try {
    const meta: unknown = parseYaml(match[1] ?? "")
    if (meta !== null && (typeof meta !== "object" || Array.isArray(meta)))
      return { allowed: false, content: "" }
    const record = (meta ?? {}) as Record<string, unknown>
    const allowed = [record.ai_policy, record.policy, record.redistribution].every(
      (value) =>
        value === undefined ||
        value === null ||
        value === "" ||
        /^(?:allowed|allow|permitted)$/i.test(String(value).trim()),
    )
    return { allowed, content: text.slice(match[0].length) }
  } catch {
    return { allowed: false, content: "" }
  }
}
function readingBytes(source: string, bytes: Buffer): Buffer {
  if (![".md", ".markdown", ".txt"].includes(extname(source).toLowerCase())) return bytes
  const parsed = textDocument(bytes)
  if (!parsed.allowed) throw new Error("Reading-copy source policy changed; plan a fresh export")
  return Buffer.from(
    parsed.content.replace(
      /([?&](?:verifier|access_token|token|sig|signature|X-Amz-Signature|X-Goog-Signature)=)[^\s&<>"')]+/gi,
      "$1[redacted]",
    ),
  )
}
/** Preview only; course-scoped inventory, policy checks and collision checks precede all writes. */
export async function planReadingCopy(
  rootPath: string,
  destinationPath: string,
): Promise<ReadingPlan> {
  const root = await canonical(rootPath),
    destination = await canonical(destinationPath)
  if (within(root, destination) || within(destination, root))
    throw new Error(
      "Reading-copy destination must be separate from the working vault, not its parent or child",
    )
  const workspace = await inspectWorkspace(root)
  const extractionPaths = new Set(
    workspace.courses.flatMap((course) => course.sources.map((source) => source.path)),
  )
  const files: ReadingPlan["files"] = [],
    names = new Set(["00 read me.txt"])
  let skipped = 0,
    totalBytes = 0
  async function visit(directory: string) {
    await assertNoSymlinks(directory)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink() || privateName(entry.name)) {
        skipped++
        continue
      }
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      if (!entry.isFile() || !formats.has(extname(entry.name).toLowerCase())) {
        skipped++
        continue
      }
      if (
        entry.name.endsWith(".extracted.md") &&
        !extractionPaths.has(relative(root, path).split(sep).join("/"))
      ) {
        skipped++
        continue
      }
      const bytes = await optional(path)
      if (!bytes) continue
      if ([".md", ".markdown", ".txt"].includes(extname(path).toLowerCase())) {
        if (!textDocument(bytes).allowed) {
          skipped++
          continue
        }
      } else {
        // A restricted legacy/extraction sidecar must not be bypassed by copying its original.
        let blocked = false
        for (const sidecar of [`${path}.md`, `${path}.extracted.md`]) {
          const text = await optional(sidecar)
          if (text && !textDocument(text).allowed) blocked = true
        }
        if (blocked) {
          skipped++
          continue
        }
      }
      const local = relative(root, path).split(sep).join("/")
      const output = /\.(?:md|markdown)$/i.test(local) ? `${local}.txt` : local
      safeName(output)
      const key = output.normalize("NFC").toLocaleLowerCase()
      if (names.has(key))
        throw new Error(
          "Reading-copy filenames collide; rename the conflicting local files before exporting",
        )
      names.add(key)
      totalBytes += bytes.length
      if (files.length >= MAX_FILES || totalBytes > MAX_TOTAL)
        throw new Error("Reading copy exceeds its 5000-file or 512 MB limit; narrow the vault")
      files.push({ source: local, output, bytes: bytes.length, hash: digest(bytes) })
    }
  }
  for (const course of workspace.courses) await visit(join(root, course.root))
  return {
    root,
    destination,
    files: files.sort((a, b) => a.source.localeCompare(b.source)),
    skipped,
    totalBytes,
  }
}
const readMe = Buffer.from(
  "Canvas Agent read-only reading copy\n\nMarkdown is .md.txt for phone preview; PDFs and Office originals retain their formats. No edits flow back to the working vault. Credentials, private metadata, task records, hidden files, archives and policy-restricted files are excluded from new exports. Frontmatter and known signed-link parameters are removed from text copies; this is not a complete secret/content audit. Drive must be running and online to upload this local folder. Existing snapshots and Recovered versions are retained; review them manually if material becomes restricted or must be removed.\n",
)
async function contents(plan: ReadingPlan): Promise<Map<string, Buffer>> {
  // Re-plan to check changed sidecar policy, inventory and source hashes before exporting.
  const fresh = await planReadingCopy(plan.root, plan.destination)
  if (JSON.stringify(fresh.files) !== JSON.stringify(plan.files))
    throw new Error("Reading-copy sources changed during export; retry")
  const result = new Map<string, Buffer>()
  for (const file of plan.files) {
    const bytes = await optional(join(plan.root, file.source))
    if (!bytes || digest(bytes) !== file.hash)
      throw new Error("Reading-copy source changed during export; retry")
    result.set(file.output, readingBytes(file.source, bytes))
  }
  result.set("00 READ ME.txt", readMe)
  return result
}
async function exclusive(path: string, data: Buffer) {
  await assertNoSymlinks(path, true)
  await mkdir(dirname(path), { recursive: true })
  await assertNoSymlinks(path, true)
  await writeFile(path, data, { flag: "wx", mode: 0o600 })
}
/** Append-only snapshots; the completion marker is written last. */
export async function createReadingCopy(root: string, destination: string) {
  const plan = await planReadingCopy(root, destination),
    data = await contents(plan)
  const path = join(
    plan.destination,
    `Reading ${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
  )
  for (const [name, bytes] of data) await exclusive(join(path, name), bytes)
  return { path, copied: plan.files.length, skipped: plan.skipped }
}
async function readState(root: string): Promise<MirrorState | undefined> {
  const bytes = await optional(join(root, STATE), 2 * 1024 * 1024)
  if (!bytes) return
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error("Reading-copy state is invalid")
  }
  const result = State.safeParse(parsed)
  if (!result.success) throw new Error("Reading-copy state is invalid")
  validateFiles(result.data.files)
  if (!isAbsolute(result.data.destination))
    throw new Error("Reading-copy destination state must be absolute")
  return result.data
}
async function saveState(root: string, state: MirrorState) {
  const path = join(root, STATE),
    temp = `${path}.${randomUUID()}.tmp`
  await exclusive(temp, Buffer.from(`${JSON.stringify(state, null, 2)}\n`))
  try {
    await assertNoSymlinks(path, true)
    await rename(temp, path)
  } finally {
    await unlink(temp).catch(() => undefined)
  }
}
/** Explicit applied Current export opts this vault into refreshes after successful CLI writes. */
export async function refreshReadingMirror(
  root: string,
  destination: string,
  options: { importSchoolState?: boolean } = {},
) {
  const plan = await planReadingCopy(root, destination),
    lock = join(plan.root, LOCK)
  await assertNoSymlinks(lock, true)
  await mkdir(dirname(lock), { recursive: true })
  try {
    await mkdir(lock)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "Reading-copy refresh is locked; check for a running refresh or interrupted operation",
      )
    throw error
  }
  let legacyLock: string | undefined
  try {
    let state = await readState(plan.root)
    const legacyPath = join(plan.root, "_meta/reading-mirror.json")
    const legacyBytes = await optional(legacyPath, 2 * 1024 * 1024)
    if (legacyBytes) {
      const schema = z
        .object({
          destination: z.string(),
          updatedAt: z.string(),
          files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
          mtimes: z.record(z.string(), z.number()).optional(),
        })
        .strict()
      let raw: unknown
      try {
        raw = JSON.parse(legacyBytes.toString("utf8"))
      } catch {
        throw new Error("Legacy reading-mirror state is invalid")
      }
      const legacy = schema.safeParse(raw)
      if (!legacy.success || !isAbsolute(legacy.data.destination))
        throw new Error("Legacy reading-mirror state is invalid")
      if ((await canonical(legacy.data.destination)) === plan.destination) {
        if (!options.importSchoolState)
          throw new Error(
            "School Agent owns this mirror; use --import-school-state only when intentionally transferring ownership",
          )
        if (state)
          throw new Error(
            "Canvas Agent already has mirror ownership; review the two mappings before importing",
          )
        const files = legacy.data.files
        validateFiles(files)
        for (const name of [...plan.files.map((file) => file.output), "00 READ ME.txt"]) {
          if ((await optional(join(plan.destination, "Current", name))) && !files[name])
            throw new Error(
              "An unowned file would be overwritten in Current; legacy mapping was not imported",
            )
        }
        const oldLock = join(plan.root, "_meta/reading-mirror.lock")
        await assertNoSymlinks(oldLock, true)
        try {
          await mkdir(oldLock)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw new Error("School Agent reading mirror is locked; wait for it to finish")
          throw error
        }
        legacyLock = oldLock
        const fresh = await optional(legacyPath, 2 * 1024 * 1024)
        if (!fresh || digest(fresh) !== digest(legacyBytes))
          throw new Error("Legacy reading-mirror state changed during import")
        // Disable the old hook by archiving its mapping, never deleting it.
        // New ownership starts disabled until a manual refresh is applied.
        const imported: MirrorState = {
          version: 1,
          enabled: false,
          destination: plan.destination,
          files,
        }
        await saveState(plan.root, imported)
        const backup = join(plan.root, `_meta/reading-mirror.imported-${randomUUID()}.json`)
        await assertNoSymlinks(backup, true)
        await rename(legacyPath, backup)
        state = imported
      } else if (options.importSchoolState)
        throw new Error(
          "Legacy mirror destination differs; refusing to import into another account/folder",
        )
    } else if (options.importSchoolState)
      throw new Error("No School Agent reading-mirror mapping is available to import")
    if (state && state.destination !== plan.destination)
      throw new Error(
        "Reading-copy destination differs from the saved mapping; refusing to reroute automatically",
      )
    const data = await contents(plan),
      current = join(plan.destination, "Current")
    const existing = new Map<string, Buffer | undefined>()
    let existingBytes = 0
    const names = new Set([...data.keys(), ...Object.keys(state?.files ?? {})])
    // Check every prospective target before changing any destination contents.
    for (const name of names) {
      safeName(name)
      const bytes = await optional(join(current, name))
      existingBytes += bytes?.length ?? 0
      if (existingBytes > MAX_TOTAL)
        throw new Error("Existing reading copy exceeds its bounded refresh limit")
      if (bytes && !state?.files[name])
        throw new Error(
          "An unowned file would be overwritten in Current; choose an empty destination",
        )
      existing.set(name, bytes)
    }
    const next: MirrorState = {
      version: 1,
      enabled: true,
      destination: plan.destination,
      files: { ...(state?.files ?? {}) },
    }
    let updated = 0,
      unchanged = 0,
      recovered = 0
    const recovery = join(
      plan.destination,
      "Recovered",
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    )
    for (const name of names) {
      const before = existing.get(name),
        desired = data.get(name),
        target = join(current, name)
      if (before && desired && digest(before) === digest(desired)) {
        next.files[name] = digest(desired)
        unchanged++
        continue
      }
      // Persist ownership intent before a write. An interrupted update can be safely resumed.
      if (desired) {
        next.files[name] = digest(desired)
        await saveState(plan.root, next)
      }
      const actual = await optional(target)
      if (
        Boolean(actual) !== Boolean(before) ||
        (actual && before && digest(actual) !== digest(before))
      )
        throw new Error("Reading-copy destination changed during refresh; retry")
      if (actual) {
        const backup = join(recovery, name)
        await assertNoSymlinks(backup, true)
        await mkdir(dirname(backup), { recursive: true })
        await assertNoSymlinks(target)
        await rename(target, backup)
        recovered++
      }
      if (desired) {
        await exclusive(target, desired)
        updated++
      } else delete next.files[name]
      await saveState(plan.root, next)
    }
    await saveState(plan.root, next)
    return { path: current, updated, unchanged, recovered, skipped: plan.skipped }
  } finally {
    try {
      if (legacyLock) await rmdir(legacyLock)
    } finally {
      await rmdir(lock)
    }
  }
}
export async function refreshConfiguredReadingMirror(root: string) {
  await assertNoSymlinks(root)
  const state = await readState(root)
  return state?.enabled ? refreshReadingMirror(root, state.destination) : undefined
}
export async function disableReadingMirror(root: string) {
  await assertNoSymlinks(root)
  const lock = join(root, LOCK)
  await assertNoSymlinks(lock, true)
  await mkdir(dirname(lock), { recursive: true })
  try {
    await mkdir(lock)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Reading-copy refresh is locked")
    throw error
  }
  try {
    const state = await readState(root)
    if (state) await saveState(root, { ...state, enabled: false })
    return { disabled: true, copiesPreserved: true }
  } finally {
    await rmdir(lock)
  }
}
