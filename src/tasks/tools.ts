import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile } from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"
import { assertNoSymlinks } from "../shared/fs-safety.js"
import { readJsonInput } from "../shared/json-input.js"
import type { SourceRecord, ToolkitConfig } from "../shared/types.js"
import {
  auditTaskSnapshots,
  automaticWorkbookEvidence,
  readOutput,
} from "./artifacts/inspection.js"
import { readTask } from "./artifacts/records.js"
import {
  CALCULATION_OPERATIONS,
  type CalculationBatchItem,
  calculateValues,
} from "./calculations/calculation-core.js"
import { createWorkbook, parseWorkbookInput } from "./calculations/workbook.js"

const MAX_LOG = 1024 * 1024
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const within = (parent: string, child: string) =>
  child === parent || child.startsWith(`${parent}${sep}`)

export {
  auditTaskSnapshots,
  compareTasks,
  inspectTask,
} from "./artifacts/inspection.js"
export type { CalculationBatchItem } from "./calculations/calculation-core.js"
export {
  CALCULATION_OPERATIONS,
  calculateValues,
  parseCalculationBatch,
} from "./calculations/calculation-core.js"
export {
  createWorkbook,
  matchesLegacyWorkbook,
  parseWorkbookInput,
} from "./calculations/workbook.js"

async function taskVault(config: ToolkitConfig, taskId: string) {
  const vault = resolve(config.vault.path)
  const task = await readTask(vault, taskId)
  const snapshots = await auditTaskSnapshots(vault, task)
  if (!snapshots.current)
    throw new Error("Task evidence is stale; create a new task before calculating or evaluating")
  return { vault, task }
}

function validatePrivateToolRecord(
  entry: unknown,
  name: "calculations.jsonl" | "artifacts.jsonl",
): void {
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
      (entry.rate !== undefined && (typeof entry.rate !== "number" || !Number.isFinite(entry.rate)))
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
      (!Array.isArray(entry.sheets) || !entry.sheets.every((value) => typeof value === "string"))
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
      validatePrivateToolRecord(entry, name)
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
