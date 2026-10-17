import { createHash } from "node:crypto"
import { constants, type Dirent } from "node:fs"
import { lstat, open, readdir, readFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { parse as parseYaml } from "yaml"
import { AssignmentDatesSchema } from "../canvas/assignment-dates.js"
import { readIngestProvenance } from "../documents/ingest-compatibility.js"
import { type Diagnostic, diagnostic } from "../shared/diagnostics.js"
import { assertNoSymlinks } from "../shared/fs-safety.js"

import type {
  CourseContext,
  ExcludedSource,
  SourceRecord,
  WorkspaceContext,
} from "../shared/types.js"

const courseCodePattern = /^[A-Z]{2,12}[-_]?[0-9]{2,4}[A-Z]?$/i
const textExtensions = new Set([".md", ".markdown", ".txt"])
const workDirectoryNames = new Set(["prep", "drafts", "draft", "final", "finals"])

type ScanEntry = { path: string; absolute: string; name: string; parent: string }
type NoticeCollector = { messages: string[]; diagnostics: Diagnostic[] }

function addNotice(
  notices: NoticeCollector,
  code: string,
  message: string,
  scope: "workspace" | "course" = "workspace",
  severity: "info" | "warning" | "error" = "warning",
  path?: string,
): void {
  notices.messages.push(message)
  notices.diagnostics.push(
    diagnostic(code, message, { scope, severity, ...(path ? { path } : {}) }),
  )
}

async function readCourseMappings(root: string, notices: NoticeCollector) {
  const mapped = new Map<
    string,
    { id: string; name: string; code?: string; syncNamespace?: "Canvas Agent" }
  >()
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
      if (entry.syncNamespace !== undefined && entry.syncNamespace !== "Canvas Agent")
        throw new Error("Unsupported product namespace")
      mapped.set(entry.root, {
        id: entry.id,
        name: entry.name,
        code: stringValue(entry.code) ?? undefined,
        ...(entry.syncNamespace === "Canvas Agent"
          ? { syncNamespace: "Canvas Agent" as const }
          : {}),
      })
    }
  } catch (error) {
    mapped.clear()
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      addNotice(
        notices,
        "workspace.course_mappings_unavailable",
        "Canvas course mappings are unavailable or unsafe; using conventional course folders only.",
        "workspace",
        "error",
      )
  }
  return mapped
}

async function readWorkspaceCourses(
  root: string,
  mapped: Awaited<ReturnType<typeof readCourseMappings>>,
  notices: NoticeCollector,
) {
  const ownership = [...mapped.values()].some((course) => course.syncNamespace)
    ? await readPreservedOwnership(root)
    : undefined
  const courses: CourseContext[] = []
  const children = await readdir(root, { withFileTypes: true })
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (child.name === "_meta") {
      addNotice(
        notices,
        "workspace.private_metadata_skipped",
        "Skipped private metadata directory: _meta",
      )
      continue
    }
    if (child.name.startsWith(".")) {
      addNotice(notices, "workspace.hidden_entry_skipped", `Skipped hidden entry: ${child.name}`)
      continue
    }
    if (child.isSymbolicLink()) {
      addNotice(
        notices,
        "workspace.symlink_skipped",
        `Skipped symbolic link: ${child.name}`,
        "workspace",
        "warning",
        child.name,
      )
      continue
    }
    if (!child.isDirectory() || !(courseCodePattern.test(child.name) || mapped.has(child.name)))
      continue
    const mapping = mapped.get(child.name)
    const course = await inspectCourse(
      root,
      child.name,
      notices,
      mapping?.syncNamespace ? ownership : undefined,
    )
    if (mapping) {
      course.canvasId = mapping.id
      course.canvasCode = mapping.code
      course.title = mapping.name
      if (mapping.syncNamespace) course.syncNamespace = mapping.syncNamespace
    }
    courses.push(course)
  }

  return courses
}

async function readPendingTaskPaths(root: string, notices: NoticeCollector) {
  const pendingTasks: string[] = []
  const tasksPath = join(root, "_meta", "tasks")
  try {
    await assertNoSymlinks(tasksPath)
    const taskStat = await lstat(tasksPath)
    if (taskStat.isDirectory() && !taskStat.isSymbolicLink()) {
      const entries = await readdir(tasksPath, { withFileTypes: true })
      if (entries.length > 5000) throw new Error("Task inventory exceeds bounds")
      let taskBytes = 0
      for (const entry of entries) {
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
          if (!taskStat.isFile() || taskStat.isSymbolicLink() || taskStat.size > 50_000_000)
            throw new Error("Unsafe or oversized task record")
          taskBytes += taskStat.size
          if (taskBytes > 500_000_000) throw new Error("Task inventory exceeds bounds")
          const task = JSON.parse(await readFile(taskPath, "utf8")) as { status?: unknown }
          if (task.status === "pending") pendingTasks.push(`_meta/tasks/${entry.name}`)
        } catch {
          if (
            !notices.messages.includes(
              "Private task inventory is incomplete; inspect saved records",
            )
          )
            addNotice(
              notices,
              "workspace.task_inventory_incomplete",
              "Private task inventory is incomplete; inspect saved records",
            )
          if (taskBytes > 500_000_000) break
        }
      }
    }
  } catch (error) {
    // An absent task directory is normal in existing School Agent vaults.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      addNotice(
        notices,
        "workspace.task_inventory_unavailable",
        "Private task inventory is unavailable or exceeds bounds; inspect saved records",
      )
  }

  return pendingTasks
}

/** Read a School Agent style workspace without changing it or following links. */
export async function inspectWorkspace(vault: string): Promise<WorkspaceContext> {
  const root = resolve(vault)
  await assertNoSymlinks(root)
  const rootStat = await lstat(root).catch(() => null)
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Workspace is not a readable directory: ${root}`)
  }

  const notices: NoticeCollector = { messages: [], diagnostics: [] }
  const mapped = await readCourseMappings(root, notices)
  const courses = await readWorkspaceCourses(root, mapped, notices)
  const pendingTasks = await readPendingTaskPaths(root, notices)
  return {
    version: 1,
    vault: root,
    courses,
    pendingTasks: pendingTasks.sort(),
    notices: notices.messages,
    diagnostics: [...notices.diagnostics],
  }
}

export function selectCourse(context: WorkspaceContext, query: string): CourseContext {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) throw new Error("Course query must not be empty")
  const matches = context.courses.filter((course) =>
    courseAliases(course).some((value) => value.toLocaleLowerCase() === needle),
  )
  const partial =
    matches.length > 0
      ? matches
      : /^\d+$/.test(needle)
        ? []
        : context.courses.filter((course) =>
            // Numeric Canvas IDs are exact identities, never substring matches.
            courseAliases(course)
              .filter((value) => value !== course.canvasId)
              .some((value) => value.toLocaleLowerCase().includes(needle)),
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

function courseAliases(course: CourseContext): string[] {
  const title =
    course.canvasCode && course.title.startsWith(`${course.canvasCode} - `)
      ? course.title.slice(course.canvasCode.length + 3)
      : course.title
  return [course.code, course.root, course.title, title, course.canvasId, course.canvasCode].filter(
    (value): value is string => Boolean(value),
  )
}

/** Ownership evidence is required only for the explicitly preserved product layout. */
async function readPreservedOwnership(vault: string): Promise<Record<string, string>> {
  const path = join(vault, "_meta/canvas-sync-state.json")
  try {
    await assertNoSymlinks(path)
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      const limit = 10 * 1024 * 1024
      if (!stat.isFile() || stat.size > limit) throw new Error("Invalid ownership file")
      const bytes = Buffer.alloc(limit + 1)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead > limit) throw new Error("Oversized ownership file")
      const state: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"))
      if (!isRecord(state) || state.version !== 1 || !isRecord(state.files))
        throw new Error("Invalid ownership metadata")
      const files: Record<string, string> = Object.create(null)
      for (const [key, value] of Object.entries(state.files)) {
        if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
          throw new Error("Invalid ownership hash")
        files[key] = value
      }
      return files
    } finally {
      await handle.close()
    }
  } catch {
    throw new Error(
      "Preserved Canvas source ownership is missing or unsafe; inspect metadata before selecting fresh context",
    )
  }
}

type ParsedDocument = NonNullable<Awaited<ReturnType<typeof readDocument>>>

interface CourseInventory {
  vault: string
  root: string
  absoluteRoot: string
  sources: SourceRecord[]
  excluded: ExcludedSource[]
  guidance: string[]
  existingWork: string[]
  compatible: Map<string, Awaited<ReturnType<typeof readDocument>>>
  restrictedOriginals: Set<string>
}

async function filterRetiredSources(
  entries: ScanEntry[],
  root: string,
  excluded: ExcludedSource[],
  retiredOwnership?: Record<string, string>,
): Promise<void> {
  // Retain retired files on disk and in saved histories, but never let an
  // unchanged old Canvas snapshot shadow refreshed sources. Edited/untracked
  // School or student files remain eligible. Filter before deriving relations.
  if (retiredOwnership) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (!entry || entry.path.startsWith(`${root}/Canvas Agent/`)) continue
      const ownedHash = retiredOwnership[entry.path]
      if (!ownedHash || !textExtensions.has(extension(entry.name))) continue
      const parsed = await readDocument(entry, [])
      if (parsed && createHash("sha256").update(parsed.bytes).digest("hex") === ownedHash) {
        entries.splice(i, 1)
        excluded.push({
          path: entry.path,
          reasonCode: "source.retired_canvas_owned",
          reason:
            "Retired unchanged Canvas-owned source; original retained outside active namespace",
        })
      }
    }
  }
}

async function appendGlobalGuidance(vault: string, entries: ScanEntry[]): Promise<void> {
  const globalAgents = join(vault, "AGENTS.md")
  try {
    const stat = await lstat(globalAgents)
    if (stat.isFile() && !stat.isSymbolicLink()) {
      entries.push({ path: "AGENTS.md", absolute: globalAgents, name: "AGENTS.md", parent: "" })
    }
  } catch {
    // Root guidance is optional.
  }
}

async function readCourseIndex(
  root: string,
  code: string,
  entries: ScanEntry[],
  excluded: ExcludedSource[],
) {
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
      excluded.push({
        path: index.path,
        reasonCode: "source.restricted_policy_metadata",
        reason: "Restricted policy metadata; text omitted",
      })
    }
  }
  return { title, source: safeIndex ? toSource(safeIndex.entry, safeIndex.parsed) : undefined }
}

async function inspectCompatibleSources(
  vault: string,
  absoluteRoot: string,
  entries: ScanEntry[],
  excluded: ExcludedSource[],
) {
  // A restrictive compatible declaration must not be bypassed through its raw
  // text original or an older extraction variant. Keep historical bytes intact.
  const compatible = new Map<string, Awaited<ReturnType<typeof readDocument>>>()
  const restrictedOriginals = new Set<string>()
  const textOriginals = new Set(
    entries
      .filter((entry) => /-[a-f0-9]{12}\.(?:txt|md|markdown)$/.test(entry.name))
      .map((entry) => entry.path),
  )
  for (const entry of entries) {
    if (!/\.school-[a-f0-9]{12}\.extracted\.md$/.test(entry.name)) continue
    const parsed = await readDocument(entry, excluded)
    compatible.set(entry.path, parsed)
    if (!parsed) {
      const original =
        /^(.*-[a-f0-9]{12}\.(?:txt|md|markdown))\.(?:week|as-of|module|school)-/.exec(
          entry.path,
        )?.[1]
      if (original && textOriginals.has(original)) restrictedOriginals.add(original)
      continue
    }
    if (!parsed || !isRestricted(parsed.data)) continue
    const originalPath = stringValue(parsed.data.original_path)
    const originalHash = stringValue(parsed.data.original_hash)
    if (!originalPath || !originalHash || !/^[a-f0-9]{64}$/.test(originalHash)) continue
    const target = resolve(vault, originalPath)
    if (target.startsWith(absoluteRoot + sep) && entry.absolute.startsWith(`${target}.`))
      restrictedOriginals.add(originalPath)
  }

  return { compatible, restrictedOriginals }
}

async function readExtractionSource(
  context: CourseInventory,
  entry: ScanEntry,
  parsed: ParsedDocument,
): Promise<SourceRecord | undefined> {
  const { vault, absoluteRoot, excluded } = context
  const originalPath = stringValue(parsed.data.original_path)
  const originalHash = stringValue(parsed.data.original_hash)
  if (
    originalPath &&
    /(?:^|\/)(?:credentials?|secrets?|passwords?|tokens?)(?:\.[^/]*)?$/i.test(originalPath)
  ) {
    excluded.push({
      path: entry.path,
      reasonCode: "source.credential_like_original",
      reason: "Credential-like original; extraction omitted",
    })
    return
  }
  const relativeOriginal = originalPath && resolve(vault, originalPath)
  if (!originalPath || !originalHash || !relativeOriginal?.startsWith(absoluteRoot + sep)) {
    excluded.push({
      path: entry.path,
      reasonCode: "source.invalid_extraction_provenance",
      reason: "Extraction sidecar has invalid original provenance; text omitted",
    })
    return
  }
  try {
    await assertNoSymlinks(relativeOriginal)
    const originalInfo = await lstat(relativeOriginal)
    if (!originalInfo.isFile() || originalInfo.size > 50 * 1024 * 1024)
      throw new Error("Extraction original exceeds the regular-file size limit")
    const original = await readFile(relativeOriginal)
    if (createHash("sha256").update(original).digest("hex") !== originalHash) {
      excluded.push({
        path: entry.path,
        reasonCode: "source.stale_extraction",
        reason: "Extraction sidecar is stale; text omitted",
      })
      return
    }
    // A generated sidecar must not launder policy metadata from an original
    // Markdown/text document. The sidecar's own frontmatter only proves
    // provenance; the original's guidance policy remains authoritative.
    if (textExtensions.has(extension(basename(originalPath)))) {
      const originalEntry: ScanEntry = {
        path: originalPath,
        absolute: relativeOriginal,
        name: basename(originalPath),
        parent: dirname(originalPath),
      }
      const originalParsed = await readDocument(originalEntry, [])
      if (!originalParsed || isRestricted(originalParsed.data)) {
        excluded.push({
          path: entry.path,
          reasonCode: "source.restricted_original_metadata",
          reason:
            "Original document has malformed or restricted policy metadata; extraction omitted",
        })
        return
      }
    }
  } catch {
    excluded.push({
      path: entry.path,
      reasonCode: "source.unsafe_extraction_original",
      reason: "Extraction original is missing or unsafe; text omitted",
    })
    return
  }
  if (isRestricted(parsed.data)) {
    excluded.push({
      path: entry.path,
      reasonCode: "source.restricted_policy_metadata",
      reason: "Restricted policy metadata; text omitted",
    })
    return
  }
  return {
    ...toSource(entry, parsed),
    originalPath,
    originalHash,
    ...(stringValue(parsed.data.module_canvas_id)
      ? { moduleCanvasId: stringValue(parsed.data.module_canvas_id) as string }
      : {}),
  }
}

function courseSourceRecord(
  entry: ScanEntry,
  parsed: ParsedDocument,
  excluded: ExcludedSource[],
): SourceRecord | undefined {
  const record = toSource(entry, parsed)
  if (parsed.data.assignment_dates !== undefined) {
    const evidence = AssignmentDatesSchema.safeParse(parsed.data.assignment_dates)
    if (!evidence.success) {
      excluded.push({
        path: entry.path,
        reasonCode: "source.invalid_assignment_dates",
        reason: "Invalid assignment date evidence; inspect source metadata",
      })
      return
    }
    record.assignmentDates = evidence.data
  }
  if (stringValue(parsed.data.module_canvas_id))
    record.moduleCanvasId = stringValue(parsed.data.module_canvas_id) ?? undefined
  const relationText =
    typeof parsed.data.related_paths === "string"
      ? [parsed.data.related_paths]
      : Array.isArray(parsed.data.related_paths)
        ? parsed.data.related_paths.filter((v): v is string => typeof v === "string")
        : []
  const relatedPaths = [...new Set(relationText)]
  if (relatedPaths.length) record.relatedPaths = relatedPaths
  if (stringValue(parsed.data.due_at)) record.dueAt = stringValue(parsed.data.due_at) ?? undefined
  if (!record.dueAt && isRecord(parsed.data.dates))
    record.dueAt = stringValue(parsed.data.dates.due_at) ?? undefined
  if (stringValue(parsed.data.canvas_id))
    record.canvasId = stringValue(parsed.data.canvas_id) ?? undefined
  return record
}

async function inspectCourseEntry(context: CourseInventory, entry: ScanEntry): Promise<void> {
  const { root, sources, excluded, guidance, existingWork, compatible, restrictedOriginals } =
    context
  if (entry.path === `${root}/_index.md`) return
  if (/^(?:credentials?|secrets?|passwords?|tokens?)(?:\..*)?$/i.test(entry.name)) {
    excluded.push({
      path: entry.path,
      reasonCode: "source.credential_like",
      reason: "Credential-like file; text omitted",
    })
    return
  }
  if (isProposal(entry.path)) {
    excluded.push({
      path: entry.path,
      reasonCode: "source.proposed_guidance",
      reason: "Proposed guidance is not active context; text omitted",
    })
    return
  }
  if (entry.path === "AGENTS.md") {
    const parsed = await readDocument(entry, excluded)
    if (!parsed) return
    if (isRestricted(parsed.data)) {
      excluded.push({
        path: entry.path,
        reasonCode: "source.restricted_policy_metadata",
        reason: "Restricted policy metadata; text omitted",
      })
      return
    }
    guidance.push(entry.path)
    return
  }
  if (isExistingWork(entry.path)) {
    existingWork.push(entry.path)
    return
  }
  if (!textExtensions.has(extension(entry.name))) {
    excluded.push({
      path: entry.path,
      reasonCode: "source.unsupported_file_type",
      reason: "Unsupported or binary file type; text not read",
    })
    return
  }
  const isGuidance = isGuidancePath(entry.path)
  const parsed = compatible.has(entry.path)
    ? compatible.get(entry.path)
    : await readDocument(entry, excluded)
  if (!parsed) return
  if (
    restrictedOriginals.has(entry.path) ||
    restrictedOriginals.has(stringValue(parsed.data.original_path) ?? "")
  ) {
    excluded.push({
      path: entry.path,
      reasonCode: "source.restricted_compatible_policy",
      reason: "Restricted compatible policy declaration; original and extraction variants omitted",
    })
    return
  }
  if (entry.name.endsWith(".extracted.md")) {
    const record = await readExtractionSource(context, entry, parsed)
    if (record) sources.push(record)
    return
  }
  if (isRestricted(parsed.data)) {
    excluded.push({
      path: entry.path,
      reasonCode: "source.restricted_policy_metadata",
      reason: "Restricted policy metadata; text omitted",
    })
    return
  }
  const record = courseSourceRecord(entry, parsed, excluded)
  if (!record) return
  if (isGuidance) {
    guidance.push(entry.path)
  } else {
    sources.push(record)
  }
}

function linkCourseSources(root: string, sources: SourceRecord[], notices: NoticeCollector) {
  const approvedPaths = new Set(sources.map((source) => source.path))
  const home = sources.find((source) => source.path === `${root}/00 Home.md`)
  for (const source of sources) {
    const relations = legacyRelations(source, sources, home?.canvasUrl)
    if (relations.length)
      source.relatedPaths = [...new Set([...(source.relatedPaths ?? []), ...relations])]
  }
  for (const imported of sources.filter((item) => item.moduleCanvasId)) {
    const module = sources.find(
      (item) =>
        item.canvasId === imported.moduleCanvasId &&
        /module|session|milestone/i.test(`${item.type} ${item.path}`),
    )
    if (module) module.relatedPaths = [...new Set([...(module.relatedPaths ?? []), imported.path])]
    else
      addNotice(
        notices,
        "source.module_unmatched",
        `Imported source ${imported.path} has no matching course module.`,
        "course",
        "warning",
        imported.path,
      )
  }
  for (const source of sources) {
    for (const related of source.relatedPaths ?? []) {
      const target = related.startsWith(`${root}/`) ? related : `${root}/${related}`
      if (!approvedPaths.has(target)) {
        addNotice(
          notices,
          "source.related_source_unavailable",
          `Skipped unavailable related course source ${target} linked from ${source.path}.`,
          "course",
          "warning",
          target,
        )
      }
    }
  }
  return home
}

async function inspectCourse(
  vault: string,
  code: string,
  notices: NoticeCollector,
  retiredOwnership?: Record<string, string>,
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
        /^(?:Week \d+ - [A-Za-z]{3} \d{1,2}|Milestone \d+(?: - [A-Za-z]{3} \d{1,2})?|Session \d+(?: - [A-Za-z]{3} \d{1,2})?)$/i.test(
          entry.name,
        ),
    )
    .map((entry) => `${root}/${entry.name}`)
    .sort()
  await walk(absoluteRoot, root, entries, notices)
  await filterRetiredSources(entries, root, excluded, retiredOwnership)
  await appendGlobalGuidance(vault, entries)
  const index = await readCourseIndex(root, code, entries, excluded)
  let title = index.title
  if (index.source) sources.push(index.source)
  const compatible = await inspectCompatibleSources(vault, absoluteRoot, entries, excluded)
  const context: CourseInventory = {
    vault,
    root,
    absoluteRoot,
    sources,
    excluded,
    guidance,
    existingWork,
    ...compatible,
  }
  for (const entry of entries) await inspectCourseEntry(context, entry)
  const home = linkCourseSources(root, sources, notices)
  // School Agent does not have canvas-courses.json. Its public navigation file
  // carries the course identity; don't mistake a page/assignment ID for a course ID.
  const canvasId = home?.canvasUrl?.match(/\/courses\/(\d+)\/?(?:[?#].*)?$/)?.[1]
  const canvasCode = home?.text
    .match(/^\s*(?:\*\*Course:\*\*|Course code:)\s*([^\r\n]+)/m)?.[1]
    ?.trim()
  if (title === code && home) title = headingTitle(home.text) ?? title
  return {
    code,
    title,
    root,
    ...(canvasId ? { canvasId } : {}),
    ...(canvasCode ? { canvasCode } : {}),
    sources: sources.sort(byPath),
    excluded: uniqueExcluded(excluded).sort(byPath),
    guidance: guidance.sort(),
    existingWork: [...new Set(existingWork)].sort(),
    periods,
  }
}

/** Resolve only explicit Canvas links against this course's approved inventory. */
function legacyRelations(
  source: SourceRecord,
  sources: SourceRecord[],
  courseUrl?: string,
): string[] {
  const relations = new Set<string>()
  const add = (kind: string, id: string) => {
    for (const target of sources) {
      if (target.path === source.path) continue
      const typed =
        kind === "Page"
          ? target.canvasUrl?.includes("/pages/")
          : kind === "File"
            ? /files?|extraction/i.test(target.type)
            : /assignment/i.test(target.type)
      if (!typed) continue
      if (
        kind === "Page"
          ? target.canvasUrl?.split(/[?#]/)[0]?.endsWith(`/pages/${id}`)
          : target.canvasId === id
      )
        relations.add(target.path)
    }
  }
  for (const match of source.text.matchAll(
    /^- (Page|Assignment|File):[^\r\n]*\((?:canvas_id|page_url):\s*([^\s)]+)\)\s*$/gm,
  ))
    add(match[1] ?? "", match[2] ?? "")
  if (courseUrl) {
    try {
      const owner = new URL(courseUrl)
      const courseId = owner.pathname.match(/^\/courses\/(\d+)\/?$/)?.[1]
      if (courseId)
        for (const match of source.text.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
          try {
            const link = new URL((match[1] ?? "").replaceAll("&amp;", "&"), owner)
            if (link.origin !== owner.origin || link.username || link.password) continue
            const ref = link.pathname.match(
              /^\/(?:api\/v1\/)?courses\/(\d+)\/(pages|assignments|files)\/([^/]+)(?:\/download)?\/?$/,
            )
            if (!ref || ref[1] !== courseId) continue
            add(
              ref[2] === "pages" ? "Page" : ref[2] === "files" ? "File" : "Assignment",
              ref[3] ?? "",
            )
          } catch {
            /* Malformed links are reference data, never executable input. */
          }
        }
    } catch {
      /* Invalid course URLs provide no link scope. */
    }
  }
  return [...relations]
}

async function walk(
  directory: string,
  relativeDirectory: string,
  entries: ScanEntry[],
  notices: NoticeCollector,
): Promise<void> {
  let children: Dirent[]
  try {
    children = await readdir(directory, { withFileTypes: true })
  } catch {
    addNotice(
      notices,
      "workspace.directory_unreadable",
      `Could not read directory: ${relativeDirectory}`,
      "course",
    )
    return
  }
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(directory, child.name)
    const path = `${relativeDirectory}/${child.name}`
    if (child.name.startsWith(".")) {
      addNotice(
        notices,
        "workspace.hidden_entry_skipped",
        `Skipped hidden entry: ${path}`,
        "course",
      )
      continue
    }
    if (child.isSymbolicLink()) {
      addNotice(
        notices,
        "workspace.symlink_skipped",
        `Skipped symbolic link: ${path}`,
        "course",
        "warning",
        path,
      )
      continue
    }
    if (child.isDirectory()) {
      if (child.name === "_meta") {
        addNotice(
          notices,
          "workspace.private_metadata_skipped",
          `Skipped private metadata under: ${relativeDirectory}`,
          "course",
          "info",
        )
        const guidancePath = join(absolute, "guidance")
        try {
          const guidanceStat = await lstat(guidancePath)
          if (guidanceStat.isDirectory() && !guidanceStat.isSymbolicLink()) {
            await walk(guidancePath, `${path}/guidance`, entries, notices)
          } else if (guidanceStat.isSymbolicLink()) {
            addNotice(
              notices,
              "workspace.symlink_skipped",
              `Skipped symbolic link: ${path}/guidance`,
              "course",
              "warning",
              `${path}/guidance`,
            )
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
        reasonCode: "source.file_not_regular_or_too_large",
        reason: "Not a regular text file or exceeds 5 MB text limit; text omitted",
      })
      return null
    }
    bytes = await readFile(entry.absolute)
  } catch {
    excluded.push({
      path: entry.path,
      reasonCode: "source.read_failed",
      reason: "Could not read file",
    })
    return null
  }
  if (bytes.includes(0)) {
    excluded.push({
      path: entry.path,
      reasonCode: "source.binary_content",
      reason: "Binary content; text not read",
    })
    return null
  }
  const text = bytes.toString("utf8")
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    excluded.push({
      path: entry.path,
      reasonCode: "source.invalid_utf8",
      reason: "Invalid UTF-8; text not read",
    })
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
    const data = isRecord(parsed) ? parsed : {}
    if (/\.school-[a-f0-9]{12}\.extracted\.md$/.test(entry.name)) {
      const evidence = await readIngestProvenance(`${entry.absolute}.ingest.json`)
      const provenance = evidence.data
      if (provenance.hash !== createHash("sha256").update(bytes).digest("hex"))
        throw new Error("Compatible provenance is stale")
      const dateMetadata = isRecord(data.dates) ? data.dates.created_at : undefined
      if (provenance.availableAt !== dateMetadata)
        throw new Error("Compatible availability conflicts with the saved document")
      // A companion cannot redirect the unchanged document to another original.
      const originalName = provenance.originalPath.split("/").at(-1)
      const date =
        isRecord(data.dates) && typeof data.dates.date === "string" ? data.dates.date : undefined
      const module = typeof data.module_canvas_id === "string" ? data.module_canvas_id : undefined
      const ending = entry.name.match(/\.school-[a-f0-9]{12}\.extracted\.md$/)?.[0]
      const expectedName = `${originalName}${date ? `.week-${date}` : ""}${provenance.availableAt ? `.as-of-${provenance.availableAt}` : ""}${module ? `.module-${module.replace(/[^a-zA-Z0-9_-]/g, "-")}` : ""}${ending}`
      if (
        !originalName ||
        entry.name !== expectedName ||
        originalName.match(/-([a-f0-9]{12})\.[^./]+$/)?.[1] !==
          provenance.originalHash.slice(0, 12) ||
        entry.path.slice(0, entry.path.lastIndexOf("/")) !==
          provenance.originalPath.slice(0, provenance.originalPath.lastIndexOf("/"))
      )
        throw new Error("Compatible original identity conflicts with the saved document")
      data.original_path = provenance.originalPath
      data.original_hash = provenance.originalHash
      data.ingest_provenance_path = `${entry.path}.ingest.json`
      data.ingest_provenance_hash = evidence.hash
      if (provenance.availableAt) data.available_at = provenance.availableAt
    }
    return {
      bytes,
      data,
      content: text.slice(match[0].length).trim(),
    }
  } catch {
    excluded.push({
      path: entry.path,
      reasonCode: "source.malformed_frontmatter",
      reason: "Malformed frontmatter; text omitted",
    })
    return null
  }
}

function toSource(
  entry: ScanEntry,
  parsed: { bytes: Buffer; data: Record<string, unknown>; content: string },
): SourceRecord {
  const dates = collectDates(parsed.data.dates)
  const dateMetadata = isRecord(parsed.data.dates) ? parsed.data.dates : {}
  const moduleDates =
    isRecord(parsed.data.dates) &&
    /module|session|milestone/i.test(stringValue(parsed.data.type) ?? entry.path)
      ? Object.fromEntries(
          ["unlock_at", "session_at"].flatMap((key) =>
            typeof dateMetadata[key] === "string" ? [[key, dateMetadata[key]]] : [],
          ),
        )
      : {}
  // An ingestion availability suffix is provenance, not a teaching date.
  // Continue recognizing dates in course/session paths and explicit week suffixes.
  const teachingPath = entry.path.replace(
    /\.as-of-\d{4}-\d{2}-\d{2}(?=(?:\.module-[a-zA-Z0-9_-]+)?(?:\.school-[a-f0-9]{12})?\.extracted\.md$)/,
    "",
  )
  for (const match of teachingPath.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) dates.push(match[0])
  return {
    path: entry.path,
    ...(typeof parsed.data.module_position === "number" &&
    Number.isSafeInteger(parsed.data.module_position) &&
    parsed.data.module_position > 0
      ? { modulePosition: parsed.data.module_position }
      : {}),
    title:
      stringValue(parsed.data.title) ??
      (/^00 Prompt\.(?:md|markdown)$/i.test(entry.name)
        ? basename(dirname(entry.path)).replace(/^(?:\d{4}-\d{2}-\d{2}|Undated)\s*-\s*/i, "")
        : null) ??
      headingTitle(parsed.content) ??
      basename(entry.name, extension(entry.name)),
    hash: createHash("sha256").update(parsed.bytes).digest("hex"),
    ...(/\.school-[a-f0-9]{12}\.extracted\.md$/.test(entry.name) &&
    typeof parsed.data.ingest_provenance_path === "string" &&
    typeof parsed.data.ingest_provenance_hash === "string"
      ? {
          ingestProvenance: {
            path: parsed.data.ingest_provenance_path,
            hash: parsed.data.ingest_provenance_hash,
          },
        }
      : {}),
    text: parsed.content,
    type: stringValue(parsed.data.type) ?? inferType(entry.path),
    dates: [...new Set(dates)].sort(),
    ...(Object.keys(moduleDates).length ? { moduleDates } : {}),
    ...(stringValue(parsed.data.canvas_url)
      ? { canvasUrl: stringValue(parsed.data.canvas_url) ?? "" }
      : {}),
    ...(stringValue(parsed.data.original_path)
      ? { originalPath: stringValue(parsed.data.original_path) ?? "" }
      : {}),
    ...(stringValue(parsed.data.original_hash)
      ? { originalHash: stringValue(parsed.data.original_hash) ?? "" }
      : {}),
    ...(stringValue(parsed.data.posted_at)
      ? { postedAt: stringValue(parsed.data.posted_at) ?? "" }
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
  const signalKeys = new Set([
    "date",
    "dates",
    "due",
    "due_at",
    "unlock_at",
    "start_at",
    "end_at",
    "period",
    "class",
    "session",
    "session_at",
  ])
  return Object.entries(value).flatMap(([key, date]) => {
    if (!signalKeys.has(key.toLowerCase())) return []
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
