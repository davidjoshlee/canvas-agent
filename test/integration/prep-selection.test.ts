import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { TaskRecord } from "../../src/shared/types.js"
import { captureSimulation, replaySimulation } from "../../src/simulation/captures.js"
import { createSimulationTask, readSimulationTask } from "../../src/simulation/tasks.js"
import { completeTask } from "../../src/tasks/completion.js"
import {
  createAssignmentTask,
  createPrepTask,
  readTask,
  selectPrepInputs,
} from "../../src/tasks/store.js"
import { inspectWorkspace, selectCourse } from "../../src/vault/workspace.js"

const roots: string[] = []
async function fixture(withDeadline = false) {
  const vault = await mkdtemp(join(tmpdir(), "canvas-prep-selection-"))
  roots.push(vault)
  const docs = {
    "Canvas/Modules/First.md": `type: modules\ncanvas_id: "11"\nmodule_position: 1\ndates: {unlock_at: "2026-10-05T08:00:00Z", session_at: "2026-10-12"}\nrelated_paths: [CS101/first-reading.md${withDeadline ? ", CS101/Assignments/prompt.md" : ""}]`,
    "Canvas/Modules/Second.md":
      'type: modules\ncanvas_id: "22"\nmodule_position: 2\ndates: {session_at: "2026-10-12"}\nrelated_paths: [CS101/second-reading.md]',
    "first-reading.md": "type: files",
    "second-reading.md": "type: files",
    ...(withDeadline
      ? {
          "Assignments/prompt.md":
            'type: assignments\ncanvas_id: "50"\ndue_at: "2026-10-12T08:00:00Z"',
        }
      : {}),
  }
  for (const [path, metadata] of Object.entries(docs)) {
    await mkdir(join(vault, "CS101", path, ".."), { recursive: true })
    await writeFile(
      join(vault, "CS101", path),
      `---\n${metadata}\n---\n# Synthetic source\nSubstantive synthetic framework evidence from ${path}, not actual student coursework.`,
    )
  }
  return vault
}
async function candidate(vault: string, task: TaskRecord) {
  const path = join(vault, `${task.id}.candidate.md`)
  await writeFile(
    path,
    [
      `Task: ${task.id}`,
      ...task.requirements.map(
        (heading) =>
          `## ${heading}\n${heading === "Sources" ? `\`${task.sources[0]?.path}\`` : "Synthetic structural-validator fixture only."}`,
      ),
    ].join("\n\n"),
  )
  return path
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("versioned School-style prep selection", () => {
  it("uses the same selection in compiled ordinary and frozen completion/comparison/M1 flows", async () => {
    const vault = await fixture()
    const config = join(vault, "config.json")
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
      return JSON.parse(result.stdout)
    }
    cli(["init", "--vault", vault, "--canvas-url", "https://canvas.example.test"])
    const created = cli(["prep", "CS101", "--week", "2026-10-12"])
    const ordinary = cli(["task", "show", created.id])
    expect(ordinary.prepSelectionVersion).toBe(2)
    expect(
      ordinary.sources.some((source: { path: string }) => source.path.endsWith("first-reading.md")),
    ).toBe(false)
    cli(["task", "complete", created.id, "--file", await candidate(vault, ordinary)])
    const capture = cli(["simulate", "capture", "CS101", "--as-of", "2026-10-12"])
    const frozen = cli([
      "simulate",
      "task",
      "create",
      capture.id,
      "--kind",
      "prep",
      "--week",
      "2026-10-12",
    ])
    const shown = cli(["simulate", "task", "show", frozen.id])
    expect(shown.prepSelectionVersion).toBe(2)
    expect(shown.task.sources.map((source: { path: string }) => source.path)).toEqual(
      ordinary.sources.map((source: { path: string }) => source.path),
    )
    cli(["simulate", "task", "complete", frozen.id, "--file", await candidate(vault, shown.task)])
    const comparison = cli(["simulate", "compare", "--course", "CS101", "--task", frozen.id])
    expect(cli(["gate", "m1", "--course", "CS101", "--comparison", comparison.id]).verdict).toBe(
      "pending-human",
    )
  })
  it("preserves an older strict assignment snapshot when only additive parsed module-date metadata becomes available", async () => {
    const vault = await fixture(true)
    const task = await createAssignmentTask(
      vault,
      "CS101",
      "CS101/Assignments/prompt.md",
      "outline",
    )
    task.sources = task.sources.map(({ moduleDates: _new, ...source }) => source)
    const path = join(vault, "_meta/tasks", task.id, "task.json")
    await writeFile(path, JSON.stringify(task))
    const before = await readFile(path)
    await readTask(vault, task.id)
    expect(await readFile(path)).toEqual(before)
    await completeTask(vault, task.id, await candidate(vault, task))
    expect((await readTask(vault, task.id)).status).toBe("completed")
  })
  it("prefers module unlock over session date and preserves that selection through ordinary completion", async () => {
    const vault = await fixture()
    const course = selectCourse(await inspectWorkspace(vault), "CS101")
    const module = course.sources.find((source) => source.canvasId === "11")
    expect(module?.moduleDates).toEqual({
      unlock_at: "2026-10-05T08:00:00Z",
      session_at: "2026-10-12",
    })
    const task = await createPrepTask(vault, "CS101", "2026-10-12")
    expect(task.prepSelectionVersion).toBe(2)
    expect(task.sources.some((source) => source.path.endsWith("first-reading.md"))).toBe(false)
    expect(task.sources.some((source) => source.path.endsWith("second-reading.md"))).toBe(true)
    expect((await readTask(vault, task.id)).sources).toEqual(task.sources)
    await completeTask(vault, task.id, await candidate(vault, task))
    expect((await readTask(vault, task.id)).status).toBe("completed")
  })

  it("selects a module through a directly linked assignment deadline even when its unlock is in another week", async () => {
    const vault = await fixture(true)
    const task = await createPrepTask(vault, "CS101", "2026-10-12")
    expect(task.sources.some((source) => source.canvasId === "11")).toBe(true)
    expect(task.sources.some((source) => source.path.endsWith("first-reading.md"))).toBe(true)
    expect((await readTask(vault, task.id)).sources).toEqual(task.sources)
    await completeTask(vault, task.id, await candidate(vault, task))
    expect((await readTask(vault, task.id)).status).toBe("completed")
  })

  it("reads and completes coherent unflagged flat-date recipes without rewriting or adopting new selection", async () => {
    const vault = await fixture()
    const course = selectCourse(await inspectWorkspace(vault), "CS101")
    const task = await createPrepTask(vault, "CS101", "2026-10-12")
    delete task.prepSelectionVersion
    task.sources = selectPrepInputs(course, "2026-10-12", 1).sources.map(
      ({ moduleDates: _new, ...source }) => source,
    )
    const path = join(vault, "_meta/tasks", task.id, "task.json")
    await writeFile(path, JSON.stringify(task))
    const before = await readFile(path)
    expect(
      (await readTask(vault, task.id)).sources.some((source) =>
        source.path.endsWith("first-reading.md"),
      ),
    ).toBe(true)
    expect(await readFile(path)).toEqual(before)
    await completeTask(vault, task.id, await candidate(vault, task))
    const completed = await readTask(vault, task.id)
    expect(completed.prepSelectionVersion).toBeUndefined()
    expect(completed.sources).toEqual(task.sources)
  })

  it("binds new frozen selection to raw captured dates and preserves coherent old flat recipes", async () => {
    const vault = await fixture()
    const capture = await captureSimulation(vault, "CS101", "2026-10-12")
    const task = await createSimulationTask(vault, capture.id, { kind: "prep", week: "2026-10-12" })
    const record = await readSimulationTask(vault, task.id)
    expect(record.prepSelectionVersion).toBe(2)
    expect(record.task.prepSelectionVersion).toBe(2)
    expect(record.task.sources.some((source) => source.path.endsWith("first-reading.md"))).toBe(
      false,
    )
    const path = join(vault, "_meta/simulations/tasks", task.id, "record.json")
    delete record.prepSelectionVersion
    delete record.task.prepSelectionVersion
    await writeFile(path, JSON.stringify(record))
    await expect(readSimulationTask(vault, task.id)).rejects.toThrow(/authoritative snapshot/)
    const replay = await replaySimulation(vault, capture.id)
    record.task.sources = selectPrepInputs(
      {
        ...replay.course,
        sources: replay.sources.map(({ availabilitySignals: _signals, ...source }) => source),
        excluded: replay.excluded,
        guidance: [],
        existingWork: [],
      },
      "2026-10-12",
      1,
    ).sources
    await writeFile(path, JSON.stringify(record))
    const before = await readFile(path)
    expect(
      (await readSimulationTask(vault, task.id)).task.sources.some((source) =>
        source.path.endsWith("first-reading.md"),
      ),
    ).toBe(true)
    expect(await readFile(path)).toEqual(before)
    const snapshotPath = join(vault, capture.path)
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"))
    snapshot.sources.find(
      (source: { canvasId?: string }) => source.canvasId === "11",
    ).moduleDates.unlock_at = "2026-10-12T08:00:00Z"
    const { hash: _old, ...base } = snapshot
    snapshot.hash = createHash("sha256").update(JSON.stringify(base)).digest("hex")
    await writeFile(snapshotPath, JSON.stringify(snapshot))
    await expect(replaySimulation(vault, capture.id)).rejects.toThrow(/source binding/)
  })
})
