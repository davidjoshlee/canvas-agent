import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseSessionTitle, resolveSessionYear } from "../src/session-dates.ts"

// Pure source audit only. Never load a School config, vault, provider or account.
const school = process.argv[2]
if (!school || !isAbsolute(school)) throw new Error("Supply an absolute School Agent checkout path")
const path = join(school, "src/canvas/sync-session-date.ts")
const { parseSessionDate, resolveCourseYear } = await import(pathToFileURL(path).href)
const sharedTitles = [
  "Session 8 (October 16)",
  "Oct. 16",
  "10/16",
  "October 16 (10/16)",
  "Sept 30",
  "Oct 16 and Oct 23",
  "Session 8",
]
const titles = sharedTitles.map((title) => {
  const original = parseSessionDate(title, 2026)
  const current = parseSessionTitle(title, 2026).date
  assert.equal(current, original)
  return { title, school: original ?? null, canvas: current ?? null, equal: true }
})
const cases = [
  [{ term: { start_at: "2026-09-20T00:00:00Z" }, course_code: "F24-CS101" }, []],
  [{ start_at: "2026-09-20" }, []],
  [{ end_at: "2026-12-20" }, []],
  [{ course_code: "F26-CS101" }, ["2025-10-01"]],
  [{ course_code: "CS101-26F" }, []],
  [{}, ["2025-10-01", "2026-10-01", "2026-10-08"]],
  [{}, ["2025-10-01", "2026-10-01"]],
  [{}, []],
]
const years = cases.map(([course, due]) => {
  const original = resolveCourseYear(course, due)
  const current = resolveSessionYear(course, due)
  assert.equal(current.year, original)
  return {
    school: original ?? null,
    canvas: current.year ?? null,
    source: current.source,
    equal: true,
  }
})
const differences = [
  ["Feb 30", "invalid date refused"],
  ["October 16, 2027", "explicit title year honored instead of course-year substitution"],
  ["2027-10-16", "explicit ISO title date recognized"],
].map(([title, reason]) => ({
  title,
  reason,
  school: parseSessionDate(title, 2026) ?? null,
  canvas: parseSessionTitle(title, 2026).date ?? null,
}))
assert.equal(differences[0].school, "2026-02-30")
assert.equal(differences[0].canvas, null)
assert.equal(differences[1].school, "2026-10-16")
assert.equal(differences[1].canvas, "2027-10-16")
assert.equal(differences[2].school, null)
assert.equal(differences[2].canvas, "2027-10-16")
console.log(
  JSON.stringify(
    {
      status: "shared-synthetic-session-cases-pass",
      source: {
        path,
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      },
      sharedCases: titles.length + years.length,
      titles,
      years,
      deliberateDifferences: differences,
      scope: "source parsing/year inference only; not real course coverage or historical access",
    },
    null,
    2,
  ),
)
