import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { parse as parseYaml } from "yaml"
import { assertNoSymlinks } from "./fs-safety.js"
import { planLayoutMigration } from "./migration.js"
import { inspectIncomingMigrationReferences } from "./migration-incoming.js"
import {
  rebaseMigrationReferences,
  validateWikiTargets,
  type WikiTargetHint,
} from "./migration-references.js"
import { inspectSchoolLayout, type SchoolLayoutState } from "./school-layout.js"

const tables = ["courses", "modules", "assignments", "announcements", "files"] as const
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
type Course = {
  canvas_id: string
  name: string | null
  course_code: string | null
  vault_path: string | null
}
type Move = {
  canvasId: string
  source: string
  destination: string
  indexHash: string
  treeDigest: string
}
type FileMove = {
  source: string
  current: string
  destination: string
  hash: string
  destinationHash?: string
}
export type RootMigrationPlan = {
  root: string
  index: string
  ids: string[]
  indexDigest: string
  moves: Move[]
  scopes: Move[]
  layout: boolean
  files: FileMove[]
  mappingHash: string | null
  conflicts: string[]
  ready: boolean
  incomingCheck: boolean
  incomingDigest: string | null
  incomingDocuments: number
  incomingLimits: string
  schoolLayout: SchoolLayoutState
  wikiTargets: WikiTargetHint[]
}

async function sqlite() {
  const [major, minor] = process.versions.node.split(".").map(Number)
  if (
    (major ?? 0) < 22 ||
    (major === 22 && (minor ?? 0) < 16) ||
    (major === 23 && (minor ?? 0) < 8)
  )
    throw new Error("School index migration requires Node 22.16+ (or 23.8+)")
  return import("node:sqlite")
}
async function exists(path: string) {
  await assertNoSymlinks(path, true)
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
}
async function treeDigest(root: string) {
  const entries: unknown[] = []
  async function visit(path: string, depth: number) {
    if (depth > 64 || entries.length >= 20000)
      throw new Error("Course root exceeds safe entry/depth limits")
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      throw new Error("Course root contains a symbolic link or unsupported entry")
    entries.push([
      relative(root, path),
      stat.isDirectory() ? "directory" : "file",
      stat.size,
      stat.mtimeMs,
    ])
    if (stat.isDirectory())
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), depth + 1)
  }
  await visit(root, 0)
  return digest(JSON.stringify(entries))
}
async function safeIndex(path: string, root: string) {
  if (!isAbsolute(path)) throw new Error("School index path must be explicit and absolute")
  const rel = relative(root, path)
  if (!rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)))
    throw new Error("The active School index must stay outside the vault")
  const stat = await exists(path)
  if (!stat?.isFile() || stat.size > 512 * 1024 * 1024)
    throw new Error("School index must be an existing bounded regular file")
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const file = await exists(path + suffix)
    if (file && (!file.isFile() || file.size > 512 * 1024 * 1024))
      throw new Error("School index journal must be a bounded regular file")
  }
}
function snapshot(db: DatabaseSync) {
  const version = db.prepare("SELECT MAX(version) AS version FROM migrations").get()?.version
  if (typeof version !== "number" || version < 1 || version > 5)
    throw new Error("Unsupported School index schema version")
  if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' LIMIT 1").get())
    throw new Error("School index has unsupported triggers; review before migration")
  const courses = db
    .prepare(
      "SELECT canvas_id, name, course_code, vault_path FROM courses ORDER BY canvas_id LIMIT 1001",
    )
    .all() as unknown as Course[]
  if (courses.length > 1000) throw new Error("School index exceeds 1000 courses")
  const paths = tables.map((table) => {
    const rows = db
      .prepare(
        `SELECT canvas_id, ${table === "courses" ? "canvas_id AS course_canvas_id" : "course_canvas_id"}, vault_path FROM ${table} ORDER BY canvas_id LIMIT 100001`,
      )
      .all()
    if (rows.length > 100000) throw new Error("School index path inventory exceeds 100000 rows")
    return { table, rows }
  })
  const serialized = JSON.stringify({ courses, paths })
  if (Buffer.byteLength(serialized) > 64 * 1024 * 1024)
    throw new Error("School index path inventory exceeds 64 MB")
  return { courses, paths, hash: digest(serialized) }
}
function folder(row: Course) {
  const savedCode = row.course_code?.trim()
  const code =
    savedCode && !/^course-\d+$/i.test(savedCode)
      ? savedCode
      : row.name?.trim() || `course-${row.canvas_id}`
  const match = code.match(
    /^(?:(?:F|W|Sp|Su)\d{2}|\d{2}(?:F|W|Sp|Su))[-\s]+([A-Za-z]{2,12})[-\s]+([0-9]{2,4}[A-Za-z]?)(?=$|[-\s/])/i,
  )
  if (match) return `${match[1]}${match[2]}`.toUpperCase()
  if (/^[A-Z]{2,12}[0-9]{2,4}[A-Z]?$/.test(code)) return code
  const termless = code.match(/^(?:\d{2}(?:Su|Sp|F|W)|(?:F|W|Sp|Su)\d{2})[-\s]+([A-Za-z]{2,12})$/i)
  if (termless?.[1]) return termless[1].toUpperCase()
  const name = code
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 100)
  if (!name) throw new Error("Course has no safe destination name")
  return name
}
/** Read only the explicitly supplied School index and selected course manifests. */
export async function planRootMigration(
  rootPath: string,
  indexPath: string,
  ids: string[],
  options: {
    layout?: boolean
    checkIncoming?: boolean
    wikiTargets?: readonly WikiTargetHint[]
  } = {},
): Promise<RootMigrationPlan> {
  const root = resolve(rootPath),
    index = resolve(indexPath)
  await assertNoSymlinks(root)
  if (!ids.length || ids.some((id) => !/^\d+$/.test(id)))
    throw new Error("Root migration needs explicit numeric Canvas course IDs")
  await safeIndex(indexPath, root)
  const { DatabaseSync } = await sqlite(),
    db = new DatabaseSync(index, { readOnly: true })
  const state = (() => {
    try {
      return snapshot(db)
    } finally {
      db.close()
    }
  })()
  const plan: RootMigrationPlan = {
    root,
    index,
    ids: [...new Set(ids)].sort(),
    indexDigest: state.hash,
    moves: [],
    scopes: [],
    layout: options.layout ?? false,
    files: [],
    mappingHash: null,
    conflicts: [],
    ready: false,
    incomingCheck: options.checkIncoming ?? false,
    incomingDigest: null,
    incomingDocuments: 0,
    incomingLimits:
      "Unselected-course references were not inspected; selected-scope readiness is not whole-vault link verification.",
    schoolLayout: await inspectSchoolLayout(root),
    wikiTargets: validateWikiTargets(options.wikiTargets),
  }
  if (!plan.schoolLayout.supported)
    plan.conflicts.push(
      "School layout marker is invalid or unsupported; inspect it before migration",
    )
  for (const id of plan.ids) {
    const row = state.courses.find((course) => course.canvas_id === id)
    if (!row?.vault_path || !isAbsolute(row.vault_path) || dirname(row.vault_path) !== root) {
      plan.conflicts.push(`Course ${id} has no indexed immediate root in this vault`)
      continue
    }
    const source = row.vault_path,
      destination = join(root, folder(row))
    if (!(await exists(source))?.isDirectory()) {
      plan.conflicts.push(`Course ${id} root is missing or not a directory`)
      continue
    }
    const manifest = join(source, "_index.md")
    const stat = await exists(manifest)
    if (!stat?.isFile() || stat.size > 1024 * 1024) {
      plan.conflicts.push(`Course ${id} has no bounded identity manifest`)
      continue
    }
    const text = await readFile(manifest, "utf8"),
      front = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)
    let metadata: Record<string, unknown> = {}
    try {
      metadata = parseYaml(front?.[1] ?? "") ?? {}
    } catch {
      /* fail identity below */
    }
    if (String(metadata.canvas_id ?? "") !== id) {
      plan.conflicts.push(`Course ${id} manifest identity does not match its index row`)
      continue
    }
    for (const { rows } of state.paths)
      for (const item of rows) {
        const path = item.vault_path
        if (
          typeof path === "string" &&
          (path === source || path.startsWith(`${source}/`)) &&
          String(item.course_canvas_id) !== id
        )
          plan.conflicts.push(`Course ${id} root contains an index path owned by another course`)
      }
    const tree = await treeDigest(source)
    plan.scopes.push({
      canvasId: id,
      source,
      destination,
      indexHash: digest(text),
      treeDigest: tree,
    })
    if (source !== destination)
      plan.moves.push({
        canvasId: id,
        source,
        destination,
        indexHash: digest(text),
        treeDigest: tree,
      })
  }
  const destinations = new Set<string>()
  for (const move of plan.moves) {
    const key = move.destination.normalize("NFC").toLowerCase()
    if (destinations.has(key))
      plan.conflicts.push(`Multiple courses target ${basename(move.destination)}`)
    destinations.add(key)
    if (await exists(move.destination))
      plan.conflicts.push(`Destination already exists: ${basename(move.destination)}`)
  }
  let bytesRead = 0
  async function files(path: string, move: Move) {
    const stat = await lstat(path)
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await files(join(path, name), move)
      return
    }
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024 || plan.files.length >= 5000)
      throw new Error("Root migration requires at most 5000 bounded regular files")
    bytesRead += stat.size
    if (bytesRead > 512 * 1024 * 1024)
      throw new Error("Root migration source inventory exceeds 512 MB")
    const local = relative(move.source, path)
    plan.files.push({
      source: relative(root, path).split(sep).join("/"),
      destination: relative(root, join(move.destination, local)).split(sep).join("/"),
      current: relative(root, join(move.destination, local)).split(sep).join("/"),
      hash: digest(await readFile(path)),
    })
  }
  for (const move of plan.layout ? plan.scopes : plan.moves) await files(move.source, move)
  if (plan.wikiTargets.some((hint) => !plan.files.some((file) => file.source === hint.target)))
    throw new Error(
      "Wiki targets must identify existing files in the explicitly selected course inventory",
    )
  if (plan.layout && plan.scopes.length) {
    const layout = await planLayoutMigration(
      root,
      plan.scopes.map((move) => basename(move.source)),
      { wikiTargets: plan.wikiTargets },
    )
    // The combined final reference map is validated below, not the intermediate
    // layout map: references may move between two selected roots in this operation.
    plan.conflicts.push(
      ...layout.conflicts.filter((conflict) => !conflict.startsWith("Reference rebasing blocked")),
    )
    for (const file of plan.files) {
      const document = layout.moves.find((move) => move.source === file.source)
      if (!document) continue
      const scope = plan.scopes.find((move) => file.source.startsWith(`${basename(move.source)}/`))
      if (!scope) throw new Error("Document scope is missing")
      file.destination = `${basename(scope.destination)}/${document.destination.slice(basename(scope.source).length + 1)}`
    }
  }
  for (const file of plan.files) {
    if (
      file.source
        .split("/")
        .some((part) => part.startsWith(".") || (part.startsWith("_") && part !== "_index.md"))
    )
      continue
    try {
      const result = await rebaseMigrationReferences(
        await readFile(join(root, file.source)),
        file,
        plan.files,
        root,
        { wikiTargets: plan.wikiTargets },
      )
      if (digest(result.bytes) !== file.hash) file.destinationHash = digest(result.bytes)
    } catch (error) {
      plan.conflicts.push(
        `Reference rewrite blocked for ${file.source}: ${(error as Error).message}`,
      )
    }
  }
  const mapping = await readMapping(root)
  plan.mappingHash = mapping?.hash ?? null
  if (mapping)
    for (const move of plan.layout ? plan.scopes : plan.moves) {
      const entries = mapping.value.courses.filter(
        (item) => item.id === move.canvasId || item.root === basename(move.source),
      )
      if (entries.some((item) => item.id !== move.canvasId || item.root !== basename(move.source)))
        plan.conflicts.push(`Canvas mapping identity conflicts with root ${move.canvasId}`)
      if (
        mapping.value.courses.some(
          (item) =>
            item.id !== move.canvasId &&
            item.root.toLowerCase() === basename(move.destination).toLowerCase(),
        )
      )
        plan.conflicts.push(
          `Canvas mapping destination belongs to another course: ${move.canvasId}`,
        )
    }
  if (plan.incomingCheck) {
    try {
      const incoming = await inspectIncomingMigrationReferences(
        root,
        state.courses,
        plan.ids,
        plan.files,
      )
      plan.incomingDigest = incoming.digest
      plan.incomingDocuments = incoming.documents
      plan.incomingLimits = incoming.limits
      for (const item of incoming.findings)
        plan.conflicts.push(
          `Incoming references in unselected course ${item.courseId}: ${item.path} (${item.changes} changes needed); include that course explicitly or repair its links before applying`,
        )
    } catch {
      plan.conflicts.push(
        "Incoming reference scan could not verify all opted-in text scope; inspect unsupported entries/links before applying",
      )
    }
  }
  plan.ready = !plan.conflicts.length
  return plan
}
type Mapping = {
  version: 1
  courses: Array<{ id: string; root: string; name: string; code?: string }>
  [key: string]: unknown
}
async function readMapping(root: string) {
  const path = join(root, "_meta/canvas-courses.json"),
    stat = await exists(path)
  if (!stat) return
  if (!stat.isFile() || stat.size > 1024 * 1024)
    throw new Error("Canvas mapping must be a bounded regular file")
  const bytes = await readFile(path),
    value = JSON.parse(bytes.toString()) as Mapping
  if (
    value.version !== 1 ||
    !Array.isArray(value.courses) ||
    value.courses.length > 1000 ||
    value.courses.some(
      (item) =>
        !item ||
        typeof item.id !== "string" ||
        typeof item.name !== "string" ||
        typeof item.root !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(item.root),
    )
  )
    throw new Error("Invalid Canvas mapping")
  if (
    new Set(value.courses.map((item) => item.id)).size !== value.courses.length ||
    new Set(value.courses.map((item) => item.root.toLowerCase())).size !== value.courses.length
  )
    throw new Error("Canvas mapping contains ambiguous identities")
  return { bytes, value, hash: digest(bytes) }
}

/** Apply a freshly verified scoped root or combined layout/root/index plan. */
export async function applyRootMigration(plan: RootMigrationPlan) {
  const fresh = await planRootMigration(plan.root, plan.index, plan.ids, {
    layout: plan.layout,
    checkIncoming: plan.incomingCheck,
    wikiTargets: plan.wikiTargets,
  })
  if (JSON.stringify(fresh) !== JSON.stringify(plan))
    throw new Error("Root migration plan is stale")
  if (!plan.ready) throw new Error("Root migration has conflicts")
  const { DatabaseSync, backup } = await sqlite()
  const lock = join(plan.root, "_meta/vault-migration.lock"),
    archive = join(plan.root, "_meta/vault-migrations", randomUUID())
  await assertNoSymlinks(lock, true)
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 })
  await assertNoSymlinks(dirname(lock))
  try {
    await mkdir(lock)
  } catch {
    throw new Error("Vault migration is locked; inspect the prior operation")
  }
  const moved: Move[] = [],
    rewritten: FileMove[] = []
  const caseRenames: Array<{
    source: string
    destination: string
    temp: string
    completed: boolean
  }> = []
  let mappingWrittenHash: string | undefined, priorMapping: Awaited<ReturnType<typeof readMapping>>
  let db: DatabaseSync | undefined,
    transaction = false,
    committed = false
  try {
    await mkdir(archive, { recursive: true, mode: 0o700 })
    await assertNoSymlinks(archive)
    await writeFile(join(archive, "root-plan.json"), JSON.stringify(plan), {
      flag: "wx",
      mode: 0o600,
    })
    await safeIndex(plan.index, plan.root)
    db = new DatabaseSync(plan.index)
    await backup(db, join(archive, "school-index.sqlite"))
    await chmod(join(archive, "school-index.sqlite"), 0o600)
    db.exec("BEGIN IMMEDIATE")
    transaction = true
    const state = snapshot(db)
    if (state.hash !== plan.indexDigest) throw new Error("School index changed after preview")
    priorMapping = await readMapping(plan.root)
    if ((priorMapping?.hash ?? null) !== plan.mappingHash)
      throw new Error("Canvas mapping changed after preview")
    for (const file of plan.files.filter(
      (item) => item.destinationHash || item.current !== item.destination,
    )) {
      const original = await readFile(join(plan.root, file.source))
      if (digest(original) !== file.hash) throw new Error("Reference source changed before staging")
      const result = await rebaseMigrationReferences(original, file, plan.files, plan.root, {
        wikiTargets: plan.wikiTargets,
      })
      if (digest(result.bytes) !== (file.destinationHash ?? file.hash))
        throw new Error("Reference rewrite changed after preview")
      for (const [directory, bytes] of [
        ["reference-originals", original],
        ["reference-rewritten", result.bytes],
      ] as const) {
        const path = join(archive, directory, file.source)
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await assertNoSymlinks(dirname(path))
        await writeFile(path, bytes, { flag: "wx", mode: 0o600 })
      }
    }
    for (const scope of plan.scopes) {
      if ((await treeDigest(scope.source)) !== scope.treeDigest)
        throw new Error("Course root changed before application")
    }
    for (const move of plan.moves) {
      await assertNoSymlinks(move.source)
      if (digest(await readFile(join(move.source, "_index.md"))) !== move.indexHash)
        throw new Error("Course identity manifest changed")
      if ((await treeDigest(move.source)) !== move.treeDigest)
        throw new Error("Course root changed after preview")
      if (await exists(move.destination)) throw new Error("Root destination appeared after preview")
      await rename(move.source, move.destination)
      moved.push(move)
      for (const table of tables)
        db.prepare(
          `UPDATE ${table} SET vault_path = ? || substr(vault_path, length(?) + 1) WHERE vault_path = ? OR substr(vault_path, 1, length(?) + 1) = ?`,
        ).run(move.destination, move.source, move.source, move.source, `${move.source}/`)
      await writeFile(join(archive, "root-progress.json"), JSON.stringify({ moved }), {
        mode: 0o600,
      })
    }
    for (const file of plan.files.filter(
      (item) => item.destinationHash || item.current !== item.destination,
    )) {
      const destination = join(plan.root, file.destination)
      const current = join(plan.root, file.current)
      await assertNoSymlinks(current)
      if (digest(await readFile(current)) !== file.hash)
        throw new Error("Moved reference source changed")
      const staged = await readFile(join(archive, "reference-rewritten", file.source))
      if (digest(staged) !== (file.destinationHash ?? file.hash))
        throw new Error("Staged reference bytes changed")
      if (file.current !== file.destination) {
        await assertNoSymlinks(destination, true)
        await mkdir(dirname(destination), { recursive: true })
        await assertNoSymlinks(dirname(destination))
        const handle = await open(destination, "wx", 0o600)
        // Register only after exclusive creation, never adopt an existing target.
        rewritten.push(file)
        try {
          await handle.writeFile(staged)
        } finally {
          await handle.close()
        }
        if (digest(await readFile(destination)) !== (file.destinationHash ?? file.hash))
          throw new Error("Layout copy hash differs")
        if (digest(await readFile(current)) !== file.hash)
          throw new Error("Layout source changed before archival")
        const removed = join(archive, "removed-originals", file.source)
        await mkdir(dirname(removed), { recursive: true, mode: 0o700 })
        await assertNoSymlinks(dirname(removed))
        await rename(current, removed)
        for (const table of tables)
          db.prepare(`UPDATE ${table} SET vault_path = ? WHERE vault_path = ?`).run(
            destination,
            current,
          )
      } else {
        await assertNoSymlinks(destination)
        await rename(join(archive, "reference-rewritten", file.source), destination)
        rewritten.push(file)
      }
      await writeFile(
        join(archive, "root-references-progress.json"),
        JSON.stringify({ rewritten }),
        { mode: 0o600 },
      )
    }
    if (plan.layout)
      for (const scope of plan.scopes) {
        const source = join(scope.destination, "assignments"),
          destination = join(scope.destination, "Assignments")
        const old = await exists(source),
          modern = await exists(destination)
        if (
          !old?.isDirectory() ||
          !modern?.isDirectory() ||
          old.ino !== modern.ino ||
          old.dev !== modern.dev
        )
          continue
        if (!(await readdir(scope.destination)).includes("assignments")) continue
        const entry = {
          source,
          destination,
          temp: join(archive, `assignment-case-${randomUUID()}`),
          completed: false,
        }
        await rename(source, entry.temp)
        caseRenames.push(entry)
        await rename(entry.temp, destination)
        entry.completed = true
      }
    if ((plan.layout ? plan.scopes : plan.moves).length) {
      const mapping: Mapping = priorMapping
        ? structuredClone(priorMapping.value)
        : { version: 1, courses: [] }
      for (const move of plan.layout ? plan.scopes : plan.moves) {
        const existing = mapping.courses.find((item) => item.id === move.canvasId),
          row = state.courses.find((item) => item.canvas_id === move.canvasId)
        if (!row) throw new Error("Selected course disappeared from the index")
        if (existing) existing.root = basename(move.destination)
        else
          mapping.courses.push({
            id: move.canvasId,
            root: basename(move.destination),
            name: row.name ?? basename(move.destination),
            ...(row.course_code ? { code: row.course_code } : {}),
          })
      }
      const path = join(plan.root, "_meta/canvas-courses.json"),
        current = await readMapping(plan.root)
      if ((current?.hash ?? null) !== plan.mappingHash)
        throw new Error("Canvas mapping changed during migration")
      if (priorMapping)
        await writeFile(join(archive, "canvas-courses.original.json"), priorMapping.bytes, {
          flag: "wx",
          mode: 0o600,
        })
      const bytes = Buffer.from(`${JSON.stringify(mapping, null, 2)}\n`),
        temp = join(archive, "canvas-courses.rewritten.json")
      await writeFile(temp, bytes, { flag: "wx", mode: 0o600 })
      await rename(temp, path)
      mappingWrittenHash = digest(bytes)
    }
    db.exec("COMMIT")
    transaction = false
    committed = true
    await writeFile(join(archive, "root-complete.json"), JSON.stringify({ moved: moved.length }), {
      flag: "wx",
      mode: 0o600,
    })
    return {
      moved: moved.length,
      archive,
      limitation:
        "Selected-course migration only. Historical task/run snapshots and global School layout markers are unchanged; incoming references from unselected courses are not updated. Create fresh tasks for changed source paths and review compatibility before using both tools as writers.",
    }
  } catch (error) {
    if (committed)
      return {
        moved: moved.length,
        archive,
        warning:
          "Root/index transaction committed; completion journal write failed. Inspect the journal before any retry.",
      }
    const recovery: string[] = []
    for (const entry of [...caseRenames].reverse()) {
      try {
        if (!entry.completed && (await exists(entry.source)))
          throw new Error("Assignment directory recreated")
        await rename(entry.completed ? entry.destination : entry.temp, entry.source)
      } catch {
        recovery.push("Assignment directory casing needs manual recovery")
      }
    }
    if (transaction) {
      try {
        db?.exec("ROLLBACK")
      } catch {
        recovery.push("School index rollback needs manual review")
      }
    }
    if (mappingWrittenHash) {
      try {
        const current = await readMapping(plan.root)
        if (current?.hash !== mappingWrittenHash)
          throw new Error("Canvas mapping was edited concurrently")
        const path = join(plan.root, "_meta/canvas-courses.json")
        if (priorMapping) {
          const temp = join(archive, "canvas-courses.rollback.json")
          await writeFile(temp, priorMapping.bytes, { flag: "wx", mode: 0o600 })
          await rename(temp, path)
        } else {
          const { unlink } = await import("node:fs/promises")
          await unlink(path)
        }
      } catch {
        recovery.push("Canvas mapping needs manual recovery")
      }
    }
    for (const file of [...rewritten].reverse()) {
      try {
        const path = join(plan.root, file.destination)
        await assertNoSymlinks(path)
        if (digest(await readFile(path)) !== (file.destinationHash ?? file.hash))
          throw new Error("Reference was edited concurrently")
        const original = await readFile(join(archive, "reference-originals", file.source))
        if (digest(original) !== file.hash) throw new Error("Reference backup changed")
        if (file.current !== file.destination) {
          const current = join(plan.root, file.current)
          const stat = await exists(current)
          if (!stat)
            await copyFile(
              join(archive, "reference-originals", file.source),
              current,
              constants.COPYFILE_EXCL,
            )
          else if (digest(await readFile(current)) !== file.hash)
            throw new Error("Original layout path was recreated with new bytes")
          await unlink(path)
          continue
        }
        const temp = join(archive, "reference-rollback", file.source)
        await mkdir(dirname(temp), { recursive: true, mode: 0o700 })
        await assertNoSymlinks(dirname(temp))
        await writeFile(temp, original, { flag: "wx", mode: 0o600 })
        await rename(temp, path)
      } catch {
        recovery.push(`Reference needs manual recovery: ${file.source}`)
      }
    }
    for (const move of [...moved].reverse()) {
      try {
        if (await exists(move.source)) throw new Error("Source root was recreated")
        await assertNoSymlinks(move.destination)
        await rename(move.destination, move.source)
      } catch {
        recovery.push(`Root needs manual recovery: ${move.canvasId}`)
      }
    }
    await writeFile(join(archive, "root-interrupted.json"), JSON.stringify({ recovery }), {
      flag: "wx",
      mode: 0o600,
    }).catch(() => {})
    throw new Error(
      `Root migration interrupted: ${(error as Error).message}. ${recovery.join("; ")} Backup/journal: ${archive}`,
    )
  } finally {
    db?.close()
    await rmdir(lock)
  }
}
