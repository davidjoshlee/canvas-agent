import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { assertNoSymlinks } from "../../shared/fs-safety.js"
import type { TaskRecord } from "../../shared/types.js"
import { CALCULATION_OPERATIONS, calculateValues } from "./calculation-core.js"

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
const recordSchema = z
  .object({
    version: z.literal(1),
    time: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    operation: z.enum(CALCULATION_OPERATIONS),
    input: z.array(z.number().finite()).min(1).max(1000),
    result: z.number().finite(),
    rate: z.number().finite().optional(),
    source: z
      .object({ path: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .optional(),
  })
  .strict()
type Arithmetic = { input: number[]; result: number }

async function boundedText(path: string, limit: number) {
  await assertNoSymlinks(path)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > limit)
      throw new Error("Numeric review input exceeds regular-file bounds")
    const buffer = Buffer.alloc(limit + 1)
    let length = 0
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    const bytes = buffer.subarray(0, length)
    if (length > limit || bytes.includes(0)) throw new Error("Unsafe numeric review input")
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      throw new Error("Numeric review requires valid UTF-8; inspect locally")
    }
  } finally {
    await handle.close()
  }
}

export async function readTaskCalculationEvidence(vault: string, task: TaskRecord) {
  let text: string
  try {
    text = await boundedText(join(vault, "_meta/tasks", task.id, "calculations.jsonl"), 1024 * 1024)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        results: [] as Arithmetic[],
        records: [] as z.infer<typeof recordSchema>[],
        hash: sha(""),
      }
    throw error
  }
  const results: Arithmetic[] = []
  const records: z.infer<typeof recordSchema>[] = []
  let inputs = 0
  for (const line of text.split("\n").filter(Boolean)) {
    let record: z.infer<typeof recordSchema>
    try {
      record = recordSchema.parse(JSON.parse(line))
    } catch {
      throw new Error("Invalid private calculation record; inspect locally")
    }
    if (results.length >= 10_000)
      throw new Error("Numeric review arithmetic inventory exceeds bounds")
    inputs += record.input.length
    if (
      inputs > 100_000 ||
      calculateValues(record.operation, record.input, record.rate) !== record.result
    )
      throw new Error("Calculation log differs from bounded arithmetic")
    if (
      record.source &&
      !task.sources.some(
        (source) => source.path === record.source?.path && source.hash === record.source.hash,
      )
    )
      throw new Error("Calculation log source differs from the saved task")
    results.push({ input: record.input, result: record.result })
    records.push(record)
  }
  return { results, records, hash: sha(text) }
}
