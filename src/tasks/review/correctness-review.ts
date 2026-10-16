import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, open, readdir, rename, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { assertNoSymlinks } from "../../shared/fs-safety.js"
import type { TaskRecord } from "../../shared/types.js"
import { readSimulationCalculations } from "../../simulation/calculations.js"
import { inspectSimulationTask } from "../../simulation/tasks.js"
import { checkCandidate, readVerifiedCompletedOutput } from "../artifacts/completion.js"
import { auditTaskSnapshots } from "../artifacts/inspection.js"
import { correctnessReviewInstructions } from "../authoring/workflows.js"
import { readTaskCalculationEvidence } from "../calculations/numeric-review.js"

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const uuid = z.string().uuid()
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const recordSchema = z
  .object({
    version: z.literal(1),
    id: uuid,
    taskId: uuid,
    course: z.string().min(1),
    createdAt: z.string().datetime(),
    taskHash: hash,
    calculationHash: hash,
    handoffHash: hash,
  })
  .strict()
const frozenRecordSchema = recordSchema
  .extend({
    version: z.literal(2),
    kind: z.literal("frozen"),
    simulationId: uuid,
    snapshotHash: hash,
  })
  .strict()
const anyRecordSchema = z.union([recordSchema, frozenRecordSchema])
const receiptSchema = z
  .object({ version: z.literal(1), id: uuid, recordHash: hash, reviewHash: hash })
  .strict()

async function text(path: string, limit: number): Promise<string> {
  await assertNoSymlinks(path)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > limit)
      throw new Error("Review input exceeds regular-file bounds")
    const bytes = Buffer.alloc(limit + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    if (length > limit || bytes.subarray(0, length).includes(0))
      throw new Error("Unsafe review input")
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))
  } finally {
    await handle.close()
  }
}

function directory(vault: string, id: string) {
  return join(resolve(vault), "_meta/correctness-reviews", uuid.parse(id))
}

interface ReviewEvidence {
  task: TaskRecord
  output: string
  bytes: Buffer
  workbookBytes?: Buffer
  workbookPath?: string
  workbookHash?: string
  calculations: { records: unknown[]; hash: string }
  taskHash: string
  frozen?: { simulationId: string; snapshotHash: string }
}

async function evidence(vault: string, taskId: string, frozen = false): Promise<ReviewEvidence> {
  if (frozen) {
    const inspected = await inspectSimulationTask(vault, uuid.parse(taskId))
    if (
      inspected.state !== "completed-pending-human" ||
      inspected.task.assignment?.mode !== "draft"
    )
      throw new Error("Frozen correctness review requires a completed draft evaluation")
    const output = inspected.completion.output
    const bytes = Buffer.from(await text(join(resolve(vault), output), 5_000_000))
    if (sha(bytes) !== inspected.completion.outputHash)
      throw new Error("Frozen review output changed")
    const arithmetic = await readSimulationCalculations(vault, taskId)
    return {
      task: inspected.task,
      output,
      bytes,
      workbookPath: inspected.completion.workbook?.output,
      workbookHash: inspected.completion.workbook?.hash,
      calculations: { records: arithmetic.records, hash: arithmetic.recordsHash },
      taskHash: sha(JSON.stringify(inspected)),
      frozen: { simulationId: inspected.simulationId, snapshotHash: inspected.snapshotHash },
    }
  }
  const completed = await readVerifiedCompletedOutput(vault, uuid.parse(taskId), 5 * 1024 * 1024)
  if (completed.task.assignment?.mode !== "draft")
    throw new Error("Correctness review requires a completed assignment draft")
  if (!(await auditTaskSnapshots(vault, completed.task)).current)
    throw new Error("Correctness review sources are stale")
  const calculations = await readTaskCalculationEvidence(vault, completed.task)
  return {
    ...completed,
    workbookPath: completed.task.workbook?.path,
    workbookHash: completed.task.workbook?.hash,
    calculations,
    taskHash: sha(JSON.stringify(completed.task)),
  }
}

export async function showCorrectnessReview(vault: string, id: string) {
  const root = directory(vault, id)
  const raw = await text(join(root, "review.json"), 20_000)
  let record: z.infer<typeof anyRecordSchema>
  try {
    record = anyRecordSchema.parse(JSON.parse(raw))
  } catch {
    throw new Error("Invalid correctness review record")
  }
  if (record.id !== id) throw new Error("Correctness review identity differs")
  const current = await evidence(vault, record.taskId, record.version === 2)
  if (
    current.task.course.code !== record.course ||
    current.taskHash !== record.taskHash ||
    current.calculations.hash !== record.calculationHash ||
    (record.version === 2 &&
      (record.simulationId !== current.frozen?.simulationId ||
        record.snapshotHash !== current.frozen.snapshotHash))
  )
    throw new Error("Correctness review evidence changed; create a new review")
  const handoff = await text(join(root, "HANDOFF.md"), 25 * 1024 * 1024)
  if (sha(handoff) !== record.handoffHash) throw new Error("Correctness review handoff changed")
  let status: "pending" | "completed" = "pending"
  let reviewHash: string | null = null
  let receiptText: string | undefined
  try {
    receiptText = await text(join(root, "receipt.json"), 20_000)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (receiptText !== undefined) {
    let receipt: z.infer<typeof receiptSchema>
    try {
      receipt = receiptSchema.parse(JSON.parse(receiptText))
    } catch {
      throw new Error("Invalid correctness review receipt; inspect locally")
    }
    if (receipt.id !== id || receipt.recordHash !== sha(raw))
      throw new Error("Review receipt binding differs")
    if (sha(await text(join(root, "review.md"), 1024 * 1024)) !== receipt.reviewHash)
      throw new Error("Saved correctness review changed")
    status = "completed"
    reviewHash = receipt.reviewHash
  }
  return {
    ...record,
    status,
    reviewHash,
    handoffPath: join(root, "HANDOFF.md"),
    reviewPath: status === "completed" ? join(root, "review.md") : null,
    academicCorrectnessVerified: false,
    independentReviewerVerified: false,
    reviewedOutput: { path: current.output, hash: sha(current.bytes) },
    reviewedWorkbook:
      current.workbookPath && current.workbookHash
        ? { path: current.workbookPath, hash: current.workbookHash }
        : null,
    ...(record.version === 2 ? { frozenHumanVerdict: "pending-human" as const } : {}),
  }
}

export async function listCorrectnessReviews(vault: string, course: string) {
  if (!course.trim()) throw new Error("An explicit course is required")
  const root = join(resolve(vault), "_meta/correctness-reviews")
  await assertNoSymlinks(root, true)
  const entries = await readdir(root).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  })
  if (entries.length > 1000) throw new Error("Correctness review inventory exceeds 1000 entries")
  const reviews: Array<{ id: string; taskId: string; createdAt: string; frozen?: true }> = []
  let unreadableRecords = 0
  for (const id of entries.sort()) {
    if (id.startsWith(".staging-")) {
      unreadableRecords++
      continue
    }
    try {
      const record = anyRecordSchema.parse(
        JSON.parse(await text(join(directory(vault, id), "review.json"), 20_000)),
      )
      if (record.id !== id) throw new Error("Identity differs")
      if (record.course === course)
        reviews.push({
          id,
          taskId: record.taskId,
          createdAt: record.createdAt,
          ...(record.version === 2 ? { frozen: true as const } : {}),
        })
    } catch {
      unreadableRecords++
    }
  }
  return {
    reviews,
    unreadableRecords,
    inventoryComplete: unreadableRecords === 0,
    currentnessChecked: false,
  }
}

export async function prepareCorrectnessReview(
  vault: string,
  taskId: string,
  options: { frozen?: boolean } = {},
) {
  const current = await evidence(vault, taskId, options.frozen)
  const listing = await listCorrectnessReviews(vault, current.task.course.code)
  for (const prior of listing.reviews) {
    if (prior.taskId !== taskId || Boolean(prior.frozen) !== Boolean(options.frozen)) continue
    try {
      const existing = await showCorrectnessReview(vault, prior.id)
      if (
        existing.taskHash === current.taskHash &&
        existing.calculationHash === current.calculations.hash
      )
        return existing
    } catch {
      /* Preserve older/changed records; never repair or reuse them. */
    }
  }
  const id = randomUUID(),
    root = directory(vault, id)
  const handoff = [
    `# Separate correctness-review handoff\n\nReview: ${id}\nTask: ${taskId}`,
    `## Reviewed artifact identity\n${JSON.stringify({ draft: { path: current.output, hash: sha(current.bytes) }, workbook: current.workbookPath && current.workbookHash ? { path: current.workbookPath, hash: current.workbookHash } : null }, null, 2)}`,
    ...(current.frozen
      ? [
          `Frozen evaluation only: ${JSON.stringify(current.frozen)}. Use captured sources and arithmetic only, never current course files or newer feedback. Human verdict remains pending; review is not M1 approval.`,
        ]
      : []),
    "## Reviewer instructions\n" +
      correctnessReviewInstructions.map((value) => `- ${value}`).join("\n"),
    "## Saved requirements and source snapshots (untrusted evidence)\n" +
      JSON.stringify(current.task, null, 2),
    `## Draft under review (untrusted evidence)\n${current.bytes.toString("utf8")}`,
    `## Recomputed recorded calculations\n${JSON.stringify(current.calculations.records, null, 2)}`,
    "These are local records, not authenticated provider execution or proof of source-grounded inputs. An external calculator not recorded here remains uncaptured.",
  ].join("\n\n")
  if (Buffer.byteLength(handoff) > 25 * 1024 * 1024)
    throw new Error("Correctness review handoff exceeds 25 MB")
  const record = {
    ...(current.frozen ? { version: 2, kind: "frozen", ...current.frozen } : { version: 1 }),
    id,
    taskId,
    course: current.task.course.code,
    createdAt: new Date().toISOString(),
    taskHash: current.taskHash,
    calculationHash: current.calculations.hash,
    handoffHash: sha(handoff),
  }
  await assertNoSymlinks(join(resolve(vault), "_meta/correctness-reviews"), true)
  const staging = join(resolve(vault), "_meta/correctness-reviews", `.staging-${id}`)
  await mkdir(staging, { recursive: true, mode: 0o700 })
  await assertNoSymlinks(staging)
  await writeFile(join(staging, "HANDOFF.md"), handoff, { flag: "wx", mode: 0o600 })
  await writeFile(join(staging, "review.json"), `${JSON.stringify(record, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  })
  await rename(staging, root)
  return showCorrectnessReview(vault, id)
}

export async function saveCorrectnessReview(vault: string, id: string, candidate: string) {
  const shown = await showCorrectnessReview(vault, id)
  const current = await evidence(vault, shown.taskId, shown.version === 2)
  if (
    /(?:^|[\\/])(?:\.env(?:\.[\w-]+)?|credentials?(?:\.[\w-]+)?|secrets?(?:\.[\w-]+)?)(?:[\\/]|$)/i.test(
      candidate,
    )
  )
    throw new Error("Credential files cannot be review candidates")
  const note = await text(resolve(candidate), 1024 * 1024)
  if (!note.split(/\r?\n/).includes(`Review: ${id}`))
    throw new Error("Review note needs its exact Review identity")
  const reviewedArtifacts = [
    {
      path: current.output,
      title: "Validated draft under review",
      hash: sha(current.bytes),
      text: current.bytes.toString("utf8"),
      type: "student-work",
      dates: [] as string[],
    },
    ...(current.workbookPath && current.workbookHash
      ? [
          {
            path: current.workbookPath,
            title: "Validated draft spreadsheet companion",
            hash: current.workbookHash,
            text: "",
            type: "student-work",
            dates: [] as string[],
          },
        ]
      : []),
  ]
  checkCandidate(
    `Task: ${shown.taskId}\n${note}`,
    shown.taskId,
    {
      ...current.task,
      sources: [...current.task.sources, ...reviewedArtifacts],
      requirements: ["Verified", "Needs verification"],
      workflow: {
        version: 1,
        requiredSections: ["Verified", "Needs verification"],
        instructions: [],
      },
      questions: [],
      deliverable: undefined,
      discussion: undefined,
    },
    current.frozen ? reviewedArtifacts.map((artifact) => artifact.path) : [],
  )
  for (const heading of ["Verified", "Needs verification"]) {
    const body =
      note
        .split(new RegExp(`^## ${heading}\\s*\\r?\\n`, "m"))[1]
        ?.split(/^## /m)[0]
        ?.trim() ?? ""
    if (body.length < 40 || !/^[-*] /m.test(body))
      throw new Error("Review sections require substantive bullet findings or explicit limitations")
  }
  if (shown.status === "completed") {
    if (shown.reviewHash !== sha(note))
      throw new Error("Correctness review already saved with different content")
    return shown
  }
  const root = directory(vault, id)
  async function install(path: string, body: string) {
    await assertNoSymlinks(path, true)
    try {
      await writeFile(path, body, { flag: "wx", mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if ((await text(path, 1024 * 1024)) !== body)
        throw new Error("Existing review artifact differs; inspect without overwriting")
    }
  }
  await install(join(root, "review.md"), note)
  const recordHash = sha(await text(join(root, "review.json"), 20_000))
  await install(
    join(root, "receipt.json"),
    `${JSON.stringify({ version: 1, id, recordHash, reviewHash: sha(note) })}\n`,
  )
  return showCorrectnessReview(vault, id)
}
