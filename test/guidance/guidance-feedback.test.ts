import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  feedbackDirectory,
  feedbackHash,
  feedbackSnapshot,
  normalizeOwnFeedback,
} from "../../src/feedback/history.js"
import {
  captureProposalFeedback,
  ProposalFeedbackAssignmentsSchema,
} from "../../src/guidance/feedback.js"
import { proposeGuidance, saveGuidanceProposal } from "../../src/guidance/proposals.js"
import { planReadingCopy } from "../../src/vault/reading-copy.js"
import { inspectWorkspace, selectCourse } from "../../src/vault/workspace.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "canvas-proposal-feedback-"))
  roots.push(base)
  const vault = join(base, "vault")
  await mkdir(join(vault, "CS101/Guidance"), { recursive: true })
  await mkdir(join(vault, "_meta"))
  await writeFile(
    join(vault, "_meta/canvas-courses.json"),
    JSON.stringify({
      version: 1,
      courses: [{ root: "CS101", code: "CS101", id: "1", name: "Synthetic course" }],
    }),
  )
  await writeFile(join(vault, "CS101/syllabus.md"), "Synthetic course syllabus.")
  await writeFile(join(vault, "CS101/Guidance/active.md"), "Keep active guidance unchanged.")
  const candidate = join(base, "candidate.md")
  await writeFile(
    candidate,
    "# Private proposed guidance\nReview evidence before drawing conclusions.\n## Sources\n`CS101/syllabus.md`\n## Brief structure\nReading synthesis, Discussion preparation, Sources\n",
  )
  const cache = async (id: string, score: number, checkedAt: string) => {
    const directory = feedbackDirectory(vault, "1", id)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const data = normalizeOwnFeedback(
      {
        assignment_id: Number(id),
        score,
        submission_comments: [{ comment: `PRIVATE_LESSON_${id}_${score}` }],
      },
      "1",
      id,
    )
    const hash = feedbackHash(data)
    await writeFile(join(directory, `${hash}.json`), JSON.stringify(data), { mode: 0o600 })
    await writeFile(
      join(directory, "current.json"),
      JSON.stringify({ ...feedbackSnapshot(data), checkedAt }),
      { mode: 0o600 },
    )
    return join(directory, `${hash}.json`)
  }
  const context = await inspectWorkspace(vault)
  const course = selectCourse(context, "CS101")
  const propose = (feedbackAssignments?: string[]) =>
    proposeGuidance(vault, context, course, feedbackAssignments ? { feedbackAssignments } : {})
  return { base, vault, candidate, cache, context, course, propose }
}
async function record(vault: string, id: string) {
  const path = join(vault, "_meta/guidance-proposals", id, "proposal.json")
  return { path, value: JSON.parse(await readFile(path, "utf8")) }
}

it("captures at most five current own values privately, not older values, observations or public sources", async () => {
  const f = await fixture()
  await f.cache("10", 1, "2026-10-01T00:00:00Z")
  for (let i = 10; i <= 15; i++) await f.cache(String(i), i, `2026-10-${i}T00:00:00Z`)
  const proposal = await f.propose()
  const r = await record(f.vault, proposal.id)
  expect(r.value.proposalFeedbackVersion).toBe(1)
  expect(
    r.value.learningHistory.records.map((row: { assignmentId: string }) => row.assignmentId),
  ).toEqual(["15", "14", "13", "12", "11"])
  expect(r.value.learningHistory.observations).toBeUndefined()
  expect(JSON.stringify(r.value.sources)).not.toContain("PRIVATE_LESSON")
  expect(await readFile(proposal.task, "utf8")).toContain("not grading chronology")
  expect((await stat(r.path)).mode & 0o777).toBe(0o600)
  const active = await readFile(join(f.vault, "CS101/Guidance/active.md"))
  await saveGuidanceProposal(f.vault, proposal.id, f.candidate)
  expect(await readFile(join(f.vault, "CS101/Guidance/active.md"))).toEqual(active)
  const plan = await planReadingCopy(f.vault, join(f.base, "reading-copy"))
  expect(JSON.stringify(plan)).not.toMatch(/PRIVATE_LESSON|proposal\.json|prep-guidance\.proposed/)
})

it("permits unchanged cache refreshes but rejects changed selected values and altered archives without rewriting the proposal", async () => {
  const f = await fixture()
  const archive = await f.cache("10", 10, "2026-10-10T00:00:00Z")
  const proposal = await f.propose(["10"])
  await f.cache("10", 10, "2026-10-11T00:00:00Z")
  await saveGuidanceProposal(f.vault, proposal.id, f.candidate)
  const r = await record(f.vault, proposal.id),
    before = await readFile(r.path)
  await f.cache("10", 20, "2026-10-12T00:00:00Z")
  await expect(saveGuidanceProposal(f.vault, proposal.id, f.candidate)).rejects.toThrow(
    /feedback changed/,
  )
  expect(await readFile(r.path)).toEqual(before)
  await writeFile(archive, '{"tampered":true}')
  await expect(saveGuidanceProposal(f.vault, proposal.id, f.candidate)).rejects.toThrow()
  expect(await readFile(r.path)).toEqual(before)
})

it("detects newly available feedback, while legacy proposals remain un-enriched and explicitly scoped proposals ignore unrelated caches", async () => {
  const f = await fixture()
  const noFeedback = await f.propose(),
    legacy = await f.propose()
  const old = await record(f.vault, legacy.id)
  delete old.value.proposalFeedbackVersion
  await writeFile(old.path, JSON.stringify(old.value))
  await f.cache("10", 10, "2026-10-10T00:00:00Z")
  await expect(saveGuidanceProposal(f.vault, noFeedback.id, f.candidate)).rejects.toThrow(
    /feedback changed/,
  )
  await saveGuidanceProposal(f.vault, legacy.id, f.candidate)
  expect((await record(f.vault, legacy.id)).value.learningHistory).toBeUndefined()
  const scoped = await f.propose(["10"])
  await f.cache("11", 11, "2026-10-11T00:00:00Z")
  await writeFile(
    join(feedbackDirectory(f.vault, "1", "11"), "current.json"),
    "INVALID_UNRELATED_CACHE",
  )
  await saveGuidanceProposal(f.vault, scoped.id, f.candidate)
})

it("rejects unsafe scopes, unknown assignment caches and mismatched course identities", async () => {
  const f = await fixture()
  for (const scope of [[], ["../10"], ["10", "10"], ["1", "2", "3", "4", "5", "6"]])
    expect(ProposalFeedbackAssignmentsSchema.safeParse(scope).success).toBe(false)
  await expect(f.propose(["99"])).rejects.toThrow(/no known cache/)
  await expect(captureProposalFeedback(f.vault, { ...f.course, canvasId: "2" })).rejects.toThrow(
    /binding/,
  )
})

it("rejects a changed default top-five selection even when all previously selected values are unchanged", async () => {
  const f = await fixture()
  for (let i = 10; i < 15; i++) await f.cache(String(i), i, `2026-10-${i}T00:00:00Z`)
  const proposal = await f.propose(),
    r = await record(f.vault, proposal.id)
  const before = await readFile(r.path)
  await f.cache("15", 15, "2026-10-15T00:00:00Z")
  await expect(saveGuidanceProposal(f.vault, proposal.id, f.candidate)).rejects.toThrow(
    /feedback changed/,
  )
  expect(await readFile(r.path)).toEqual(before)
})

it("rejects oversized selected feedback without truncating comments or creating a handoff", async () => {
  const f = await fixture()
  const data = normalizeOwnFeedback(
    {
      assignment_id: 10,
      submission_comments: Array.from({ length: 50 }, () => ({ comment: "x".repeat(12_000) })),
    },
    "1",
    "10",
  )
  const directory = feedbackDirectory(f.vault, "1", "10")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, `${feedbackHash(data)}.json`), JSON.stringify(data), {
    mode: 0o600,
  })
  await writeFile(join(directory, "current.json"), JSON.stringify(feedbackSnapshot(data)), {
    mode: 0o600,
  })
  await expect(f.propose(["10"])).rejects.toThrow(/500 KB/)
  await expect(stat(join(f.vault, "_meta/guidance-proposals"))).rejects.toMatchObject({
    code: "ENOENT",
  })
})

it("accepts repeatable exact feedback scope through the compiled CLI without echoing private values", async () => {
  const f = await fixture()
  await f.cache("10", 10, "2026-10-10T00:00:00Z")
  const config = join(f.base, "config.json")
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      canvas: { baseUrl: "https://canvas.example.invalid", tokenEnv: "UNSET_PROPOSAL_TOKEN" },
      vault: { path: f.vault },
      courses: { allowlist: [] },
    }),
  )
  const cli = (scope: string[]) =>
    spawnSync(
      process.execPath,
      [
        resolve("dist/cli.js"),
        "guidance",
        "propose",
        "CS101",
        ...scope,
        "--config",
        config,
        "--json",
      ],
      { cwd: f.base, encoding: "utf8", timeout: 30_000 },
    )
  const result = cli(["--feedback-assignment", "10"])
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).not.toContain("PRIVATE_LESSON")
  const r = await record(f.vault, JSON.parse(result.stdout).id)
  expect(r.value.feedbackAssignments).toEqual(["10"])
  expect(cli(["--feedback-assignment", "10", "--feedback-assignment", "10"]).status).not.toBe(0)
})
