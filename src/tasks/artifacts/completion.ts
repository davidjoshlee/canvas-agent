import { createHash } from "node:crypto"
import { mkdir, open, readdir, readFile, unlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { verifyLearningHistory, verifyTaskLearningHistory } from "../../feedback/history.js"
import { restrictedGuidancePaths } from "../../guidance/selection.js"
import { diagnosticFromLegacyNotice } from "../../shared/diagnostics.js"
import { savedExclusions } from "../../shared/exclusions.js"
import {
  assertNoSymlinks,
  vaultPath as noLinks,
  publishExclusiveFile,
  readBoundedFile,
  replaceFileAtomically,
  vaultRelativePath as safeRel,
} from "../../shared/fs-safety.js"
import type { CourseContext, TaskRecord, WorkspaceContext } from "../../shared/types.js"
import { productDestination } from "../../vault/destinations.js"
import { inspectWorkspace } from "../../vault/workspace.js"
import {
  deriveCurrentTaskInputs,
  readGuidanceSnapshot,
  readSelectedGuidance,
  resolvePrepPeriod,
  verifySourceSnapshot,
} from "../authoring/recipes.js"
import { workflowFor } from "../authoring/workflows.js"
import { draftWorkbookBytes, verifyWorkbookFile } from "../compatibility/draft-workbook.js"
import { prepareAnswerEvidence } from "../evidence/answer-evidence.js"
import {
  assignmentDraftsDirectory,
  nextArtifactName,
  parseArtifactVersion,
  taskArtifactBaseName,
} from "./artifact-layout.js"
import { readVerifiedBundle } from "./bundle-store.js"
import { claimCompletionIntent } from "./completion-intent.js"
import { readTask, TaskRecordSchema } from "./records.js"

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")
async function externalFile(path: string): Promise<Buffer> {
  const abs = resolve(path)
  await assertNoSymlinks(abs)
  const data = await readBoundedFile(abs, 50 * 1024 * 1024)
  if (data.includes(0) || !Buffer.from(data.toString("utf8"), "utf8").equals(data))
    throw new Error("Candidate must be valid UTF-8 text")
  return data
}

/** Privacy guards shared by candidate validation and read-only saved retrieval. */
export function checkArtifactPrivacy(
  text: string,
  task: TaskRecord,
  privateCitations: readonly string[] = [],
): void {
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
  const approvedGuidance = new Set([...task.guidance.map((s) => s.path), ...privateCitations])
  const privatePath = /(?:^|[\s"'(<])((?:[A-Za-z0-9_.-]+\/)*_meta(?:\/[A-Za-z0-9_.-]+)+)/g
  for (const match of text.matchAll(privatePath)) {
    const path = match[1] ?? ""
    if (!approvedGuidance.has(path)) throw new Error("Candidate contains a private metadata path")
  }
}

export function checkCandidate(
  text: string,
  id: string,
  task: TaskRecord,
  privateCitations: readonly string[] = [],
): void {
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
  const workflow = task.workflow ?? {
    ...workflowFor("prep"),
    requiredSections: [...task.requirements],
  }
  if (JSON.stringify(task.requirements) !== JSON.stringify(workflow.requiredSections))
    throw new Error("Task requirements do not match the authoritative workflow")
  for (const heading of workflow.requiredSections) {
    if (!sections.get(heading)) throw new Error(`Required section is missing or empty: ${heading}`)
  }
  if (task.discussion) {
    const question = sections.get("Student question") ?? ""
    if (
      !question.split(/\r?\n/).every((line) => /^>/.test(line)) ||
      question
        .split(/\r?\n/)
        .map((line) => line.replace(/^> ?/, ""))
        .join("\n")
        .trim() !== task.discussion.message.trim()
    )
      throw new Error("Discussion note must preserve the exact blockquoted student question")
  }
  checkArtifactPrivacy(text, task, privateCitations)
  const allowed = new Set([...task.sources, ...task.guidance].map((s) => s.path))
  const approvedGuidance = new Set([...task.guidance.map((s) => s.path), ...privateCitations])
  // The exact quoted inquiry is reference data, not an evidence citation. Scope
  // citation checks to the response; credential/private-path checks still cover all text.
  const evidenceText = task.discussion
    ? [...sections.entries()]
        .filter(([heading]) => heading !== "Student question")
        .map(([heading, body]) => `${heading}\n${body}`)
        .join("\n")
    : text
  const inline = [...evidenceText.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "")
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
  const sourceHeading = [...sections.keys()].find((heading) => /sources/i.test(heading))
  const sourceSection = sourceHeading ? (sections.get(sourceHeading) ?? "") : text
  if (
    ![...sourceSection.matchAll(/`([^`]+)`/g)].some((m) => allowed.has(m[1] ?? "")) &&
    allowed.size > 0
  )
    throw new Error("Sources section must cite exact task source paths in backticks")
  const requiredAnswers = [
    ...new Set([
      ...(task.workflow?.version === 2 || task.workflow?.version === 3
        ? (task.questions ?? [])
        : []),
      ...(task.deliverable && task.deliverable.kind !== "none"
        ? task.deliverable.items.map((item) => item.text)
        : []),
    ]),
  ]
  if (requiredAnswers.length)
    validateQuestionAnswers(
      text,
      requiredAnswers,
      task.sources,
      task.requirements,
      task.answerEvidenceVersion,
    )
}

function validateQuestionAnswers(
  text: string,
  questions: string[],
  sources: TaskRecord["sources"],
  requiredSections: string[],
  answerEvidenceVersion?: 1,
): void {
  let evidence: ReturnType<typeof prepareAnswerEvidence> | undefined
  for (const question of questions) {
    const escaped = question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const heading = new RegExp(`^#{3,6}\\s+${escaped}\\s*$`, "im")
    const match = heading.exec(text)
    if (!match || match.index === undefined)
      throw new Error(
        `Candidate must include an exact Markdown subheading for required question: ${question}`,
      )
    const before = text.slice(0, match.index)
    const parentSections = [...before.matchAll(/^##\s+(.+?)\s*$/gm)]
    const parentSection = parentSections[parentSections.length - 1]?.[1]?.trim()
    if (
      !parentSection ||
      !requiredSections.includes(parentSection) ||
      /sources/i.test(parentSection)
    )
      throw new Error(
        `Required question must be answered under a non-Sources required section: ${question}`,
      )
    const bodyStart = match.index + match[0].length
    const nextHeading = /\n#{1,6}\s+/g
    nextHeading.lastIndex = bodyStart
    const boundary = nextHeading.exec(text)?.index ?? text.length
    const answer = text.slice(bodyStart, boundary).trim()
    const hasSourceCitation = [...answer.matchAll(/`([^`]+)`/g)].some((item) =>
      sources.some((source) => source.path === item[1]),
    )
    const identifiesGap =
      /\b(?:not available|not present|does not address|do not address|insufficient (?:evidence|information)|cannot be determined from the supplied sources|PENDING\s*[-—–:]\s*requires\s+\S)/i.test(
        answer,
      )
    if (answer.length < 40 || (!hasSourceCitation && !identifiesGap))
      throw new Error(
        `Required question needs a substantive answer with an exact source citation or explicit evidence gap: ${question}`,
      )
    if (answerEvidenceVersion === 1 && !identifiesGap) {
      evidence ??= prepareAnswerEvidence(sources)
      const supported = evidence(question, answer)
      if (!supported.valid)
        throw new Error(
          `Required question answer needs five distinct content words, three beyond the question, and two novel words found in selected sources: ${question}`,
        )
    }
  }
}

async function verifyCurrentAssignment(
  vault: string,
  task: TaskRecord,
  course: CourseContext,
): Promise<void> {
  const assignment = task.assignment
  if (!assignment) throw new Error("Assignment task metadata is missing")
  const current = await deriveCurrentTaskInputs(vault, course, task)
  if (!("guidance" in current)) throw new Error("Assignment input recipe omitted guidance")
  const canonical = (_key: string, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value
  const sameRecords = (a: unknown[], b: unknown[]) =>
    JSON.stringify(a, canonical) === JSON.stringify(b, canonical)
  // Legacy parsers used different presentation metadata (titles, dates and
  // relation annotations). Content, roles, original hashes and selected paths
  // must still match exactly; newly created versioned tasks remain strict.
  const evidence = (sources: TaskRecord["sources"]) =>
    sources.map(({ path, hash, text, type, originalPath, originalHash, ingestProvenance }) => ({
      path,
      hash,
      text,
      type,
      originalPath,
      originalHash,
      ...(task.sources.find((source) => source.path === path)?.ingestProvenance
        ? { ingestProvenance }
        : {}),
    }))
  if (
    !sameRecords(
      task.parserVersion === 2
        ? current.sources.map((source) => {
            const saved = task.sources.find((item) => item.path === source.path)
            const { moduleDates, ingestProvenance, ...common } = source
            return {
              ...common,
              ...(saved?.moduleDates !== undefined ? { moduleDates } : {}),
              ...(saved?.ingestProvenance !== undefined ? { ingestProvenance } : {}),
            }
          })
        : evidence(current.sources),
      task.parserVersion === 2 ? task.sources : evidence(task.sources),
    )
  )
    throw new Error("Assignment inputs are stale: selected sources or their snapshots changed")
  if (!sameRecords(current.guidance, task.guidance))
    throw new Error("Course guidance changed or was modified since this task was created")
  if (!sameRecords(savedExclusions(current.excluded), task.excluded))
    throw new Error("Assignment source restrictions or exclusions changed since task creation")
  for (const source of task.sources) await verifySourceSnapshot(vault, source)
  return
}

async function verifyCurrentPrep(
  vault: string,
  task: TaskRecord,
  course: CourseContext,
  context: WorkspaceContext,
): Promise<void> {
  const period =
    task.period ?? (task.week ? { kind: "week" as const, value: task.week } : undefined)
  if (!period) throw new Error("Preparation task is missing its period")
  const currentPrepPeriod = resolvePrepPeriod(course, period)
  const currentSessionRoot = period.kind === "session" ? currentPrepPeriod.root : undefined
  if (period.kind === "session" && task.period?.root !== currentSessionRoot)
    throw new Error("Task session root no longer matches the selected module")
  const expected = productDestination(
    course.root,
    currentPrepPeriod.destination,
    task.productNamespaceVersion,
  )
  if (task.destination !== expected)
    throw new Error("Task destination does not match the current authoritative course and period")
  const { sources: currentRelevant, excluded: currentExcluded } = await deriveCurrentTaskInputs(
    vault,
    course,
    task,
  )
  const snap = new Map(task.sources.map((s) => [s.path, s]))
  if (
    currentRelevant.length !== snap.size ||
    currentRelevant.some(
      (s) =>
        snap.get(s.path)?.hash !== s.hash ||
        snap.get(s.path)?.text !== s.text ||
        (snap.get(s.path)?.ingestProvenance !== undefined &&
          JSON.stringify(snap.get(s.path)?.ingestProvenance) !==
            JSON.stringify(s.ingestProvenance)),
    )
  )
    throw new Error("Task sources are stale: source material was added, removed, or changed")
  const guidancePaths = task.guidanceSelectionVersion
    ? (
        await readSelectedGuidance(
          vault,
          course.guidance,
          "prep",
          undefined,
          [],
          restrictedGuidancePaths(course),
        )
      ).map((source) => source.path)
    : course.guidance
  if (
    guidancePaths.length !== task.guidance.length ||
    guidancePaths.some((path) => !task.guidance.some((s) => s.path === path))
  )
    throw new Error("Course guidance changed since this task was created")
  for (const saved of task.sources) {
    await verifySourceSnapshot(vault, saved)
  }
  for (const saved of task.guidance) {
    const current = await readGuidanceSnapshot(vault, saved.path, task.guidanceSelectionVersion)
    if (current.hash !== saved.hash)
      throw new Error(`Guidance changed since task creation: ${saved.path}`)
    if (current.text !== saved.text)
      throw new Error(`Guidance snapshot was modified: ${saved.path}`)
    if (
      task.guidanceSelectionVersion &&
      (current.canvasId !== saved.canvasId || current.canvasUrl !== saved.canvasUrl)
    )
      throw new Error("Guidance identity changed or was modified")
  }
  const relevantExcluded = savedExclusions(currentExcluded)
  const priorExcluded = task.excluded
  if (
    JSON.stringify(relevantExcluded.map((e) => [e.path, e.reason]).sort()) !==
    JSON.stringify(priorExcluded.map((e) => [e.path, e.reason]).sort())
  )
    throw new Error("Relevant source restrictions or exclusions changed since task creation")
  const relevantCurrentCodes = (context.diagnostics ?? [])
    .filter(
      (item) =>
        item.code === "workspace.restriction_present" || item.code === "workspace.symlink_skipped",
    )
    .map((item) => `${item.code}:${item.path ?? ""}`)
    .sort()
  const relevantPriorCodes = task.notices
    .filter((notice) => !/^Excluded /i.test(notice))
    .map((notice) => diagnosticFromLegacyNotice(notice))
    .filter(
      (item) =>
        item.code === "workspace.restriction_present" || item.code === "workspace.symlink_skipped",
    )
    .map((item) => `${item.code}:${item.path ?? ""}`)
    .sort()
  if (JSON.stringify(relevantCurrentCodes) !== JSON.stringify(relevantPriorCodes))
    throw new Error("Workspace restriction notices changed since task creation")
}

async function verifyCurrent(vault: string, task: TaskRecord): Promise<void> {
  await assertNoSymlinks(resolve(vault))
  const context = await inspectWorkspace(resolve(vault))
  const course = context.courses.find(
    (c) => c.code === task.course.code && c.root === task.course.root,
  )
  if (!course) throw new Error("Task course is missing or no longer uniquely identifiable")
  if (task.learningHistory) await verifyLearningHistory(vault, task.learningHistory, course)
  if (task.kind === "assignment") await verifyCurrentAssignment(vault, task, course)
  else await verifyCurrentPrep(vault, task, course, context)
}

function validateOutputReference(task: TaskRecord, output: string): void {
  safeRel(output)
  if (!output.startsWith(`${task.destination}/`))
    throw new Error("Completed output is outside the task destination")
  const filename = output.slice(task.destination.length + 1)
  if (parseArtifactVersion(filename, taskArtifactBaseName(task)) === undefined)
    throw new Error("Completed output filename is not a supported version")
}

async function verifyTaskDestination(vault: string, task: TaskRecord): Promise<void> {
  const period =
    task.period ?? (task.week ? { kind: "week" as const, value: task.week } : undefined)
  const context = await inspectWorkspace(resolve(vault))
  const course = context.courses.find(
    (c) => c.code === task.course.code && c.root === task.course.root,
  )
  let mismatched = !course
  if (course && task.kind === "prep") {
    const current = period ? resolvePrepPeriod(course, period) : undefined
    mismatched =
      !current ||
      (task.period?.root !== undefined && task.period.root !== current.root) ||
      productDestination(course.root, current.destination, task.productNamespaceVersion) !==
        task.destination
  } else if (course) {
    mismatched =
      !task.assignment ||
      task.destination !==
        productDestination(
          course.root,
          assignmentDraftsDirectory(task.assignment.source),
          task.productNamespaceVersion,
        )
  }
  if (mismatched)
    throw new Error("Task destination does not match the authoritative course and week")
}

export async function readVerifiedCompletedOutput(
  vault: string,
  id: string,
  maxBytes?: number,
): Promise<{ task: TaskRecord; output: string; bytes: Buffer; workbookBytes?: Buffer }> {
  return verifiedCompletedOutput(vault, id, maxBytes, "assignment-write")
}

/** Read any completed academic artifact, without granting revision/approval authority. */
export async function readSavedCompletedOutput(vault: string, id: string) {
  return verifiedCompletedOutput(vault, id, 5 * 1024 * 1024, "read-only")
}

async function verifiedCompletedOutput(
  vault: string,
  id: string,
  maxBytes: number | undefined,
  intent: "assignment-write" | "read-only",
): Promise<{ task: TaskRecord; output: string; bytes: Buffer; workbookBytes?: Buffer }> {
  await assertNoSymlinks(resolve(vault))
  const task = await readTask(vault, id)
  await readVerifiedBundle(vault, id, task)
  if (task.status !== "completed" || !task.completedAt || !task.output || !task.outputHash)
    throw new Error("Task is not completed with a saved output")
  if (intent === "assignment-write" && (task.kind !== "assignment" || !task.assignment))
    throw new Error("Only completed assignment outputs can be revised or approved")
  await verifyTaskLearningHistory(vault, task)
  validateOutputReference(task, task.output)
  if (!task.destination.startsWith(`${task.course.root}/`))
    throw new Error("Saved output destination differs from its course scope")
  if (intent === "assignment-write") await verifyTaskDestination(vault, task)
  const saved = await noLinks(vault, task.output)
  let bytes: Buffer
  if (maxBytes === undefined) bytes = await readFile(saved)
  else {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 50 * 1024 * 1024)
      throw new Error("Invalid completed-output byte limit")
    bytes = await readBoundedFile(saved, maxBytes)
  }
  if (digest(bytes) !== task.outputHash)
    throw new Error("Completed output is missing or has been modified")
  const workbookBytes = await verifyCompletedWorkbook(vault, task, bytes)
  return { task, output: task.output, bytes, ...(workbookBytes ? { workbookBytes } : {}) }
}

export async function verifyCompletedWorkbook(
  vault: string,
  task: TaskRecord,
  bytes: Buffer,
): Promise<Buffer | undefined> {
  if (!task.workbookVersion) return
  const expected = await draftWorkbookBytes(bytes.toString("utf8"))
  if (!expected) {
    if (task.workbook) throw new Error("Draft has unexpected automatic workbook metadata")
    return
  }
  const path = task.output?.replace(/\.md$/, ".xlsx")
  if (!task.workbook || task.workbook.path !== path || task.workbook.hash !== digest(expected))
    throw new Error("Draft workbook does not match its completion record")
  const saved = await noLinks(vault, task.workbook.path)
  await verifyWorkbookFile(saved, expected)
  return expected
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
  await verifyCompletedWorkbook(vault, task, actual)
  return { task, output }
}

async function reserveCompletionOutput(
  task: TaskRecord,
  destination: string,
  markerPath: string,
  candidateHash: string,
): Promise<string> {
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
    const base = taskArtifactBaseName(task)
    const name = nextArtifactName(base, files, Boolean(task.workbookVersion))
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
  return outputRel
}

export async function completeTask(
  vault: string,
  id: string,
  candidateFile: string,
  bundleReservation?: string,
): Promise<{ task: TaskRecord; output: string }> {
  await assertNoSymlinks(resolve(vault))
  const task = await readTask(vault, id)
  if (task.bundleHash && task.bundleHash !== bundleReservation)
    throw new Error("Task has a bundle reservation; complete with the same bundle manifest")
  const candidateBytes = await externalFile(candidateFile)
  const candidate = candidateBytes.toString("utf8")
  checkCandidate(candidate, id, task)
  const workbookBytes = task.workbookVersion ? await draftWorkbookBytes(candidate) : null
  const candidateHash = digest(candidateBytes)
  if (bundleReservation) {
    const bundle = await readVerifiedBundle(vault, id, task)
    if (
      !bundle ||
      bundle.files.find((file) => file.path === bundle.primary)?.hash !== candidateHash
    )
      throw new Error("Candidate does not match the reserved bundle primary response")
  }
  if (task.status === "completed") {
    await readVerifiedBundle(vault, id, task)
    const result = await completedResult(vault, task, candidateBytes)
    const completedTaskJson = await noLinks(vault, `_meta/tasks/${id}/task.json`)
    await unlink(join(dirname(completedTaskJson), "completion.transaction.json")).catch(
      () => undefined,
    )
    return result
  }
  await verifyCurrent(vault, task)
  await claimCompletionIntent(vault, id, {
    version: 1,
    kind: bundleReservation ? "bundle" : "file",
    hash: bundleReservation ?? candidateHash,
  })
  const destination = await noLinks(vault, task.destination, true)
  await mkdir(destination, { recursive: true, mode: 0o700 })
  // Re-check every created component after mkdir, including the course and vault ancestors.
  await noLinks(vault, task.destination)
  const taskJson = await noLinks(vault, `_meta/tasks/${id}/task.json`)
  const markerPath = join(dirname(taskJson), "completion.transaction.json")
  const outputRel = await reserveCompletionOutput(task, destination, markerPath, candidateHash)
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
  try {
    await publishExclusiveFile(finalPath, candidateBytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const existing = await readFile(finalPath)
    if (!existing.equals(candidateBytes))
      throw new Error("Output version already exists with different student content")
  }
  let workbook: TaskRecord["workbook"]
  if (workbookBytes) {
    const path = outputRel.replace(/\.md$/, ".xlsx")
    const absolute = await noLinks(vault, path, true)
    try {
      await publishExclusiveFile(absolute, workbookBytes)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      await verifyWorkbookFile(await noLinks(vault, path), workbookBytes)
    }
    workbook = { path, hash: digest(workbookBytes) }
  }
  const updated = TaskRecordSchema.parse({
    ...task,
    status: "completed",
    completedAt: new Date().toISOString(),
    output: outputRel,
    outputHash: candidateHash,
    ...(workbook ? { workbook } : {}),
  }) as TaskRecord
  await replaceFileAtomically(taskJson, `${JSON.stringify(updated, null, 2)}\n`)
  await unlink(markerPath).catch(() => undefined)
  return { task: updated, output: outputRel }
}
