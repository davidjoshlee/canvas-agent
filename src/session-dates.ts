const months = Object.fromEntries(
  [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].flatMap((month, index) => [
    [month, index + 1],
    [month.slice(0, 3), index + 1],
  ]),
) as Record<string, number>
months.sept = 9

function calendarDay(year: number, month: number, day: number): string | undefined {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return undefined
  const value = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value
    ? value
    : undefined
}
function yearOf(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d(?:$|T)/.test(value)) return undefined
  const [year, month, day] = value.slice(0, 10).split("-").map(Number)
  if (!calendarDay(year ?? 0, month ?? 0, day ?? 0)) return undefined
  const instant = Date.parse(value)
  return Number.isFinite(instant) ? new Date(instant).getUTCFullYear() : undefined
}

/** Course evidence, never the machine's current year. Unique modal deadline year matches School. */
export function resolveSessionYear(
  course: Record<string, unknown>,
  deadlines: readonly unknown[],
): { year?: number; source: string } {
  const term =
    course.term && typeof course.term === "object" && !Array.isArray(course.term)
      ? (course.term as Record<string, unknown>)
      : {}
  for (const [source, value] of [
    ["term-start", term.start_at],
    ["course-start", course.start_at],
    ["course-end", course.end_at],
  ] as const) {
    const year = yearOf(value)
    if (year !== undefined) return { year, source }
  }
  const code = typeof course.course_code === "string" ? course.course_code : ""
  const codeYears = [
    ...code.matchAll(/(?:^|[-_])(?:(?:f|w|sp|su)(\d{2})|(\d{2})(?:f|w|sp|su))(?=[-_]|$)/gi),
  ].map((match) => 2000 + Number(match[1] ?? match[2]))
  if (new Set(codeYears).size === 1) return { year: codeYears[0], source: "course-code" }
  const counts = new Map<number, number>()
  for (const value of deadlines) {
    const year = yearOf(value)
    if (year !== undefined) counts.set(year, (counts.get(year) ?? 0) + 1)
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1])
  if (ranked[0] && ranked[0][1] !== ranked[1]?.[1])
    return { year: ranked[0][0], source: "assignment-modal-year" }
  return { source: "unresolved" }
}

/** A date in a title is a teaching date, not an explicit API release date. */
export function parseSessionTitle(
  title: string,
  courseYear?: number,
): {
  date?: string
  yearSource?: "course-year" | "title-year"
  reason?: "ambiguous" | "invalid-date" | "unresolved-year"
} {
  const candidates = new Set<string>()
  let problem: "invalid-date" | "unresolved-year" | undefined
  let usedCourseYear = false
  const add = (month: number, day: number, year?: number) => {
    const resolved = year ?? courseYear
    if (resolved === undefined) {
      problem ??= "unresolved-year"
      return
    }
    usedCourseYear ||= year === undefined
    const date = calendarDay(resolved, month, day)
    if (!date) {
      problem = "invalid-date"
      return
    }
    candidates.add(date)
  }
  for (const match of title.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g))
    add(Number(match[2]), Number(match[3]), Number(match[1]))
  for (const match of title.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/g)) {
    const month = months[(match[1] ?? "").toLowerCase()]
    if (month !== undefined) add(month, Number(match[2]), match[3] ? Number(match[3]) : undefined)
  }
  for (const match of title.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/g))
    add(Number(match[1]), Number(match[2]), match[3] ? Number(match[3]) : undefined)
  if (problem) return { reason: problem }
  if (candidates.size > 1) return { reason: "ambiguous" }
  return candidates.size
    ? { date: [...candidates][0], yearSource: usedCourseYear ? "course-year" : "title-year" }
    : {}
}
