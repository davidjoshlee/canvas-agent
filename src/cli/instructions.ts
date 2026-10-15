import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { assertNoSymlinks } from "../shared/fs-safety.js"

const definitions = [
  ["agents", "AGENTS.md", 24 * 1024],
  ["cli", "plugins/canvas-agent/references/cli.md", 512 * 1024],
  ["workflows", "plugins/canvas-agent/references/workflows.md", 24 * 1024],
  ["prep", "plugins/canvas-agent/skills/canvas-workspace/SKILL.md", 7500],
  ["assignment", "plugins/canvas-agent/skills/assignment-workflow/SKILL.md", 7500],
  ["setup", "plugins/canvas-agent/skills/setup-and-sync/SKILL.md", 7500],
] as const

async function textAt(path: string, limit: number): Promise<string> {
  await assertNoSymlinks(path)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > limit)
      throw new Error("Packaged instructions exceed file bounds")
    const bytes = Buffer.alloc(limit + 1)
    let length = 0
    while (length < bytes.length) {
      const part = await file.read(bytes, length, bytes.length - length, length)
      if (!part.bytesRead) break
      length += part.bytesRead
    }
    if (length > limit || bytes.subarray(0, length).includes(0))
      throw new Error("Packaged instructions exceed text bounds")
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))
  } finally {
    await file.close()
  }
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
function topicExcerpts(text: string, topic: string) {
  const query = topic.trim()
  if (
    query.length < 2 ||
    query.length > 120 ||
    [...topic].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error("Instruction topic must be 2–120 printable characters")
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
  if (Buffer.byteLength(JSON.stringify(excerpts)) > 64 * 1024)
    throw new Error("Instruction topic is too broad; use a more specific literal phrase")
  return { topic: query, matchMode: "literal-case-insensitive", excerpts }
}

/** Locate this installation's public instructions; never inspect config or vault. */
export async function discoverInstructions(
  packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  topic?: string,
) {
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
  const files = await Promise.all(
    definitions.map(async ([id, relativePath, limit]) => {
      const path = join(root, relativePath)
      let text: string
      try {
        text = await textAt(path, limit)
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
  const core = coreOf(texts.get("cli") ?? "")
  if (
    Buffer.byteLength(core) > 5000 ||
    ["agents", "prep", "assignment", "setup"].some((id) => coreOf(texts.get(id) ?? "") !== core)
  )
    throw new Error(
      "Packaged instruction cores differ or exceed bounds; reinstall matching instructions",
    )
  return {
    version: 1,
    packageVersion: version,
    packageRoot: root,
    files,
    sharedCoreHash: createHash("sha256").update(core).digest("hex"),
    sharedCoreConsistent: true,
    contextInjectionVerified: false,
    instructionAuthenticityVerified: false,
    ...(topic === undefined
      ? {}
      : {
          lookup: {
            ...topicExcerpts(texts.get("cli") ?? "", topic),
            fileId: "cli",
            completeReference: false,
            note: "Matching paragraphs only, with line numbers and heading context. Read related guidance and command --help; excerpts do not replace the applicable skill, saved task or student permission.",
          },
        }),
    note: "Read AGENTS and the applicable skill, then its detailed references; use instructions --topic PHRASE --json for installed CLI excerpts without guessing paths. These paths belong to this CLI installation, not the working directory or plugin cache. Shared CLI cores have equal contract content; hashes do not prove origin, agent injection or attention. Saved task workflows and scoped student permission remain authoritative for authoring.",
  }
}
