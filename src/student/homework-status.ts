import { readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { assertNoSymlinks } from "../shared/fs-safety.js"
import type { WorkspaceContext } from "../shared/types.js"
import { readTask } from "../tasks/records.js"
import type { UndatedItem, UpcomingItem } from "./upcoming.js"

interface DraftPresence {
  draftVersion: number | null
  draftPaths: string[]
  draftBinding:
    | "task-metadata"
    | "legacy-filename"
    | "mixed"
    | "not-found"
    | "ambiguous-legacy-filename"
  draftContentsVerified: false
  relatedDrafts: Array<{
    taskId: string
    path: string
    promptPath: string
    version: number
    binding: "same-canvas-id-different-prompt"
    draftContentsVerified: false
  }>
}
const slug = (value: string, fallback: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || fallback
const legacySlug = (item: { title: string; canvasId?: string }) =>
  slug(item.title, `untitled-${item.canvasId}`)
const version = (filename: string, base: string) => {
  if (filename === `${base}.md`) return 1
  if (!filename.startsWith(`${base}.v`) || !filename.endsWith(".md")) return undefined
  const suffix = filename.slice(base.length + 2, -3)
  if (!/^[1-9]\d*$/.test(suffix)) return undefined
  const value = Number(suffix)
  return Number.isSafeInteger(value) ? value : undefined
}

/** Filename/metadata presence only, never completion validity, approval or academic review. */
export async function withHomeworkDraftStatus(
  vault: string,
  context: WorkspaceContext,
  upcoming: { items: UpcomingItem[]; overdue: UpcomingItem[]; undated: UndatedItem[] },
) {
  const directory = join(resolve(vault), "_meta/tasks")
  await assertNoSymlinks(directory, true)
  const names = await readdir(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  })
  if (names.length > 5000) throw new Error("Homework task inventory exceeds 5000 entries")
  const native = new Map<string, Map<string, number>>()
  const related = new Map<string, DraftPresence["relatedDrafts"]>()
  let unreadableTaskRecords = 0
  for (const name of names.sort()) {
    if (!/^[a-f0-9-]{36}$/i.test(name)) continue
    try {
      const task = await readTask(vault, name)
      if (task.status !== "completed" || task.assignment?.mode !== "draft" || !task.output) continue
      const course = context.courses.find(
        (course) => course.root === task.course.root && course.code === task.course.code,
      )
      if (!course?.existingWork.includes(task.output)) continue
      // The saved recipe validates the product destination, which can differ
      // from the prompt's directory when both products preserve separate writers.
      const prefix = `${task.destination}/`
      if (!task.output.startsWith(prefix)) continue
      const number = version(task.output.slice(prefix.length), "01 Assignment Draft")
      if (!number) continue
      const key = `${course.code}\0${task.assignment.source}`
      const paths = native.get(key) ?? new Map<string, number>()
      paths.set(task.output, number)
      native.set(key, paths)
      const canvasId = task.sources.find(
        (source) => source.path === task.assignment?.source,
      )?.canvasId
      if (course.syncNamespace && /^[1-9]\d{0,39}$/.test(canvasId ?? "")) {
        const identityKey = `${course.code}\0${canvasId}`
        const entries = related.get(identityKey) ?? []
        entries.push({
          taskId: task.id,
          path: task.output,
          promptPath: task.assignment.source,
          version: number,
          binding: "same-canvas-id-different-prompt",
          draftContentsVerified: false,
        })
        related.set(identityKey, entries)
      }
    } catch {
      unreadableTaskRecords++
    }
  }
  const add = <T extends UpcomingItem | UndatedItem>(item: T): T & DraftPresence => {
    const course = context.courses.find((course) => course.code === item.course)
    const paths = native.get(`${item.course}\0${item.path}`) ?? new Map<string, number>()
    const legacy = new Map<string, number>()
    const titleSlug = legacySlug(item)
    const collisions =
      course?.sources.filter(
        (source) =>
          /^assignments?(?:\.md)?$/i.test(source.type) && legacySlug(source) === titleSlug,
      ) ?? []
    for (const path of course?.existingWork ?? []) {
      const prefix = `${course?.root}/Drafts/`
      if (!path.startsWith(prefix)) continue
      const number = version(path.slice(prefix.length), titleSlug)
      if (number) legacy.set(path, number)
    }
    const ambiguous = legacy.size > 0 && collisions.length > 1
    const all = new Map([...paths, ...(ambiguous ? [] : legacy)])
    return {
      ...item,
      draftVersion: all.size ? Math.max(...all.values()) : null,
      draftPaths: [...all.keys()].sort(),
      draftBinding: ambiguous
        ? "ambiguous-legacy-filename"
        : paths.size
          ? legacy.size
            ? "mixed"
            : "task-metadata"
          : legacy.size
            ? "legacy-filename"
            : "not-found",
      draftContentsVerified: false,
      relatedDrafts:
        item.kind === "assignment" && /^[1-9]\d{0,39}$/.test(item.canvasId ?? "")
          ? (related.get(`${item.course}\0${item.canvasId}`) ?? [])
              .filter((entry) => entry.promptPath !== item.path)
              .sort((a, b) => a.path.localeCompare(b.path) || a.taskId.localeCompare(b.taskId))
          : [],
    }
  }
  return {
    items: upcoming.items.map(add),
    overdue: upcoming.overdue.map(add),
    undated: upcoming.undated.map(add),
    unreadableTaskRecords,
    limitation:
      "Draft presence from saved task metadata or unambiguous legacy filenames only. Related drafts share a numeric Canvas assignment ID in a preserved course but cite a different prompt path; inspect their original task, not the current prompt's completion status. Contents, current source bindings, academic quality, approval and submission are not verified; unreadable task records may hide other drafts.",
  }
}
