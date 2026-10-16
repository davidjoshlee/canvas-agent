import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, realpath, rename } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { assertNoSymlinks } from "../shared/fs-safety.js"
import type { WorkspaceContext } from "../shared/types.js"
import { isAssignmentSource } from "../vault/source-kind.js"
import type { UpcomingItem } from "./upcoming.js"

export type DueOverride = { path: string; dueAt: string; updatedAt: string }
export type CalendarNotice = {
  kind: "match" | "mismatch" | "ambiguous" | "unmatched"
  path?: string
  title: string
  canvasId?: string
  canvasDueAt?: string
  calendarDueAt?: string
  detail?: string
  assignmentDates?: import("../canvas/assignment-dates.js").AssignmentDates
  alternativeDateMatch?: boolean
}
const overridePath = (vault: string) => join(vault, "_meta", "calendar-overrides.json")
const within = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`))
}
function validDate(value: string): boolean {
  const dateOnly = /^(\d{4})-(\d\d)-(\d\d)$/.exec(value)
  if (dateOnly) return validParts(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]))
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return false
  return validParts(
    Number(value.slice(0, 4)),
    Number(value.slice(5, 7)),
    Number(value.slice(8, 10)),
  )
}
function validParts(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}
async function checkedVault(vault: string): Promise<string> {
  await assertNoSymlinks(vault)
  const root = await realpath(vault)
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Workspace must be a real directory")
  return root
}
async function readOverrides(vault: string): Promise<DueOverride[]> {
  const path = overridePath(vault)
  await assertNoSymlinks(path, true)
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000)
      throw new Error("Calendar override file must be a regular file under 1 MB")
    const raw: unknown = JSON.parse(await readFile(path, "utf8"))
    if (
      !Array.isArray(raw) ||
      raw.length > 10_000 ||
      raw.some((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true
        const row = entry as Record<string, unknown>
        return (
          Object.keys(row).sort().join(",") !== "dueAt,path,updatedAt" ||
          typeof row.path !== "string" ||
          !validOverridePath(row.path) ||
          typeof row.dueAt !== "string" ||
          !validDate(row.dueAt) ||
          typeof row.updatedAt !== "string" ||
          !Number.isFinite(Date.parse(row.updatedAt))
        )
      })
    )
      throw new Error("Calendar override file is malformed")
    return raw as DueOverride[]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}
function validOverridePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    path === path.replaceAll("\\", "/") &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  )
}
export async function setCalendarOverride(
  vault: string,
  workspace: WorkspaceContext,
  targetPath: string,
  dueAt: string,
): Promise<DueOverride> {
  const root = await checkedVault(vault)
  if (!validDate(dueAt))
    throw new Error("Due date must be YYYY-MM-DD or an ISO date-time with timezone")
  const normalized = targetPath.replaceAll("\\", "/")
  if (!validOverridePath(normalized))
    throw new Error("Assignment path must be normalized and vault-relative")
  const absolute = resolve(root, normalized)
  if (!within(root, absolute)) throw new Error("Assignment path escapes the workspace")
  await assertNoSymlinks(absolute)
  const stat = await lstat(absolute)
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Assignment path must be a regular file")
  const match = workspace.courses.flatMap((course) =>
    course.sources
      .filter((source) => source.path === normalized && isAssignmentSource(source))
      .map((source) => ({ course, source })),
  )
  if (match.length !== 1)
    throw new Error(
      match.length ? "Assignment path is ambiguous" : "Path is not a known synced assignment",
    )
  const entries = await readOverrides(root)
  const previousBytes = await readFile(overridePath(root)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  })
  const override = { path: normalized, dueAt, updatedAt: new Date().toISOString() }
  const next = [...entries.filter((entry) => entry.path !== normalized), override].sort((a, b) =>
    a.path.localeCompare(b.path),
  )
  const file = overridePath(root)
  await mkdir(dirname(file), { recursive: true })
  await assertNoSymlinks(file, true)
  const temp = `${file}.${randomUUID()}.tmp`
  await writeFileSafe(temp, `${JSON.stringify(next, null, 2)}\n`)
  const currentBytes = await readFile(file).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  })
  if (!sameBytes(previousBytes, currentBytes)) {
    await import("node:fs/promises").then(({ unlink }) => unlink(temp))
    throw new Error("Calendar overrides changed concurrently; retry the command")
  }
  await rename(temp, file)
  return override
}
function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right)
}
async function writeFileSafe(path: string, text: string): Promise<void> {
  const file = await open(path, "wx", 0o600)
  try {
    await file.writeFile(text, "utf8")
  } finally {
    await file.close()
  }
}
export async function applyCalendarOverrides(
  vault: string,
  context: WorkspaceContext,
): Promise<WorkspaceContext> {
  const root = await checkedVault(vault)
  const overrides = await readOverrides(root)
  const byPath = new Map(overrides.map((entry) => [entry.path, entry.dueAt]))
  return {
    ...context,
    courses: context.courses.map((course) => ({
      ...course,
      sources: course.sources.map((source) => {
        const dueAt = byPath.get(source.path)
        return dueAt && isAssignmentSource(source) ? { ...source, dueAt } : source
      }),
    })),
  }
}

function unfold(ics: string): string[] {
  return ics
    .replace(/\r?\n[ \t]/g, "")
    .replaceAll("\r\n", "\n")
    .split("\n")
}
function unescapeIcs(value: string): string {
  return value.replace(/\\[nN]/g, "\n").replace(/\\([,;\\])/g, "$1")
}
type Event = { title: string; id?: string; dueAt?: string; unsupportedDate?: string }
function readEvents(ics: string): Event[] {
  const result: Event[] = []
  let fields: string[] | undefined
  for (const line of unfold(ics)) {
    if (line === "BEGIN:VEVENT") {
      fields = []
      continue
    }
    if (line === "END:VEVENT" && fields) {
      const field = (name: string) =>
        fields?.find((value) => value.startsWith(`${name};`) || value.startsWith(`${name}:`))
      const value = (name: string) => {
        const line = field(name)
        const colon = line?.indexOf(":") ?? -1
        return colon < 0 ? undefined : line?.slice(colon + 1)
      }
      const dateLine = field("DUE") ?? field("DTSTART")
      const date = value("DUE") ?? value("DTSTART")
      const dateParams = dateLine?.slice(0, dateLine.indexOf(":")) ?? ""
      const parsed = date?.match(/^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)?(Z)?)?$/)
      let dueAt: string | undefined
      if (
        parsed &&
        (!parsed[4] || parsed[7]) &&
        !/TZID=/i.test(dateParams) &&
        validParts(Number(parsed[1]), Number(parsed[2]), Number(parsed[3]))
      )
        dueAt = parsed[4]
          ? `${parsed[1]}-${parsed[2]}-${parsed[3]}T${parsed[4]}:${parsed[5]}:${parsed[6] ?? "00"}Z`
          : `${parsed[1]}-${parsed[2]}-${parsed[3]}`
      const title = value("SUMMARY")
      if (title)
        result.push({
          title: unescapeIcs(title),
          id: value("X-CANVAS-ASSIGNMENT-ID") ?? value("UID")?.match(/^assignment-([^@]+)/)?.[1],
          dueAt,
          ...(!dueAt && date
            ? {
                unsupportedDate:
                  /TZID=/i.test(dateParams) || (parsed?.[4] && !parsed[7])
                    ? "Floating or TZID calendar dates are not compared; use a UTC event."
                    : "Calendar event has an unsupported or invalid date.",
              }
            : {}),
        })
      fields = undefined
      continue
    }
    if (fields) fields.push(line)
  }
  return result
}
export function compareCalendar(context: WorkspaceContext, ics: string): CalendarNotice[] {
  const assignments = context.courses.flatMap((course) => {
    const sources = course.sources.filter((source) => isAssignmentSource(source))
    const activeIds = new Set(
      course.syncNamespace
        ? sources
            .filter((source) => source.path.startsWith(`${course.root}/Canvas Agent/`))
            .map((source) => source.canvasId)
            .filter((id): id is string => Boolean(id))
        : [],
    )
    return sources
      .filter(
        (source) =>
          !source.canvasId ||
          !activeIds.has(source.canvasId) ||
          source.path.startsWith(`${course.root}/Canvas Agent/`),
      )
      .map((source) => ({ course, source }))
  })
  const events = readEvents(ics)
  const notices: CalendarNotice[] = []
  const used = new Set<number>()
  const eventOwners = events.map((event) =>
    assignments
      .map(({ source }, index) => ({ source, index }))
      .filter(({ source }) =>
        event.id
          ? source.canvasId === event.id
          : event.title.trim().toLocaleLowerCase() === source.title.trim().toLocaleLowerCase(),
      )
      .map(({ index }) => index),
  )
  for (const { source } of assignments) {
    const idMatches = source.canvasId
      ? events
          .map((event, index) => ({ event, index }))
          .filter(({ event }) => event.id === source.canvasId)
      : []
    const matches = idMatches.length
      ? idMatches
      : events
          .map((event, index) => ({ event, index }))
          .filter(
            ({ event }) =>
              !event.id &&
              event.title.trim().toLocaleLowerCase() === source.title.trim().toLocaleLowerCase(),
          )
    if (matches.length > 1) {
      notices.push({
        kind: "ambiguous",
        path: source.path,
        title: source.title,
        ...(source.canvasId ? { canvasId: source.canvasId } : {}),
        detail: `${matches.length} calendar events match; no change applied`,
      })
      continue
    }
    const matched = matches[0]
    if (!matched) {
      notices.push({
        kind: "unmatched",
        path: source.path,
        title: source.title,
        ...(source.canvasId ? { canvasId: source.canvasId } : {}),
        ...(source.dueAt ? { canvasDueAt: source.dueAt } : {}),
        detail: "Assignment has no matching calendar event",
      })
      continue
    }
    if ((eventOwners[matched.index] ?? []).length > 1) {
      used.add(matched.index)
      notices.push({
        kind: "ambiguous",
        path: source.path,
        title: source.title,
        ...(source.canvasId ? { canvasId: source.canvasId } : {}),
        detail: "Calendar event could refer to multiple assignments; no change applied",
      })
      continue
    }
    used.add(matched.index)
    const canvasDueAt = source.dueAt
    const calendarDueAt = matched.event.dueAt
    const alternativeDateMatch = Boolean(
      calendarDueAt &&
        source.assignmentDates?.alternatives.some(
          (date) => date.dueAt && Date.parse(date.dueAt) === Date.parse(calendarDueAt),
        ),
    )
    const same =
      canvasDueAt && calendarDueAt && Date.parse(canvasDueAt) === Date.parse(calendarDueAt)
    notices.push({
      kind: same ? "match" : "mismatch",
      path: source.path,
      title: source.title,
      ...(source.canvasId ? { canvasId: source.canvasId } : {}),
      ...(canvasDueAt ? { canvasDueAt } : {}),
      ...(calendarDueAt ? { calendarDueAt } : {}),
      ...(source.assignmentDates
        ? { assignmentDates: source.assignmentDates, alternativeDateMatch }
        : {}),
      ...(!same && alternativeDateMatch
        ? {
            detail:
              "Calendar matches a visible alternative, not the requester-effective due date; confirm applicability in Canvas. No date changed.",
          }
        : {}),
      ...(!calendarDueAt
        ? { detail: matched.event.unsupportedDate ?? "Calendar event has no supported date" }
        : {}),
    })
  }
  events.forEach((event, index) => {
    if (!used.has(index))
      notices.push({
        kind: "unmatched",
        title: event.title,
        ...(event.id ? { canvasId: event.id } : {}),
        ...(event.dueAt ? { calendarDueAt: event.dueAt } : {}),
      })
  })
  return notices
}
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n")
}
function icsDate(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) throw new Error(`Invalid due date: ${value}`)
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "")
}
export function renderCalendar(items: readonly UpcomingItem[], stamp = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Canvas Agent//Due Dates//EN",
    "CALSCALE:GREGORIAN",
  ]
  for (const item of items) {
    const date = icsDate(item.dueAt)
    const id = item.canvasId
      ? `assignment-${item.canvasId}`
      : `path-${createHash("sha256").update(item.path).digest("hex")}`
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeText(id)}@canvas-agent.local`,
      ...(item.canvasId ? [`X-CANVAS-ASSIGNMENT-ID:${escapeText(item.canvasId)}`] : []),
      `DTSTAMP:${icsDate(stamp.toISOString())}`,
      `DTSTART:${date}`,
      `DUE:${date}`,
      `SUMMARY:${escapeText(item.title)}`,
      `CATEGORIES:${escapeText(item.course)}`,
      `DESCRIPTION:${escapeText(item.path)}`,
      "END:VEVENT",
    )
  }
  lines.push("END:VCALENDAR", "")
  return lines.join("\r\n")
}
export async function exportCalendar(file: string, items: readonly UpcomingItem[]): Promise<void> {
  if (!isAbsolute(file)) throw new Error("Calendar export path must be absolute")
  const contents = renderCalendar(items)
  await assertNoSymlinks(file, true)
  await assertNoSymlinks(dirname(file), true)
  await mkdir(dirname(file), { recursive: true })
  await assertNoSymlinks(file, true)
  const handle = await open(file, "wx", 0o600)
  try {
    await handle.writeFile(contents, "utf8")
  } finally {
    await handle.close()
  }
}

export async function readCalendarFile(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("ICS path must be absolute")
  await assertNoSymlinks(path)
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5_000_000)
    throw new Error("ICS input must be a regular file under 5 MB")
  return readFile(path, "utf8")
}
