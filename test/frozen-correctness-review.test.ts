import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  listCorrectnessReviews,
  prepareCorrectnessReview,
  saveCorrectnessReview,
  showCorrectnessReview,
} from "../src/correctness-review.js"
import { captureSimulation } from "../src/simulation.js"
import { calculateSimulationBatch } from "../src/simulation-calculations.js"
import {
  completeSimulationTask,
  createSimulationTask,
  readSimulationTask,
} from "../src/simulation-tasks.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(complete = true) {
  const root = await mkdtemp(join(tmpdir(), "canvas-frozen-correctness-"))
  roots.push(root)
  const vault = join(root, "vault"),
    source = "CS101/Assignments/prompt.md",
    reading = "CS101/Resources/pricing.md"
  await mkdir(join(vault, "CS101/Assignments"), { recursive: true })
  await mkdir(join(vault, "CS101/Resources"))
  await writeFile(
    join(vault, source),
    "---\ntype: assignment\navailable_at: 2026-10-05\n---\nEvaluate incremental contribution using supplied pricing data.",
  )
  await writeFile(
    join(vault, reading),
    "---\navailable_at: 2026-10-05\n---\nPremium uplift 1800, discount loss 300, setup cost 1000. CAPTURED_SOURCE_SENTINEL.",
  )
  const config = join(root, "config.json")
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      canvas: { baseUrl: "https://canvas.example.invalid", tokenEnv: "UNSET_FROZEN_REVIEW_TOKEN" },
      vault: { path: vault },
      courses: { allowlist: [] },
    }),
  )
  const snapshot = await captureSimulation(vault, "CS101", "2026-10-09")
  const task = await createSimulationTask(vault, snapshot.id, {
    kind: "assignment",
    source,
    mode: "draft",
    context: [reading],
  })
  const calculation = await calculateSimulationBatch(vault, task.id, [
    { operation: "sum", values: [1800, -300, -1000], source: reading },
  ])
  const recipe = await readSimulationTask(vault, task.id)
  const candidate = join(root, "draft.md")
  await writeFile(
    candidate,
    [
      `Task: ${task.id}`,
      ...recipe.task.requirements.map(
        (heading) =>
          `## ${heading}\nSynthetic contribution is 500, pending required empirical evidence. \`${reading}\``,
      ),
      ...(recipe.task.deliverable?.items ?? []).map(
        (item) =>
          `### ${item.text}\nPENDING — requires empirical evidence missing from this synthetic fixture. \`${source}\``,
      ),
      "### Synthetic contribution\n| Label | Value |\n| --- | --- |\n| Contribution | 500 |",
    ].join("\n\n"),
  )
  const completion = complete ? await completeSimulationTask(vault, task.id, candidate) : null
  const cli = (args: string[]) =>
    spawnSync(process.execPath, [resolve("dist/cli.js"), ...args, "--config", config, "--json"], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root },
      encoding: "utf8",
      timeout: 30_000,
    })
  return { root, vault, task, source, reading, snapshot, calculation, completion, cli }
}
function note(id: string, reading: string, output: string, workbook?: string) {
  return `Review: ${id}\n\n## Verified\n- The captured inputs sum to contribution 500 in the recorded calculation; source-input grounding remains a reviewer claim, not a toolkit grade. \`${reading}\`\n\n## Needs verification\n- The frozen draft \`${output}\`${workbook ? ` and workbook \`${workbook}\`` : ""} still require permitted academic review; no human verdict or independent reviewer identity was authenticated.\n`
}

it("reviews captured draft/arithmetic after live course removal, supports exact private output citations, and preserves original frozen bytes", async () => {
  const f = await fixture()
  const preserved = [
    join(f.vault, "_meta/simulations", `${f.snapshot.id}.json`),
    join(f.vault, "_meta/simulations/tasks", f.task.id, "record.json"),
    join(f.vault, "_meta/simulations/tasks", f.task.id, "completion.json"),
    join(f.vault, f.completion?.output ?? "missing-output"),
    join(f.vault, f.completion?.workbook?.output ?? "missing-workbook"),
  ]
  const originals = await Promise.all(preserved.map((path) => readFile(path)))
  await writeFile(join(f.vault, f.reading), "LIVE_NEWER_CANARY — never use for frozen review")
  await rename(join(f.vault, "CS101"), join(f.root, "removed-live-course"))
  const prepared = f.cli(["correctness", "prepare", f.task.id, "--frozen"])
  expect(prepared.status, prepared.stderr).toBe(0)
  const review = JSON.parse(prepared.stdout)
  expect(review).toMatchObject({
    version: 2,
    kind: "frozen",
    simulationId: f.snapshot.id,
    frozenHumanVerdict: "pending-human",
    status: "pending",
  })
  const handoff = await readFile(review.handoffPath, "utf8")
  expect(handoff).toContain("CAPTURED_SOURCE_SENTINEL")
  expect(handoff).not.toContain("LIVE_NEWER_CANARY")
  expect(handoff).toContain('"result": 500')
  expect(handoff).toContain(f.completion?.output)
  expect(review.reviewedOutput).toEqual({
    path: f.completion?.output,
    hash: f.completion?.outputHash,
  })
  expect(review.reviewedWorkbook).toEqual({
    path: f.completion?.workbook?.output,
    hash: f.completion?.workbook?.hash,
  })
  expect((await prepareCorrectnessReview(f.vault, f.task.id, { frozen: true })).id).toBe(review.id)
  expect((await listCorrectnessReviews(f.vault, "CS101")).reviews[0]).toMatchObject({
    id: review.id,
    frozen: true,
  })
  const candidate = join(f.root, "review.md")
  await writeFile(
    candidate,
    note(
      review.id,
      f.reading,
      f.completion?.output ?? "missing-output",
      f.completion?.workbook?.output,
    ),
  )
  const saved = f.cli(["correctness", "save", review.id, "--file", candidate])
  expect(saved.status, saved.stderr).toBe(0)
  expect(JSON.parse(saved.stdout)).toMatchObject({
    status: "completed",
    academicCorrectnessVerified: false,
    frozenHumanVerdict: "pending-human",
  })
  expect((await saveCorrectnessReview(f.vault, review.id, candidate)).reviewHash).toBe(
    JSON.parse(saved.stdout).reviewHash,
  )
  expect(await Promise.all(preserved.map((path) => readFile(path)))).toEqual(originals)
})

it("requires explicit frozen scope and completed drafts and refuses changed arithmetic without rewriting older reviews", async () => {
  const pending = await fixture(false)
  await expect(
    prepareCorrectnessReview(pending.vault, pending.task.id, { frozen: true }),
  ).rejects.toThrow(/completed draft/)
  const f = await fixture()
  await expect(prepareCorrectnessReview(f.vault, f.task.id)).rejects.toThrow()
  const review = await prepareCorrectnessReview(f.vault, f.task.id, { frozen: true })
  const handoffBefore = await readFile(review.handoffPath)
  await calculateSimulationBatch(f.vault, f.task.id, [
    { operation: "sum", values: [1, 2], source: f.reading },
  ])
  await expect(showCorrectnessReview(f.vault, review.id)).rejects.toThrow(/evidence changed/)
  const next = await prepareCorrectnessReview(f.vault, f.task.id, { frozen: true })
  expect(next.id).not.toBe(review.id)
  expect(await readFile(review.handoffPath)).toEqual(handoffBefore)
  const arithmeticPath = join(
    f.vault,
    "_meta/simulations/tasks",
    f.task.id,
    "calculations",
    `${f.calculation.id}.json`,
  )
  const arithmetic = JSON.parse(await readFile(arithmeticPath, "utf8"))
  arithmetic.results[0].result = 999
  await writeFile(arithmeticPath, JSON.stringify(arithmetic))
  await expect(showCorrectnessReview(f.vault, next.id)).rejects.toThrow()
})

it("never permits unrelated private citations and fails closed on altered frozen outputs", async () => {
  const f = await fixture()
  const review = await prepareCorrectnessReview(f.vault, f.task.id, { frozen: true })
  const candidate = join(f.root, "review.md")
  await writeFile(
    candidate,
    `${note(review.id, f.reading, f.completion?.output ?? "missing-output")}\nRead \`_meta/tasks/unrelated/task.json\`.\n`,
  )
  await expect(saveCorrectnessReview(f.vault, review.id, candidate)).rejects.toThrow()
  const handoffBefore = await readFile(review.handoffPath)
  await writeFile(
    join(f.vault, f.completion?.output ?? "missing-output"),
    "Changed frozen student output",
  )
  await expect(showCorrectnessReview(f.vault, review.id)).rejects.toThrow(/changed/)
  expect(await readFile(review.handoffPath)).toEqual(handoffBefore)
})

it("replays the retained frozen-host note with no live course folder and preserves the fixture baseline", async () => {
  const built = spawnSync(
    process.execPath,
    [resolve("scripts/create-correctness-host-acceptance.mjs"), "--frozen"],
    { encoding: "utf8", timeout: 30_000 },
  )
  expect(built.status, built.stderr).toBe(0)
  const f = JSON.parse(built.stdout)
  expect(f.root.startsWith(join(tmpdir(), "canvas-host-correctness-frozen-"))).toBe(true)
  roots.push(f.root)
  const vault = join(f.root, "vault")
  const listed = spawnSync(
    process.execPath,
    [
      resolve("dist/cli.js"),
      "simulate",
      "task",
      "list",
      "--course",
      "ECON903",
      "--config",
      f.config,
      "--json",
    ],
    {
      cwd: f.root,
      env: { PATH: process.env.PATH, HOME: join(f.root, "home") },
      encoding: "utf8",
      timeout: 30_000,
    },
  )
  expect(listed.status, listed.stderr).toBe(0)
  const tasks = JSON.parse(listed.stdout).tasks
  expect(tasks).toHaveLength(1)
  const taskId = tasks[0].id
  const review = await prepareCorrectnessReview(vault, taskId, { frozen: true })
  const candidate = join(f.root, "retained-review.md")
  const body = (await readFile(resolve("test/fixtures/host-frozen-correctness/review.md"), "utf8"))
    .replaceAll("{{REVIEW_ID}}", review.id)
    .replaceAll("{{TASK_ID}}", taskId)
  await writeFile(candidate, body)
  const saved = await saveCorrectnessReview(vault, review.id, candidate)
  expect(saved.status).toBe("completed")
  expect(saved.frozenHumanVerdict).toBe("pending-human")
  expect(await readFile(saved.reviewPath ?? "missing-review", "utf8")).toBe(body)
  expect((await saveCorrectnessReview(vault, review.id, candidate)).reviewHash).toBe(
    saved.reviewHash,
  )
  const baseline = JSON.parse(await readFile(join(f.root, "baseline.json"), "utf8"))
  expect(baseline).toHaveLength(8)
  const { createHash } = await import("node:crypto")
  for (const entry of baseline)
    expect(
      createHash("sha256")
        .update(await readFile(join(vault, entry.path)))
        .digest("hex"),
    ).toBe(entry.hash)
  await expect(readFile(join(vault, "ECON903/Materials/pilot.md"))).rejects.toThrow()
})
