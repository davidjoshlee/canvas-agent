import { resolve } from "node:path"
import type { ToolkitConfig } from "../shared/types.js"
import { notifyDueSoon, planDueSoon, saveDueSoon } from "../student/reminders.js"
import { inspectWorkspace } from "../vault/workspace.js"
import { type CanvasClient, createCanvasClient } from "./client.js"
import { type SyncReport, syncCourses } from "./sync.js"

export interface SyncWorkflowReport extends SyncReport {
  dueSoon?:
    | {
        status: "saved"
        receipt: Awaited<ReturnType<typeof saveDueSoon>>
        notification: Awaited<ReturnType<typeof notifyDueSoon>> | "not-requested"
      }
    | { status: "not-refreshed" }
}

export async function syncWithReminderRefresh(
  config: ToolkitConfig,
  options: {
    unresolvedPilot?: { id: string; code: string; name: string }
    reminderDays?: number
    notifyDueSoon?: boolean
    preserveSchool?: boolean
  } = {},
  client: CanvasClient = createCanvasClient(config),
): Promise<SyncWorkflowReport> {
  const reminderDays = options.reminderDays ?? 7
  if (!Number.isInteger(reminderDays) || reminderDays < 1 || reminderDays > 365)
    throw new Error("Sync reminder lead days must be between 1 and 365")
  const report = await syncCourses(
    config,
    {
      ...(options.unresolvedPilot ? { unresolvedPilot: options.unresolvedPilot } : {}),
      ...(options.preserveSchool ? { preserveSchool: true } : {}),
    },
    client,
  )
  const syncedIds = new Set(
    (report.courseReports ?? [])
      .filter((course) => course.status === "synced")
      .map((course) => course.courseId),
  )
  if (!syncedIds.size) return report
  let dueSoon: SyncWorkflowReport["dueSoon"]
  try {
    const vault = resolve(config.vault.path)
    const workspace = await inspectWorkspace(vault)
    const context = {
      ...workspace,
      courses: workspace.courses.filter(
        (course) => course.canvasId && syncedIds.has(course.canvasId),
      ),
    }
    const plan = await planDueSoon(vault, context, { days: reminderDays })
    const receipt = await saveDueSoon(vault, plan)
    const notification = options.notifyDueSoon ? await notifyDueSoon(plan) : "not-requested"
    dueSoon = { status: "saved", receipt, notification }
    if (notification === "failed" || notification === "unsupported-platform")
      report.notices.push(
        `Due-soon desktop delivery: ${notification}; the private durable alert remains available.`,
      )
  } catch {
    dueSoon = { status: "not-refreshed" }
    report.notices.push(
      "Due-soon alert was not refreshed; inspect private _meta/due-soon ownership, locks or interrupted state. Synced course files were not rolled back.",
    )
  }
  return { ...report, dueSoon }
}
