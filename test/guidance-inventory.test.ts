import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { readGuidanceProposalRecord } from "../src/guidance.js"
import { listGuidanceProposals, showGuidanceProposal } from "../src/guidance-inventory.js"
import { declaredPrepSections } from "../src/requirements.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")
async function fixture() {
  const setup = spawnSync(
    process.execPath,
    [resolve("scripts/create-guidance-host-acceptance.mjs")],
    { encoding: "utf8", timeout: 30_000 },
  )
  expect(setup.status, setup.stderr).toBe(0)
  const f = JSON.parse(setup.stdout) as { root: string; vault: string; config: string }
  roots.push(f.root)
  const cli = (args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), ...args, "--config", f.config, "--json"],
      {
        cwd: f.root,
        encoding: "utf8",
        timeout: 30_000,
        env: { PATH: process.env.PATH, HOME: join(f.root, "home") },
      },
    )
    expect(result.status, result.stderr).toBe(0)
    return { raw: result.stdout, value: JSON.parse(result.stdout) }
  }
  const list = cli(["guidance", "list", "--course", "ECON902"])
  const id = list.value.proposals[0].id as string
  const path = join(f.vault, "_meta/guidance-proposals", id, "proposal.json")
  return { ...f, cli, list, id, path }
}

it("replays the forward host candidate with private context, metadata discovery, versioned retries and unchanged inputs", async () => {
  const f = await fixture()
  expect(f.list.value).toMatchObject({ inventoryComplete: true, unreadableRecords: 0 })
  expect(f.list.value.proposals).toHaveLength(1)
  expect(f.list.raw).not.toMatch(/Current cached lesson|OLDER_VALUE_SENTINEL|causal claim/)
  const shown = f.cli(["guidance", "show", f.id])
  expect(shown.value).toMatchObject({
    sourceCount: 3,
    guidanceCount: 1,
    privateFeedbackRecordCount: 2,
    savedCandidateCount: 0,
    currentnessChecked: false,
    activationState: "not-verified",
  })
  expect(shown.raw).not.toMatch(/Current cached lesson|OLDER_VALUE_SENTINEL|causal claim/)
  const record = await readGuidanceProposalRecord(f.vault, f.id)
  expect(record.learningHistory?.records.map((row) => row.assignmentId)).toEqual(["60", "50"])
  expect(JSON.stringify(record.learningHistory)).not.toContain("OLDER_VALUE_SENTINEL")
  const text = (
    await readFile(resolve("test/fixtures/host-guidance/candidate.md"), "utf8")
  ).replace("{{TASK_ID}}", f.id)
  expect(declaredPrepSections(text)).toEqual(declaredPrepSections(record.guidance[0]?.text ?? ""))
  const candidate = join(f.root, "candidate.md")
  await writeFile(candidate, text)
  const first = f.cli(["guidance", "save", f.id, "--file", candidate]).value.path
  const before = await readFile(first)
  const second = f.cli(["guidance", "save", f.id, "--file", candidate]).value.path
  expect(second).not.toBe(first)
  expect(await readFile(first)).toEqual(before)
  expect(await readFile(second, "utf8")).toBe(text)
  expect(f.cli(["guidance", "show", f.id]).value.savedCandidateCount).toBe(2)
  const baseline = JSON.parse(await readFile(join(f.root, "baseline.json"), "utf8")) as {
    files: Array<{ path: string; hash: string }>
  }
  const changed: string[] = []
  for (const row of baseline.files)
    if (hash(await readFile(join(f.vault, row.path))) !== row.hash) changed.push(row.path)
  expect(changed).toEqual([`_meta/guidance-proposals/${f.id}/proposal.json`])
  const current = JSON.parse(await readFile(f.path, "utf8"))
  const originalRecordHash = baseline.files.find((row) => row.path.endsWith("/proposal.json"))?.hash
  expect(hash(`${JSON.stringify({ ...current, saved: [] }, null, 2)}\n`)).toBe(originalRecordHash)
})

it("recovers missing handoffs read-only and explicitly does not verify changed live context or cached archives", async () => {
  const f = await fixture(),
    before = await readFile(f.path)
  const first = await showGuidanceProposal(f.vault, f.id)
  if (!first.task) throw new Error("Fixture handoff missing")
  await rename(first.task, join(f.root, "retained-original-TASK.md"))
  await writeFile(
    join(f.vault, "ECON902/Syllabus.md"),
    "Changed live syllabus; old context is retained.",
  )
  const record = await readGuidanceProposalRecord(f.vault, f.id)
  const row = record.learningHistory?.records[0]
  if (!row) throw new Error("Fixture feedback missing")
  await writeFile(
    join(f.vault, "_meta/canvas-feedback/902", row.assignmentId, `${row.dataHash}.json`),
    "INVALID_PRIVATE_ARCHIVE",
  )
  const recovered = f.cli(["guidance", "show", f.id])
  expect(recovered.value.task).toBeNull()
  expect(recovered.value.instructions).not.toBeNull()
  expect(recovered.value.currentnessChecked).toBe(false)
  expect(recovered.value.limitation).toContain("not verified")
  expect((await listGuidanceProposals(f.vault, "ECON902")).proposals[0]?.id).toBe(f.id)
  expect(await readFile(f.path)).toEqual(before)
})

it("reports unknown-course corrupt records as incomplete without body echo or history repair", async () => {
  const f = await fixture(),
    directory = join(f.vault, "_meta/guidance-proposals")
  const bad = join(directory, randomUUID()),
    oversized = join(directory, randomUUID())
  await mkdir(bad)
  await writeFile(join(bad, "proposal.json"), "PRIVATE_BAD_RECORD_SENTINEL")
  await symlink(bad, join(directory, randomUUID()))
  await mkdir(oversized)
  await writeFile(join(oversized, "proposal.json"), "")
  await truncate(join(oversized, "proposal.json"), 2_000_001)
  const list = f.cli(["guidance", "list", "--course", "ECON902"])
  expect(list.value).toMatchObject({ inventoryComplete: false, unreadableRecords: 3 })
  expect(list.value.proposals.map((row: { id: string }) => row.id)).toEqual([f.id])
  expect(list.raw).not.toContain("PRIVATE_BAD_RECORD_SENTINEL")
  expect(await readFile(join(bad, "proposal.json"), "utf8")).toBe("PRIVATE_BAD_RECORD_SENTINEL")
  await expect(showGuidanceProposal(f.vault, "../escape")).rejects.toThrow(/UUID/)
  await expect(listGuidanceProposals(f.vault, "unknown")).rejects.toThrow(/No course/)
})

it("enforces inventory/read bounds and rejects unsafe metadata or handoff links", async () => {
  const f = await fixture(),
    before = await readFile(f.path)
  await expect(readGuidanceProposalRecord(f.vault, f.id, { remaining: 0 })).rejects.toThrow(
    /inventory exceeds/,
  )
  const record = JSON.parse(before.toString())
  record.saved = ["../Guidance/prep-guidance.proposed.v1.md"]
  await writeFile(f.path, JSON.stringify(record))
  await expect(showGuidanceProposal(f.vault, f.id)).rejects.toThrow(/Invalid/)
  await writeFile(f.path, before)
  const shown = await showGuidanceProposal(f.vault, f.id)
  if (!shown.task) throw new Error("Fixture handoff missing")
  const kept = join(f.root, "kept-TASK.md")
  await rename(shown.task, kept)
  await symlink(kept, shown.task)
  await expect(showGuidanceProposal(f.vault, f.id)).rejects.toThrow(/Symbolic/)
  await Promise.all(
    Array.from({ length: 1000 }, () =>
      mkdir(join(f.vault, "_meta/guidance-proposals", randomUUID())),
    ),
  )
  await expect(listGuidanceProposals(f.vault, "ECON902")).rejects.toThrow(/1000 entries/)
  expect(await readFile(f.path)).toEqual(before)
})

it("filters other courses and preserves coherent unflagged records without enrichment", async () => {
  const f = await fixture()
  await mkdir(join(f.vault, "CS202"))
  await writeFile(join(f.vault, "CS202/Syllabus.md"), "OTHER_COURSE_BODY_SENTINEL")
  const other = f.cli(["guidance", "propose", "CS202"]).value.id
  const list = f.cli(["guidance", "list", "--course", "ECON902"])
  expect(list.value.proposals.map((row: { id: string }) => row.id)).toEqual([f.id])
  expect(list.raw).not.toContain(other)
  expect(list.raw).not.toContain("OTHER_COURSE_BODY_SENTINEL")
  const old = JSON.parse(await readFile(f.path, "utf8"))
  delete old.proposalContextVersion
  delete old.proposalFeedbackVersion
  delete old.proposalStructureVersion
  delete old.learningHistory
  old.sources = old.sources.filter((row: { path: string }) => /Syllabus/.test(row.path))
  await writeFile(f.path, JSON.stringify(old))
  const task = join(f.vault, "_meta/guidance-proposals", f.id, "TASK.md")
  await writeFile(
    task,
    `# Earlier syllabus-only guidance handoff\nTask: ${f.id}\nRead only the saved syllabus/common guidance.\n`,
  )
  const before = await Promise.all([f.path, task].map((path) => readFile(path)))
  expect(f.cli(["guidance", "show", f.id]).value.privateFeedbackRecordCount).toBe(0)
  expect((await listGuidanceProposals(f.vault, "ECON902")).inventoryComplete).toBe(true)
  expect(await Promise.all([f.path, task].map((path) => readFile(path)))).toEqual(before)
})
