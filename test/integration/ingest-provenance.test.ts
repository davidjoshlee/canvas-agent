import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { ingestFile } from "../../src/documents/content.js"
import { captureSimulation, replaySimulation } from "../../src/evaluation/captures.js"
import { createSimulationTask, readSimulationTask } from "../../src/evaluation/tasks.js"
import type { TaskRecord } from "../../src/shared/types.js"
import { completeTask } from "../../src/tasks/completion.js"
import {
  createAssignmentTask,
  createPrepTask,
  readTask,
  verifySourceSnapshot,
} from "../../src/tasks/store.js"
import { inspectWorkspace } from "../../src/vault/workspace.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-provenance-binding-"))
  roots.push(root)
  const vault = join(root, "vault"),
    input = join(root, "reading.txt")
  await mkdir(join(vault, "SYNTH501/Assignments"), { recursive: true })
  await mkdir(join(vault, "_meta"))
  await writeFile(
    join(vault, "_meta/canvas-courses.json"),
    JSON.stringify({
      version: 1,
      courses: [{ id: "17", name: "Synthetic course", root: "SYNTH501" }],
    }),
  )
  await writeFile(input, "Synthetic observations distinguish evidence from assumptions.\n")
  const result = await ingestFile(vault, "SYNTH501", input, "Reading", {
    week: "2026-10-12",
    asOf: "2026-10-05",
    compatibility: {
      canvasOrigin: "https://canvas.example.test",
      aiPolicy: "allowed",
      redistribution: "allowed",
    },
  })
  const sidecar = result.text ?? "",
    companion = `${sidecar}.ingest.json`
  return {
    root,
    vault,
    input,
    sidecar,
    companion,
    original: result.original,
    relative: sidecar.replace(`${vault}/`, ""),
  }
}
async function candidate(root: string, task: TaskRecord) {
  const path = join(root, `${task.id}.candidate.md`)
  await writeFile(
    path,
    [
      `Task: ${task.id}`,
      ...task.requirements.map(
        (heading) =>
          `## ${heading}\nSynthetic observations distinguish evidence from assumptions. \`${task.sources[0]?.path}\``,
      ),
    ].join("\n\n"),
  )
  return path
}
it("records exact companion bytes and refuses mutation between selection and source snapshot", async () => {
  const f = await fixture(),
    task = await createPrepTask(f.vault, "SYNTH501", "2026-10-12")
  const source = task.sources.find((item) => item.path === f.relative)
  expect(source?.ingestProvenance).toEqual({
    path: `${f.relative}.ingest.json`,
    hash: createHash("sha256")
      .update(await readFile(f.companion))
      .digest("hex"),
  })
  expect(
    (await readTask(f.vault, task.id)).sources.find((item) => item.path === f.relative)
      ?.ingestProvenance,
  ).toEqual(source?.ingestProvenance)
  await writeFile(f.companion, `${await readFile(f.companion, "utf8")}\n`)
  if (!source) throw new Error("Missing synthetic source")
  await expect(verifySourceSnapshot(f.vault, source)).rejects.toThrow(/provenance changed/)
})
it("uses declared availability for cutoff capture but not as a different teaching week", async () => {
  const f = await fixture()
  const source = (await inspectWorkspace(f.vault)).courses[0]?.sources.find(
    (entry) => entry.path === f.relative,
  )
  expect(source?.dates).toEqual(["2026-10-12"])
  await expect(createPrepTask(f.vault, "SYNTH501", "2026-10-05")).rejects.toThrow(
    /material|readable|period/,
  )
  const early = await captureSimulation(f.vault, "SYNTH501", "2026-10-09")
  const replay = await replaySimulation(f.vault, early.id)
  expect(
    replay.sources.find((entry) => entry.path === f.relative)?.availabilitySignals,
  ).toContainEqual({ field: "available_at", value: "2026-10-05" })
  expect(
    (await createSimulationTask(f.vault, early.id, { kind: "prep", week: "2026-10-12" })).id,
  ).toMatch(/^[a-f0-9-]{36}$/)
})
it("rejects prep and assignment completion after companion-only changes, preserving pending recipes", async () => {
  const f = await fixture()
  const prompt = "SYNTH501/Assignments/prompt.md"
  await writeFile(
    join(f.vault, prompt),
    "---\ntype: assignment\ncanvas_id: '9'\n---\nAssignment reference artifact.\n",
  )
  const tasks = [
    await createPrepTask(f.vault, "SYNTH501", "2026-10-12"),
    await createAssignmentTask(f.vault, "SYNTH501", prompt, "outline", undefined, [f.relative]),
  ]
  const before = await Promise.all(
    tasks.map((task) => readFile(join(f.vault, "_meta/tasks", task.id, "task.json"))),
  )
  await writeFile(
    f.companion,
    JSON.stringify(JSON.parse(await readFile(f.companion, "utf8")), null, 2),
  )
  for (const [index, task] of tasks.entries()) {
    await expect(completeTask(f.vault, task.id, await candidate(f.root, task))).rejects.toThrow(
      /stale|provenance changed/,
    )
    expect(await readFile(join(f.vault, "_meta/tasks", task.id, "task.json"))).toEqual(
      before[index],
    )
    expect((await readTask(f.vault, task.id)).status).toBe("pending")
  }
})
it("does not accept a companion-only earlier availability date or redirect to a different original", async () => {
  const f = await fixture(),
    before = await readFile(f.sidecar),
    data = JSON.parse(await readFile(f.companion, "utf8"))
  await writeFile(f.companion, JSON.stringify({ ...data, availableAt: "2026-09-01" }))
  expect((await inspectWorkspace(f.vault)).courses[0]?.sources).toEqual([])
  const other = join(f.vault, `SYNTH501/Canvas/Files/other-${data.originalHash.slice(0, 12)}.txt`)
  await writeFile(other, await readFile(f.original))
  await writeFile(
    f.companion,
    JSON.stringify({ ...data, originalPath: other.replace(`${f.vault}/`, "") }),
  )
  const context = await inspectWorkspace(f.vault)
  expect(context.courses[0]?.sources.some((source) => source.path === f.relative)).toBe(false)
  expect(await readFile(f.sidecar)).toEqual(before)
})
it("preserves older recipes without retrospectively adding a companion binding", async () => {
  const f = await fixture(),
    task = await createPrepTask(f.vault, "SYNTH501", "2026-10-12")
  const path = join(f.vault, "_meta/tasks", task.id, "task.json")
  const old = JSON.parse(await readFile(path, "utf8"))
  for (const source of old.sources) delete source.ingestProvenance
  await writeFile(path, JSON.stringify(old))
  await writeFile(f.companion, `${await readFile(f.companion, "utf8")}\n`)
  const loaded = await readTask(f.vault, task.id)
  expect(loaded.sources.every((source) => source.ingestProvenance === undefined)).toBe(true)
  const done = await completeTask(f.vault, task.id, await candidate(f.root, loaded))
  expect(done.task.sources.every((source) => source.ingestProvenance === undefined)).toBe(true)
})
it("replays captured companion bindings without reading changed or absent live originals/companions", async () => {
  const f = await fixture(),
    capture = await captureSimulation(f.vault, "SYNTH501", "2026-10-12")
  const before = await replaySimulation(f.vault, capture.id)
  const captured = before.sources.find((source) => source.path === f.relative)
  expect(captured?.ingestProvenance?.path).toBe(`${f.relative}.ingest.json`)
  const frozen = await createSimulationTask(f.vault, capture.id, {
    kind: "prep",
    week: "2026-10-12",
  })
  await rm(f.companion)
  await rm(f.original)
  expect((await replaySimulation(f.vault, capture.id)).sources).toEqual(before.sources)
  expect(
    (await readSimulationTask(f.vault, frozen.id)).task.sources.find(
      (source) => source.path === f.relative,
    )?.ingestProvenance,
  ).toEqual(captured?.ingestProvenance)
})
it("rejects task provenance references that are not the source's exact companion", async () => {
  const f = await fixture(),
    task = await createPrepTask(f.vault, "SYNTH501", "2026-10-12")
  const path = join(f.vault, "_meta/tasks", task.id, "task.json"),
    data = JSON.parse(await readFile(path, "utf8"))
  data.sources.find(
    (source: { path: string }) => source.path === f.relative,
  ).ingestProvenance.path = "_meta/auth.json"
  await writeFile(path, JSON.stringify(data))
  await expect(readTask(f.vault, task.id)).rejects.toThrow(
    /Invalid task record|malformed|provenance/,
  )
})
