import type { SourceRecord } from "./types.js"

export interface ResolvedRequirements {
  sections: string[]
  questions: string[]
  guidanceInstructions: string[]
}

const DEFAULT_PREP = [
  "Overview",
  "Reading synthesis",
  "Key concepts",
  "Preparation questions",
  "Discussion points",
  "Sources",
]

/** Resolve only explicitly declared brief headings and plainly enumerated questions. */
export function resolveRequirements(
  kind: "prep" | "assignment",
  mode: "outline" | "draft" | "review" | undefined,
  sources: SourceRecord[],
  guidance: SourceRecord[],
): ResolvedRequirements {
  const prep = kind === "prep"
  const headings = prep ? declaredSections(guidance.map((item) => item.text).join("\n\n")) : []
  const sections = headings.length
    ? headings.some((heading) => heading.toLocaleLowerCase() === "sources")
      ? headings
      : [...headings, "Sources"]
    : prep
      ? [...DEFAULT_PREP]
      : mode === "review"
        ? ["Assignment requirements", "Review", "Suggested revisions", "Open questions", "Sources"]
        : [
            "Assignment requirements",
            mode === "outline" ? "Outline" : "Draft",
            "Open questions",
            "Sources",
          ]
  const questionSources =
    kind === "assignment"
      ? sources.filter(
          (source, index) =>
            index === 0 ||
            source.type.toLocaleLowerCase().includes("assignment") ||
            /question/i.test(`${source.path} ${source.title}`),
        )
      : sources
  const questions = extractQuestions(questionSources, kind)
  const guidanceInstructions = guidance
    .flatMap((item) => item.text.split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, ""))
  return { sections, questions, guidanceInstructions }
}

function declaredSections(guidance: string): string[] {
  const lines = guidance.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    /^##\s+(?:Brief structure|Prep brief structure)(?:\s*\([^)]*\))?\s*$/i.test(line.trim()),
  )
  if (start < 0) return []
  const content: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line.trim())) break
    content.push(line)
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of content) {
    const line = raw.trim()
    if (!line) continue
    const heading = line.match(/^#{3,6}\s+(.+?)\s*$/)?.[1]
    const item = line.match(/^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/)?.[1]
    // Only headings and explicitly enumerated items declare the brief structure;
    // explanatory prose beneath the structure heading is not a section name.
    const name = (heading ?? item ?? "").trim()
    if (!name || name.length > 100 || /[<>`]/.test(name)) continue
    const key = name.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(name)
  }
  return result
}

function extractQuestions(sources: SourceRecord[], kind: "prep" | "assignment"): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    let capture = false
    for (const line of source.text.split(/\r?\n/)) {
      const heading = line.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim() ?? ""
      if (heading)
        capture =
          /(?:preparation|discussion|assignment|case)?\s*questions?(?:\s+for\s+discussion)?/i.test(
            heading,
          )
      const question = line
        .trim()
        .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "")
        .trim()
      if (!question || question.length > 500 || !question.endsWith("?")) continue
      // Questions are taken from the designated question section or from an explicit numbered prompt.
      const explicitlyNumbered = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line)
      if (!capture && !explicitlyNumbered) continue
      const key = question.toLocaleLowerCase().replace(/\s+/g, " ")
      if (!seen.has(key)) {
        seen.add(key)
        result.push(question)
      }
    }
  }
  if (result.length > 40)
    throw new Error(
      `Found ${result.length} ${kind} questions; narrow the selected materials because at most 40 can be validated`,
    )
  return result
}
