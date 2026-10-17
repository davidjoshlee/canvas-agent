import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { TaskRecord } from "../../src/shared/types.js"
import { completeTask } from "../../src/tasks/artifacts/completion.js"
import { resolveRequirements } from "../../src/tasks/authoring/requirements.js"
import { workflowForRequirements } from "../../src/tasks/authoring/workflows.js"
import { createAssignmentTask, createPrepTask, readTask } from "../../src/tasks/store.js"

const roots: string[] = [],
  source = "MBA101/Week 01 - Oct 5/case.md",
  prompt = "MBA101/Assignments/Undated - Analysis/00 Prompt.md"
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-parser-compat-"))
  roots.push(root)
  await mkdir(dirname(join(root, source)), { recursive: true })
  await writeFile(
    join(root, source),
    "<h2>Preparation questions</h2><ol><li>What explains the strategic choice?</li></ol><p>The case identifies costly entry as the binding constraint.</p>",
  )
  await mkdir(dirname(join(root, prompt)), { recursive: true })
  await writeFile(
    join(root, prompt),
    "---\ncanvas_id: '22'\ntype: assignments\ndates:\n  session_at: '2026-10-05'\n---\nAnalyze entry costs.",
  )
  return root
}
const taskPath = (root: string, id: string) => join(root, "_meta/tasks", id, "task.json")
async function oldCapture(root: string, task: TaskRecord, recipe: 1 | 2 = 1) {
  const old = JSON.parse(JSON.stringify(task)) as TaskRecord
  delete old.parserVersion
  delete old.groupScopeVersion
  delete old.deliverable
  delete old.deliverableParserVersion
  delete old.deliverableScopeVersion
  delete old.guidanceSelectionVersion
  delete old.assignmentStructureVersion
  delete old.answerEvidenceVersion
  const req = resolveRequirements({
    kind: old.kind,
    mode: old.assignment?.mode,
    sources: old.sources,
    guidance: old.guidance,
    parserVersion: recipe,
  })
  old.questions = req.questions
  delete old.hostExecutionVersion
  old.workflow = workflowForRequirements({
    kind: old.kind,
    mode: old.assignment?.mode,
    sections: req.sections,
    questions: req.questions,
    guidanceInstructions: req.guidanceInstructions,
    version: 2,
  })
  old.requirements = old.workflow.requiredSections
  await writeFile(taskPath(root, old.id), JSON.stringify(old))
  return old
}
async function candidate(root: string, task: TaskRecord, answers = false) {
  const path = join(root, "candidate.md"),
    cite = `\`${task.sources[0]?.path}\``
  const content = task.requirements.map(
    (heading) =>
      `## ${heading}\nA synthetic response identifies entry costs and explains the evidence without overstating certainty. ${cite}${answers && /Preparation questions/.test(heading) ? (task.questions ?? []).map((q) => `\n### ${q}\nThe supplied case identifies costly entry as a constraint on feasible strategy, so the response compares entry alternatives using that evidence. ${cite}`).join("") : ""}`,
  )
  await writeFile(path, [`Task: ${task.id}`, ...content].join("\n\n"))
  return path
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe("saved parser recipe compatibility", () => {
  it("retains an explicit v2 draft workflow without silently injecting v3 outcomes", async () => {
    const root = await fixture()
    const task = await createAssignmentTask(root, {
      courseQuery: "MBA101",
      sourcePath: prompt,
      mode: "draft",
    })
    expect(task.workflow?.version).toBe(3)
    delete task.groupScopeVersion
    delete task.deliverable
    delete task.deliverableParserVersion
    delete task.deliverableScopeVersion
    delete task.guidanceSelectionVersion
    delete task.assignmentStructureVersion
    const req = resolveRequirements({
      kind: task.kind,
      mode: task.assignment?.mode,
      sources: task.sources,
      guidance: task.guidance,
      parserVersion: 2,
    })
    delete task.hostExecutionVersion
    task.workflow = workflowForRequirements({
      kind: task.kind,
      mode: task.assignment?.mode,
      sections: req.sections,
      questions: req.questions,
      guidanceInstructions: req.guidanceInstructions,
      version: 2,
    })
    const bytes = JSON.stringify(task)
    const handoffPath = join(root, "_meta/tasks", task.id, "TASK.md")
    const handoff = (await readFile(handoffPath, "utf8")).replace(
      /(## Workflow instructions\r?\n)[\s\S]*?(?=## Source snapshots)/,
      (_match, prefix: string) =>
        `${prefix}\n${task.workflow?.instructions.map((instruction) => `- ${instruction}`).join("\n")}\n\n`,
    )
    await writeFile(taskPath(root, task.id), bytes)
    await writeFile(handoffPath, handoff)
    const read = await readTask(root, task.id)
    expect(read.workflow?.version).toBe(2)
    expect(read.workflow?.instructions.join(" ")).not.toContain("actual finished deliverable")
    expect(await readFile(taskPath(root, task.id), "utf8")).toBe(bytes)
    expect(await readFile(join(root, "_meta/tasks", task.id, "TASK.md"), "utf8")).toBe(handoff)
    await expect(completeTask(root, task.id, await candidate(root, task))).resolves.toMatchObject({
      task: { status: "completed" },
    })
  })
  it("resolves current week using the host-local calendar near a UTC Monday boundary", async () => {
    const prior = process.env.TZ
    process.env.TZ = "America/Los_Angeles"
    try {
      const root = await fixture()
      const task = await createPrepTask(root, "MBA101", "current", {
        now: new Date("2026-10-12T01:00:00Z"),
      })
      expect(task.week).toBe("2026-10-05")
    } finally {
      if (prior === undefined) delete process.env.TZ
      else process.env.TZ = prior
    }
  })
  it("reads and completes pre-HTML unversioned tasks without rewriting captured questions", async () => {
    const root = await fixture(),
      old = await oldCapture(root, await createPrepTask(root, "MBA101", "2026-10-05"))
    expect(old.questions).toEqual([])
    const bytes = await readFile(taskPath(root, old.id))
    expect((await readTask(root, old.id)).questions).toEqual([])
    expect(await readFile(taskPath(root, old.id))).toEqual(bytes)
    await expect(completeTask(root, old.id, await candidate(root, old))).resolves.toMatchObject({
      task: { status: "completed" },
    })
  })
  it("retains question gates for transitional unversioned HTML-aware tasks", async () => {
    const root = await fixture(),
      old = await oldCapture(root, await createPrepTask(root, "MBA101", "2026-10-05"), 2)
    expect((await readTask(root, old.id)).questions).toEqual([
      "What explains the strategic choice?",
    ])
    await expect(completeTask(root, old.id, await candidate(root, old))).rejects.toThrow(
      /question/i,
    )
    await expect(
      completeTask(root, old.id, await candidate(root, old, true)),
    ).resolves.toMatchObject({ task: { status: "completed" } })
  })
  it("makes new tasks explicitly HTML-aware and rejects a changed question list or unsupported parser", async () => {
    const root = await fixture(),
      task = await createPrepTask(root, "MBA101", "2026-10-05")
    expect(task.parserVersion).toBe(2)
    await writeFile(taskPath(root, task.id), JSON.stringify({ ...task, questions: [] }))
    await expect(readTask(root, task.id)).rejects.toThrow(/question requirements were modified/)
    await writeFile(taskPath(root, task.id), JSON.stringify({ ...task, parserVersion: 3 }))
    await expect(readTask(root, task.id)).rejects.toThrow(/Invalid task record/)
  })
  it("tolerates legacy title/date annotations but still checks exact source bodies and hashes", async () => {
    const root = await fixture(),
      old = await oldCapture(
        root,
        await createAssignmentTask(root, {
          courseQuery: "MBA101",
          sourcePath: prompt,
          mode: "outline",
        }),
      )
    const oldSource = old.sources[0]
    if (!oldSource) throw new Error("Missing fixture source")
    old.sources[0] = { ...oldSource, title: "00 Prompt", dates: [] }
    await writeFile(taskPath(root, old.id), JSON.stringify(old))
    await expect(completeTask(root, old.id, await candidate(root, old))).resolves.toMatchObject({
      task: { status: "completed" },
    })
    const altered = await oldCapture(
      root,
      await createAssignmentTask(root, {
        courseQuery: "MBA101",
        sourcePath: prompt,
        mode: "outline",
      }),
    )
    const alteredSource = altered.sources[0]
    if (!alteredSource) throw new Error("Missing fixture source")
    altered.sources[0] = {
      ...alteredSource,
      text: "Forged evidence that was not in the source.",
    }
    await writeFile(taskPath(root, altered.id), JSON.stringify(altered))
    await expect(completeTask(root, altered.id, await candidate(root, altered))).rejects.toThrow(
      /stale/,
    )
  })
  it("never treats genuinely changed files as a mere parser update", async () => {
    const root = await fixture(),
      old = await oldCapture(root, await createPrepTask(root, "MBA101", "2026-10-05"))
    await writeFile(join(root, source), "Changed source evidence.")
    await expect(completeTask(root, old.id, await candidate(root, old))).rejects.toThrow(/stale/)
  })
})
