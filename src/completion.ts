import { createHash, randomUUID } from "node:crypto"
import { link, lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { assertNoSymlinks } from "./fs-safety.js"
import {
  readGuidanceSnapshot,
  readTask,
  resolvePrepDestination,
  selectAssignmentInputs,
  selectPrepInputs,
  TaskRecordSchema,
} from "./tasks.js"
import type { CourseContext, TaskRecord } from "./types.js"
import { workflowFor } from "./workflows.js"
import { inspectWorkspace } from "./workspace.js"

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")
const within = (parent: string, child: string) => {
  const rel = relative(parent, child)
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
}

function safeRel(value: string): string {
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error(`Unsafe vault-relative path: ${value}`)
  return value
}

async function noLinks(root: string, rel: string, allowMissing = false): Promise<string> {
  const clean = safeRel(rel)
  const base = resolve(root)
  const target = resolve(base, ...clean.split("/"))
  if (!within(base, target)) throw new Error("Path escapes its root")
  let current = base
  const rootStat = await lstat(base)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new Error(`Symlink or invalid directory: ${base}`)
  for (const part of clean.split("/")) {
    current = join(current, part)
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) throw new Error(`Symlink paths are not allowed: ${clean}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) break
      throw error
    }
  }
  return target
}

async function externalFile(path: string): Promise<Buffer> {
  const abs = resolve(path)
  await assertNoSymlinks(abs)
  const data = await readFile(abs)
  if (data.includes(0) || !Buffer.from(data.toString("utf8"), "utf8").equals(data))
    throw new Error("Candidate must be valid UTF-8 text")
  return data
}

function checkCandidate(text: string, id: string, task: TaskRecord): void {
  if (!text.trim()) throw new Error("Candidate is empty")
  if (!new RegExp(`^Task: ${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(text))
    throw new Error("Candidate must include the exact Task identity header")
  const sections = new Map<string, string>()
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const title = lines[i]?.match(/^##\s+(.+?)\s*$/)?.[1]
    if (!title) continue
    const body: string[] = []
    for (let j = i + 1; j < lines.length && !/^##\s+/.test(lines[j] ?? ""); j++)
      body.push(lines[j] ?? "")
    sections.set(title, body.join("\n").trim())
  }
  const workflow = task.workflow ?? workflowFor("prep")
  if (JSON.stringify(task.requirements) !== JSON.stringify(workflow.requiredSections))
    throw new Error("Task requirements do not match the authoritative workflow")
  for (const heading of workflow.requiredSections) {
    if (!sections.get(heading)) throw new Error(`Required section is missing or empty: ${heading}`)
  }
  if (
    /(?:^|[\\/])(?:\.env(?:\.[\w-]+)?|credentials?(?:\.[\w-]+)?|secrets?(?:\.[\w-]+)?)(?:[\\/]|$)/i.test(
      text,
    )
  )
    throw new Error("Candidate contains a credential path")
  if (
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~-]{16,}|(?:api[_-]?key|access[_-]?token|client[_-]?secret|canvas[_-]?token|password|secret)\s*[:=]\s*\S+)/i.test(
      text,
    )
  )
    throw new Error("Candidate appears to contain credentials")
  const allowed = new Set([...task.sources, ...task.guidance].map((s) => s.path))
  const approvedGuidance = new Set(task.guidance.map((s) => s.path))
  const privatePath = /(?:^|[\s"'(<])((?:[A-Za-z0-9_.-]+\/)*_meta(?:\/[A-Za-z0-9_.-]+)+)/g
  for (const match of text.matchAll(privatePath)) {
    const path = match[1] ?? ""
    if (!approvedGuidance.has(path)) throw new Error("Candidate contains a private metadata path")
  }
  const inline = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "")
  const citations = inline.filter((v) => v.includes("/") || /\.(?:md|txt|pdf|docx?)$/i.test(v))
  for (const citation of citations) {
    if (
      citation.includes("..") ||
      citation.startsWith("/") ||
      citation.includes("\\") ||
      !allowed.has(citation)
    )
      throw new Error(`Citation is not an exact task source path: ${citation}`)
    if (/(^|\/)_(?:meta|private)(\/|$)/i.test(citation) && !approvedGuidance.has(citation))
      throw new Error(`Candidate cites a private path: ${citation}`)
  }
  const sourceSection = sections.get("Sources") ?? ""
  if (
    ![...sourceSection.matchAll(/`([^`]+)`/g)].some((m) => allowed.has(m[1] ?? "")) &&
    allowed.size > 0
  )
    throw new Error("Sources section must cite exact task source paths in backticks")
}

function expectedDestination(course: CourseContext, week: string): string {
  return resolvePrepDestination(course, week)
}

async function verifyCurrent(vault: string, task: TaskRecord): Promise<void> {
  await assertNoSymlinks(resolve(vault))
  const context = await inspectWorkspace(resolve(vault))
  const course = context.courses.find(
    (c) => c.code === task.course.code && c.root === task.course.root,
  )
  if (!course) throw new Error("Task course is missing or no longer uniquely identifiable")
  if (task.kind === "assignment") {
    const assignment = task.assignment
    if (!assignment) throw new Error("Assignment task metadata is missing")
    const current = await selectAssignmentInputs(
      vault,
      course,
      assignment.source,
      assignment.work,
      assignment.context,
    )
    const sameRecords = (a: unknown[], b: unknown[]) => JSON.stringify(a) === JSON.stringify(b)
    if (!sameRecords(current.sources, task.sources))
      throw new Error("Assignment inputs are stale: selected sources or their snapshots changed")
    if (!sameRecords(current.guidance, task.guidance))
      throw new Error("Course guidance changed or was modified since this task was created")
    if (!sameRecords(current.excluded, task.excluded))
      throw new Error("Assignment source restrictions or exclusions changed since task creation")
    return
  }
  if (!task.week) throw new Error("Preparation task is missing its week")
  const expected = expectedDestination(course, task.week)
  if (task.destination !== expected)
    throw new Error("Task destination does not match the current authoritative course and week")
  const { sources: currentRelevant, excluded: currentExcluded } = selectPrepInputs(
    course,
    task.week,
  )
  const snap = new Map(task.sources.map((s) => [s.path, s]))
  if (
    currentRelevant.length !== snap.size ||
    currentRelevant.some(
      (s) => snap.get(s.path)?.hash !== s.hash || snap.get(s.path)?.text !== s.text,
    )
  )
    throw new Error("Task sources are stale: source material was added, removed, or changed")
  if (
    course.guidance.length !== task.guidance.length ||
    course.guidance.some((path) => !task.guidance.some((s) => s.path === path))
  )
    throw new Error("Course guidance changed since this task was created")
  for (const saved of task.sources) {
    const path = await noLinks(vault, saved.path)
    const bytes = await readFile(path)
    if (digest(bytes) !== saved.hash)
      throw new Error(`Source or guidance changed since task creation: ${saved.path}`)
  }
  for (const saved of task.guidance) {
    const current = await readGuidanceSnapshot(vault, saved.path)
    if (current.hash !== saved.hash)
      throw new Error(`Guidance changed since task creation: ${saved.path}`)
    if (current.text !== saved.text)
      throw new Error(`Guidance snapshot was modified: ${saved.path}`)
  }
  const relevantExcluded = currentExcluded
  const priorExcluded = task.excluded
  if (
    JSON.stringify(relevantExcluded.map((e) => [e.path, e.reason]).sort()) !==
    JSON.stringify(priorExcluded.map((e) => [e.path, e.reason]).sort())
  )
    throw new Error("Relevant source restrictions or exclusions changed since task creation")
  const currentNotices = [
    ...context.notices,
    ...currentExcluded.map((e) => `Excluded ${e.path}: ${e.reason}`),
  ]
  const relevantNotices = (notices: string[]) =>
    notices.filter((n) => /restrict|prohibit|policy|symlink/i.test(n)).sort()
  if (
    JSON.stringify(relevantNotices(currentNotices)) !==
    JSON.stringify(relevantNotices(task.notices))
  )
    throw new Error("Workspace restriction notices changed since task creation")
}

function validateOutputReference(task: TaskRecord, output: string): void {
  safeRel(output)
  if (!output.startsWith(`${task.destination}/`))
    throw new Error("Completed output is outside the task destination")
  const filename = output.slice(task.destination.length + 1)
  const valid =
    task.kind === "prep"
      ? /^01 Prep Brief(?:\.v(?:[2-9]|[1-9]\d+))?\.md$/.test(filename)
      : new RegExp(
          `^01 Assignment ${task.assignment?.mode === "outline" ? "Outline" : task.assignment?.mode === "draft" ? "Draft" : "Review"}(?:\\.v(?:[2-9]|[1-9]\\d+))?\\.md$`,
        ).test(filename)
  if (!valid) throw new Error("Completed output filename is not a supported version")
}

async function verifyTaskDestination(vault: string, task: TaskRecord): Promise<void> {
  const context = await inspectWorkspace(resolve(vault))
  const course = context.courses.find(
    (c) => c.code === task.course.code && c.root === task.course.root,
  )
  if (
    !course ||
    (task.kind === "prep"
      ? !task.week || resolvePrepDestination(course, task.week) !== task.destination
      : !task.assignment ||
        task.destination !==
          `${task.assignment.source.slice(0, task.assignment.source.lastIndexOf("/"))}/Drafts`)
  )
    throw new Error("Task destination does not match the authoritative course and week")
}

async function completedResult(
  vault: string,
  task: TaskRecord,
  candidateBytes: Buffer,
): Promise<{ task: TaskRecord; output: string }> {
  if (task.outputHash !== digest(candidateBytes))
    throw new Error("Task is already completed with different candidate content")
  const output = task.output
  if (!output) throw new Error("Completed task is missing its output path")
  validateOutputReference(task, output)
  await verifyTaskDestination(vault, task)
  const saved = await noLinks(vault, output)
  const actual = await readFile(saved)
  if (digest(actual) !== task.outputHash || !actual.equals(candidateBytes))
    throw new Error("Completed output is missing or has been modified")
  return { task, output }
}

async function atomicReplace(path: string, data: string): Promise<void> {
  await assertNoSymlinks(path)
  const temp = `${path}.tmp-${randomUUID()}`
  const handle = await open(temp, "wx", 0o600)
  try {
    await handle.writeFile(data, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, path)
}

export async function completeTask(
  vault: string,
  id: string,
  candidateFile: string,
): Promise<{ task: TaskRecord; output: string }> {
  await assertNoSymlinks(resolve(vault))
  const task = await readTask(vault, id)
  const candidateBytes = await externalFile(candidateFile)
  const candidate = candidateBytes.toString("utf8")
  checkCandidate(candidate, id, task)
  const candidateHash = digest(candidateBytes)
  if (task.status === "completed") {
    const result = await completedResult(vault, task, candidateBytes)
    const completedTaskJson = await noLinks(vault, `_meta/tasks/${id}/task.json`)
    await unlink(join(dirname(completedTaskJson), "completion.transaction.json")).catch(
      () => undefined,
    )
    return result
  }
  await verifyCurrent(vault, task)
  const destination = await noLinks(vault, task.destination, true)
  await mkdir(destination, { recursive: true, mode: 0o700 })
  // Re-check every created component after mkdir, including the course and vault ancestors.
  await noLinks(vault, task.destination)
  const taskJson = await noLinks(vault, `_meta/tasks/${id}/task.json`)
  const markerPath = join(dirname(taskJson), "completion.transaction.json")
  await assertNoSymlinks(markerPath, true)
  let marker: { hash: string; output: string } | undefined
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8")) as { hash: string; output: string }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Invalid interrupted completion transaction")
  }
  if (marker && marker.hash !== candidateHash)
    throw new Error("A different completion is already in progress for this task")
  let outputRel = marker?.output
  if (outputRel) {
    safeRel(outputRel)
    validateOutputReference(task, outputRel)
  } else {
    const files = await readdir(destination)
    const base =
      task.kind === "prep"
        ? "01 Prep Brief.md"
        : `01 Assignment ${task.assignment?.mode === "outline" ? "Outline" : task.assignment?.mode === "draft" ? "Draft" : "Review"}.md`
    let name = base
    let version = 2
    while (files.includes(name)) name = `${base.slice(0, -3)}.v${version++}.md`
    outputRel = `${task.destination}/${name}`
    const markerData = JSON.stringify({ hash: candidateHash, output: outputRel })
    try {
      const markerHandle = await open(markerPath, "wx", 0o600)
      try {
        await markerHandle.writeFile(markerData)
        await markerHandle.sync()
      } finally {
        await markerHandle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const competing = JSON.parse(await readFile(markerPath, "utf8")) as {
        hash: string
        output: string
      }
      if (competing.hash !== candidateHash)
        throw new Error("A different completion is already in progress for this task")
      outputRel = competing.output
    }
  }
  // A caller can arrive after a peer removed its transaction marker. Re-read the
  // authoritative record after marker ownership to avoid allocating another version.
  const latestTask = await readTask(vault, id)
  if (latestTask.status === "completed") {
    const result = await completedResult(vault, latestTask, candidateBytes)
    await unlink(markerPath).catch(() => undefined)
    return result
  }
  validateOutputReference(task, outputRel)
  await verifyCurrent(vault, task)
  const finalPath = await noLinks(vault, outputRel, true)
  await assertNoSymlinks(finalPath, true)
  const tempOutput = `${finalPath}.tmp-${randomUUID()}`
  try {
    const handle = await open(tempOutput, "wx", 0o600)
    try {
      await handle.writeFile(candidateBytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await link(tempOutput, finalPath)
    await unlink(tempOutput)
  } catch (error) {
    await unlink(tempOutput).catch(() => undefined)
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const existing = await readFile(finalPath)
    if (!existing.equals(candidateBytes))
      throw new Error("Output version already exists with different student content")
  }
  const updated = TaskRecordSchema.parse({
    ...task,
    status: "completed",
    completedAt: new Date().toISOString(),
    output: outputRel,
    outputHash: candidateHash,
  }) as TaskRecord
  await atomicReplace(taskJson, `${JSON.stringify(updated, null, 2)}\n`)
  await unlink(markerPath).catch(() => undefined)
  return { task: updated, output: outputRel }
}
