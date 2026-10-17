import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { expect, it } from "vitest"
import type { TaskRecord } from "../../src/shared/types.js"
import { harnessCalculationsFromFile } from "../helpers/harness-calculations.js"

// Retain original host artifacts unchanged. New parser-v2 tasks require literal
// question headings; this adaptation only reorganizes the retained answers and
// adds the already verified baseline sentence/citation, not a new model run.
function withDetectedHeadings(template: string, task: TaskRecord, custom = false): string {
  expect(task.deliverableParserVersion).toBe(3)
  if (!task.deliverable || task.deliverable.kind === "none")
    throw new Error("Pricing prompt checklist was not detected")
  expect(task.deliverable.items).toHaveLength(3)
  const [baseline, incremental, recommendation] = task.deliverable.items
  if (!baseline || !incremental || !recommendation) throw new Error("Incomplete pricing checklist")
  if (custom)
    return template
      .replace("## Recommendation\n\n", `## Recommendation\n\n### ${recommendation.text}\n\n`)
      .replace(
        "## Computations\n\n",
        `## Computations\n\n### ${baseline.text}\n\nBaseline contribution is 500 × 40 = 20000, verified by the executed multiplication using the prompt's scenario inputs. \`ECON101/Assignments/pricing.md\`\n\n### ${incremental.text}\n\n`,
      )
  return template
    .replace(
      "### Baseline and incremental contribution\n\nBaseline contribution is 500 bookings × $40 = $20,000. The premium uplift is",
      `### ${baseline.text}\n\nBaseline contribution is 500 bookings × $40 = $20,000, verified by the executed multiplication. \`ECON101/Assignments/pricing.md\`\n\n### ${incremental.text}\n\nThe premium uplift is`,
    )
    .replace("### Recommendation and experimental decision rule", `### ${recommendation.text}`)
}

// Captured primary-host acceptance artifacts, not a new model invocation or an
// independent semantic grade. Keep these distinct from scaffolding-only tests.
it("replays the host-authored v3 synthesis and finished pricing deliverable through the compiled CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvas-host-v3-"))
  const fixtures = resolve("test/fixtures/host-v3")
  const binary = resolve("dist/cli.js")
  const config = join(root, "config.json")
  const vault = join(root, "vault")
  const cli = <T>(args: string[]): T => {
    const result = spawnSync(process.execPath, [binary, ...args, "--config", config, "--json"], {
      cwd: root,
      encoding: "utf8",
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toBe("")
    return JSON.parse(result.stdout) as T
  }
  const prompt = "ECON101/Assignments/pricing.md"
  const reading1 = "ECON101/Week 03 - Oct 12/marginal-analysis.md"
  const reading2 = "ECON101/Week 03 - Oct 12/experiment-design.md"
  const session = "ECON101/Week 03 - Oct 12/session.md"
  const guidance = "ECON101/guidance/prep-guidance.md"
  const originals = new Map<string, Buffer>()
  try {
    cli(["setup", "--canvas-url", "https://canvas.example.test", "--vault", vault])
    for (const path of [prompt, reading1, reading2, session, guidance]) {
      const bytes = await readFile(join(fixtures, "vault", path))
      originals.set(path, bytes)
      await mkdir(dirname(join(vault, path)), { recursive: true })
      await writeFile(join(vault, path), bytes)
    }
    const prep = cli<{ id: string; sources: string[]; guidance: string[] }>([
      "prep",
      "ECON101",
      "--week",
      "2026-10-12",
    ])
    const draft = cli<{ id: string; sources: string[]; guidance: string[] }>([
      "assignment",
      "ECON101",
      "--source",
      prompt,
      "--mode",
      "draft",
      "--context",
      reading1,
      "--context",
      reading2,
    ])
    expect(prep.sources).toEqual(expect.arrayContaining([reading1, reading2, session]))
    expect(draft.sources).toEqual([prompt, reading1, reading2])
    for (const task of [prep, draft]) {
      expect(task.guidance).toEqual([guidance])
      const handoff = cli<{ workflow: { version: number }; guidance: { text: string }[] }>([
        "task",
        "show",
        task.id,
      ])
      expect(handoff.workflow.version).toBe(3)
      expect(handoff.guidance[0]?.text).toContain("explicitly permitted")
    }
    const calculations = harnessCalculationsFromFile(join(fixtures, "calculations.json"))
    expect(calculations.map((record) => record.result)).toEqual([20000, 1800, 300, 500, 20500])
    expect(calculations.every((record) => record.source.path === prompt)).toBe(true)
    for (const [name, task] of [
      ["prep", prep],
      ["draft", draft],
    ] as const) {
      const candidate = join(root, `${name}.md`)
      const original = await readFile(join(fixtures, `${name}-candidate.md`), "utf8")
      const template =
        name === "draft"
          ? withDetectedHeadings(original, cli<TaskRecord>(["task", "show", task.id]))
          : original
      await writeFile(candidate, template.replace("{{TASK_ID}}", task.id))
      const completed = cli<{ output: string; task: { workbook?: { path: string } } }>([
        "task",
        "complete",
        task.id,
        "--file",
        candidate,
      ])
      expect(await readFile(join(vault, completed.output), "utf8")).toBe(
        template.replace("{{TASK_ID}}", task.id),
      )
      const inspected = cli<{
        snapshots: { current: boolean; changed: string[]; missing: string[] }
      }>(["inspect", task.id])
      expect(inspected.snapshots).toEqual({ current: true, changed: [], missing: [] })
      expect(completed.task.workbook).toBeUndefined()
    }
    for (const [path, bytes] of originals) expect(await readFile(join(vault, path))).toEqual(bytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("replays the host-authored course-guidance proposal without activating it or changing supplied policies", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvas-host-guidance-"))
  const fixtures = resolve("test/fixtures/host-v3")
  const binary = resolve("dist/cli.js")
  const vault = join(root, "vault")
  const config = join(root, "config.json")
  const cli = <T>(args: string[]): T => {
    const result = spawnSync(process.execPath, [binary, ...args, "--config", config, "--json"], {
      cwd: root,
      encoding: "utf8",
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toBe("")
    return JSON.parse(result.stdout) as T
  }
  const syllabus = "ECON101/Syllabus.md"
  const guidance = "ECON101/guidance/prep-guidance.md"
  const unrelated = "ECON101/guidance/assignment-60.md"
  const originals = new Map<string, Buffer>()
  try {
    cli(["setup", "--canvas-url", "https://canvas.example.test", "--vault", vault])
    for (const path of [syllabus, guidance]) {
      const bytes = await readFile(join(fixtures, "vault", path))
      originals.set(path, bytes)
      await mkdir(dirname(join(vault, path)), { recursive: true })
      await writeFile(join(vault, path), bytes)
    }
    const restricted =
      "---\ntype: guidance\ncanvas_id: '60'\nai_policy: prohibited\n---\nUNRELATED_ASSIGNMENT_GUIDANCE_SENTINEL\n"
    await writeFile(join(vault, unrelated), restricted)
    const proposal = cli<{ id: string; task: string }>(["guidance", "propose", "ECON101"])
    const recordPath = join(vault, "_meta/guidance-proposals", proposal.id, "proposal.json")
    const record = JSON.parse(await readFile(recordPath, "utf8"))
    expect(record.guidanceSelectionVersion).toBe(1)
    expect(record.sources.map((source: { path: string }) => source.path)).toEqual([syllabus])
    expect(record.guidance.map((source: { path: string }) => source.path)).toEqual([guidance])
    expect(JSON.stringify(record)).not.toContain("UNRELATED_ASSIGNMENT_GUIDANCE_SENTINEL")
    expect(await readFile(proposal.task, "utf8")).toContain(
      "Do not edit or replace active guidance",
    )
    const candidate = join(root, "guidance-candidate.md")
    const text = await readFile(join(fixtures, "guidance-candidate.md"), "utf8")
    await writeFile(candidate, text)
    const first = cli<{ path: string }>(["guidance", "save", proposal.id, "--file", candidate])
    const second = cli<{ path: string }>(["guidance", "save", proposal.id, "--file", candidate])
    expect(first.path).toMatch(/prep-guidance\.proposed\.v1\.md$/)
    expect(second.path).toMatch(/prep-guidance\.proposed\.v2\.md$/)
    expect(await readFile(first.path, "utf8")).toBe(text)
    expect(await readFile(second.path, "utf8")).toBe(text)
    const context = cli<{
      courses: Array<{ guidance: string[]; excluded: Array<{ path: string; reason: string }> }>
    }>(["context"])
    expect(context.courses[0]?.guidance).toEqual([guidance])
    expect(
      context.courses[0]?.excluded.filter((entry) => /proposed\.v[12]\.md$/.test(entry.path)),
    ).toHaveLength(2)
    expect(
      context.courses[0]?.excluded
        .filter((entry) => /proposed/.test(entry.path))
        .every((entry) => /not active/.test(entry.reason)),
    ).toBe(true)
    expect(JSON.parse(await readFile(recordPath, "utf8")).saved).toHaveLength(2)
    for (const [path, bytes] of originals) expect(await readFile(join(vault, path))).toEqual(bytes)
    expect(await readFile(join(vault, unrelated), "utf8")).toBe(restricted)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("replays first-use custom guidance and host work across separate CLI processes without changing originals", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvas-host-custom-"))
  const fixtures = resolve("test/fixtures/host-v3")
  const binary = resolve("dist/cli.js")
  const vault = join(root, "vault")
  const config = join(root, "config.json")
  const cli = <T>(args: string[]): T => {
    const result = spawnSync(process.execPath, [binary, ...args, "--config", config, "--json"], {
      cwd: root,
      encoding: "utf8",
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toBe("")
    return JSON.parse(result.stdout) as T
  }
  const prompt = "ECON101/Assignments/pricing.md"
  const readings = [
    "ECON101/Week 03 - Oct 12/marginal-analysis.md",
    "ECON101/Week 03 - Oct 12/experiment-design.md",
  ]
  const originals = new Map<string, Buffer>()
  try {
    cli(["setup", "--canvas-url", "https://canvas.example.test", "--vault", vault])
    for (const path of [prompt, ...readings, "ECON101/guidance/prep-guidance.md"]) {
      const bytes = await readFile(join(fixtures, "vault", path))
      originals.set(path, bytes)
      await mkdir(dirname(join(vault, path)), { recursive: true })
      await writeFile(join(vault, path), bytes)
    }
    const starter = cli<{ created: boolean; paths: string[]; aiPermissionVerified: boolean }>([
      "guidance",
      "init-assignment",
      "ECON101",
      "--source",
      prompt,
    ])
    expect(starter.created).toBe(true)
    expect(starter.aiPermissionVerified).toBe(false)
    const guide = starter.paths[0]
    const starterText = await readFile(join(vault, guide), "utf8")
    const guideText = starterText
      .replace(
        "Add your own goals, constraints and preferred voice here. Unspecified preferences remain unknown; the agent must not invent them.",
        "Synthetic student preference: keep the recommendation conditional and concise. Separate scenario arithmetic from empirical evidence; do not claim a successful pilot.",
      )
      .replace(
        /## Optional output format[\s\S]*$/,
        "## Brief structure\n\n1. Recommendation\n2. Computations\n3. Limitations\n4. Sources\n",
      )
    await writeFile(join(vault, guide), guideText)
    const unrelated = "ECON101/guidance/assignment-60.md"
    const restricted =
      "---\ntype: guidance\ncanvas_id: '60'\nai_policy: prohibited\n---\nUNRELATED_RESTRICTED_GUIDANCE_BODY\n"
    await writeFile(join(vault, unrelated), restricted)
    const retry = cli<{ created: boolean; paths: string[] }>([
      "guidance",
      "init-assignment",
      "ECON101",
      "--source",
      prompt,
    ])
    expect(retry.created).toBe(false)
    expect(await readFile(join(vault, guide), "utf8")).toBe(guideText)
    const task = cli<{ id: string }>([
      "assignment",
      "ECON101",
      "--source",
      prompt,
      "--mode",
      "draft",
      ...readings.flatMap((path) => ["--context", path]),
    ])
    const handoff = cli<TaskRecord>(["task", "show", task.id])
    expect(handoff.guidanceSelectionVersion).toBe(1)
    expect(handoff.assignmentStructureVersion).toBe(1)
    expect(handoff.requirements).toEqual([
      "Recommendation",
      "Computations",
      "Limitations",
      "Sources",
    ])
    expect(handoff.sources.map((source) => source.path)).toEqual([prompt, ...readings])
    expect(handoff.guidance.some((source) => source.canvasId === "50")).toBe(true)
    expect(JSON.stringify(handoff)).not.toContain("UNRELATED_RESTRICTED_GUIDANCE_BODY")
    expect(
      harnessCalculationsFromFile(join(fixtures, "calculations.json")).map((entry) => entry.result),
    ).toEqual([20000, 1800, 300, 500, 20500])
    const candidate = join(root, "custom-candidate.md")
    const text = withDetectedHeadings(
      await readFile(join(fixtures, "custom-candidate.md"), "utf8"),
      handoff,
      true,
    ).replace("{{TASK_ID}}", task.id)
    await writeFile(candidate, text)
    const completed = cli<{ output: string; task: { workbook: { path: string } } }>([
      "task",
      "complete",
      task.id,
      "--file",
      candidate,
    ])
    const output = await readFile(join(vault, completed.output))
    expect(completed.task.workbook).toBeUndefined()
    const recordPath = join(vault, "_meta/tasks", task.id, "task.json")
    const record = await readFile(recordPath)
    // Each cli() starts a fresh process; recovery comes from the saved recipe/output,
    // not a surviving worker. This is not a test of the product's /goal controller.
    expect(cli<TaskRecord>(["task", "show", task.id]).status).toBe("completed")
    cli(["task", "complete", task.id, "--file", candidate])
    expect(await readFile(recordPath)).toEqual(record)
    expect(await readFile(join(vault, completed.output))).toEqual(output)
    expect(output.toString("utf8")).toBe(text)
    expect(cli<{ snapshots: { current: boolean } }>(["inspect", task.id]).snapshots.current).toBe(
      true,
    )
    for (const [path, bytes] of originals) expect(await readFile(join(vault, path))).toEqual(bytes)
    expect(await readFile(join(vault, guide), "utf8")).toBe(guideText)
    expect(await readFile(join(vault, unrelated), "utf8")).toBe(restricted)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
