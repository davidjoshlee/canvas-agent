import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { calculateSimulationBatch } from "../../src/evaluation/calculations.js"
import { captureSimulation } from "../../src/evaluation/captures.js"
import { createSimulationTask } from "../../src/evaluation/tasks.js"
import {
  checkFrozenTaskNumbers,
  checkTaskNumbers,
  numericPresenceReview,
} from "../../src/tasks/numeric-review.js"
import { createPrepTask } from "../../src/tasks/store.js"
import { calculateBatchTask } from "../../src/tasks/tools.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-numeric-review-"))
  roots.push(root)
  const vault = join(root, "vault")
  for (const [name, path] of [
    ["prompt.md", "ECON901/Assignments/launch.md"],
    ["case.md", "ECON901/Week 02 - Oct 12/launch-case.md"],
    ["marginal-analysis.md", "ECON901/Week 02 - Oct 12/marginal-analysis.md"],
    ["course-guidance.md", "ECON901/Guidance/course-guidance.md"],
  ]) {
    const destination = join(vault, path ?? "")
    await mkdir(join(destination, ".."), { recursive: true })
    await writeFile(destination, await readFile(resolve("test/fixtures/host-numeric", name ?? "")))
  }
  const config = {
    version: 1 as const,
    canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "UNSET_NUMERIC_REVIEW_TOKEN" },
    vault: { path: vault },
    courses: { allowlist: [] },
  }
  const configPath = join(root, "config.json")
  await writeFile(configPath, JSON.stringify(config))
  const task = await createPrepTask(vault, "ECON901", "2026-10-12")
  const batch = JSON.parse(
    await readFile(resolve("test/fixtures/host-recovery/ordinary-calculations.json"), "utf8"),
  )
  await calculateBatchTask(config, task.id, batch.operations)
  const file = join(root, "candidate.md")
  await writeFile(
    file,
    (await readFile(resolve("test/fixtures/host-recovery/ordinary-candidate.md"), "utf8")).replace(
      "{{TASK_ID}}",
      task.id,
    ),
  )
  const cli = (args: string[]) =>
    spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), ...args, "--config", configPath, "--json"],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    )
  return { root, vault, config, task, file, batch, cli }
}

it("flags the retained prose comparison without rewriting candidate, recipe or log", async () => {
  const f = await fixture()
  const paths = [
    f.file,
    join(f.vault, "_meta/tasks", f.task.id, "calculations.jsonl"),
    join(f.vault, "_meta/tasks", f.task.id, "task.json"),
  ]
  const before = await Promise.all(paths.map((path) => readFile(path)))
  const report = await checkTaskNumbers(f.vault, f.task.id, f.file)
  expect(report).toMatchObject({
    recomputedOperations: 4,
    needsReview: true,
    numericCorrectnessVerified: false,
    executionAuthenticated: false,
  })
  expect(report.flagged.map((finding) => finding.value)).toEqual([200])
  expect(report.flagged[0]?.lines).toEqual([11, 21, 42])
  expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before)
  const cli = f.cli(["check-numbers", f.task.id, "--file", f.file])
  expect(cli.status, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).flagged.map((finding: { value: number }) => finding.value)).toEqual(
    [200],
  )
  expect(cli.stdout).not.toContain("Unit contribution")
  await calculateBatchTask(f.config, f.task.id, [
    { operation: "subtract", values: [600, 400], source: f.task.sources[0]?.path },
  ])
  expect(await checkTaskNumbers(f.vault, f.task.id, f.file)).toMatchObject({
    flagged: [],
    needsReview: false,
    numericCorrectnessVerified: false,
  })
})

it("binds frozen arithmetic without using edited live sources and rejects changed results", async () => {
  const f = await fixture()
  const capture = await captureSimulation(f.vault, "ECON901", "2026-10-13")
  const task = await createSimulationTask(f.vault, capture.id, { kind: "prep", week: "2026-10-12" })
  const evidence = await calculateSimulationBatch(f.vault, task.id, f.batch.operations)
  const file = join(f.root, "frozen.md")
  await writeFile(
    file,
    (await readFile(resolve("test/fixtures/host-recovery/frozen-candidate.md"), "utf8")).replace(
      "{{TASK_ID}}",
      task.id,
    ),
  )
  await writeFile(join(f.vault, "ECON901/Week 02 - Oct 12/launch-case.md"), "NEW_LIVE_VALUE 200")
  expect(
    (await checkFrozenTaskNumbers(f.vault, task.id, file)).flagged.map((finding) => finding.value),
  ).toEqual([200])
  const cli = f.cli(["simulate", "task", "check-numbers", task.id, "--file", file])
  expect(cli.status, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).flagged.map((finding: { value: number }) => finding.value)).toEqual(
    [200],
  )
  const path = join(
    f.vault,
    "_meta/simulations/tasks",
    task.id,
    "calculations",
    `${evidence.id}.json`,
  )
  const changed = JSON.parse(await readFile(path, "utf8"))
  changed.results[0].result = 999
  await writeFile(path, JSON.stringify(changed))
  await expect(checkFrozenTaskNumbers(f.vault, task.id, file)).rejects.toThrow(
    "differs from executed arithmetic",
  )
})

it("rejects ordinary tampering and unsafe inputs without echo or repair", async () => {
  const f = await fixture()
  const log = join(f.vault, "_meta/tasks", f.task.id, "calculations.jsonl")
  const original = await readFile(log, "utf8")
  const records = original
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  records[0].result = 999
  await writeFile(log, records.map((record) => JSON.stringify(record)).join("\n"))
  await expect(checkTaskNumbers(f.vault, f.task.id, f.file)).rejects.toThrow(
    "differs from bounded arithmetic",
  )
  records[0].result = 20
  records[0].source.hash = "0".repeat(64)
  await writeFile(log, records.map((record) => JSON.stringify(record)).join("\n"))
  await expect(checkTaskNumbers(f.vault, f.task.id, f.file)).rejects.toThrow("source differs")
  await writeFile(log, "PRIVATE_NUMERIC_RECORD_SENTINEL")
  await expect(checkTaskNumbers(f.vault, f.task.id, f.file)).rejects.toThrow(
    "Invalid private calculation record",
  )
  expect(await readFile(log, "utf8")).toBe("PRIVATE_NUMERIC_RECORD_SENTINEL")
  await writeFile(log, original)
  const linked = join(f.root, "linked.md")
  await symlink(f.file, linked)
  await expect(checkTaskNumbers(f.vault, f.task.id, linked)).rejects.toThrow("Symbolic links")
  await expect(checkTaskNumbers(f.vault, f.task.id, join(f.root, ".env"))).rejects.toThrow(
    "credential file",
  )
  const oversized = join(f.root, "oversized.md")
  await writeFile(oversized, "")
  await truncate(oversized, 5 * 1024 * 1024 + 1)
  await expect(checkTaskNumbers(f.vault, f.task.id, oversized)).rejects.toThrow(
    "regular-file bounds",
  )
})

it("labels source coincidences, input-only values and percentages without correctness claims", async () => {
  const f = await fixture()
  const report = numericPresenceReview(
    f.task,
    "An unrelated claim: 50. An input: 777. A percentage: 10%.",
    [{ input: [777], result: 888 }],
  )
  expect(report.observedNumbers.find((entry) => entry.value === 50)?.classification).toBe(
    "source-literal",
  )
  expect(report.observedNumbers.find((entry) => entry.value === 777)?.classification).toBe(
    "input-only",
  )
  expect(report.observedNumbers.find((entry) => entry.value === 0.1)?.classification).toBe(
    "unmatched",
  )
  expect(report.numericCorrectnessVerified).toBe(false)
  expect(report.limitation).toContain("unrelated claims")
})

it("bounds reference count, path bytes and source text before document masking", async () => {
  const f = await fixture()
  expect(() =>
    numericPresenceReview(
      f.task,
      "approximately 0.5",
      Array.from({ length: 10001 }, () => ({ input: [1, 2], result: 0.5 })),
    ),
  ).toThrow("arithmetic inventory exceeds")
  const source = f.task.sources[0]
  if (!source) throw new Error("Expected selected source")
  expect(() =>
    numericPresenceReview(
      { ...f.task, guidance: [], sources: Array.from({ length: 1001 }, () => source) },
      "200",
      [],
    ),
  ).toThrow("1000 source references")
  expect(() =>
    numericPresenceReview(
      {
        ...f.task,
        guidance: [],
        sources: [{ ...source, path: "x".repeat(1024 * 1024 + 1), text: "" }],
      },
      "200",
      [],
    ),
  ).toThrow("reference paths exceed")
  expect(() =>
    numericPresenceReview(
      { ...f.task, guidance: [], sources: [{ ...source, text: "x".repeat(20 * 1024 * 1024 + 1) }] },
      "200",
      [],
    ),
  ).toThrow("source text exceeds")
})

it("separates labeled valid ISO dates without hiding bare arithmetic or invalid dates", async () => {
  const f = await fixture()
  const task = { ...f.task, sources: [], guidance: [] }
  const report = numericPresenceReview(
    task,
    "Week of 2026-10-12: profit 4011.\nDue date: 2024-02-29\nDate: 2026-02-29\n2026-10-12\nWeek: 2026-10-12-4009\nDate 2026-10-12.5\nDate 2026-10-12abc",
    [],
  )
  expect(report.ignoredDateLabels).toEqual([
    { date: "2026-10-12", line: 1 },
    { date: "2024-02-29", line: 2 },
  ])
  expect(report.flagged.find((entry) => entry.value === 4011)?.lines).toEqual([1])
  expect(report.flagged.find((entry) => entry.value === 2026)?.lines).toContain(4)
  expect(report.flagged.some((entry) => entry.lines.includes(3))).toBe(true)
  expect(report.flagged.some((entry) => entry.lines.includes(5))).toBe(true)
  expect(report.flagged.some((entry) => entry.lines.includes(6))).toBe(true)
  expect(report.flagged.some((entry) => entry.lines.includes(7))).toBe(true)
  expect(report.numericCorrectnessVerified).toBe(false)
  const capped = numericPresenceReview(task, "Week of 2026-10-12\n".repeat(1001), [])
  expect(capped.ignoredDateLabels).toHaveLength(1000)
  expect(capped.ignoredDateLabelCount).toBe(1001)
  expect(capped.ignoredDateLabelsTruncated).toBe(true)
})

it("explains approximate rounded results but retains flags and rejects unmatched precision", async () => {
  const f = await fixture()
  const task = { ...f.task, sources: [], guidance: [] }
  const report = numericPresenceReview(
    task,
    "Approximately 66.7%. Roughly 0.67. About 67%. Approximately 66.8%. Approximately 0.68.",
    [{ input: [400, 600], result: 400 / 600 }],
  )
  for (const value of [0.667, 0.67])
    expect(report.flagged.find((entry) => entry.value === value)).toMatchObject({
      classification: "rounded-recorded-result",
      roundedMatches: [400 / 600],
    })
  for (const value of [66.8 / 100, 0.68])
    expect(report.flagged.find((entry) => entry.value === value)?.classification).toBe("unmatched")
  const unqualified = numericPresenceReview(task, "66.7%. 0.67. About 1e-1.", [
    { input: [400, 600], result: 400 / 600 },
  ])
  expect(unqualified.flagged.every((entry) => entry.classification === "unmatched")).toBe(true)
  expect(
    numericPresenceReview(task, "Approximately 66.7%. Unqualified: 66.7%.", [
      { input: [400, 600], result: 400 / 600 },
    ]).flagged[0]?.classification,
  ).toBe("unmatched")
  expect(report.needsReview).toBe(true)
  expect(report.numericCorrectnessVerified).toBe(false)
  expect(report.limitation).toContain("stay flagged for review")
})

it.each(["ordinary", "frozen"])(
  "checks a retained week label and approximate ratio in %s scope without changing evidence",
  async (scope) => {
    const f = await fixture()
    const frozen = scope === "frozen"
    const task = frozen
      ? await createSimulationTask(
          f.vault,
          (await captureSimulation(f.vault, "ECON901", "2026-10-13")).id,
          { kind: "prep", week: "2026-10-12" },
        )
      : f.task
    const operations = [
      ...f.batch.operations,
      { operation: "subtract", values: [600, 400] },
      { operation: "divide", values: [400, 600] },
    ]
    if (frozen) await calculateSimulationBatch(f.vault, task.id, operations)
    else await calculateBatchTask(f.config, task.id, operations.slice(-2))
    const text = (await readFile(f.file, "utf8")).replace(f.task.id, task.id)
    await writeFile(
      f.file,
      `${text}\nWeek of 2026-10-12. Break-even is approximately 66.7% of forecast.\n`,
    )
    const before = await readFile(f.file)
    const report = frozen
      ? await checkFrozenTaskNumbers(f.vault, task.id, f.file)
      : await checkTaskNumbers(f.vault, task.id, f.file)
    expect(report.ignoredDateLabels).toEqual([
      { date: "2026-10-12", line: text.split("\n").length + 1 },
    ])
    expect(report.flagged).toHaveLength(1)
    expect(report.flagged[0]?.classification).toBe("rounded-recorded-result")
    expect(await readFile(f.file)).toEqual(before)
  },
)
