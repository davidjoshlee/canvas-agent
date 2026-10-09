import { parse as parseYaml } from "yaml"
import { applyCalendarOverrides } from "./calendar.js"
import type { SourceRecord, WorkspaceContext } from "./types.js"

export interface UpcomingItem {
  kind: "assignment" | "announcement"
  course: string
  title: string
  path: string
  dueAt: string
  canvasId?: string
  overdue: boolean
}

export interface UndatedItem {
  kind: "assignment" | "announcement"
  course: string
  title: string
  path: string
  canvasId?: string
}

function sourceDueAt(source: SourceRecord): string | undefined {
  if (source.dueAt) return source.dueAt
  const frontmatter = source.text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)
  if (frontmatter) {
    try {
      const meta = parseYaml(frontmatter[1] ?? "") as Record<string, unknown> | null
      const direct = meta?.due_at
      if (typeof direct === "string" && Number.isFinite(Date.parse(direct))) return direct
      const dates = meta?.dates as Record<string, unknown> | undefined
      if (typeof dates?.due_at === "string" && Number.isFinite(Date.parse(dates.due_at)))
        return dates.due_at
    } catch {
      // Invalid metadata is ignored; body fallback can still support older vault files.
    }
  }
  const body = source.text.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*/, "")
  const line = body.match(/^\s*(?:[-*]\s*)?Due:\s*(\d{4}-\d\d-\d\d(?:T[^\s]+)?)/im)?.[1]
  return line && Number.isFinite(Date.parse(line)) ? line : undefined
}

export function collectUpcoming(
  context: WorkspaceContext,
  options: { days?: number; course?: string; now?: Date; includeAnnouncements?: boolean } = {},
): { items: UpcomingItem[]; overdue: UpcomingItem[]; undated: UndatedItem[] } {
  const now = options.now ?? new Date()
  const horizon = now.getTime() + (options.days ?? 14) * 86_400_000
  const rows = new Map<string, UpcomingItem>()
  const undated = new Map<string, UndatedItem>()
  for (const course of context.courses) {
    if (options.course && course.code.toLocaleLowerCase() !== options.course.toLocaleLowerCase())
      continue
    for (const source of course.sources) {
      const label = `${source.type} ${source.path}`
      const kind = /announcement/i.test(label)
        ? "announcement"
        : /assignment/i.test(label)
          ? "assignment"
          : undefined
      if (!kind || (kind === "announcement" && !options.includeAnnouncements)) continue
      const key = `${course.code}\0${kind}\0${source.canvasId ?? source.path}`
      const base: UndatedItem = {
        kind,
        course: course.code,
        title: source.title,
        path: source.path,
        ...(source.canvasId ? { canvasId: source.canvasId } : {}),
      }
      const dueAt = kind === "announcement" ? source.postedAt : sourceDueAt(source)
      if (!dueAt || !Number.isFinite(Date.parse(dueAt))) {
        undated.set(key, base)
        continue
      }
      const timestamp = Date.parse(dueAt)
      if (!Number.isFinite(timestamp) || timestamp > horizon) continue
      const row: UpcomingItem = {
        kind,
        course: course.code,
        title: source.title,
        path: source.path,
        dueAt,
        ...(source.canvasId ? { canvasId: source.canvasId } : {}),
        overdue: kind === "assignment" && timestamp < now.getTime(),
      }
      const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      if (kind === "announcement" && timestamp < today) continue
      undated.delete(key)
      const previous = rows.get(key)
      if (!previous || row.path.localeCompare(previous.path) < 0) rows.set(key, row)
    }
  }
  const sorted = [...rows.values()].sort(
    (a, b) =>
      Date.parse(a.dueAt) - Date.parse(b.dueAt) ||
      a.course.localeCompare(b.course) ||
      a.path.localeCompare(b.path),
  )
  return {
    items: sorted.filter((item) => !item.overdue),
    overdue: sorted.filter((item) => item.overdue),
    undated: [...undated.entries()]
      .filter(([key]) => !rows.has(key))
      .map(([, item]) => item)
      .sort((a, b) => a.course.localeCompare(b.course) || a.path.localeCompare(b.path)),
  }
}

/** Collects due work after applying private, local calendar overrides. */
export async function readUpcoming(
  vault: string,
  context: WorkspaceContext,
  options: { days?: number; course?: string; now?: Date; includeAnnouncements?: boolean } = {},
): Promise<{ items: UpcomingItem[]; overdue: UpcomingItem[]; undated: UndatedItem[] }> {
  return collectUpcoming(await applyCalendarOverrides(vault, context), options)
}
