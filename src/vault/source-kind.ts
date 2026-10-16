import type { SourceRecord } from "../shared/types.js"

/**
 * Coarse document roles used by vault consumers. `SourceRecord.type` predates
 * this interface and contains both Canvas roles and inferred file labels, so
 * callers should classify once here instead of mixing role and path regexes.
 */
export type SourceKind =
  | "assignment"
  | "announcement"
  | "module"
  | "syllabus"
  | "feedback"
  | "student-work"
  | "other"

const roleAliases: Record<string, SourceKind> = {
  assignment: "assignment",
  assignments: "assignment",
  announcement: "announcement",
  announcements: "announcement",
  module: "module",
  modules: "module",
  session: "module",
  sessions: "module",
  milestone: "module",
  milestones: "module",
  syllabus: "syllabus",
  syllabi: "syllabus",
  feedback: "feedback",
  "student-work": "student-work",
  "student-work-document": "student-work",
}

const pathFallbackTypes = new Set([
  "",
  "document",
  "resource",
  "week",
  "md",
  ".md",
  "markdown",
  ".markdown",
  "txt",
  ".txt",
  "pdf",
  ".pdf",
  "docx",
  ".docx",
  "html",
  ".html",
])

function normalizedType(type: string): string {
  return type
    .trim()
    .toLocaleLowerCase()
    .replace(/\.(?:md|markdown|txt)$/i, "")
}

function legacyPathKind(path: string): SourceKind {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean)
  const folders = parts.slice(0, -1).map((part) => part.trim().toLocaleLowerCase())
  const name = (parts.at(-1) ?? "").toLocaleLowerCase()
  if (folders.some((part) => /^(?:assignments?|assignment\s)/.test(part))) return "assignment"
  if (folders.some((part) => /^(?:announcements?|discussion\s*topics?)$/.test(part)))
    return "announcement"
  if (folders.some((part) => /^(?:modules?|sessions?|milestones?)$/.test(part))) return "module"
  if (
    folders.some((part) => /^(?:syllabus|syllabi)$/.test(part)) ||
    /^syllabus(?:[-_. ]|$)/.test(name)
  )
    return "syllabus"
  if (folders.some((part) => /^feedback$/.test(part)) || /\.(?:feedback|summary)\.md$/i.test(name))
    return "feedback"
  return "other"
}

/** Canonical recognized type wins; path meaning is only an old-format adapter. */
export function sourceKind(
  source: Pick<SourceRecord, "path" | "type"> &
    Partial<Pick<SourceRecord, "moduleCanvasId" | "modulePosition" | "moduleDates">>,
): SourceKind {
  const type = normalizedType(source.type)
  const explicit = Object.hasOwn(roleAliases, type) ? roleAliases[type] : undefined
  if (explicit) return explicit

  // Imported children may live beside module index files. Their membership
  // marker must prevent generic path fallback from promoting them to indexes.
  if (source.moduleCanvasId !== undefined) return "other"

  // Position and teaching dates describe a module index itself.
  if (source.modulePosition !== undefined || source.moduleDates !== undefined) return "module"

  if (!pathFallbackTypes.has(type)) return "other"
  return legacyPathKind(source.path)
}

/** Exact decoder for the module-type regex used by persisted task recipes. */
export function isLegacyTaskModuleSource(source: Pick<SourceRecord, "type">): boolean {
  return /module|session|milestone/i.test(source.type)
}

export const isAssignmentSource = (source: Parameters<typeof sourceKind>[0]) =>
  sourceKind(source) === "assignment"
export const isAnnouncementSource = (source: Parameters<typeof sourceKind>[0]) =>
  sourceKind(source) === "announcement"
export const isTeachingModuleSource = (source: Parameters<typeof sourceKind>[0]) =>
  sourceKind(source) === "module"
export const isSyllabusSource = (source: Parameters<typeof sourceKind>[0]) =>
  sourceKind(source) === "syllabus"
export const isFeedbackSource = (source: Parameters<typeof sourceKind>[0]) =>
  sourceKind(source) === "feedback"
export const isStudentWorkSource = (source: Parameters<typeof sourceKind>[0]) =>
  sourceKind(source) === "student-work"
