import { describe, expect, it } from "vitest"
import { relatedSources } from "../src/module-context.js"
import type { CourseContext, SourceRecord } from "../src/types.js"

const source = (path: string, relatedPaths: string[] = []): SourceRecord => ({
  path,
  title: path,
  hash: "hash",
  text: path,
  type: "document",
  dates: [],
  relatedPaths,
})

describe("related module sources", () => {
  it("follows only explicit relationships within the approved course sources", () => {
    const module = source("ACCT340/Canvas/Modules/Week-1.md", [
      "ACCT340/Canvas/Assignments/Case.md",
      "../../OTHER/secret.md",
      "ACCT340/Canvas/Files/raw.pdf",
    ])
    const assignment = source("ACCT340/Canvas/Assignments/Case.md", [
      "ACCT340/Resources/Reading.md",
    ])
    const reading = source("ACCT340/Resources/Reading.md")
    const course = {
      code: "ACCT340",
      title: "Accounting",
      root: "ACCT340",
      sources: [module, assignment, reading],
      excluded: [],
      guidance: [],
      existingWork: [],
    } satisfies CourseContext
    expect(relatedSources(course, [module]).map((record) => record.path)).toEqual([
      "ACCT340/Canvas/Assignments/Case.md",
      "ACCT340/Canvas/Modules/Week-1.md",
      "ACCT340/Resources/Reading.md",
    ])
  })
})
