import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"

const identifiers = vi.hoisted(() => ({ next: "" }))
vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto")
  return { ...actual, randomUUID: () => identifiers.next || actual.randomUUID() }
})

import { captureSimulation } from "../src/simulation.js"
import {
  calculateSimulationBatch,
  readSimulationCalculations,
} from "../src/simulation-calculations.js"
import { createSimulationTask } from "../src/simulation-tasks.js"

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

it("validates entire batches before writing and refuses unsupported/unselected inputs or held locks", async () => {
  const { vault, task, reading } = await fixture()
  for (const input of [
    [
      { operation: "sum", values: [1, 2], source: reading },
      { operation: "divide", values: [1, 0] },
    ],
    [{ operation: "run-code", values: [1] }],
    [{ operation: "sum", values: [1], source: "OTHER101/reading.md" }],
    [{ operation: "sum", values: Array.from({ length: 1001 }, () => 1) }],
    [{ operation: "sum", values: [1], rate: 0.1 }],
  ])
    await expect(calculateSimulationBatch(vault, task.id, input)).rejects.toThrow()
  expect((await readSimulationCalculations(vault, task.id)).records).toEqual([])
  const lock = join(vault, "_meta/simulations/tasks", task.id, "calculations.lock")
  await mkdir(lock)
  await expect(
    calculateSimulationBatch(vault, task.id, [{ operation: "sum", values: [1] }]),
  ).rejects.toThrow()
  expect(
    await readFile(join(vault, "_meta/simulations/tasks", task.id, "record.json")),
  ).toBeTruthy()
  await expect(mkdir(lock)).rejects.toThrow()
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
it("refuses a new write at the private record-count limit without changing existing arithmetic evidence", async () => {
  const { vault, task } = await fixture()
  const result = await calculateSimulationBatch(vault, task.id, [
    { operation: "sum", values: [1, 2] },
  ])
  const directory = join(vault, "_meta/simulations/tasks", task.id, "calculations")
  const original = JSON.parse(await readFile(join(directory, `${result.id}.json`), "utf8"))
  // Synthetic fixtures for the resource gate, not claims that 99 calculations ran.
  for (let index = 1; index < 100; index++) {
    const id = randomUUID()
    await writeFile(join(directory, `${id}.json`), JSON.stringify({ ...original, id }))
  }
  const before = await readSimulationCalculations(vault, task.id)
  expect(before.records).toHaveLength(100)
  await expect(
    calculateSimulationBatch(vault, task.id, [{ operation: "sum", values: [3, 4] }]),
  ).rejects.toThrow(/limit reached/)
  expect((await readSimulationCalculations(vault, task.id)).recordsHash).toBe(before.recordsHash)
})
it("preserves an unowned temporary collision and removes only the lock it created", async () => {
  const { vault, task } = await fixture()
  identifiers.next = "00000000-0000-4000-8000-000000000005"
  const directory = join(vault, "_meta/simulations/tasks", task.id)
  const temporary = join(directory, `.calculation-${identifiers.next}.tmp`)
  await writeFile(temporary, "Unowned private temporary file preserved.")
  await expect(
    calculateSimulationBatch(vault, task.id, [{ operation: "sum", values: [1, 2] }]),
  ).rejects.toThrow()
  expect(await readFile(temporary, "utf8")).toBe("Unowned private temporary file preserved.")
  expect((await readSimulationCalculations(vault, task.id)).records).toEqual([])
  await expect(lstat(join(directory, "calculations.lock"))).rejects.toMatchObject({
    code: "ENOENT",
  })
})

it("runs single/batch and inspection commands through the compiled CLI with redacted invalid input", async () => {
  const { root, vault, task, reading } = await fixture()
  const config = join(root, "config.json")
  const cli = (args: string[]) =>
    spawnSync(process.execPath, [resolve("dist/cli.js"), ...args, "--config", config, "--json"], {
      encoding: "utf8",
    })
  expect(
    cli(["init", "--vault", vault, "--canvas-url", "https://canvas.example.test"]).status,
  ).toBe(0)
  const single = cli([
    "simulate",
    "task",
    "calculate",
    task.id,
    "--operation",
    "sum",
    "--values",
    "1800,-300,-1000",
    "--source",
    reading,
  ])
  expect(single.status, single.stderr).toBe(0)
  expect(JSON.parse(single.stdout).results[0].result).toBe(500)
  expect(single.stdout).not.toContain("PRIVATE_SOURCE_BODY")
  const file = join(root, "batch.json")
  await writeFile(
    file,
    JSON.stringify({ operations: [{ operation: "multiply", values: [2, 3], source: reading }] }),
  )
  expect(cli(["simulate", "task", "calculate", task.id, "--file", file]).status).toBe(0)
  const shown = cli(["simulate", "task", "calculations", task.id])
  expect(shown.status, shown.stderr).toBe(0)
  expect(JSON.parse(shown.stdout).records).toHaveLength(2)
  await writeFile(file, "PRIVATE_INVALID_JSON_LITERAL")
  const invalid = cli(["simulate", "task", "calculate", task.id, "--file", file])
  expect(invalid.status).toBe(1)
  expect(invalid.stdout + invalid.stderr).not.toContain("PRIVATE_INVALID_JSON_LITERAL")
  expect(cli(["simulate", "task", "calculate", task.id, "--file", join(root, ".env")]).status).toBe(
    1,
  )
  expect(
    JSON.parse(cli(["simulate", "task", "calculations", task.id]).stdout).records,
  ).toHaveLength(2)
}, 15_000)
