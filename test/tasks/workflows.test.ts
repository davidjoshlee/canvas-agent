import { describe, expect, it } from "vitest"
import { workflowFor, workflowForRequirements } from "../../src/tasks/authoring/workflows.js"

describe("academic workflow contracts", () => {
  it("makes new drafts finished deliverables with executed quantitative checks and source-based self-review", () => {
    const sections = workflowFor("assignment", "draft").requiredSections
    const current = workflowForRequirements({
      kind: "assignment",
      mode: "draft",
      sections: sections,
      questions: [],
    })
    const prior = workflowForRequirements({
      kind: "assignment",
      mode: "draft",
      sections: sections,
      questions: [],
      guidanceInstructions: [],
      version: 2,
    })
    expect(current.version).toBe(3)
    expect(current.requiredSections).toEqual(prior.requiredSections)
    expect(current.instructions.join(" ")).toContain("actual finished deliverable")
    expect(current.instructions.join(" ")).toContain("PENDING")
    expect(current.instructions.join(" ")).toContain("bounded calculate command")
    expect(current.instructions.join(" ")).toContain("self-review, not independent grading")
    expect(prior.instructions.join(" ")).not.toContain("actual finished deliverable")
    for (const mode of ["outline", "discuss"] as const)
      expect(
        workflowForRequirements({
          kind: "assignment",
          mode: mode,
          sections: workflowFor("assignment", mode).requiredSections,
          questions: [],
        }).instructions.join(" "),
      ).not.toContain("actual finished deliverable")
    expect(() =>
      workflowForRequirements({
        kind: "assignment",
        mode: "draft",
        sections: sections,
        questions: [],
        guidanceInstructions: [],
        version: 99 as never,
      }),
    ).toThrow(/version/)
  })
  it("keeps discussion separate from graded drafting and requires explicit permission", () => {
    const discussion = workflowFor("assignment", "discuss")
    expect(discussion.requiredSections).toEqual([
      "Student question",
      "Discussion",
      "Open questions",
      "Sources",
    ])
    expect(discussion.instructions.join(" ")).toContain("Do not write or replace a graded draft")
    expect(discussion.instructions.join(" ")).toContain("explicitly permits")
    expect(discussion.instructions.join(" ")).toContain(
      "Do not submit or upload anything to Canvas",
    )
  })
  it("defines a complete, finished prep brief with stable required headings", () => {
    const workflow = workflowFor("prep")
    expect(workflow.version).toBe(1)
    expect(workflow.requiredSections).toEqual([
      "Summary",
      "Key concepts",
      "Discussion questions",
      "Sources",
    ])
    expect(workflow.instructions.join(" ")).toMatch(/finished, usable preparation brief/)
    expect(workflow.instructions.join(" ")).toMatch(
      /synthesize their frameworks, claims, supporting evidence/,
    )
    expect(workflow.instructions.join(" ")).toMatch(/Answer any supplied preparation questions/)
    expect(workflow.instructions.join(" ")).toMatch(/absent material/)
    expect(workflow.instructions.join(" ")).toMatch(/untrusted reference material/)
    expect(workflow.instructions.join(" ")).toMatch(/Do not submit or upload anything to Canvas/)
  })

  it("provides distinct assignment modes and maps requirements in each", () => {
    const outline = workflowFor("assignment", "outline")
    const draft = workflowFor("assignment", "draft")
    const review = workflowFor("assignment", "review")

    expect(outline.requiredSections).toEqual([
      "Assignment requirements",
      "Outline",
      "Open questions",
      "Sources",
    ])
    expect(draft.requiredSections).toEqual([
      "Assignment requirements",
      "Draft",
      "Open questions",
      "Sources",
    ])
    expect(review.requiredSections).toEqual([
      "Assignment requirements",
      "Review",
      "Suggested revisions",
      "Open questions",
      "Sources",
    ])
    for (const workflow of [outline, draft, review]) {
      expect(workflow.version).toBe(1)
      expect(workflow.instructions.join(" ")).toMatch(
        /explicit assignment-prompt and rubric requirement/,
      )
      expect(workflow.instructions.join(" ")).toMatch(
        /explicitly permits|explicit in the supplied guidance/,
      )
      expect(workflow.instructions.join(" ")).toMatch(/Do not submit or upload anything to Canvas/)
    }
    expect(outline.instructions.join(" ")).toMatch(/Do not write a complete submission/)
    expect(draft.instructions.join(" ")).toMatch(/Never invent personal experiences, data, results/)
    expect(review.instructions.join(" ")).toMatch(/Critique only student work that was supplied/)
    expect(review.instructions.join(" ")).toMatch(/do not replace or rewrite the work/)
  })

  it("rejects missing or mismatched modes", () => {
    expect(() => workflowFor("assignment")).toThrow(/explicit mode/)
    expect(() => workflowFor("prep", "draft")).toThrow(/does not accept/)
    expect(() => workflowFor("assignment", "other" as never)).toThrow(/Unsupported assignment mode/)
    expect(() => workflowFor("assignment", "__proto__" as never)).toThrow(
      /Unsupported assignment mode/,
    )
  })

  it("returns fresh arrays so callers cannot mutate later workflow results", () => {
    const first = workflowFor("prep")
    first.instructions.push("caller mutation")
    first.requiredSections.pop()

    const second = workflowFor("prep")
    expect(second.instructions).not.toContain("caller mutation")
    expect(second.requiredSections).toEqual([
      "Summary",
      "Key concepts",
      "Discussion questions",
      "Sources",
    ])
  })
})
