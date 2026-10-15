import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, open, readdir, rmdir, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { z } from "zod"
import { assertNoSymlinks } from "../shared/fs-safety.js"
import { createWorkbook, matchesLegacyWorkbook, parseWorkbookInput } from "../tasks/tools.js"
import { inspectSimulationTask, readSimulationTask } from "./tasks.js"

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const SimulationWorkbookRecordSchema = z
  .object({
    version: z.literal(1),
    rendererVersion: z.literal(1).optional(),
    automatic: z.object({ candidateHash: digest }).strict().optional(),
    id: z.string().uuid(),
    taskId: z.string().uuid(),
    simulationId: z.string().uuid(),
    snapshotHash: digest,
    recipeHash: digest,
    at: z.string().datetime(),
    output: z.string(),
    hash: digest,
    inputHash: digest,
    size: z
      .number()
      .int()
      .nonnegative()
      .max(5 * 1024 * 1024),
    sheets: z.array(z.string().min(1).max(31)).min(1).max(20),
    source: z.object({ path: z.string(), hash: digest }).strict().optional(),
  })
  .strict()
const recordSchema = SimulationWorkbookRecordSchema
export const SimulationWorkbookEvidenceSchema = z
  .object({
    taskId: z.string().uuid(),
    simulationId: z.string().uuid(),
    snapshotHash: digest,
    recipeHash: digest,
    records: z.array(SimulationWorkbookRecordSchema).max(20),
    recordsHash: digest,
    totalBytes: z.number().int().nonnegative().max(50_000_000),
    attributionVerified: z.literal(false),
  })
  .strict()

async function bounded(path: string, limit: number): Promise<Buffer> {
  await assertNoSymlinks(path)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > limit)
      throw new Error("Workbook evidence exceeds regular-file bounds")
    const buffer = Buffer.alloc(limit + 1)
    let size = 0
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    if (size > limit) throw new Error("Workbook evidence exceeds byte bounds")
    return Buffer.from(buffer.subarray(0, size))
  } finally {
    await handle.close()
  }
}
function json(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new Error("Workbook evidence must contain valid UTF-8 JSON; inspect locally")
  }
}
async function scope(vault: string, id: string) {
  const task = await readSimulationTask(vault, id)
  const directory = join(resolve(vault), "_meta/simulations/tasks", id, "workbooks")
  await assertNoSymlinks(directory, true)
  return { task, directory, recipeHash: hash(JSON.stringify(task)) }
}

/** Verify stored values-only companions against their input, bytes and frozen recipe. */
export async function readSimulationWorkbooks(vault: string, id: string) {
  const { task, directory, recipeHash } = await scope(vault, id)
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return [] as string[]
  })
  if (names.length > 20 || names.some((name) => !z.string().uuid().safeParse(name).success))
    throw new Error("Evaluation workbook inventory is invalid or exceeds 20 companions")
  const records: z.infer<typeof recordSchema>[] = [],
    digests: string[] = []
  let totalBytes = 0
  for (const name of names.sort()) {
    const base = join(directory, name)
    await assertNoSymlinks(base)
    if (
      JSON.stringify((await readdir(base)).sort()) !==
      JSON.stringify(["input.json", "record.json", "workbook.xlsx"])
    )
      throw new Error("Evaluation workbook bundle is incomplete or contains unknown entries")
    const metadata = await bounded(join(base, "record.json"), 100_000)
    let record: z.infer<typeof recordSchema>
    try {
      record = recordSchema.parse(json(metadata))
    } catch {
      throw new Error("Invalid evaluation workbook metadata; inspect locally")
    }
    const output = `_meta/simulations/tasks/${id}/workbooks/${name}/workbook.xlsx`
    if (
      record.id !== name ||
      record.taskId !== id ||
      record.simulationId !== task.simulationId ||
      record.recipeHash !== recipeHash ||
      record.snapshotHash !== task.snapshotHash ||
      record.output !== output ||
      record.automatic
    )
      throw new Error("Evaluation workbook scope or recipe binding changed")
    const input = await bounded(join(base, "input.json"), 5 * 1024 * 1024)
    const bytes = await bounded(join(base, "workbook.xlsx"), 5 * 1024 * 1024)
    totalBytes += input.length + bytes.length + metadata.length
    if (totalBytes > 50_000_000) throw new Error("Evaluation workbook evidence exceeds 50 MB")
    const parsed = parseWorkbookInput(json(input))
    if (
      hash(input) !== record.inputHash ||
      hash(bytes) !== record.hash ||
      bytes.length !== record.size ||
      JSON.stringify(parsed.sheets.map((sheet) => sheet.name)) !== JSON.stringify(record.sheets) ||
      !(record.rendererVersion === 1
        ? bytes.equals(await createWorkbook(parsed))
        : await matchesLegacyWorkbook(parsed, bytes))
    )
      throw new Error("Evaluation workbook input or values-only bytes changed")
    if (
      record.source &&
      !task.task.sources.some(
        (source) => source.path === record.source?.path && source.hash === record.source.hash,
      )
    )
      throw new Error("Workbook source differs from selected frozen evidence")
    records.push(record)
    digests.push(`${name}:${hash(metadata)}:${hash(input)}:${hash(bytes)}`)
  }
  if (task.workbookVersion === 1) {
    const evaluation = await inspectSimulationTask(vault, id)
    if (evaluation.state === "completed-pending-human" && evaluation.completion.workbook) {
      const book = evaluation.completion.workbook
      if (names.includes(id))
        throw new Error("Explicit workbook collides with automatic companion identity")
      const automatic = recordSchema.parse({
        version: 1,
        rendererVersion: 1,
        automatic: { candidateHash: evaluation.completion.outputHash },
        id,
        taskId: id,
        simulationId: task.simulationId,
        snapshotHash: task.snapshotHash,
        recipeHash,
        // Task creation is a recipe timestamp, not claimed workbook execution time.
        at: task.task.createdAt,
        output: book.output,
        hash: book.hash,
        inputHash: book.inputHash,
        size: book.size,
        sheets: book.sheets,
      })
      records.push(automatic)
      const metadata = JSON.stringify(evaluation.completion)
      totalBytes += book.size + Buffer.byteLength(metadata)
      digests.push(`automatic:${hash(metadata)}:${book.inputHash}:${book.hash}`)
    }
  }
  if (records.length > 20 || totalBytes > 50_000_000)
    throw new Error("Evaluation workbook inventory exceeds companion count or byte bounds")
  return {
    taskId: id,
    simulationId: task.simulationId,
    snapshotHash: task.snapshotHash,
    recipeHash,
    records,
    recordsHash: hash(JSON.stringify(digests)),
    totalBytes,
    attributionVerified: false,
  }
}

/** Explicit JSON values to a private companion, never an automatic student submission. */
export async function createSimulationWorkbook(
  vault: string,
  id: string,
  file: string,
  sourcePath?: string,
) {
  if (
    !isAbsolute(file) ||
    /(?:^|\/)(?:\.env|credentials?|secrets?|passwords?|tokens?)(?:\.|$)/i.test(file)
  )
    throw new Error("Workbook input must be an absolute non-credential JSON file")
  const { task, directory, recipeHash } = await scope(vault, id)
  const source =
    sourcePath === undefined
      ? undefined
      : task.task.sources.find((item) => item.path === sourcePath)
  if (sourcePath !== undefined && !source)
    throw new Error("Workbook source is not selected frozen evidence")
  const parsed = parseWorkbookInput(json(await bounded(file, 5 * 1024 * 1024)))
  const input = JSON.stringify(parsed),
    bytes = await createWorkbook(parsed)
  const record = recordSchema.parse({
    version: 1,
    rendererVersion: 1,
    id: randomUUID(),
    taskId: id,
    simulationId: task.simulationId,
    snapshotHash: task.snapshotHash,
    recipeHash,
    at: new Date().toISOString(),
    output: "pending",
    hash: hash(bytes),
    inputHash: hash(input),
    size: bytes.length,
    sheets: parsed.sheets.map((sheet) => sheet.name),
    ...(source ? { source: { path: source.path, hash: source.hash } } : {}),
  })
  record.output = `_meta/simulations/tasks/${id}/workbooks/${record.id}/workbook.xlsx`
  const metadata = JSON.stringify(record),
    lock = `${directory}.lock`
  await assertNoSymlinks(lock, true)
  await mkdir(lock, { mode: 0o700 })
  try {
    const current = await readSimulationWorkbooks(vault, id)
    if (current.recipeHash !== recipeHash)
      throw new Error("Evaluation changed during workbook creation")
    const evaluation =
      task.workbookVersion === 1 ? await inspectSimulationTask(vault, id) : undefined
    const reserveAutomatic = evaluation?.state === "pending-host" ? 1 : 0
    if (
      current.records.length + reserveAutomatic >= 20 ||
      current.totalBytes + bytes.length + Buffer.byteLength(input + metadata) > 50_000_000
    )
      throw new Error("Evaluation workbook count or byte limit reached")
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await assertNoSymlinks(directory)
    const destination = join(directory, record.id)
    await mkdir(destination, { mode: 0o700 })
    await assertNoSymlinks(destination)
    await writeFile(join(destination, "input.json"), input, { flag: "wx", mode: 0o600 })
    await writeFile(join(destination, "workbook.xlsx"), bytes, { flag: "wx", mode: 0o600 })
    await writeFile(join(destination, "record.json"), metadata, { flag: "wx", mode: 0o600 })
  } finally {
    await rmdir(lock)
  }
  return {
    ...record,
    attributionVerified: false,
    note: "Private values-only evaluation workbook; no formulas/macros execute. Source context does not establish input grounding or academic correctness. ZIP timestamps are fixed for reproducibility, not execution-time evidence.",
  }
}
