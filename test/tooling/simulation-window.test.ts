import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { captureSimulation, replaySimulation } from "../../src/simulation/captures.js"
import { completeSimulationTask, readSimulationTask } from "../../src/simulation/tasks.js"
import { comparisonM1Bundle } from "../../tools/evaluation/m1.js"
import {
  compareSimulationWindow,
  createSimulationWindow,
  inspectSimulationWindow,
  listSimulationWindows,
  resumeSimulationWindow,
  simulationWindowDates,
} from "../../tools/evaluation/window.js"

const roots: string[] = []
const sha = (text: string) => createHash("sha256").update(text).digest("hex")
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "canvas-window-"))
  roots.push(base)
  const vault = join(base, "vault")
  const paths = {
    a: "CS101/Assignments/A.md",
    b: "CS101/Assignments/B.md",
    other: "CS101/Assignments/Other.md",
    first: "CS101/Canvas/Modules/First-11.md",
    second: "CS101/Canvas/Modules/Second-22.md",
    r1: "CS101/Week 01 - Oct 5/reading.md",
    r2: "CS101/Week 02 - Oct 12/reading.md",
  }
  for (const [path, available, fields, body] of [
    [
      paths.a,
      "2026-10-05",
      'type: assignments\ncanvas_id: "50"',
      "Explain synthetic framework A using supplied evidence.",
    ],
    [
      paths.b,
      "2026-10-12",
      'type: assignments\ncanvas_id: "60"',
      "Explain synthetic framework B using supplied evidence.",
    ],
    [
      paths.other,
      "2026-10-05",
      'type: assignments\ncanvas_id: "70"',
      "Explain the unrelated synthetic framework.",
    ],
    [
      paths.r1,
      "2026-10-05",
      'dates: {date: "2026-10-05"}',
      "Synthetic teaching material explains the framework and relevant evidentiary distinctions in detail. OLD_CAPTURED_BODY.",
    ],
    [
      paths.r2,
      "2026-10-12",
      'dates: {date: "2026-10-12"}',
      "Synthetic later teaching material explains the framework and relevant evidentiary distinctions in detail. LATER_CAPTURED_BODY.",
    ],
    [
      paths.first,
      "2026-10-05",
      `type: modules\ncanvas_id: "11"\nmodule_position: 1\nrelated_paths: ${JSON.stringify([paths.a, paths.r1])}\ndates: {date: "2026-10-05"}`,
      "Session 1\nSynthetic first teaching module.",
    ],
    [
      paths.second,
      "2026-10-12",
      `type: modules\ncanvas_id: "22"\nmodule_position: 2\nrelated_paths: ${JSON.stringify([paths.b, paths.r2])}\ndates: {date: "2026-10-12"}`,
      "Session 2\nSynthetic second teaching module.",
    ],
  ]) {
    await mkdir(join(vault, path, ".."), { recursive: true })
    await writeFile(
      join(vault, path),
      `---\navailable_at: ${available}\n${fields}\n---\n# Synthetic source\n${body}\n`,
    )
  }
  const capture = await captureSimulation(vault, "CS101", "2026-10-12")
  return { base, vault, paths, capture }
}
async function complete(vault: string, id: string) {
  const record = await readSimulationTask(vault, id)
  const file = join(vault, `${id}.candidate.md`)
  await writeFile(
    file,
    [
      `Task: ${id}`,
      ...record.task.requirements.map(
        (heading) =>
          `## ${heading}\n${heading === "Sources" ? `\`${record.task.sources[0]?.path}\`` : "Synthetic mechanical-validator fixture, not coursework."}`,
      ),
      ...(record.options.mode === "draft"
        ? ["### Schedule\n| Label | Value |\n| --- | --- |\n| Cash | 500 |"]
        : []),
    ].join("\n\n"),
  )
  return completeSimulationTask(vault, id, file)
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("simulation window orchestration", () => {
  it("preserves recorded creation failures on resume instead of retrying them as new successes", async () => {
    const f = await fixture()
    let checkpoints = 0,
      id = ""
    try {
      await createSimulationWindow(
        f.vault,
        f.capture.id,
        "CS101",
        "2026-09-28..2026-10-12",
        undefined,
        {
          afterCheckpoint: async () => {
            if (++checkpoints === 3) throw new Error("Synthetic failed-slot interruption")
          },
        },
      )
    } catch (error) {
      id = (error as { windowId: string }).windowId
    }
    const before = await inspectSimulationWindow(f.vault, id, "CS101")
    expect(before.weeks[0]?.tasks[0]?.failure).toBe("handoff-creation-failed")
    const resumed = await resumeSimulationWindow(f.vault, id, "CS101")
    expect(resumed.phase).toBe("planned")
    expect(resumed.weeks[0]?.tasks).toEqual(before.weeks[0]?.tasks)
    expect(resumed.counts.unavailable).toBe(1)
    expect(resumed.verdict).toBe("pending-human")
  })

  it("does not remove a foreign replacement planner lock after ownership changes", async () => {
    const f = await fixture()
    let id = ""
    await expect(
      createSimulationWindow(f.vault, f.capture.id, "CS101", "2026-10-05..2026-10-12", undefined, {
        afterCheckpoint: async () => {
          id = (await readdir(join(f.vault, "_meta/simulation-windows")))[0] ?? ""
          const directory = join(f.vault, "_meta/simulation-windows", id)
          await rename(join(directory, "lock"), join(directory, "retained-original-lock"))
          await mkdir(join(directory, "lock"))
          await writeFile(join(directory, "lock/owner.txt"), "FOREIGN_REPLACEMENT_LOCK")
          // Return normally: the writer itself must stop after losing ownership.
        },
      }),
    ).rejects.toThrow("lock ownership changed")
    expect(
      await readFile(join(f.vault, "_meta/simulation-windows", id, "lock/owner.txt"), "utf8"),
    ).toBe("FOREIGN_REPLACEMENT_LOCK")
    const journal = JSON.parse(
      await readFile(join(f.vault, "_meta/simulation-windows", id, "plan.json"), "utf8"),
    )
    expect(journal.weeks).toEqual([])
    await expect(readdir(join(f.vault, "_meta/simulations/tasks"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
  it("resumes a genuinely interrupted prefix in a fresh CLI, preserving completed handoffs and archived journal bytes", async () => {
    const f = await fixture()
    let checkpoints = 0,
      id = ""
    try {
      await createSimulationWindow(
        f.vault,
        f.capture.id,
        "CS101",
        "2026-10-05..2026-10-12",
        undefined,
        {
          afterCheckpoint: async () => {
            if (++checkpoints === 3) throw new Error("Synthetic planner interruption")
          },
        },
      )
    } catch (error) {
      id = (error as { windowId: string }).windowId
    }
    expect(id).toBeTruthy()
    const partial = await inspectSimulationWindow(f.vault, id, "CS101")
    expect(partial.phase).toBe("building")
    expect(partial.weeks[0]?.tasks).toHaveLength(1)
    const taskId = partial.weeks[0]?.tasks[0]?.id ?? "missing"
    await complete(f.vault, taskId)
    const protectedPaths = [
      join(f.vault, f.capture.path),
      ...["record.json", "TASK.md", "output.md", "completion.json"].map((file) =>
        join(f.vault, "_meta/simulations/tasks", taskId, file),
      ),
    ]
    const before = await Promise.all(protectedPaths.map((path) => readFile(path)))
    const directory = join(f.vault, "_meta/simulation-windows", id)
    const planPath = join(directory, "plan.json")
    const partialBytes = await readFile(planPath)
    await writeFile(join(f.vault, f.paths.r1), "NEVER_READ_LIVE_AFTER_RESTART")
    const config = join(f.base, "config.json")
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "UNSET_WINDOW_RESUME_TOKEN" },
        vault: { path: f.vault },
        courses: { allowlist: [] },
      }),
    )
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        resolve("tools/evaluation/run.ts"),
        "simulate",
        "window",
        "resume",
        id,
        "--course",
        "CS101",
        "--config",
        config,
        "--json",
      ],
      { cwd: f.base, encoding: "utf8", timeout: 30_000 },
    )
    expect(result.status, result.stderr).toBe(0)
    const resumed = JSON.parse(result.stdout)
    expect(resumed).toMatchObject({
      id,
      phase: "planned",
      counts: { completed: 1 },
      verdict: "pending-human",
    })
    expect(resumed.weeks[0].snapshot).toEqual(partial.weeks[0]?.snapshot)
    expect(resumed.weeks[0].tasks[0].id).toBe(taskId)
    expect(resumed.weeks).toHaveLength(2)
    expect(await Promise.all(protectedPaths.map((path) => readFile(path)))).toEqual(before)
    expect(
      await readFile(join(directory, "history", `${sha(partialBytes.toString())}.json`)),
    ).toEqual(partialBytes)
    const newTask = resumed.weeks[0].tasks[1].id
    expect(JSON.stringify((await readSimulationTask(f.vault, newTask)).task.sources)).not.toContain(
      "NEVER_READ_LIVE_AFTER_RESTART",
    )
    expect(await readFile(join(f.vault, f.paths.r1), "utf8")).toBe("NEVER_READ_LIVE_AFTER_RESTART")
    const finalBytes = await readFile(planPath)
    const historyBefore = await readdir(join(directory, "history"))
    await resumeSimulationWindow(f.vault, id, "CS101")
    expect(await readFile(planPath)).toEqual(finalBytes)
    expect(await readdir(join(directory, "history"))).toEqual(historyBefore)
    await expect(readdir(join(directory, "lock"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses held planner locks and legacy incomplete ownership without changing journals or reserved tasks", async () => {
    const f = await fixture()
    let id = ""
    try {
      await createSimulationWindow(
        f.vault,
        f.capture.id,
        "CS101",
        "2026-10-05..2026-10-12",
        undefined,
        {
          afterCheckpoint: async () => {
            throw new Error("Synthetic initial interruption")
          },
        },
      )
    } catch (error) {
      id = (error as { windowId: string }).windowId
    }
    const directory = join(f.vault, "_meta/simulation-windows", id)
    const path = join(directory, "plan.json")
    const before = await readFile(path)
    const lock = join(directory, "lock")
    await mkdir(lock)
    await writeFile(join(lock, "owner.txt"), "OTHER_WRITER_SENTINEL")
    await expect(resumeSimulationWindow(f.vault, id, "CS101")).rejects.toMatchObject({
      code: "EEXIST",
    })
    expect(await readFile(path)).toEqual(before)
    expect(await readFile(join(lock, "owner.txt"), "utf8")).toBe("OTHER_WRITER_SENTINEL")
    // Remove only this test-owned lock, not through the product's resume command.
    await rm(lock, { recursive: true })
    const legacy = JSON.parse(before.toString())
    delete legacy.planningVersion
    const { hash: _old, ...base } = legacy
    legacy.hash = sha(JSON.stringify(base))
    const bytes = JSON.stringify(legacy)
    await writeFile(path, bytes)
    await expect(resumeSimulationWindow(f.vault, id, "CS101")).rejects.toThrow(
      "untracked writer ownership",
    )
    expect(await readFile(path, "utf8")).toBe(bytes)
    await expect(readdir(join(directory, "history"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("stops resume on a changed saved recipe before creating missing handoffs", async () => {
    const f = await fixture()
    let checkpoints = 0,
      id = ""
    try {
      await createSimulationWindow(
        f.vault,
        f.capture.id,
        "CS101",
        "2026-10-05..2026-10-12",
        undefined,
        {
          afterCheckpoint: async () => {
            if (++checkpoints === 3) throw new Error("Synthetic interruption")
          },
        },
      )
    } catch (error) {
      id = (error as { windowId: string }).windowId
    }
    const partial = await inspectSimulationWindow(f.vault, id, "CS101")
    const path = join(
      f.vault,
      "_meta/simulations/tasks",
      partial.weeks[0]?.tasks[0]?.id ?? "",
      "record.json",
    )
    const recipe = JSON.parse(await readFile(path, "utf8"))
    recipe.task.createdAt = "2026-10-05T00:00:00.000Z"
    await writeFile(path, JSON.stringify(recipe))
    const planPath = join(f.vault, "_meta/simulation-windows", id, "plan.json")
    const before = await readFile(planPath)
    const taskIds = await readdir(join(f.vault, "_meta/simulations/tasks"))
    await expect(resumeSimulationWindow(f.vault, id, "CS101")).rejects.toThrow(
      "recipe binding changed",
    )
    expect(await readFile(planPath)).toEqual(before)
    expect(await readdir(join(f.vault, "_meta/simulations/tasks"))).toEqual(taskIds)
  })
  it("lists a saved building journal as recorded selection only without inferring a live job", async () => {
    const f = await fixture()
    const own = await createSimulationWindow(
      f.vault,
      f.capture.id,
      "CS101",
      "2026-10-05..2026-10-05",
    )
    const directory = join(f.vault, "_meta/simulation-windows")
    const originalBytes = await readFile(join(directory, own.id, "plan.json"))
    const record = JSON.parse(originalBytes.toString())
    const id = randomUUID()
    record.id = id
    record.phase = "building"
    record.weeks = []
    const { hash: _old, ...base } = record
    record.hash = sha(JSON.stringify(base))
    await mkdir(join(directory, id))
    const path = join(directory, id, "plan.json")
    const bytes = JSON.stringify(record)
    await writeFile(path, bytes)
    const listed = await listSimulationWindows(f.vault, "CS101")
    expect(listed.inventoryComplete).toBe(true)
    expect(listed.windows.find((window) => window.id === id)).toMatchObject({
      phase: "building",
      recordedCutoffs: 0,
      recordedHandoffs: 0,
    })
    expect(JSON.stringify(listed.windows)).not.toContain("complete")
    expect(await readFile(path, "utf8")).toBe(bytes)
    expect(await readFile(join(directory, own.id, "plan.json"))).toEqual(originalBytes)
  })
  it("discovers saved plan metadata without current folders or reading missing capture/task evidence", async () => {
    const f = await fixture()
    expect((await listSimulationWindows(f.vault, "CS101")).windows).toEqual([])
    const own = await createSimulationWindow(
      f.vault,
      f.capture.id,
      "CS101",
      "2026-10-05..2026-10-12",
    )
    const planPath = join(f.vault, "_meta/simulation-windows", own.id, "plan.json")
    const before = await readFile(planPath)
    const record = JSON.parse(before.toString())
    await mkdir(join(f.vault, "ECON101/Week 01 - Oct 5"), { recursive: true })
    await writeFile(
      join(f.vault, "ECON101/Week 01 - Oct 5/reading.md"),
      "---\navailable_at: 2026-10-05\n---\nOTHER_WINDOW_PRIVATE_BODY substantive evidence.\n",
    )
    const otherCapture = await captureSimulation(f.vault, "ECON101", "2026-10-05")
    const other = await createSimulationWindow(
      f.vault,
      otherCapture.id,
      "ECON101",
      "2026-10-05..2026-10-05",
    )
    await rename(join(f.vault, "CS101"), join(f.base, "retained-CS101"))
    await rename(join(f.vault, f.capture.path), join(f.base, "retained-original-capture.json"))
    const listed = await listSimulationWindows(f.vault, "cs101")
    expect(listed).toMatchObject({ inventoryComplete: true, unreadableRecords: 0 })
    expect(listed.windows).toEqual([
      {
        id: own.id,
        createdAt: record.createdAt,
        originalCaptureId: f.capture.id,
        range: own.range,
        phase: "planned",
        recordedCutoffs: 2,
        recordedHandoffs: own.weeks.reduce((count, week) => count + week.tasks.length, 0),
      },
    ])
    expect(JSON.stringify(listed)).not.toContain(other.id)
    expect(JSON.stringify(listed)).not.toContain("PRIVATE_BODY")
    expect(JSON.stringify(listed)).not.toContain("recipeHash")
    expect(JSON.stringify(listed)).not.toContain("completed")
    expect(listed.limitation).toContain("not verified")
    await expect(inspectSimulationWindow(f.vault, own.id, "CS101")).rejects.toThrow()
    expect(await readFile(planPath)).toEqual(before)
    expect((await listSimulationWindows(f.vault, "UNKNOWN")).windows).toEqual([])
    await expect(listSimulationWindows(f.vault, " ")).rejects.toThrow("explicit")
  })

  it("reports malformed, linked, oversized and rehashed invalid date journals without repair", async () => {
    const f = await fixture()
    const own = await createSimulationWindow(
      f.vault,
      f.capture.id,
      "CS101",
      "2026-10-05..2026-10-05",
    )
    const path = join(f.vault, "_meta/simulation-windows")
    const malformed = join(path, randomUUID())
    await mkdir(malformed)
    await writeFile(join(malformed, "plan.json"), "PRIVATE_WINDOW_MALFORMED_SENTINEL")
    await symlink(malformed, join(path, randomUUID()))
    const oversized = join(path, randomUUID())
    await mkdir(oversized)
    await writeFile(join(oversized, "plan.json"), "")
    await truncate(join(oversized, "plan.json"), 4_000_001)
    const id = randomUUID()
    const invalid = join(path, id)
    await mkdir(invalid)
    const original = JSON.parse(await readFile(join(path, own.id, "plan.json"), "utf8"))
    original.id = id
    original.range = "2026-02-30..2026-03-01"
    const { hash: _old, ...base } = original
    original.hash = sha(JSON.stringify(base))
    await writeFile(join(invalid, "plan.json"), JSON.stringify(original))
    const listed = await listSimulationWindows(f.vault, "CS101")
    expect(listed).toMatchObject({ inventoryComplete: false, unreadableRecords: 4 })
    expect(listed.windows.map((window) => window.id)).toEqual([own.id])
    expect(JSON.stringify(listed)).not.toContain("PRIVATE_WINDOW")
    expect(await readFile(join(malformed, "plan.json"), "utf8")).toBe(
      "PRIVATE_WINDOW_MALFORMED_SENTINEL",
    )
  })
  it("preserves weekday cutoffs separately from Monday teaching periods", async () => {
    const f = await fixture()
    expect(simulationWindowDates("2026-10-06..2026-10-12")).toEqual(["2026-10-06"])
    const window = await createSimulationWindow(
      f.vault,
      f.capture.id,
      "CS101",
      "2026-10-08..2026-10-12",
    )
    expect(window.weeks).toHaveLength(1)
    const row = window.weeks[0]
    if (!row) throw new Error("Expected one planned cutoff")
    expect(row.cutoff).toBe("2026-10-08")
    expect(row.week).toBe("2026-10-05")
    expect((await replaySimulation(f.vault, row.snapshot.id)).asOf).toBe("2026-10-08T23:59:59.999Z")
    const prep = row.tasks.find((task) => task.kind === "prep")
    expect((await readSimulationTask(f.vault, prep?.id ?? "missing")).options.week).toBe(
      "2026-10-05",
    )
    for (const task of row.tasks) await complete(f.vault, task.id ?? "missing")
    expect((await compareSimulationWindow(f.vault, window.id, "CS101", "2026-10-08")).verdict).toBe(
      "pending-human",
    )
    expect((await compareSimulationWindow(f.vault, window.id, "CS101", "2026-10-05")).verdict).toBe(
      "pending-human",
    )
  })
  it("plans weekly prep plus all visible drafts from one fixed capture, tracks completion and aggregates review", async () => {
    const f = await fixture()
    const parent = await readFile(join(f.vault, f.capture.path))
    await writeFile(join(f.vault, f.paths.r1), "Changed live material must not enter window tasks.")
    const window = await createSimulationWindow(
      f.vault,
      f.capture.id,
      "CS101",
      "2026-10-05..2026-10-12",
    )
    expect(window.state).toBe("pending-host")
    expect(window.counts).toEqual({ pending: 7, completed: 0, unavailable: 0 })
    expect(
      window.weeks[0]?.tasks
        .filter((task) => task.kind === "assignment")
        .map((task) => task.source),
    ).toEqual([f.paths.a, f.paths.other])
    expect(
      window.weeks[1]?.tasks
        .filter((task) => task.kind === "assignment")
        .map((task) => task.source),
    ).toEqual([f.paths.a, f.paths.b, f.paths.other])
    for (const row of window.weeks)
      for (const task of row.tasks) {
        const recipe = await readSimulationTask(f.vault, task.id ?? "missing")
        if (row.week === "2026-10-05")
          expect(recipe.task.sources.some((s) => s.text.includes("LATER_CAPTURED_BODY"))).toBe(
            false,
          )
        expect(recipe.task.sources.some((s) => s.text.includes("Changed live material"))).toBe(
          false,
        )
      }
    await expect(compareSimulationWindow(f.vault, window.id, "CS101")).rejects.toThrow(
      /failed or pending/,
    )
    for (const row of window.weeks)
      for (const task of row.tasks) await complete(f.vault, task.id ?? "missing")
    const updated = await inspectSimulationWindow(f.vault, window.id, "CS101")
    expect(updated.state).toBe("completed-pending-human")
    expect(updated.counts).toEqual({ pending: 0, completed: 7, unavailable: 0 })
    const compared = await compareSimulationWindow(f.vault, window.id, "CS101")
    expect(compared.workbookCompanions).toBe(5)
    expect(await comparisonM1Bundle(f.vault, "CS101", compared.id)).toMatchObject({
      verdict: "pending-human",
      workbookCompanions: 5,
    })
    expect(await readFile(join(f.vault, f.capture.path))).toEqual(parent)
    expect(await readFile(join(f.vault, f.paths.r1), "utf8")).toBe(
      "Changed live material must not enter window tasks.",
    )
  })

  it("restricts draft selection to a captured module without using future module membership", async () => {
    const f = await fixture()
    const window = await createSimulationWindow(
      f.vault,
      f.capture.id,
      "CS101",
      "2026-10-05..2026-10-12",
      "22",
    )
    expect(window.module?.path).toBe(f.paths.second)
    expect(window.weeks.map((row) => row.moduleAvailable)).toEqual([false, true])
    expect(window.weeks[0]?.tasks.map((task) => task.kind)).toEqual(["prep"])
    expect(
      window.weeks[1]?.tasks
        .filter((task) => task.kind === "assignment")
        .map((task) => task.source),
    ).toEqual([f.paths.b])
    expect(window.counts.pending).toBe(3)
    for (const task of window.weeks[0]?.tasks ?? []) await complete(f.vault, task.id ?? "missing")
    const compared = await compareSimulationWindow(f.vault, window.id, "CS101", "2026-10-05")
    expect(compared.workbookCompanions).toBe(0)
    await expect(compareSimulationWindow(f.vault, window.id, "CS101")).rejects.toThrow(
      /failed or pending/,
    )
    await expect(
      compareSimulationWindow(f.vault, window.id, "CS101", "2026-09-28"),
    ).rejects.toThrow(/not in this window/)
  })

  it("rejects invalid scope, range and module before new window/capture writes", async () => {
    const f = await fixture()
    const before = await readdir(join(f.vault, "_meta/simulations"))
    expect(simulationWindowDates("2026-10-05..2026-10-12")).toEqual(["2026-10-05", "2026-10-12"])
    for (const range of [
      "2026-10-06..not-a-date",
      "2026-02-30..2026-03-02",
      "2026-10-12..2026-10-05",
      "2024-01-01..2026-10-12",
    ])
      await expect(createSimulationWindow(f.vault, f.capture.id, "CS101", range)).rejects.toThrow()
    await expect(
      createSimulationWindow(f.vault, f.capture.id, "OTHER101", "2026-10-05..2026-10-12"),
    ).rejects.toThrow(/course must match/)
    await expect(
      createSimulationWindow(f.vault, f.capture.id, "CS101", "2026-10-05..2026-10-19"),
    ).rejects.toThrow(/exceeds/)
    await expect(
      createSimulationWindow(f.vault, f.capture.id, "CS101", "2026-10-05..2026-10-12", "999"),
    ).rejects.toThrow(/missing or ambiguous/)
    expect(await readdir(join(f.vault, "_meta/simulations"))).toEqual(before)
    await expect(readdir(join(f.vault, "_meta/simulation-windows"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("rejects rehashed selection/recipe tampering and reports interrupted journals without claiming a live job", async () => {
    const f = await fixture()
    const window = await createSimulationWindow(
      f.vault,
      f.capture.id,
      "CS101",
      "2026-10-05..2026-10-12",
    )
    const path = join(f.vault, "_meta/simulation-windows", window.id, "plan.json")
    const bytes = await readFile(path, "utf8")
    const changed = JSON.parse(bytes)
    changed.weeks[0].tasks[1].source = f.paths.b
    const { hash: _old, ...base } = changed
    changed.hash = sha(JSON.stringify(base))
    await writeFile(path, JSON.stringify(changed))
    await expect(inspectSimulationWindow(f.vault, window.id, "CS101")).rejects.toThrow(
      /task selection/,
    )
    await writeFile(path, bytes)
    const taskId = window.weeks[0]?.tasks[0]?.id ?? "missing"
    const recipePath = join(f.vault, "_meta/simulations/tasks", taskId, "record.json")
    const recipeBytes = await readFile(recipePath, "utf8")
    const recipe = JSON.parse(recipeBytes)
    recipe.task.createdAt = "2026-10-11T12:00:00.000Z"
    await writeFile(recipePath, JSON.stringify(recipe))
    expect((await readSimulationTask(f.vault, taskId)).task.createdAt).toBe(recipe.task.createdAt)
    await expect(inspectSimulationWindow(f.vault, window.id, "CS101")).rejects.toThrow(
      /recipe binding/,
    )
    await writeFile(recipePath, recipeBytes)
    const interrupted = JSON.parse(bytes)
    interrupted.phase = "building"
    interrupted.weeks = interrupted.weeks.slice(0, 1)
    const { hash: _hash, ...partial } = interrupted
    interrupted.hash = sha(JSON.stringify(partial))
    await writeFile(path, JSON.stringify(interrupted))
    expect((await inspectSimulationWindow(f.vault, window.id, "CS101")).state).toBe(
      "incomplete-plan",
    )
    await expect(compareSimulationWindow(f.vault, window.id, "CS101")).rejects.toThrow(
      /planning is incomplete/,
    )
    expect(await readFile(path, "utf8")).toBe(JSON.stringify(interrupted))
  })

  it("keeps handoff creation failures explicit rather than calling an empty period completed", async () => {
    const f = await fixture()
    const window = await createSimulationWindow(
      f.vault,
      f.capture.id,
      "CS101",
      "2026-09-28..2026-10-05",
    )
    expect(window.state).toBe("partial-plan")
    expect(window.counts.unavailable).toBe(1)
    expect(window.weeks[0]?.tasks[0]?.state).toBe("recorded-creation-failure")
    await expect(compareSimulationWindow(f.vault, window.id, "CS101")).rejects.toThrow(
      /failed or pending/,
    )
  })

  it("requires an explicit module path for ambiguous IDs rather than choosing another namespace", async () => {
    const f = await fixture()
    const duplicate = "CS101/Canvas/Pages/Duplicate-22.md"
    await mkdir(join(f.vault, duplicate, ".."), { recursive: true })
    await writeFile(
      join(f.vault, duplicate),
      '---\navailable_at: 2026-10-05\ntype: modules\ncanvas_id: "22"\nmodule_canvas_id: "42"\n---\nSynthetic module-like page in another module namespace.',
    )
    const capture = await captureSimulation(f.vault, "CS101", "2026-10-12")
    await expect(
      createSimulationWindow(f.vault, capture.id, "CS101", "2026-10-12..2026-10-12", "22"),
    ).rejects.toThrow(/ambiguous/)
    const chosen = await createSimulationWindow(
      f.vault,
      capture.id,
      "CS101",
      "2026-10-12..2026-10-12",
      f.paths.second,
    )
    expect(chosen.module?.path).toBe(f.paths.second)
    expect(
      chosen.weeks[0]?.tasks
        .filter((task) => task.kind === "assignment")
        .map((task) => task.source),
    ).toEqual([f.paths.b])
  })

  it("runs compiled window create/show/compare and per-week M1 with metadata-only plan output", async () => {
    const f = await fixture()
    const config = join(f.base, "config.json")
    const cli = (args: string[]) => {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          resolve("tools/evaluation/run.ts"),
          ...args,
          "--config",
          config,
          "--json",
        ],
        { encoding: "utf8" },
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).not.toContain("OLD_CAPTURED_BODY")
      return JSON.parse(result.stdout)
    }
    cli(["init", "--vault", f.vault, "--canvas-url", "https://canvas.example.test"])
    const window = cli([
      "simulate",
      "window",
      "create",
      f.capture.id,
      "--course",
      "CS101",
      "--weeks",
      "2026-10-05..2026-10-12",
      "--module",
      "22",
    ])
    expect(cli(["simulate", "window", "show", window.id, "--course", "CS101"]).counts.pending).toBe(
      3,
    )
    const journalPath = join(f.vault, "_meta/simulation-windows", window.id, "plan.json")
    const beforeDiscovery = await readFile(journalPath)
    const listed = cli(["simulate", "window", "list", "--course", "CS101"])
    expect(listed).toMatchObject({ inventoryComplete: true, unreadableRecords: 0 })
    expect(listed.windows.map((entry: { id: string }) => entry.id)).toEqual([window.id])
    expect(listed.windows[0]).toMatchObject({
      phase: "planned",
      recordedCutoffs: 2,
      recordedHandoffs: 3,
    })
    expect(await readFile(journalPath)).toEqual(beforeDiscovery)
    for (const row of window.weeks) for (const task of row.tasks) await complete(f.vault, task.id)
    expect(cli(["simulate", "window", "show", window.id, "--course", "CS101"]).state).toBe(
      "completed-pending-human",
    )
    const compared = cli([
      "simulate",
      "window",
      "compare",
      window.id,
      "--course",
      "CS101",
      "--week",
      "2026-10-12",
    ])
    expect(compared.workbookCompanions).toBe(1)
    expect(cli(["gate", "m1", "--course", "CS101", "--comparison", compared.id]).verdict).toBe(
      "pending-human",
    )
  }, 15_000)
})
