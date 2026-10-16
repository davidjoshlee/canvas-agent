import { describe, expect, it } from "vitest"
import { sourceKind } from "../../src/vault/source-kind.js"

describe("semantic source classification", () => {
  it("prefers recognized canonical types over misleading filenames", () => {
    expect(
      sourceKind({ type: "assignment", path: "CS101/Assignments/announcement-analysis.md" }),
    ).toBe("assignment")
    expect(
      sourceKind({ type: "announcements", path: "CS101/Assignments/assignment-brief.md" }),
    ).toBe("announcement")
  })

  it("adapts known legacy file labels from directory semantics", () => {
    expect(sourceKind({ type: "document", path: "CS101/Assignments/prompt.md" })).toBe("assignment")
    expect(sourceKind({ type: ".pdf", path: "CS101/Syllabus/course-outline.pdf" })).toBe("syllabus")
    expect(sourceKind({ type: "modules", path: "CS101/Canvas/Modules/Week 1.md" })).toBe("module")
  })

  it("uses module-index metadata, preserves imported readings, and leaves unknown roles conservative", () => {
    expect(
      sourceKind({
        type: "document",
        path: "CS101/Canvas/Pages/week-1.md",
        moduleCanvasId: "42",
      }),
    ).toBe("other")
    expect(
      sourceKind({
        type: "document",
        path: "CS101/Canvas/Modules/reading.md",
        moduleCanvasId: "42",
      }),
    ).toBe("other")
    expect(
      sourceKind({
        type: "document",
        path: "CS101/Canvas/Modules/Week 1.md",
        modulePosition: 1,
      }),
    ).toBe("module")
    expect(sourceKind({ type: "reading", path: "CS101/Assignments/assignment-analysis.md" })).toBe(
      "other",
    )
    expect(sourceKind({ type: "reading", path: "CS101/Modules/Session 1.md" })).toBe("other")
  })

  it.each(["constructor", "toString", "__proto__"])(
    "treats prototype property name %s as an unknown source type",
    (type) => {
      expect(sourceKind({ type, path: "CS101/Assignments/assignment-analysis.md" })).toBe("other")
    },
  )
})
