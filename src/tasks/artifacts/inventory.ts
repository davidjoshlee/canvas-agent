import { lstat, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { assertNoSymlinks } from "../../shared/fs-safety.js"
import type { TaskRecord } from "../../shared/types.js"
import { inspectWorkspace, selectCourse } from "../../vault/workspace.js"
import { readTask } from "./records.js"

/** Validated recipe metadata only: never current-source, output or approval verification. */
export async function listCourseTasks(
  vault: string,
  query: string,
  status?: "pending" | "completed",
) {
  if (status !== undefined && status !== "pending" && status !== "completed")
    throw new Error("Task status must be pending or completed")
  const course = selectCourse(await inspectWorkspace(vault, { course: query }), query)
  const directory = join(resolve(vault), "_meta/tasks")
  await assertNoSymlinks(directory, true)
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  })
  if (entries.length > 5000) throw new Error("Task inventory exceeds 5000 entries")
  const tasks: Array<{
    id: string
    kind: TaskRecord["kind"]
    status: TaskRecord["status"]
    createdAt: string
    week?: string
    period?: TaskRecord["period"]
    mode?: NonNullable<TaskRecord["assignment"]>["mode"]
    promptPath?: string
    parentTaskId?: string
    output?: string
  }> = []
  let unreadableRecords = 0
  let bytes = 0
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!z.string().uuid().safeParse(entry.name).success) continue
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe task entry")
      const path = join(directory, entry.name, "task.json")
      await assertNoSymlinks(path)
      const stat = await lstat(path)
      if (!stat.isFile() || stat.size > 50_000_000)
        throw new Error("Unsafe or oversized task record")
      bytes += stat.size
      if (bytes > 500_000_000) throw new Error("Task inventory exceeds 500 MB")
      const task = await readTask(vault, entry.name)
      if (task.course.root !== course.root || task.course.code !== course.code) continue
      if (status && task.status !== status) continue
      tasks.push({
        id: task.id,
        kind: task.kind,
        status: task.status,
        createdAt: task.createdAt,
        ...(task.week ? { week: task.week } : {}),
        ...(task.period ? { period: task.period } : {}),
        ...(task.assignment
          ? { mode: task.assignment.mode, promptPath: task.assignment.source }
          : {}),
        ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
        ...(task.output ? { output: task.output } : {}),
      })
    } catch {
      if (bytes > 500_000_000)
        throw new Error("Task inventory exceeds 500 MB; narrow the workspace")
      unreadableRecords++
    }
  }
  tasks.sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id),
  )
  return {
    course: course.code,
    tasks,
    unreadableRecords,
    inventoryComplete: unreadableRecords === 0,
    limitation:
      "Validated saved recipe metadata only. Current sources, output bytes, permission, academic quality and approval are not verified. Unreadable records have unknown course scope and may hide tasks; inspect them without rewriting history.",
  }
}
