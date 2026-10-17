import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import { basename, extname, isAbsolute, relative, sep } from "node:path"
import { parse as parseYaml } from "yaml"
import { assignmentRelatedSources, relatedSources } from "../../canvas/module-context.js"
import { restrictedGuidancePaths, selectTaskGuidance } from "../../guidance/selection.js"
import { vaultPath } from "../../shared/fs-safety.js"
import type { CourseContext, SourceRecord } from "../../shared/types.js"
import { isLegacyTaskModuleSource } from "../../vault/source-kind.js"
import { questionText } from "./requirements.js"
import type { AssignmentMode } from "./workflows.js"

function hash(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}
export function mondayDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("Week must be an explicit Monday in YYYY-MM-DD format")
  const date = new Date(`${value}T00:00:00.000Z`)
  if (
    !Number.isFinite(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== value ||
    date.getUTCDay() !== 1
  )
    throw new Error("Week must be a real Monday date in YYYY-MM-DD format")
  return date
}
export function currentMonday(now: Date): string {
  if (!Number.isFinite(now.valueOf())) throw new Error("Current date is invalid")
  // Use the host's local calendar date for the CLI default, then normalize
  // that date to UTC solely for stable YYYY-MM-DD arithmetic.
  const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
  date.setUTCDate(date.getUTCDate() - ((now.getDay() + 6) % 7))
  return date.toISOString().slice(0, 10)
}
export function slug(value: string): string {
  return (
    value
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "session"
  )
}
export function relPath(value: string): string {
  const normalized = value.replaceAll("\\", "/")
  if (
    !normalized ||
    [...normalized].some((char) => char.charCodeAt(0) < 32 || char === "`") ||
    normalized.startsWith("/") ||
    normalized.split("/").some((p) => p === ".." || p === "." || p === "")
  )
    throw new Error(`Unsafe vault-relative path: ${value}`)
  return normalized
}
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
}
export async function noSymlinkPath(
  root: string,
  rel: string,
  allowMissing = false,
): Promise<string> {
  relPath(rel)
  return vaultPath(root, rel, allowMissing)
}

function weekFolders(
  course: CourseContext,
  targetWeek: Date,
): Array<{ path: string; num: number; date?: Date }> {
  const paths = new Set(
    course.sources.map((s) => s.path).concat(course.existingWork, course.periods ?? []),
  )
  const out: Array<{ path: string; num: number; date?: Date }> = []
  for (const path of paths) {
    // Product artifacts cannot become a second authoritative course week.
    if (path.startsWith(`${course.root}/Canvas Agent/Generated/`)) continue
    if (path !== course.root && !path.startsWith(`${course.root}/`)) continue
    const m = path.match(/(?:^|\/)(Week\s+(\d+)\s+-\s+([A-Za-z]{3})\s+(\d{1,2}))(?:\/|$)/i)
    if (!m) continue
    const months = [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ]
    const monthName = m[3]
    const dayText = m[4]
    const weekName = m[1]
    const ordinal = m[2]
    if (!monthName || !dayText || !weekName || !ordinal) continue
    const month = months.indexOf(monthName.toLowerCase())
    const candidate =
      month < 0
        ? undefined
        : new Date(Date.UTC(targetWeek.getUTCFullYear(), month, Number(dayText)))
    const date =
      candidate && candidate.getUTCMonth() === month && candidate.getUTCDate() === Number(dayText)
        ? candidate
        : undefined
    const folder = path.slice(0, path.indexOf(weekName) + weekName.length)
    out.push({ path: folder, num: Number(ordinal), date })
  }
  return [...new Map(out.map((item) => [item.path, item])).values()]
}
function destinationFor(
  course: CourseContext,
  week: Date,
): {
  locationKind: "week-folder" | "fallback-week"
  root?: string
  destination: string
} {
  const folders = weekFolders(course, week)
  const exact = folders.filter(
    (f) => f.date && f.date.toISOString().slice(5, 10) === week.toISOString().slice(5, 10),
  )
  if (exact.length > 1)
    throw new Error("Multiple conventional week folders match the requested date")
  const exactFolder = exact[0]
  if (exactFolder)
    return {
      locationKind: "week-folder",
      root: exactFolder.path,
      destination: `${exactFolder.path}/Prep`,
    }
  return {
    locationKind: "fallback-week",
    destination: `${course.root}/Other/Prep/${week.toISOString().slice(0, 10)}`,
  }
}
export function isPrepOrDraft(path: string): boolean {
  return (
    /(^|\/)(prep|drafts?|proposed)(\/|$)/i.test(path) ||
    /\bprep(?:\s|[-_])?(brief|notes?)\b/i.test(path) ||
    /prep-guidance\.proposed/i.test(path)
  )
}
export function isCourseReference(path: string, courseRoot: string): boolean {
  if (!path.startsWith(`${courseRoot}/`)) return false
  const name = path.slice(courseRoot.length + 1)
  if (/^Resources\/Syllabus\.(md|markdown|txt)$/i.test(name)) return true
  if (name.includes("/")) return false
  const lower = basename(name).toLocaleLowerCase()
  return (
    lower === "00 home.md" ||
    /^syllabus\.(md|markdown|txt)$/.test(lower) ||
    /^(course|course info|course overview|course details|course calendar|calendar)\.(md|markdown|txt)$/.test(
      lower,
    )
  )
}
export function isSyllabusSource(path: string): boolean {
  return /(?:^|\/)syllabus\.(?:md|markdown|txt)$/i.test(path)
}
function isCanvasModuleIndex(source: SourceRecord): boolean {
  return /(?:^|\/)Canvas\/Modules(?:\/|$)/i.test(source.path) || isLegacyTaskModuleSource(source)
}
function hasSubstantiveModuleContent(source: SourceRecord): boolean {
  if (!source.text.trim()) return false
  const normalized = (value: string) =>
    value
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
  const plainText = questionText(source.text)
  if (isCanvasModuleIndex(source) && normalized(plainText) === normalized(source.title))
    return false
  const body = plainText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !/^#{1,6}\s+/.test(line))
    .filter(Boolean)
  if (body.length === 0 || (body.length === 1 && /^\(No text content\.\)$/i.test(body[0] ?? "")))
    return false
  if (
    !isCanvasModuleIndex(source) &&
    source.type !== "navigation" &&
    !/(?:^|\/)00 Overview\.md$/i.test(source.path)
  )
    return true
  if (body.some((line) => !/^(?:[-*+]\s+|\d+[.)]\s+)/.test(line))) return true
  const labels = body.map((line) => line.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "").trim())
  return labels.some((label) => {
    const plain = label
      .replace(/\[[^\]]+\]\([^)]*\)/g, "")
      .replace(/\s+\((?:https?:\/\/|\/)[^)]*\)\s*$/, "")
      .trim()
    if (/[?!.]$/.test(plain)) return true
    // Canvas module item titles alone are pointers. Preserve a full instruction
    // when it can stand on its own, even if the linked material is unavailable.
    return (
      plain.split(/\s+/).length >= 6 &&
      /^(?:read|prepare|discuss|review|complete|watch|listen|bring|compare|analyze|analyse|reflect|consider|answer|write|submit|study|evaluate)\b/i.test(
        plain,
      )
    )
  })
}
function dateInWeek(value: string | undefined, monday: Date): boolean {
  if (!value) return false
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return false
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  const sunday = new Date(monday.valueOf() + 6 * 86_400_000)
  return start >= monday.valueOf() && start <= sunday.valueOf()
}
export function inWeekDates(source: SourceRecord, monday: Date): boolean {
  return source.dates.some((value) => dateInWeek(value, monday)) || dateInWeek(source.dueAt, monday)
}
export function resolvePrepDestination(course: CourseContext, weekValue: string): string {
  return destinationFor(course, mondayDate(weekValue)).destination
}

export function resolvePrepPeriod(
  course: CourseContext,
  period: { kind: "week" | "session"; value: string },
): {
  locationKind: "week-folder" | "session-folder" | "fallback-week" | "fallback-session"
  root?: string
  destination: string
} {
  if (period.kind === "week") return destinationFor(course, mondayDate(period.value))
  const root = resolveSessionRoot(course, period.value)
  const conventional = root !== undefined && /(?:^|\/)(?:Week\s+\d+|Milestone\s+\d+)\b/i.test(root)
  const locationKind = conventional ? "session-folder" : "fallback-session"
  return {
    locationKind,
    ...(root ? { root } : {}),
    destination: conventional
      ? `${root}/Prep`
      : `${course.root}/Other/Prep/session-${slug(period.value)}`,
  }
}

/** Read adapter for the exact unnamespaced week destinations accepted by older task records. */
export function savedWeekPrepLocation(
  courseRoot: string,
  weekValue: string,
  destination: string,
):
  | {
      locationKind: "week-folder" | "fallback-week"
      root?: string
    }
  | undefined {
  if (destination === `${courseRoot}/Other/Prep/${weekValue}`)
    return { locationKind: "fallback-week" }
  const prefix = `${courseRoot}/`
  if (!destination.startsWith(prefix)) return undefined
  const suffix = destination.slice(prefix.length)
  const match = /^Week \d+ - ([A-Za-z]{3}) (\d{1,2})\/Prep$/.exec(suffix)
  if (!match) return undefined
  const months = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ]
  if (
    months.indexOf((match[1] ?? "").toLowerCase()) !== Number(weekValue.slice(5, 7)) - 1 ||
    Number(match[2]) !== Number(weekValue.slice(8, 10))
  )
    return undefined
  return { locationKind: "week-folder", root: `${courseRoot}/${suffix.slice(0, -"/Prep".length)}` }
}
export function selectPrepInputs(
  course: CourseContext,
  periodValue: string | { kind: "week" | "session"; value: string },
  selectionVersion: 1 | 2 = 2,
): { sources: SourceRecord[]; excluded: CourseContext["excluded"] } {
  const period =
    typeof periodValue === "string" ? { kind: "week" as const, value: periodValue } : periodValue
  const targetWeekPath = period.kind === "week" ? prepWeekFolder(course, period.value) : undefined
  let seeds: SourceRecord[]
  if (period.kind === "week") {
    const week = mondayDate(period.value)
    seeds = course.sources.filter(
      (source) =>
        !isPrepOrDraft(source.path) &&
        ((targetWeekPath !== undefined && source.path.startsWith(`${targetWeekPath}/`)) ||
          (selectionVersion === 2 && isCanvasModuleIndex(source)
            ? moduleInWeek(source, course, week)
            : inWeekDates(source, week))),
    )
  } else {
    const anchors = findSessionAnchors(course, period.value)
    if (anchors.length === 0)
      throw new Error(`No readable module or session matches ${period.value}`)
    const identities = new Set(anchors.map(sessionIdentity))
    if (identities.size !== 1)
      throw new Error(`Session ${period.value} is ambiguous across matching modules`)
    seeds = relatedSources(course, anchors)
    resolveSessionRoot(course, period.value)
  }
  // Course references provide useful framing, but must never turn a period with
  // no readable class material into a successful preparation handoff.
  const references = course.sources.filter((source) => isCourseReference(source.path, course.root))
  const sources = relatedSources(course, [...seeds, ...references]).filter(
    (source) => !isPrepOrDraft(source.path),
  )
  const sourceSet = new Set(sources.map((source) => source.path))
  const excluded = course.excluded.filter(
    (item) =>
      sourceSet.has(item.path) ||
      (targetWeekPath !== undefined && item.path.startsWith(`${targetWeekPath}/`)),
  )
  return { sources, excluded }
}

function moduleInWeek(source: SourceRecord, course: CourseContext, monday: Date): boolean {
  const inWindow = (value: string | undefined) =>
    value !== undefined &&
    Number.isFinite(Date.parse(value)) &&
    Date.parse(value) >= monday.valueOf() &&
    Date.parse(value) < monday.valueOf() + 7 * 86_400_000
  const effective = source.moduleDates?.unlock_at ?? source.moduleDates?.session_at
  if (source.moduleDates ? inWindow(effective) : inWeekDates(source, monday)) return true
  const paths = new Set(
    (source.relatedPaths ?? []).map((path) =>
      path.startsWith(`${course.root}/`) ? path : `${course.root}/${path}`,
    ),
  )
  return course.sources.some(
    (item) =>
      /^assignments?(?:\.md)?$/i.test(item.type) &&
      (paths.has(item.path) ||
        (source.canvasId !== undefined && item.moduleCanvasId === source.canvasId)) &&
      inWindow(item.dueAt),
  )
}

/** Selection rule used only to keep reading and completing saved 0.2 task records. */
export function selectLegacyPrepInputs(
  course: CourseContext,
  weekValue: string,
): { sources: SourceRecord[]; excluded: CourseContext["excluded"] } {
  const week = mondayDate(weekValue)
  const folder = prepWeekFolder(course, weekValue)
  const sources = course.sources.filter(
    (source) =>
      !isPrepOrDraft(source.path) &&
      ((folder !== undefined && source.path.startsWith(`${folder}/`)) ||
        inWeekDates(source, week) ||
        isCourseReference(source.path, course.root)),
  )
  const selected = new Set(sources.map((source) => source.path))
  const excluded = course.excluded.filter(
    (item) =>
      selected.has(item.path) || (folder !== undefined && item.path.startsWith(`${folder}/`)),
  )
  return { sources, excluded }
}

export function prepWeekFolder(course: CourseContext, weekValue: string): string | undefined {
  const period = resolvePrepPeriod(course, { kind: "week", value: weekValue })
  return period.locationKind === "week-folder" ? period.root : undefined
}

function findSessionAnchors(course: CourseContext, value: string): SourceRecord[] {
  const normalized = value.trim()
  const id = normalized.replace(/^session\s+/i, "")
  const canonical = normalized.toLocaleLowerCase().replace(/\.[^.]+$/, "")
  return course.sources.filter((source) => {
    if (isPrepOrDraft(source.path)) return false
    const isModule =
      isLegacyTaskModuleSource(source) ||
      /(?:^|\/)(?:modules?|milestones?|sessions?)(?:\/|$)/i.test(source.path)
    if (!isModule) return false
    const dateMatches =
      /^\d{4}-\d{2}-\d{2}$/.test(normalized) &&
      [...source.dates, ...(source.dueAt ? [source.dueAt] : [])].some(
        (date) => date.slice(0, 10) === normalized,
      )
    const pathParts = source.path
      .split("/")
      .map((part) => part.replace(/\.[^.]+$/, "").toLocaleLowerCase())
    return (
      source.canvasId === normalized ||
      source.moduleCanvasId === normalized ||
      source.canvasId === id ||
      (/^\d+$/.test(id) &&
        new RegExp(`^(?:session|milestone)\\s+0*${id}(?:\\b|\\s*[-:])`, "i").test(source.title)) ||
      source.title.replace(/\.[^.]+$/, "").toLocaleLowerCase() === canonical ||
      pathParts.includes(canonical) ||
      dateMatches
    )
  })
}

function sessionRoot(courseRoot: string, source: SourceRecord): string {
  const parts = source.path.split("/")
  const index = parts.findIndex((part) => /^(?:Week|Milestone)\s+\d+\b/i.test(part))
  if (index >= 0) return parts.slice(0, index + 1).join("/")
  return source.path.slice(0, source.path.lastIndexOf("/")) || courseRoot
}
function sessionIdentity(source: SourceRecord): string {
  // Legacy page snapshots inherit their owning module's session/date metadata.
  // Multiple pages belonging to that same module are one session, not ambiguity.
  return source.moduleCanvasId ?? source.canvasId ?? source.path
}
export function resolveSessionRoot(course: CourseContext, value: string): string {
  const anchors = findSessionAnchors(course, value)
  if (anchors.length === 0) throw new Error(`No readable module or session matches ${value}`)
  if (new Set(anchors.map(sessionIdentity)).size !== 1)
    throw new Error(`Session ${value} is ambiguous across matching modules`)
  const roots = new Set(anchors.map((source) => sessionRoot(course.root, source)))
  if (roots.size !== 1) throw new Error(`Session ${value} is ambiguous across module locations`)
  const root = [...roots][0]
  if (!root) throw new Error(`Session ${value} has no selected module location`)
  return root
}
export async function verifySourceSnapshot(
  vault: string,
  source: SourceRecord,
): Promise<SourceRecord> {
  const path = await noSymlinkPath(vault, source.path)
  const bytes = await readFile(path)
  if (hash(bytes) !== source.hash)
    throw new Error(`Source changed while creating task: ${source.path}`)
  if (bytes.includes(0) || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes))
    throw new Error(`Source is no longer safe UTF-8 text: ${source.path}`)
  if (source.ingestProvenance) {
    if (source.ingestProvenance.path !== `${source.path}.ingest.json`)
      throw new Error("Invalid compatible provenance scope")
    const { readIngestProvenance } = await import("../../documents/ingest-compatibility.js")
    const companion = await noSymlinkPath(vault, source.ingestProvenance.path)
    if ((await readIngestProvenance(companion)).hash !== source.ingestProvenance.hash)
      throw new Error("Compatible source provenance changed since snapshot")
  }
  if (source.originalPath || source.originalHash) {
    if (!source.originalPath || !source.originalHash)
      throw new Error(`Incomplete original-source integrity metadata: ${source.path}`)
    const original = await noSymlinkPath(vault, source.originalPath)
    const originalInfo = await lstat(original)
    if (!originalInfo.isFile() || originalInfo.size > 50 * 1024 * 1024)
      throw new Error(`Original source is not a bounded regular file: ${source.originalPath}`)
    const originalBytes = await readFile(original)
    if (hash(originalBytes) !== source.originalHash)
      throw new Error(`Original source changed since extraction: ${source.originalPath}`)
  }
  return { ...source }
}
export async function readGuidanceSnapshot(
  vault: string,
  sourcePath: string,
  identityVersion?: 1,
  identityOnly = false,
): Promise<SourceRecord> {
  if (identityOnly && !identityVersion)
    throw new Error("Guidance identity inspection requires a version")
  const path = await noSymlinkPath(vault, sourcePath)
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024)
    throw new Error("Guidance must be a bounded regular text file")
  const bytes = await readFile(path)
  if (bytes.includes(0) || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes))
    throw new Error(`Guidance is not safe UTF-8 text: ${sourcePath}`)
  const original = bytes.toString("utf8")
  let text = original
  let metadata: Record<string, unknown> = {}
  try {
    const match = original.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/)
    if (match) {
      const parsed: unknown = parseYaml(match[1] ?? "")
      if (
        parsed !== null &&
        parsed !== undefined &&
        (typeof parsed !== "object" || Array.isArray(parsed))
      )
        throw new Error("Frontmatter must be a mapping")
      metadata = (parsed ?? {}) as Record<string, unknown>
      text = original.slice(match[0].length).trim()
    } else if (/^---(?:\s*\r?\n|$)/.test(original)) throw new Error("Unterminated frontmatter")
  } catch {
    throw new Error(`Guidance metadata is malformed: ${sourcePath}`)
  }
  for (const value of identityOnly
    ? []
    : [metadata.ai_policy, metadata.policy, metadata.redistribution]) {
    if (value === undefined || value === null || value === "") continue
    const policy = String(value)
      .trim()
      .toLocaleLowerCase()
      .replace(/[\s-]+/g, "_")
    if (!["allowed", "allow", "permitted"].includes(policy))
      throw new Error(`Guidance has restricted or unknown policy metadata: ${sourcePath}`)
  }
  let canvasId: string | undefined, canvasUrl: string | undefined
  if (
    identityVersion &&
    metadata.canvas_id !== undefined &&
    metadata.canvas_id !== null &&
    metadata.canvas_id !== ""
  ) {
    if (
      (typeof metadata.canvas_id !== "string" && typeof metadata.canvas_id !== "number") ||
      (typeof metadata.canvas_id === "number" && !Number.isSafeInteger(metadata.canvas_id)) ||
      !/^[1-9]\d{0,39}$/.test(String(metadata.canvas_id))
    )
      throw new Error("Guidance Canvas identity is invalid")
    canvasId = String(metadata.canvas_id)
  }
  if (
    identityVersion &&
    metadata.canvas_url !== undefined &&
    metadata.canvas_url !== null &&
    metadata.canvas_url !== ""
  ) {
    try {
      if (typeof metadata.canvas_url !== "string" || metadata.canvas_url.length > 2000)
        throw new Error("Invalid URL")
      const url = new URL(metadata.canvas_url)
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error("Invalid URL")
      url.search = ""
      url.hash = ""
      canvasUrl = url.href
    } catch {
      throw new Error("Guidance Canvas URL is invalid")
    }
  }
  return {
    path: sourcePath,
    title: basename(path, extname(path)),
    hash: hash(bytes),
    text: identityOnly ? "" : text,
    type: "guidance",
    dates: [],
    ...(canvasId ? { canvasId } : {}),
    ...(canvasUrl ? { canvasUrl } : {}),
  }
}

export async function readSelectedGuidance(
  vault: string,
  paths: string[],
  kind: "prep" | "assignment",
  prompt?: SourceRecord,
  explicitPaths: string[] = [],
  restrictedPaths: string[] = [],
): Promise<SourceRecord[]> {
  const inventory = [...new Set([...paths, ...restrictedPaths])]
  if (inventory.length > 500) throw new Error("Guidance identity inventory exceeds 500 files")
  const identities = await Promise.all(
    inventory.map((path) => readGuidanceSnapshot(vault, path, 1, true)),
  )
  const selected = selectTaskGuidance(kind, identities, prompt, explicitPaths)
  if (selected.some((identity) => restrictedPaths.includes(identity.path)))
    throw new Error(
      "Selected guidance is excluded by policy; review it before creating or completing work",
    )
  return Promise.all(
    selected.map(async (identity) => {
      const snapshot = await readGuidanceSnapshot(vault, identity.path, 1)
      if (snapshot.hash !== identity.hash)
        throw new Error("Guidance changed during identity selection; retry with current evidence")
      return snapshot
    }),
  )
}

async function explicitSource(
  course: CourseContext,
  vault: string,
  value: string,
): Promise<SourceRecord> {
  const clean = relPath(value)
  if (
    !clean.startsWith(`${course.root}/`) ||
    isPrepOrDraft(clean) ||
    /(^|\/)_(?:meta|private)(\/|$)/i.test(clean)
  )
    throw new Error(`Assignment source is not an approved course source: ${value}`)
  const source = course.sources.find((item) => item.path === clean)
  if (!source) {
    const excluded = course.excluded.find((item) => item.path === clean)
    throw new Error(
      excluded
        ? `Assignment source is restricted or unreadable: ${clean} (${excluded.reason})`
        : `Assignment source is not an approved readable course source: ${clean}`,
    )
  }
  return verifySourceSnapshot(vault, source)
}

async function explicitWork(
  course: CourseContext,
  vault: string,
  value: string,
  revisionSource?: SourceRecord,
): Promise<SourceRecord> {
  const clean = relPath(value)
  if (
    !clean.startsWith(`${course.root}/`) ||
    !/\.(?:md|markdown|txt)$/i.test(clean) ||
    /(^|\/)_(?:meta|private)(\/|$)/i.test(clean) ||
    /(^|\/)(?:credentials?|secrets?|passwords?|tokens?)(?:\.[^/]*)?$/i.test(clean) ||
    clean.split("/").some((part) => part.startsWith("."))
  )
    throw new Error(
      `Student work must be readable Markdown or text within an existing-work folder: ${value}`,
    )
  const allowed =
    course.existingWork.includes(clean) &&
    /(^|\/)drafts?(\/|$)/i.test(clean.slice(course.root.length))
  if (revisionSource) {
    if (revisionSource.path !== clean || revisionSource.type !== "student-work")
      throw new Error("Revision source does not match the explicitly approved student-work path")
    const verified = await verifySourceSnapshot(vault, revisionSource)
    const stored = await readFile(await noSymlinkPath(vault, clean), "utf8")
    if (verified.text !== stored)
      throw new Error("Approved revision source snapshot text was modified")
    return verified
  }
  if (!allowed) throw new Error(`Student work is not in an approved existing-work folder: ${clean}`)
  const file = await noSymlinkPath(vault, clean)
  const info = await lstat(file)
  if (!info.isFile() || info.size > 5 * 1024 * 1024)
    throw new Error(`Student work is not a regular text file: ${clean}`)
  const bytes = await readFile(file)
  if (bytes.includes(0) || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes))
    throw new Error(`Student work is not safe UTF-8 text: ${clean}`)
  const text = bytes.toString("utf8")
  let body = text
  let metadata: Record<string, unknown> = {}
  try {
    const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/)
    if (match) {
      const parsed: unknown = parseYaml(match[1] ?? "")
      if (
        parsed !== null &&
        parsed !== undefined &&
        (typeof parsed !== "object" || Array.isArray(parsed))
      )
        throw new Error()
      metadata = (parsed ?? {}) as Record<string, unknown>
      body = text.slice(match[0].length).trim()
    } else if (/^---(?:\s*\r?\n|$)/.test(text)) throw new Error()
  } catch {
    throw new Error(`Student work metadata is malformed: ${clean}`)
  }
  for (const value of [metadata.ai_policy, metadata.policy, metadata.redistribution]) {
    if (value === undefined || value === null || value === "") continue
    const policy = String(value)
      .trim()
      .toLocaleLowerCase()
      .replace(/[\s-]+/g, "_")
    if (!["allowed", "allow", "permitted"].includes(policy))
      throw new Error(`Student work has restricted or unknown policy metadata: ${clean}`)
  }
  return {
    path: clean,
    title: basename(file, extname(file)),
    hash: hash(bytes),
    text: body,
    type: "student-work",
    dates: [],
  }
}

/** Policy-checked existing Drafts text for migration and explicit student-work inputs. */
export async function readStudentWork(
  vault: string,
  course: CourseContext,
  path: string,
): Promise<SourceRecord> {
  return explicitWork(course, vault, path)
}

/** Exact prompt selection shared by draft and the School Agent homework shortcut. */
export function selectAssignmentPrompt(course: CourseContext, queryValue: string): SourceRecord {
  const query = queryValue.trim().toLowerCase()
  if (!query) throw new Error("Assignment selector cannot be empty")
  const assignments = course.sources.filter((source) =>
    /^assignments?(?:\.md)?$/i.test(source.type),
  )
  const matches = assignments.filter((source) =>
    [source.path, source.title, source.canvasId].some((value) => value?.toLowerCase() === query),
  )
  if (matches.length !== 1)
    throw new Error(
      matches.length > 1
        ? `Assignment selector is ambiguous: ${queryValue}`
        : `No assignment prompt matches ${queryValue}. Available: ${assignments.map((source) => `${source.title} (${source.canvasId ?? source.path})`).join("; ")}`,
    )
  const found = matches[0]
  if (!found) throw new Error("Assignment prompt selection failed")
  return found
}

function isAssignmentReference(path: string, courseRoot: string): boolean {
  if (!path.startsWith(`${courseRoot}/`) || isPrepOrDraft(path)) return false
  return (
    isCourseReference(path, courseRoot) ||
    /(?:^|\/)[^/]*syllabus[^/]*\.(?:md|markdown|txt)$/i.test(path) ||
    /(^|\/)(?:references?|reading list)(\/|$)/i.test(path.slice(courseRoot.length + 1))
  )
}

export function hasPrepMaterial(course: CourseContext, sources: SourceRecord[]): boolean {
  return sources.some(
    (source) =>
      !isCourseReference(source.path, course.root) &&
      !isSyllabusSource(source.path) &&
      hasSubstantiveModuleContent(source),
  )
}

export interface SelectAssignmentInputsOptions {
  course: CourseContext
  sourcePath: string
  workPath?: string
  contextPaths?: string[]
  revisionSource?: SourceRecord
  guidanceSelectionVersion?: 1
}

export async function selectAssignmentInputs(
  vault: string,
  options: SelectAssignmentInputsOptions,
): Promise<{
  sources: SourceRecord[]
  guidance: SourceRecord[]
  context: string[]
  excluded: CourseContext["excluded"]
}> {
  const {
    course,
    sourcePath,
    workPath,
    contextPaths = [],
    revisionSource,
    guidanceSelectionVersion,
  } = options
  const prompt = await explicitSource(course, vault, sourcePath)
  const uniqueContext = [...new Set(contextPaths.map(relPath))].filter(
    (path) => path !== prompt.path && path !== workPath,
  )
  const contextSources: SourceRecord[] = []
  const contextGuidance: string[] = []
  for (const path of uniqueContext) {
    if (course.guidance.includes(path)) {
      contextGuidance.push(path)
      continue
    }
    if (
      course.existingWork.includes(path) &&
      /(^|\/)drafts?(\/|$)/i.test(path.slice(course.root.length))
    )
      contextSources.push(await explicitWork(course, vault, path))
    else contextSources.push(await explicitSource(course, vault, path))
  }
  const promptRecord = course.sources.find((source) => source.path === prompt.path)
  const linked = promptRecord
    ? assignmentRelatedSources(course, promptRecord, uniqueContext).filter(
        (source) => source.path !== prompt.path,
      )
    : []
  const linkedSources: SourceRecord[] = []
  for (const source of linked) {
    if (isPrepOrDraft(source.path) || contextSources.some((item) => item.path === source.path))
      continue
    linkedSources.push(await explicitSource(course, vault, source.path))
  }
  const references = course.sources
    .filter((source) => isAssignmentReference(source.path, course.root))
    .filter(
      (source) =>
        source.path !== prompt.path && !contextSources.some((item) => item.path === source.path),
    )
    .filter((source) => !linkedSources.some((item) => item.path === source.path))
    .sort((a, b) => a.path.localeCompare(b.path))
  const selectedSources = [
    prompt,
    ...contextSources,
    ...linkedSources,
    ...(await Promise.all(references.map((source) => verifySourceSnapshot(vault, source)))),
  ]
  if (workPath) selectedSources.push(await explicitWork(course, vault, workPath, revisionSource))
  const context = [
    ...new Set([
      ...contextSources.map((source) => source.path),
      ...linkedSources.map((source) => source.path),
      ...references.map((source) => source.path),
      ...contextGuidance,
    ]),
  ]
  const guidance: SourceRecord[] = []
  if (guidanceSelectionVersion)
    guidance.push(
      ...(await readSelectedGuidance(
        vault,
        course.guidance,
        "assignment",
        prompt,
        contextGuidance,
        restrictedGuidancePaths(course),
      )),
    )
  else for (const path of course.guidance) guidance.push(await readGuidanceSnapshot(vault, path))
  const guidanceLike = (path: string) =>
    path === "AGENTS.md" || /(^|\/)AGENTS\.md$/i.test(path) || /(^|\/)guidance\//i.test(path)
  const relevantPaths = new Set([prompt.path, ...context, ...(workPath ? [workPath] : [])])
  const excluded = course.excluded.filter(
    (item) =>
      relevantPaths.has(item.path) ||
      isAssignmentReference(item.path, course.root) ||
      guidanceLike(item.path),
  )
  return { sources: selectedSources, guidance, context, excluded }
}

export function validateDiscussionMessage(
  mode: AssignmentMode | undefined,
  discussionMessage?: string,
) {
  if (mode === "discuss") {
    if (
      !discussionMessage?.trim() ||
      Buffer.byteLength(discussionMessage) > 12_000 ||
      discussionMessage.includes("\0")
    )
      throw new Error("Discussion requires a non-empty question under 12 KB")
    if (
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~-]{16,}|(?:api[_-]?key|access[_-]?token|canvas[_-]?token|password|secret)\s*[:=]\s*\S+)/i.test(
        discussionMessage,
      )
    )
      throw new Error(
        "Discussion question appears to contain credentials; remove them before creating a task",
      )
    if (
      Object.entries(process.env).some(
        ([name, value]) =>
          /token|secret|password|credential|api[_-]?key/i.test(name) &&
          value &&
          value.length >= 8 &&
          discussionMessage.includes(value),
      )
    )
      throw new Error(
        "Discussion question contains a known local credential; remove it before creating a task",
      )
  } else if (discussionMessage !== undefined)
    throw new Error("Student inquiry is supported only in discussion mode")
}

/** Re-derive the authoritative selected inputs for a saved task recipe. */
export async function deriveCurrentTaskInputs(
  vault: string,
  course: CourseContext,
  task: import("../../shared/types.js").TaskRecord,
): Promise<
  | Awaited<ReturnType<typeof selectAssignmentInputs>>
  | { sources: SourceRecord[]; excluded: CourseContext["excluded"] }
> {
  if (task.kind === "assignment") {
    const assignment = task.assignment
    if (!assignment) throw new Error("Assignment task metadata is missing")
    return selectAssignmentInputs(vault, {
      course,
      sourcePath: assignment.source,
      ...(assignment.work ? { workPath: assignment.work } : {}),
      contextPaths: assignment.context,
      ...(task.parentTaskId
        ? { revisionSource: task.sources.find((source) => source.path === assignment.work) }
        : {}),
      ...(task.guidanceSelectionVersion
        ? { guidanceSelectionVersion: task.guidanceSelectionVersion }
        : {}),
    })
  }
  const period =
    task.period ?? (task.week ? { kind: "week" as const, value: task.week } : undefined)
  if (!period) throw new Error("Preparation task is missing its period")
  return (!task.workflow || task.workflow.version === 1) && period.kind === "week"
    ? selectLegacyPrepInputs(course, period.value)
    : selectPrepInputs(course, period, task.prepSelectionVersion ?? 1)
}
