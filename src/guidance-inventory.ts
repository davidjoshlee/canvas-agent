import { lstat, readdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { assertNoSymlinks } from "./fs-safety.js"
import { readGuidanceProposalRecord } from "./guidance.js"
import { inspectWorkspace, selectCourse } from "./workspace.js"

const limitation =
  "Validated saved proposal metadata only. Source currentness, feedback archives, candidate bytes, permission, academic quality and activation are not verified. Missing handoffs are reported without repairing history."
async function rootPath(vault: string) {
  await assertNoSymlinks(vault)
  return realpath(vault)
}
async function handoff(root: string, path: string) {
  const full = join(root, path)
  await assertNoSymlinks(full, true)
  const info = await lstat(full).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  })
  if (!info) return null
  if (!info.isFile() || info.size > 2_000_000) throw new Error("Unsafe proposal handoff")
  return full
}

/** No body echo, live sources, feedback reads, candidate adoption or filesystem writes. */
export async function showGuidanceProposal(vault: string, id: string) {
  const root = await rootPath(vault)
  const record = await readGuidanceProposalRecord(root, id)
  return {
    id: record.id,
    course: record.course,
    createdAt: record.createdAt,
    recordPath: join(root, "_meta/guidance-proposals", record.id, "proposal.json"),
    task: await handoff(root, record.task),
    instructions: await handoff(root, record.instructions),
    sourceCount: record.sources.length,
    guidanceCount: record.guidance.length,
    privateFeedbackRecordCount: record.learningHistory?.records.length ?? 0,
    savedCandidateCount: record.saved.length,
    saved: record.saved,
    currentnessChecked: false,
    activationState: "not-verified",
    limitation,
  }
}

export async function listGuidanceProposals(vault: string, query: string) {
  const root = await rootPath(vault)
  const course = selectCourse(await inspectWorkspace(root), query)
  const directory = join(root, "_meta/guidance-proposals")
  await assertNoSymlinks(directory, true)
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  })
  if (entries.length > 1000) throw new Error("Proposal inventory exceeds 1000 entries")
  const budget = { remaining: 100_000_000 }
  const proposals: Array<{
    id: string
    course: string
    createdAt: string
    savedCandidateCount: number
  }> = []
  let unreadableRecords = 0
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!z.string().uuid().safeParse(entry.name).success) continue
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe proposal entry")
      const record = await readGuidanceProposalRecord(root, entry.name, budget)
      if (record.course !== course.code) continue
      proposals.push({
        id: record.id,
        course: record.course,
        createdAt: record.createdAt,
        savedCandidateCount: record.saved.length,
      })
    } catch {
      if (budget.remaining < 0) throw new Error("Proposal inventory exceeds 100 MB")
      unreadableRecords++
    }
  }
  proposals.sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id),
  )
  return {
    course: course.code,
    proposals,
    unreadableRecords,
    inventoryComplete: unreadableRecords === 0,
    limitation: `${limitation} Unreadable records have unknown course scope and may hide proposals.`,
  }
}
