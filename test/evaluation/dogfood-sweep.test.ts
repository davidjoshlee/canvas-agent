import { randomUUID } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { readDogfood } from "../../src/evaluation/dogfood.js"
import {
  createDogfoodSweep,
  initializeDogfoodSweep,
  inspectDogfoodSweep,
  listDogfoodSweeps,
  resolveDogfoodSessions,
} from "../../src/evaluation/sweep.js"
import { inspectWorkspace, selectCourse } from "../../src/vault/workspace.js"

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-sweep-"))
  roots.push(root)
  await mkdir(join(root, "CS101/Modules"), { recursive: true })
  await mkdir(join(root, "CS101/Assignments"))
  await writeFile(
    join(root, "CS101/Assignments/prompt.md"),
    "---\ntype: assignment\n---\nSynthetic prompt.",
  )
  for (const [number, id] of [
    [2, 200],
    [1, 100],
  ]) {
    await writeFile(
      join(root, `CS101/Modules/session${number}.md`),
      `---\ntype: module\ncanvas_id: '${id}'\ntitle: Session ${number} - Synthetic topic\n${number === 1 ? "related_paths: [CS101/Assignments/prompt.md]\n" : ""}---\nSubstantive synthetic session content on competition and strategy.\n`,
    )
  }
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
it("discovers scoped sweep manifests without reading child bodies, changing locks or initializing work", async () => {
  const root = await fixture()
  await mkdir(join(root, "ECON101/Modules"), { recursive: true })
  await writeFile(
    join(root, "ECON101/Modules/session.md"),
    "---\ntype: module\ncanvas_id: '300'\ntitle: Session 1 - Other course\n---\nOTHER_COURSE_PRIVATE_BODY substantive material.\n",
  )
  const own = await createDogfoodSweep(root, "CS101", 2)
  const other = await createDogfoodSweep(root, "ECON101", 1)
  const manifest = join(root, "_meta/dogfood-sweeps", own.id, "manifest.json")
  const before = await readFile(manifest)
  const lock = join(root, "_meta/dogfood-sweeps", own.id, "lock")
  await mkdir(lock)
  // Discovery validates immutable selections, not child state or readiness.
  const childPath = join(root, "_meta/dogfood", own.sessions[0]?.runId ?? "", "000000.json")
  await writeFile(childPath, "PRIVATE_CHILD_CORRUPTION_SENTINEL")
  const listed = await listDogfoodSweeps(root, "CS101")
  expect(listed).toMatchObject({ course: "CS101", inventoryComplete: true, unreadableRecords: 0 })
  expect(listed.sweeps).toEqual([
    {
      id: own.id,
      createdAt: own.createdAt,
      sessionCount: 2,
      runIds: own.sessions.map((session) => session.runId),
    },
  ])
  expect(JSON.stringify(listed)).not.toContain(other.id)
  expect(JSON.stringify(listed)).not.toContain("PRIVATE_CHILD")
  expect(JSON.stringify(listed)).not.toContain("prompt.md")
  expect(listed.limitation).toContain("not verified")
  expect(await readFile(manifest)).toEqual(before)
  expect(await readdir(lock)).toEqual([])
  expect(await readFile(childPath, "utf8")).toBe("PRIVATE_CHILD_CORRUPTION_SENTINEL")
  await expect(readdir(join(root, "_meta/tasks"))).rejects.toMatchObject({ code: "ENOENT" })
})

it("marks malformed, linked, oversized and identity-substituted manifests incomplete without echo or repair", async () => {
  const root = await fixture()
  expect((await listDogfoodSweeps(root, "CS101")).sweeps).toEqual([])
  const own = await createDogfoodSweep(root, "CS101", 1)
  const path = join(root, "_meta/dogfood-sweeps")
  const malformed = join(path, randomUUID())
  await mkdir(malformed)
  await writeFile(join(malformed, "manifest.json"), "PRIVATE_MANIFEST_SENTINEL")
  await symlink(malformed, join(path, randomUUID()))
  const oversized = join(path, randomUUID())
  await mkdir(oversized)
  await writeFile(join(oversized, "manifest.json"), "")
  await truncate(join(oversized, "manifest.json"), 1_000_001)
  const substituted = join(path, randomUUID())
  await mkdir(substituted)
  await writeFile(
    join(substituted, "manifest.json"),
    await readFile(join(path, own.id, "manifest.json")),
  )
  const listed = await listDogfoodSweeps(root, "CS101")
  expect(listed.sweeps.map((entry) => entry.id)).toEqual([own.id])
  expect(listed).toMatchObject({ inventoryComplete: false, unreadableRecords: 4 })
  expect(JSON.stringify(listed)).not.toContain("PRIVATE_MANIFEST")
  expect(await readFile(join(malformed, "manifest.json"), "utf8")).toBe("PRIVATE_MANIFEST_SENTINEL")
  await expect(listDogfoodSweeps(root, "UNKNOWN")).rejects.toThrow(/No course matches/)
})
it("orders exact teaching identities, binds linked prompts, and creates separate private runs without guessed dates", async () => {
  const root = await fixture()
  const plan = resolveDogfoodSessions(selectCourse(await inspectWorkspace(root), "CS101"), 2)
  expect(plan.map((session) => session.number)).toEqual([1, 2])
  expect(plan.map((session) => session.selector)).toEqual(["100", "200"])
  expect(plan.map((session) => session.assignment)).toEqual(["CS101/Assignments/prompt.md", null])
  const sweep = await createDogfoodSweep(root, "CS101", 2)
  expect(new Set(sweep.sessions.map((session) => session.runId)).size).toBe(2)
  for (const session of sweep.sessions)
    expect((await readDogfood(root, session.runId)).target).toEqual({
      course: "CS101",
      period: { kind: "session", value: session.selector },
      assignment: session.assignment,
    })
  const shown = await inspectDogfoodSweep(root, "CS101", sweep.id)
  expect(shown.evidenceRevalidated).toBe(false)
  expect(
    shown.sessions.every((entry) => entry.state === "not-started" && !entry.recordedComplete),
  ).toBe(true)
  await expect(readdir(join(root, "_meta/tasks"))).rejects.toThrow()
  expect(await readFile(join(root, "CS101/Modules/session1.md"), "utf8")).toContain(
    "Substantive synthetic",
  )
  const path = join(root, "_meta/dogfood-sweeps", sweep.id, "manifest.json")
  await writeFile(path, `${await readFile(path, "utf8")} changed`)
  await expect(inspectDogfoodSweep(root, "CS101", sweep.id)).rejects.toThrow()
})
it("groups legacy pages under their owning module instead of inventing duplicate sessions", async () => {
  const root = await fixture()
  await writeFile(
    join(root, "CS101/Modules/legacy-page.md"),
    "---\ntype: page\ncanvas_id: '999'\nmodule_canvas_id: '100'\ntitle: Session 1 - Legacy page\n---\nSubstantive additional teaching evidence.",
  )
  expect(
    resolveDogfoodSessions(selectCourse(await inspectWorkspace(root), "CS101"), 2),
  ).toHaveLength(2)
})
it("recovers interrupted initialization using only the manifest's reserved IDs and preserves completed checkpoints", async () => {
  const root = await fixture()
  let id = ""
  try {
    await createDogfoodSweep(root, "CS101", 2, {
      afterRunCreated: async () => {
        throw new Error("Synthetic interruption")
      },
    })
    throw new Error("Expected initialization interruption")
  } catch (error) {
    id = (error as { sweepId: string }).sweepId
  }
  expect(id).toBeTruthy()
  const before = await inspectDogfoodSweep(root, "CS101", id)
  expect(before.sessions.map((session) => session.state)).toEqual([
    "not-started",
    "not-initialized",
  ])
  const path = join(root, "_meta/dogfood-sweeps", id, "manifest.json")
  const manifestBytes = await readFile(path)
  const firstId = before.sessions[0]?.runId ?? ""
  const firstCheckpoint = await readFile(join(root, "_meta/dogfood", firstId, "000000.json"))
  const completed = await initializeDogfoodSweep(root, "CS101", id)
  expect(completed.sessions.map((session) => session.runId)).toEqual(
    before.sessions.map((session) => session.runId),
  )
  expect(await readFile(path)).toEqual(manifestBytes)
  expect(await readFile(join(root, "_meta/dogfood", firstId, "000000.json"))).toEqual(
    firstCheckpoint,
  )
  expect(await readdir(join(root, "_meta/dogfood"))).toHaveLength(2)
  expect(await initializeDogfoodSweep(root, "CS101", id)).toEqual(completed)
})
it("refuses stale recovery plans, corrupt/nonempty runs and owned locks without overwriting them", async () => {
  const root = await fixture(),
    sweep = await createDogfoodSweep(root, "CS101", 2)
  const lock = join(root, "_meta/dogfood-sweeps", sweep.id, "lock")
  await mkdir(lock)
  await expect(initializeDogfoodSweep(root, "CS101", sweep.id)).rejects.toThrow(/EEXIST/)
  expect(await readdir(join(root, "_meta/dogfood-sweeps", sweep.id))).toContain("lock")
  await rm(lock, { recursive: true })
  const path = join(root, "_meta/dogfood", sweep.sessions[1]?.runId ?? "", "000000.json")
  await writeFile(path, "Corrupt checkpoint.")
  await expect(initializeDogfoodSweep(root, "CS101", sweep.id)).rejects.toThrow()
  expect(await readFile(path, "utf8")).toBe("Corrupt checkpoint.")
  await rm(path)
  await writeFile(join(path, "..", "student-owned.txt"), "Keep this file.")
  await expect(initializeDogfoodSweep(root, "CS101", sweep.id)).rejects.toThrow(/Unknown entry/)
  await writeFile(join(root, "CS101/Modules/session1.md"), "Changed selected session.")
  await expect(initializeDogfoodSweep(root, "CS101", sweep.id)).rejects.toThrow()
  expect(await readFile(join(path, "..", "student-owned.txt"), "utf8")).toBe("Keep this file.")
})
it("rejects invalid counts, ambiguous modules/assignments and unavailable links before creating runs", async () => {
  const root = await fixture()
  for (const count of [0, 1.5, 101, 3])
    await expect(createDogfoodSweep(root, "CS101", count)).rejects.toThrow()
  await writeFile(
    join(root, "CS101/Modules/duplicate.md"),
    "---\ntype: module\ncanvas_id: '300'\ntitle: Session 1 - Different module\n---\nSubstantive conflicting session.",
  )
  await expect(createDogfoodSweep(root, "CS101", 2)).rejects.toThrow(/ambiguous/)
  await rm(join(root, "CS101/Modules/duplicate.md"))
  const module = join(root, "CS101/Modules/session1.md"),
    original = await readFile(module, "utf8")
  await writeFile(
    module,
    original.replace("[CS101/Assignments/prompt.md]", "[CS101/Assignments/missing.md]"),
  )
  await expect(createDogfoodSweep(root, "CS101", 2)).rejects.toThrow(/unavailable/)
  await writeFile(
    join(root, "CS101/Assignments/other.md"),
    "---\ntype: assignment\n---\nSecond prompt.",
  )
  await writeFile(
    module,
    original.replace(
      "[CS101/Assignments/prompt.md]",
      "[CS101/Assignments/prompt.md, CS101/Assignments/other.md]",
    ),
  )
  await expect(createDogfoodSweep(root, "CS101", 2)).rejects.toThrow(/multiple assignments/)
  await expect(readdir(join(root, "_meta/dogfood"))).rejects.toThrow()
})
