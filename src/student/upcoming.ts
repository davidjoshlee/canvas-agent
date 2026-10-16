import { parse as parseYaml } from "yaml"
import type { SourceRecord, WorkspaceContext } from "../shared/types.js"
import { sourceKind } from "../vault/source-kind.js"
import { selectCourse } from "../vault/workspace.js"
import { applyCalendarOverrides } from "./calendar.js"

export interface UpcomingItem {
  kind: "assignment" | "announcement"
  course: string
  title: string
  path: string
  dueAt: string
  canvasId?: string
  assignmentDates?: SourceRecord["assignmentDates"]
  overdue: boolean
}

export interface UndatedItem {
  kind: "assignment" | "announcement"
  course: string
  title: string
  path: string
  canvasId?: string
  assignmentDates?: SourceRecord["assignmentDates"]
}

function sourceDueAt(source: SourceRecord): string | undefined {
  if (source.dueAt) return source.dueAt
  if (source.assignmentDates) return source.assignmentDates.effectiveDueAt ?? undefined
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
  const courses = options.course ? [selectCourse(context, options.course)] : context.courses
  for (const course of courses) {
    const seen = new Set<string>()
    const sources = course.syncNamespace
      ? [...course.sources].sort(
          (a, b) =>
            Number(b.path.startsWith(`${course.root}/Canvas Agent/`)) -
            Number(a.path.startsWith(`${course.root}/Canvas Agent/`)),
        )
      : course.sources
    for (const source of sources) {
      const classified = sourceKind(source)
      const kind =
        classified === "announcement" || classified === "assignment" ? classified : undefined
      if (!kind || (kind === "announcement" && !options.includeAnnouncements)) continue
      const key = `${course.code}\0${kind}\0${source.canvasId ?? source.path}`
      // An edited old copy remains available as explicit student context, but
      // must not override a refreshed product source's deadline (even when the
      // latter is undated or outside this view's horizon).
      if (course.syncNamespace) {
        if (seen.has(key)) continue
        seen.add(key)
      }
      const base: UndatedItem = {
        kind,
        course: course.code,
        title: source.title,
        path: source.path,
        ...(source.canvasId ? { canvasId: source.canvasId } : {}),
        ...(source.assignmentDates ? { assignmentDates: source.assignmentDates } : {}),
      }
      const dueAt = kind === "announcement" ? source.postedAt : sourceDueAt(source)
      if (!dueAt || !Number.isFinite(Date.parse(dueAt))) {
        undated.set(key, base)
        continue
      }
      const timestamp = Date.parse(dueAt)
      if (!Number.isFinite(timestamp) || timestamp > horizon) continue
      const row: UpcomingItem = {
        ...base,
        dueAt,
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
