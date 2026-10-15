import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"

const race = vi.hoisted(() => ({
  target: "",
  linkTarget: "",
  mode: "",
  mutated: false,
  readBytes: 0,
  largestRequest: 0,
}))
vi.mock("node:fs/promises", async () => {
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === race.target)
        throw new Error("Unbounded path readFile must not be used")
      return fs.readFile(...args)
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const selected = String(args[0]) === race.target
      if (selected && race.mode === "link-before-open" && !race.mutated) {
        await fs.rename(race.target, `${race.target}.preserved`)
        await fs.symlink(race.linkTarget, race.target)
        race.mutated = true
      }
      const handle = await fs.open(...args)
      if (!selected || race.mode !== "grow-after-stat") return handle
      return new Proxy(handle, {
        get(target, key) {
          if (key === "stat")
            return async () => {
              const before = await target.stat()
              if (!race.mutated) {
                await fs.truncate(race.target, 5_000_001)
                race.mutated = true
              }
              return before
            }
          if (key === "read")
            return async (...readArgs: Parameters<typeof handle.read>) => {
              const length = typeof readArgs[2] === "number" ? readArgs[2] : 0
              race.largestRequest = Math.max(race.largestRequest, length)
              const result = await target.read(...readArgs)
              race.readBytes += result.bytesRead
              return result
            }
          const value = Reflect.get(target, key)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
    },
  }
})

import { captureSimulation } from "../../src/evaluation/captures.js"
import { completeSimulationTask, createSimulationTask } from "../../src/evaluation/tasks.js"
import { readTaskOutput } from "../../src/tasks/output.js"

const roots: string[] = []
afterEach(async () => {
  Object.assign(race, {
    target: "",
    linkTarget: "",
    mode: "",
    mutated: false,
    readBytes: 0,
    largestRequest: 0,
  })
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-frozen-read-race-"))
  roots.push(root)
  const vault = join(root, "vault")
  const source = "CS101/Week 01 - Oct 12/reading.md"
  await mkdir(join(vault, "CS101/Week 01 - Oct 12"), { recursive: true })
  await writeFile(
    join(vault, source),
    "---\navailable_at: 2026-10-12\n---\nSynthetic marginal framework distinguishes avoidable costs from sunk expenses.",
  )
  const capture = await captureSimulation(vault, "CS101", "2026-10-14")
  const task = await createSimulationTask(vault, capture.id, { kind: "prep", week: "2026-10-12" })
  const candidate = join(root, "candidate.md")
  await writeFile(
    candidate,
    [
      `Task: ${task.id}`,
      ...task.requirements.map(
        (heading) =>
          `## ${heading}\n\nSynthetic marginal framework evidence separates avoidable costs from sunk expenses without invented data. \`${source}\``,
      ),
    ].join("\n\n"),
  )
  const completion = await completeSimulationTask(vault, task.id, candidate)
  const record = join(vault, "_meta/simulations/tasks", task.id, "record.json")
  return {
    root,
    vault,
    task,
    output: join(vault, completion.output),
    record,
    before: await readFile(record),
  }
}

it("bounds actual reads when an output grows after descriptor stat and preserves the task recipe", async () => {
  const f = await fixture()
  Object.assign(race, { target: f.output, mode: "grow-after-stat" })
  await expect(
    readTaskOutput(join(f.root, "config.json"), f.vault, f.task.id, "frozen"),
  ).rejects.toThrow("bounded read limits")
  expect(race.mutated).toBe(true)
  expect(race.readBytes).toBeLessThanOrEqual(5_000_001)
  expect(race.largestRequest).toBeLessThanOrEqual(5_000_001)
  race.target = ""
  expect(await readFile(f.record)).toEqual(f.before)
})

it("refuses a final-component symlink substituted after ancestor checks without reading its target", async () => {
  const f = await fixture()
  const target = join(f.root, "outside-output.md")
  await writeFile(target, "PRIVATE_LINK_TARGET_SENTINEL")
  Object.assign(race, { target: f.output, linkTarget: target, mode: "link-before-open" })
  const error = await readTaskOutput(
    join(f.root, "config.json"),
    f.vault,
    f.task.id,
    "frozen",
  ).catch((value: unknown) => value)
  expect(error).toBeInstanceOf(Error)
  expect(race.mutated).toBe(true)
  expect(String(error)).not.toContain("PRIVATE_LINK_TARGET_SENTINEL")
  race.target = ""
  expect(await readFile(f.record)).toEqual(f.before)
  expect(await readFile(target, "utf8")).toBe("PRIVATE_LINK_TARGET_SENTINEL")
})
