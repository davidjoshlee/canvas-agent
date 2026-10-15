import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { buildCoreDogfoodFlows, dogfoodCourseFingerprint } from "../../src/evaluation/core-flows.js"
import {
  createDogfood,
  type DogfoodFlow,
  type DogfoodJournal,
  runDogfood,
} from "../../src/evaluation/dogfood.js"
import { buildReviewDogfoodFlows } from "../../src/evaluation/review-flows.js"
import type { ToolkitConfig } from "../../src/shared/types.js"
import { completeTask } from "../../src/tasks/completion.js"
import { readTask } from "../../src/tasks/store.js"
import { inspectWorkspace, selectCourse } from "../../src/vault/workspace.js"

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-dogfood-flows-"))
  roots.push(root)
  const reading = "CS101/Week 01 - Oct 5/reading.md",
    prompt = "CS101/Assignments/prompt.md"
  await mkdir(join(root, "CS101/Week 01 - Oct 5"), { recursive: true })
  await mkdir(join(root, "CS101/Assignments"))
  await writeFile(join(root, reading), "Synthetic reading with substantive framework evidence.")
  await writeFile(
    join(root, prompt),
    "---\ntype: assignment\n---\nDescribe the supplied framework.",
  )
  const config: ToolkitConfig = {
    version: 1,
    canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "SYNTHETIC_DOGFOOD_TOKEN" },
    vault: { path: root },
    courses: { allowlist: [] },
  }
  const journal = await createDogfood(root, {
    course: "CS101",
    period: { kind: "week", value: "2026-10-05" },
    assignment: prompt,
  })
  return { root, config, journal, reading, prompt }
}
function flow(flows: DogfoodFlow[], name: string) {
  const result = flows.find((entry) => entry.name === name)
  if (!result) throw new Error("Missing flow")
  return result
}
async function finish(root: string, id: string) {
  const task = await readTask(root, id),
    file = join(root, "synthetic-candidate.md")
  await writeFile(
    file,
    [
      `Task: ${id}`,
      ...task.requirements.map(
        (heading) =>
          `## ${heading}\n\n${heading === "Student question" ? `> ${task.discussion?.message}` : heading === "Sources" ? task.sources.map((source) => `\`${source.path}\``).join("\n") : "Synthetic structural validator test, not student coursework."}`,
      ),
    ].join("\n\n"),
  )
  return completeTask(root, id, file)
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe("concrete first-half dogfood workflows", () => {
  it("executes all ten real backends across external completion, human review and explicit approval", async () => {
    const { root, config, journal, reading, prompt } = await fixture()
    const sourceBytes = await Promise.all(
      [reading, prompt].map((path) => readFile(join(root, path))),
    )
    const humanVerdicts: Record<string, "pass" | "fail"> = {},
      approveTaskIds: string[] = []
    const input = { config, offline: true, humanVerdicts, approveTaskIds }
    let current = journal,
      originalDraft: Buffer | undefined
    for (let attempt = 0; attempt < 20; attempt++) {
      current = await runDogfood(root, journal.id, journal.target, [
        ...buildCoreDogfoodFlows(input),
        ...buildReviewDogfoodFlows(input),
      ])
      const last = current.flows.at(-1)
      expect(last?.status).not.toBe("fail")
      if (current.flows.length === 10) break
      const id = last?.data.taskId ?? ""
      expect(id).not.toBe("")
      if (last?.status === "pending-host") {
        const completed = await finish(root, id)
        if (last.name === "draft") originalDraft = await readFile(join(root, completed.output))
      } else if (last?.name === "approve") {
        expect(last.status).toBe("pending-human")
        await expect(readdir(join(root, "CS101/Assignments/Finals"))).rejects.toThrow()
        approveTaskIds.push(id)
      } else {
        expect(last?.status).toBe("pending-human")
        humanVerdicts[id] = "pass"
      }
    }
    expect(current.flows).toHaveLength(10)
    expect(current.flows.map((result) => result.status)).toEqual([
      "skipped",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "skipped",
    ])
    const draftId = current.flows[4]?.data.taskId ?? ""
    const draft = await readTask(root, draftId)
    expect(await readFile(join(root, draft.output ?? ""))).toEqual(originalDraft)
    for (let index = 0; index < 2; index++)
      expect(await readFile(join(root, [reading, prompt][index] ?? ""))).toEqual(sourceBytes[index])
    const resumed = await runDogfood(root, journal.id, journal.target, [
      ...buildCoreDogfoodFlows(input),
      ...buildReviewDogfoodFlows(input),
    ])
    expect(resumed).toEqual(current)
    const approval = current.flows[6]
    expect(approval?.data.output).toContain("/Finals/")
    await writeFile(join(root, approval?.data.output ?? ""), "Changed final artifact.")
    const failed = await runDogfood(root, journal.id, journal.target, [
      ...buildCoreDogfoodFlows(input),
      ...buildReviewDogfoodFlows(input),
    ])
    expect(failed.flows).toHaveLength(7)
    expect(failed.flows[6]?.status).toBe("fail")
    expect(await readFile(join(root, approval?.data.output ?? ""), "utf8")).toBe(
      "Changed final artifact.",
    )
  })
  it("preserves synthetic renewal evidence, reports real gap counts and delegates costs explicitly", async () => {
    const { root, config, journal } = await fixture()
    const review = buildReviewDogfoodFlows({ config })
    const auth = flow(review, "token-renewal alert")
    const alert = await auth.run(undefined, journal)
    expect(alert.status).toBe("pass")
    expect(alert.evidence).toContain("real auth untouched")
    const saved = JSON.parse(await readFile(join(root, alert.data.path ?? ""), "utf8"))
    expect(saved).toMatchObject({
      synthetic: true,
      status: { renewal: "expired" },
      notification: "local record only; no OS notifier tested",
    })
    expect(await auth.validate(alert, journal)).toBe(true)
    await writeFile(join(root, alert.data.path ?? ""), "Changed alert.")
    expect(await auth.validate(alert, journal)).toBe(false)
    await expect(auth.run(alert, journal)).rejects.toThrow(/changed/)
    await writeFile(join(root, "CS101/empty.md"), "")
    expect((await flow(review, "gaps re-check").run(undefined, journal)).data.empty).toBe("1")
    const cost = await flow(review, "cost report").run(undefined, journal)
    expect(cost.status).toBe("skipped")
    expect(cost.data.owner).toBe("host")
    expect(cost.evidence).not.toContain("totalCost")
  })
  it("keeps live sync opt-in, distinguishes offline skipping, and blocks unallowlisted scope", async () => {
    const { config, journal } = await fixture()
    const waiting = await flow(buildCoreDogfoodFlows({ config }), "sync").run(undefined, journal)
    expect(waiting.status).toBe("pending-host")
    const offline = flow(buildCoreDogfoodFlows({ config, offline: true }), "sync")
    const result = await offline.run(undefined, journal)
    expect(result.status).toBe("skipped")
    expect(await offline.validate(result, journal)).toBe(true)
    expect(
      await flow(buildCoreDogfoodFlows({ config, syncAuthorized: true }), "sync").validate(
        result,
        journal,
      ),
    ).toBe(false)
    await expect(
      flow(buildCoreDogfoodFlows({ config, syncAuthorized: true }), "sync").run(undefined, journal),
    ).rejects.toThrow(/allowlisted/)
    expect(() => buildCoreDogfoodFlows({ config, offline: true, syncAuthorized: true })).toThrow(
      /not both/,
    )
  })
  it("binds an explicit host export with unknown totals and revalidates its original period and bytes", async () => {
    const { root, config, journal } = await fixture()
    const file = join(root, "host-usage.json")
    const bytes = JSON.stringify({
      version: 1,
      host: "Synthetic-host",
      rows: [
        {
          id: "row-one",
          at: new Date().toISOString(),
          function: "prep",
          model: "synthetic/model",
          source: "estimated",
          costUsd: "0.000000001",
        },
        {
          id: "row-two",
          at: new Date().toISOString(),
          function: "draft",
          model: "synthetic/model",
          source: "host-reported",
        },
      ],
    })
    await writeFile(file, bytes)
    const cost = flow(buildReviewDogfoodFlows({ config, hostUsageFile: file }), "cost report")
    const result = await cost.run(undefined, journal)
    expect(result.status).toBe("pass")
    expect(result.data).toMatchObject({
      rows: "2",
      totalCostUsd: "unknown",
      knownCostSubtotalUsd: "0.000000001",
      missingCostRows: "1",
      scope: "supplied-export-not-run-attributed",
      authoritativeBillingVerified: "false",
    })
    expect(JSON.stringify(result)).not.toContain("row-one")
    expect(await readFile(file, "utf8")).toBe(bytes)
    const resumed = flow(buildReviewDogfoodFlows({ config }), "cost report")
    expect(await resumed.validate(result, journal)).toBe(true)
    expect(await resumed.run(result, journal)).toEqual(result)
    const skipped = await resumed.run(undefined, journal)
    expect(await cost.validate(skipped, journal)).toBe(false)
    await writeFile(file, bytes.replace("0.000000001", "0.000000002"))
    await expect(resumed.validate(result, journal)).rejects.toThrow(/changed/)
    await writeFile(file, bytes)
    expect(await resumed.validate(result, journal)).toBe(true)
    await expect(
      flow(
        buildReviewDogfoodFlows({ config, hostUsageFile: join(root, "different.json") }),
        "cost report",
      ).run(result, journal),
    ).rejects.toThrow(/choice changed/)
  })
  it("reuses scope-bound sweep sync evidence and refuses changed fingerprints", async () => {
    const { root, config, journal } = await fixture()
    const course = selectCourse(await inspectWorkspace(root), "CS101")
    const preSynced = { fingerprint: dogfoodCourseFingerprint(course), written: 2, notices: 1 }
    const shared = flow(buildCoreDogfoodFlows({ config, syncAuthorized: true, preSynced }), "sync")
    const result = await shared.run(undefined, journal)
    expect(result.status).toBe("pass")
    expect(result.data).toMatchObject({ written: "2", notices: "1" })
    expect(result.evidence).toContain("synced once")
    await writeFile(join(root, "CS101/Week 01 - Oct 5/reading.md"), "Changed synced reading.")
    expect(await shared.validate(result, journal)).toBe(false)
    await expect(shared.run(result, journal)).rejects.toThrow(/sync evidence changed/)
  })
  it("checks timeline and preserves a private operational note without activating guidance", async () => {
    const { root, config, journal, prompt } = await fixture()
    const concrete = buildCoreDogfoodFlows({ config, offline: true })
    const timeline = flow(concrete, "timeline"),
      note = flow(concrete, "guidance note")
    const view = await timeline.run(undefined, journal)
    expect(view.data.undated).toBe("1")
    expect(await timeline.validate(view, journal)).toBe(true)
    const result = await note.run(undefined, journal)
    expect(await note.validate(result, journal)).toBe(true)
    expect(await note.run(result, journal)).toEqual(result)
    await expect(readdir(join(root, "CS101/Guidance"))).rejects.toThrow()
    await writeFile(join(root, result.data.path ?? ""), "Changed owned note.")
    expect(await note.validate(result, journal)).toBe(false)
    await expect(note.run(result, journal)).rejects.toThrow(/owned content/)
    expect(await readFile(join(root, prompt), "utf8")).toContain("Describe the supplied")
  })
  it.each(["prep brief", "draft"] as const)(
    "runs %s through pending host, human verdict and source/output revalidation",
    async (name) => {
      const { root, config, journal, reading, prompt } = await fixture()
      const current = flow(buildCoreDogfoodFlows({ config, offline: true }), name)
      const pending = await current.run(undefined, journal)
      expect(pending.status).toBe("pending-host")
      expect(await current.run(pending, journal)).toEqual(pending)
      const id = pending.data.taskId ?? ""
      if (name === "draft") expect((await readTask(root, id)).assignment?.source).toBe(prompt)
      const completion = await finish(root, id)
      const human = await current.run(pending, journal)
      expect(human.status).toBe("pending-human")
      const reviewed = flow(
        buildCoreDogfoodFlows({ config, offline: true, humanVerdicts: { [id]: "pass" } }),
        name,
      )
      const passed = await reviewed.run(human, journal)
      expect(passed.status).toBe("pass")
      expect(await current.validate(passed, journal)).toBe(true)
      const rejected = flow(
        buildCoreDogfoodFlows({ config, humanVerdicts: { [id]: "fail" } }),
        name,
      )
      expect((await rejected.run(human, journal)).status).toBe("fail")
      const wrongScope: DogfoodJournal = {
        ...journal,
        target: {
          ...journal.target,
          period: { kind: "week", value: "2026-10-12" },
          assignment: "missing",
        },
      }
      await expect(current.run(passed, wrongScope)).rejects.toThrow()
      const unchanged = await readFile(join(root, completion.output))
      await writeFile(join(root, completion.output), "Changed saved output.")
      await expect(current.validate(passed, journal)).rejects.toThrow()
      await writeFile(join(root, completion.output), unchanged)
      await writeFile(
        join(root, name === "prep brief" ? reading : prompt),
        "Changed source after generation.",
      )
      await expect(current.validate(passed, journal)).rejects.toThrow()
    },
  )
  it("skips assignment generation only for an explicitly prep-only target", async () => {
    const { root, config, journal } = await fixture()
    const draft = flow(buildCoreDogfoodFlows({ config, offline: true }), "draft")
    const prepOnly = { ...journal, target: { ...journal.target, assignment: null } }
    const skipped = await draft.run(undefined, prepOnly)
    expect(skipped.status).toBe("skipped")
    await expect(readdir(join(root, "_meta/tasks"))).rejects.toThrow()
    expect(await draft.validate(skipped, prepOnly)).toBe(true)
  })
})
