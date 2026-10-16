import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { CourseContext, SourceRecord } from "../../src/shared/types.js"
import {
  artifactBaseName,
  assignmentDraftsDirectory,
  assignmentFinalsDirectory,
  formatArtifactName,
  nextArtifactName,
  parseArtifactVersion,
} from "../../src/tasks/artifacts/artifact-layout.js"
import { resolvePrepPeriod, savedWeekPrepLocation } from "../../src/tasks/authoring/recipes.js"
import { productDestination } from "../../src/vault/destinations.js"

const source = (path: string, title: string, type = "markdown"): SourceRecord => ({
  path,
  title,
  hash: createHash("sha256").update(path).digest("hex"),
  text: "Synthetic course evidence for location selection.",
  type,
  dates: [],
})
const course = (sources: SourceRecord[], existingWork: string[] = []): CourseContext => ({
  code: "CS101",
  title: "Synthetic course",
  root: "CS101",
  sources,
  excluded: [],
  guidance: [],
  existingWork,
})

describe("academic artifact layout", () => {
  it("returns explicit week, session, and fallback location kinds", () => {
    const week = course(
      [source("CS101/Week 03 - Oct 12/reading.md", "Reading")],
      ["CS101/Week 03 - Oct 12"],
    )
    expect(resolvePrepPeriod(week, { kind: "week", value: "2026-10-12" })).toEqual({
      locationKind: "week-folder",
      root: "CS101/Week 03 - Oct 12",
      destination: "CS101/Week 03 - Oct 12/Prep",
    })

    const session = course([source("CS101/Milestone 2/Session 4.md", "Session 4", "module")])
    expect(resolvePrepPeriod(session, { kind: "session", value: "Session 4" })).toMatchObject({
      locationKind: "session-folder",
      root: "CS101/Milestone 2",
      destination: "CS101/Milestone 2/Prep",
    })

    const fallback = course([source("CS101/Materials/reading.md", "Reading")])
    expect(resolvePrepPeriod(fallback, { kind: "week", value: "2026-10-12" })).toEqual({
      locationKind: "fallback-week",
      destination: "CS101/Other/Prep/2026-10-12",
    })
    expect(
      resolvePrepPeriod(course([source("CS101/Session 1.md", "Session 1", "module")]), {
        kind: "session",
        value: "Session 1",
      }),
    ).toMatchObject({
      locationKind: "fallback-session",
      destination: "CS101/Other/Prep/session-session-1",
    })
  })

  it("reads historical fallback destinations even when a week folder exists now", () => {
    expect(savedWeekPrepLocation("CS101", "2026-10-12", "CS101/Other/Prep/2026-10-12")).toEqual({
      locationKind: "fallback-week",
    })
    expect(savedWeekPrepLocation("CS101", "2026-10-12", "CS101/Week 03 - Oct 12/Prep")).toEqual({
      locationKind: "week-folder",
      root: "CS101/Week 03 - Oct 12",
    })
  })

  it("uses one canonical version parser and writer, rejecting malformed suffixes", () => {
    const base = artifactBaseName("assignment-draft", "draft")
    for (const version of [1, 2, 3, 12, 999]) {
      const name = formatArtifactName(base, version)
      expect(parseArtifactVersion(name, base)).toBe(version)
    }
    for (const name of [
      "01 Assignment Draft.v0.md",
      "01 Assignment Draft.v1.md",
      "01 Assignment Draft.v02.md",
      "01 Assignment Draft.v2x.md",
      "01 Assignment Draft.v9007199254740992.md",
      "01 Assignment Draft.V2.md",
      "01 Assignment Draft.md.bak",
    ])
      expect(parseArtifactVersion(name, base)).toBeUndefined()
    expect(parseArtifactVersion("case.v1.md", "case", true)).toBe(1)
    expect(nextArtifactName(base, [base, "01 Assignment Draft.v2.md"])).toBe(
      "01 Assignment Draft.v3.md",
    )
  })

  it("keeps folder construction and generated namespace paths stable", () => {
    expect(assignmentDraftsDirectory("CS101/Assignments/case.md")).toBe("CS101/Assignments/Drafts")
    expect(assignmentFinalsDirectory("CS101/Canvas Agent/Generated/Assignments/Drafts")).toBe(
      "CS101/Canvas Agent/Generated/Assignments/Finals",
    )
    expect(productDestination("CS101", "CS101/Week 03 - Oct 12/Prep", 1)).toBe(
      "CS101/Canvas Agent/Generated/Week 03 - Oct 12/Prep",
    )
  })
})
