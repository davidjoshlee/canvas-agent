import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, readFile, realpath, writeFile } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { verifyLearningHistory } from "../feedback/history.js"
import { assertNoSymlinks } from "../shared/fs-safety.js"
import type { CourseContext, SourceRecord, WorkspaceContext } from "../shared/types.js"
import {
  readGuidanceSnapshot,
  readSelectedGuidance,
  verifySourceSnapshot,
} from "../tasks/authoring/recipes.js"
import { declaredPrepSections } from "../tasks/authoring/requirements.js"
import { isAssignmentSource, isFeedbackSource, isSyllabusSource } from "../vault/source-kind.js"
import { inspectWorkspace } from "../vault/workspace.js"
import {
  captureProposalFeedback,
  ProposalFeedbackAssignmentsSchema,
  ProposalFeedbackSchema,
  proposalFeedbackInstruction,
  sameProposalFeedback,
} from "./feedback.js"
import { restrictedGuidancePaths } from "./selection.js"

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
    guidanceSelectionVersion: z.literal(1).optional(),
    proposalContextVersion: z.literal(1).optional(),
    proposalFeedbackVersion: z.literal(1).optional(),
    proposalStructureVersion: z.literal(1).optional(),
    feedbackAssignments: ProposalFeedbackAssignmentsSchema.optional(),
    learningHistory: ProposalFeedbackSchema.optional(),
    id: z.string().uuid(),
    course: z.string().min(1).max(100),
    createdAt: z.string().datetime({ offset: true }),
    task: z.string().min(1).max(2000),
    instructions: z.string().min(1).max(2000),
    sources: z.array(SourceSnapshotSchema).max(17),
    guidance: z.array(GuidanceSnapshotSchema).max(24),
    saved: z
      .array(z.string().min(1).max(2000))
      .max(100)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (
      (!record.proposalFeedbackVersion && (record.learningHistory || record.feedbackAssignments)) ||
      (record.learningHistory && record.learningHistory.course !== record.course)
    )
      ctx.addIssue({
        code: "custom",
        message: "Proposal feedback recipe or course binding mismatch",
      })
    if (!record.proposalContextVersion && record.sources.length > 12)
      ctx.addIssue({ code: "custom", message: "Legacy proposal exceeds source bounds" })
    const byteCount =
      (record.learningHistory ? Buffer.byteLength(JSON.stringify(record.learningHistory)) : 0) +
      [...record.sources, ...record.guidance].reduce(
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
        (path) =>
          !/^[^/\\]+\/Guidance\/prep-guidance\.proposed\.v[1-9][0-9]*\.md$/.test(path) ||
          path.split("/").some((part) => part === "." || part === ".."),
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
function guidanceSources(course: CourseContext, version?: 1): SourceRecord[] {
  const work = new Set(course.existingWork)
  const permitted = (source: SourceRecord) =>
    Boolean(source.text.trim()) &&
    !/\.(?:feedback|summary)\.md$/i.test(source.path) &&
    !isFeedbackSource(source) &&
    !work.has(source.path)
  const selected = course.sources.filter(
    (source) => isSyllabusSource(source) && (!version || permitted(source)),
  )
  selected.sort((a, b) => a.path.localeCompare(b.path))
  if (!version) return selected
  if (selected.length > 12) throw new Error("Too many syllabus sources for a bounded proposal")
  const rank = (source: SourceRecord) => {
    for (const value of [source.postedAt, source.dueAt]) {
      const time = value ? Date.parse(value) : Number.NaN
      if (Number.isFinite(time)) return time
    }
    return Number.NEGATIVE_INFINITY
  }
  const assignments = course.sources
    .filter(
      (source) =>
        isAssignmentSource(source) &&
        permitted(source) &&
        !selected.some((row) => row.path === source.path),
    )
    .sort((a, b) => {
      const left = rank(a),
        right = rank(b)
      return left === right ? a.path.localeCompare(b.path) : left > right ? -1 : 1
    })
    .slice(0, 5)
  return [...selected, ...assignments]
}

/** Creates a model-free handoff. The generated agent must author a proposal; no policy is inferred. */
export async function proposeGuidance(
  vault: string,
  context: WorkspaceContext,
  course: CourseContext,
  options: { feedbackAssignments?: string[] } = {},
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
  const sources = guidanceSources(course, 1)
  if (!sources.some(isSyllabusSource))
    throw new Error(
      `No readable syllabus is available for ${course.code}; guidance proposal needs a source syllabus.`,
    )
  const sourceSnapshots = await Promise.all(
    sources.map(async (source) => {
      await verifySourceSnapshot(vault, source)
      return { path: source.path, hash: source.hash, text: source.text, type: source.type }
    }),
  )
  const guidanceSnapshots = await readSelectedGuidance(
    vault,
    course.guidance,
    "prep",
    undefined,
    [],
    restrictedGuidancePaths(course),
  )
  if (guidanceSnapshots.length > 24)
    throw new Error("Too many selected common guidance sources for a bounded proposal handoff")
  const learningHistory = await captureProposalFeedback(vault, course, options.feedbackAssignments)
  const totalBytes =
    (learningHistory ? Buffer.byteLength(JSON.stringify(learningHistory)) : 0) +
    [...sourceSnapshots, ...guidanceSnapshots].reduce(
      (total, snapshot) => total + Buffer.byteLength(snapshot.text, "utf8"),
      0,
    )
  if (
    totalBytes > MAX_SNAPSHOT_BYTES ||
    [...sourceSnapshots, ...guidanceSnapshots].some(
      (snapshot) => Buffer.byteLength(snapshot.text, "utf8") > 500_000,
    )
  )
    throw new Error("Proposal source/guidance/feedback context exceeds the 1.5 MB snapshot limit")
  const guidance = guidanceSnapshots.map(
    (snapshot) => `- \`${snapshot.path}\` (SHA-256 ${snapshot.hash})`,
  )
  const id = randomUUID()
  const directoryRel = `_meta/guidance-proposals/${id}`
  const directory = await safeVaultPath(vault, directoryRel, true)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await assertNoSymlinks(directory)
  const task = [
    "# Course guidance proposal task",
    "",
    `Task: ${id}`,
    `Course: ${course.code} — ${course.title}`,
    "",
    "## Goal",
    "",
    "Draft proposed course guidance for human review, using the syllabus, sampled assignment prompts and currently active common course guidance below.",
    "The sample includes up to five readable assignments, ranked by cached posted date then due date with deterministic path ties; undated prompts sort last. This is selection metadata, not proof of publication, recent instructor intent or historical availability. Excluded/restricted sources are never substituted.",
    "Separate standing expectations for graded deliverables from the weekly prep brief's format. Do not copy a graded memo/case response structure into the weekly prep brief. Preserve any existing prep structure unless these sources support a change; do not infer instructor permission from assignments or prior work.",
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
    "Declare the weekly prep format in exactly one ## Brief structure or ## Prep brief structure block with safe section names (plain/comma-separated names, bullets or subheadings). Keep instructions outside that block. It must contain at least one substantive prep section, not Sources alone; Sources is always required in the eventual brief. Saving validates that the declaration parses back through the prep parser. This is structural validation, not academic review or activation.",
    "Include a ## Sources section with exact supplied source paths in backticks. Unbound path citations, credential-like text and uncited proposals are rejected.",
    "Save only with `guidance save <task UUID> --file <absolute candidate>`; that command creates a versioned `.proposed.md` file and never changes active guidance.",
    ...(learningHistory
      ? [
          proposalFeedbackInstruction,
          "Read learningHistory only in the private proposal.json record; it is not part of Sources or a permission grant.",
        ]
      : [
          "No meaningful cached own-feedback was selected. Do not invent past feedback or instructor preferences.",
        ]),
    "",
  ].join("\n")
  const instructions = [
    `Proposal task ${id} for ${course.code}.`,
    "",
    "Read the listed local source files and prepare a candidate only. This is a model-free handoff; the CLI does not generate content or grant AI permissions.",
    "Active course guidance:",
    ...(guidance.length ? guidance : ["- None found."]),
    "",
    "Selected syllabus and assignment snapshots:",
    ...sources.map((source) => `- ${source.path}`),
    "",
  ].join("\n")
  const record = ProposalRecordSchema.parse({
    version: 1,
    guidanceSelectionVersion: 1,
    proposalContextVersion: 1,
    proposalFeedbackVersion: 1,
    proposalStructureVersion: 1,
    ...(options.feedbackAssignments ? { feedbackAssignments: options.feedbackAssignments } : {}),
    ...(learningHistory ? { learningHistory } : {}),
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
  await writeFile(join(directory, "TASK.md"), task, { flag: "wx", encoding: "utf8", mode: 0o600 })
  await writeFile(join(directory, "instructions.md"), instructions, {
    flag: "wx",
    encoding: "utf8",
    mode: 0o600,
  })
  await writeFile(join(directory, "proposal.json"), serializedRecord, {
    flag: "wx",
    encoding: "utf8",
    mode: 0o600,
  })
  return {
    id,
    course: course.code,
    task: join(directory, "TASK.md"),
    instructions: join(directory, "instructions.md"),
  }
}

/** Private validated record reader; callers must not emit source/feedback bodies in inventories. */
export async function readGuidanceProposalRecord(
  vault: string,
  id: string,
  budget?: { remaining: number },
): Promise<ProposalRecord> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    throw new Error("Proposal ID must be a UUID")
  const path = await safeVaultPath(vault, `_meta/guidance-proposals/${id}/proposal.json`)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let metadata: ProposalRecord
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 2_000_000)
      throw new Error("Proposal record must be a regular file under 2 MB")
    if (budget) {
      budget.remaining -= info.size
      if (budget.remaining < 0) throw new Error("Proposal inventory exceeds 100 MB")
    }
    const buffer = Buffer.alloc(2_000_001)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    const bytes = buffer.subarray(0, length)
    if (budget && bytes.length > info.size) budget.remaining -= bytes.length - info.size
    if (budget && budget.remaining < 0) throw new Error("Proposal inventory exceeds 100 MB")
    if (
      bytes.length > 2_000_000 ||
      bytes.includes(0) ||
      !Buffer.from(bytes.toString()).equals(bytes)
    )
      throw new Error("Invalid or oversized proposal record")
    try {
      metadata = ProposalRecordSchema.parse(JSON.parse(bytes.toString()))
    } catch {
      throw new Error("Invalid or oversized proposal record")
    }
  } finally {
    await handle.close()
  }
  if (
    metadata.id !== id ||
    metadata.task !== `_meta/guidance-proposals/${id}/TASK.md` ||
    metadata.instructions !== `_meta/guidance-proposals/${id}/instructions.md`
  )
    throw new Error("Proposal record identity or task paths do not match")
  return metadata
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
  const metadata = await readGuidanceProposalRecord(vault, id)
  const workspace = await inspectWorkspace(vault)
  const course = workspace.courses.find((row) => row.code === metadata.course)
  if (!course) throw new Error("Proposal course no longer exists in the workspace")
  if (metadata.proposalFeedbackVersion) {
    if (metadata.learningHistory)
      await verifyLearningHistory(vault, metadata.learningHistory, course)
    const currentFeedback = await captureProposalFeedback(
      vault,
      course,
      metadata.feedbackAssignments,
    )
    if (!sameProposalFeedback(metadata.learningHistory, currentFeedback))
      throw new Error("Selected proposal feedback changed; create a new proposal")
  }
  const currentSources = guidanceSources(course, metadata.proposalContextVersion)
  if (!currentSources.some(isSyllabusSource))
    throw new Error("Syllabus is no longer available; create a new guidance proposal")
  const currentGuidance = metadata.guidanceSelectionVersion
    ? await readSelectedGuidance(
        vault,
        course.guidance,
        "prep",
        undefined,
        [],
        restrictedGuidancePaths(course),
      )
    : await Promise.all(course.guidance.map((path) => readGuidanceSnapshot(vault, path)))
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
      "Selected proposal sources or active guidance changed since this proposal task was created; create a new proposal",
    )
  for (const source of currentSources) await verifySourceSnapshot(vault, source)
  const allowed = new Set([...metadata.sources, ...metadata.guidance].map((source) => source.path))
  const sections = candidate.split(/^##\s+/m)
  const sourceSection = sections.find((section) => /^Sources\s*\r?\n/i.test(section))
  if (
    !sourceSection ||
    ![...sourceSection.matchAll(/`([^`]+)`/g)].some((match) => allowed.has(match[1] ?? ""))
  )
    throw new Error("Guidance Sources section must cite exact proposal source paths in backticks")
  for (const match of candidate.matchAll(/`([^`]+)`/g)) {
    const path = match[1] ?? ""
    if ((path.includes("/") || /\.(?:md|txt|pdf|docx?)$/i.test(path)) && !allowed.has(path))
      throw new Error(`Guidance citation is not an exact proposal source path: ${path}`)
  }
  if (
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~-]{16,}|(?:api[_-]?key|access[_-]?token|client[_-]?secret|canvas[_-]?token|password|secret)\s*[:=]\s*\S+)/i.test(
      candidate,
    )
  )
    throw new Error("Guidance candidate appears to contain credentials")
  if (metadata.proposalStructureVersion) {
    // A proposal must round-trip through the same parser used by fresh prep tasks,
    // without falling back to generic defaults or finding a heading in an example.
    let fenced = false
    let fenceCharacter = ""
    let fenceLength = 0
    let declarations = 0
    for (const line of candidate.split(/\r?\n/)) {
      const fence = line.match(/^\s*(`{3,}|~{3,})/)
      if (fence?.[1]) {
        const marker = fence[1]
        if (!fenced) {
          fenced = true
          fenceCharacter = marker[0] ?? ""
          fenceLength = marker.length
        } else if (marker[0] === fenceCharacter && marker.length >= fenceLength) fenced = false
        continue
      }
      if (
        /^##\s+(?:Brief structure|Prep brief structure)(?:\s*\([^)]*\))?\s*$/i.test(line.trim())
      ) {
        if (fenced) throw new Error("Prep structure declaration cannot be a fenced example")
        declarations++
      }
    }
    if (declarations !== 1)
      throw new Error("Guidance must declare exactly one Brief structure for weekly prep")
    const headings = declaredPrepSections(candidate)
    if (!headings.some((heading) => heading.toLocaleLowerCase() !== "sources"))
      throw new Error("Guidance must declare a substantive prep section, not Sources alone")
  }
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
