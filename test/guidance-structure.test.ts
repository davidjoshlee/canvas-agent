import { spawnSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { proposeGuidance, saveGuidanceProposal } from "../src/guidance.js"
import { inspectWorkspace, selectCourse } from "../src/workspace.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "canvas-guidance-roundtrip-"))
  roots.push(base)
  const vault = join(base, "vault")
  await mkdir(join(vault, "CS101/Guidance"), { recursive: true })
  await mkdir(join(vault, "CS101/Week 03 - Oct 12"))
  await writeFile(
    join(vault, "CS101/Syllabus.md"),
    "Synthetic syllabus: use evidence for class discussion.",
  )
  const reading = "CS101/Week 03 - Oct 12/reading.md"
  await writeFile(
    join(vault, reading),
    "Evidence helps distinguish an assertion from an observation.\n## Preparation questions\n1. Why use evidence?\n",
  )
  await writeFile(
    join(vault, "CS101/Guidance/active.md"),
    "This synthetic fixture explicitly permits AI prep assistance. Preserve this guide.",
  )
  const config = join(base, "config.json")
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      canvas: { baseUrl: "https://canvas.example.invalid", tokenEnv: "UNSET_ROUNDTRIP_TOKEN" },
      vault: { path: vault },
      courses: { allowlist: [] },
    }),
  )
  const context = await inspectWorkspace(vault)
  const proposal = await proposeGuidance(vault, context, selectCourse(context, "CS101"))
  const record = join(vault, "_meta/guidance-proposals", proposal.id, "proposal.json")
  const candidate = join(base, "guidance.md")
  const body = (structure: string) =>
    `# Proposed prep guidance\nSynthesize readings and distinguish evidence from assertions.\n## Sources\n\`CS101/Syllabus.md\`\n${structure}\n`
  const cli = (args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), ...args, "--config", config, "--json"],
      { cwd: base, encoding: "utf8", timeout: 30_000 },
    )
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  }
  return { base, vault, reading, proposal, record, candidate, body, cli }
}

it("rejects missing, empty, Sources-only, duplicate, unsafe and fenced structures without saving or changing records", async () => {
  const f = await fixture(),
    before = await readFile(f.record)
  expect(JSON.parse(before.toString()).proposalStructureVersion).toBe(1)
  expect(await readFile(f.proposal.task, "utf8")).toContain("parses back through the prep parser")
  for (const structure of [
    "",
    "## Brief structure\n",
    "## Brief structure\nSources",
    "## Brief structure\nOverview\n## Prep brief structure\nDiscussion",
    "## Brief structure\nOverview, <script>",
    "```markdown\n## Brief structure\nOverview\n```",
    "## Brief structure\nFollow the expected structure exactly.",
  ]) {
    await writeFile(f.candidate, f.body(structure))
    await expect(saveGuidanceProposal(f.vault, f.proposal.id, f.candidate)).rejects.toThrow()
    expect(await readFile(f.record)).toEqual(before)
    expect(await readdir(join(f.vault, "CS101/Guidance"))).toEqual(["active.md"])
  }
})

it("keeps unflagged proposal save behavior without silently adding the new structural contract", async () => {
  const f = await fixture(),
    old = JSON.parse(await readFile(f.record, "utf8"))
  delete old.proposalStructureVersion
  await writeFile(f.record, JSON.stringify(old))
  await writeFile(f.candidate, f.body(""))
  const saved = await saveGuidanceProposal(f.vault, f.proposal.id, f.candidate)
  expect(await readFile(saved, "utf8")).toBe(f.body(""))
  expect(JSON.parse(await readFile(f.record, "utf8")).proposalStructureVersion).toBeUndefined()
})

it("round-trips saved plain guidance through explicit fixture activation, fresh CLI prep and completion while preserving older work", async () => {
  const f = await fixture()
  await writeFile(
    f.candidate,
    f.body("## Brief structure\nReading synthesis, Discussion preparation\nSources"),
  )
  const prior = f.cli(["prep", "CS101", "--week", "2026-10-12"])
  const priorRecord = join(f.vault, "_meta/tasks", prior.id, "task.json")
  const priorBytes = await readFile(priorRecord)
  const saved = f.cli(["guidance", "save", f.proposal.id, "--file", f.candidate]).path as string
  const inactive = f.cli(["prep", "CS101", "--week", "2026-10-12"])
  const beforeActivation = JSON.parse(
    await readFile(join(f.vault, "_meta/tasks", inactive.id, "task.json"), "utf8"),
  )
  expect(beforeActivation.requirements).toContain("Key concepts")
  // Explicit test-only human activation; the CLI never performs this copy.
  await copyFile(saved, join(f.vault, "CS101/Guidance/prep-guidance.md"))
  const current = f.cli(["prep", "CS101", "--week", "2026-10-12"])
  const task = JSON.parse(
    await readFile(join(f.vault, "_meta/tasks", current.id, "task.json"), "utf8"),
  )
  expect(task.prepStructureVersion).toBe(1)
  expect(task.requirements).toEqual(["Reading synthesis", "Discussion preparation", "Sources"])
  expect(task.questions).toEqual(["Why use evidence?"])
  expect(task.course.code).toBe("CS101")
  expect(task.period.value).toBe("2026-10-12")
  const prep = join(f.base, "prep.md")
  await writeFile(
    prep,
    `Task: ${task.id}\n## Reading synthesis\nThe reading distinguishes assertions from observations using evidence.\n## Discussion preparation\n### Why use evidence?\nEvidence helps distinguish an assertion from an observation, clarifying which statements are supported and which need further investigation. See \`${f.reading}\`.\n## Sources\n\`${f.reading}\`\n`,
  )
  f.cli(["task", "complete", task.id, "--file", prep])
  const inspection = f.cli(["inspect", task.id])
  expect(JSON.stringify(inspection)).toContain("completed")
  expect(await readFile(priorRecord)).toEqual(priorBytes)
  expect(await readFile(saved, "utf8")).toBe(
    f.body("## Brief structure\nReading synthesis, Discussion preparation\nSources"),
  )
  expect(await readFile(join(f.vault, "CS101/Guidance/active.md"), "utf8")).toContain(
    "Preserve this guide",
  )
})
