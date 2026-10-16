import { isAbsolute, resolve, sep } from "node:path"
import type { CourseContext, SourceRecord } from "../shared/types.js"
import { isLegacyTaskModuleSource } from "../vault/source-kind.js"

const MAX_RELATED = 40

/** School's assignment context includes owning modules and the preceding teaching
 * module. Use explicit membership and persisted directory order, never title
 * guesses or an unrelated globally nearest document. */
export function assignmentRelatedSources(
  course: CourseContext,
  prompt: SourceRecord,
  explicitContext: string[] = [],
): SourceRecord[] {
  const root = `${course.root}/`
  const modules = course.sources.filter(
    (source) =>
      source.path.startsWith(root) &&
      isLegacyTaskModuleSource(source) &&
      !/(?:^|\/)(?:prep|drafts?|proposed)(?:\/|$)/i.test(source.path),
  )
  const owners = modules.filter(
    (source) =>
      (prompt.moduleCanvasId !== undefined &&
        prompt.moduleCanvasId === (source.moduleCanvasId ?? source.canvasId)) ||
      (source.relatedPaths ?? []).some(
        (path) => (path.startsWith(root) ? path : root + path) === prompt.path,
      ),
  )
  if (!owners.length) return relatedSources(course, [prompt])
  const position = (source: SourceRecord) => {
    if (source.modulePosition !== undefined) {
      if (!Number.isSafeInteger(source.modulePosition) || source.modulePosition < 1)
        throw new Error("Teaching module order is invalid")
      return source.modulePosition
    }
    const path = source.path.slice(root.length)
    const match =
      path.match(/(?:^|\/)(\d+)-/) ?? path.match(/(?:^|\/)(?:Week|Milestone)\s+(\d+)(?:\s+-|\/)/i)
    const value = match?.[1] === undefined ? 0 : Number(match[1])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Teaching module order is invalid")
    return value
  }
  const identity = (source: SourceRecord) => source.moduleCanvasId ?? source.canvasId ?? source.path
  const ownerIds = new Set(owners.map(identity))
  const owning = modules.filter((source) => ownerIds.has(identity(source)))
  const first = Math.min(...owning.map(position))
  const preceding = modules.filter(
    (source) => !ownerIds.has(identity(source)) && position(source) > 0 && position(source) < first,
  )
  const latest = preceding.length ? Math.max(...preceding.map(position)) : undefined
  let previous =
    latest === undefined ? [] : preceding.filter((source) => position(source) === latest)
  if (new Set(previous.map(identity)).size > 1) {
    const selected = new Set(
      previous.filter((source) => explicitContext.includes(source.path)).map(identity),
    )
    if (selected.size !== 1)
      throw new Error(
        "Preceding teaching module is ambiguous; select one module path explicitly with --context",
      )
    previous = previous.filter((source) => selected.has(identity(source)))
  }
  return relatedSources(course, [prompt, ...owning, ...previous])
}

/** Expand only explicit, same-course relationships attached to supplied seed records. */
export function relatedSources(course: CourseContext, seeds: SourceRecord[]): SourceRecord[] {
  const approved = new Map(course.sources.map((source) => [source.path, source]))
  const root = `${course.root}/`
  const queue = seeds.filter((source) => approved.has(source.path)).map((source) => source.path)
  const found = new Map<string, SourceRecord>()
  const visited = new Set<string>()
  while (queue.length && visited.size < MAX_RELATED) {
    const path = queue.shift()
    if (!path) break
    if (visited.has(path)) continue
    visited.add(path)
    const source = approved.get(path)
    if (!source) continue
    found.set(path, source)
    for (const related of source.relatedPaths ?? []) {
      if (isAbsolute(related) || related.startsWith("/") || related.split("/").includes(".."))
        continue
      const local = related.startsWith(root) ? related.slice(root.length) : related
      const absolute = resolve(course.root, local)
      if (!absolute.startsWith(resolve(course.root) + sep)) continue
      const targetPath = `${course.root}/${local}`
      // Workspace inspection reports unavailable links as notices. Keep them out
      // of the evidence graph; silently fetching or trusting them is not allowed.
      if (targetPath.startsWith(root) && approved.has(targetPath) && !visited.has(targetPath))
        queue.push(targetPath)
    }
  }
  if (queue.length) {
    throw new Error(
      `Module context includes more than ${MAX_RELATED} approved sources; narrow the selected module.`,
    )
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path))
}
