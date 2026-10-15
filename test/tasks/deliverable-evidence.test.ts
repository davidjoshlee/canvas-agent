import { describe, expect, it } from "vitest"
import {
  captureDeliverable,
  DeliverableEvidenceSchema,
} from "../../src/tasks/deliverable-evidence.js"

const source = (text: string, path = "CS101/assignment.md") => ({ text, path })
describe("bounded source-derived deliverable evidence", () => {
  it("captures imperatives, wrapped prose and stable source identity without requiring question marks", () => {
    expect(
      captureDeliverable(
        [source("Required:\n1. Calculate the baseline\n   contribution.\n2. Recommend a test.")],
        [],
      ),
    ).toEqual({
      version: 1,
      kind: "requirements",
      cue: "Required:",
      sourcePath: "CS101/assignment.md",
      items: [
        { id: "1", text: "Calculate the baseline contribution." },
        { id: "2", text: "Recommend a test." },
      ],
    })
  })
  it("honors an explicit guidance suppression, never a suppression in reference material", () => {
    const prompt = source("Required: 1. Explain the result.")
    for (const text of [
      "## Deliverable\nnone",
      "## Deliverable\nNONE\n\n## Notes\nDiscuss uncertainty.",
    ])
      expect(
        captureDeliverable([prompt], [source(text, "CS101/guidance/prep-guidance.md")]),
      ).toEqual({ version: 1, kind: "none", suppressed: true })
    for (const text of [
      "The deliverable is none of these.",
      "## Deliverable\nnone except the memo.",
    ])
      expect(captureDeliverable([prompt], [source(text)])).toHaveProperty("kind", "requirements")
    expect(
      captureDeliverable([source("## Deliverable\nnone\n\nRequired: 1. Explain the result.")], []),
    ).toHaveProperty("kind", "requirements")
  })
  it("preserves exact part scope and does not turn numbered facts into deliverables", () => {
    const prompt = source(
      "Facts: 1. Revenue rose. 2. Costs fell. Required: PART I: Summarize the evidence. PART II: (a) Build a schedule. (b) Explain limitations.",
    )
    expect(captureDeliverable([prompt], [], "PART II")).toMatchObject({
      items: [
        { id: "a", text: "Build a schedule." },
        { id: "b", text: "Explain limitations." },
      ],
    })
    expect(captureDeliverable([source("Facts: 1. Revenue rose. 2. Costs fell.")], [])).toEqual({
      version: 1,
      kind: "none",
      suppressed: false,
    })
    expect(captureDeliverable([prompt], [], "PART III")).toHaveProperty("kind", "none")
  })
  it("fails bounded inputs/outputs without echoing source bodies or silently truncating", () => {
    const secret = "PRIVATE_SYNTHETIC_MARKER"
    for (const sources of [
      Array.from({ length: 501 }, () => source(secret)),
      [source(secret + "x".repeat(5_000_000))],
      [
        source(
          `Required: ${Array.from({ length: 41 }, (_, i) => `${i + 1}. ${secret}`).join(" ")}`,
        ),
      ],
    ]) {
      expect(() => captureDeliverable(sources, [])).toThrow(/bounds/)
      try {
        captureDeliverable(sources, [])
      } catch (error) {
        expect(String(error)).not.toContain(secret)
      }
    }
    expect(() => captureDeliverable([], [], secret)).toThrow("part scope is unsupported")
    expect(
      DeliverableEvidenceSchema.safeParse({
        version: 1,
        kind: "none",
        suppressed: false,
        sourceBody: secret,
      }).success,
    ).toBe(false)
  })
})
