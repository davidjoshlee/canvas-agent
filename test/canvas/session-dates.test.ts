import { describe, expect, it } from "vitest"
import { parseSessionTitle, resolveSessionYear } from "../../src/canvas/session-dates.js"

describe("course-evidence session dates", () => {
  it("resolves course years in School precedence without the current clock", () => {
    expect(
      resolveSessionYear(
        {
          term: { start_at: "2026-09-20T00:00:00Z" },
          start_at: "2025-09-20",
          course_code: "F24-CS-101",
        },
        ["2023-10-01"],
      ),
    ).toEqual({ year: 2026, source: "term-start" })
    expect(resolveSessionYear({ start_at: "2026-09-20" }, [])).toEqual({
      year: 2026,
      source: "course-start",
    })
    expect(resolveSessionYear({ end_at: "2026-12-20" }, [])).toEqual({
      year: 2026,
      source: "course-end",
    })
    for (const code of ["F26-CS-101", "CS101-26F", "SP26_CS101", "CS101_SU26"])
      expect(resolveSessionYear({ course_code: code }, ["2025-10-01"])).toEqual({
        year: 2026,
        source: "course-code",
      })
    expect(resolveSessionYear({}, ["2025-10-01", "2026-10-01", "2026-10-08"])).toEqual({
      year: 2026,
      source: "assignment-modal-year",
    })
    expect(resolveSessionYear({}, ["2025-10-01", "2026-10-01"])).toEqual({ source: "unresolved" })
    expect(
      resolveSessionYear({ term: { start_at: "2026-02-30" } }, ["invalid", "2026-02-30"]),
    ).toEqual({ source: "unresolved" })
  })
  it("parses School's valid month-name and numeric formats with year provenance", () => {
    for (const title of ["Session 8 (October 16)", "Oct. 16", "10/16", "Oct 16 (10/16)"])
      expect(parseSessionTitle(title, 2026)).toEqual({
        date: "2026-10-16",
        yearSource: "course-year",
      })
    expect(parseSessionTitle("Sept 30", 2026).date).toBe("2026-09-30")
    expect(parseSessionTitle("Feb 29", 2024).date).toBe("2024-02-29")
  })
  it("honors explicit title years without silently substituting the course year", () => {
    for (const title of ["2027-10-16", "October 16, 2027", "10/16/2027"])
      expect(parseSessionTitle(title, 2026)).toEqual({
        date: "2027-10-16",
        yearSource: "title-year",
      })
    expect(parseSessionTitle("2027-10-16").date).toBe("2027-10-16")
    expect(parseSessionTitle("October 16, 2027").date).toBe("2027-10-16")
  })
  it("reports ambiguity, impossible dates and missing year rather than creating rollover/guessed dates", () => {
    expect(parseSessionTitle("Oct 16 and Oct 23", 2026)).toEqual({ reason: "ambiguous" })
    expect(parseSessionTitle("Feb 30", 2026)).toEqual({ reason: "invalid-date" })
    expect(parseSessionTitle("Feb 29", 2026)).toEqual({ reason: "invalid-date" })
    expect(parseSessionTitle("13/16", 2026)).toEqual({ reason: "invalid-date" })
    expect(parseSessionTitle("Oct 16")).toEqual({ reason: "unresolved-year" })
    expect(parseSessionTitle("Session 8", 2026)).toEqual({})
  })
})
