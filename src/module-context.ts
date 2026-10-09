import { isAbsolute, resolve, sep } from "node:path"
import type { CourseContext, SourceRecord } from "./types.js"

const MAX_RELATED = 40

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
