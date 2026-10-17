import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createDogfood,
  type DogfoodFlow,
  dogfoodFlowNames,
  isUninitializedDogfoodRun,
  listDogfood,
  MissingDogfoodCheckpointError,
  readDogfood,
  runDogfood,
} from "../../tools/evaluation/dogfood.js"

const roots: string[] = []
const target = {
  course: "CS101",
  period: { kind: "week" as const, value: "2026-10-05" },
  assignment: null,
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-dogfood-"))
  roots.push(root)
  const journal = await createDogfood(root, target)
  return { root, journal, directory: join(root, "_meta/dogfood", journal.id) }
}
function flows(
  calls: string[],
  validate: DogfoodFlow["validate"] = async () => true,
): DogfoodFlow[] {
  return dogfoodFlowNames.map((name) => ({
    name,
    validate,
    async run() {
      calls.push(name)
      return {
        name,
        status: "pass",
        evidence: "Synthetic mechanical evidence",
        nextSteps: "",
        data: {},
      }
    },
  }))
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe("versioned resumable dogfood core", () => {
  it("discovers scoped checkpoints without private evidence, lock mutation or implied running jobs", async () => {
    const { root, journal, directory } = await fixture()
    const concrete = flows([])
    const second = concrete[1]
    if (!second) throw new Error("Synthetic second flow missing")
    second.run = async () => ({
      name: "timeline",
      status: "pending-host",
      evidence: "PRIVATE_EVIDENCE_SENTINEL",
      nextSteps: "PRIVATE_NEXT_STEP_SENTINEL",
      data: { note: "PRIVATE_DATA_SENTINEL" },
    })
    await runDogfood(root, journal.id, target, concrete)
    const other = await createDogfood(root, { ...target, course: "ECON101" })
    await mkdir(join(directory, "lock"))
    const files = (await readdir(directory)).filter((file) => file.endsWith(".json"))
    const before = await Promise.all(files.map((file) => readFile(join(directory, file))))
    const result = await listDogfood(root, "CS101")
    expect(result).toMatchObject({ inventoryComplete: true, unreadableRecords: 0 })
    expect(result.runs).toEqual([
      {
        id: journal.id,
        startedAt: journal.startedAt,
        period: target.period,
        assignment: null,
        recordedFlows: 2,
        lastCheckpoint: { name: "timeline", status: "pending-host" },
      },
    ])
    expect(JSON.stringify(result)).not.toContain(other.id)
    expect(JSON.stringify(result)).not.toContain("SENTINEL")
    expect(result.limitation).toContain("not a live job")
    expect(await readdir(directory)).toContain("lock")
    expect(await Promise.all(files.map((file) => readFile(join(directory, file))))).toEqual(before)
  })

  it("reports incomplete discovery for corrupt or linked journals without exposing or replacing them", async () => {
    const { root, journal, directory } = await fixture()
    const invalid = join(root, "_meta/dogfood", randomUUID())
    await mkdir(invalid)
    await writeFile(join(invalid, "000000.json"), "PRIVATE_CORRUPT_SENTINEL")
    await symlink(directory, join(root, "_meta/dogfood", randomUUID()), "dir")
    const result = await listDogfood(root, "CS101")
    expect(result.runs.map((run) => run.id)).toEqual([journal.id])
    expect(result.inventoryComplete).toBe(false)
    expect(result.unreadableRecords).toBe(2)
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CORRUPT_SENTINEL")
    expect(await readFile(join(invalid, "000000.json"), "utf8")).toBe("PRIVATE_CORRUPT_SENTINEL")
  })
  it("runs in legacy order, preserves checkpoints and revalidates reused results", async () => {
    const { root, journal, directory } = await fixture()
    const calls: string[] = [],
      validated: string[] = []
    const concrete = flows(calls, async (result) => {
      validated.push(result.name)
      return true
    })
    const result = await runDogfood(root, journal.id, target, concrete)
    expect(calls).toEqual([...dogfoodFlowNames])
    expect(result.flows.every((flow) => flow.status === "pass")).toBe(true)
    const initial = await readFile(join(directory, "000000.json"), "utf8")
    expect(result.version).toBe(2)
    expect((await readdir(directory)).length).toBe(10)
    expect(await runDogfood(root, journal.id, target, concrete)).toEqual(result)
    expect(calls.length).toBe(9)
    expect(validated).toEqual([...dogfoodFlowNames])
    expect(await readFile(join(directory, "000000.json"), "utf8")).toBe(initial)
  })
  it.each(["pending-host", "pending-human"] as const)(
    "stops at %s and resumes from that flow",
    async (status) => {
      const { root, journal } = await fixture()
      const calls: string[] = [],
        concrete = flows(calls)
      let finished = false
      concrete[3] = {
        name: "prep brief",
        validate: async () => true,
        async run(prior) {
          calls.push("prep brief")
          if (prior) expect(prior.data.taskId).toBe("synthetic-task")
          return {
            name: "prep brief",
            status: finished ? "pass" : status,
            evidence: "Synthetic handoff",
            nextSteps: "Complete the synthetic handoff",
            data: { taskId: "synthetic-task" },
          }
        },
      }
      expect((await runDogfood(root, journal.id, target, concrete)).flows).toHaveLength(4)
      finished = true
      expect((await runDogfood(root, journal.id, target, concrete)).flows).toHaveLength(9)
      expect(calls.filter((name) => name === "sync")).toHaveLength(1)
      expect(calls.filter((name) => name === "prep brief")).toHaveLength(2)
    },
  )
  it("invalidates downstream results for stale evidence and stops on failure without leaking errors", async () => {
    const { root, journal } = await fixture()
    const concrete = flows([])
    await runDogfood(root, journal.id, target, concrete)
    concrete[0] = {
      name: "sync",
      validate: async () => false,
      async run() {
        return {
          name: "sync",
          status: "pending-host",
          evidence: "Sync needed",
          nextSteps: "",
          data: {},
        }
      },
    }
    expect((await runDogfood(root, journal.id, target, concrete)).flows).toHaveLength(1)
    concrete[0] = {
      name: "sync",
      validate: async () => true,
      async run() {
        throw new Error("Bearer secret-token-and-private-source-body")
      },
    }
    const failure = await runDogfood(root, journal.id, target, concrete)
    expect(failure.flows[0]?.status).toBe("fail")
    expect(JSON.stringify(failure)).not.toContain("secret-token")
  })
  it("rejects changed scope, locked runs, corrupt checkpoints, unsafe IDs and symlinks", async () => {
    const { root, journal, directory } = await fixture()
    await expect(
      runDogfood(root, journal.id, { ...target, course: "OTHER101" }, flows([])),
    ).rejects.toThrow(/target/)
    await mkdir(join(directory, "lock"))
    await expect(runDogfood(root, journal.id, target, flows([]))).rejects.toThrow(/EEXIST/)
    expect(await readdir(directory)).toContain("lock")
    await rm(join(directory, "lock"), { recursive: true })
    await writeFile(
      join(directory, "000000.json"),
      JSON.stringify({ payload: "{}", hash: "0".repeat(64) }),
    )
    await expect(readDogfood(root, journal.id)).rejects.toThrow(/hash mismatch/)
    await expect(readDogfood(root, "../outside")).rejects.toThrow(/UUID/)
    const other = await createDogfood(root, target)
    const path = join(root, "_meta/dogfood", other.id, "000000.json"),
      outside = join(root, "outside.json")
    await writeFile(outside, await readFile(path))
    await rm(path)
    await symlink(outside, path)
    await expect(readDogfood(root, other.id)).rejects.toThrow(/symbolic links/i)
    await expect(runDogfood(root, journal.id, target, flows([]).slice(1))).rejects.toThrow(
      /nine ordered/,
    )
  })

  it("reads and resumes version 1 journals with their legacy cost checkpoint", async () => {
    const { root, journal, directory } = await fixture()
    const old = { ...journal, version: 1 }
    const payload = JSON.stringify(old)
    await writeFile(
      join(directory, "000000.json"),
      JSON.stringify({ payload, hash: createHash("sha256").update(payload).digest("hex") }),
    )
    const concrete = flows([])
    const resumed = await runDogfood(root, journal.id, target, concrete)
    expect(resumed.version).toBe(1)
    expect(resumed.flows).toHaveLength(10)
    expect(resumed.flows.at(-1)).toMatchObject({
      name: "cost report",
      status: "skipped",
      data: { owner: "host" },
    })
    const oldCostPath = join(directory, "000010.json")
    const exportPath = join(root, "historical-export.json")
    await writeFile(exportPath, "Preserved historical export bytes")
    const historical = {
      ...resumed,
      flows: [
        ...resumed.flows.slice(0, -1),
        {
          name: "cost report" as const,
          status: "pass" as const,
          evidence: "Historical export report",
          nextSteps: "",
          data: { exportFile: exportPath, exportHash: "old-hash", totalCostUsd: "1.00" },
        },
      ],
    }
    const historicalPayload = JSON.stringify(historical)
    await writeFile(
      oldCostPath,
      JSON.stringify({
        payload: historicalPayload,
        hash: createHash("sha256").update(historicalPayload).digest("hex"),
      }),
    )
    const historicalCostCheckpoint = await readFile(oldCostPath)
    expect((await readDogfood(root, journal.id)).flows.at(-1)?.data.totalCostUsd).toBe("1.00")
    const updated = await runDogfood(root, journal.id, target, concrete)
    expect(updated.id).toBe(journal.id)
    expect(updated.flows.at(-1)).toMatchObject({
      name: "cost report",
      status: "skipped",
      data: { owner: "host" },
    })
    expect(await readFile(oldCostPath)).toEqual(historicalCostCheckpoint)
    expect(await readFile(exportPath, "utf8")).toBe("Preserved historical export bytes")
    expect((await readDogfood(root, journal.id)).id).toBe(journal.id)
  })
})

import { randomUUID } from "node:crypto"

it("recognizes an empty journal independently of its display wording", async () => {
  const { root, journal, directory } = await fixture()
  await rm(join(directory, "000000.json"))
  const error = await readDogfood(root, journal.id).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(MissingDogfoodCheckpointError)
  if (!(error instanceof MissingDogfoodCheckpointError))
    throw new Error("Expected empty checkpoint error")
  error.message = "Reworded empty-journal explanation"
  expect(isUninitializedDogfoodRun(error)).toBe(true)
  expect(isUninitializedDogfoodRun(new Error("Dogfood journal has no checkpoint"))).toBe(false)
  expect(
    isUninitializedDogfoodRun(Object.assign(new Error("Missing directory"), { code: "ENOENT" })),
  ).toBe(true)
  expect(isUninitializedDogfoodRun(null)).toBe(false)
  expect(await readdir(directory)).toEqual([])
})
