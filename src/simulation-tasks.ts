import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { link, lstat, mkdir, open, readdir, rmdir, unlink, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { z } from "zod"
import { groupCategoryFromPrompt } from "./assignment-group.js"
import { checkCandidate } from "./completion.js"
import { captureTaskDeliverable } from "./deliverable-evidence.js"
import { draftWorkbookBytes, verifyWorkbookFile, workbookFromDraft } from "./draft-workbook.js"
import { assertNoSymlinks } from "./fs-safety.js"
import { selectTaskGuidance } from "./guidance-selection.js"
import { assignmentRelatedSources, relatedSources } from "./module-context.js"
import { resolveRequirements } from "./requirements.js"
import { replaySimulation } from "./simulation.js"
import { readSimulationWorkbooks } from "./simulation-workbooks.js"
import {
  hasPrepMaterial,
  selectPrepInputs,
  TaskRecordSchema,
  validateDiscussionMessage,
} from "./tasks.js"
import type { CourseContext, SourceRecord, TaskRecord } from "./types.js"
import { groupAssignmentInstruction, workflowForRequirements } from "./workflows.js"

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const optionsSchema = z
  .object({
    kind: z.enum(["prep", "assignment"]),
    week: z.string().optional(),
    session: z.string().optional(),
    source: z.string().optional(),
    mode: z.enum(["outline", "draft", "review", "discuss"]).optional(),
    work: z.string().min(1).optional(),
    message: z.string().optional(),
    context: z.array(z.string()).max(100).default([]),
  })
  .strict()
type Options = z.input<typeof optionsSchema>
const recordSchema = z
  .object({
    version: z.literal(1),
    selectionVersion: z.literal(2).optional(),
    prepSelectionVersion: z.literal(2).optional(),
    prepStructureVersion: z.literal(1).optional(),
    answerEvidenceVersion: z.literal(1).optional(),
    workflowVersion: z.literal(3).optional(),
    workbookVersion: z.literal(1).optional(),
    groupScopeVersion: z.literal(1).optional(),
    deliverableVersion: z.literal(1).optional(),
    deliverableScopeVersion: z.literal(1).optional(),
    deliverableParserVersion: z.union([z.literal(2), z.literal(3)]).optional(),
    guidanceSelectionVersion: z.union([z.literal(0), z.literal(1)]).optional(),
    assignmentStructureVersion: z.literal(1).optional(),
    simulationId: z.string().uuid(),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    options: optionsSchema,
    task: TaskRecordSchema,
  })
  .strict()
  .superRefine((record, ctx) => {
    if (
      record.answerEvidenceVersion &&
      (record.options.kind !== "prep" ||
        record.workflowVersion !== 3 ||
        record.task.answerEvidenceVersion !== record.answerEvidenceVersion)
    )
      ctx.addIssue({ code: "custom", message: "Frozen answer evidence recipe is invalid" })
    if (record.task.answerEvidenceVersion && !record.answerEvidenceVersion)
      ctx.addIssue({ code: "custom", message: "Frozen answer evidence recipe is missing" })
  })
const completionSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    simulationId: z.string().uuid(),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    output: z.string(),
    outputHash: z.string().regex(/^[a-f0-9]{64}$/),
    recipeHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    workbookVersion: z.literal(1).optional(),
    workbook: z
      .object({
        output: z.string(),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        inputHash: z.string().regex(/^[a-f0-9]{64}$/),
        size: z
          .number()
          .int()
          .positive()
          .max(5 * 1024 * 1024),
        sheets: z.array(z.string().min(1).max(31)).min(1).max(20),
      })
      .strict()
      .optional(),
    verdict: z.literal("pending-human"),
    historicalVerified: z.literal(false),
  })
  .strict()
function directory(vault: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new Error("Simulation task ID must be a UUID")
  return join(resolve(vault), "_meta/simulations/tasks", id)
}
async function textFile(path: string, limit = 20_000_000, budget?: { remaining: number }) {
  await assertNoSymlinks(path)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > limit)
      throw new Error("Simulation task file is not a bounded regular file")
    if (budget) {
      budget.remaining -= stat.size
      if (budget.remaining < 0) throw new Error("Frozen task inventory exceeds 100 MB")
    }
    let buffer = Buffer.alloc(Math.min(limit + 1, Math.max(1, stat.size + 1)))
    let length = 0
    while (length < limit + 1) {
      if (length === buffer.length) {
        const larger = Buffer.alloc(Math.min(limit + 1, Math.max(64 * 1024, buffer.length * 2)))
        buffer.copy(larger, 0, 0, length)
        buffer = larger
      }
      const part = await handle.read(buffer, length, buffer.length - length, length)
      if (!part.bytesRead) break
      length += part.bytesRead
    }
    if (budget && length > stat.size) {
      budget.remaining -= length - stat.size
      if (budget.remaining < 0) throw new Error("Frozen task inventory exceeds 100 MB")
    }
    if (length > limit) throw new Error("Simulation task file exceeds bounded read limits")
    const bytes = buffer.subarray(0, length)
    if (bytes.includes(0) || !Buffer.from(bytes.toString()).equals(bytes))
      throw new Error("Simulation task file must be safe UTF-8")
    return bytes.toString()
  } finally {
    await handle.close()
  }
}
async function derive(
  vault: string,
  simulationId: string,
  options: z.output<typeof optionsSchema>,
  id: string,
  createdAt: string,
  selectionVersion?: 2,
  workflowVersion?: 3,
  workbookVersion?: 1,
  prepSelectionVersion?: 2,
  prepStructureVersion?: 1,
  groupScopeVersion?: 1,
  deliverableVersion?: 1,
  deliverableScopeVersion?: 1,
  guidanceSelectionVersion?: 0 | 1,
  assignmentStructureVersion?: 1,
  deliverableParserVersion?: 2 | 3,
  answerEvidenceVersion?: 1,
  budget?: { remaining: number },
) {
  if (groupScopeVersion && (options.kind !== "assignment" || workflowVersion !== 3))
    throw new Error("Frozen group scope requires the current assignment workflow")
  if (workbookVersion && (options.kind !== "assignment" || options.mode !== "draft"))
    throw new Error("Automatic frozen workbooks require an assignment draft")
  if (answerEvidenceVersion && (options.kind !== "prep" || workflowVersion !== 3))
    throw new Error("Frozen answer evidence requires the current prep workflow")
  const replay = await replaySimulation(vault, simulationId, budget)
  const all: SourceRecord[] = replay.sources.map(
    ({ availabilitySignals: _signals, ...source }) => source,
  )
  let guidance: SourceRecord[] =
    selectionVersion === 2
      ? replay.guidance.map(({ availabilitySignals: _signals, ...source }) => source)
      : []
  const course: CourseContext = {
    ...replay.course,
    sources: all.filter((source) => source.type !== "student-work"),
    excluded: replay.excluded,
    guidance: [],
    existingWork: [],
    periods: [
      ...new Set(
        all.flatMap(
          (source) => source.path.match(/^(.+\/(?:Week|Milestone) \d+[^/]*)(?:\/|$)/)?.[1] ?? [],
        ),
      ),
    ],
  }
  let sources: SourceRecord[], period: TaskRecord["period"]
  validateDiscussionMessage(options.mode, options.message)
  if (options.kind === "prep") {
    if (
      Boolean(options.week) === Boolean(options.session) ||
      options.source ||
      options.mode ||
      options.work ||
      options.message !== undefined ||
      options.context.length
    )
      throw new Error(
        "Snapshot prep needs exactly one explicit week/session; no assignment options",
      )
    period = {
      kind: options.week ? "week" : "session",
      value: options.week ?? options.session ?? "",
    }
    sources = selectPrepInputs(course, period, prepSelectionVersion ?? 1).sources
    if (!hasPrepMaterial(course, sources))
      throw new Error("Snapshot has no substantive preparation material for this period")
  } else {
    if (!options.source || !options.mode || options.week || options.session)
      throw new Error("Snapshot assignment needs an explicit source and assignment mode")
    if (options.mode === "review" && !options.work)
      throw new Error("Snapshot review requires --work pointing to captured student work")
    const prompt = all.find(
      (source) => source.path === options.source && /^assignments?(?:\.md)?$/i.test(source.type),
    )
    if (!prompt) throw new Error("Assignment prompt is not in the approved fixed snapshot")
    const context = options.context.map((path) => {
      const source = course.sources.find((entry) => entry.path === path)
      if (!source) throw new Error("Requested context is not in the approved fixed snapshot")
      return source
    })
    sources = [
      prompt,
      ...relatedSources(course, [
        ...(selectionVersion === 2
          ? assignmentRelatedSources(course, prompt, options.context)
          : [prompt]),
        ...context,
      ]).filter((source) => source.path !== prompt.path),
    ]
    if (options.work) {
      const work = all.find((entry) => entry.path === options.work && entry.type === "student-work")
      if (!work)
        throw new Error(
          "Student work is not in the approved fixed snapshot; explicitly capture it first",
        )
      sources.push(work)
    }
  }
  if (guidanceSelectionVersion) {
    if (workflowVersion !== 3 || selectionVersion !== 2 || replay.guidanceIdentityVersion !== 1)
      throw new Error(
        "Frozen scoped guidance requires a versioned identity capture and current workflow",
      )
    guidance = selectTaskGuidance(options.kind, guidance, sources[0])
    if (
      replay.restrictedGuidanceVersion === 1 &&
      selectTaskGuidance(options.kind, replay.restrictedGuidance ?? [], sources[0]).length
    )
      throw new Error(
        "Selected frozen guidance is excluded by policy; review the captured restriction before creating work",
      )
  }
  if (deliverableVersion && workflowVersion !== 3)
    throw new Error("Frozen deliverables require the current workflow")
  if (deliverableParserVersion && !deliverableVersion)
    throw new Error("Frozen deliverable parser requires captured deliverables")
  const deliverable = deliverableVersion
    ? captureTaskDeliverable(
        options.kind,
        options.mode,
        sources,
        guidance,
        deliverableScopeVersion,
        deliverableParserVersion,
      )
    : undefined
  const resolved = resolveRequirements(
    options.kind,
    options.mode,
    sources,
    guidance,
    2,
    deliverable,
    assignmentStructureVersion,
    prepStructureVersion,
  )
  const groupCategoryId = groupScopeVersion
    ? groupCategoryFromPrompt(sources.find((source) => source.path === options.source)?.text ?? "")
    : undefined
  const task: TaskRecord = {
    version: 1,
    ...(deliverable ? { deliverable } : {}),
    ...(deliverableScopeVersion ? { deliverableScopeVersion } : {}),
    ...(deliverableParserVersion ? { deliverableParserVersion } : {}),
    ...(guidanceSelectionVersion ? { guidanceSelectionVersion } : {}),
    ...(assignmentStructureVersion ? { assignmentStructureVersion } : {}),
    parserVersion: 2,
    ...(prepSelectionVersion ? { prepSelectionVersion } : {}),
    ...(prepStructureVersion ? { prepStructureVersion } : {}),
    ...(answerEvidenceVersion ? { answerEvidenceVersion } : {}),
    ...(workbookVersion ? { workbookVersion } : {}),
    ...(groupScopeVersion ? { groupScopeVersion } : {}),
    id,
    status: "pending",
    kind: options.kind,
    createdAt,
    course: replay.course,
    ...(period ? { period, ...(options.week ? { week: options.week } : {}) } : {}),
    ...(options.source && options.mode
      ? {
          assignment: {
            source: options.source,
            mode: options.mode,
            ...(options.work ? { work: options.work } : {}),
            context: sources
              .filter((source) => source.path !== options.source && source.path !== options.work)
              .map((source) => source.path),
            ...(groupCategoryId ? { groupCategoryId } : {}),
          },
        }
      : {}),
    destination: `_meta/simulations/tasks/${id}`,
    sources,
    ...(options.message !== undefined
      ? { discussion: { message: options.message.trim().replaceAll("\r\n", "\n") } }
      : {}),
    guidance,
    excluded: replay.excluded,
    questions: resolved.questions,
    requirements: resolved.sections,
    workflow: workflowForRequirements(
      options.kind,
      options.mode,
      resolved.sections,
      resolved.questions,
      resolved.guidanceInstructions,
      workflowVersion ?? 2,
      deliverable,
      assignmentStructureVersion,
      answerEvidenceVersion,
    ),
    notices: [
      ...(guidanceSelectionVersion === 0
        ? [
            "This older capture has no versioned guidance identity evidence. Whole-course guidance selection remains unverified, not assignment-isolated; review ownership or create a fresh capture. No live guidance is borrowed.",
          ]
        : []),
      replay.limitation,
      "Evaluation output is private and never replaces student coursework. Independently confirm current AI-use permission before host generation; captured technical eligibility is not instructor authorization.",
      "Use fixed source bodies only. Missing context requires a fresh capture or explicit limitation, never current-vault substitution.",
      ...(selectionVersion === 2 && options.kind === "assignment"
        ? [
            "Selection recipe v2 includes explicitly linked owning and ordered preceding teaching modules from this capture only. Review the complete supplied source list; never downgrade/edit the recipe to remove context.",
          ]
        : []),
    ],
  }
  if (groupCategoryId)
    task.workflow?.instructions.push(
      groupAssignmentInstruction(
        groupCategoryId,
        assignmentStructureVersion ? resolved.sections : undefined,
      ),
    )
  return recordSchema.parse({
    version: 1,
    ...(selectionVersion ? { selectionVersion } : {}),
    ...(prepSelectionVersion ? { prepSelectionVersion } : {}),
    ...(prepStructureVersion ? { prepStructureVersion } : {}),
    ...(answerEvidenceVersion ? { answerEvidenceVersion } : {}),
    ...(workflowVersion ? { workflowVersion } : {}),
    ...(workbookVersion ? { workbookVersion } : {}),
    ...(groupScopeVersion ? { groupScopeVersion } : {}),
    ...(deliverableVersion ? { deliverableVersion } : {}),
    ...(deliverableScopeVersion ? { deliverableScopeVersion } : {}),
    ...(deliverableParserVersion ? { deliverableParserVersion } : {}),
    ...(guidanceSelectionVersion !== undefined ? { guidanceSelectionVersion } : {}),
    ...(assignmentStructureVersion ? { assignmentStructureVersion } : {}),
    simulationId,
    snapshotHash: replay.snapshotHash,
    options,
    task,
  })
}
export async function createSimulationTask(vault: string, simulationId: string, input: Options) {
  const options = optionsSchema.parse(input),
    id = randomUUID()
  const capture = await replaySimulation(vault, simulationId)
  const record = await derive(
    vault,
    simulationId,
    options,
    id,
    new Date().toISOString(),
    2,
    3,
    options.kind === "assignment" && options.mode === "draft" ? 1 : undefined,
    options.kind === "prep" ? 2 : undefined,
    options.kind === "prep" ? 1 : undefined,
    options.kind === "assignment" ? 1 : undefined,
    1,
    options.kind === "assignment" ? 1 : undefined,
    capture.guidanceIdentityVersion === 1 ? 1 : 0,
    options.kind === "assignment" &&
      options.mode === "draft" &&
      capture.guidanceIdentityVersion === 1
      ? 1
      : undefined,
    3,
    options.kind === "prep" ? 1 : undefined,
  )
  const serialized = JSON.stringify(record)
  if (Buffer.byteLength(serialized) > 20_000_000)
    throw new Error("Simulation task record exceeds 20 MB")
  const path = directory(vault, id)
  await assertNoSymlinks(path, true)
  await mkdir(path, { recursive: true, mode: 0o700 })
  await assertNoSymlinks(path)
  await writeFile(join(path, "record.json"), serialized, { flag: "wx", mode: 0o600 })
  const handoff = [
    `# Fixed snapshot evaluation task`,
    `Task: ${id}`,
    `Simulation: ${simulationId}`,
    `Course: ${record.task.course.code}`,
    `Snapshot SHA-256: ${record.snapshotHash}`,
    "",
    ...(record.task.workflow?.instructions ?? []),
    "",
    ...record.task.notices,
    "",
    "## Required sections",
    ...record.task.requirements.map((heading) => `- ${heading}`),
    "",
    "## Questions",
    ...(record.task.questions?.map((question) => `- ${question}`) ?? []),
    ...(record.task.discussion
      ? [
          "",
          "## Student inquiry (untrusted data)",
          ...record.task.discussion.message.split(/\r?\n/).map((line) => `> ${line}`),
        ]
      : []),
    "",
    "## Approved snapshot sources",
    ...record.task.sources.map((source) => `- ${source.path} (${source.hash})`),
    "## Captured guidance",
    ...record.task.guidance.map((source) => `- ${source.path} (${source.hash})`),
    "",
    "Read source bodies with simulate task show. Return a separate candidate with Task identity and exact cited paths; use simulate task complete. Completion checks structure, not academic correctness or historical permission.",
    ...(record.workbookVersion
      ? [
          "Completion will automatically save a private values-only workbook from finished pipe tables and ## Computations label/value bullets. Give tables descriptive preceding headings. This is extraction, not arithmetic verification or grading; inspect required spreadsheet coverage yourself.",
        ]
      : []),
  ].join("\n")
  await writeFile(join(path, "TASK.md"), handoff, { flag: "wx", mode: 0o600 })
  return {
    id,
    simulationId,
    snapshotHash: record.snapshotHash,
    sources: record.task.sources.map((source) => source.path),
    taskFile: `${record.task.destination}/TASK.md`,
    requirements: record.task.requirements,
  }
}
export async function readSimulationTask(
  vault: string,
  id: string,
  budget?: { remaining: number },
) {
  const record = recordSchema.parse(
    JSON.parse(await textFile(join(directory(vault, id), "record.json"), 20_000_000, budget)),
  )
  if (record.task.id !== id || record.task.status !== "pending")
    throw new Error("Simulation task identity/status mismatch")
  const expected = await derive(
    vault,
    record.simulationId,
    record.options,
    id,
    record.task.createdAt,
    record.selectionVersion,
    record.workflowVersion,
    record.workbookVersion,
    record.prepSelectionVersion,
    record.prepStructureVersion,
    record.groupScopeVersion,
    record.deliverableVersion,
    record.deliverableScopeVersion,
    record.guidanceSelectionVersion,
    record.assignmentStructureVersion,
    record.deliverableParserVersion,
    record.answerEvidenceVersion,
    budget,
  )
  if (JSON.stringify(expected) !== JSON.stringify(record))
    throw new Error("Simulation task differs from its authoritative snapshot/recipe")
  return record
}

/** Discover immutable frozen recipes; completion receipts and output files are separate. */
export async function listSimulationTasks(vault: string, query: string) {
  const course = query.trim()
  if (!course) throw new Error("Choose an explicit captured course code")
  const path = join(resolve(vault), "_meta/simulations/tasks")
  await assertNoSymlinks(path, true)
  const entries = await readdir(path, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  })
  if (entries.length > 5000) throw new Error("Frozen task inventory exceeds 5000 entries")
  const budget = { remaining: 100_000_000 }
  const tasks: Array<{
    id: string
    captureId: string
    createdAt: string
    kind: TaskRecord["kind"]
    period?: TaskRecord["period"]
    mode?: NonNullable<TaskRecord["assignment"]>["mode"]
    promptPath?: string
  }> = []
  let unreadableRecords = 0
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!z.string().uuid().safeParse(entry.name).success) continue
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("Unsafe frozen task entry")
      const record = await readSimulationTask(vault, entry.name, budget)
      if (record.task.course.code.toLowerCase() !== course.toLowerCase()) continue
      tasks.push({
        id: record.task.id,
        captureId: record.simulationId,
        createdAt: record.task.createdAt,
        kind: record.task.kind,
        ...(record.task.period ? { period: record.task.period } : {}),
        ...(record.task.assignment
          ? { mode: record.task.assignment.mode, promptPath: record.task.assignment.source }
          : {}),
      })
    } catch {
      if (budget.remaining < 0) throw new Error("Frozen task inventory exceeds 100 MB")
      unreadableRecords++
    }
  }
  tasks.sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id),
  )
  return {
    course,
    tasks,
    unreadableRecords,
    inventoryComplete: unreadableRecords === 0,
    limitation:
      "Validated immutable frozen recipe metadata and capture bindings only, not completion receipts, output bytes, academic quality, permission or live workers. No current vault sources are read. Inspect the selected frozen task before continuing; unreadable records have unknown course scope and may hide tasks. The 100 MB read budget includes repeated capture/parent validation.",
  }
}
export async function completeSimulationTask(vault: string, id: string, file: string) {
  if (!isAbsolute(file)) throw new Error("Simulation candidate path must be absolute")
  const record = await readSimulationTask(vault, id),
    candidate = await textFile(file, 5_000_000)
  checkCandidate(candidate, id, record.task)
  const input = record.workbookVersion ? workbookFromDraft(candidate) : null
  const workbookBytes = input ? await draftWorkbookBytes(candidate) : null
  const path = join(directory(vault, id), "output.md"),
    outputHash = sha(candidate)
  const marker = completionSchema.parse({
    version: 1,
    id,
    simulationId: record.simulationId,
    snapshotHash: record.snapshotHash,
    output: `${record.task.destination}/output.md`,
    outputHash,
    ...(record.workbookVersion ? { workbookVersion: record.workbookVersion } : {}),
    ...(record.workbookVersion ? { recipeHash: sha(JSON.stringify(record)) } : {}),
    ...(workbookBytes && input
      ? {
          workbook: {
            output: `${record.task.destination}/output.xlsx`,
            hash: sha(workbookBytes),
            inputHash: sha(JSON.stringify(input)),
            size: workbookBytes.length,
            sheets: input.sheets.map((sheet) => sheet.name),
          },
        }
      : {}),
    verdict: "pending-human",
    historicalVerified: false,
  })
  const metadata = join(directory(vault, id), "completion.json")
  await assertNoSymlinks(metadata, true)
  const lock = join(directory(vault, id), "completion.lock")
  await assertNoSymlinks(lock, true)
  await mkdir(lock, { mode: 0o700 })
  const workbookLock = join(directory(vault, id), "workbooks.lock")
  let workbookLockOwned = false
  try {
    if (record.workbookVersion) {
      await assertNoSymlinks(workbookLock, true)
      await mkdir(workbookLock, { mode: 0o700 })
      workbookLockOwned = true
    }
    const current = await inspectSimulationTask(vault, id)
    if (current.state === "completed-pending-human") {
      if (current.completion.outputHash !== outputHash)
        throw new Error("A different simulation output already exists; create a new task")
      if (JSON.stringify(current.completion) !== JSON.stringify(marker))
        throw new Error("Simulation completion metadata differs; inspect before retrying")
      if (record.workbookVersion) await readSimulationWorkbooks(vault, id)
      return current.completion
    }
    const workbookPath = join(directory(vault, id), "output.xlsx")
    if (record.workbookVersion && !workbookBytes) await requireMissingWorkbook(workbookPath)
    if (workbookBytes) await assertNoSymlinks(workbookPath, true)
    if (record.workbookVersion) {
      const inventory = await readSimulationWorkbooks(vault, id)
      if (inventory.recipeHash !== sha(JSON.stringify(record)))
        throw new Error("Frozen workbook recipe changed during completion")
      if (
        workbookBytes &&
        (inventory.records.length >= 20 ||
          inventory.totalBytes + workbookBytes.length + Buffer.byteLength(JSON.stringify(marker)) >
            50_000_000)
      )
        throw new Error("Automatic workbook requires free companion count and byte capacity")
    }
    await installExclusive(
      path,
      Buffer.from(candidate),
      "A different simulation output already exists; create a new task",
    )
    if (workbookBytes) await installExclusive(workbookPath, workbookBytes)
    await installExclusive(metadata, Buffer.from(JSON.stringify(marker)))
  } finally {
    try {
      if (workbookLockOwned) await rmdir(workbookLock)
    } finally {
      await rmdir(lock)
    }
  }
  return marker
}

async function requireMissingWorkbook(path: string): Promise<void> {
  await assertNoSymlinks(path, true)
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  throw new Error("Unexpected automatic workbook; inspect without deleting or adopting it")
}

async function installExclusive(
  path: string,
  bytes: Buffer,
  mismatch = "Simulation completion artifact differs; inspect before retrying",
): Promise<void> {
  await assertNoSymlinks(path, true)
  const temporary = `${path}.tmp-${randomUUID()}`
  try {
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await assertNoSymlinks(path, true)
    try {
      await link(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      try {
        await verifyWorkbookFile(path, bytes)
      } catch {
        throw new Error(mismatch)
      }
    }
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}
export async function inspectSimulationTask(vault: string, id: string) {
  const record = await readSimulationTask(vault, id)
  const path = join(directory(vault, id), "completion.json")
  let raw: string
  try {
    raw = await textFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ...record, state: "pending-host" as const }
    throw error
  }
  const completion = completionSchema.parse(JSON.parse(raw))
  if (
    completion.id !== id ||
    completion.simulationId !== record.simulationId ||
    completion.snapshotHash !== record.snapshotHash ||
    completion.output !== `${record.task.destination}/output.md`
  )
    throw new Error("Simulation completion identity or output path mismatch")
  const output = await textFile(join(directory(vault, id), "output.md"), 5_000_000)
  if (sha(output) !== completion.outputHash)
    throw new Error("Simulation output changed after completion")
  checkCandidate(output, id, record.task)
  if (
    completion.workbookVersion !== record.workbookVersion ||
    (!record.workbookVersion && (completion.workbook || completion.recipeHash)) ||
    (record.workbookVersion && completion.recipeHash !== sha(JSON.stringify(record)))
  )
    throw new Error("Simulation workbook completion recipe mismatch")
  if (record.workbookVersion) {
    const input = workbookFromDraft(output)
    const expected = input ? await draftWorkbookBytes(output) : null
    if (expected && input) {
      const book = completion.workbook
      if (
        !book ||
        book.output !== `${record.task.destination}/output.xlsx` ||
        book.hash !== sha(expected) ||
        book.inputHash !== sha(JSON.stringify(input)) ||
        book.size !== expected.length ||
        JSON.stringify(book.sheets) !== JSON.stringify(input.sheets.map((sheet) => sheet.name))
      )
        throw new Error("Simulation automatic workbook binding changed")
      await verifyWorkbookFile(join(directory(vault, id), "output.xlsx"), expected)
    } else {
      if (completion.workbook) throw new Error("Simulation has unexpected workbook metadata")
      await requireMissingWorkbook(join(directory(vault, id), "output.xlsx"))
    }
  }
  return { ...record, state: "completed-pending-human" as const, completion }
}

/** Return existing verified bytes only, never create a replacement frozen output. */
export async function readSavedSimulationOutput(vault: string, id: string) {
  const record = await inspectSimulationTask(vault, id)
  if (!("completion" in record)) throw new Error("Frozen task has no completed saved output")
  const text = await textFile(join(directory(vault, id), "output.md"), 5_000_000)
  if (sha(text) !== record.completion.outputHash)
    throw new Error("Frozen output changed during inspection")
  return { record, text }
}
