import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { assertNoSymlinks, readBoundedFile } from "../shared/fs-safety.js"
import type { SourceRecord } from "../shared/types.js"
import {
  createWorkbook,
  matchesLegacyWorkbook,
  parseWorkbookInput,
} from "../tasks/compatibility/workbook.js"

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

function json(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new Error("Workbook evidence must contain valid UTF-8 JSON; inspect locally")
  }
}
export async function readSimulationWorkbooksForRecord<
  T extends {
    simulationId: string
    snapshotHash: string
    workbookVersion?: 1
    task: { createdAt: string; destination: string; sources: SourceRecord[] }
  },
>(
  vault: string,
  id: string,
  task: T,
  evaluation?: {
    state: string
    completion?: {
      workbook?: { output: string; hash: string; inputHash: string; size: number; sheets: string[] }
      outputHash: string
    }
  },
  providedDirectory?: string,
  providedRecipeHash?: string,
) {
  const directory =
    providedDirectory ?? join(resolve(vault), "_meta/simulations/tasks", id, "workbooks")
  if (!providedDirectory) await assertNoSymlinks(directory, true)
  const recipeHash = providedRecipeHash ?? hash(JSON.stringify(task))
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
    const metadata = await readBoundedFile(join(base, "record.json"), 100_000)
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
    const input = await readBoundedFile(join(base, "input.json"), 5 * 1024 * 1024)
    const bytes = await readBoundedFile(join(base, "workbook.xlsx"), 5 * 1024 * 1024)
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
    const completion = evaluation?.completion
    const book = completion?.workbook
    if (evaluation?.state === "completed-pending-human" && completion && book) {
      if (names.includes(id))
        throw new Error("Explicit workbook collides with automatic companion identity")
      const automatic = recordSchema.parse({
        version: 1,
        rendererVersion: 1,
        automatic: { candidateHash: completion.outputHash },
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
      const metadata = JSON.stringify(completion)
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
