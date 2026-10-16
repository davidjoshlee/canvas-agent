import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { basename, isAbsolute, join } from "node:path"
import { z } from "zod"
import { assertNoSymlinks } from "../shared/fs-safety.js"
import type { TaskRecord } from "../shared/types.js"
import { readSimulationCalculations } from "../simulation/calculations.js"
import { readSimulationTask } from "../simulation/tasks.js"
import { CALCULATION_OPERATIONS, calculateValues } from "./calculation-core.js"
import { checkCandidate } from "./completion.js"
import { readTask } from "./records.js"

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

/** Numeric presence heuristic, not semantic grounding, execution authentication or grading. */
export function numericPresenceReview(
  task: TaskRecord,
  candidate: string,
  arithmetic: Arithmetic[],
) {
  if (arithmetic.length > 10_000)
    throw new Error("Numeric review arithmetic inventory exceeds bounds")
  if (task.sources.length + task.guidance.length > 1000)
    throw new Error("Numeric review exceeds 1000 source references")
  const selected = [...task.sources, ...task.guidance]
  let pathBytes = 0,
    textBytes = 0
  for (const source of selected) {
    pathBytes += Buffer.byteLength(source.path)
    textBytes += Buffer.byteLength(source.text)
    if (pathBytes > 1024 * 1024) throw new Error("Numeric review reference paths exceed 1 MB")
    if (textBytes > 20 * 1024 * 1024) throw new Error("Numeric review source text exceeds 20 MB")
  }
  const paths = new Set(selected.map((source) => source.path))
  let matches = 0
  const ignoredDateLabels: Array<{ date: string; line: number }> = []
  let ignoredDateLabelCount = 0
  const roundedIndexes = new Map<string, Map<number, number[]>>()
  const roundedResults = (value: number, decimals: number, percent: boolean) => {
    const key = `${decimals}:${percent}`
    let index = roundedIndexes.get(key)
    if (!index) {
      index = new Map()
      for (const { result } of arithmetic) {
        const display = percent ? result * 100 : result
        if (!Number.isFinite(display)) continue
        const rounded = Number(display.toFixed(decimals)) / (percent ? 100 : 1)
        const entries = index.get(rounded) ?? []
        if (entries.length < 3 && !entries.includes(result)) entries.push(result)
        index.set(rounded, entries)
      }
      roundedIndexes.set(key, index)
    }
    return index.get(value) ?? []
  }
  const values = (text: string, candidateText = false) => {
    const found: Array<{ value: number; line: number; roundedMatches: number[] }> = []
    const masked = text
      .replace(/^Task:.*$/gm, "")
      .replace(/`([^`\r\n]+)`/g, (whole: string, path: string) =>
        paths.has(path) ? " ".repeat(whole.length) : whole,
      )
    for (const [index, rawLine] of masked.split(/\r?\n/).entries()) {
      // Only explicitly labeled, calendar-valid ISO dates are metadata. Bare
      // subtraction, invalid dates and numeric values elsewhere remain visible.
      const line = candidateText
        ? rawLine.replace(
            /\b(?:week(?: of)?|date|dated|as of|due(?: date)?|available(?: from)?|session)\s*:?\s*(\d{4}-\d{2}-\d{2})(?![\p{L}\p{N}_-]|\.\d)/giu,
            (whole: string, date: string) => {
              const time = Date.parse(`${date}T00:00:00Z`)
              if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date)
                return whole
              if (++matches > 50_000)
                throw new Error("Numeric review exceeds 50000 numeric occurrences")
              ignoredDateLabelCount++
              if (ignoredDateLabels.length < 1000) ignoredDateLabels.push({ date, line: index + 1 })
              return " ".repeat(whole.length)
            },
          )
        : rawLine
      for (const match of line.matchAll(
        /(?<![\p{L}\p{N}_])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?%?(?![\p{L}\p{N}_])/gu,
      )) {
        if (++matches > 50_000) throw new Error("Numeric review exceeds 50000 numeric occurrences")
        const token = match[0]
        const value =
          Number(token.replaceAll(",", "").replace(/%$/, "")) / (token.endsWith("%") ? 100 : 1)
        if (!Number.isFinite(value))
          throw new Error("Numeric review contains unsupported non-finite notation")
        const decimals = token.match(/\.(\d+)/)?.[1]?.length ?? 0
        const approximate =
          /(?:\b(?:approximately|approx\.?|about|roughly|rounded(?: to)?)\s*|[~≈]\s*)$/i.test(
            line.slice(Math.max(0, (match.index ?? 0) - 30), match.index),
          )
        found.push({
          value,
          line: index + 1,
          roundedMatches:
            candidateText &&
            approximate &&
            decimals <= 6 &&
            !/[eE]/.test(token) &&
            (decimals > 0 || token.endsWith("%"))
              ? roundedResults(value, decimals, token.endsWith("%"))
              : [],
        })
      }
    }
    return found
  }
  const sourceText = selected.map((source) => source.text).join("\n")
  const literals = new Set(values(sourceText).map((entry) => entry.value))
  const results = new Set(arithmetic.map((entry) => entry.result))
  const inputs = new Set(arithmetic.flatMap((entry) => entry.input))
  type Finding = {
    value: number
    classification:
      | "recorded-result"
      | "source-literal"
      | "input-only"
      | "rounded-recorded-result"
      | "unmatched"
    roundedMatches?: number[]
    lines: number[]
    occurrences: number
  }
  const findings = new Map<number, Finding>()
  for (const entry of values(candidate, true)) {
    const existing = findings.get(entry.value)
    if (existing) {
      if (existing.classification === "rounded-recorded-result" && !entry.roundedMatches.length) {
        existing.classification = "unmatched"
        delete existing.roundedMatches
      }
      existing.occurrences++
      if (existing.lines.length < 20 && !existing.lines.includes(entry.line))
        existing.lines.push(entry.line)
    } else
      findings.set(entry.value, {
        value: entry.value,
        classification: results.has(entry.value)
          ? "recorded-result"
          : literals.has(entry.value)
            ? "source-literal"
            : inputs.has(entry.value)
              ? "input-only"
              : entry.roundedMatches.length
                ? "rounded-recorded-result"
                : "unmatched",
        ...(entry.roundedMatches.length ? { roundedMatches: entry.roundedMatches } : {}),
        lines: [entry.line],
        occurrences: 1,
      })
  }
  const observedNumbers = [...findings.values()]
  const flagged = observedNumbers.filter(
    (entry) =>
      entry.classification === "input-only" ||
      entry.classification === "unmatched" ||
      entry.classification === "rounded-recorded-result",
  )
  return {
    observedNumbers,
    flagged,
    ignoredDateLabels,
    ignoredDateLabelCount,
    ignoredDateLabelsTruncated: ignoredDateLabelCount > ignoredDateLabels.length,
    needsReview: flagged.length > 0,
    numericCorrectnessVerified: false,
    executionAuthenticated: false,
    limitation:
      "Numeric presence heuristic only. Equal values can refer to unrelated claims; source literals and recomputed records do not prove grounding or complete executed coverage. Explicitly labeled calendar-valid ISO dates are listed separately, not arithmetic-checked. Approximate decimal/percentage matches to rounded recorded results stay flagged for review; verify the claim and displayed precision rather than replacing it with excessive digits. Other dates, labels and unsupported notation may create false positives or omissions. Percentages normalize to fractions. Review every derived claim and its operands, even if no values are flagged. No permission, grade, completed-output verification or approval is established.",
  }
}

async function candidateText(file: string, task: TaskRecord) {
  if (!isAbsolute(file)) throw new Error("Numeric review requires an absolute candidate path")
  if (/^(?:\.env|credentials?|secrets?|passwords?|tokens?)(?:\.|$)/i.test(basename(file)))
    throw new Error("Numeric review must not read a credential file")
  const text = await boundedText(file, 5 * 1024 * 1024)
  checkCandidate(text, task.id, task)
  return text
}

export async function checkTaskNumbers(vault: string, id: string, file: string) {
  const task = await readTask(vault, id)
  const text = await candidateText(file, task)
  const arithmetic = await readTaskCalculationEvidence(vault, task)
  return {
    id,
    scope: "ordinary" as const,
    candidateHash: sha(text),
    arithmeticHash: arithmetic.hash,
    recomputedOperations: arithmetic.results.length,
    ...numericPresenceReview(task, text, arithmetic.results),
  }
}
export async function checkFrozenTaskNumbers(vault: string, id: string, file: string) {
  const record = await readSimulationTask(vault, id)
  const text = await candidateText(file, record.task)
  const arithmetic = await readSimulationCalculations(vault, id)
  const results = arithmetic.records.flatMap((entry) => entry.results)
  return {
    id,
    scope: "frozen" as const,
    candidateHash: sha(text),
    arithmeticHash: arithmetic.recordsHash,
    recomputedOperations: results.length,
    ...numericPresenceReview(record.task, text, results),
  }
}
