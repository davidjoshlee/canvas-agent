import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { proposeGuidance, saveGuidanceProposal } from "../../src/guidance/proposals.js"
import { inspectWorkspace, selectCourse } from "../../src/vault/workspace.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const container = await mkdtemp(join(tmpdir(), "canvas-proposal-context-"))
  roots.push(container)
  const root = join(container, "vault")
  const put = async (path: string, text: string) => {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, text)
  }
  await put(
    "CS101/syllabus.md",
    "Synthetic syllabus: weekly discussion prep differs from graded memos.",
  )
  await put(
    "CS101/Guidance/active.md",
    "Synthetic fixture explicitly permits AI assistance; preserve the original guide.",
  )
  for (let index = 0; index < 7; index++)
    await put(
      `CS101/Assignments/prompt-${index}.md`,
      `---\ntype: assignment\ncanvas_id: '${index + 10}'\nposted_at: 2026-10-${12 + index}T00:00:00Z\n---\nRequired: explain framework ${index}; do not treat this graded memo's shape as a prep template.`,
    )
  await put("CS101/Assignments/undated.md", "---\ntype: assignment\n---\nUNDATED_SENTINEL")
  await put(
    "CS101/Assignments/private.feedback.md",
    "---\ntype: assignment\nposted_at: 2040-01-01\n---\nPRIVATE_FEEDBACK_SENTINEL",
  )
  await put(
    "CS101/Assignments/blocked.md",
    "---\ntype: assignment\nai_policy: prohibited\nposted_at: 2040-01-01\n---\nRESTRICTED_SENTINEL",
  )
  await put("CS101/Assignments/Drafts/work.md", "---\ntype: drafts\n---\nSTUDENT_WORK_SENTINEL")
  await put(
    "CS202/Assignments/other.md",
    "---\ntype: assignment\nposted_at: 2040-01-01\n---\nOTHER_COURSE_SENTINEL",
  )
  const context = await inspectWorkspace(root)
  const proposal = await proposeGuidance(root, context, selectCourse(context, "CS101"))
  const recordPath = join(root, "_meta/guidance-proposals", proposal.id, "proposal.json")
  const record = JSON.parse(await readFile(recordPath, "utf8"))
  const candidate = join(container, "candidate.md")
  await writeFile(
    candidate,
    "# Proposed synthetic course guidance\nKeep prep separate from graded submissions.\n\n## Sources\n`CS101/syllabus.md`\n\n## Brief structure\n- Reading synthesis\n- Discussion preparation\n- Sources\n",
  )
  return { root, container, put, proposal, recordPath, record, candidate }
}

it("captures five scoped date-ranked prompts and separates graded expectations from weekly prep", async () => {
  const f = await fixture()
  await f.put(
    "CS101/syllabus.feedback.md",
    "---\ntype: feedback\n---\nPRIVATE_SYLLABUS_FEEDBACK_SENTINEL",
  )
  const current = await inspectWorkspace(f.root)
  const newer = await proposeGuidance(f.root, current, selectCourse(current, "CS101"))
  expect(
    await readFile(join(f.root, "_meta/guidance-proposals", newer.id, "proposal.json"), "utf8"),
  ).not.toContain("PRIVATE_SYLLABUS_FEEDBACK_SENTINEL")
  expect(f.record.proposalContextVersion).toBe(1)
  expect(f.record.sources.map((row: { path: string }) => row.path)).toEqual([
    "CS101/syllabus.md",
    ...[6, 5, 4, 3, 2].map((index) => `CS101/Assignments/prompt-${index}.md`),
  ])
  expect(JSON.stringify(f.record)).not.toMatch(
    /UNDATED_SENTINEL|PRIVATE_FEEDBACK_SENTINEL|RESTRICTED_SENTINEL|STUDENT_WORK_SENTINEL|OTHER_COURSE_SENTINEL/,
  )
  const task = await readFile(f.proposal.task, "utf8")
  expect(task).toContain("Do not copy a graded memo/case response structure")
  expect(task).toContain("not proof of publication")
  const active = await readFile(join(f.root, "CS101/Guidance/active.md"))
  await f.put(
    "CS101/Assignments/prompt-0.md",
    "---\ntype: assignment\nposted_at: 2026-10-12\n---\nChanged outside the selected five.",
  )
  const saved = await saveGuidanceProposal(f.root, f.proposal.id, f.candidate)
  expect(saved).toContain("prep-guidance.proposed.v1.md")
  expect(await readFile(join(f.root, "CS101/Guidance/active.md"))).toEqual(active)
})

it("fails closed when selected prompt text, recency selection or policy changes without modifying the proposal", async () => {
  for (const change of ["body", "selection", "policy"] as const) {
    const f = await fixture()
    const before = await readFile(f.recordPath)
    if (change === "selection")
      await f.put(
        "CS101/Assignments/new.md",
        "---\ntype: assignment\nposted_at: 2026-10-20\n---\nA newly selected prompt.",
      )
    else
      await f.put(
        "CS101/Assignments/prompt-6.md",
        `---\ntype: assignment\nposted_at: 2026-10-18\n${change === "policy" ? "ai_policy: prohibited\n" : ""}---\nChanged selected body.`,
      )
    await expect(saveGuidanceProposal(f.root, f.proposal.id, f.candidate)).rejects.toThrow(
      /changed since this proposal/,
    )
    expect(await readFile(f.recordPath)).toEqual(before)
  }
})

it("retains coherent earlier syllabus-only proposal selection after new assignment changes", async () => {
  const f = await fixture()
  const old = {
    ...f.record,
    sources: f.record.sources.filter((row: { path: string }) => row.path === "CS101/syllabus.md"),
  }
  delete old.proposalContextVersion
  await writeFile(f.recordPath, JSON.stringify(old))
  await writeFile(
    f.proposal.task,
    `# Synthetic earlier proposal\nTask: ${f.proposal.id}\nUse only the saved syllabus and common guidance in proposal.json.\n`,
  )
  await writeFile(
    f.proposal.instructions,
    "Synthetic earlier syllabus-only handoff; no assignment sample was captured.\n",
  )
  const handoffs = await Promise.all(
    [f.proposal.task, f.proposal.instructions].map((path) => readFile(path)),
  )
  await f.put(
    "CS101/Assignments/prompt-6.md",
    "---\ntype: assignment\n---\nNew prompt must not enrich an older recipe.",
  )
  const saved = await saveGuidanceProposal(f.root, f.proposal.id, f.candidate)
  expect(saved).toContain("proposed.v1.md")
  const current = JSON.parse(await readFile(f.recordPath, "utf8"))
  expect(current.proposalContextVersion).toBeUndefined()
  expect(current.sources).toEqual(old.sources)
  expect(
    await Promise.all([f.proposal.task, f.proposal.instructions].map((path) => readFile(path))),
  ).toEqual(handoffs)
})

it("uses the versioned selection through the compiled proposal and save CLI", async () => {
  const f = await fixture()
  const config = join(f.container, "config.json")
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      canvas: { baseUrl: "https://canvas.example.invalid", tokenEnv: "UNSET_GUIDANCE_TOKEN" },
      vault: { path: f.root },
      courses: { allowlist: [] },
    }),
  )
  const cli = (args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), ...args, "--config", config, "--json"],
      { cwd: f.container, encoding: "utf8", timeout: 30_000 },
    )
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  }
  const created = cli(["guidance", "propose", "CS101"])
  const record = JSON.parse(
    await readFile(join(f.root, "_meta/guidance-proposals", created.id, "proposal.json"), "utf8"),
  )
  expect(record.sources).toHaveLength(6)
  expect(record.proposalContextVersion).toBe(1)
  expect(cli(["guidance", "save", created.id, "--file", f.candidate]).path).toContain(
    "proposed.v1.md",
  )
})
