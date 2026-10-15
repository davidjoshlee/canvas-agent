import { createHash, randomUUID } from "node:crypto"
import { link, mkdir, open, readdir, readFile, unlink, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { captureLearningHistory } from "../feedback/history.js"
import { assertNoSymlinks } from "../shared/fs-safety.js"
import type { SourceRecord, TaskRecord } from "../shared/types.js"
import { inspectWorkspace, selectCourse } from "../vault/workspace.js"
import { readVerifiedCompletedOutput } from "./completion.js"
import { verifyWorkbookFile } from "./draft-workbook.js"
import { captureRevisionEdits } from "./revision-edits.js"
import { createAssignmentTask, readTask, selectAssignmentInputs } from "./store.js"

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")
const within = (parent: string, child: string) => {
  const path = relative(parent, child)
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
}

async function safePath(vault: string, path: string, allowMissing = false): Promise<string> {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Unsafe vault-relative lifecycle path")
  const root = resolve(vault)
  const absolute = resolve(root, ...path.split("/"))
  if (!within(root, absolute)) throw new Error("Lifecycle path escapes the vault")
  await assertNoSymlinks(root)
  await assertNoSymlinks(absolute, allowMissing)
  return absolute
}

/** Create a fresh draft task from an unchanged, completed assignment artifact. */
export async function reviseTask(
  vault: string,
  id: string,
  feedback: string,
  workPath?: string,
): Promise<TaskRecord> {
  const previous = await readVerifiedCompletedOutput(vault, id)
  const parent = previous.task
  if (!parent.assignment || !["draft", "outline"].includes(parent.assignment.mode))
    throw new Error("Only a completed draft or outline can start a revision")
  if (!feedback.trim() || feedback.length > 12_000)
    throw new Error("Revision feedback must be non-empty and no longer than 12 KB")
  const priorOutput = previous.output
  if (!priorOutput.startsWith(`${parent.destination}/`))
    throw new Error("The completed output is not in this assignment's Drafts folder")

  const context = [
    ...new Set([...parent.assignment.context, ...(workPath ? [workPath] : [])]),
  ].sort()
  const outputText = previous.bytes.toString("utf8")
  if (!Buffer.from(outputText, "utf8").equals(previous.bytes))
    throw new Error("Completed output is not safe UTF-8 text")
  const revisionSource: SourceRecord = {
    path: priorOutput,
    title: "Validated prior assignment output",
    hash: sha(previous.bytes),
    text: outputText,
    type: "student-work",
    dates: [],
  }
  const workspace = await inspectWorkspace(resolve(vault))
  const course = selectCourse(workspace, parent.course.code)
  const selected = await selectAssignmentInputs(
    vault,
    course,
    parent.assignment.source,
    priorOutput,
    context,
    revisionSource,
    1,
  )
  const tasksRoot = await safePath(vault, "_meta/tasks", true)
  const revisionEdits = workPath
    ? captureRevisionEdits(selected.sources, priorOutput, workPath)
    : undefined
  const learningHistory = await captureLearningHistory(vault, course)
  const priorTasks = await readdir(tasksRoot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  })
  for (const name of priorTasks) {
    if (!/^[0-9a-f-]{36}$/i.test(name)) continue
    try {
      const existing = await readTask(vault, name)
      if (
        existing.parentTaskId === parent.id &&
        existing.workflow?.version === 3 &&
        existing.groupScopeVersion === 1 &&
        existing.deliverable?.version === 1 &&
        existing.deliverableScopeVersion === 1 &&
        existing.deliverableParserVersion === 3 &&
        existing.guidanceSelectionVersion === 1 &&
        existing.assignmentStructureVersion === 1 &&
        existing.productNamespaceVersion === (course.syncNamespace ? 1 : undefined) &&
        existing.feedback === feedback &&
        JSON.stringify(existing.revisionEdits) === JSON.stringify(revisionEdits) &&
        existing.assignment?.source === parent.assignment.source &&
        existing.assignment.mode === "draft" &&
        existing.assignment.work === priorOutput &&
        JSON.stringify([...existing.assignment.context].sort()) ===
          JSON.stringify([...selected.context].sort()) &&
        JSON.stringify(existing.sources) === JSON.stringify(selected.sources) &&
        JSON.stringify(existing.guidance) === JSON.stringify(selected.guidance) &&
        JSON.stringify(existing.learningHistory) === JSON.stringify(learningHistory)
      )
        return existing
    } catch {
      // Ignore unrelated or incomplete task records while recovering a retry.
    }
  }

  return createAssignmentTask(
    vault,
    parent.course.code,
    parent.assignment.source,
    "draft",
    priorOutput,
    context,
    {
      parentTaskId: parent.id,
      feedback,
      revisionSource,
      ...(workPath ? { editedWork: workPath } : {}),
    },
  )
}

/** Copy a completed assignment draft to a non-overwriting Finals sibling. */
export async function approveTask(
  vault: string,
  id: string,
): Promise<{ task: TaskRecord; output: string; workbook?: { path: string; hash: string } }> {
  const { task, output, bytes, workbookBytes } = await readVerifiedCompletedOutput(vault, id)
  if (task.assignment?.mode !== "draft")
    throw new Error("Only a completed assignment draft can be approved")
  const hash = sha(bytes)
  const assignmentFolder = task.destination.slice(0, task.destination.lastIndexOf("/"))
  const finalDirRel = `${assignmentFolder}/Finals`
  const finalDir = await safePath(vault, finalDirRel, true)
  await mkdir(finalDir, { recursive: true, mode: 0o700 })
  await safePath(vault, finalDirRel)

  const metadataRel = `_meta/tasks/${task.id}/approval.json`
  const metadataPath = await safePath(vault, metadataRel, true)
  try {
    const stored = JSON.parse(await readFile(metadataPath, "utf8")) as {
      sourceOutput?: string
      sourceHash?: string
      output?: string
      outputHash?: string
      workbook?: { path: string; hash: string }
    }
    if (
      stored.sourceOutput !== output ||
      stored.sourceHash !== hash ||
      !stored.output ||
      stored.outputHash !== hash
    )
      throw new Error("Approval metadata does not match the completed draft")
    const finalPath = await safePath(vault, stored.output)
    if (sha(await readFile(finalPath)) !== hash)
      throw new Error("Approved Final output is missing or has been modified")
    if (workbookBytes) {
      if (
        stored.workbook?.path !== stored.output.replace(/\.md$/, ".xlsx") ||
        stored.workbook.hash !== sha(workbookBytes)
      )
        throw new Error("Approval workbook metadata does not match the completed draft")
      const path = await safePath(vault, stored.workbook.path)
      await verifyWorkbookFile(path, workbookBytes)
    } else if (stored.workbook) throw new Error("Approval has an unexpected workbook")
    return {
      task,
      output: stored.output,
      ...(stored.workbook ? { workbook: stored.workbook } : {}),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  const existing = await readdir(finalDir)
  const base = "01 Assignment Final.md"
  let filename = base
  let version = 2
  while (
    existing.includes(filename) ||
    (workbookBytes && existing.includes(filename.replace(/\.md$/, ".xlsx")))
  )
    filename = `${base.slice(0, -3)}.v${version++}.md`
  const finalRel = `${finalDirRel}/${filename}`
  const finalPath = await safePath(vault, finalRel, true)
  const tempPath = `${finalPath}.tmp-${randomUUID()}`
  try {
    const handle = await open(tempPath, "wx", 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await safePath(vault, finalRel, true)
    await link(tempPath, finalPath)
    await unlink(tempPath)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
  let workbook: { path: string; hash: string } | undefined
  if (workbookBytes) {
    const path = finalRel.replace(/\.md$/, ".xlsx")
    const finalWorkbookPath = await safePath(vault, path, true)
    const temporary = `${finalWorkbookPath}.tmp-${randomUUID()}`
    try {
      const handle = await open(temporary, "wx", 0o600)
      try {
        await handle.writeFile(workbookBytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await safePath(vault, path, true)
      await link(temporary, finalWorkbookPath)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
    workbook = { path, hash: sha(workbookBytes) }
  }
  const metadata = {
    version: 1,
    taskId: task.id,
    sourceOutput: output,
    sourceHash: hash,
    output: finalRel,
    outputHash: hash,
    ...(workbook ? { workbook } : {}),
    approvedAt: new Date().toISOString(),
  }
  try {
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    // A concurrent caller won. Its metadata is authoritative; leave this uniquely versioned copy intact.
  }
  return { task, output: finalRel, ...(workbook ? { workbook } : {}) }
}
