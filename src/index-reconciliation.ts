import { constants } from "node:fs"
import { lstat, open, readdir } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { parse as parseYaml } from "yaml"
import { assertNoSymlinks } from "./fs-safety.js"
import { withSchoolIndexSnapshot } from "./school-index-snapshot.js"

const tables = ["courses", "modules", "assignments", "announcements", "files"] as const
type Table = (typeof tables)[number]
type Row = {
  canvas_id: string
  course_canvas_id: string
  vault_path: string | null
  unavailable: number
}
export type IndexFinding = {
  table: Table
  canvasId: string
  courseCanvasId: string
  indexedPath: string
  indexedPathScope: "inside-vault" | "outside-vault"
  status:
    | "unique-relocation"
    | "ambiguous-relocation"
    | "concluded-or-deleted"
    | "course-root-absent"
    | "missing-local"
    | "identity-mismatch"
  candidates: string[]
}
function within(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`)
}
const key = (course: string, table: Table, id: string) => JSON.stringify([course, table, id])

/** Diagnose only explicitly selected School rows. Never edit or open outside-vault document paths. */
export async function reconcileSchoolIndex(options: {
  vault: string
  index: string
  courseIds: string[]
  canvasOrigin: string
}) {
  const vault = resolve(options.vault),
    index = resolve(options.index)
  if (!isAbsolute(options.index) || within(vault, index))
    throw new Error("Supply an absolute School index path outside the vault")
  const ids = [...new Set(options.courseIds)].sort()
  if (!ids.length || ids.length > 1000 || ids.some((id) => !/^\d{1,20}$/.test(id)))
    throw new Error("Reconciliation requires explicit numeric course IDs (maximum 1000)")
  await assertNoSymlinks(vault)
  if (!(await lstat(vault)).isDirectory()) throw new Error("Vault must be a directory")
  await assertNoSymlinks(index)
  const indexStat = await lstat(index)
  if (!indexStat.isFile() || indexStat.size > 512 * 1024 * 1024)
    throw new Error("School index must be an existing bounded regular file")
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    await assertNoSymlinks(index + suffix, true)
    const stat = await lstat(index + suffix).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return null
    })
    if (stat && (!stat.isFile() || stat.size > 512 * 1024 * 1024))
      throw new Error("School index journal is unsafe or oversized")
  }
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number)
  if (major < 22 || (major === 22 && minor < 16) || (major === 23 && minor < 8))
    throw new Error("School index diagnostics require Node 22.16+ (or 23.8+)")
  const { DatabaseSync } = await import("node:sqlite")
  const rows: { table: Table; row: Row }[] = []
  let rowBytes = 0
  await withSchoolIndexSnapshot(index, (copy) => {
    const db = new DatabaseSync(copy, { readOnly: true })
    try {
      const version = db.prepare("SELECT MAX(version) AS version FROM migrations").get()?.version
      if (typeof version !== "number" || version < 1 || version > 5)
        throw new Error("Unsupported School index schema version")
      const placeholders = ids.map(() => "?").join(",")
      for (const table of tables) {
        const courseColumn = table === "courses" ? "canvas_id" : "course_canvas_id"
        const unavailable =
          table === "courses"
            ? "CASE WHEN workflow_state IN ('completed','concluded') THEN 1 ELSE 0 END"
            : table === "assignments"
              ? "deleted"
              : "0"
        const selected = db
          .prepare(
            `SELECT canvas_id, ${courseColumn} AS course_canvas_id, vault_path, ${unavailable} AS unavailable FROM ${table} WHERE ${courseColumn} IN (${placeholders}) ORDER BY canvas_id LIMIT 100001`,
          )
          .all(...ids)
        if (rows.length + selected.length > 100000)
          throw new Error("Selected index exceeds 100000 rows")
        for (const raw of selected) {
          if (
            typeof raw.canvas_id !== "string" ||
            !/^\d{1,20}$/.test(raw.canvas_id) ||
            typeof raw.course_canvas_id !== "string" ||
            !ids.includes(raw.course_canvas_id) ||
            (raw.vault_path !== null &&
              (typeof raw.vault_path !== "string" ||
                Buffer.byteLength(raw.vault_path) > 4096 ||
                Array.from(raw.vault_path).some((character) => character.charCodeAt(0) < 32)))
          )
            throw new Error("Selected index row has invalid identity or path metadata")
          rows.push({ table, row: raw as unknown as Row })
          rowBytes += Buffer.byteLength(JSON.stringify(raw))
          if (rowBytes > 64 * 1024 * 1024) throw new Error("Selected index metadata exceeds 64 MB")
        }
      }
    } finally {
      db.close()
    }
  })
  const knownCourses = new Set(
    rows.filter(({ table }) => table === "courses").map(({ row }) => row.canvas_id),
  )
  if (ids.some((id) => !knownCourses.has(id)))
    throw new Error("A selected course is absent from the School index")
  const origin = new URL(options.canvasOrigin).origin
  const catalog = new Map<string, string[]>()
  const identities = new Map<string, string>()
  const notices: string[] = []
  let entries = 0,
    bytes = 0
  async function document(path: string): Promise<Record<string, unknown> | null> {
    await assertNoSymlinks(path)
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 5_000_000)
        throw new Error("Document is unsafe or oversized")
      const buffer = Buffer.alloc(Math.min(5_000_001, stat.size + 1))
      let count = 0
      while (count < buffer.length) {
        const read = await handle.read(buffer, count, buffer.length - count, count)
        if (!read.bytesRead) break
        count += read.bytesRead
      }
      bytes += count
      if (count > stat.size || bytes > 100_000_000)
        throw new Error("Document inventory exceeds bounds")
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count))
      const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1]
      if (!header) return null
      let data: unknown
      try {
        data = parseYaml(header)
      } catch {
        notices.push("Skipped malformed document metadata; no content echoed")
        return null
      }
      return data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : null
    } finally {
      await handle.close()
    }
  }
  function add(identity: string, path: string) {
    catalog.set(identity, [...(catalog.get(identity) ?? []), path])
    identities.set(path, identity)
  }
  async function walk(path: string, course: string, depth: number) {
    if (depth > 64) throw new Error("Document inventory exceeds depth bounds")
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++entries > 20000) throw new Error("Document inventory exceeds entry bounds")
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue
      const file = join(path, entry.name)
      if (entry.isSymbolicLink()) {
        notices.push("Skipped linked entry in selected course")
        continue
      }
      if (entry.isDirectory()) {
        await assertNoSymlinks(file)
        await walk(file, course, depth + 1)
      } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "_index.md") {
        const data = await document(file)
        if (
          data?.source !== "sync" ||
          typeof data.canvas_id !== "string" ||
          !/^\d{1,20}$/.test(data.canvas_id) ||
          typeof data.canvas_url !== "string"
        )
          continue
        let url: URL
        try {
          url = new URL(data.canvas_url)
        } catch {
          continue
        }
        if (url.origin !== origin) continue
        const table = tables.find((item) => item !== "courses" && item === data.type)
        const urlCourse = /^\/courses\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1]
        const resource =
          /\/(modules|assignments|announcements|discussion_topics|files)\/(\d+)(?:\/|$)/.exec(
            url.pathname,
          )
        if (
          table &&
          (resource?.[1] === table ||
            (table === "announcements" && resource?.[1] === "discussion_topics")) &&
          resource[2] === data.canvas_id &&
          (!urlCourse || urlCourse === course)
        )
          add(key(course, table, data.canvas_id), file)
      }
    }
  }
  for (const entry of await readdir(vault, { withFileTypes: true })) {
    if (++entries > 20000) throw new Error("Document inventory exceeds entry bounds")
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue
    const root = join(vault, entry.name),
      manifest = join(root, "_index.md")
    const stat = await lstat(manifest).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return null
    })
    if (!stat) continue
    const data = await document(manifest)
    if (
      (data?.type !== "index" && data?.type !== "_index.md") ||
      typeof data.canvas_id !== "string" ||
      !ids.includes(data.canvas_id) ||
      typeof data.canvas_url !== "string"
    )
      continue
    let url: URL
    try {
      url = new URL(data.canvas_url)
    } catch {
      continue
    }
    if (
      url.origin !== origin ||
      /^\/courses\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1] !== data.canvas_id
    )
      continue
    add(key(data.canvas_id, "courses", data.canvas_id), root)
    await walk(root, data.canvas_id, 0)
  }
  const concluded = new Set(
    rows
      .filter(({ table, row }) => table === "courses" && row.unavailable === 1)
      .map(({ row }) => row.canvas_id),
  )
  const findings: IndexFinding[] = []
  for (const { table, row } of rows) {
    if (!row.vault_path) continue
    const indexedPath = resolve(vault, row.vault_path),
      identity = key(row.course_canvas_id, table, row.canvas_id)
    if (identities.get(indexedPath) === identity) continue
    const candidates = (catalog.get(identity) ?? []).sort()
    const mismatched = identities.has(indexedPath)
    const status = mismatched
      ? "identity-mismatch"
      : row.unavailable === 1 || concluded.has(row.course_canvas_id)
        ? "concluded-or-deleted"
        : candidates.length > 1
          ? "ambiguous-relocation"
          : candidates.length === 1
            ? "unique-relocation"
            : !catalog.has(key(row.course_canvas_id, "courses", row.course_canvas_id))
              ? "course-root-absent"
              : "missing-local"
    findings.push({
      table,
      canvasId: row.canvas_id,
      courseCanvasId: row.course_canvas_id,
      indexedPath,
      indexedPathScope: within(vault, indexedPath) ? "inside-vault" : "outside-vault",
      status,
      candidates,
    })
  }
  return {
    vaultRoot: vault,
    indexPath: index,
    courseIds: ids,
    findings,
    proposedRelinks: findings.filter((finding) => finding.status === "unique-relocation").length,
    notices,
    dryRun: true as const,
    changesMade: false as const,
    classificationScope: "validated-local-identities" as const,
    authorshipAuthenticated: false as const,
    indexSnapshotVerified: true as const,
    currentIndexVerified: false as const,
    canvasAvailabilityVerified: false as const,
  }
}
