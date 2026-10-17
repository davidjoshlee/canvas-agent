import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile } from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"
import { assertNoSymlinks } from "../shared/fs-safety.js"
import type { ToolkitConfig } from "../shared/types.js"
import {
  auditTaskSnapshots,
  automaticWorkbookEvidence,
  readOutput,
} from "./artifacts/inspection.js"
import { readTask } from "./artifacts/records.js"

const MAX_LOG = 1024 * 1024
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const _within = (parent: string, child: string) =>
  child === parent || child.startsWith(`${parent}${sep}`)

async function taskVault(config: ToolkitConfig, taskId: string) {
  const vault = resolve(config.vault.path)
  const task = await readTask(vault, taskId)
  const snapshots = await auditTaskSnapshots(vault, task)
  if (!snapshots.current)
    throw new Error("Task evidence is stale; create a new task before evaluating")
  return { vault, task }
}

async function appendPrivateRecord(
  vault: string,
  taskId: string,
  name: "artifacts.jsonl",
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
          automaticWorkbook.state === "harness-owned"
            ? "The coding harness owns spreadsheet creation and verification. External companions are not inventoried by the CLI."
            : automaticWorkbook.state === "verified-empty"
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
