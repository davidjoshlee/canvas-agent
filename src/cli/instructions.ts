import { createHash } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readBoundedFile } from "../shared/fs-safety.js"
import {
  INSTRUCTION_CORE_BUDGET_BYTES,
  INSTRUCTION_ENTRY_BUDGET_BYTES,
  INSTRUCTION_FILE_MAX_BYTES,
  INSTRUCTION_SKILL_BUDGET_BYTES,
  instructionSizeWarning,
} from "./instruction-policy.js"

const definitions = [
  ["agents", "AGENTS.md", INSTRUCTION_ENTRY_BUDGET_BYTES],
  ["cli", "plugins/canvas-agent/references/cli.md", undefined],
  ["workflows", "plugins/canvas-agent/references/workflows.md", INSTRUCTION_ENTRY_BUDGET_BYTES],
  ["prep", "plugins/canvas-agent/skills/canvas-workspace/SKILL.md", INSTRUCTION_SKILL_BUDGET_BYTES],
  [
    "assignment",
    "plugins/canvas-agent/skills/assignment-workflow/SKILL.md",
    INSTRUCTION_SKILL_BUDGET_BYTES,
  ],
  ["setup", "plugins/canvas-agent/skills/setup-and-sync/SKILL.md", INSTRUCTION_SKILL_BUDGET_BYTES],
] as const

async function textAt(path: string, limit: number): Promise<string> {
  const bytes = await readBoundedFile(path, limit)
  if (bytes.includes(0)) throw new Error("Packaged instructions contain invalid text")
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}
function coreOf(text: string): string {
  const start = "<!-- canvas-agent-cli:start -->"
  const end = "<!-- canvas-agent-cli:end -->"
  const first = text.indexOf(start),
    last = text.indexOf(end)
  if (
    first < 0 ||
    last < first ||
    text.indexOf(start, first + start.length) !== -1 ||
    text.indexOf(end, last + end.length) !== -1
  )
    throw new Error("Packaged instruction core is missing or ambiguous")
  return text.slice(first, last + end.length)
}

/** Literal paragraph lookup; keep fenced command examples intact and never truncate. */
function topicExcerpts(text: string, topic: string, page: number) {
  const query = topic.trim()
  if (
    query.length < 1 ||
    query.length > 4096 ||
    [...topic].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error("Instruction topic must be 1–4096 printable characters")
  const lines = text.split("\n")
  const excerpts: { heading: string; startLine: number; endLine: number; text: string }[] = []
  let heading = ""
  let start = 0
  let fence: { marker: string; length: number } | undefined
  const flush = (end: number) => {
    const body = lines.slice(start, end).join("\n")
    if (body.toLowerCase().includes(query.toLowerCase()))
      excerpts.push({ heading, startLine: start + 1, endLine: end, text: body })
    start = end + 1
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (marker) {
      const run = marker[1] ?? ""
      if (!fence) fence = { marker: run[0] ?? "", length: run.length }
      else if (run[0] === fence.marker && run.length >= fence.length && !marker[2]?.trim())
        fence = undefined
    }
    if (!fence && /^#{1,6} /.test(line)) heading = line.replace(/^#+ /, "")
    if (!fence && !line.trim()) flush(i)
  }
  flush(lines.length)
  if (!excerpts.length) throw new Error("No installed CLI guidance matches that literal topic")
  const pages: (typeof excerpts)[] = []
  let current: typeof excerpts = []
  let bytes = 2
  const pageByteTarget = 64 * 1024
  for (const excerpt of excerpts) {
    const size = Buffer.byteLength(JSON.stringify(excerpt)) + 1
    if (current.length && bytes + size > pageByteTarget) {
      pages.push(current)
      current = []
      bytes = 2
    }
    // A single large paragraph or fenced example stays intact on its own page.
    current.push(excerpt)
    bytes += size
  }
  if (current.length) pages.push(current)
  const selected = pages[page - 1]
  if (!selected) throw new Error("Instruction page is out of range")
  return {
    topic: query,
    matchMode: "literal-case-insensitive",
    excerpts: selected,
    page,
    totalPages: pages.length,
    totalMatches: excerpts.length,
    hasMore: page < pages.length,
    nextPage: page < pages.length ? page + 1 : null,
    pageByteTarget,
  }
}

/** Locate this installation's public instructions; never inspect config or vault. */
export async function discoverInstructions(
  packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  topic?: string,
  page?: number,
) {
  if (page !== undefined && topic === undefined)
    throw new Error("Instruction --page requires --topic")
  if (page !== undefined && (!Number.isSafeInteger(page) || page < 1))
    throw new Error("Instruction page must be a positive integer")
  const root = resolve(packageRoot)
  let version: unknown
  try {
    const metadata = JSON.parse(await textAt(join(root, "package.json"), 16 * 1024)) as {
      name?: unknown
      version?: unknown
    }
    if (metadata.name !== "canvas-agent") throw new Error("Wrong package")
    version = metadata.version
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version))
      throw new Error("Invalid version")
  } catch {
    throw new Error("Packaged instruction metadata is unavailable or invalid")
  }
  const texts = new Map<string, string>()
  const warnings: string[] = []
  const files = await Promise.all(
    definitions.map(async ([id, relativePath]) => {
      const path = join(root, relativePath)
      let text: string
      try {
        text = await textAt(path, INSTRUCTION_FILE_MAX_BYTES)
      } catch {
        throw new Error(`Packaged instruction unavailable or unsafe: ${id}`)
      }
      texts.set(id, text)
      return {
        id,
        path,
        relativePath,
        bytes: Buffer.byteLength(text),
        sha256: createHash("sha256").update(text).digest("hex"),
      }
    }),
  )
  for (const [id, , budget] of definitions) {
    if (budget === undefined) continue
    const warning = instructionSizeWarning(
      `Instruction ${id}`,
      Buffer.byteLength(texts.get(id) ?? ""),
      budget,
    )
    if (warning) warnings.push(warning)
  }
  const core = coreOf(texts.get("cli") ?? "")
  const coreWarning = instructionSizeWarning(
    "Shared CLI core",
    Buffer.byteLength(core),
    INSTRUCTION_CORE_BUDGET_BYTES,
  )
  if (coreWarning) warnings.push(coreWarning)
  if (["agents", "prep", "assignment", "setup"].some((id) => coreOf(texts.get(id) ?? "") !== core))
    throw new Error("Packaged instruction cores differ; reinstall matching instructions")
  return {
    version: 1,
    packageVersion: version,
    packageRoot: root,
    files,
    warnings,
    sharedCoreHash: createHash("sha256").update(core).digest("hex"),
    sharedCoreConsistent: true,
    contextInjectionVerified: false,
    instructionAuthenticityVerified: false,
    ...(topic === undefined
      ? {}
      : {
          lookup: {
            ...topicExcerpts(texts.get("cli") ?? "", topic, page ?? 1),
            fileId: "cli",
            completeReference: false,
            note: "Matching paragraphs only, with line numbers and heading context. Read related guidance and command --help; excerpts do not replace the applicable skill, saved task or student permission.",
          },
        }),
    note: "Read AGENTS and the applicable skill, then its detailed references; use instructions --topic PHRASE --json for installed CLI excerpts without guessing paths. These paths belong to this CLI installation, not the working directory or plugin cache. Shared CLI cores have equal contract content; hashes do not prove origin, agent injection or attention. Saved task workflows and scoped student permission remain authoritative for authoring.",
  }
}
