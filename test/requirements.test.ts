import { describe, expect, it } from "vitest"
import { resolveRequirements } from "../src/requirements.js"
import type { SourceRecord } from "../src/types.js"

const source = (path: string, text: string, type = "reading"): SourceRecord => ({
  path,
  title: path,
  hash: "a".repeat(64),
  text,
  type,
  dates: [],
})

describe("prep requirement resolution", () => {
  it("uses the course's enumerated brief structure and stops at the next H2", () => {
    const guidance = source(
      "GSB-101/guidance.md",
      "## Brief structure (required)\nIntroductory note.\n- Executive summary\n- Frameworks\n### Case application\n\n## Citation style\n- Chicago",
      "guidance",
    )
    expect(resolveRequirements("prep", undefined, [], [guidance]).sections).toEqual([
      "Executive summary",
      "Frameworks",
      "Case application",
      "Sources",
    ])
  })

  it("extracts questions without disturbing the selected source order", () => {
    const prompt = source(
      "GSB-101/Week/session.md",
      "## Questions\n1. What explains the outcome?",
      "module",
    )
    const linked = source(
      "GSB-101/Week/reading.md",
      "## Discussion questions\n- Which evidence matters?",
    )
    const result = resolveRequirements("prep", undefined, [prompt, linked], [])
    expect(result.questions).toEqual(["What explains the outcome?", "Which evidence matters?"])
  })

  it("fails closed instead of silently dropping questions beyond the validation limit", () => {
    const questions = Array.from(
      { length: 41 },
      (_, index) => `- What is question ${index + 1}?`,
    ).join("\n")
    expect(() =>
      resolveRequirements(
        "prep",
        undefined,
        [source("GSB-101/Week/session.md", `## Questions\n${questions}`)],
        [],
      ),
    ).toThrow(/41 prep questions.*at most 40/)
  })
})
