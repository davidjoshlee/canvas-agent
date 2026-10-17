import { describe, expect, it } from "vitest"
import type { SourceRecord } from "../../src/shared/types.js"
import { resolveRequirements } from "../../src/tasks/authoring/requirements.js"

const source = (path: string, text: string, type = "reading"): SourceRecord => ({
  path,
  title: path,
  hash: "a".repeat(64),
  text,
  type,
  dates: [],
})

describe("prep requirement resolution", () => {
  it("does not strip plain-text mathematical comparisons as HTML", () => {
    expect(
      resolveRequirements({
        kind: "prep",
        sources: [source("GSB-101/session.md", "1. Does a < b imply b > a?")],
        guidance: [],
      }).questions,
    ).toEqual(["Does a < b imply b > a?"])
  })
  it("extracts HTML Canvas questions and ignores script/style/comment content", () => {
    const html =
      "<style><li>Hidden style?</li></style><script><li>Hidden script?</li></script><!-- <li>Hidden comment?</li> --><h2>Preparation questions</h2><ol><li><strong>What drives growth &amp; margin?</strong></li><li><p>Which evidence is strongest&#63;</p></li></ol><h2>Background</h2><p>A rhetorical question?</p>"
    expect(
      resolveRequirements({
        kind: "prep",
        sources: [source("GSB-101/session.md", html)],
        guidance: [],
      }).questions,
    ).toEqual(["What drives growth & margin?", "Which evidence is strongest?"])
  })
  it("uses the course's enumerated brief structure and stops at the next H2", () => {
    const guidance = source(
      "GSB-101/guidance.md",
      "## Brief structure (required)\nIntroductory note.\n- Executive summary\n- Frameworks\n### Case application\n\n## Citation style\n- Chicago",
      "guidance",
    )
    expect(
      resolveRequirements({ kind: "prep", sources: [], guidance: [guidance] }).sections,
    ).toEqual(["Executive summary", "Frameworks", "Case application", "Sources"])
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
    const result = resolveRequirements({ kind: "prep", sources: [prompt, linked], guidance: [] })
    expect(result.questions).toEqual(["What explains the outcome?", "Which evidence matters?"])
  })

  it("fails closed instead of silently dropping questions beyond the validation limit", () => {
    const questions = Array.from(
      { length: 41 },
      (_, index) => `- What is question ${index + 1}?`,
    ).join("\n")
    expect(() =>
      resolveRequirements({
        kind: "prep",
        sources: [source("GSB-101/Week/session.md", `## Questions\n${questions}`)],
        guidance: [],
      }),
    ).toThrow(/41 prep questions.*at most 40/)
  })
})
