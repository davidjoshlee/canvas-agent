import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { assertNoSymlinks } from "../shared/fs-safety.js"
import { CALCULATION_OPERATIONS, calculateValues } from "../tasks/compatibility/calculation-core.js"
import { readSimulationTask } from "./tasks.js"

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")
const operation = z.enum(CALCULATION_OPERATIONS)
export const SimulationCalculationRecordSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    taskId: z.string().uuid(),
    simulationId: z.string().uuid(),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    recipeHash: z.string().regex(/^[a-f0-9]{64}$/),
    at: z.string().datetime(),
    results: z
      .array(
        z
          .object({
            operation,
            input: z.array(z.number().finite()).min(1).max(1000),
            result: z.number().finite(),
            rate: z.number().finite().optional(),
            source: z
              .object({ path: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
const recordSchema = SimulationCalculationRecordSchema
export const SimulationCalculationEvidenceSchema = z
  .object({
    taskId: z.string().uuid(),
    simulationId: z.string().uuid(),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    recipeHash: z.string().regex(/^[a-f0-9]{64}$/),
    records: z.array(SimulationCalculationRecordSchema).max(100),
    recordsHash: z.string().regex(/^[a-f0-9]{64}$/),
    totalBytes: z.number().int().nonnegative().max(10_000_000),
    attributionVerified: z.literal(false),
  })
  .strict()

async function scope(vault: string, id: string) {
  const task = await readSimulationTask(vault, id)
  const directory = join(resolve(vault), "_meta/simulations/tasks", id, "calculations")
  await assertNoSymlinks(directory, true)
  return { task, directory, recipeHash: hash(JSON.stringify(task)) }
}

/** Recompute and validate private arithmetic evidence without reading current course files. */
export async function readSimulationCalculations(vault: string, id: string) {
  const { task, directory, recipeHash } = await scope(vault, id)
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return [] as string[]
  })
  if (names.length > 100 || names.some((name) => !/^[a-f0-9-]{36}\.json$/.test(name)))
    throw new Error("Evaluation calculation inventory is invalid or exceeds 100 records")
  const records: z.infer<typeof recordSchema>[] = [],
    digests: string[] = []
  let bytesRead = 0
  for (const name of names.sort()) {
    const path = join(directory, name)
    await assertNoSymlinks(path)
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes: Buffer
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 500_000 || bytesRead + stat.size > 10_000_000)
        throw new Error("Evaluation calculation records exceed safe file/total bounds")
      bytes = await file.readFile()
      if (bytes.length > 500_000 || bytesRead + bytes.length > 10_000_000)
        throw new Error("Evaluation calculation records exceed safe file/total bounds")
    } finally {
      await file.close()
    }
    bytesRead += bytes.length
    let record: z.infer<typeof recordSchema>
    try {
      record = recordSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      )
    } catch {
      throw new Error("Invalid evaluation calculation record; inspect locally")
    }
    if (
      record.id !== name.slice(0, -5) ||
      record.taskId !== id ||
      record.simulationId !== task.simulationId ||
      record.snapshotHash !== task.snapshotHash ||
      record.recipeHash !== recipeHash
    )
      throw new Error("Evaluation calculation scope or recipe binding changed")
    let inputs = 0
    for (const result of record.results) {
      inputs += result.input.length
      if (
        inputs > 10_000 ||
        calculateValues(result.operation, result.input, result.rate) !== result.result
      )
        throw new Error("Evaluation calculation result differs from executed arithmetic")
      if (
        result.source &&
        !task.task.sources.some(
          (source) => source.path === result.source?.path && source.hash === result.source.hash,
        )
      )
        throw new Error("Evaluation calculation source differs from selected frozen evidence")
    }
    records.push(record)
    digests.push(`${name}:${hash(bytes)}`)
  }
  return {
    taskId: id,
    simulationId: task.simulationId,
    snapshotHash: task.snapshotHash,
    recipeHash,
    records,
    recordsHash: hash(JSON.stringify(digests)),
    totalBytes: bytesRead,
    attributionVerified: false,
  }
}
