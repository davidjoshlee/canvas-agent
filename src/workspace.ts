import { createHash } from "node:crypto"
import type { Dirent } from "node:fs"
import { lstat, readdir, readFile } from "node:fs/promises"
import { basename, join, relative, resolve, sep } from "node:path"

import { parse as parseYaml } from "yaml"
import { assertNoSymlinks } from "./fs-safety.js"

import type { CourseContext, ExcludedSource, SourceRecord, WorkspaceContext } from "./types.js"

const courseCodePattern = /^[A-Z]{2,12}[-_]?[0-9]{2,4}[A-Z]?$/i
const textExtensions = new Set([".md", ".markdown", ".txt"])
const workDirectoryNames = new Set(["prep", "drafts", "draft", "final", "finals"])

type ScanEntry = { path: string; absolute: string; name: string; parent: string }

/** Read a School Agent style workspace without changing it or following links. */
export async function inspectWorkspace(vault: string): Promise<WorkspaceContext> {
  const root = resolve(vault)
  await assertNoSymlinks(root)
  const rootStat = await lstat(root).catch(() => null)
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Workspace is not a readable directory: ${root}`)
  }

  const notices: string[] = []
  const mapped = new Map<string, { id: string; name: string }>()
  const manifestPath = join(root, "_meta", "canvas-courses.json")
  try {
    await assertNoSymlinks(manifestPath)
    const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"))
    if (!isRecord(manifest) || manifest.version !== 1 || !Array.isArray(manifest.courses))
      throw new Error("Invalid mapping")
    for (const entry of manifest.courses) {
      if (
        !isRecord(entry) ||
        typeof entry.root !== "string" ||
        typeof entry.id !== "string" ||
        typeof entry.name !== "string" ||
        !entry.root ||
        entry.root.startsWith(".") ||
        entry.root.startsWith("_") ||
        /[\\/]/.test(entry.root)
      )
        continue
      if (mapped.has(entry.root)) throw new Error("Ambiguous mapping")
      mapped.set(entry.root, { id: entry.id, name: entry.name })
    }
  } catch (error) {
    mapped.clear()
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      notices.push(
        "Canvas course mappings are unavailable or unsafe; using conventional course folders only.",
      )
  }
  const courses: CourseContext[] = []
  const children = await readdir(root, { withFileTypes: true })
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (child.name === "_meta") {
      notices.push("Skipped private metadata directory: _meta")
      continue
    }
    if (child.name.startsWith(".")) {
      notices.push(`Skipped hidden entry: ${child.name}`)
      continue
    }
    if (child.isSymbolicLink()) {
      notices.push(`Skipped symbolic link: ${child.name}`)
      continue
    }
    if (!child.isDirectory() || !(courseCodePattern.test(child.name) || mapped.has(child.name)))
      continue
    const course = await inspectCourse(root, child.name, notices)
    const mapping = mapped.get(child.name)
    if (mapping) {
      course.canvasId = mapping.id
      course.title = mapping.name
    }
    courses.push(course)
  }

  const pendingTasks: string[] = []
  const tasksPath = join(root, "_meta", "tasks")
  try {
    await assertNoSymlinks(tasksPath)
    const taskStat = await lstat(tasksPath)
    if (taskStat.isDirectory() && !taskStat.isSymbolicLink()) {
      for (const entry of await readdir(tasksPath, { withFileTypes: true })) {
        if (
          !entry.isDirectory() ||
          entry.isSymbolicLink() ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            entry.name,
          )
        )
          continue
        try {
          const taskPath = join(tasksPath, entry.name, "task.json")
          const taskStat = await lstat(taskPath)
          if (!taskStat.isFile() || taskStat.isSymbolicLink()) continue
          const task = JSON.parse(await readFile(taskPath, "utf8")) as { status?: unknown }
          if (task.status === "pending") pendingTasks.push(`_meta/tasks/${entry.name}`)
        } catch {
          // Invalid or incomplete private task records are not exposed.
        }
      }
    }
  } catch {
    // An absent task directory is normal in existing School Agent vaults.
  }

  return { version: 1, vault: root, courses, pendingTasks: pendingTasks.sort(), notices }
}

export function selectCourse(context: WorkspaceContext, query: string): CourseContext {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) throw new Error("Course query must not be empty")
  const matches = context.courses.filter((course) =>
    [course.code, course.title, course.root].some((value) => value.toLocaleLowerCase() === needle),
  )
  const partial =
    matches.length > 0
      ? matches
      : context.courses.filter((course) =>
          [course.code, course.title, course.root].some((value) =>
            value.toLocaleLowerCase().includes(needle),
          ),
        )
  if (partial.length === 0) throw new Error(`No course matches "${query}"`)
  if (partial.length > 1) {
    throw new Error(
      `Course query "${query}" is ambiguous: ${partial.map((course) => course.code).join(", ")}`,
    )
  }
  const course = partial[0]
  if (!course) throw new Error(`No course matches "${query}"`)
  return course
}

async function inspectCourse(
  vault: string,
  code: string,
  notices: string[],
): Promise<CourseContext> {
  const absoluteRoot = join(vault, code)
  const root = relative(vault, absoluteRoot).split(sep).join("/")
  const sources: SourceRecord[] = []
  const excluded: ExcludedSource[] = []
  const guidance: string[] = []
  const existingWork: string[] = []
  const entries: ScanEntry[] = []
  const periods = (await readdir(absoluteRoot, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        /^Week \d+ - [A-Za-z]{3} \d{1,2}$/.test(entry.name),
    )
    .map((entry) => `${root}/${entry.name}`)
    .sort()
  await walk(absoluteRoot, root, entries, notices)
  const globalAgents = join(vault, "AGENTS.md")
  try {
    const stat = await lstat(globalAgents)
    if (stat.isFile() && !stat.isSymbolicLink()) {
      entries.push({ path: "AGENTS.md", absolute: globalAgents, name: "AGENTS.md", parent: "" })
    }
  } catch {
    // Root guidance is optional.
  }

  let title = code
  let safeIndex:
    | {
        entry: ScanEntry
        parsed: { bytes: Buffer; data: Record<string, unknown>; content: string }
      }
    | undefined
  const index = entries.find((entry) => entry.path === `${root}/_index.md`)
  if (index) {
    const parsed = await readDocument(index, excluded)
    if (parsed && !isRestricted(parsed.data)) {
      title = stringValue(parsed.data.course_title) ?? headingTitle(parsed.content) ?? code
      safeIndex = { entry: index, parsed }
    } else if (parsed) {
      excluded.push({ path: index.path, reason: "Restricted policy metadata; text omitted" })
    }
  }
  if (safeIndex) sources.push(toSource(safeIndex.entry, safeIndex.parsed))

  for (const entry of entries) {
    if (entry.path === `${root}/_index.md`) continue
    if (/^(?:credentials?|secrets?|passwords?|tokens?)(?:\..*)?$/i.test(entry.name)) {
      excluded.push({ path: entry.path, reason: "Credential-like file; text omitted" })
      continue
    }
    if (isProposal(entry.path)) {
      excluded.push({
        path: entry.path,
        reason: "Proposed guidance is not active context; text omitted",
      })
      continue
    }
    if (entry.path === "AGENTS.md") {
      const parsed = await readDocument(entry, excluded)
      if (!parsed) continue
      if (isRestricted(parsed.data)) {
        excluded.push({ path: entry.path, reason: "Restricted policy metadata; text omitted" })
        continue
      }
      guidance.push(entry.path)
      continue
    }
    if (isExistingWork(entry.path)) {
      existingWork.push(entry.path)
      continue
    }
    if (!textExtensions.has(extension(entry.name))) {
      excluded.push({ path: entry.path, reason: "Unsupported or binary file type; text not read" })
      continue
    }
    const isGuidance = isGuidancePath(entry.path)
    const parsed = await readDocument(entry, excluded)
    if (!parsed) continue
    if (isRestricted(parsed.data)) {
      excluded.push({ path: entry.path, reason: "Restricted policy metadata; text omitted" })
      continue
    }
    const record = toSource(entry, parsed)
    if (isGuidance) {
      guidance.push(entry.path)
    } else {
      sources.push(record)
    }
  }
  return {
    code,
    title,
    root,
    sources: sources.sort(byPath),
    excluded: uniqueExcluded(excluded).sort(byPath),
    guidance: guidance.sort(),
    existingWork: [...new Set(existingWork)].sort(),
    periods,
  }
}

async function walk(
  directory: string,
  relativeDirectory: string,
  entries: ScanEntry[],
  notices: string[],
): Promise<void> {
  let children: Dirent[]
  try {
    children = await readdir(directory, { withFileTypes: true })
  } catch {
    notices.push(`Could not read directory: ${relativeDirectory}`)
    return
  }
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(directory, child.name)
    const path = `${relativeDirectory}/${child.name}`
    if (child.name.startsWith(".")) {
      notices.push(`Skipped hidden entry: ${path}`)
      continue
    }
    if (child.isSymbolicLink()) {
      notices.push(`Skipped symbolic link: ${path}`)
      continue
    }
    if (child.isDirectory()) {
      if (child.name === "_meta") {
        notices.push(`Skipped private metadata under: ${relativeDirectory}`)
        const guidancePath = join(absolute, "guidance")
        try {
          const guidanceStat = await lstat(guidancePath)
          if (guidanceStat.isDirectory() && !guidanceStat.isSymbolicLink()) {
            await walk(guidancePath, `${path}/guidance`, entries, notices)
          } else if (guidanceStat.isSymbolicLink()) {
            notices.push(`Skipped symbolic link: ${path}/guidance`)
          }
        } catch {
          // Private task and operational metadata are intentionally ignored.
        }
        continue
      }
      await walk(absolute, path, entries, notices)
    } else if (child.isFile()) {
      // Only course guidance is intentionally read from metadata; task and operational metadata stay private.
      if (path.includes("/_meta/") && !path.includes("/_meta/guidance/")) continue
      entries.push({ path, absolute, name: child.name, parent: relativeDirectory })
    }
  }
}

async function readDocument(
  entry: ScanEntry,
  excluded: ExcludedSource[],
): Promise<{ bytes: Buffer; data: Record<string, unknown>; content: string } | null> {
  let bytes: Buffer
  try {
    await assertNoSymlinks(entry.absolute)
    const info = await lstat(entry.absolute)
    if (!info.isFile() || info.size > 5 * 1024 * 1024) {
      excluded.push({
        path: entry.path,
        reason: "Not a regular text file or exceeds 5 MB text limit; text omitted",
      })
      return null
    }
    bytes = await readFile(entry.absolute)
  } catch {
    excluded.push({ path: entry.path, reason: "Could not read file" })
    return null
  }
  if (bytes.includes(0)) {
    excluded.push({ path: entry.path, reason: "Binary content; text not read" })
    return null
  }
  const text = bytes.toString("utf8")
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    excluded.push({ path: entry.path, reason: "Invalid UTF-8; text not read" })
    return null
  }
  try {
    const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/)
    if (!match) {
      if (/^---(?:\s*\r?\n|$)/.test(text)) throw new Error("Unterminated frontmatter")
      return { bytes, data: {}, content: text.trim() }
    }
    const parsed = parseYaml(match[1] ?? "")
    if (!isRecord(parsed) && parsed !== null && parsed !== undefined)
      throw new Error("Frontmatter must be a mapping")
    return {
      bytes,
      data: isRecord(parsed) ? parsed : {},
      content: text.slice(match[0].length).trim(),
    }
  } catch {
    excluded.push({ path: entry.path, reason: "Malformed frontmatter; text omitted" })
    return null
  }
}

function toSource(
  entry: ScanEntry,
  parsed: { bytes: Buffer; data: Record<string, unknown>; content: string },
): SourceRecord {
  const dates = collectDates(parsed.data.dates)
  for (const match of entry.path.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) dates.push(match[0])
  return {
    path: entry.path,
    title:
      stringValue(parsed.data.title) ??
      headingTitle(parsed.content) ??
      basename(entry.name, extension(entry.name)),
    hash: createHash("sha256").update(parsed.bytes).digest("hex"),
    text: parsed.content,
    type: stringValue(parsed.data.type) ?? inferType(entry.path),
    dates: [...new Set(dates)].sort(),
    ...(stringValue(parsed.data.canvas_url)
      ? { canvasUrl: stringValue(parsed.data.canvas_url) ?? "" }
      : {}),
  }
}

function isRestricted(data: Record<string, unknown>): boolean {
  const values = [data.ai_policy, data.policy, data.redistribution]
  for (const raw of values) {
    if (raw === undefined || raw === null || raw === "") continue
    const value = String(raw)
      .trim()
      .toLocaleLowerCase()
      .replace(/[\s-]+/g, "_")
    if (value === "allowed" || value === "allow" || value === "permitted") continue
    // School Agent's prohibited/restricted values and local-only or unknown policy labels are excluded.
    return true
  }
  return false
}

function isExistingWork(path: string): boolean {
  return path.split("/").some((segment) => workDirectoryNames.has(segment.toLocaleLowerCase()))
}

function isGuidancePath(path: string): boolean {
  const parts = path.split("/")
  const lower = parts.map((part) => part.toLocaleLowerCase())
  if (lower.some((part) => part === "prep-guidance.proposed.md")) return false
  return (
    lower.some((part, index) => {
      if (part === "guidance") return true
      return part === "_meta" && lower[index + 1] === "guidance"
    }) ||
    (lower.at(-1) === "agents.md" && parts.length === 2)
  )
}

function isProposal(path: string): boolean {
  const name = basename(path).toLocaleLowerCase()
  return (
    name.includes(".proposed.") || name.startsWith("proposed-") || name.endsWith("-proposal.md")
  )
}

function inferType(path: string): string {
  const parts = path.toLocaleLowerCase().split("/")
  if (parts.some((part) => /^(assignments?|assignment\s)/.test(part))) return "assignment"
  if (parts.some((part) => /^week(?:\s|[-_])/.test(part))) return "week"
  if (parts.some((part) => part === "resources")) return "resource"
  return "document"
}

function collectDates(value: unknown): string[] {
  if (!isRecord(value)) return []
  return Object.values(value).flatMap((date) => {
    if (typeof date !== "string") return []
    const match = date.match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/)
    return match?.[1] ? [match[1]] : []
  })
}

function headingTitle(content: string): string | null {
  return (
    content
      .split(/\r?\n/)
      .map((line) => line.match(/^#\s+(.+?)\s*#*$/)?.[1]?.trim())
      .find(Boolean) ?? null
  )
}

function extension(name: string): string {
  return name.slice(name.lastIndexOf(".")).toLocaleLowerCase()
}
function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function byPath(a: { path: string }, b: { path: string }): number {
  return a.path.localeCompare(b.path)
}
function uniqueExcluded(items: ExcludedSource[]): ExcludedSource[] {
  return [...new Map(items.map((item) => [item.path, item])).values()]
}
