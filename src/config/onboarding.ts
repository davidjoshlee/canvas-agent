import {
  isCanvasDiscoveryUnavailable,
  listActiveCourses,
  listConcludedCourses,
  listCourses,
  probeUnresolvedPilotCourse,
  verifyAuth,
} from "../canvas/sync.js"
import type { ToolkitConfig } from "../shared/types.js"
import { saveAllowlist } from "./index.js"

export async function selectOnboardingCourses(
  configPath: string,
  config: ToolkitConfig,
  selection: { ids?: string[]; allActive?: boolean; pilot?: boolean },
): Promise<{
  selected: string[]
  courses: Array<{ id: string; code: string; name: string }>
  warning?: string
  pilotEligibility?: {
    basis: "completed-enrollment" | "assignment-date-span-and-own-feedback"
    dateSpanDays?: number
    gradedAssignmentId?: string
  }
}> {
  if (!selection.allActive && !selection.ids?.length)
    throw new Error("Select one or more --course IDs, or use --all-active explicitly")
  if (selection.allActive && selection.ids?.length)
    throw new Error("Choose explicit course IDs or --all-active, not both")
  if (selection.pilot) {
    if (selection.allActive || selection.ids?.length !== 1)
      throw new Error("Pilot onboarding requires exactly one explicit concluded course ID")
    const id = selection.ids[0]
    if (!id || !/^[1-9]\d*$/.test(id))
      throw new Error("Pilot course needs an exact numeric Canvas ID")
    const concluded = await listConcludedCourses(config)
    const matches = concluded.filter((course) => String(course.id) === id)
    if (matches.length > 1) throw new Error("Pilot course discovery is ambiguous")
    let course = matches[0]
    let pilotEligibility: NonNullable<
      Awaited<ReturnType<typeof selectOnboardingCourses>>["pilotEligibility"]
    > = { basis: "completed-enrollment" }
    if (!course) {
      if ((await listActiveCourses(config)).some((active) => active.id === id))
        throw new Error("Known active course cannot be selected as a concluded/unresolved pilot")
      const probe = await probeUnresolvedPilotCourse(config, id)
      course = { id, course_code: probe.code, name: probe.name }
      pilotEligibility = {
        basis: "assignment-date-span-and-own-feedback",
        dateSpanDays: probe.dateSpanDays,
        gradedAssignmentId: probe.gradedAssignmentId,
      }
    }
    await saveAllowlist(configPath, [id])
    return {
      selected: [id],
      pilotEligibility,
      courses: [
        {
          id,
          code: String(course.course_code ?? id),
          name: String(course.name ?? course.course_code ?? id),
        },
      ],
      warning:
        "Selected one explicit pilot course. Existing files are preserved; date span and cached feedback do not reconstruct historical contents, authorship or permissions.",
    }
  }
  const active = await listActiveCourses(config)
  let discovered: Awaited<ReturnType<typeof listCourses>>
  let discoveryGap = false
  try {
    discovered = await listCourses(config)
  } catch (error) {
    if (!isCanvasDiscoveryUnavailable(error)) throw error
    await verifyAuth(config)
    discovered = active
    discoveryGap = true
  }
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
    ...(selection.allActive || discoveryGap
      ? {
          warning: [
            ...(selection.allActive
              ? [`Selected all ${selected.length} active course(s) explicitly with --all-active.`]
              : []),
            ...(discoveryGap
              ? [
                  "General course discovery is unavailable (HTTP 403/404); selection uses the successful active-enrollment list after API profile verification. This is a coverage gap, not complete course access or academic permission.",
                ]
              : []),
          ].join(" "),
        }
      : {}),
  }
}
