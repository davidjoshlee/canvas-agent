import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { z } from "zod"
import { captureLearningHistory } from "../../feedback/history.js"
import { publishExclusiveFile, readBoundedFile, vaultPath } from "../../shared/fs-safety.js"
import type { SourceRecord, TaskRecord } from "../../shared/types.js"
import { inspectWorkspace, selectCourse } from "../../vault/workspace.js"
import { createAssignmentTask } from "../authoring/creation.js"
import { selectAssignmentInputs } from "../authoring/recipes.js"
import { verifyWorkbookFile } from "../compatibility/draft-workbook.js"
import { captureRevisionEdits } from "../evidence/revision-edits.js"
import {
  artifactBaseName,
  assignmentFinalsDirectory,
  nextArtifactName,
  parseArtifactVersion,
} from "./artifact-layout.js"
import { bundleSnapshotPath, readVerifiedBundle } from "./bundle-store.js"
import { readVerifiedCompletedOutput } from "./completion.js"
import { readTask } from "./records.js"

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")
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
  const tasksRoot = await vaultPath(vault, "_meta/tasks", true)
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
        existing.hostExecutionVersion === 1 &&
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
): Promise<{
  task: TaskRecord
  output: string
  workbook?: { path: string; hash: string }
  bundle?: { directory: string; files: Array<{ source: string; path: string; hash: string }> }
}> {
  const { task, output, bytes, workbookBytes } = await readVerifiedCompletedOutput(vault, id)
  if (task.assignment?.mode !== "draft")
    throw new Error("Only a completed assignment draft can be approved")
  const hash = sha(bytes)
  const bundleRecord = await readVerifiedBundle(vault, id, task)
  const finalDirRel = assignmentFinalsDirectory(task.destination)
  const finalDir = await vaultPath(vault, finalDirRel, true)
  await mkdir(finalDir, { recursive: true, mode: 0o700 })
  await vaultPath(vault, finalDirRel)

  const metadataRel = `_meta/tasks/${task.id}/approval.json`
  const metadataPath = await vaultPath(vault, metadataRel, true)
  type ApprovalMetadata = {
    sourceOutput?: string
    sourceHash?: string
    output?: string
    outputHash?: string
    workbook?: { path: string; hash: string }
    bundle?: { directory: string; files: Array<{ source: string; path: string; hash: string }> }
  }
  let savedMetadata: ApprovalMetadata | undefined
  try {
    savedMetadata = JSON.parse(await readFile(metadataPath, "utf8")) as ApprovalMetadata
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (savedMetadata) {
    const stored = savedMetadata as {
      sourceOutput?: string
      sourceHash?: string
      output?: string
      outputHash?: string
      workbook?: { path: string; hash: string }
      bundle?: { directory: string; files: Array<{ source: string; path: string; hash: string }> }
    }
    if (
      stored.sourceOutput !== output ||
      stored.sourceHash !== hash ||
      !stored.output ||
      stored.outputHash !== hash
    )
      throw new Error("Approval metadata does not match the completed draft")
    validateFinalReference(stored.output, finalDirRel)
    const finalPath = await vaultPath(vault, stored.output)
    if (sha(await readFile(finalPath)) !== hash)
      throw new Error("Approved Final output is missing or has been modified")
    if (workbookBytes) {
      if (
        stored.workbook?.path !== stored.output.replace(/\.md$/, ".xlsx") ||
        stored.workbook.hash !== sha(workbookBytes)
      )
        throw new Error("Approval workbook metadata does not match the completed draft")
      const path = await vaultPath(vault, stored.workbook.path)
      await verifyWorkbookFile(path, workbookBytes)
    } else if (stored.workbook) throw new Error("Approval has an unexpected workbook")
    if (bundleRecord) await verifyApprovedBundle(vault, stored.bundle, stored.output, bundleRecord)
    else if (stored.bundle) throw new Error("Approval has an unexpected bundle companion")
    return {
      task,
      output: stored.output,
      ...(stored.workbook ? { workbook: stored.workbook } : {}),
      ...(stored.bundle ? { bundle: stored.bundle } : {}),
    }
  }

  const existing = await readdir(finalDir)
  const occupied = new Set(existing)
  for (const name of existing) {
    if (!name.endsWith("-bundle")) continue
    occupied.add(`${name.slice(0, -7)}.md`)
  }
  const filename = nextArtifactName(
    artifactBaseName("assignment-final"),
    [...occupied],
    Boolean(workbookBytes),
  )
  const proposedFinal = `${finalDirRel}/${filename}`
  const finalRel = bundleRecord
    ? await reserveBundleApproval(vault, task, proposedFinal, finalDirRel)
    : proposedFinal
  const finalPath = await vaultPath(vault, finalRel, true)
  if (bundleRecord) await publishApprovalBytes(finalPath, bytes)
  else await publishExclusiveFile(finalPath, bytes)
  let workbook: { path: string; hash: string } | undefined
  if (workbookBytes) {
    const path = finalRel.replace(/\.md$/, ".xlsx")
    const finalWorkbookPath = await vaultPath(vault, path, true)
    if (bundleRecord) await publishApprovalBytes(finalWorkbookPath, workbookBytes)
    else await publishExclusiveFile(finalWorkbookPath, workbookBytes)
    workbook = { path, hash: sha(workbookBytes) }
  }
  let bundle:
    | { directory: string; files: Array<{ source: string; path: string; hash: string }> }
    | undefined
  if (bundleRecord) {
    const bundleDirectory = `${finalRel.slice(0, -3)}-bundle`
    const absBundleDir = await vaultPath(vault, bundleDirectory, true)
    await mkdir(absBundleDir, { recursive: true, mode: 0o700 })
    await vaultPath(vault, bundleDirectory)
    const files: Array<{ source: string; path: string; hash: string }> = []
    for (const entry of bundleRecord.files.filter((f) => f.role === "deliverable")) {
      const source = bundleSnapshotPath(id, entry.path)
      const path = `${bundleDirectory}/${entry.path}`
      const target = await vaultPath(vault, path, true)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      const snapshotBytes = await readBoundedFile(await vaultPath(vault, source), 50 * 1024 * 1024)
      if (sha(snapshotBytes) !== entry.hash)
        throw new Error("Bundle snapshot changed during approval")
      await publishApprovalBytes(target, snapshotBytes)
      files.push({ source, path, hash: entry.hash })
    }
    bundle = { directory: bundleDirectory, files }
  }
  const metadata = {
    version: 1,
    taskId: task.id,
    sourceOutput: output,
    sourceHash: hash,
    output: finalRel,
    outputHash: hash,
    ...(workbook ? { workbook } : {}),
    ...(bundle ? { bundle } : {}),
    approvedAt: new Date().toISOString(),
  }
  try {
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    // Re-read and verify the authoritative receipt after a concurrent publisher wins.
    return approveTask(vault, id)
  }
  return {
    task,
    output: finalRel,
    ...(workbook ? { workbook } : {}),
    ...(bundle ? { bundle } : {}),
  }
}

function validateFinalReference(output: string, directory: string): void {
  const filename = output.slice(directory.length + 1)
  if (
    !output.startsWith(`${directory}/`) ||
    parseArtifactVersion(filename, artifactBaseName("assignment-final")) === undefined
  )
    throw new Error("Approval output is outside its versioned Finals destination")
}

/** Reserve one destination before any bundle approval bytes are published. */
async function reserveBundleApproval(
  vault: string,
  task: TaskRecord,
  proposed: string,
  directory: string,
): Promise<string> {
  const path = await vaultPath(vault, `_meta/tasks/${task.id}/approval.transaction.json`, true)
  const reservation = {
    version: 1,
    taskId: task.id,
    sourceOutput: task.output,
    sourceHash: task.outputHash,
    bundleHash: task.bundleHash,
    output: proposed,
  }
  try {
    await publishExclusiveFile(path, `${JSON.stringify(reservation)}\n`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const stored = z
    .object({
      version: z.literal(1),
      taskId: z.string().uuid(),
      sourceOutput: z.string(),
      sourceHash: z.string(),
      bundleHash: z.string(),
      output: z.string(),
    })
    .strict()
    .parse(JSON.parse((await readBoundedFile(path, 16384)).toString("utf8")))
  if (
    stored.taskId !== task.id ||
    stored.sourceOutput !== task.output ||
    stored.sourceHash !== task.outputHash ||
    stored.bundleHash !== task.bundleHash
  )
    throw new Error("Interrupted approval does not match the completed bundle")
  validateFinalReference(stored.output, directory)
  return stored.output
}

async function publishApprovalBytes(path: string, bytes: Buffer): Promise<void> {
  try {
    await publishExclusiveFile(path, bytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    if (!(await readBoundedFile(path, 50 * 1024 * 1024)).equals(bytes))
      throw new Error("Approved Final file already exists with different bytes")
  }
}

async function verifyApprovedBundle(
  vault: string,
  stored:
    | { directory: string; files: Array<{ source: string; path: string; hash: string }> }
    | undefined,
  output: string,
  record: NonNullable<Awaited<ReturnType<typeof readVerifiedBundle>>>,
) {
  if (!stored) throw new Error("Approval bundle metadata is missing")
  const expectedDirectory = `${output.slice(0, -3)}-bundle`
  if (stored.directory !== expectedDirectory)
    throw new Error("Approval bundle directory is invalid")
  const expected = record.files.filter((f) => f.role === "deliverable")
  if (stored.files.length !== expected.length)
    throw new Error("Approval bundle file list does not match the completed bundle")
  for (const f of expected) {
    const actual = stored.files.find(
      (x) => x.source === bundleSnapshotPath(record.taskId, f.path) && x.hash === f.hash,
    )
    if (
      !actual ||
      actual.path !== `${stored.directory}/${f.path}` ||
      sha(await readFile(await vaultPath(vault, `${stored.directory}/${f.path}`))) !== f.hash
    )
      throw new Error("Approved Final bundle deliverable is missing or modified")
  }
}
