import { basename } from "node:path"
import { isRestrictedGuidanceExclusion } from "../shared/exclusions.js"
import type { CourseContext, SourceRecord } from "../shared/types.js"

export function restrictedGuidancePaths(course: Pick<CourseContext, "excluded">): string[] {
  return course.excluded
    .filter(
      (entry) =>
        isRestrictedGuidanceExclusion(entry) &&
        (/(?:^|\/)guidance\/[^/]+\.(?:md|markdown|txt)$/i.test(entry.path) ||
          /^(?:AGENTS\.md|[^/]+\/AGENTS\.md)$/i.test(entry.path)) &&
        !/(?:\.proposed\.|\/proposed-|-proposal\.md$)/i.test(entry.path),
    )
    .map((entry) => entry.path)
}

/** Read-only source metadata, not instructor authentication or AI permission. */
export function guidanceAssignmentIdentity(source: SourceRecord): string | undefined {
  const name = basename(source.path).toLowerCase()
  const named = name.match(/^assignment-([1-9]\d{0,39})\.md$/)?.[1]
  let linked: string | undefined
  if (source.canvasUrl) {
    const url = new URL(source.canvasUrl)
    const course = url.pathname.match(/^\/courses\/([1-9]\d{0,39})\/?$/)?.[1]
    if (course) {
      if (source.canvasId && course !== source.canvasId)
        throw new Error("Guidance course identity conflicts; inspect the source metadata")
      return undefined
    }
    linked = url.pathname.match(/^\/courses\/\d+\/assignments\/([1-9]\d{0,39})\/?$/)?.[1]
  }
  const declared =
    linked ||
    named ||
    (/-guidance\.md$/.test(name) && !["prep-guidance.md", "course-guidance.md"].includes(name)
      ? source.canvasId
      : undefined)
  if (declared && source.canvasId && declared !== source.canvasId)
    throw new Error("Guidance assignment identity conflicts; inspect the source metadata")
  return declared
}

export function selectTaskGuidance(
  kind: "prep" | "assignment",
  guidance: SourceRecord[],
  prompt?: SourceRecord,
  explicitPaths: string[] = [],
): SourceRecord[] {
  return guidance.filter((source) => {
    const owner = guidanceAssignmentIdentity(source)
    const selected = !owner || (kind === "assignment" && prompt?.canvasId === owner)
    if (!selected && explicitPaths.includes(source.path))
      throw new Error(
        "Explicit guidance is bound to another assignment or has no matching prompt identity",
      )
    return selected
  })
}
