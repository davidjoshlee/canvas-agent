import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { calculateSimulationBatch } from "../helpers/legacy-execution.js"

const identifiers = vi.hoisted(() => ({ next: "" }))
vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto")
  return { ...actual, randomUUID: () => identifiers.next || actual.randomUUID() }
})

import { readSimulationCalculations } from "../../src/simulation/calculations.js"
import { captureSimulation } from "../../src/simulation/captures.js"
import { createSimulationTask } from "../../src/simulation/tasks.js"

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-frozen-calculations-"))
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
    "---\navailable_at: 2026-10-05\n---\nPremium uplift 1800, discount loss 300, setup cost 1000. PRIVATE_SOURCE_BODY.",
  )
  const snapshot = await captureSimulation(vault, "CS101", "2026-10-09")
  const task = await createSimulationTask(vault, snapshot.id, {
    kind: "assignment",
    source,
    mode: "draft",
    context: [reading],
  })
  return { root, vault, source, reading, snapshot, task }
}
afterEach(async () => {
  identifiers.next = ""
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it("executes source-bound frozen batches and keeps results usable after live-source edits", async () => {
  const { vault, task, reading, snapshot } = await fixture()
  const before = await readFile(join(vault, "_meta/simulations/tasks", task.id, "record.json"))
  const result = await calculateSimulationBatch(vault, task.id, [
    { operation: "sum", values: [1800, -300, -1000], source: reading },
    { operation: "npv", values: [-100, 110], rate: 0.1 },
  ])
  expect(result.results.map((entry) => entry.result)).toEqual([500, -100 + 110 / 1.1])
  expect(result.snapshotHash).toBe(snapshot.hash)
  expect(result.attributionVerified).toBe(false)
  expect(result.results[0]?.source?.path).toBe(reading)
  expect(
    (
      await lstat(
        join(vault, "_meta/simulations/tasks", task.id, "calculations", `${result.id}.json`),
      )
    ).mode & 0o777,
  ).toBe(0o600)
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SOURCE_BODY")
  await writeFile(join(vault, reading), "Changed live source that must not replace the capture.")
  const checked = await readSimulationCalculations(vault, task.id)
  expect(checked.records[0]?.results[0]?.result).toBe(500)
  expect(await readFile(join(vault, "_meta/simulations/tasks", task.id, "record.json"))).toEqual(
    before,
  )
})

it("recomputes saved results, rejects altered bindings and refuses symlinked numeric records", async () => {
  const { root, vault, task, reading } = await fixture()
  const result = await calculateSimulationBatch(vault, task.id, [
    { operation: "sum", values: [1, 2], source: reading },
  ])
  const path = join(vault, "_meta/simulations/tasks", task.id, "calculations", `${result.id}.json`)
  const bytes = await readFile(path, "utf8")
  const changed = JSON.parse(bytes)
  changed.results[0].result = 999
  await writeFile(path, JSON.stringify(changed))
  await expect(readSimulationCalculations(vault, task.id)).rejects.toThrow(/arithmetic/)
  await writeFile(path, bytes)
  changed.results[0].result = 3
  changed.results[0].source.hash = "0".repeat(64)
  await writeFile(path, JSON.stringify(changed))
  await expect(readSimulationCalculations(vault, task.id)).rejects.toThrow(/frozen evidence/)
  await writeFile(path, bytes)
  const outside = join(root, "outside.json")
  await writeFile(outside, "PRIVATE_OUTSIDE_LITERAL")
  await symlink(
    outside,
    join(
      vault,
      "_meta/simulations/tasks",
      task.id,
      "calculations",
      "00000000-0000-4000-8000-000000000000.json",
    ),
  )
  await expect(readSimulationCalculations(vault, task.id)).rejects.toThrow(/Symbolic links/)
  expect(await readFile(outside, "utf8")).toBe("PRIVATE_OUTSIDE_LITERAL")
})
