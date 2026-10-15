import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { link, lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { prepareAnswerEvidence } from "./answer-evidence.js"
import { verifyLearningHistory, verifyTaskLearningHistory } from "./canvas-feedback.js"
import { draftWorkbookBytes, verifyWorkbookFile } from "./draft-workbook.js"
import { assertNoSymlinks } from "./fs-safety.js"
import { restrictedGuidancePaths } from "./guidance-selection.js"
import { productDestination } from "./product-destination.js"
import {
  readGuidanceSnapshot,
  readSelectedGuidance,
  readTask,
  resolvePrepDestination,
  resolveSessionRoot,
  selectAssignmentInputs,
  selectLegacyPrepInputs,
  selectPrepInputs,
  TaskRecordSchema,
  verifySourceSnapshot,
} from "./tasks.js"
import type { CourseContext, TaskRecord } from "./types.js"
import { assignmentOutputLabel, workflowFor } from "./workflows.js"
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
  if (task.learningHistory) await verifyLearningHistory(vault, task.learningHistory, course)
  if (task.kind === "assignment") {
    const assignment = task.assignment
    if (!assignment) throw new Error("Assignment task metadata is missing")
    const current = await selectAssignmentInputs(
      vault,
      course,
      assignment.source,
      assignment.work,
      assignment.context,
      task.parentTaskId
        ? task.sources.find((source) => source.path === assignment.work)
        : undefined,
      task.guidanceSelectionVersion,
    )
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
    if (!sameRecords(current.excluded, task.excluded))
      throw new Error("Assignment source restrictions or exclusions changed since task creation")
    for (const source of task.sources) await verifySourceSnapshot(vault, source)
    return
  }
  const period =
    task.period ?? (task.week ? { kind: "week" as const, value: task.week } : undefined)
  if (!period) throw new Error("Preparation task is missing its period")
  const currentSessionRoot =
    period.kind === "session" ? resolveSessionRoot(course, period.value) : undefined
  if (period.kind === "session" && task.period?.root !== currentSessionRoot)
    throw new Error("Task session root no longer matches the selected module")
  const expected =
    period.kind === "week"
      ? expectedDestination(course, period.value)
      : currentSessionRoot &&
          (/(?:^|\/)Week\s+\d+\b/i.test(currentSessionRoot) ||
            /(?:^|\/)Milestone\s+\d+\b/i.test(currentSessionRoot))
        ? `${currentSessionRoot}/Prep`
        : course.root +
          "/Other/Prep/session-" +
          (period.value
            .toLocaleLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "session")
  if (task.destination !== expected)
    throw new Error("Task destination does not match the current authoritative course and period")
  const { sources: currentRelevant, excluded: currentExcluded } =
    (!task.workflow || task.workflow.version === 1) && period.kind === "week"
      ? selectLegacyPrepInputs(course, period.value)
      : selectPrepInputs(course, period, task.prepSelectionVersion ?? 1)
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
          `^01 Assignment ${assignmentOutputLabel(task.assignment?.mode ?? "review")}(?:\\.v(?:[2-9]|[1-9]\\d+))?\\.md$`,
        ).test(filename)
  if (!valid) throw new Error("Completed output filename is not a supported version")
}

async function verifyTaskDestination(vault: string, task: TaskRecord): Promise<void> {
  const period = task.period
  const context = await inspectWorkspace(resolve(vault))
  const course = context.courses.find(
    (c) => c.code === task.course.code && c.root === task.course.root,
  )
  if (
    !course ||
    (task.kind === "prep"
      ? period?.kind === "session"
        ? (() => {
            const currentRoot = resolveSessionRoot(course, period.value)
            return (
              task.period?.root !== currentRoot ||
              task.destination !==
                productDestination(
                  course.root,
                  /(?:^|\/)Week\s+\d+\b/i.test(currentRoot) ||
                    /(?:^|\/)Milestone\s+\d+\b/i.test(currentRoot)
                    ? `${currentRoot}/Prep`
                    : course.root +
                        "/Other/Prep/session-" +
                        (period.value
                          .toLocaleLowerCase()
                          .replace(/[^a-z0-9]+/g, "-")
                          .replace(/^-|-$/g, "") || "session"),
                  task.productNamespaceVersion,
                )
            )
          })()
        : !task.week ||
          productDestination(
            course.root,
            resolvePrepDestination(course, task.week),
            task.productNamespaceVersion,
          ) !== task.destination
      : !task.assignment ||
        task.destination !==
          productDestination(
            course.root,
            `${task.assignment.source.slice(0, task.assignment.source.lastIndexOf("/"))}/Drafts`,
            task.productNamespaceVersion,
          ))
  )
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
    const handle = await open(
      saved,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > maxBytes)
        throw new Error("Completed output exceeds bounded regular-file limits")
      const buffer = Buffer.alloc(maxBytes + 1)
      let length = 0
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, length)
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      if (length > maxBytes) throw new Error("Completed output exceeds byte limits")
      bytes = buffer.subarray(0, length)
    } finally {
      await handle.close()
    }
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
  const workbookBytes = task.workbookVersion ? await draftWorkbookBytes(candidate) : null
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
        : `01 Assignment ${assignmentOutputLabel(task.assignment?.mode ?? "review")}.md`
    let name = base
    let version = 2
    while (
      files.includes(name) ||
      (task.workbookVersion && files.includes(name.replace(/\.md$/, ".xlsx")))
    )
      name = `${base.slice(0, -3)}.v${version++}.md`
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
  let workbook: TaskRecord["workbook"]
  if (workbookBytes) {
    const path = outputRel.replace(/\.md$/, ".xlsx")
    const absolute = await noLinks(vault, path, true)
    const temporary = `${absolute}.tmp-${randomUUID()}`
    try {
      const handle = await open(temporary, "wx", 0o600)
      try {
        await handle.writeFile(workbookBytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await link(temporary, absolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      await verifyWorkbookFile(await noLinks(vault, path), workbookBytes)
    } finally {
      await unlink(temporary).catch(() => undefined)
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
  await atomicReplace(taskJson, `${JSON.stringify(updated, null, 2)}\n`)
  await unlink(markerPath).catch(() => undefined)
  return { task: updated, output: outputRel }
}
