import { randomUUID } from "node:crypto"
import { lstat, mkdir, open, readdir, readFile, realpath, writeFile } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { assertNoSymlinks } from "./fs-safety.js"
import { readGuidanceSnapshot, verifySourceSnapshot } from "./tasks.js"
import type { CourseContext, SourceRecord, WorkspaceContext } from "./types.js"
import { inspectWorkspace } from "./workspace.js"

export type GuidanceProposal = { id: string; course: string; task: string; instructions: string }
const MAX_SNAPSHOT_BYTES = 1_500_000
const SourceSnapshotSchema = z
  .object({
    path: z.string().min(1).max(1000),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    text: z.string().max(500_000),
    type: z.string().min(1).max(100),
  })
  .strict()
const GuidanceSnapshotSchema = z
  .object({
    path: z.string().min(1).max(1000),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    text: z.string().max(500_000),
  })
  .strict()
const ProposalRecordSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    course: z.string().min(1).max(100),
    createdAt: z.string().datetime({ offset: true }),
    task: z.string().min(1).max(2000),
    instructions: z.string().min(1).max(2000),
    sources: z.array(SourceSnapshotSchema).max(12),
    guidance: z.array(GuidanceSnapshotSchema).max(24),
    saved: z
      .array(z.string().min(1).max(2000))
      .max(100)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict()
  .superRefine((record, ctx) => {
    const byteCount = [...record.sources, ...record.guidance].reduce(
      (total, snapshot) => total + Buffer.byteLength(snapshot.text, "utf8"),
      0,
    )
    if (byteCount > MAX_SNAPSHOT_BYTES)
      ctx.addIssue({ code: "custom", message: "Proposal source snapshots exceed 1.5 MB" })
    const paths = [...record.sources, ...record.guidance].map((snapshot) => snapshot.path)
    if (new Set(paths).size !== paths.length)
      ctx.addIssue({ code: "custom", message: "Proposal contains duplicate source paths" })
    if (
      record.saved.some(
        (path) => !/^.+\/Guidance\/prep-guidance\.proposed\.v[1-9][0-9]*\.md$/.test(path),
      )
    )
      ctx.addIssue({ code: "custom", message: "Proposal contains an invalid saved candidate path" })
  })
type ProposalRecord = z.infer<typeof ProposalRecordSchema>
const isWithin = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..")
}
async function safeVaultPath(vault: string, path: string, missing = false): Promise<string> {
  if (
    !path ||
    path.startsWith("/") ||
    path.split(/[\\/]/).some((part) => part === ".." || part === ".")
  )
    throw new Error(`Unsafe vault path: ${path}`)
  await assertNoSymlinks(vault)
  const root = await realpath(vault)
  const absolute = resolve(root, path)
  if (!isWithin(root, absolute)) throw new Error("Path escapes the vault")
  await assertNoSymlinks(absolute, missing)
  return absolute
}
function guidanceSources(course: CourseContext): SourceRecord[] {
  const selected = course.sources.filter((source) =>
    /syllabus/i.test(`${source.path} ${source.type}`),
  )
  return selected.sort((a, b) => a.path.localeCompare(b.path))
}

/** Creates a model-free handoff. The generated agent must author a proposal; no policy is inferred. */
export async function proposeGuidance(
  vault: string,
  context: WorkspaceContext,
  course: CourseContext,
): Promise<GuidanceProposal> {
  const freshContext = await inspectWorkspace(vault)
  const selectedCourse = freshContext.courses.find(
    (candidate) => candidate.code === course.code && candidate.root === course.root,
  )
  if (
    !selectedCourse ||
    !context.courses.some(
      (candidate) => candidate.code === course.code && candidate.root === course.root,
    )
  )
    throw new Error("Course must come from the supplied workspace context")
  course = selectedCourse
  const sources = guidanceSources(course)
  if (sources.length === 0)
    throw new Error(
      `No readable syllabus is available for ${course.code}; guidance proposal needs a source syllabus.`,
    )
  if (sources.length > 12 || course.guidance.length > 24)
    throw new Error("Too many syllabus or guidance sources for a bounded proposal handoff")
  const sourceSnapshots = await Promise.all(
    sources.map(async (source) => {
      await verifySourceSnapshot(vault, source)
      return { path: source.path, hash: source.hash, text: source.text, type: source.type }
    }),
  )
  const guidanceSnapshots = await Promise.all(
    course.guidance.map((path) => readGuidanceSnapshot(vault, path)),
  )
  const totalBytes = [...sourceSnapshots, ...guidanceSnapshots].reduce(
    (total, snapshot) => total + Buffer.byteLength(snapshot.text, "utf8"),
    0,
  )
  if (
    totalBytes > MAX_SNAPSHOT_BYTES ||
    [...sourceSnapshots, ...guidanceSnapshots].some(
      (snapshot) => Buffer.byteLength(snapshot.text, "utf8") > 500_000,
    )
  )
    throw new Error("Syllabus and active guidance exceed the 1.5 MB proposal snapshot limit")
  const guidance = guidanceSnapshots.map(
    (snapshot) => `- \`${snapshot.path}\` (SHA-256 ${snapshot.hash})`,
  )
  const id = randomUUID()
  const directoryRel = `_meta/guidance-proposals/${id}`
  const directory = await safeVaultPath(vault, directoryRel, true)
  await mkdir(directory, { recursive: true })
  await assertNoSymlinks(directory)
  const task = [
    "# Course guidance proposal task",
    "",
    `Task: ${id}`,
    `Course: ${course.code} — ${course.title}`,
    "",
    "## Goal",
    "",
    "Draft proposed course guidance for human review, using the syllabus and currently active course guidance listed below.",
    "Do not edit or replace active guidance. Do not treat silence as permission for AI assistance: state that the course's AI-use policy must be confirmed separately.",
    "",
    "## Sources",
    "",
    ...sources.map((source) => `- \`${source.path}\` (SHA-256 ${source.hash})`),
    ...guidance,
    "",
    "## Instructions",
    "",
    "Use only these sources and distinguish explicit rules from uncertainty. Preserve existing instructions unless the source supports a change.",
    `Source and guidance bodies are preserved in \`${directoryRel}/proposal.json\`; cite their exact paths from that record.`,
    "Write a standalone Markdown candidate with a concise course overview, explicit workflow/format expectations, source-backed policy notes, and open questions. Do not claim AI assistance is allowed unless the supplied material explicitly says so.",
    "Save only with `guidance save <task UUID> --file <absolute candidate>`; that command creates a versioned `.proposed.md` file and never changes active guidance.",
    "",
  ].join("\n")
  const instructions = [
    `Proposal task ${id} for ${course.code}.`,
    "",
    "Read the listed local source files and prepare a candidate only. This is a model-free handoff; the CLI does not generate content or grant AI permissions.",
    "Active course guidance:",
    ...(guidance.length ? guidance : ["- None found."]),
    "",
    "Relevant syllabus snapshots:",
    ...sources.map((source) => `- ${source.path}`),
    "",
  ].join("\n")
  const record = ProposalRecordSchema.parse({
    version: 1,
    id,
    course: course.code,
    createdAt: new Date().toISOString(),
    task: `${directoryRel}/TASK.md`,
    instructions: `${directoryRel}/instructions.md`,
    sources: sourceSnapshots,
    guidance: guidanceSnapshots.map(({ path, hash, text }) => ({ path, hash, text })),
    saved: [],
  })
  const serializedRecord = `${JSON.stringify(record, null, 2)}\n`
  if (Buffer.byteLength(serializedRecord, "utf8") > 2_000_000)
    throw new Error("Serialized proposal record exceeds the 2 MB limit")
  await writeFile(join(directory, "TASK.md"), task, { flag: "wx", encoding: "utf8" })
  await writeFile(join(directory, "instructions.md"), instructions, {
    flag: "wx",
    encoding: "utf8",
  })
  await writeFile(join(directory, "proposal.json"), serializedRecord, {
    flag: "wx",
    encoding: "utf8",
  })
  return {
    id,
    course: course.code,
    task: join(directory, "TASK.md"),
    instructions: join(directory, "instructions.md"),
  }
}

export async function saveGuidanceProposal(
  vault: string,
  id: string,
  candidatePath: string,
): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    throw new Error("Proposal ID must be a UUID")
  if (!resolve(candidatePath) || candidatePath !== resolve(candidatePath))
    throw new Error("Candidate file path must be absolute")
  await assertNoSymlinks(candidatePath)
  const stat = await lstat(candidatePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000)
    throw new Error("Candidate must be a regular file under 2 MB")
  const candidate = await readFile(candidatePath, "utf8")
  if (!candidate.trim()) throw new Error("Candidate is empty")
  const metadataPath = await safeVaultPath(vault, `_meta/guidance-proposals/${id}/proposal.json`)
  const metadataStat = await lstat(metadataPath)
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > 2_000_000)
    throw new Error("Proposal record must be a regular file under 2 MB")
  let metadata: ProposalRecord
  try {
    metadata = ProposalRecordSchema.parse(JSON.parse(await readFile(metadataPath, "utf8")))
  } catch {
    throw new Error("Invalid or oversized proposal record")
  }
  if (
    metadata.id !== id ||
    metadata.task !== `_meta/guidance-proposals/${id}/TASK.md` ||
    metadata.instructions !== `_meta/guidance-proposals/${id}/instructions.md`
  )
    throw new Error("Proposal record identity or task paths do not match")
  const workspace = await inspectWorkspace(vault)
  const course = workspace.courses.find((row) => row.code === metadata.course)
  if (!course) throw new Error("Proposal course no longer exists in the workspace")
  const currentSources = guidanceSources(course)
  if (!currentSources.length)
    throw new Error("Syllabus is no longer available; create a new guidance proposal")
  const currentGuidance = await Promise.all(
    course.guidance.map((path) => readGuidanceSnapshot(vault, path)),
  )
  const sourceSnapshots = currentSources.map(({ path, hash, text, type }) => ({
    path,
    hash,
    text,
    type,
  }))
  const guidanceSnapshots = currentGuidance.map(({ path, hash, text }) => ({ path, hash, text }))
  if (
    !sameSnapshots(metadata.sources, sourceSnapshots) ||
    !sameSnapshots(metadata.guidance, guidanceSnapshots)
  )
    throw new Error(
      "Syllabus or active guidance changed since this proposal task was created; create a new proposal",
    )
  for (const source of currentSources) await verifySourceSnapshot(vault, source)
  const targetDirRel = `${course.root}/Guidance`
  const targetDir = await safeVaultPath(vault, targetDirRel, true)
  await mkdir(targetDir, { recursive: true })
  await assertNoSymlinks(targetDir)
  const base = "prep-guidance.proposed"
  const existing = new Set(await readdir(targetDir))
  let version = 1
  while (existing.has(`${base}.v${version}.md`)) version++
  const targetRel = `${targetDirRel}/${base}.v${version}.md`
  const target = await safeVaultPath(vault, targetRel, true)
  const handle = await open(target, "wx", 0o600)
  try {
    await handle.writeFile(candidate, "utf8")
  } finally {
    await handle.close()
  }
  const saved = [...metadata.saved, targetRel]
  const updated = { ...metadata, saved }
  const temp = `${metadataPath}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(ProposalRecordSchema.parse(updated), null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  })
  // Metadata is private; replace only our validated proposal record.
  const { rename } = await import("node:fs/promises")
  await rename(temp, metadataPath)
  return target
}

function sameSnapshots(
  saved: readonly { path: string; hash: string; text: string; type?: string }[],
  current: readonly { path: string; hash: string; text: string; type?: string }[],
): boolean {
  return (
    saved.length === current.length &&
    saved.every((snapshot, index) => {
      const match = current[index]
      return (
        match !== undefined &&
        snapshot.path === match.path &&
        snapshot.hash === match.hash &&
        snapshot.text === match.text &&
        snapshot.type === match.type
      )
    })
  )
}
