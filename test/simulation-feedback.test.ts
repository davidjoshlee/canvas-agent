import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  feedbackDirectory,
  feedbackHash,
  feedbackSnapshot,
  normalizeOwnFeedback,
} from "../src/canvas-feedback.js"
import { createConfig } from "../src/config.js"
import { comparisonM1Bundle } from "../src/m1.js"
import { captureSimulation } from "../src/simulation.js"
import {
  compareSimulationEvaluations,
  readSimulationComparison,
} from "../src/simulation-comparison.js"
import {
  completeSimulationTask,
  createSimulationTask,
  readSimulationTask,
} from "../src/simulation-tasks.js"
import { createSimulationWindow } from "../src/simulation-window.js"

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-review-feedback-"))
  roots.push(root)
  const vault = join(root, "vault"),
    config = join(root, "config.json")
  await createConfig(config, { vault, baseUrl: "https://canvas.example.test" })
  await mkdir(join(vault, "CS101"), { recursive: true })
  await mkdir(join(vault, "CS101/Week 01 - Oct 5"))
  await writeFile(
    join(vault, "CS101/Week 01 - Oct 5/reading.md"),
    "---\navailable_at: 2026-10-05\n---\nSynthetic framework reading supplies evidence and practical applications for class preparation.",
  )
  await writeFile(
    join(vault, "CS101/00 Home.md"),
    "---\ncanvas_url: https://canvas.example.test/courses/1\navailable_at: 2026-10-01\n---\n# Synthetic course\n",
  )
  const sources = ["50", "60"].map((id) => `CS101/Assignments/Case${id}/prompt.md`)
  for (const [index, path] of sources.entries()) {
    await mkdir(join(vault, path, ".."), { recursive: true })
    await writeFile(
      join(vault, path),
      `---\ntype: assignment\ncanvas_id: "${index ? "60" : "50"}"\navailable_at: 2026-10-05\n---\n# Synthetic case\nExplain the supplied synthetic framework using evidence.`,
    )
  }
  const cache = async (id: string, score: number, comment: string) => {
    const data = normalizeOwnFeedback(
      {
        assignment_id: Number(id),
        score,
        rubric_assessment: { evidence_quality: { points: 0, comments: comment } },
        body: "PRIVATE_SUBMITTED_BODY",
      },
      "1",
      id,
    )
    const hash = feedbackHash(data),
      directory = feedbackDirectory(vault, "1", id)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const archive = join(directory, `${hash}.json`)
    await writeFile(archive, JSON.stringify(data), { mode: 0o600 })
    await writeFile(join(directory, "current.json"), JSON.stringify(feedbackSnapshot(data)), {
      mode: 0o600,
    })
    return { hash, archive }
  }
  const feedback = await cache("50", 0, "PRIVATE_REVIEW_FEEDBACK")
  await cache("60", 88, "PRIVATE_UNSELECTED_FEEDBACK")
  const capture = await captureSimulation(vault, "CS101", "2026-10-09")
  const ids: string[] = []
  for (const path of sources) {
    const task = await createSimulationTask(vault, capture.id, {
      kind: "assignment",
      source: path,
      mode: "draft",
    })
    const record = await readSimulationTask(vault, task.id),
      candidate = join(root, "candidate.md")
    await writeFile(
      candidate,
      [
        `Task: ${task.id}`,
        ...record.task.requirements.map(
          (heading) =>
            `## ${heading}\n\n${heading === "Sources" ? record.task.sources.map((source) => `\`${source.path}\``).join("\n") : "Synthetic evidence quality analysis; structural fixture only."}`,
        ),
      ].join("\n\n"),
    )
    await completeSimulationTask(vault, task.id, candidate)
    ids.push(task.id)
  }
  return { root, vault, config, ids, feedback, cache, capture }
}
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

it("captures explicitly selected feedback for the matching assignment only, preserves frozen generation, and binds retained archives through M1", async () => {
  const f = await fixture()
  const generation = await Promise.all(
    f.ids.map(async (id) => JSON.stringify((await readSimulationTask(f.vault, id)).task)),
  )
  expect(generation.join(" ")).not.toContain("PRIVATE_REVIEW_FEEDBACK")
  const comparison = await compareSimulationEvaluations(f.vault, "CS101", f.ids, [], ["50"])
  expect(comparison.feedbackReferences).toBe(1)
  const record = await readSimulationComparison(f.vault, "CS101", comparison.id)
  expect(record.rubricEvidenceVersion).toBe(1)
  expect(record.feedbackReferences?.[0]).toMatchObject({
    assignmentId: "50",
    data: { score: 0 },
    currentGradeVerified: false,
    authorshipVerified: false,
    accountSubjectVerified: false,
  })
  expect(record.artifacts.map((artifact) => artifact.rubric.length)).toEqual([1, 0])
  expect(record.artifacts[0]?.rubric[0]).toMatchObject({
    criterion: "evidence_quality",
    literalMention: true,
    humanCoverage: "unscored",
  })
  expect(record.comparison).toContain("PRIVATE_REVIEW_FEEDBACK")
  expect(record.comparison).not.toMatch(/PRIVATE_UNSELECTED_FEEDBACK|PRIVATE_SUBMITTED_BODY/)
  await f.cache("50", 100, "PRIVATE_NEW_FEEDBACK")
  expect(
    (await readSimulationComparison(f.vault, "CS101", comparison.id)).feedbackReferences?.[0]?.data
      .score,
  ).toBe(0)
  const gate = await comparisonM1Bundle(f.vault, "CS101", comparison.id)
  expect(await readFile(join(f.vault, gate.path), "utf8")).toContain("PRIVATE_REVIEW_FEEDBACK")
  expect(
    await Promise.all(
      f.ids.map(async (id) => JSON.stringify((await readSimulationTask(f.vault, id)).task)),
    ),
  ).toEqual(generation)
  const before = await readdir(join(f.vault, "_meta/gates/m1"))
  await writeFile(f.feedback.archive, "PRIVATE_TAMPERED_ARCHIVE")
  await expect(comparisonM1Bundle(f.vault, "CS101", comparison.id)).rejects.toThrow()
  expect(await readdir(join(f.vault, "_meta/gates/m1"))).toEqual(before)
})

it("rejects unmatched, missing, duplicate and unsafe feedback assignment scopes before writing comparison bundles", async () => {
  const f = await fixture(),
    first = f.ids[0]
  if (!first) throw new Error("Synthetic task missing")
  for (const ids of [["60"], ["999"], ["50", "50"], ["../50"]])
    await expect(compareSimulationEvaluations(f.vault, "CS101", [first], [], ids)).rejects.toThrow()
  await expect(readdir(join(f.vault, "_meta/simulation-comparisons"))).rejects.toThrow()
})

it("recomputes rubric indicators even after evidence is rehashed and keeps older uncaptured feedback comparisons readable", async () => {
  const f = await fixture(),
    task = f.ids[0]
  if (!task) throw new Error("Synthetic task missing")
  const comparison = await compareSimulationEvaluations(f.vault, "CS101", [task], [], ["50"])
  const directory = join(f.vault, "_meta/simulation-comparisons", comparison.id)
  const rewrite = async (value: unknown) => {
    const text = JSON.stringify(value)
    await writeFile(join(directory, "evidence.json"), text)
    await writeFile(
      join(directory, "integrity.json"),
      JSON.stringify({
        version: 1,
        id: comparison.id,
        evidenceHash: createHash("sha256").update(text).digest("hex"),
      }),
    )
  }
  const evidence = JSON.parse(await readFile(join(directory, "evidence.json"), "utf8"))
  evidence.artifacts[0].rubric[0].literalMention = false
  await rewrite(evidence)
  await expect(readSimulationComparison(f.vault, "CS101", comparison.id)).rejects.toThrow(
    /rubric indicators differ/,
  )
  const legacy = await compareSimulationEvaluations(f.vault, "CS101", [task])
  const path = join(f.vault, "_meta/simulation-comparisons", legacy.id, "evidence.json")
  const old = JSON.parse(await readFile(path, "utf8"))
  delete old.rubricEvidenceVersion
  delete old.feedbackReferences
  const bytes = JSON.stringify(old)
  await writeFile(path, bytes)
  await writeFile(
    join(f.vault, "_meta/simulation-comparisons", legacy.id, "integrity.json"),
    JSON.stringify({
      version: 1,
      id: legacy.id,
      evidenceHash: createHash("sha256").update(bytes).digest("hex"),
    }),
  )
  expect(
    (await readSimulationComparison(f.vault, "CS101", legacy.id)).feedbackReferences,
  ).toBeUndefined()
  await comparisonM1Bundle(f.vault, "CS101", legacy.id)
  expect(await readFile(path, "utf8")).toBe(bytes)
})

it("runs explicit private feedback comparison and M1 through the compiled CLI without exposing feedback in JSON", async () => {
  const f = await fixture(),
    task = f.ids[0]
  if (!task) throw new Error("Synthetic task missing")
  const run = (args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), ...args, "--config", f.config, "--json"],
      { encoding: "utf8" },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toMatch(/PRIVATE_REVIEW_FEEDBACK|PRIVATE_SUBMITTED_BODY/)
    return JSON.parse(result.stdout)
  }
  const comparison = run([
    "simulate",
    "compare",
    "--course",
    "CS101",
    "--task",
    task,
    "--feedback-assignment",
    "50",
  ])
  expect(comparison.feedbackReferences).toBe(1)
  const gate = run(["gate", "m1", "--comparison", comparison.id, "--course", "CS101"])
  expect(await readFile(join(f.vault, gate.path), "utf8")).toContain("PRIVATE_REVIEW_FEEDBACK")
})

it("wires review-only feedback into compiled whole-window comparison without applying assignment criteria to prep", async () => {
  const f = await fixture()
  const window = await createSimulationWindow(
    f.vault,
    f.capture.id,
    "CS101",
    "2026-10-09..2026-10-09",
  )
  for (const row of window.weeks)
    for (const handoff of row.tasks) {
      if (!handoff.id || handoff.failure) throw new Error("Synthetic window handoff unavailable")
      const record = await readSimulationTask(f.vault, handoff.id),
        candidate = join(f.root, "window-candidate.md")
      await writeFile(
        candidate,
        [
          `Task: ${handoff.id}`,
          ...record.task.requirements.map(
            (heading) =>
              `## ${heading}\n\n${heading === "Sources" ? record.task.sources.map((source) => `\`${source.path}\``).join("\n") : "Synthetic evidence quality fixture, not academic generation."}`,
          ),
        ].join("\n\n"),
      )
      await completeSimulationTask(f.vault, handoff.id, candidate)
    }
  const result = spawnSync(
    process.execPath,
    [
      resolve("dist/cli.js"),
      "simulate",
      "window",
      "compare",
      window.id,
      "--course",
      "CS101",
      "--feedback-assignment",
      "50",
      "--config",
      f.config,
      "--json",
    ],
    { encoding: "utf8" },
  )
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).not.toContain("PRIVATE_REVIEW_FEEDBACK")
  const record = await readSimulationComparison(f.vault, "CS101", JSON.parse(result.stdout).id)
  expect(record.feedbackReferences).toHaveLength(1)
  expect(record.artifacts.find((artifact) => artifact.kind === "prep")?.rubric).toEqual([])
  expect(record.artifacts.filter((artifact) => artifact.rubric.length)).toHaveLength(1)
})
