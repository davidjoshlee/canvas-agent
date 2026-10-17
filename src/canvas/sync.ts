import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { canvasSubjectHash, guardSyncSubject } from "../auth/sync-subject.js"
import { extractText } from "../documents/content.js"
import {
  feedbackDirectory,
  feedbackHash,
  nextFeedbackSnapshot,
  normalizeOwnFeedback,
  readFeedbackSnapshotRecord,
  validateFeedbackArchive,
  validateFeedbackObservations,
} from "../feedback/history.js"
import { assertNoSymlinks } from "../shared/fs-safety.js"
import type { ToolkitConfig } from "../shared/types.js"
import { inspectSchoolLayout } from "../vault/school-layout.js"
import { assertNoPreservationMigration } from "../vault/write-guard.js"
import { captureAssignmentDates } from "./assignment-dates.js"
import { assignmentGroupCategory } from "./assignment-group.js"
import { assignmentRubricHtml, renderAssignmentRubric } from "./assignment-rubric.js"
import { type CanvasClient, CanvasHttpError, createCanvasClient } from "./client.js"
import { parseSessionTitle, resolveSessionYear } from "./session-dates.js"

type Obj = Record<string, unknown>

function base(config: ToolkitConfig): URL {
  const url = new URL(config.canvas.baseUrl)
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Unsafe Canvas base URL")
  return url
}
function apiUrl(root: URL, path: string): URL {
  return new URL(`/api/v1/${path.replace(/^\//, "")}`, root)
}
export function isCanvasUnauthorized(error: unknown): boolean {
  return error instanceof CanvasHttpError && error.status === 401
}
export interface CourseSyncOutcome {
  courseId: string
  code?: string
  root?: string
  status: "synced" | "failed" | "unavailable"
  written: number
  notices: number
  errorKind?: "http-error" | "resource-error"
  httpStatus?: number
}
export interface SyncReport {
  courses: number
  written: string[]
  notices: string[]
  courseReports?: CourseSyncOutcome[]
  failedCourses?: number
}
export class CanvasSyncPartialError extends Error {
  constructor(readonly report: SyncReport) {
    super(
      "Selected-course sync had failures; remaining selected courses were attempted. Inspect courseReports and retry the failed course explicitly.",
    )
  }
}
function unavailable(error: unknown): error is CanvasHttpError {
  return error instanceof CanvasHttpError && [403, 404].includes(error.status)
}

export function isCanvasDiscoveryUnavailable(error: unknown): boolean {
  return unavailable(error)
}
function requireValidAuth(error: unknown): void {
  if (error instanceof CanvasHttpError && error.status === 401) throw error
}
async function jsonObject(response: Response): Promise<Obj> {
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new Error("Canvas returned invalid resource JSON; no response body was echoed")
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Canvas returned an unexpected resource object; no body was echoed")
  return value as Obj
}
const get = (client: CanvasClient, url: URL) => client.get(url)
const list = (client: CanvasClient, url: URL) => client.list(url)
export async function listCourses(
  config: ToolkitConfig,
  includeConcluded = false,
  client: CanvasClient = createCanvasClient(config),
): Promise<Array<{ id: string; code: string; name: string }>> {
  const root = base(config)
  const rows = await list(client, apiUrl(root, "courses?per_page=100&include[]=term"))
  if (includeConcluded) rows.push(...(await listConcludedCourses(config, client)))
  return [
    ...new Map(
      rows.map((c) => [
        String(c.id),
        {
          id: String(c.id),
          code: String(c.course_code ?? c.id),
          name: String(c.name ?? c.course_code ?? c.id),
        },
      ]),
    ).values(),
  ]
}

/** Completed enrollment discovery is explicit; never automatically selects courses. */
export async function listConcludedCourses(
  config: ToolkitConfig,
  client: CanvasClient = createCanvasClient(config),
): Promise<Obj[]> {
  return list(
    client,
    apiUrl(
      base(config),
      "courses?enrollment_state=completed&state[]=completed&per_page=100&include[]=term",
    ),
  )
}

/** Explicit unresolved pilot only: retain no submission bodies or probe responses. */
export async function probeUnresolvedPilotCourse(
  config: ToolkitConfig,
  id: string,
  client: CanvasClient = createCanvasClient(config),
) {
  if (!/^[1-9]\d*$/.test(id)) throw new Error("Pilot course needs an exact numeric Canvas ID")
  let metadata: Obj = { id }
  try {
    const response = await get(client, apiUrl(base(config), `courses/${id}`))
    const bytes = await readBounded(response, 1_000_000, 10_000)
    if (!bytes) throw new Error("Pilot course metadata exceeds bounds")
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    } catch {
      throw new Error("Pilot course metadata is invalid; no body was echoed")
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      String((value as Obj).id) !== id
    )
      throw new Error("Pilot course identity was not verified")
    metadata = value as Obj
  } catch (error) {
    if (!unavailable(error)) throw error
  }
  let assignments: Obj[]
  try {
    assignments = await list(client, apiUrl(base(config), `courses/${id}/assignments?per_page=100`))
  } catch (error) {
    if (!unavailable(error)) throw error
    throw new Error("Explicit pilot assignment history is unavailable")
  }
  if (assignments.length > 1000) throw new Error("Pilot assignment inventory exceeds 1000 entries")
  const dates = assignments.flatMap((assignment) => {
    const value = assignment.due_at ?? assignment.created_at
    const time = typeof value === "string" ? Date.parse(value) : NaN
    return Number.isFinite(time) ? [time] : []
  })
  const dateSpanDays = dates.length > 1 ? (Math.max(...dates) - Math.min(...dates)) / 86_400_000 : 0
  if (dateSpanDays < 14)
    throw new Error("Unresolved pilot needs at least 14 days of assignment date span")
  for (const assignmentId of new Set(
    assignments
      .map((assignment) => String(assignment.id))
      .filter((value) => /^[1-9]\d*$/.test(value)),
  )) {
    try {
      const response = await get(
        client,
        apiUrl(
          base(config),
          `courses/${id}/assignments/${assignmentId}/submissions/self?include[]=rubric_assessment`,
        ),
      )
      const bytes = await readBounded(response, 1_000_000, 10_000)
      if (!bytes) throw new Error("Pilot own-feedback response exceeds bounds")
      let raw: unknown
      try {
        raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      } catch {
        throw new Error("Pilot own-feedback response is invalid; no body was saved")
      }
      const feedback = normalizeOwnFeedback(raw, id, assignmentId)
      if (feedback.score !== null || feedback.rubric.length)
        return {
          id,
          code: String(metadata.course_code ?? id),
          name: String(metadata.name ?? metadata.course_code ?? `Course ${id}`),
          dateSpanDays,
          gradedAssignmentId: assignmentId,
        }
    } catch (error) {
      if (!unavailable(error)) throw error
    }
  }
  throw new Error("Unresolved pilot needs a non-null own-submission score or rubric assessment")
}

/** Validate the configured token without returning identity or profile data. */
async function verifiedSubjectHash(
  config: ToolkitConfig,
  client: CanvasClient = createCanvasClient(config),
): Promise<string> {
  const response = await get(client, apiUrl(base(config), "users/self"))
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Canvas returned no user profile; authorization was not verified")
  const chunks: Uint8Array[] = []
  let subject = ""
  let size = 0,
    timedOut = false,
    complete = false
  const timer = setTimeout(() => {
    timedOut = true
    void reader.cancel().catch(() => undefined)
  }, 10_000)
  timer.unref()
  try {
    for (;;) {
      const chunk = await reader.read()
      if (timedOut) throw new Error()
      if (chunk.done) {
        complete = true
        break
      }
      size += chunk.value.byteLength
      if (size > 256 * 1024) throw new Error()
      chunks.push(chunk.value)
    }
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    )
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    const profile = value as Obj
    if (!Object.hasOwn(profile, "id") || !Object.hasOwn(profile, "name")) throw new Error()
    const validId =
      typeof profile.id === "number"
        ? Number.isSafeInteger(profile.id) && profile.id > 0
        : typeof profile.id === "string" && /^[1-9]\d{0,99}$/.test(profile.id)
    if (!validId || typeof profile.name !== "string" || profile.name.length > 4096)
      throw new Error()
    subject = String(profile.id)
  } catch {
    throw new Error(
      `Canvas returned HTTP ${response.status} but not a valid bounded user profile; authorization was not verified. Check the configured Canvas API host or institutional sign-in requirements.`,
    )
  } finally {
    clearTimeout(timer)
    if (!complete) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return canvasSubjectHash(base(config).origin, subject)
}

export async function verifyAuth(
  config: ToolkitConfig,
  client: CanvasClient = createCanvasClient(config),
): Promise<{ ok: true }> {
  await verifiedSubjectHash(config, client)
  return { ok: true }
}

/** Return only active courses for onboarding; listCourses remains the discovery API. */
export async function listActiveCourses(
  config: ToolkitConfig,
  client: CanvasClient = createCanvasClient(config),
): Promise<Array<{ id: string; code: string; name: string }>> {
  const rows = await list(
    client,
    apiUrl(base(config), "users/self/courses?enrollment_state=active&per_page=100&include[]=term"),
  )
  return [
    ...new Map(
      rows
        .filter((c) => c.workflow_state == null || c.workflow_state === "available")
        .map((c) => [
          String(c.id),
          {
            id: String(c.id),
            code: String(c.course_code ?? c.id),
            name: String(c.name ?? c.course_code ?? c.id),
          },
        ]),
    ).values(),
  ]
}

const safeSegment = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "untitled"
function canonicalRoot(code: string): string {
  const termCode = code.match(/^[A-Z]\d{2}-([A-Z]{2,12})-(\d{2,4}[A-Z]?)(?:-\d{1,3})?$/i)
  if (termCode) return `${termCode[1]}${termCode[2]}`.toUpperCase()
  const conventional = code.match(/^([A-Z]{2,12})[-_ ]?(\d{2,4}[A-Z]?)$/i)
  if (conventional) return `${conventional[1]}${conventional[2]}`.toUpperCase()
  return safeSegment(code).replace(/[-_ ]/g, "").toUpperCase()
}
function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}
type SyncState = { version: 1; origin?: string; files: Record<string, string> }
class CanvasOriginMismatch extends Error {}
async function guardCanvasOrigin(vault: string, origin: string, reserve = false): Promise<void> {
  const path = join(vault, "_meta", "canvas-origin.json")
  await assertNoSymlinks(path, true)
  let bytes: string
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > 4096)
      throw new CanvasOriginMismatch(
        "Canvas origin reservation is unsafe; inspect it or choose a separate vault.",
      )
    bytes = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    if (!reserve) return
    await safeMkdir(vault, dirname(path))
    await assertNoSymlinks(path, true)
    try {
      await writeFile(path, JSON.stringify({ version: 1, origin }), { flag: "wx", mode: 0o600 })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      return guardCanvasOrigin(vault, origin)
    }
  }
  let value: unknown
  try {
    value = JSON.parse(bytes)
  } catch {
    /* Generic error below never echoes private state. */
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "origin,version" ||
    (value as Obj).version !== 1 ||
    (value as Obj).origin !== origin
  )
    throw new CanvasOriginMismatch(
      "Canvas server differs from the vault's origin reservation or its binding is invalid; choose a separate vault. No existing coursework or feedback was changed.",
    )
}
type Managed = {
  vault: string
  subjectHash: string
  state: SyncState
  trusted: boolean
  stateHash?: string
  written: string[]
  notices: string[]
}
function relativeVault(vault: string, path: string): string {
  const value = relative(vault, path).split(sep).join("/")
  if (!value || value === ".." || value.startsWith("../") || isAbsolute(value))
    throw new Error("Canvas output path escapes the vault")
  return value
}
async function safeMkdir(_vault: string, path: string): Promise<void> {
  await assertNoSymlinks(path, true)
  await mkdir(path, { recursive: true })
  await assertNoSymlinks(path)
}
async function managedWrite(
  manager: Managed,
  path: string,
  bytes: Buffer | string,
  privateMode = false,
): Promise<boolean> {
  await assertNoPreservationMigration(manager.vault)
  const key = relativeVault(manager.vault, path)
  await assertNoSymlinks(path, true)
  await safeMkdir(manager.vault, dirname(path))
  let current: Buffer | undefined
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Canvas output is not a regular file: ${key}`)
    if (privateMode && info.mode & 0o077)
      throw new Error("Own feedback output is not private; it was preserved")
    current = await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (current && sha(current) === sha(bytes)) return false
  if (current && (!manager.trusted || manager.state.files[key] !== sha(current))) {
    manager.notices.push(
      `Preserved changed or untracked file ${key}; Canvas updates were not applied.`,
    )
    return false
  }
  await assertNoSymlinks(path, true)
  if (!current) {
    try {
      await writeFile(path, bytes, { flag: "wx", ...(privateMode ? { mode: 0o600 } : {}) })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        manager.notices.push(`Preserved concurrently created file ${key}.`)
        return false
      }
      throw error
    }
  } else {
    const tempPath = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(tempPath, bytes, { flag: "wx", ...(privateMode ? { mode: 0o600 } : {}) })
      await assertNoSymlinks(path)
      if (sha(await readFile(path)) !== manager.state.files[key]) {
        manager.notices.push(`Preserved concurrently edited file ${key}.`)
        return false
      }
      await rename(tempPath, path)
    } finally {
      try {
        await unlink(tempPath)
      } catch {
        /* renamed or absent */
      }
    }
  }
  manager.state.files[key] = sha(bytes)
  manager.written.push(path)
  return true
}
async function loadSyncState(
  vault: string,
  notices: string[],
  origin: string,
): Promise<{ state: SyncState; trusted: boolean; stateHash?: string }> {
  const path = join(vault, "_meta", "canvas-sync-state.json")
  await assertNoSymlinks(path, true)
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Sync state is not a regular file")
    const raw = await readFile(path, "utf8"),
      parsed = JSON.parse(raw)
    if (
      parsed.version !== 1 ||
      !parsed.files ||
      typeof parsed.files !== "object" ||
      Array.isArray(parsed.files)
    )
      throw new Error("Sync state has an unsupported format")
    if (parsed.origin !== undefined) {
      let canonicalOrigin: string | undefined
      try {
        canonicalOrigin = new URL(parsed.origin).origin
      } catch {
        // An invalid saved binding must not fall through to an untrusted fresh state.
      }
      if (typeof parsed.origin !== "string" || canonicalOrigin !== parsed.origin)
        throw new CanvasOriginMismatch(
          "Canvas sync origin binding is invalid; existing vault was preserved. Inspect it or choose a separate vault.",
        )
      if (parsed.origin !== origin)
        throw new CanvasOriginMismatch(
          "Canvas server differs from this vault's sync binding; choose a separate vault. No existing coursework or feedback was changed.",
        )
    } else if (Object.keys(parsed.files).length)
      notices.push(
        "Legacy sync state has no verified server binding. This first configured-origin binding protects future syncs only; historical feedback/account ownership remains unverified.",
      )
    return {
      state: { version: 1, origin, files: parsed.files },
      trusted: true,
      stateHash: sha(raw),
    }
  } catch (error) {
    if (error instanceof CanvasOriginMismatch) throw error
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      notices.push("Canvas sync state could not be trusted; existing files will be preserved.")
    return {
      state: { version: 1, origin, files: {} },
      trusted: (error as NodeJS.ErrnoException).code === "ENOENT",
    }
  }
}
async function saveSyncState(manager: Managed): Promise<void> {
  if (!manager.trusted) return
  try {
    await assertNoPreservationMigration(manager.vault)
  } catch {
    manager.notices.push(
      "Preservation migration lock prevented ownership-state refresh; partial files were retained for review",
    )
    return
  }
  const path = join(manager.vault, "_meta", "canvas-sync-state.json")
  await safeMkdir(manager.vault, dirname(path))
  await assertNoSymlinks(path, true)
  const bytes = `${JSON.stringify(manager.state, null, 2)}\n`
  try {
    const current = await readFile(path)
    if (!manager.stateHash || sha(current) !== manager.stateHash) {
      manager.notices.push(
        "Preserved changed Canvas sync state; concurrent or manual changes were not overwritten.",
      )
      return
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || manager.stateHash) {
      manager.notices.push(
        "Preserved changed Canvas sync state; concurrent or manual changes were not overwritten.",
      )
      return
    }
  }
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, bytes, { flag: "wx" })
  try {
    await assertNoSymlinks(path, true)
    try {
      const current = await readFile(path)
      if (!manager.stateHash || sha(current) !== manager.stateHash) {
        manager.notices.push(
          "Preserved changed Canvas sync state; concurrent or manual changes were not overwritten.",
        )
        return
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || manager.stateHash) {
        manager.notices.push(
          "Preserved changed Canvas sync state; concurrent or manual changes were not overwritten.",
        )
        return
      }
    }
    await rename(tempPath, path)
    manager.stateHash = sha(bytes)
  } finally {
    try {
      await unlink(tempPath)
    } catch {
      /* renamed or absent */
    }
  }
}
function cleanHtml(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
      (_match, level, content) => `\n${"#".repeat(Number(level))} ${content}\n`,
    )
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<\/?[a-z][a-z0-9:-]*(?:\s[^>]*)?\/?\s*>/gi, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
function textOf(html: unknown): string {
  return cleanHtml(typeof html === "string" ? html : "")
}
function markdown(
  title: string,
  source: Obj,
  body: string,
  fields: Record<string, unknown> = {},
): string {
  const dateFields = Object.fromEntries(
    Object.entries(fields).filter(
      ([key, value]) =>
        ([
          "due_at",
          "unlock_at",
          "published_at",
          "posted_at",
          "session_at",
          "lock_at",
          "start_at",
          "end_at",
          "created_at",
          "updated_at",
        ].includes(key) &&
          typeof value === "string" &&
          /^\d{4}-\d{2}-\d{2}T/.test(value)) ||
        (key === "session_at" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)),
    ),
  )
  if (Object.keys(dateFields).length && !fields.dates) fields = { ...fields, dates: dateFields }
  const front = {
    title,
    canvas_id: String(source.id ?? ""),
    canvas_url: typeof source.html_url === "string" ? source.html_url : "",
    ...fields,
  }
  const yaml = Object.entries(front)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n")
  return `---\n${yaml}\n---\n\n# ${title}\n\n${body || "(No text content.)"}\n`
}
function linkedFileIds(html: unknown): string[] {
  if (typeof html !== "string") return []
  const ids = new Set<string>()
  for (const match of html.matchAll(/(?:\/files\/|files%2[fF])([0-9]+)(?=\/|\?|&|#|["'\s]|$)/g))
    if (match[1]) ids.add(match[1])
  return [...ids]
}
type SyncedCourse = {
  id: string
  code: string
  name: string
  root: string
  syncNamespace?: "Canvas Agent"
}

/** Per-course ownership and source relationships accumulated in sync order. */
interface CourseSync {
  course: SyncedCourse
  manager: Managed
  client: CanvasClient
  vault: string
  courseRoot: string
  root: URL
  prefix: string
  contentPaths: Map<string, string>
  referencedFileIds: Set<string>
  sourceReferences: Array<{ path: string; ids: string[] }>
  assignmentDeadlines: unknown[]
  feedbackAssignmentIds: string[]
}

async function syncCourseOverview(context: CourseSync, explicitPilot: boolean) {
  const { client, root, manager, course, courseRoot } = context
  let courseInfo: Obj
  try {
    courseInfo = await jsonObject(
      await get(
        client,
        apiUrl(
          root,
          `courses/${encodeURIComponent(course.id)}?include[]=syllabus_body&include[]=term`,
        ),
      ),
    )
    if (String(courseInfo.id) !== course.id)
      throw new Error("Selected course metadata identity does not match the requested course")
  } catch (error) {
    if (!explicitPilot || !unavailable(error)) throw error
    courseInfo = { id: course.id, course_code: course.code, name: course.name }
    manager.notices.push(
      `Pilot course ${course.id} metadata/syllabus is unavailable (HTTP ${error.status}); only independently accessible resources are synced.`,
    )
  }
  const metadataPath = join(courseRoot, "00 Home.md")
  const metadata = markdown(
    course.name,
    courseInfo,
    [
      `Canvas course ID: ${course.id}`,
      `Course code: ${course.code}`,
      courseInfo.start_at ? `Starts: ${courseInfo.start_at}` : "",
      courseInfo.end_at ? `Ends: ${courseInfo.end_at}` : "",
      courseInfo.time_zone ? `Time zone: ${courseInfo.time_zone}` : "",
      courseInfo.public_description ? textOf(courseInfo.public_description) : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    Object.fromEntries(
      ["start_at", "end_at"].filter((k) => courseInfo[k]).map((k) => [k, courseInfo[k]]),
    ),
  )
  await managedWrite(manager, metadataPath, metadata)
  const syllabusIds = linkedFileIds(courseInfo.syllabus_body)
  if (courseInfo.syllabus_body)
    await managedWrite(
      manager,
      join(courseRoot, "Resources", "Syllabus.md"),
      markdown("Syllabus", courseInfo, textOf(courseInfo.syllabus_body), {
        raw_html_file_ids: syllabusIds,
      }),
    )
  return { courseInfo, syllabusIds }
}

async function optionalCourseList(
  context: CourseSync,
  endpoint: string,
  label: string,
): Promise<Obj[]> {
  const { client, root, prefix, manager, course } = context
  try {
    return await list(client, apiUrl(root, `${prefix}/${endpoint}`))
  } catch (error) {
    if (!unavailable(error)) throw error
    manager.notices.push(
      `Canvas ${label} unavailable for ${course.code} (HTTP ${error.status}); continuing with accessible module-linked content. Coverage may be incomplete.`,
    )
    return []
  }
}

async function syncCourseContent(
  context: CourseSync,
  endpoint: string,
  folder: string,
  getTitle: (v: Obj) => string,
  getText: (v: Obj) => string,
  supplied?: Obj[],
) {
  const {
    client,
    root,
    prefix,
    manager,
    course,
    vault,
    courseRoot,
    assignmentDeadlines,
    feedbackAssignmentIds,
    referencedFileIds,
    sourceReferences,
    contentPaths,
  } = context
  const values =
    supplied ??
    (endpoint === "pages"
      ? await optionalCourseList(context, "pages?per_page=100", "Pages list")
      : await list(
          client,
          apiUrl(
            root,
            `${prefix}/${endpoint}?per_page=100${endpoint === "assignments" ? "&include[]=all_dates&override_assignment_dates=true" : ""}`,
          ),
        ))
  for (const value of values) {
    if (endpoint === "assignments") assignmentDeadlines.push(value.due_at)
    if (endpoint === "assignments" && /^[1-9]\d*$/.test(String(value.id)))
      feedbackAssignmentIds.push(String(value.id))
    let source = value
    if (endpoint === "pages" && typeof value.body !== "string" && typeof value.url === "string") {
      try {
        source = await jsonObject(
          await get(client, apiUrl(root, `${prefix}/pages/${encodeURIComponent(value.url)}`)),
        )
      } catch (error) {
        if (!unavailable(error)) throw error
        manager.notices.push(
          `Canvas page unavailable for ${course.code} (HTTP ${error.status}); coverage may be incomplete.`,
        )
        continue
      }
    }
    const title = getTitle(source),
      identity = endpoint === "pages" ? (source.page_id ?? source.id) : source.id,
      path = join(
        courseRoot,
        "Canvas",
        folder,
        `${safeSegment(title)}-${safeSegment(String(identity ?? "item"))}.md`,
      )
    const fields: Record<string, unknown> = {}
    if (endpoint === "assignments") fields.assignment_dates = captureAssignmentDates(source)
    if (endpoint === "quizzes") fields.type = "quizzes"
    const rawHtml = endpoint === "pages" ? source.body : source.description
    const fileIds = [
      ...new Set([
        ...linkedFileIds(rawHtml),
        ...(endpoint === "assignments"
          ? assignmentRubricHtml(source.rubric).flatMap(linkedFileIds)
          : []),
      ]),
    ]
    for (const fileId of fileIds) referencedFileIds.add(fileId)
    if (fileIds.length) sourceReferences.push({ path, ids: fileIds })
    if (endpoint === "pages") {
      const pageUrl = typeof value.url === "string" ? value.url : source.url
      if (typeof pageUrl === "string")
        contentPaths.set(`pages:url:${pageUrl}`, relativeVault(vault, path))
      if (identity != null)
        contentPaths.set(`pages:${String(identity)}`, relativeVault(vault, path))
    } else if (identity != null)
      contentPaths.set(`${endpoint}:${String(identity)}`, relativeVault(vault, path))
    for (const key of [
      "due_at",
      "unlock_at",
      "published_at",
      "posted_at",
      "lock_at",
      "start_at",
      "end_at",
      "created_at",
      "updated_at",
    ])
      if (source[key]) fields[key] = source[key]
    await managedWrite(
      manager,
      path,
      markdown(title, { ...source, id: identity ?? source.id }, getText(source), fields),
    )
  }
}

async function collectCourseModules(context: CourseSync) {
  const { referencedFileIds, contentPaths } = context
  const modules = await optionalCourseList(
    context,
    "modules?include[]=items&per_page=100",
    "Modules list",
  )
  const modulePages = new Set<string>()
  for (const module of modules) {
    if (!Array.isArray(module.items) && module.id != null)
      module.items = await optionalCourseList(
        context,
        `modules/${encodeURIComponent(String(module.id))}/items?per_page=100`,
        "module items",
      )
    for (const item of Array.isArray(module.items) ? (module.items as Obj[]) : []) {
      if (item.type === "File" && item.content_id != null)
        referencedFileIds.add(String(item.content_id))
      if (
        item.type === "Page" &&
        typeof item.page_url === "string" &&
        !contentPaths.has(`pages:url:${item.page_url}`)
      )
        modulePages.add(item.page_url)
    }
  }
  await syncCourseContent(
    context,
    "pages",
    "Pages",
    (v) => String(v.title ?? v.url ?? `Page ${v.id}`),
    (v) => textOf(v.body),
    [...modulePages].map((url) => ({ url })),
  )
  return modules
}

async function syncCourseFiles(context: CourseSync) {
  const { client, root, manager, course, vault, courseRoot, referencedFileIds, contentPaths } =
    context
  const files = await optionalCourseList(context, "files?per_page=100", "Files list")
  const knownFileIds = new Set(files.map((file) => String(file.id)))
  for (const fileId of referencedFileIds) {
    if (knownFileIds.has(fileId)) continue
    try {
      const response = await get(client, apiUrl(root, `files/${encodeURIComponent(fileId)}`))
      const metadata = await jsonObject(response)
      if (String(metadata.id) === fileId) files.push(metadata)
    } catch (error) {
      requireValidAuth(error)
      manager.notices.push(
        `Could not retrieve metadata for linked Canvas file ${fileId} in ${course.code}.`,
      )
    }
  }
  for (const file of files) {
    const filename = String(file.filename ?? file.display_name ?? `file-${file.id}`)
    const id = safeSegment(String(file.id ?? "file"))
    const target = join(courseRoot, "Canvas", "Files", `${id}-${safeSegment(filename)}`)
    if (file.locked || file.hidden || file.locked_for_user || file.hidden_for_user || !file.url) {
      manager.notices.push(`Skipped inaccessible Canvas file ${filename} in ${course.code}.`)
      continue
    }
    const url = typeof file.url === "string" ? new URL(file.url, root) : undefined
    if (!url || (url.origin !== root.origin && !(await client.publicHttpsUrl(url)))) {
      manager.notices.push(`Skipped external or unsafe Canvas file ${filename} in ${course.code}.`)
      continue
    }
    try {
      const response = await client.download(url)
      const bytes = await readBounded(response, 50 * 1024 * 1024)
      if (!bytes) {
        manager.notices.push(`Skipped Canvas file over 50 MB: ${filename}.`)
        continue
      }
      await managedWrite(manager, target, bytes)
      const extracted = await extractText({
        bytes,
        filename,
        contentType: typeof file.content_type === "string" ? file.content_type : null,
      })
      if (extracted.notice)
        manager.notices.push(`Could not extract ${filename}: ${extracted.notice}.`)
      if (extracted.text) {
        const retained = await readFile(target).catch(() => undefined)
        if (retained && sha(retained) === sha(bytes)) {
          const sidecar = `${target}.extracted.md`
          const content = markdown(filename, file, extracted.text, {
            original_path: relativeVault(vault, target),
            original_hash: sha(bytes),
            ...Object.fromEntries(
              ["unlock_at", "published_at", "posted_at", "created_at", "updated_at"]
                .filter((key) => file[key])
                .map((key) => [key, file[key]]),
            ),
          })
          await managedWrite(manager, sidecar, content)
          if (file.id != null)
            contentPaths.set(`files:${String(file.id)}`, relativeVault(vault, sidecar))
        }
      }
    } catch (error) {
      requireValidAuth(error)
      manager.notices.push(`Could not download Canvas file ${filename} in ${course.code}.`)
    }
  }
}

async function linkExtractedCourseFiles(context: CourseSync) {
  const { manager, course, sourceReferences, contentPaths } = context
  for (const ref of sourceReferences) {
    const paths = ref.ids
      .map((id) => contentPaths.get(`files:${id}`))
      .filter((p): p is string => Boolean(p))
    for (const id of ref.ids)
      if (!contentPaths.has(`files:${id}`))
        manager.notices.push(
          `Linked Canvas file ${id} has no extracted text source in ${course.code}.`,
        )
    if (!paths.length) continue
    const source = await readFile(ref.path, "utf8").catch(() => "")
    if (!source.startsWith("---\n")) continue
    const end = source.indexOf("\n---\n", 4)
    if (end < 0) continue
    const front = source.slice(4, end)
    const updated =
      front.replace(/\nrelated_paths:.*(?=\n|$)/, "") +
      `\nrelated_paths: ${JSON.stringify([...new Set(paths)])}`
    await managedWrite(manager, ref.path, `---\n${updated}\n---${source.slice(end + 4)}`)
  }
}

async function syncOwnFeedback(context: CourseSync) {
  const { client, root, prefix, manager, course, vault, feedbackAssignmentIds } = context
  if (feedbackAssignmentIds.length > 1000)
    throw new Error("Own-feedback assignment inventory exceeds 1000 entries")
  for (const assignmentId of [...new Set(feedbackAssignmentIds)]) {
    try {
      const response = await get(
        client,
        apiUrl(
          root,
          `${prefix}/assignments/${assignmentId}/submissions/self?include[]=rubric_assessment&include[]=submission_comments`,
        ),
      )
      const bytes = await readBounded(response, 1_000_000, 10_000)
      if (!bytes) throw new Error("Own feedback response exceeds 1 MB")
      let raw: unknown
      try {
        raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      } catch {
        throw new Error("Own feedback response was invalid JSON; no response body was saved")
      }
      if (
        raw &&
        typeof raw === "object" &&
        !Array.isArray(raw) &&
        Object.hasOwn(raw, "user_id") &&
        canvasSubjectHash(root.origin, (raw as Obj).user_id) !== manager.subjectHash
      )
        throw new Error(
          "Own feedback response does not match the verified Canvas API subject; no feedback payload was saved",
        )
      const data = normalizeOwnFeedback(raw, course.id, assignmentId)
      const directory = feedbackDirectory(vault, course.id, assignmentId)
      await assertNoSymlinks(directory, true)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await assertNoSymlinks(directory)
      if ((await lstat(directory)).mode & 0o077)
        throw new Error("Own feedback directory is not private")
      const dataHash = feedbackHash(data)
      const currentPath = join(directory, "current.json")
      const previous = await readFeedbackSnapshotRecord(currentPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      })
      const snapshot = nextFeedbackSnapshot(data, previous)
      if (previous) await validateFeedbackObservations(directory, previous)
      await managedWrite(manager, join(directory, `${dataHash}.json`), JSON.stringify(data), true)
      await validateFeedbackArchive(directory, dataHash)
      await managedWrite(manager, currentPath, JSON.stringify(snapshot), true)
    } catch (error) {
      requireValidAuth(error)
      if (!unavailable(error)) throw error
      manager.notices.push(
        `Own feedback unavailable for assignment ${assignmentId} in ${course.code} (HTTP ${error.status}); cached feedback may be absent or stale.`,
      )
    }
  }
}

async function writeCourseModules(context: CourseSync, courseInfo: Obj, modules: Obj[]) {
  const { manager, course, courseRoot, assignmentDeadlines, contentPaths } = context
  const sessionYear = resolveSessionYear(
    { ...courseInfo, course_code: courseInfo.course_code ?? course.code },
    assignmentDeadlines,
  )
  for (const value of modules) {
    const title = String(value.name ?? `Module ${value.id}`)
    const session = parseSessionTitle(title, sessionYear.year)
    if (session.reason)
      manager.notices.push(
        `Module ${String(value.id ?? "unknown")} in ${course.code} has ${session.reason} session-date evidence; no teaching date was inferred.`,
      )
    const relatedPaths: string[] = []
    const items = Array.isArray(value.items)
      ? value.items
          .map((i: Obj) => {
            const type =
              i.type === "Assignment"
                ? "assignments"
                : i.type === "Page"
                  ? "pages"
                  : i.type === "File"
                    ? "files"
                    : i.type === "Quiz"
                      ? "quizzes"
                      : ""
            const related =
              i.type === "Page" && typeof i.page_url === "string"
                ? contentPaths.get(`pages:url:${i.page_url}`)
                : type && i.content_id != null
                  ? contentPaths.get(`${type}:${String(i.content_id)}`)
                  : undefined
            if (related) relatedPaths.push(related)
            return `- ${String(i.title ?? i.type ?? "Item")}${related ? ` (${related})` : i.html_url ? ` (${i.html_url})` : ""}`
          })
          .join("\n")
      : ""
    const path = join(
      courseRoot,
      "Canvas",
      "Modules",
      `${safeSegment(title)}-${safeSegment(String(value.id ?? "item"))}.md`,
    )
    await managedWrite(
      manager,
      path,
      markdown(title, value, items, {
        type: "modules",
        ...(session.date
          ? {
              session_at: session.date,
              session_date_source: `module-title-v1/${session.yearSource === "title-year" ? "title-year" : sessionYear.source}`,
            }
          : {}),
        ...(typeof value.position === "number" &&
        Number.isSafeInteger(value.position) &&
        value.position > 0
          ? { module_position: value.position }
          : {}),
        ...(relatedPaths.length ? { related_paths: [...new Set(relatedPaths)] } : {}),
        ...Object.fromEntries(
          ["unlock_at", "start_at", "end_at", "created_at", "updated_at"]
            .filter((k) => value[k])
            .map((k) => [k, value[k]]),
        ),
      }),
    )
  }
}

async function syncCourseDiscussions(context: CourseSync) {
  const { client, root, prefix, manager, course, courseRoot } = context
  try {
    const topics = await list(client, apiUrl(root, `${prefix}/discussion_topics?per_page=100`))
    for (const topic of topics) {
      const title = String(topic.title ?? `Discussion ${topic.id}`)
      const path = join(
        courseRoot,
        "Canvas",
        "Discussions",
        `${safeSegment(title)}-${safeSegment(String(topic.id ?? "item"))}.md`,
      )
      await managedWrite(
        manager,
        path,
        markdown(title, topic, textOf(topic.message), {
          ...Object.fromEntries(
            ["due_at", "unlock_at", "lock_at", "posted_at"]
              .filter((key) => topic[key])
              .map((key) => [key, topic[key]]),
          ),
        }),
      )
    }
  } catch (error) {
    requireValidAuth(error)
    manager.notices.push(
      `Canvas discussion topics were unavailable for ${course.code}; continuing without them.`,
    )
  }
  try {
    const announcements = await list(
      client,
      apiUrl(root, `${prefix}/discussion_topics?only_announcements=true&per_page=100`),
    )
    for (const announcement of announcements) {
      const title = String(announcement.title ?? `Announcement ${announcement.id}`)
      const path = join(
        courseRoot,
        "Canvas",
        "Announcements",
        `${safeSegment(title)}-${safeSegment(String(announcement.id ?? "item"))}.md`,
      )
      await managedWrite(
        manager,
        path,
        markdown(title, announcement, textOf(announcement.message), {
          ...Object.fromEntries(
            ["posted_at", "delayed_post_at", "lock_at"]
              .filter((key) => announcement[key])
              .map((key) => [key, announcement[key]]),
          ),
        }),
      )
    }
  } catch (error) {
    requireValidAuth(error)
    manager.notices.push(
      `Canvas announcements were unavailable for ${course.code}; continuing without them.`,
    )
  }
}

async function syncOne(
  config: ToolkitConfig,
  course: SyncedCourse,
  manager: Managed,
  explicitPilot = false,
  client: CanvasClient = createCanvasClient(config),
): Promise<void> {
  const vault = manager.vault
  const courseRoot = resolve(vault, course.root, course.syncNamespace ?? "")
  if (!courseRoot.startsWith(vault + sep)) throw new Error("Course code resolves outside the vault")
  await safeMkdir(vault, courseRoot)
  const context: CourseSync = {
    course,
    manager,
    client,
    vault,
    courseRoot,
    root: base(config),
    prefix: `courses/${encodeURIComponent(course.id)}`,
    contentPaths: new Map(),
    referencedFileIds: new Set(),
    sourceReferences: [],
    assignmentDeadlines: [],
    feedbackAssignmentIds: [],
  }
  const { courseInfo, syllabusIds } = await syncCourseOverview(context, explicitPilot)
  context.referencedFileIds = new Set(syllabusIds)
  await syncCourseContent(
    context,
    "assignments",
    "Assignments",
    (v) => String(v.name ?? `Assignment ${v.id}`),
    (v) =>
      [
        v.description && textOf(v.description),
        assignmentGroupCategory(v.group_category_id)
          ? `Group category: ${assignmentGroupCategory(v.group_category_id)}`
          : "",
        v.due_at ? `Due: ${v.due_at}` : "",
        v.points_possible != null ? `Points: ${v.points_possible}` : "",
        Array.isArray(v.attachments) && v.attachments.length
          ? `Attachments: ${v.attachments
              .map((attachment: Obj) =>
                String(attachment.display_name ?? attachment.filename ?? "Canvas attachment"),
              )
              .join(", ")}`
          : "",
        renderAssignmentRubric(v.rubric, cleanHtml),
      ]
        .filter(Boolean)
        .join("\n\n"),
  )
  await syncCourseContent(
    context,
    "pages",
    "Pages",
    (v) => String(v.title ?? v.url ?? `Page ${v.id}`),
    (v) => textOf(v.body),
  )
  const modules = await collectCourseModules(context)
  await syncCourseContent(
    context,
    "quizzes",
    "Quizzes",
    (value) => String(value.title ?? `Quiz ${value.id}`),
    (value) => textOf(value.description),
    await optionalCourseList(context, "quizzes?per_page=100", "Quizzes list"),
  )
  await syncCourseFiles(context)
  if (syllabusIds.length)
    context.sourceReferences.push({
      path: join(courseRoot, "Resources", "Syllabus.md"),
      ids: syllabusIds,
    })
  await linkExtractedCourseFiles(context)
  await syncOwnFeedback(context)
  await writeCourseModules(context, courseInfo, modules)
  await syncCourseDiscussions(context)
}
async function readBounded(
  response: Response,
  maxBytes: number,
  timeoutMs?: number,
): Promise<Buffer | undefined> {
  if (
    response.headers.get("content-length") &&
    Number(response.headers.get("content-length")) > maxBytes
  )
    return
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let length = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = timeoutMs
    ? new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Canvas response body timed out; partial content was not saved"))
          void reader.cancel().catch(() => undefined)
        }, timeoutMs)
      })
    : undefined
  try {
    while (true) {
      const { done, value } = await (deadline
        ? Promise.race([reader.read(), deadline])
        : reader.read())
      if (done) break
      length += value.byteLength
      if (length > maxBytes) {
        await reader.cancel()
        return
      }
      chunks.push(value)
    }
    return Buffer.concat(
      chunks.map((c) => Buffer.from(c)),
      length,
    )
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type SyncPilot = { id: string; code: string; name: string }
type CourseManifest = { version: number; courses: Obj[] }

async function discoverSelectedCourses(
  config: ToolkitConfig,
  client: CanvasClient,
  notices: string[],
  pilot?: SyncPilot,
) {
  let all: Obj[]
  try {
    all = await list(client, apiUrl(base(config), "courses?per_page=100&include[]=term"))
  } catch (error) {
    if (!unavailable(error)) throw error
    all = []
    notices.push(
      `Course discovery is unavailable (HTTP ${error.status}); resolving only explicitly allowlisted course IDs. This is a coverage gap, not failed API authentication.`,
    )
  }
  if (pilot && !all.some((course) => String(course.id) === pilot.id))
    all.push({ id: pilot.id, course_code: pilot.code, name: pilot.name })
  const allow = new Set(config.courses.allowlist.map(String))
  const courseReports: CourseSyncOutcome[] = []
  const failures: unknown[] = []
  // A concluded allowlisted course may be absent from the default active listing.
  // Resolve only the student's explicit IDs, never broaden to unrelated courses.
  for (const id of allow) {
    if (all.some((course) => String(course.id) === id)) continue
    if (!/^[1-9]\d*$/.test(id)) throw new Error("Sync allowlist needs numeric Canvas course IDs")
    try {
      const value: unknown = await jsonObject(
        await get(client, apiUrl(base(config), `courses/${id}?include[]=term`)),
      )
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        String((value as Obj).id) !== id
      )
        throw new Error("Selected course response has an invalid or mismatched identity")
      all.push(value as Obj)
    } catch (error) {
      if (isCanvasUnauthorized(error)) throw error
      if (!unavailable(error)) {
        if (allow.size === 1) throw error
        failures.push(error)
        courseReports.push({
          courseId: id,
          status: "failed",
          written: 0,
          notices: 0,
          errorKind: error instanceof CanvasHttpError ? "http-error" : "resource-error",
          ...(error instanceof CanvasHttpError ? { httpStatus: error.status } : {}),
        })
        notices.push(
          `Selected course ${id} identity retrieval failed; other selected courses were attempted. No response/error body was echoed.`,
        )
        continue
      }
      notices.push(
        `Allowlisted course ${id} is unavailable (HTTP ${error.status}); its existing files were preserved.`,
      )
      courseReports.push({
        courseId: id,
        status: "unavailable",
        written: 0,
        notices: 1,
        httpStatus: error.status,
      })
    }
  }
  const courses = [
    ...new Map(
      all
        .filter((c) => allow.has(String(c.id)))
        .map(
          (c) =>
            [
              String(c.id),
              {
                id: String(c.id),
                code: String(c.course_code ?? c.id),
                name: String(c.name ?? c.course_code ?? c.id),
              },
            ] as const,
        ),
    ).values(),
  ]
  return { courses, allow, courseReports, failures }
}

async function readCourseManifest(vault: string, notices: string[]) {
  const manifestPath = join(vault, "_meta", "canvas-courses.json")
  await assertNoSymlinks(vault, true)
  await assertNoSymlinks(manifestPath, true)
  let previous: { version: number; courses: Obj[] } = { version: 1, courses: [] }
  try {
    const info = await lstat(manifestPath)
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Canvas course manifest is not a regular file")
    previous = JSON.parse(await readFile(manifestPath, "utf8")) as {
      version: number
      courses: Obj[]
    }
    if (previous.version !== 1 || !Array.isArray(previous.courses))
      throw new Error("Canvas course manifest has an unsupported format")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      notices.push("Canvas course manifest could not be parsed; preserving it.")
      previous = { version: 1, courses: [] }
    }
  }
  return { manifestPath, previous }
}

async function resolveCourseMappings(
  vault: string,
  courses: Array<{ id: string; code: string; name: string }>,
  previous: CourseManifest,
  notices: string[],
  preserveSchool?: boolean,
) {
  const prior = new Map<string, Obj>(previous.courses.map((c: Obj) => [String(c.id), c]))
  const merged: Obj[] = []
  for (const course of courses) {
    const old = prior.get(course.id)
    if (old?.syncNamespace !== undefined && old.syncNamespace !== "Canvas Agent")
      throw new Error(
        "Unsupported Canvas product namespace; inspect the course mapping before sync",
      )
    let root =
      typeof old?.root === "string" && old.root === safeSegment(old.root)
        ? old.root
        : canonicalRoot(course.code)
    if (!old?.root) {
      const rawRoot = safeSegment(course.code)
      if (
        rawRoot !== root &&
        !rawRoot.startsWith(".") &&
        !rawRoot.startsWith("_") &&
        !rawRoot.includes("/") &&
        !rawRoot.includes("\\")
      ) {
        try {
          const canonicalInfo = await lstat(join(vault, root)).catch(() => null)
          const rawInfo = await lstat(join(vault, rawRoot)).catch(() => null)
          if (!canonicalInfo?.isDirectory() && rawInfo?.isDirectory() && !rawInfo.isSymbolicLink())
            root = rawRoot
        } catch {
          /* path validation below reports unsafe roots */
        }
      }
    }
    merged.push({
      ...old,
      ...course,
      root,
      ...(preserveSchool ? { syncNamespace: "Canvas Agent" } : {}),
    })
    if (preserveSchool)
      notices.push(
        `Separate Canvas product namespace selected for ${course.code}; School files are not converted or deleted. Existing root-level Canvas artifacts still require review before shared writing is certified.`,
      )
  }
  return merged
}

async function validateCourseMappings(
  vault: string,
  courses: Array<{ id: string; code: string; name: string }>,
  previous: CourseManifest,
  merged: Obj[],
  stateResult: Awaited<ReturnType<typeof loadSyncState>>,
): Promise<void> {
  const roots = merged.map((c) => String(c.root))
  if (new Set(roots.map((r) => r.toLocaleLowerCase())).size !== roots.length)
    throw new Error("Canvas course-root collision; sync stopped before writing")
  for (const course of merged) {
    if (
      previous.courses.some(
        (old: Obj) =>
          String(old.id) !== String(course.id) &&
          String(old.root ?? canonicalRoot(String(old.code ?? ""))).toLocaleLowerCase() ===
            String(course.root).toLocaleLowerCase(),
      )
    ) {
      throw new Error(
        "Canvas course-root collision with an existing mapping; choose a separate term vault",
      )
    }
  }
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index] ?? ""
    const raw = courses.find((c) => c.id === String(merged[index]?.id))?.code ?? root
    if (
      !root ||
      raw.startsWith(".") ||
      raw.startsWith("_") ||
      root.toLocaleLowerCase() === "_meta" ||
      root.startsWith(".") ||
      root.includes("/") ||
      root.includes("\\") ||
      root === "." ||
      root === ".."
    )
      throw new Error(`Reserved or unsafe Canvas course root: ${root}`)
    if (resolve(vault, root) === vault || !resolve(vault, root).startsWith(vault + sep))
      throw new Error(`Canvas course root escapes the vault: ${root}`)
    await assertNoSymlinks(join(vault, root), true)
    if (merged[index]?.syncNamespace) {
      await assertNoSymlinks(join(vault, root, "Canvas Agent"), true)
      const home = join(vault, root, "00 Home.md")
      const owned = stateResult.state.files[`${root}/00 Home.md`]
      if (owned) {
        await assertNoSymlinks(home, true)
        const retained = await readFile(home).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
          throw error
        })
        if (retained && sha(retained) === owned)
          throw new Error(
            "Existing root-level Canvas-owned Home requires reviewed migration before School coexistence; preserve it and use a separate testing vault. No documents were moved or converted",
          )
      }
    }
  }
}

async function publishCourseManifest(
  manager: Managed,
  manifestPath: string,
  previous: CourseManifest,
  merged: Obj[],
): Promise<void> {
  const { vault } = manager
  // The course manifest is toolkit-owned metadata. A valid pre-existing manifest is merged by Canvas ID.
  if (previous.courses.length && !manager.state.files[relativeVault(vault, manifestPath)]) {
    try {
      manager.state.files[relativeVault(vault, manifestPath)] = sha(await readFile(manifestPath))
    } catch {
      /* new manifest */
    }
  }
  const manifestCourses = new Map<string, Obj>(previous.courses.map((c: Obj) => [String(c.id), c]))
  for (const course of merged) manifestCourses.set(String(course.id), course)
  const manifest = `${JSON.stringify({ version: 1, courses: [...manifestCourses.values()] }, null, 2)}\n`
  await managedWrite(manager, manifestPath, manifest)
}

async function syncSelectedCourses(
  config: ToolkitConfig,
  client: CanvasClient,
  manager: Managed,
  merged: Obj[],
  selection: Awaited<ReturnType<typeof discoverSelectedCourses>>,
  pilot?: SyncPilot,
): Promise<void> {
  const { written, notices } = manager
  const { courseReports, failures } = selection
  try {
    for (const course of merged) {
      const beforeWritten = written.length,
        beforeNotices = notices.length
      try {
        await syncOne(config, course as SyncedCourse, manager, pilot?.id === course.id, client)
        courseReports.push({
          courseId: String(course.id),
          code: String(course.code),
          root: String(course.root),
          status: "synced",
          written: written.length - beforeWritten,
          notices: notices.length - beforeNotices,
        })
      } catch (error) {
        if (isCanvasUnauthorized(error)) throw error
        failures.push(error)
        courseReports.push({
          courseId: String(course.id),
          code: String(course.code),
          root: String(course.root),
          status: "failed",
          written: written.length - beforeWritten,
          notices: notices.length - beforeNotices,
          errorKind: error instanceof CanvasHttpError ? "http-error" : "resource-error",
          ...(error instanceof CanvasHttpError ? { httpStatus: error.status } : {}),
        })
        notices.push(
          `Selected course ${course.id} failed; partial files/ownership evidence were retained and other selected courses were attempted. No source/error body was echoed.`,
        )
      }
    }
  } finally {
    // Preserve ownership evidence even if a later endpoint fails mid-sync.
    await saveSyncState(manager)
  }
}

export async function syncCourses(
  config: ToolkitConfig,
  options: {
    unresolvedPilot?: { id: string; code: string; name: string }
    preserveSchool?: boolean
  } = {},
  client: CanvasClient = createCanvasClient(config),
): Promise<SyncReport> {
  const pilot = options.unresolvedPilot
  if (
    pilot &&
    (config.courses.allowlist.length !== 1 ||
      config.courses.allowlist[0] !== pilot.id ||
      !/^[1-9]\d*$/.test(pilot.id))
  )
    throw new Error("Unresolved pilot sync must match exactly one explicitly selected course")
  if (!config.courses.allowlist.length)
    return {
      courses: 0,
      written: [],
      notices: ["Canvas course allowlist is empty; nothing was synced."],
    }
  const notices: string[] = []
  const vault = resolve(config.vault.path)
  await assertNoPreservationMigration(vault)
  await guardCanvasOrigin(vault, base(config).origin)
  const stateResult = await loadSyncState(vault, notices, base(config).origin)
  const subjectHash = await verifiedSubjectHash(config, client)
  const subjectBound = await guardSyncSubject(vault, base(config).origin, subjectHash)
  if (!subjectBound && stateResult.stateHash)
    notices.push(
      "This vault has no verified historical account binding. The first API-subject reservation protects future syncs only; prior feedback ownership remains unverified.",
    )
  const selection = await discoverSelectedCourses(config, client, notices, pilot)
  const { courses, allow, courseReports, failures } = selection
  const written: string[] = []
  const { manifestPath, previous } = await readCourseManifest(vault, notices)
  const merged = await resolveCourseMappings(
    vault,
    courses,
    previous,
    notices,
    options.preserveSchool,
  )
  await validateCourseMappings(vault, courses, previous, merged, stateResult)
  const manager: Managed = {
    vault,
    subjectHash,
    state: stateResult.state,
    trusted: stateResult.trusted,
    stateHash: stateResult.stateHash,
    written,
    notices,
  }
  await guardCanvasOrigin(vault, base(config).origin, true)
  await guardSyncSubject(vault, base(config).origin, subjectHash, true)
  await publishCourseManifest(manager, manifestPath, previous, merged)
  await syncSelectedCourses(config, client, manager, merged, selection, pilot)
  if (merged.some((course) => course.syncNamespace === "Canvas Agent")) {
    const layout = await inspectSchoolLayout(vault)
    notices.push(
      layout.schoolWrites === "blocked-by-marker"
        ? `School shared-writer readiness: blocked-by-marker (${layout.status}). ${layout.note}`
        : `School shared-writer readiness remains unverified (${layout.status}); its marker was not changed and a preserved namespace is not a compatibility certificate.`,
    )
  }
  if (failures.length) {
    // Preserve existing single-course diagnostics and fail-closed callers.
    if (allow.size === 1) throw failures[0]
    throw new CanvasSyncPartialError({
      courses: courseReports.filter((course) => course.status === "synced").length,
      written,
      notices,
      courseReports,
      failedCourses: failures.length,
    })
  }
  if (!courses.length) notices.push("No allowlisted courses were returned by Canvas.")
  return {
    courses: courses.length,
    written,
    notices,
    courseReports,
    failedCourses: 0,
  }
}
