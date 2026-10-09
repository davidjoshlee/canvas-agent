import { listActiveCourses, listCourses } from "./canvas.js"
import { saveAllowlist } from "./config.js"
import type { ToolkitConfig } from "./types.js"

export async function selectOnboardingCourses(
  configPath: string,
  config: ToolkitConfig,
  selection: { ids?: string[]; allActive?: boolean },
): Promise<{
  selected: string[]
  courses: Array<{ id: string; code: string; name: string }>
  warning?: string
}> {
  if (!selection.allActive && !selection.ids?.length)
    throw new Error("Select one or more --course IDs, or use --all-active explicitly")
  if (selection.allActive && selection.ids?.length)
    throw new Error("Choose explicit course IDs or --all-active, not both")
  const active = await listActiveCourses(config)
  const discovered = await listCourses(config)
  const activeById = new Map(active.map((course) => [course.id, course]))
  const discoveredIds = new Set(discovered.map((course) => course.id))
  let selected: string[]
  if (selection.allActive) {
    selected = active.map((course) => course.id)
  } else {
    selected = [...new Set((selection.ids ?? []).map(String))]
    const invalid = selected.filter((id) => !activeById.has(id) || !discoveredIds.has(id))
    if (invalid.length)
      throw new Error(`Course IDs must be discovered and active: ${invalid.join(", ")}`)
  }
  await saveAllowlist(configPath, selected)
  const courses = selected.flatMap((id) => {
    const course = activeById.get(id)
    return course ? [course] : []
  })
  return {
    selected,
    courses,
    ...(selection.allActive
      ? {
          warning: `Selected all ${selected.length} active course(s) explicitly with --all-active.`,
        }
      : {}),
  }
}
