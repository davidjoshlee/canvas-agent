import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile } from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"
import JSZip from "jszip"
import { verifyTaskLearningHistory } from "../feedback/history.js"
import { assertNoSymlinks } from "../shared/fs-safety.js"
import { readJsonInput } from "../shared/json-input.js"
import type { SourceRecord, TaskRecord, ToolkitConfig } from "../shared/types.js"
import { verifyCompletedWorkbook } from "./completion.js"
import { readTask } from "./store.js"

const MAX_EVIDENCE = 5 * 1024 * 1024
const MAX_ORIGINAL = 50 * 1024 * 1024
const MAX_LOG = 1024 * 1024
const MAX_WORKBOOK = 5 * 1024 * 1024
const MAX_CELLS = 50_000
const MAX_SHEETS = 20
export const CALCULATION_OPERATIONS = [
  "sum",
  "mean",
  "median",
  "min",
  "max",
  "stddev",
  "npv",
  "add",
  "subtract",
  "multiply",
  "divide",
  "power",
] as const
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export interface SnapshotAudit {
  current: boolean
  changed: string[]
  missing: string[]
}

function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`)
}

function snapshotPath(vault: string, task: TaskRecord, path: string): string {
  if (path === "AGENTS.md") return resolve(vault, path)
  const target = resolve(vault, path)
  const courseRoot = resolve(vault, task.course.root)
  if (!within(courseRoot, target)) throw new Error("Task evidence path is outside its course")
  return target
}

async function fileHash(path: string, maxBytes = MAX_EVIDENCE): Promise<string | undefined> {
  await assertNoSymlinks(path)
  const info = await lstat(path)
  if (!info.isFile() || info.size > maxBytes)
    throw new Error("Task evidence is not a bounded regular file")
  return hash(await readFile(path))
}

/** Recheck every captured source, guidance file, and extraction original before using a task. */
export async function auditTaskSnapshots(vault: string, task: TaskRecord): Promise<SnapshotAudit> {
  await verifyTaskLearningHistory(vault, task)
  const changed: string[] = []
  const missing: string[] = []
  const checks: Array<{ path: string; expected: string; maxBytes?: number }> = [
    ...task.sources.map((source) => ({ path: source.path, expected: source.hash })),
    ...task.guidance.map((source) => ({ path: source.path, expected: source.hash })),
    ...task.sources.flatMap((source) =>
      source.originalPath && source.originalHash
        ? [{ path: source.originalPath, expected: source.originalHash, maxBytes: MAX_ORIGINAL }]
        : [],
    ),
  ]
  for (const check of checks) {
    try {
      const actual = await fileHash(snapshotPath(vault, task, check.path), check.maxBytes)
      if (actual !== check.expected) changed.push(check.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") missing.push(check.path)
      else throw error
    }
  }
  return {
    current: changed.length === 0 && missing.length === 0,
    changed: [...new Set(changed)].sort(),
    missing: [...new Set(missing)].sort(),
  }
}

function evidenceSummary(sources: SourceRecord[]) {
  return sources.map((source) => ({
    path: source.path,
    title: source.title,
    type: source.type,
    hash: source.hash,
    dates: source.dates,
    ...(source.dueAt ? { dueAt: source.dueAt } : {}),
    ...(source.assignmentDates ? { assignmentDates: source.assignmentDates } : {}),
    ...(source.relatedPaths ? { relatedPaths: source.relatedPaths } : {}),
    ...(source.originalPath
      ? { originalPath: source.originalPath, originalHash: source.originalHash }
      : {}),
  }))
}

export async function inspectTask(vault: string, id: string) {
  const task = await readTask(vault, id)
  const snapshots = await auditTaskSnapshots(vault, task)
  return {
    id: task.id,
    kind: task.kind,
    parserVersion: task.parserVersion,
    status: task.status,
    createdAt: task.createdAt,
    course: task.course,
    ...(task.week ? { week: task.week } : {}),
    ...(task.period ? { period: task.period } : {}),
    ...(task.assignment ? { assignment: task.assignment } : {}),
    ...(task.discussion ? { discussion: task.discussion } : {}),
    destination: task.destination,
    requirements: task.requirements,
    sources: evidenceSummary(task.sources),
    guidance: evidenceSummary(task.guidance),
    learningHistory: task.learningHistory
      ? {
          hash: task.learningHistory.hash,
          records: task.learningHistory.records.length,
          legacyPlaybooks: task.learningHistory.legacyPlaybooks?.length ?? 0,
          archiveBindingsVerified: true,
          currentGradesVerified: false,
          instructorAuthorshipVerified: false,
        }
      : null,
    excluded: task.excluded,
    snapshots,
    output: task.output ? { path: task.output, hash: task.outputHash } : null,
    ...(task.workbookVersion
      ? { workbookVersion: task.workbookVersion, workbook: task.workbook ?? null }
      : {}),
    notices: task.notices,
  }
}

async function readOutput(vault: string, task: TaskRecord): Promise<string | undefined> {
  if (!task.output || !task.outputHash) return undefined
  const target = resolve(vault, task.output)
  const destination = resolve(vault, task.destination)
  if (!within(destination, target)) throw new Error("Task output is outside its destination")
  await assertNoSymlinks(target)
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_EVIDENCE)
      throw new Error("Task output is not a bounded regular file")
    const bytes = await handle.readFile()
    if (bytes.byteLength > MAX_EVIDENCE)
      throw new Error("Task output exceeds the 5 MB review limit")
    if (hash(bytes) !== task.outputHash)
      throw new Error("Task output hash does not match its completion record")
    await verifyCompletedWorkbook(vault, task, bytes)
    return bytes.toString("utf8")
  } finally {
    await handle.close()
  }
}

function automaticWorkbookEvidence(task: TaskRecord) {
  const scope = "automatic-completion-companion-only" as const
  if (task.kind !== "assignment" || task.assignment?.mode !== "draft")
    return { scope, state: "not-applicable" as const, workbook: null }
  if (task.status !== "completed") return { scope, state: "pending" as const, workbook: null }
  if (!task.workbookVersion) return { scope, state: "uncaptured-legacy" as const, workbook: null }
  return {
    scope,
    state: task.workbook ? ("verified" as const) : ("verified-empty" as const),
    workbook: task.workbook ?? null,
  }
}

function lineDiff(before: string | undefined, after: string | undefined) {
  if (before === undefined || after === undefined)
    return { available: false, lines: [] as string[] }
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let aEnd = a.length
  let bEnd = b.length
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--
    bEnd--
  }
  const lines = [
    `@@ lines ${start + 1}-${aEnd} -> ${start + 1}-${bEnd} @@`,
    ...a
      .slice(start, aEnd)
      .slice(0, 100)
      .map((line) => `-${line}`),
    ...b
      .slice(start, bEnd)
      .slice(0, 100)
      .map((line) => `+${line}`),
  ]
  if (aEnd - start > 100 || bEnd - start > 100) lines.push("... diff excerpt truncated ...")
  return { available: true, added: bEnd - start, removed: aEnd - start, lines }
}

function evidenceChanges(before: SourceRecord[], after: SourceRecord[]) {
  const left = new Map(before.map((source) => [source.path, source.hash]))
  const right = new Map(after.map((source) => [source.path, source.hash]))
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort()
  return paths.flatMap((path) => {
    const a = left.get(path)
    const b = right.get(path)
    return a === b
      ? []
      : [
          {
            path,
            before: a ?? null,
            after: b ?? null,
            change: a === undefined ? "added" : b === undefined ? "removed" : "changed",
          },
        ]
  })
}

export async function compareTasks(vault: string, leftId: string, rightId: string) {
  const [before, after] = await Promise.all([readTask(vault, leftId), readTask(vault, rightId)])
  const [beforeAudit, afterAudit] = await Promise.all([
    auditTaskSnapshots(vault, before),
    auditTaskSnapshots(vault, after),
  ])
  const [beforeOutput, afterOutput] = await Promise.all([
    readOutput(vault, before),
    readOutput(vault, after),
  ])
  const beforeWorkbook = automaticWorkbookEvidence(before)
  const afterWorkbook = automaticWorkbookEvidence(after)
  const known = (state: string) => state === "verified" || state === "verified-empty"
  const workbookChange =
    !known(beforeWorkbook.state) || !known(afterWorkbook.state)
      ? "unknown"
      : !beforeWorkbook.workbook && !afterWorkbook.workbook
        ? "none-extracted"
        : beforeWorkbook.workbook?.hash === afterWorkbook.workbook?.hash
          ? "same-bytes"
          : !beforeWorkbook.workbook
            ? "added"
            : !afterWorkbook.workbook
              ? "removed"
              : "changed-bytes"
  return {
    before: { id: before.id, status: before.status, snapshots: beforeAudit },
    after: { id: after.id, status: after.status, snapshots: afterAudit },
    sourceChanges: evidenceChanges(before.sources, after.sources),
    guidanceChanges: evidenceChanges(before.guidance, after.guidance),
    learningHistory: {
      before: before.learningHistory?.hash ?? null,
      after: after.learningHistory?.hash ?? null,
      change:
        before.learningHistory?.hash === after.learningHistory?.hash
          ? "same-captured-context"
          : "changed-captured-context",
    },
    outputDiff: lineDiff(beforeOutput, afterOutput),
    automaticWorkbooks: { before: beforeWorkbook, after: afterWorkbook, change: workbookChange },
  }
}

/** Pure bounded arithmetic shared by ordinary and fixed-evidence tasks. */
export function calculateValues(operation: string, values: number[], rate?: number): number {
  if (!values.length || values.length > 1000 || values.some((value) => !Number.isFinite(value)))
    throw new Error("Values must contain 1 to 1,000 finite numbers")
  if (operation !== "npv" && rate !== undefined) throw new Error("Rate is supported only for NPV")
  let result: number
  switch (operation) {
    case "sum":
      result = values.reduce((total, value) => total + value, 0)
      break
    case "mean":
      result = values.reduce((total, value) => total + value, 0) / values.length
      break
    case "median": {
      const sorted = [...values].sort((a, b) => a - b)
      const middle = Math.floor(sorted.length / 2)
      const middleValue = sorted[middle]
      const lowerMiddleValue = sorted[middle - 1]
      if (middleValue === undefined) throw new Error("Median requires at least one value")
      result =
        sorted.length % 2 ? middleValue : ((lowerMiddleValue ?? middleValue) + middleValue) / 2
      break
    }
    case "min":
      result = Math.min(...values)
      break
    case "max":
      result = Math.max(...values)
      break
    case "stddev": {
      const mean = values.reduce((total, value) => total + value, 0) / values.length
      result = Math.sqrt(
        values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length,
      )
      break
    }
    case "npv": {
      if (rate === undefined || !Number.isFinite(rate) || rate <= -1 || rate > 100)
        throw new Error("NPV rate must be finite and greater than -1 and at most 100")
      result = values.reduce(
        (total, cashflow, period) => total + cashflow / (1 + rate) ** period,
        0,
      )
      break
    }
    case "add":
    case "subtract":
    case "multiply":
    case "divide":
    case "power": {
      if (values.length !== 2) throw new Error(`${operation} requires exactly two values`)
      const [a, b] = values as [number, number]
      if (operation === "add") result = a + b
      else if (operation === "subtract") result = a - b
      else if (operation === "multiply") result = a * b
      else if (operation === "divide") {
        if (b === 0) throw new Error("Division by zero is not allowed")
        result = a / b
      } else result = a ** b
      break
    }
    default:
      throw new Error(
        `Unsupported operation. Supported operations: ${CALCULATION_OPERATIONS.join(", ")}`,
      )
  }
  if (!Number.isFinite(result)) throw new Error("Operation result is not finite")
  return result
}

async function taskVault(config: ToolkitConfig, taskId: string) {
  const vault = resolve(config.vault.path)
  const task = await readTask(vault, taskId)
  const snapshots = await auditTaskSnapshots(vault, task)
  if (!snapshots.current)
    throw new Error("Task evidence is stale; create a new task before calculating or evaluating")
  return { vault, task }
}

async function appendPrivateRecord(
  vault: string,
  taskId: string,
  name: "calculations.jsonl" | "artifacts.jsonl",
  record: Record<string, unknown>,
): Promise<void> {
  const directory = join(vault, "_meta", "tasks", taskId)
  await assertNoSymlinks(directory)
  const path = join(directory, name)
  await assertNoSymlinks(path, true)
  const current = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  })
  if (current && (!current.isFile() || current.isSymbolicLink() || current.size > MAX_LOG))
    throw new Error("Private tool record is unsafe or exceeds 1 MB")
  if (current) {
    const text = await readFile(path, "utf8")
    for (const line of text.split("\n").filter(Boolean)) {
      const entry: unknown = JSON.parse(line)
      if (!isRecord(entry) || entry.version !== 1) throw new Error("Private tool record is invalid")
      const keys = Object.keys(entry).sort().join(",")
      if (name === "calculations.jsonl") {
        if (typeof entry.time !== "string" || !Number.isFinite(Date.parse(entry.time)))
          throw new Error("Calculation log contains an invalid time")
        const expected = [
          "input",
          "operation",
          "result",
          "time",
          "version",
          ...(entry.rate === undefined ? [] : ["rate"]),
          ...(entry.source === undefined ? [] : ["source"]),
        ]
          .sort()
          .join(",")
        if (
          keys !== expected ||
          !CALCULATION_OPERATIONS.some((operation) => operation === entry.operation) ||
          !Array.isArray(entry.input) ||
          !entry.input.length ||
          !entry.input.every((value) => typeof value === "number" && Number.isFinite(value)) ||
          typeof entry.result !== "number" ||
          !Number.isFinite(entry.result) ||
          (entry.rate !== undefined &&
            (typeof entry.rate !== "number" || !Number.isFinite(entry.rate)))
        )
          throw new Error("Calculation log contains a malformed record")
        if (
          entry.source !== undefined &&
          (!isRecord(entry.source) ||
            Object.keys(entry.source).sort().join(",") !== "hash,path" ||
            typeof entry.source.path !== "string" ||
            typeof entry.source.hash !== "string" ||
            !/^[a-f0-9]{64}$/.test(entry.source.hash))
        )
          throw new Error("Calculation log contains an invalid source reference")
      } else {
        if (typeof entry.createdAt !== "string" || !Number.isFinite(Date.parse(entry.createdAt)))
          throw new Error("Artifact log contains an invalid creation time")
        const expectedCommon = ["createdAt", "hash", "kind", "path", "version"]
        const expected =
          entry.sheets === undefined && entry.sections === undefined
            ? expectedCommon
            : [
                ...expectedCommon,
                ...(entry.sheets === undefined ? [] : ["sheets"]),
                ...(entry.sections === undefined ? [] : ["sections"]),
              ]
        if (
          keys !== expected.sort().join(",") ||
          !["workbook", "review-bundle"].includes(String(entry.kind)) ||
          typeof entry.path !== "string" ||
          isAbsolute(entry.path) ||
          entry.path.split(/[\\/]/).includes("..") ||
          typeof entry.hash !== "string" ||
          !/^[a-f0-9]{64}$/.test(entry.hash)
        )
          throw new Error("Artifact log contains a malformed record")
        if (
          entry.sheets !== undefined &&
          (!Array.isArray(entry.sheets) ||
            !entry.sheets.every((value) => typeof value === "string"))
        )
          throw new Error("Artifact log contains invalid sheet names")
        if (
          entry.sections !== undefined &&
          (!Array.isArray(entry.sections) ||
            !entry.sections.every(
              (value) =>
                isRecord(value) &&
                Object.keys(value).sort().join(",") === "present,section" &&
                typeof value.section === "string" &&
                typeof value.present === "boolean",
            ))
        )
          throw new Error("Artifact log contains invalid structural findings")
      }
    }
  }
  const line = `${JSON.stringify({ version: 1, ...record })}\n`
  if ((current?.size ?? 0) + Buffer.byteLength(line) > MAX_LOG)
    throw new Error("Private tool record would exceed 1 MB")
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await file.writeFile(line, "utf8")
  } finally {
    await file.close()
  }
}

export async function calculateTask(
  config: ToolkitConfig,
  args: { taskId: string; operation: string; values: string; source?: string; rate?: number },
) {
  const { vault, task } = await taskVault(config, args.taskId)
  const values = args.values.split(",").map((item) => {
    if (!item.trim()) throw new Error("Values must be a comma-separated list of finite numbers")
    const number = Number(item.trim())
    if (!Number.isFinite(number))
      throw new Error("Values must be a comma-separated list of finite numbers")
    return number
  })
  if (args.operation !== "npv" && args.rate !== undefined)
    throw new Error("Rate is supported only for NPV")
  const result = calculateValues(args.operation, values, args.rate)
  let selected: SourceRecord | undefined
  if (args.source) {
    selected = task.sources.find((source) => source.path === args.source)
    if (!selected) throw new Error("Calculation source is not in this approved task")
  }
  const record = {
    time: new Date().toISOString(),
    operation: args.operation,
    input: values,
    result,
    ...(args.operation === "npv" ? { rate: args.rate } : {}),
    ...(selected ? { source: { path: selected.path, hash: selected.hash } } : {}),
  }
  await appendPrivateRecord(vault, task.id, "calculations.jsonl", record)
  return {
    ...record,
    note: selected
      ? "Source is recorded as context only; it does not prove numeric correctness or source grounding."
      : "Calculation is not evidence of source grounding.",
  }
}

export interface CalculationBatchItem {
  operation: string
  values: number[]
  rate?: number
  source?: string
}

/** Parse a small, strict JSON batch of safe numeric operations. */
export function parseCalculationBatch(raw: unknown): CalculationBatchItem[] {
  if (
    !isRecord(raw) ||
    Object.keys(raw).some((key) => key !== "operations") ||
    !Array.isArray(raw.operations) ||
    raw.operations.length < 1 ||
    raw.operations.length > 100
  )
    throw new Error("Calculation JSON must contain 1 to 100 operations")
  return raw.operations.map((entry) => {
    if (
      !isRecord(entry) ||
      Object.keys(entry).some((key) => !["operation", "values", "rate", "source"].includes(key)) ||
      typeof entry.operation !== "string" ||
      !Array.isArray(entry.values) ||
      entry.values.length < 1 ||
      entry.values.length > 1000 ||
      !entry.values.every((value) => typeof value === "number" && Number.isFinite(value))
    )
      throw new Error(
        "Each calculation must contain a supported operation and 1 to 1,000 finite numeric values",
      )
    if (
      entry.rate !== undefined &&
      (typeof entry.rate !== "number" || !Number.isFinite(entry.rate))
    )
      throw new Error("Calculation rate must be finite")
    if (entry.source !== undefined && typeof entry.source !== "string")
      throw new Error("Calculation source must be a path")
    return {
      operation: entry.operation,
      values: entry.values as number[],
      ...(entry.rate === undefined ? {} : { rate: entry.rate as number }),
      ...(entry.source === undefined ? {} : { source: entry.source as string }),
    }
  })
}

export async function calculateBatchTask(
  config: ToolkitConfig,
  taskId: string,
  items: CalculationBatchItem[],
) {
  if (items.length < 1 || items.length > 100)
    throw new Error("Calculation batch must contain 1 to 100 operations")
  const supported = new Set([
    "sum",
    "mean",
    "median",
    "min",
    "max",
    "stddev",
    "npv",
    "add",
    "subtract",
    "multiply",
    "divide",
    "power",
  ])
  let valueCount = 0
  for (const item of items) {
    if (
      !supported.has(item.operation) ||
      !Array.isArray(item.values) ||
      !item.values.length ||
      item.values.length > 1000 ||
      !item.values.every(Number.isFinite)
    )
      throw new Error("Calculation batch contains an unsupported operation or invalid values")
    valueCount += item.values.length
    if (valueCount > 10_000) throw new Error("Calculation batch exceeds 10,000 numeric inputs")
    if (
      item.operation === "npv" &&
      (item.rate === undefined || !Number.isFinite(item.rate) || item.rate <= -1 || item.rate > 100)
    )
      throw new Error("NPV rate must be finite and greater than -1 and at most 100")
    if (item.operation !== "npv" && item.rate !== undefined)
      throw new Error("Rate is supported only for NPV")
    if (
      ["add", "subtract", "multiply", "divide", "power"].includes(item.operation) &&
      item.values.length !== 2
    )
      throw new Error(`${item.operation} requires exactly two values`)
    calculateValues(item.operation, item.values, item.rate)
  }
  const { task } = await taskVault(config, taskId)
  for (const item of items) {
    if (item.source && !task.sources.some((source) => source.path === item.source))
      throw new Error("Calculation source is not in this approved task")
  }
  const results = []
  for (const item of items) {
    const response = await calculateTask(config, {
      taskId,
      operation: item.operation,
      values: item.values.join(","),
      ...(item.rate === undefined ? {} : { rate: item.rate }),
      ...(item.source === undefined ? {} : { source: item.source }),
    })
    results.push(response)
  }
  return results
}

function xml(value: string): string {
  if (
    [...value].some((char) => {
      const code = char.codePointAt(0) ?? 0
      return (
        (code < 0x20 && ![0x09, 0x0a, 0x0d].includes(code)) ||
        (code >= 0xd800 && code <= 0xdfff) ||
        code === 0xfffe ||
        code === 0xffff
      )
    })
  )
    throw new Error("Workbook text contains characters that XML cannot represent")
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function columnName(index: number): string {
  let number = index + 1
  let value = ""
  while (number) {
    const remainder = (number - 1) % 26
    value = String.fromCharCode(65 + remainder) + value
    number = Math.floor((number - 1) / 26)
  }
  return value
}

export interface WorkbookInput {
  sheets: Array<{ name: string; rows: Array<Array<string | number | boolean | null>> }>
}

export function parseWorkbookInput(raw: unknown): WorkbookInput {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => key !== "sheets")
  )
    throw new Error("Workbook JSON must contain only a sheets array")
  const sheets = (raw as { sheets?: unknown }).sheets
  if (!Array.isArray(sheets) || sheets.length < 1 || sheets.length > MAX_SHEETS)
    throw new Error("Workbook must contain 1 to 20 sheets")
  const names = new Set<string>()
  let cellCount = 0
  let textBytes = 0
  let rowCount = 0
  const normalized = sheets.map((sheet) => {
    if (
      !sheet ||
      typeof sheet !== "object" ||
      Array.isArray(sheet) ||
      Object.keys(sheet).some((key) => !["name", "rows"].includes(key))
    )
      throw new Error("Each sheet must contain only a name and rows")
    const { name, rows } = sheet as { name?: unknown; rows?: unknown }
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 31 ||
      /[[\]:*?/\\]/.test(name) ||
      /^'|'$/.test(name)
    )
      throw new Error("Sheet names must be valid Excel names up to 31 characters")
    if (names.has(name.toLowerCase())) throw new Error("Sheet names must be unique ignoring case")
    names.add(name.toLowerCase())
    if (!Array.isArray(rows)) throw new Error("Sheet rows must be an array")
    rowCount += rows.length
    if (rowCount > 50_000) throw new Error("Workbook exceeds the 50,000 row limit")
    const cleanRows = rows.map((row) => {
      if (!Array.isArray(row)) throw new Error("Each workbook row must be an array")
      if (row.length > 16_384) throw new Error("Workbook exceeds Excel's 16,384 column limit")
      return row.map((cell) => {
        cellCount++
        if (cellCount > MAX_CELLS) throw new Error("Workbook exceeds the 50,000 cell limit")
        if (
          !(
            cell === null ||
            typeof cell === "string" ||
            typeof cell === "boolean" ||
            typeof cell === "number"
          )
        )
          throw new Error("Workbook cells must be text, finite numbers, booleans, or null")
        if (typeof cell === "number" && !Number.isFinite(cell))
          throw new Error("Workbook numbers must be finite")
        if (typeof cell === "string") {
          textBytes += Buffer.byteLength(cell)
          if (textBytes > 1_000_000) throw new Error("Workbook text exceeds the safe output limit")
          xml(cell)
        }
        return cell
      })
    })
    return { name, rows: cleanRows }
  })
  return { sheets: normalized }
}

export async function createWorkbook(input: WorkbookInput): Promise<Buffer> {
  return renderWorkbook(input)
}

async function renderWorkbook(
  input: WorkbookInput,
  legacyDirectoryDates?: Map<string, Date>,
): Promise<Buffer> {
  input = parseWorkbookInput(input)
  const zip = new JSZip()
  const addFile = (name: string, text: string) =>
    zip.file(name, text, { date: new Date("2000-01-01T00:00:00.000Z") })
  const overrides = input.sheets
    .map(
      (_, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("")
  addFile(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}</Types>`,
  )
  addFile(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  )
  const sheetXml = input.sheets
    .map(
      (sheet, index) =>
        `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("")
  addFile(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetXml}</sheets></workbook>`,
  )
  const rels = input.sheets
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join("")
  addFile(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
  )
  input.sheets.forEach((sheet, sheetIndex) => {
    const rows = sheet.rows
      .map((row, rowIndex) => {
        const cells = row
          .map((cell, columnIndex) => {
            const ref = `${columnName(columnIndex)}${rowIndex + 1}`
            if (cell === null) return `<c r="${ref}"/>`
            if (typeof cell === "boolean") return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`
            if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(cell)}</t></is></c>`
          })
          .join("")
        return `<row r="${rowIndex + 1}">${cells}</row>`
      })
      .join("")
    addFile(
      `xl/worksheets/sheet${sheetIndex + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    )
  })
  // JSZip implicitly creates parent directory entries. Their dates must also
  // be fixed, otherwise identical outputs differ across two-second ZIP ticks.
  zip.forEach((name, entry) => {
    if (entry.dir)
      entry.date = legacyDirectoryDates?.get(name) ?? new Date("2000-01-01T00:00:00.000Z")
  })
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  })
  if (bytes.byteLength > MAX_WORKBOOK) throw new Error("Workbook output exceeds the 5 MB limit")
  return bytes
}

/** Preserve earlier hash-bound bundles whose implicit directories used wall time.
 * Only those four directory timestamps may vary; the full reproduced ZIP must match.
 */
export async function matchesLegacyWorkbook(input: WorkbookInput, bytes: Buffer): Promise<boolean> {
  if (bytes.length > MAX_WORKBOOK) return false
  if (bytes.equals(await createWorkbook(input))) return true
  const zip = await JSZip.loadAsync(bytes)
  if (Object.keys(zip.files).length > input.sheets.length + 9) return false
  const dates = new Map<string, Date>()
  for (const name of ["_rels/", "xl/", "xl/_rels/", "xl/worksheets/"]) {
    const entry = zip.files[name]
    if (!entry?.dir || !Number.isFinite(entry.date.valueOf())) return false
    dates.set(name, entry.date)
  }
  return bytes.equals(await renderWorkbook(input, dates))
}

async function makeDirectories(path: string): Promise<void> {
  await assertNoSymlinks(path, true)
  await mkdir(path, { recursive: true, mode: 0o700 })
  await assertNoSymlinks(path)
}

async function saveVersioned(
  directory: string,
  stem: string,
  extension: string,
  bytes: Buffer | string,
): Promise<string> {
  await makeDirectories(directory)
  for (let version = 1; version <= 99; version++) {
    const suffix = version === 1 ? "" : `.v${version}`
    const path = join(directory, `${stem}${suffix}${extension}`)
    await assertNoSymlinks(path, true)
    try {
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await handle.writeFile(bytes)
      } finally {
        await handle.close()
      }
      return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue
      throw error
    }
  }
  throw new Error("No free versioned artifact filename is available")
}

export async function workbookTask(config: ToolkitConfig, taskId: string, inputPath: string) {
  const { vault, task } = await taskVault(config, taskId)
  if (!isAbsolute(inputPath)) throw new Error("Workbook JSON path must be absolute")
  const parsed = parseWorkbookInput(await readJsonInput(inputPath, "Workbook"))
  const bytes = await createWorkbook(parsed)
  const directory = resolve(vault, task.destination)
  if (!within(resolve(vault, task.course.root), directory))
    throw new Error("Task destination is outside its course")
  const path = await saveVersioned(directory, "01 Workbook", ".xlsx", bytes)
  const relativePath = path
    .slice(vault.length + 1)
    .split(sep)
    .join("/")
  const digest = hash(bytes)
  await appendPrivateRecord(vault, task.id, "artifacts.jsonl", {
    createdAt: new Date().toISOString(),
    kind: "workbook",
    path: relativePath,
    hash: digest,
    sheets: parsed.sheets.map((sheet) => sheet.name),
  })
  return {
    path: relativePath,
    hash: digest,
    size: bytes.byteLength,
    sheets: parsed.sheets.map((sheet) => sheet.name),
    note: "Values-only workbook; formulas and macros are not executed.",
  }
}

export async function reviewGate(config: ToolkitConfig, taskId: string) {
  const { vault, task } = await taskVault(config, taskId)
  if (task.status !== "completed") throw new Error("Review gate requires a completed task")
  const output = await readOutput(vault, task)
  if (output === undefined) throw new Error("Completed task output is unavailable")
  const automaticWorkbook = automaticWorkbookEvidence(task)
  const headings = new Set(
    [...output.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)].map((match) => match[1]?.trim() ?? ""),
  )
  const sections = task.requirements.map((section) => ({ section, present: headings.has(section) }))
  const report = [
    "# Human review bundle",
    "",
    `Task: ${task.id}`,
    `Course: ${task.course.code}`,
    `Task output: ${task.output}`,
    `Output SHA-256: ${task.outputHash}`,
    `Evidence snapshots current: yes (${task.sources.length} sources; ${task.guidance.length} guidance files)`,
    ...(task.learningHistory
      ? [
          `Private learning context: ${task.learningHistory.hash} (${task.learningHistory.records.length} retained values); archive bindings checked. Current grades and instructor authorship remain unverified.`,
        ]
      : []),
    "",
    "## Structural checks",
    ...sections.map((item) => `- ${item.present ? "Present" : "Missing"}: ${item.section}`),
    "",
    "## Evidence inventory",
    ...task.sources.map((source) => `- Source: ${source.path} (SHA-256 ${source.hash})`),
    ...task.guidance.map((source) => `- Guidance: ${source.path} (SHA-256 ${source.hash})`),
    "",
    "## Automatic workbook evidence",
    `Scope: ${automaticWorkbook.scope}; state: ${automaticWorkbook.state}.`,
    ...(automaticWorkbook.workbook
      ? [
          `Workbook: ${automaticWorkbook.workbook.path} (SHA-256 ${automaticWorkbook.workbook.hash}). Bytes reproduce the completed draft's tables/Computations; open the workbook to review values and deliverable coverage.`,
        ]
      : [
          automaticWorkbook.state === "verified-empty"
            ? "No tables/Computations were extracted from this new draft. This does not prove that no spreadsheet deliverable was required."
            : automaticWorkbook.state === "uncaptured-legacy"
              ? "This older draft has no automatic workbook recipe; companion evidence is unknown, not verified absent."
              : "Automatic workbook completion does not apply to this task kind/mode.",
        ]),
    "Explicit workbook-command artifacts are not inventoried by this bundle. Byte fidelity is not arithmetic verification, source grounding or academic correctness.",
    "",
    "## Review limits",
    "This bundle checks task identity, unchanged source hashes, output identity, and required heading presence only. It does not assess factual accuracy, academic quality, policy compliance, claim support, or citation correctness.",
    "",
  ].join("\n")
  const path = await saveVersioned(
    resolve(vault, task.destination),
    "01 Review Bundle",
    ".md",
    report,
  )
  const relativePath = path
    .slice(vault.length + 1)
    .split(sep)
    .join("/")
  await appendPrivateRecord(vault, task.id, "artifacts.jsonl", {
    createdAt: new Date().toISOString(),
    kind: "review-bundle",
    path: relativePath,
    hash: hash(report),
    sections,
  })
  return {
    path: relativePath,
    hash: hash(report),
    sections,
    snapshots: "current",
    automaticWorkbook,
    note: "Human review checks are structural and provenance-only.",
  }
}
