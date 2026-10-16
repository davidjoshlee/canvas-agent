import type { TaskRecord } from "../../shared/types.js"
import { type AssignmentMode, assignmentOutputLabel } from "../authoring/workflows.js"

export type AcademicArtifactKind = "prep" | "assignment-draft" | "assignment-final"

/** Stable names shared by artifact writers, readers, and presence checks. */
export function artifactBaseName(
  kind: AcademicArtifactKind,
  mode: AssignmentMode = "draft",
): string {
  if (kind === "prep") return "01 Prep Brief.md"
  if (kind === "assignment-final") return "01 Assignment Final.md"
  return `01 Assignment ${assignmentOutputLabel(mode)}.md`
}

/** Parse the canonical filename and its supported v2+ siblings. */
export function parseArtifactVersion(
  filename: string,
  baseName: string,
  allowLegacyV1Suffix = false,
): number | undefined {
  const normalizedBase = baseName.endsWith(".md") ? baseName : `${baseName}.md`
  if (filename === normalizedBase) return 1
  const stem = normalizedBase.slice(0, -3)
  if (allowLegacyV1Suffix && filename === `${stem}.v1.md`) return 1
  const match = new RegExp(`^${escapeRegExp(stem)}\\.v([2-9]|[1-9]\\d+)\\.md$`).exec(filename)
  if (!match?.[1]) return undefined
  const version = Number(match[1])
  return Number.isSafeInteger(version) ? version : undefined
}

/** Format a version number without creating alternate spellings for v1. */
export function formatArtifactName(baseName: string, version: number): string {
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error("Artifact version must be a positive safe integer")
  return version === 1 ? baseName : `${baseName.slice(0, -3)}.v${version}.md`
}

/** Find the first free artifact version, also reserving a companion workbook. */
export function nextArtifactName(
  baseName: string,
  existingNames: readonly string[],
  reserveWorkbook = false,
): string {
  const occupied = new Set(existingNames)
  for (let version = 1; version <= Number.MAX_SAFE_INTEGER; version++) {
    const name = formatArtifactName(baseName, version)
    if (occupied.has(name)) continue
    if (reserveWorkbook && occupied.has(name.replace(/\.md$/, ".xlsx"))) continue
    return name
  }
  throw new Error("No free safe-integer artifact filename is available")
}

export function assignmentDraftsDirectory(sourcePath: string): string {
  return `${sourcePath.slice(0, sourcePath.lastIndexOf("/"))}/Drafts`
}

export function assignmentFinalsDirectory(draftsPath: string): string {
  return `${draftsPath.slice(0, draftsPath.lastIndexOf("/"))}/Finals`
}

export function legacyAssignmentDraftsDirectory(courseRoot: string): string {
  return `${courseRoot}/Drafts`
}

export function taskArtifactBaseName(task: Pick<TaskRecord, "kind" | "assignment">): string {
  return task.kind === "prep"
    ? artifactBaseName("prep")
    : artifactBaseName("assignment-draft", task.assignment?.mode ?? "review")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
