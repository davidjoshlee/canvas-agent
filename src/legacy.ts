import { lstat, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { assertNoSymlinks } from "./fs-safety.js"
import { createAssignmentTask, readStudentWork, readTask } from "./tasks.js"
import type { CourseContext, SourceRecord } from "./types.js"
import { inspectWorkspace, selectCourse } from "./workspace.js"

const Provenance = z
  .object({
    course: z
      .object({
        code: z.string().min(1).max(200),
        canvas_id: z.string().regex(/^\d+$/),
        canvas_url: z.string().url(),
      })
      .strict(),
    assignment: z
      .object({
        canvas_id: z.string().min(1).max(100),
        title: z.string().min(1).max(1000),
        slug: z.string().min(1).max(1000),
        canvas_url: z.string().url(),
        due_at: z.string().nullable().optional(),
        group_category_id: z.string().nullable(),
      })
      .strict(),
    ai_policy: z.enum(["allowed", "prohibited"]),
    model_ids: z
      .object({ draft: z.string().min(1).max(200), discuss: z.string().min(1).max(200) })
      .strict(),
    source_files: z.array(z.string().min(1).max(2000)).min(1).max(200),
    timestamp: z.string().datetime({ offset: true }),
    version: z.number().int().positive(),
    run_id: z.string().uuid(),
  })
  .strict()
const Link = z
  .object({
    version: z.literal(1),
    taskId: z.string().uuid(),
    legacyRunId: z.string().uuid(),
    work: z.string().min(1).max(2000),
    workHash: z.string().regex(/^[a-f0-9]{64}$/),
    legacyVersion: z.number().int().positive(),
    legacyTimestamp: z.string().datetime({ offset: true }),
    historicalSourcesVerified: z.literal(false),
  })
  .strict()
function parseProvenance(text: string) {
  const matches = [...text.matchAll(/<!-- school-agent-provenance\r?\n([\s\S]*?)\r?\n-->/g)]
  if (matches.length !== 1)
    throw new Error(
      "Legacy draft must contain exactly one complete School Agent assignment provenance header",
    )
  let value: unknown
  try {
    value = JSON.parse(matches[0]?.[1] ?? "")
  } catch {
    throw new Error("Legacy assignment provenance is invalid JSON")
  }
  const parsed = Provenance.safeParse(value)
  if (!parsed.success)
    throw new Error("Legacy assignment provenance has an unsupported or invalid format")
  if (parsed.data.ai_policy !== "allowed")
    throw new Error("Legacy provenance marks this work as AI-prohibited")
  return parsed.data
}
function bindCourse(course: CourseContext, record: z.infer<typeof Provenance>) {
  const aliases = [course.code, course.root, course.canvasCode]
    .filter(Boolean)
    .map((value) => value?.toLowerCase())
  if (
    !course.canvasId ||
    course.canvasId !== record.course.canvas_id ||
    !aliases.includes(record.course.code.toLowerCase())
  )
    throw new Error("Legacy provenance does not match the selected course identity")
  const courseUrl = new URL(record.course.canvas_url),
    assignmentUrl = new URL(record.assignment.canvas_url)
  const home = course.sources.find((source) => source.path === `${course.root}/00 Home.md`)
  if (
    courseUrl.pathname !== `/courses/${course.canvasId}` ||
    assignmentUrl.pathname !==
      `/courses/${course.canvasId}/assignments/${record.assignment.canvas_id}` ||
    courseUrl.origin !== assignmentUrl.origin ||
    courseUrl.username ||
    courseUrl.password ||
    courseUrl.search ||
    courseUrl.hash ||
    assignmentUrl.username ||
    assignmentUrl.password ||
    assignmentUrl.search ||
    assignmentUrl.hash ||
    (home?.canvasUrl && new URL(home.canvasUrl).origin !== courseUrl.origin)
  )
    throw new Error("Legacy provenance URLs do not match the selected course")
}
async function locate(vault: string, courseQuery: string, runId: string, workPath?: string) {
  if (!z.string().uuid().safeParse(runId).success) throw new Error("Legacy run ID must be a UUID")
  const course = selectCourse(await inspectWorkspace(vault), courseQuery)
  const candidates: { work: SourceRecord; record: z.infer<typeof Provenance> }[] = []
  const paths = workPath
    ? [workPath]
    : course.existingWork.filter(
        (path) => /\.(?:md|markdown|txt)$/i.test(path) && !/\.discuss\.md$/i.test(path),
      )
  if (paths.length > 500)
    throw new Error("Too many legacy work files; provide an explicit --work path")
  let totalBytes = 0
  for (const path of paths) {
    if (candidates.length >= 20 || totalBytes > 40 * 1024 * 1024)
      throw new Error("Legacy scan exceeds its bounded work limit; provide an explicit --work path")
    try {
      const work = await readStudentWork(vault, course, path)
      totalBytes += Buffer.byteLength(work.text, "utf8")
      const record = parseProvenance(work.text)
      if (record.run_id !== runId) {
        if (workPath) throw new Error("Legacy run ID does not match the explicitly selected draft")
        continue
      }
      bindCourse(course, record)
      candidates.push({ work, record })
    } catch (error) {
      if (workPath) throw error
    }
  }
  if (!candidates.length)
    throw new Error(
      "No eligible legacy draft matches this run in the selected course; provide an explicit --work path to diagnose policy or metadata problems",
    )
  candidates.sort((a, b) => b.record.version - a.record.version)
  const found = candidates[0]
  if (
    !found ||
    candidates.filter((item) => item.record.version === found.record.version).length !== 1
  )
    throw new Error("Legacy draft selection is ambiguous; provide an explicit --work path")
  return { course, ...found }
}
function declaredSources(course: CourseContext, paths: string[]) {
  return [...new Set(paths)].map((path) => {
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      [...path].some((char) => char.charCodeAt(0) < 32 || char === "`")
    )
      return { status: "unsafe-reference" }
    const first = path.split("/")[0] ?? ""
    const aliases = [course.root, course.code, course.canvasCode]
    if (
      /^[A-Z]{2,12}[-_]?\d{2,4}[A-Z]?$|^[A-Z]\d{2}-[A-Z]{2,12}-\d{2,4}[A-Z]?(?:-\d{1,3})?$/i.test(
        first,
      ) &&
      !aliases.includes(first)
    )
      return { status: "outside-course-scope" }
    const local = aliases.includes(first) ? path.slice(first.length + 1) : path
    const rooted = `${course.root}/${local}`
    const source = course.sources.find((source) => source.path === rooted)
    const excluded = course.excluded.find((source) => source.path === rooted)
    return {
      path: rooted,
      status: source ? "available-current" : excluded ? "excluded" : "unavailable",
    }
  })
}
/** Historical references only: no past hashes or source bodies are invented. */
export async function inspectLegacyRun(
  vault: string,
  course: string,
  runId: string,
  workPath?: string,
) {
  const found = await locate(vault, course, runId, workPath)
  return {
    runId,
    kind: "legacy-assignment",
    status: "historical-unverified",
    course: { code: found.course.code, root: found.course.root, canvasId: found.course.canvasId },
    work: { path: found.work.path, hash: found.work.hash },
    assignmentCanvasId: found.record.assignment.canvas_id,
    legacyVersion: found.record.version,
    legacyTimestamp: found.record.timestamp,
    declaredSources: declaredSources(found.course, found.record.source_files),
    historicalSourcesVerified: false,
    limitation:
      "The legacy header records paths but no source hashes. Available files are current versions, not proof of historical input or course AI permission. No old run is converted into a completed or approved task.",
  }
}
/** Create a new pending handoff from explicitly chosen, policy-eligible legacy work. */
export async function importLegacyAssignment(
  vault: string,
  input: {
    course: string
    runId: string
    source: string
    work?: string
    mode: "draft" | "review"
    context?: string[]
  },
) {
  if (!["draft", "review"].includes(input.mode))
    throw new Error("Legacy import mode must be draft or review")
  const found = await locate(vault, input.course, input.runId, input.work)
  const prompt = found.course.sources.find((source) => source.path === input.source)
  if (
    !prompt ||
    prompt.canvasId !== found.record.assignment.canvas_id ||
    !/assignment/i.test(`${prompt.type} ${prompt.path}`)
  )
    throw new Error("Explicit prompt does not match the legacy assignment identity")
  const task = await createAssignmentTask(
    vault,
    found.course.code,
    prompt.path,
    input.mode,
    found.work.path,
    input.context ?? [],
  )
  const work = task.sources.find((source) => source.path === found.work.path)
  if (!work || work.hash !== found.work.hash)
    throw new Error("Legacy work changed during import; the new task must not be used")
  const metadata = Link.parse({
    version: 1,
    taskId: task.id,
    legacyRunId: input.runId,
    work: work.path,
    workHash: work.hash,
    legacyVersion: found.record.version,
    legacyTimestamp: found.record.timestamp,
    historicalSourcesVerified: false,
  })
  const path = join(vault, "_meta/tasks", task.id, "legacy.json")
  await assertNoSymlinks(path, true)
  await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  return {
    task,
    legacy: metadata,
    limitation:
      "Fresh pending handoff with current snapshots; old source references were not automatically added, and old approval/AI permission were not imported.",
  }
}
export async function legacyTaskLink(vault: string, id: string) {
  const task = await readTask(vault, id),
    path = join(vault, "_meta/tasks", task.id, "legacy.json")
  await assertNoSymlinks(path, true)
  let raw: string
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > 20_000)
      throw new Error("Legacy task link is not a bounded regular file")
    raw = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Legacy task link is invalid")
  }
  const record = Link.safeParse(parsed)
  const snapshot = task.sources.find((source) => source.path === task.assignment?.work)
  if (
    !record.success ||
    record.data.taskId !== task.id ||
    record.data.work !== snapshot?.path ||
    record.data.workHash !== snapshot.hash
  )
    throw new Error("Legacy task link does not match the task's captured student work")
  const provenance = parseProvenance(snapshot.text)
  if (
    record.data.legacyRunId !== provenance.run_id ||
    record.data.legacyVersion !== provenance.version ||
    record.data.legacyTimestamp !== provenance.timestamp
  )
    throw new Error("Legacy task link does not match captured provenance")
  return record.data
}

/** School Agent prep logs record retrieval UUIDs, not necessarily model-run UUIDs. */
export async function inspectLegacyPrepContext(
  vault: string,
  courseQuery: string,
  contextId: string,
) {
  if (!z.string().uuid().safeParse(contextId).success)
    throw new Error("Legacy context ID must be a UUID")
  const course = selectCourse(await inspectWorkspace(vault), courseQuery)
  const path = join(vault, "_meta/model-context-log.jsonl")
  await assertNoSymlinks(path)
  const info = await lstat(path)
  if (!info.isFile() || info.size > 20 * 1024 * 1024)
    throw new Error("Legacy context log must be a regular file up to 20 MB")
  const schema = z
    .object({
      runId: z.string().uuid(),
      function: z.literal("prepBrief"),
      provider: z.string().max(200).optional(),
      model: z.string().max(200).optional(),
      sources: z
        .array(
          z
            .object({
              path: z.string().min(1).max(2000),
              tier: z.enum(["manifest", "summary", "full-text"]),
            })
            .strict(),
        )
        .max(200),
      selectionMode: z.enum(["module", "keyword", "keyword-fallback"]).optional(),
      selectedModuleCanvasIds: z.array(z.string().regex(/^\d+$/)).max(100).optional(),
      selectedModuleTitles: z.array(z.string().max(1000)).max(100).optional(),
    })
    .strict()
  const matches: z.infer<typeof schema>[] = []
  const bytes = await readFile(path)
  if (bytes.length > 20 * 1024 * 1024)
    throw new Error("Legacy context log grew beyond its size limit")
  for (const line of bytes.toString("utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof raw !== "object" || !raw || !("runId" in raw) || raw.runId !== contextId) continue
    const parsed = schema.safeParse(raw)
    if (!parsed.success)
      throw new Error("Matching legacy context record is not a supported prep retrieval record")
    matches.push(parsed.data)
  }
  if (!matches.length) throw new Error("No legacy prep context record matches this UUID")
  const selected = matches[0]
  if (!selected || matches.some((record) => JSON.stringify(record) !== JSON.stringify(selected)))
    throw new Error("Legacy context ID has conflicting records; provenance is ambiguous")
  const declared = selected.sources.map((source) => ({
    ...declaredSources(course, [source.path])[0],
    tier: source.tier,
  }))
  return {
    contextId,
    kind: "legacy-prep-context",
    status: "historical-reference-only",
    function: "prepBrief",
    course: { code: course.code, root: course.root, canvasId: course.canvasId },
    courseBindingVerified: false,
    historicalSourcesVerified: false,
    modelRunBindingVerified: false,
    selectionMode: selected.selectionMode ?? "unrecorded",
    declaredSources: declared,
    limitation:
      "This log stores course-relative paths without course identity or source hashes. The course is supplied by the caller; current availability is not proof of historical scope. A retrieval UUID is not necessarily the generated prep's model-run UUID. No source bodies were recovered and no task was imported.",
  }
}
