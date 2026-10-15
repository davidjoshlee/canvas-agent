import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { basename, isAbsolute } from "node:path"
import { z } from "zod"
import { assertNoSymlinks } from "../shared/fs-safety.js"

const label = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/)
  .refine(
    (value) =>
      !/^(?:sk-|gh[pousr]_|Bearer)/i.test(value) &&
      !value.split("/").some((part) => [".", "..", ".env", "_meta"].includes(part)),
    "Unsafe usage label",
  )
const count = z.number().int().nonnegative().max(1_000_000_000_000).nullable().default(null)
const schema = z
  .object({
    version: z.literal(1),
    host: label,
    rows: z
      .array(
        z
          .object({
            id: label,
            at: z.string().datetime({ offset: true }),
            function: label,
            model: label,
            inputTokens: count,
            outputTokens: count,
            cachedInputTokens: count,
            costUsd: z
              .string()
              .regex(/^\d{1,9}(?:\.\d{1,9})?$/)
              .nullable()
              .default(null),
            source: z.enum(["host-reported", "estimated"]),
          })
          .strict()
          .superRefine((row, ctx) => {
            if (
              !Number.isFinite(Date.parse(row.at)) ||
              (row.inputTokens !== null &&
                row.cachedInputTokens !== null &&
                row.cachedInputTokens > row.inputTokens)
            )
              ctx.addIssue({ code: "custom", message: "Invalid usage time/token accounting" })
          }),
      )
      .max(10_000),
  })
  .strict()
  .superRefine((report, ctx) => {
    if (new Set(report.rows.map((row) => row.id)).size !== report.rows.length)
      ctx.addIssue({ code: "custom", message: "Duplicate usage IDs would double-count spend" })
  })
type Row = z.infer<typeof schema>["rows"][number]
const nano = (value: string) => {
  const [integer, fraction = ""] = value.split(".")
  return BigInt(integer ?? "0") * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"))
}
const dollars = (value: bigint) =>
  `${value / 1_000_000_000n}.${String(value % 1_000_000_000n).padStart(9, "0")}`
function summarize(rows: Row[]) {
  const tokenValues = (values: (number | null)[]) => {
    const known = values.reduce<number>((total, value) => total + (value ?? 0), 0)
    if (!Number.isSafeInteger(known)) throw new Error("Usage token sum exceeds safe integer limits")
    return {
      total: values.length && values.every((value) => value !== null) ? known : null,
      knownSubtotal: known,
      missingRows: values.filter((value) => value === null).length,
    }
  }
  const tokens = (field: "inputTokens" | "outputTokens" | "cachedInputTokens") =>
    tokenValues(rows.map((row) => row[field]))
  const known = rows.reduce(
    (total, row) => total + (row.costUsd === null ? 0n : nano(row.costUsd)),
    0n,
  )
  return {
    rows: rows.length,
    inputTokens: tokens("inputTokens"),
    outputTokens: tokens("outputTokens"),
    cachedInputTokens: tokens("cachedInputTokens"),
    uncachedInputTokens: tokenValues(
      rows.map((row) =>
        row.inputTokens === null || row.cachedInputTokens === null
          ? null
          : row.inputTokens - row.cachedInputTokens,
      ),
    ),
    costUsd: {
      total: rows.length && rows.every((row) => row.costUsd !== null) ? dollars(known) : null,
      knownSubtotal: dollars(known),
      missingRows: rows.filter((row) => row.costUsd === null).length,
    },
  }
}
/** Read a student-selected host export only. No model/provider/account access. */
export async function readHostUsage(file: string, options: { weeks?: number; now?: Date } = {}) {
  if (
    !isAbsolute(file) ||
    /^(?:\.env|credentials?|secrets?|passwords?|tokens?)(?:\.|$)/i.test(basename(file))
  )
    throw new Error("Usage export must be an explicit absolute non-credential JSON file")
  const now = options.now ?? new Date()
  if (
    !Number.isFinite(now.valueOf()) ||
    (options.weeks !== undefined &&
      (!Number.isInteger(options.weeks) || options.weeks < 1 || options.weeks > 520))
  )
    throw new Error("Usage report needs valid time and weeks from 1 to 520")
  await assertNoSymlinks(file)
  const descriptor = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes: Buffer
  try {
    const stat = await descriptor.stat()
    if (!stat.isFile() || stat.size > 5_000_000)
      throw new Error("Usage export must be a regular file under 5 MB")
    bytes = await descriptor.readFile()
  } finally {
    await descriptor.close()
  }
  if (bytes.includes(0) || !Buffer.from(bytes.toString()).equals(bytes))
    throw new Error("Usage export must be safe UTF-8")
  let report: z.infer<typeof schema>
  try {
    report = schema.parse(JSON.parse(bytes.toString()))
  } catch {
    throw new Error(
      "Invalid host usage export; inspect its version, labels, unique IDs, timestamps, nullable token counts and decimal-string USD costs",
    )
  }
  const since =
    options.weeks === undefined
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      : new Date(now.valueOf() - options.weeks * 7 * 86_400_000)
  const rows = report.rows.filter(
    (row) => Date.parse(row.at) >= since.valueOf() && Date.parse(row.at) <= now.valueOf(),
  )
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const key = JSON.stringify([row.function, row.model, row.source])
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return {
    host: report.host,
    since: since.toISOString(),
    through: now.toISOString(),
    exportHash: createHash("sha256").update(bytes).digest("hex"),
    groups: [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, values]) => {
        const [functionName, model, source] = JSON.parse(key) as [string, string, Row["source"]]
        return { function: functionName, model, source, ...summarize(values) }
      }),
    totals: summarize(rows),
    excludedRows: report.rows.length - rows.length,
    authoritativeBillingVerified: false,
    limitation:
      "Supplied host export only, not complete account spend or independently verified billing. Unknown costs/tokens remain null; no prices, provider calls or hidden model usage are inferred.",
  }
}

type HostUsageReport = Awaited<ReturnType<typeof readHostUsage>>

/** Human-readable parity with the School report, without inventing missing spend. */
export function renderHostUsage(report: HostUsageReport): string {
  const value = (
    summary: { total: number | string | null; knownSubtotal: number | string; missingRows: number },
    rows: number,
  ) =>
    summary.total !== null
      ? String(summary.total)
      : rows === 0
        ? "unknown (no rows)"
        : `unknown (known ${summary.knownSubtotal}; missing ${summary.missingRows})`
  const row = (
    functionName: string,
    model: string,
    source: string,
    summary: HostUsageReport["totals"],
  ) =>
    [
      functionName,
      model,
      summary.rows,
      value(summary.inputTokens, summary.rows),
      value(summary.outputTokens, summary.rows),
      value(summary.cachedInputTokens, summary.rows),
      value(summary.uncachedInputTokens, summary.rows),
      value(summary.costUsd, summary.rows),
      source,
    ].join("\t")
  return [
    `Host usage: ${report.host}`,
    `Period: ${report.since} through ${report.through}`,
    "function\tmodel\trows\tinput\toutput\tcached\tuncached\tcost_usd\tsource",
    ...report.groups.map((group) => row(group.function, group.model, group.source, group)),
    row("TOTAL", "", "", report.totals),
    `Excluded out-of-window rows: ${report.excludedRows}`,
    report.limitation,
  ].join("\n")
}
