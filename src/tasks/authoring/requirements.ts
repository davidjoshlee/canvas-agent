import { guidanceAssignmentIdentity } from "../../guidance/selection.js"
import type { SourceRecord } from "../../shared/types.js"
import type { DeliverableEvidence } from "../evidence/deliverable-evidence.js"

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

/** Explicit declarations only; unlike resolveRequirements this never supplies defaults. */
export function declaredPrepSections(text: string): string[] {
  return declaredSections(text, "prep")
}

/** Whether plain/comma-separated prep declarations need the new persisted parser recipe. */
export function needsPrepStructureVersion(guidance: SourceRecord[]): boolean {
  const text = guidance.map((item) => item.text).join("\n\n")
  return JSON.stringify(declaredSections(text)) !== JSON.stringify(declaredSections(text, "prep"))
}

/** Resolve only explicitly declared brief headings and plainly enumerated questions. */
export interface ResolveRequirementsOptions {
  kind: "prep" | "assignment"
  mode?: "outline" | "draft" | "review" | "discuss"
  sources: SourceRecord[]
  guidance: SourceRecord[]
  parserVersion?: 1 | 2
  deliverable?: DeliverableEvidence
  assignmentStructureVersion?: 1
  prepStructureVersion?: 1
}

export function resolveRequirements(options: ResolveRequirementsOptions): ResolvedRequirements {
  const {
    kind,
    mode,
    sources,
    guidance,
    parserVersion = 2,
    deliverable,
    assignmentStructureVersion,
    prepStructureVersion,
  } = options
  const prep = kind === "prep"
  if (prepStructureVersion && !prep) throw new Error("Prep structure recipe requires prep mode")
  let headings = prep
    ? declaredSections(
        guidance.map((item) => item.text).join("\n\n"),
        prepStructureVersion ? "prep" : false,
      )
    : []
  if (assignmentStructureVersion) {
    if (kind !== "assignment" || mode !== "draft")
      throw new Error("Assignment structure recipe requires draft mode")
    const declarations = guidance
      .filter(
        (source) =>
          sources[0]?.canvasId && guidanceAssignmentIdentity(source) === sources[0].canvasId,
      )
      .map((source) => declaredSections(source.text, true))
      .filter((sections) => sections.length)
    if (new Set(declarations.map((sections) => JSON.stringify(sections))).size > 1)
      throw new Error(
        "Matching assignment guides declare conflicting output structures; review them",
      )
    headings = declarations[0] ?? []
  }
  const sections = headings.length
    ? headings.some((heading) => heading.toLocaleLowerCase() === "sources")
      ? headings
      : [...headings, "Sources"]
    : prep
      ? [...DEFAULT_PREP]
      : mode === "discuss"
        ? ["Student question", "Discussion", "Open questions", "Sources"]
        : mode === "review"
          ? [
              "Assignment requirements",
              "Review",
              "Suggested revisions",
              "Open questions",
              "Sources",
            ]
          : [
              "Assignment requirements",
              mode === "outline" ? "Outline" : "Draft",
              "Open questions",
              "Sources",
            ]
  const questionSources =
    mode === "discuss"
      ? []
      : kind === "assignment"
        ? sources.filter(
            (source, index) =>
              index === 0 ||
              source.type.toLocaleLowerCase().includes("assignment") ||
              /question/i.test(`${source.path} ${source.title}`),
          )
        : sources
  const questions =
    deliverable?.kind === "none" && deliverable.suppressed
      ? []
      : deliverable?.scope && deliverable.kind !== "none"
        ? deliverable.items.map((item) => item.text).filter((text) => text.endsWith("?"))
        : extractQuestions(questionSources, kind, parserVersion)
  const guidanceInstructions = guidance
    .flatMap((item) => {
      const matched =
        assignmentStructureVersion &&
        sources[0]?.canvasId &&
        guidanceAssignmentIdentity(item) === sources[0].canvasId
      return (matched ? withoutAssignmentStructure(item.text) : item.text).split(/\r?\n/)
    })
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, ""))
  return { sections, questions, guidanceInstructions }
}

function withoutAssignmentStructure(text: string): string {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    /^##\s+(?:Brief structure|Prep brief structure|Assignment structure)(?:\s*\([^)]*\))?\s*$/i.test(
      line.trim(),
    ),
  )
  if (start < 0) return text
  const next = lines.findIndex((line, index) => index > start && /^##\s+/.test(line.trim()))
  return [...lines.slice(0, start), ...(next < 0 ? [] : lines.slice(next))].join("\n")
}

function declaredSections(guidance: string, plainNames: boolean | "prep" = false): string[] {
  const lines = guidance.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    (plainNames === true
      ? /^##\s+(?:Brief structure|Prep brief structure|Assignment structure)(?:\s*\([^)]*\))?\s*$/i
      : /^##\s+(?:Brief structure|Prep brief structure)(?:\s*\([^)]*\))?\s*$/i
    ).test(line.trim()),
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
    // Unmarked sentence-style instructions are prose, not plain section names.
    // Explicit headings/items remain declarations even when punctuated.
    const uncitedLine = line.replace(/(?:\s+`[^`]+`)+\s*$/, "").trim()
    if (plainNames === "prep" && !heading && !item && /[.!?;:]$/.test(uncitedLine)) continue
    for (const value of plainNames
      ? (heading ?? item ?? line).split(",")
      : [heading ?? item ?? ""]) {
      const name = value.trim()
      if (plainNames === "prep") {
        if (
          !name ||
          name.length > 100 ||
          /[<>`#[\]*_~|]/.test(name) ||
          [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
          !/[\p{L}\p{N}]/u.test(name)
        ) {
          if (name) throw new Error("Declared prep heading is unsafe or exceeds bounds")
          continue
        }
      } else if (!name || name.length > 100 || /[<>`]/.test(name)) {
        if (plainNames && name)
          throw new Error("Declared assignment heading is unsafe or exceeds bounds")
        continue
      }
      const key = name.toLocaleLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      result.push(name)
      if (plainNames && result.length > 40)
        throw new Error(
          `Declared ${plainNames === "prep" ? "prep" : "assignment"} structure exceeds 40 headings`,
        )
    }
  }
  return result
}

function extractQuestions(
  sources: SourceRecord[],
  kind: "prep" | "assignment",
  parserVersion: 1 | 2,
): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    let capture = false
    for (const line of (parserVersion === 1 ? source.text : questionText(source.text)).split(
      /\r?\n/,
    )) {
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

// Legacy School Agent snapshots can retain Canvas HTML. Preserve list and
// heading semantics for question detection without executing or rewriting it.
export function questionText(text: string): string {
  if (
    !/<\/?(?:p|div|h[1-6]|ol|ul|li|span|strong|em|a|br|script|style|iframe|object|embed|noscript)\b/i.test(
      text,
    )
  )
    return text
  return text
    .replace(/<(script|style|iframe|object|embed|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<h[1-6]\b[^>]*>/gi, "\n## ")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) => {
      const value = code.toLowerCase().startsWith("x")
        ? Number.parseInt(code.slice(1), 16)
        : Number(code)
      return value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
        ? String.fromCodePoint(value)
        : " "
    })
}
