import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { harnessCalculationsFromFile } from "../helpers/harness-calculations.js"

const roots: string[] = []
const fixtures = resolve("test/fixtures/host-numeric")
const prompt = "ECON901/Assignments/launch.md"
const reading = "ECON901/Week 02 - Oct 12/launch-case.md"
const files = [
  ["prompt.md", prompt],
  ["case.md", reading],
  ["course-guidance.md", "ECON901/Guidance/course-guidance.md"],
  ["assignment-guidance.md", "ECON901/Guidance/assignment-50.md"],
] as const
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it("replays host co-edit revision and explicit synthetic local approval with draft versions preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvas-host-lifecycle-replay-"))
  roots.push(root)
  const vault = join(root, "vault"),
    config = join(root, "config.json")
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "SystemRoot", "COMSPEC", "PATHEXT"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  )
  const cli = (args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), ...args, "--config", config, "--json"],
      { cwd: root, env, encoding: "utf8", timeout: 30_000, maxBuffer: 5_000_000 },
    )
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  }
  cli(["init", "--vault", vault, "--canvas-url", "https://canvas.example.test"])
  for (const folder of ["ECON901/Assignments", "ECON901/Guidance", "ECON901/Week 02 - Oct 12"])
    await mkdir(join(vault, folder), { recursive: true })
  for (const [fixture, path] of files)
    await writeFile(join(vault, path), await readFile(join(fixtures, fixture)))
  const parent = cli([
    "assignment",
    "ECON901",
    "--source",
    prompt,
    "--mode",
    "draft",
    "--context",
    reading,
  ])
  harnessCalculationsFromFile(join(fixtures, "calculations.json"))
  const parentFile = join(root, "parent.md")
  await writeFile(
    parentFile,
    (await readFile(join(fixtures, "candidate.md"), "utf8")).replace("{{TASK_ID}}", parent.id),
  )
  const prior = cli(["task", "complete", parent.id, "--file", parentFile])
  const parentPaths = [
    join(vault, prior.output),
    join(vault, "_meta/tasks", parent.id, "task.json"),
  ]
  const parentBytes = await Promise.all(parentPaths.map((path) => readFile(path)))
  const editPath = "ECON901/Assignments/Drafts/student-edited-launch.md"
  const edited = (await readFile(join(fixtures, "student-edited-launch.md"), "utf8")).replace(
    "{{PARENT_TASK_ID}}",
    parent.id,
  )
  await writeFile(join(vault, editPath), edited)
  const feedback =
    "Preserve the added demand-evidence condition and keep the full scoped analysis, including executed computations and limitations."
  const reviseArgs = ["revise", parent.id, "--work", editPath, "--feedback", feedback]
  const revision = cli(reviseArgs)
  expect(cli(reviseArgs).id).toBe(revision.id)
  const recipe = cli(["task", "show", revision.id])
  expect(recipe.parentTaskId).toBe(parent.id)
  expect(recipe.deliverable.scope).toBe("PART 2")
  expect(recipe.revisionEdits).toMatchObject({ version: 1, work: editPath })
  expect(recipe.revisionEdits.diff).toContain("+Invented student edit for engineering acceptance")
  expect(recipe.sources.find((source: { path: string }) => source.path === editPath).text).toBe(
    edited,
  )
  expect(recipe.sources.find((source: { path: string }) => source.path === prior.output).text).toBe(
    parentBytes[0]?.toString(),
  )
  const numbers = harnessCalculationsFromFile(join(fixtures, "calculations.json"))
  expect(numbers.map((row: { result: number }) => row.result)).toEqual([
    30000, 18000, 20, 4000, 400,
  ])
  const text = (await readFile(join(fixtures, "revision-candidate.md"), "utf8")).replace(
    "{{TASK_ID}}",
    revision.id,
  )
  const candidate = join(root, "revision.md")
  await writeFile(candidate, text)
  const completed = cli(["task", "complete", revision.id, "--file", candidate])
  expect(completed.output).not.toBe(prior.output)
  const approved = cli(["approve", revision.id])
  const paths = [
    join(vault, completed.output),
    join(vault, approved.output),
    join(vault, "_meta/tasks", revision.id, "task.json"),
  ]
  const retained = await Promise.all(paths.map((path) => readFile(path)))
  expect(retained[0]?.toString()).toBe(text)
  expect(retained[1]).toEqual(retained[0])
  expect(cli(["approve", revision.id]).output).toBe(approved.output)
  cli(["task", "complete", revision.id, "--file", candidate])
  expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(retained)
  expect(await Promise.all(parentPaths.map((path) => readFile(path)))).toEqual(parentBytes)
  expect(await readFile(join(vault, editPath), "utf8")).toBe(edited)
  expect(cli(["inspect", revision.id]).snapshots.current).toBe(true)
  for (const [fixture, path] of files)
    expect(await readFile(join(vault, path))).toEqual(await readFile(join(fixtures, fixture)))
}, 30000)

it.each(["primary", "luna"] as const)(
  "replays a finished %s multi-reading prep brief with question gates and scoped source isolation",
  async (host) => {
    const root = await mkdtemp(join(tmpdir(), "canvas-host-prep-replay-"))
    roots.push(root)
    const vault = join(root, "vault"),
      config = join(root, "config.json")
    const env = Object.fromEntries(
      ["PATH", "HOME", "TMPDIR", "SystemRoot", "COMSPEC", "PATHEXT"]
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]]),
    )
    const cli = (args: string[], status = 0) => {
      const result = spawnSync(
        process.execPath,
        [resolve("dist/cli.js"), ...args, "--config", config, "--json"],
        { cwd: root, env, encoding: "utf8", timeout: 30_000, maxBuffer: 5_000_000 },
      )
      expect(result.status, result.stderr).toBe(status)
      return status === 0 ? JSON.parse(result.stdout) : result.stderr
    }
    cli(["init", "--vault", vault, "--canvas-url", "https://canvas.example.test"])
    for (const folder of [
      "ECON901/Assignments",
      "ECON901/Guidance",
      "ECON901/Week 02 - Oct 12",
      "ECON901/Week 03 - Oct 19",
    ])
      await mkdir(join(vault, folder), { recursive: true })
    const originals = new Map<string, Buffer>()
    for (const [fixture, path] of [
      ...files,
      ["marginal-analysis.md", "ECON901/Week 02 - Oct 12/marginal-analysis.md"],
    ] as const) {
      let bytes = await readFile(join(fixtures, fixture))
      if (fixture === "assignment-guidance.md")
        bytes = Buffer.concat([bytes, Buffer.from("\nASSIGNMENT_ONLY_PREFERENCE_SENTINEL\n")])
      await writeFile(join(vault, path), bytes)
      originals.set(path, bytes)
    }
    const future = "ECON901/Week 03 - Oct 19/future.md"
    await writeFile(join(vault, future), "FUTURE_TOPIC_SENTINEL: an unrelated teaching week.\n")
    const created = cli(["prep", "ECON901", "--week", "2026-10-12"])
    const recipe = cli(["task", "show", created.id])
    expect(recipe.prepSelectionVersion).toBe(2)
    expect(recipe.sources.map((source: { path: string }) => source.path).sort()).toEqual(
      [prompt, reading, "ECON901/Week 02 - Oct 12/marginal-analysis.md"].sort(),
    )
    expect(recipe.guidance.map((source: { path: string }) => source.path)).toEqual([
      "ECON901/Guidance/course-guidance.md",
    ])
    expect(JSON.stringify(recipe)).not.toContain("ASSIGNMENT_ONLY_PREFERENCE_SENTINEL")
    expect(JSON.stringify(recipe)).not.toContain("FUTURE_TOPIC_SENTINEL")
    expect(recipe.questions).toEqual([
      "Which expenses enter the incremental launch decision?",
      "Why is a forecast not evidence of confirmed orders?",
      "What information is needed before calling the launch risk-free?",
    ])
    expect(recipe.requirements).toEqual([
      "Overview",
      "Reading synthesis",
      "Key concepts",
      "Preparation questions",
      "Discussion points",
      "Sources",
    ])
    const calculations = harnessCalculationsFromFile(
      join(fixtures, host === "luna" ? "luna-prep-calculations.json" : "calculations.json"),
    )
    expect(calculations.map((row: { result: number }) => row.result)).toEqual(
      host === "luna" ? [12000, 20, 200, 4000, 12000, 400] : [30000, 18000, 20, 4000, 400],
    )
    const text = (
      await readFile(
        join(fixtures, host === "luna" ? "luna-prep-candidate.md" : "prep-candidate.md"),
        "utf8",
      )
    ).replace("{{TASK_ID}}", created.id)
    const candidate = join(root, "prep.md"),
      incomplete = join(root, "incomplete.md")
    await writeFile(
      incomplete,
      text.replace(
        "### Why is a forecast not evidence of confirmed orders?",
        "### Omitted question response",
      ),
    )
    expect(cli(["task", "complete", created.id, "--file", incomplete], 1)).toContain("question")
    expect(cli(["task", "show", created.id]).status).toBe("pending")
    await writeFile(candidate, text)
    const completed = cli(["task", "complete", created.id, "--file", candidate])
    const output = join(vault, completed.output),
      record = join(vault, "_meta/tasks", created.id, "task.json")
    const retained = await Promise.all([output, record].map((path) => readFile(path)))
    expect(retained[0]?.toString()).toBe(text)
    expect(cli(["inspect", created.id]).snapshots.current).toBe(true)
    cli(["task", "complete", created.id, "--file", candidate])
    expect(await Promise.all([output, record].map((path) => readFile(path)))).toEqual(retained)
    for (const [path, bytes] of originals) expect(await readFile(join(vault, path))).toEqual(bytes)
    expect(await readFile(join(vault, future), "utf8")).toContain("FUTURE_TOPIC_SENTINEL")
  },
  30000,
)

it("replays a source-based review of flawed work without rewriting or approving that work", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvas-host-review-replay-"))
  roots.push(root)
  const vault = join(root, "vault"),
    config = join(root, "config.json")
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "SystemRoot", "COMSPEC", "PATHEXT"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  )
  const cli = (args: string[], status = 0) => {
    const result = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), ...args, "--config", config, "--json"],
      { cwd: root, env, encoding: "utf8", timeout: 30_000, maxBuffer: 5_000_000 },
    )
    expect(result.status, result.stderr).toBe(status)
    return status === 0 ? JSON.parse(result.stdout) : result.stderr
  }
  cli(["init", "--vault", vault, "--canvas-url", "https://canvas.example.test"])
  for (const folder of [
    "ECON901/Assignments/Drafts",
    "ECON901/Guidance",
    "ECON901/Week 02 - Oct 12",
  ])
    await mkdir(join(vault, folder), { recursive: true })
  for (const [fixture, path] of files)
    await writeFile(join(vault, path), await readFile(join(fixtures, fixture)))
  const work = "ECON901/Assignments/Drafts/student-review-fixture.md"
  const originalWork = await readFile(join(fixtures, "student-review-fixture.md"))
  await writeFile(join(vault, work), originalWork)
  const created = cli([
    "assignment",
    "ECON901",
    "--source",
    prompt,
    "--mode",
    "review",
    "--work",
    work,
    "--context",
    reading,
  ])
  const recipe = cli(["task", "show", created.id])
  expect(recipe.assignment.mode).toBe("review")
  expect(recipe.deliverable.scope).toBe("PART 2")
  expect(recipe.requirements).toEqual([
    "Assignment requirements",
    "Review",
    "Suggested revisions",
    "Open questions",
    "Sources",
  ])
  expect(recipe.assignmentStructureVersion).toBeUndefined()
  expect(recipe.sources.find((source: { path: string }) => source.path === work).text).toBe(
    originalWork.toString(),
  )
  const numbers = harnessCalculationsFromFile(join(fixtures, "review-calculations.json"))
  expect(numbers.map((row: { result: number }) => row.result)).toEqual([1000, 4000])
  const text = (await readFile(join(fixtures, "review-candidate.md"), "utf8")).replace(
    "{{TASK_ID}}",
    created.id,
  )
  const candidate = join(root, "review.md")
  await writeFile(candidate, text)
  const completed = cli(["task", "complete", created.id, "--file", candidate])
  expect(completed.output).not.toBe(work)
  expect(completed.task.workbookVersion).toBeUndefined()
  const outputPath = join(vault, completed.output),
    recordPath = join(vault, "_meta/tasks", created.id, "task.json")
  const retained = await Promise.all([outputPath, recordPath].map((path) => readFile(path)))
  expect(retained[0]?.toString()).toBe(text)
  expect(cli(["inspect", created.id]).snapshots.current).toBe(true)
  cli(["task", "complete", created.id, "--file", candidate])
  expect(cli(["approve", created.id], 1)).toContain("draft")
  expect(await readFile(join(vault, work))).toEqual(originalWork)
  expect(await Promise.all([outputPath, recordPath].map((path) => readFile(path)))).toEqual(
    retained,
  )
  for (const [fixture, path] of files)
    expect(await readFile(join(vault, path))).toEqual(await readFile(join(fixtures, fixture)))
}, 30000)

it.each(["ordinary", "frozen"] as const)(
  "replays the primary-host numeric scoped %s deliverable and preserves outputs across processes",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "canvas-host-numeric-replay-"))
    roots.push(root)
    const vault = join(root, "vault"),
      config = join(root, "config.json")
    const env = Object.fromEntries(
      ["PATH", "HOME", "TMPDIR", "SystemRoot", "COMSPEC", "PATHEXT"]
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]]),
    )
    const cli = (args: string[]) => {
      const result = spawnSync(
        process.execPath,
        [resolve("dist/cli.js"), ...args, "--config", config, "--json"],
        { cwd: root, env, encoding: "utf8", timeout: 30_000, maxBuffer: 5_000_000 },
      )
      expect(result.status, result.stderr).toBe(0)
      return JSON.parse(result.stdout)
    }
    cli(["init", "--vault", vault, "--canvas-url", "https://canvas.example.test"])
    for (const folder of ["ECON901/Assignments", "ECON901/Guidance", "ECON901/Week 02 - Oct 12"])
      await mkdir(join(vault, folder), { recursive: true })
    const originals = new Map<string, Buffer>()
    for (const [fixture, path] of files) {
      const bytes = await readFile(join(fixtures, fixture))
      await writeFile(join(vault, path), bytes)
      originals.set(path, bytes)
    }
    const frozen = kind === "frozen"
    const created = frozen
      ? cli([
          "simulate",
          "task",
          "create",
          cli(["simulate", "capture", "ECON901", "--as-of", "2026-10-14"]).id,
          "--kind",
          "assignment",
          "--source",
          prompt,
          "--mode",
          "draft",
          "--context",
          reading,
        ])
      : cli(["assignment", "ECON901", "--source", prompt, "--mode", "draft", "--context", reading])
    const show = () =>
      cli(frozen ? ["simulate", "task", "show", created.id] : ["task", "show", created.id])
    const shown = show(),
      recipe = frozen ? shown.task : shown
    expect(recipe.deliverableParserVersion).toBe(3)
    expect(recipe.deliverable.scope).toBe("PART 2")
    expect(recipe.deliverable.items.map((item: { text: string }) => item.text)).toEqual([
      "Calculate incremental launch profit using the supplied scenario.",
      "Recommend whether to launch and explain uncertainty.",
    ])
    expect(recipe.requirements).toEqual([
      "Recommendation",
      "Computations",
      "Limitations",
      "Sources",
    ])
    expect(
      recipe.sources.find((source: { path: string }) => source.path === reading).text,
    ).toContain("## Part 1")
    const calculation = harnessCalculationsFromFile(join(fixtures, "calculations.json"))
    expect(calculation.map((row: { result: number }) => row.result)).toEqual([
      30000, 18000, 20, 4000, 400,
    ])
    const candidate = join(root, "candidate.md")
    const text = (await readFile(join(fixtures, "candidate.md"), "utf8")).replace(
      "{{TASK_ID}}",
      created.id,
    )
    await writeFile(candidate, text)
    const complete = () =>
      cli(
        frozen
          ? ["simulate", "task", "complete", created.id, "--file", candidate]
          : ["task", "complete", created.id, "--file", candidate],
      )
    const completed = complete()
    const outputPath = join(vault, completed.output)
    const recordPath = join(
      vault,
      frozen
        ? `_meta/simulations/tasks/${created.id}/record.json`
        : `_meta/tasks/${created.id}/task.json`,
    )
    const retained = await Promise.all([outputPath, recordPath].map((path) => readFile(path)))
    expect(retained[0]?.toString()).toBe(text)
    complete()
    expect(await Promise.all([outputPath, recordPath].map((path) => readFile(path)))).toEqual(
      retained,
    )
    for (const [path, bytes] of originals) expect(await readFile(join(vault, path))).toEqual(bytes)
    if (frozen) {
      expect(completed.verdict).toBe("pending-human")
      await writeFile(join(vault, reading), "NEWER_LIVE_SOURCE_MUST_NOT_ENTER_FROZEN_OUTPUT")
      const recovered = show()
      expect(recovered.state).toBe("completed-pending-human")
      expect(JSON.stringify(recovered)).not.toContain("NEWER_LIVE_SOURCE")
      const evidence = cli(["simulate", "task", "calculations", created.id])
      expect(evidence.records).toEqual([])
      complete()
      expect(await readFile(outputPath)).toEqual(retained[0])
    } else {
      expect(cli(["inspect", created.id]).snapshots.current).toBe(true)
      expect(show().status).toBe("completed")
    }
  },
  30000,
)
