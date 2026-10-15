import type { WorkspaceContext } from "../shared/types.js"
import { readUpcoming } from "./upcoming.js"

export function isoWeek(date: string): string {
  const value = new Date(`${date}T00:00:00Z`)
  if (!Number.isFinite(value.getTime())) throw new Error("Timeline day is invalid")
  value.setUTCDate(value.getUTCDate() + 4 - (value.getUTCDay() || 7))
  const year = value.getUTCFullYear()
  const week = Math.ceil(((value.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7)
  return `${year}-W${String(week).padStart(2, "0")}`
}

/** School-style UTC day window, with explicit local overrides and retained overdue visibility. */
export async function readTimeline(
  vault: string,
  context: WorkspaceContext,
  options: { weeks?: number; course?: string; now?: Date } = {},
) {
  const weeks = options.weeks ?? 4,
    now = options.now ?? new Date()
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 365 || !Number.isFinite(now.getTime()))
    throw new Error("Timeline needs a valid time and 1 to 365 whole weeks")
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const end = new Date(start.getTime() + weeks * 7 * 86_400_000)
  const upcoming = await readUpcoming(vault, context, {
    days: weeks * 7,
    now: start,
    course: options.course,
    includeAnnouncements: true,
  })
  const datedItem = (item: (typeof upcoming.items)[number]) => ({
    ...item,
    at: item.dueAt,
    actionRequired: item.kind === "announcement",
  })
  const items = upcoming.items
    .filter((item) => Date.parse(item.dueAt) < end.getTime())
    .map(datedItem)
  const overdue = upcoming.overdue.map(datedItem)
  const undated = upcoming.undated.map((item) => ({
    ...item,
    at: "",
    actionRequired: item.kind === "announcement",
  }))
  const groups = new Map<string, typeof items>()
  for (const item of items) {
    const date = new Date(item.at).toISOString().slice(0, 10)
    const group = groups.get(date) ?? []
    group.push(item)
    groups.set(date, group)
  }
  return {
    items,
    overdue,
    undated,
    dated: [...groups].map(([date, items]) => ({ week: isoWeek(date), date, items })),
    window: {
      from: start.toISOString(),
      toExclusive: end.toISOString(),
      weeks,
      timeZone: "UTC" as const,
    },
    limitation:
      "Announcement ACTION flags indicate items to read, not verified instructor requirements or a required reply. Dates include private local overrides; Canvas deadlines are unchanged. Source coverage and submission status are not verified.",
  }
}

export function renderTimeline(timeline: Awaited<ReturnType<typeof readTimeline>>): string {
  const line = (item: (typeof timeline.items)[number] | (typeof timeline.undated)[number]) =>
    `${item.at ? `${new Date(item.at).toISOString().slice(11, 16)} ` : ""}${item.course}: ${item.title}${item.actionRequired ? " [ACTION]" : ""}\t${item.path}`
  const lines = ["Timeline (UTC)"]
  if (!timeline.dated.length) lines.push("No dated items in this timeline.")
  for (const day of timeline.dated)
    lines.push(`## ${day.week} — ${day.date}`, ...day.items.map((item) => `- ${line(item)}`), "")
  if (timeline.overdue.length)
    lines.push("## Overdue", ...timeline.overdue.map((item) => `- ${item.dueAt} ${line(item)}`), "")
  if (timeline.undated.length)
    lines.push("## Undated", ...timeline.undated.map((item) => `- ${line(item)}`))
  if ([...timeline.items, ...timeline.undated].some((item) => item.actionRequired))
    lines.push("", "[ACTION] = announcement to read, not a verified required reply.")
  return lines.join("\n").trim()
}
