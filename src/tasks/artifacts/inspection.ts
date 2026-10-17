import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readFile } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { verifyTaskLearningHistory } from "../../feedback/history.js"
import { assertNoSymlinks } from "../../shared/fs-safety.js"
import type { SourceRecord, TaskRecord } from "../../shared/types.js"
import { readVerifiedBundle } from "./bundle-store.js"
import { inspectTaskBundle } from "./bundles.js"
import { readSavedCompletedOutput, verifyCompletedWorkbook } from "./completion.js"
import { readTask } from "./records.js"

const MAX_EVIDENCE = 5 * 1024 * 1024
const MAX_ORIGINAL = 50 * 1024 * 1024

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

export interface SnapshotAudit {
  current: boolean
  changed: string[]
  missing: string[]
}

function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`)
}

function snapshotPath(vault: string, task: TaskRecord, path: string): string {
  if (path === "AGENTS.md") return resolve(vault, path)
  const target = resolve(vault, path)
  const courseRoot = resolve(vault, task.course.root)
  if (!within(courseRoot, target)) throw new Error("Task evidence path is outside its course")
  return target
}

async function fileHash(path: string, maxBytes = MAX_EVIDENCE): Promise<string | undefined> {
  await assertNoSymlinks(path)
  const info = await lstat(path)
  if (!info.isFile() || info.size > maxBytes)
    throw new Error("Task evidence is not a bounded regular file")
  return hash(await readFile(path))
}

/** Recheck every captured source, guidance file, and extraction original before using a task. */
export async function auditTaskSnapshots(vault: string, task: TaskRecord): Promise<SnapshotAudit> {
  await verifyTaskLearningHistory(vault, task)
  const changed: string[] = []
  const missing: string[] = []
  const checks: Array<{ path: string; expected: string; maxBytes?: number }> = [
    ...task.sources.map((source) => ({ path: source.path, expected: source.hash })),
    ...task.guidance.map((source) => ({ path: source.path, expected: source.hash })),
    ...task.sources.flatMap((source) =>
      source.originalPath && source.originalHash
        ? [{ path: source.originalPath, expected: source.originalHash, maxBytes: MAX_ORIGINAL }]
        : [],
    ),
  ]
  for (const check of checks) {
    try {
      const actual = await fileHash(snapshotPath(vault, task, check.path), check.maxBytes)
      if (actual !== check.expected) changed.push(check.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") missing.push(check.path)
      else throw error
    }
  }
  return {
    current: changed.length === 0 && missing.length === 0,
    changed: [...new Set(changed)].sort(),
    missing: [...new Set(missing)].sort(),
  }
}

function evidenceSummary(sources: SourceRecord[]) {
  return sources.map((source) => ({
    path: source.path,
    title: source.title,
    type: source.type,
    hash: source.hash,
    dates: source.dates,
    ...(source.dueAt ? { dueAt: source.dueAt } : {}),
    ...(source.assignmentDates ? { assignmentDates: source.assignmentDates } : {}),
    ...(source.relatedPaths ? { relatedPaths: source.relatedPaths } : {}),
    ...(source.originalPath
      ? { originalPath: source.originalPath, originalHash: source.originalHash }
      : {}),
  }))
}

export async function inspectTask(vault: string, id: string) {
  const task = await readTask(vault, id)
  const snapshots = await auditTaskSnapshots(vault, task)
  const verified =
    task.status === "completed" ? await readSavedCompletedOutput(vault, id) : undefined
  const bundle = verified ? verified.bundle : await inspectTaskBundle(vault, id)
  return {
    id: task.id,
    kind: task.kind,
    parserVersion: task.parserVersion,
    status: task.status,
    createdAt: task.createdAt,
    course: task.course,
    ...(task.week ? { week: task.week } : {}),
    ...(task.period ? { period: task.period } : {}),
    ...(task.assignment ? { assignment: task.assignment } : {}),
    ...(task.discussion ? { discussion: task.discussion } : {}),
    destination: task.destination,
    requirements: task.requirements,
    sources: evidenceSummary(task.sources),
    guidance: evidenceSummary(task.guidance),
    learningHistory: task.learningHistory
      ? {
          hash: task.learningHistory.hash,
          records: task.learningHistory.records.length,
          legacyPlaybooks: task.learningHistory.legacyPlaybooks?.length ?? 0,
          archiveBindingsVerified: true,
          currentGradesVerified: false,
          instructorAuthorshipVerified: false,
        }
      : null,
    excluded: task.excluded,
    snapshots,
    output: task.output ? { path: task.output, hash: task.outputHash } : null,
    bundle: bundle ?? null,
    ...(task.parentTaskId
      ? {
          parentBundle: await inspectTaskBundle(vault, task.parentTaskId).then((value) =>
            value
              ? {
                  taskId: task.parentTaskId,
                  hash: value.hash,
                  path: value.path,
                  integrity: value.integrity,
                }
              : null,
          ),
        }
      : {}),
    ...(task.workbookVersion
      ? { workbookVersion: task.workbookVersion, workbook: task.workbook ?? null }
      : {}),
    notices: task.notices,
  }
}

export async function readOutput(vault: string, task: TaskRecord): Promise<string | undefined> {
  if (!task.output || !task.outputHash) return undefined
  await readVerifiedBundle(vault, task.id, task)
  const target = resolve(vault, task.output)
  const destination = resolve(vault, task.destination)
  if (!within(destination, target)) throw new Error("Task output is outside its destination")
  await assertNoSymlinks(target)
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_EVIDENCE)
      throw new Error("Task output is not a bounded regular file")
    const bytes = await handle.readFile()
    if (bytes.byteLength > MAX_EVIDENCE)
      throw new Error("Task output exceeds the 5 MB review limit")
    if (hash(bytes) !== task.outputHash)
      throw new Error("Task output hash does not match its completion record")
    await verifyCompletedWorkbook(vault, task, bytes)
    return bytes.toString("utf8")
  } finally {
    await handle.close()
  }
}

export function automaticWorkbookEvidence(task: TaskRecord) {
  const scope = "automatic-completion-companion-only" as const
  if (task.kind !== "assignment" || task.assignment?.mode !== "draft")
    return { scope, state: "not-applicable" as const, workbook: null }
  if (task.status !== "completed") return { scope, state: "pending" as const, workbook: null }
  if (task.hostExecutionVersion) return { scope, state: "harness-owned" as const, workbook: null }
  if (!task.workbookVersion) return { scope, state: "uncaptured-legacy" as const, workbook: null }
  return {
    scope,
    state: task.workbook ? ("verified" as const) : ("verified-empty" as const),
    workbook: task.workbook ?? null,
  }
}

function lineDiff(before: string | undefined, after: string | undefined) {
  if (before === undefined || after === undefined)
    return { available: false, lines: [] as string[] }
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let aEnd = a.length
  let bEnd = b.length
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--
    bEnd--
  }
  const lines = [
    `@@ lines ${start + 1}-${aEnd} -> ${start + 1}-${bEnd} @@`,
    ...a
      .slice(start, aEnd)
      .slice(0, 100)
      .map((line) => `-${line}`),
    ...b
      .slice(start, bEnd)
      .slice(0, 100)
      .map((line) => `+${line}`),
  ]
  if (aEnd - start > 100 || bEnd - start > 100) lines.push("... diff excerpt truncated ...")
  return { available: true, added: bEnd - start, removed: aEnd - start, lines }
}

function evidenceChanges(before: SourceRecord[], after: SourceRecord[]) {
  const left = new Map(before.map((source) => [source.path, source.hash]))
  const right = new Map(after.map((source) => [source.path, source.hash]))
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort()
  return paths.flatMap((path) => {
    const a = left.get(path)
    const b = right.get(path)
    return a === b
      ? []
      : [
          {
            path,
            before: a ?? null,
            after: b ?? null,
            change: a === undefined ? "added" : b === undefined ? "removed" : "changed",
          },
        ]
  })
}

export async function compareTasks(vault: string, leftId: string, rightId: string) {
  const [before, after] = await Promise.all([readTask(vault, leftId), readTask(vault, rightId)])
  const [beforeAudit, afterAudit] = await Promise.all([
    auditTaskSnapshots(vault, before),
    auditTaskSnapshots(vault, after),
  ])
  const [beforeOutput, afterOutput] = await Promise.all([
    readOutput(vault, before),
    readOutput(vault, after),
  ])
  const beforeWorkbook = automaticWorkbookEvidence(before)
  const afterWorkbook = automaticWorkbookEvidence(after)
  const known = (state: string) => state === "verified" || state === "verified-empty"
  const workbookChange =
    !known(beforeWorkbook.state) || !known(afterWorkbook.state)
      ? "unknown"
      : !beforeWorkbook.workbook && !afterWorkbook.workbook
        ? "none-extracted"
        : beforeWorkbook.workbook?.hash === afterWorkbook.workbook?.hash
          ? "same-bytes"
          : !beforeWorkbook.workbook
            ? "added"
            : !afterWorkbook.workbook
              ? "removed"
              : "changed-bytes"
  return {
    before: { id: before.id, status: before.status, snapshots: beforeAudit },
    after: { id: after.id, status: after.status, snapshots: afterAudit },
    sourceChanges: evidenceChanges(before.sources, after.sources),
    guidanceChanges: evidenceChanges(before.guidance, after.guidance),
    learningHistory: {
      before: before.learningHistory?.hash ?? null,
      after: after.learningHistory?.hash ?? null,
      change:
        before.learningHistory?.hash === after.learningHistory?.hash
          ? "same-captured-context"
          : "changed-captured-context",
    },
    outputDiff: lineDiff(beforeOutput, afterOutput),
    automaticWorkbooks: { before: beforeWorkbook, after: afterWorkbook, change: workbookChange },
  }
}
