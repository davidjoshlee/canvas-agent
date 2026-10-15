import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { captureSimulation } from "../../src/evaluation/captures.js"
import {
  completeSimulationTask,
  createSimulationTask,
  readSimulationTask,
} from "../../src/evaluation/tasks.js"
import type { TaskRecord } from "../../src/shared/types.js"
import { completeTask } from "../../src/tasks/completion.js"
import { detectDeliverable } from "../../src/tasks/deliverable.js"
import { captureTaskDeliverable } from "../../src/tasks/deliverable-evidence.js"
import { resolveRequirements } from "../../src/tasks/requirements.js"
import { createAssignmentTask, createPrepTask, readTask } from "../../src/tasks/store.js"
import { workflowForRequirements } from "../../src/tasks/workflows.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const prompt = "CS101/Assignments/prompt.md"
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-task-deliverables-"))
  roots.push(root)
  await mkdir(join(root, "CS101/Assignments"), { recursive: true })
  await writeFile(
    join(root, prompt),
    "---\ntype: assignment\navailable_at: 2026-10-05\n---\nRequired: 1. Calculate baseline contribution. 2. Explain the demand uncertainty.\n",
  )
  await mkdir(join(root, "CS101/guidance"), { recursive: true })
  await writeFile(
    join(root, "CS101/guidance/prep-guidance.md"),
    "---\navailable_at: 2026-10-05\n---\nSynthetic engineering test explicitly permits AI drafting, prep and review.\n",
  )
  return root
}
async function candidate(root: string, task: TaskRecord, includeItems: boolean) {
  const path = join(root, "candidate.md")
  const cite = `\`${task.sources[0]?.path}\``
  const items =
    includeItems && task.deliverable && task.deliverable.kind !== "none"
      ? task.deliverable.items
          .map(
            (item) =>
              `### ${item.text}\nPENDING — requires the missing numerical inputs or demand evidence before a grounded answer can be produced. ${cite}`,
          )
          .join("\n\n")
      : ""
  await writeFile(
    path,
    [
      `Task: ${task.id}`,
      ...task.requirements.map(
        (section, index) =>
          `## ${section}\n\nSynthetic structural response cites the supplied evidence and does not claim an academic verdict. ${cite}\n${index === 1 ? items : ""}`,
      ),
    ].join("\n\n"),
  )
  return path
}

it("binds imperative deliverables in ordinary tasks, exposes them through compiled CLI and rejects omissions/tampering", async () => {
  const root = await fixture()
  const task = await createAssignmentTask(root, "CS101", prompt, "draft")
  expect(task.deliverable).toMatchObject({
    version: 1,
    kind: "requirements",
    sourcePath: prompt,
    items: [
      { id: "1", text: "Calculate baseline contribution." },
      { id: "2", text: "Explain the demand uncertainty." },
    ],
  })
  expect(task.workflow?.instructions.join("\n")).toContain("untrusted source-derived data")
  await expect(readTask(root, task.id)).resolves.toEqual(task)
  await expect(completeTask(root, task.id, await candidate(root, task, false))).rejects.toThrow(
    /subheading/,
  )
  const config = join(root, "config.json")
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "CANVAS_UNUSED_TOKEN" },
      vault: { path: root },
      courses: { allowlist: [] },
    }),
  )
  const result = spawnSync(
    process.execPath,
    [resolve("dist/cli.js"), "task", "show", task.id, "--config", config, "--json"],
    { cwd: root, encoding: "utf8" },
  )
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).deliverable).toEqual(task.deliverable)
  const record = join(root, "_meta/tasks", task.id, "task.json")
  const bytes = await readFile(record)
  const changed = JSON.parse(bytes.toString())
  changed.deliverable.items[0].text = "Altered requirement"
  await writeFile(record, JSON.stringify(changed))
  await expect(readTask(root, task.id)).rejects.toThrow(/Invalid task record/)
  await writeFile(record, bytes)
  await expect(
    completeTask(root, task.id, await candidate(root, task, true)),
  ).resolves.toHaveProperty("output")
})

it("versions imperative-question cues and rubric boundaries while preserving an earlier ordinary recipe", async () => {
  const root = await fixture()
  const text =
    "Answer these questions:\n1. Calculate the baseline.\n2. Explain the rubric: distinguish assumptions from results.\n3. Recommend a test.\n\nRubric: use supplied evidence."
  await writeFile(
    join(root, prompt),
    `---\ntype: assignment\navailable_at: 2026-10-05\n---\n${text}`,
  )
  expect(detectDeliverable([{ path: prompt, text }])).toEqual({ kind: "none" })
  expect(detectDeliverable([{ path: prompt, text }], undefined, 2)).toMatchObject({
    kind: "questions",
    items: [
      { text: "Calculate the baseline." },
      { text: "Explain the rubric: distinguish assumptions from results." },
      { text: "Recommend a test." },
    ],
  })
  expect(
    detectDeliverable(
      [
        {
          path: prompt,
          text: "The following facts were observed: 1. Revenue was recorded. 2. Costs were recorded.",
        },
      ],
      undefined,
      2,
    ),
  ).toEqual({ kind: "none" })
  const task = await createAssignmentTask(root, "CS101", prompt, "draft")
  expect(task.deliverableParserVersion).toBe(3)
  await expect(completeTask(root, task.id, await candidate(root, task, false))).rejects.toThrow(
    /subheading/,
  )
  await expect(
    completeTask(root, task.id, await candidate(root, task, true)),
  ).resolves.toHaveProperty("output")
  // A coherent earlier detector recipe stays empty and byte-identical on read.
  const old = await createAssignmentTask(root, "CS101", prompt, "outline")
  delete old.deliverableParserVersion
  old.deliverable = captureTaskDeliverable(
    old.kind,
    old.assignment?.mode,
    old.sources,
    old.guidance,
    old.deliverableScopeVersion,
  )
  const requirements = resolveRequirements(
    old.kind,
    old.assignment?.mode,
    old.sources,
    old.guidance,
    2,
    old.deliverable,
  )
  old.questions = requirements.questions
  old.workflow = workflowForRequirements(
    old.kind,
    old.assignment?.mode,
    old.requirements,
    old.questions,
    requirements.guidanceInstructions,
    3,
    old.deliverable,
  )
  const path = join(root, "_meta/tasks", old.id, "task.json")
  const bytes = JSON.stringify(old)
  await writeFile(path, bytes)
  expect((await readTask(root, old.id)).deliverable).toEqual({
    version: 1,
    kind: "none",
    suppressed: false,
  })
  expect(await readFile(path, "utf8")).toBe(bytes)
})

it("freezes the new imperative-question recipe without live enrichment or rewriting an older evaluation", async () => {
  const root = await fixture()
  await writeFile(
    join(root, prompt),
    "---\ntype: assignment\navailable_at: 2026-10-05\n---\nAnswer these questions: 1. Calculate baseline. 2. Explain limitations.",
  )
  const capture = await captureSimulation(root, "CS101", "2026-10-09")
  await writeFile(join(root, prompt), "Required: 1. NEW_LIVE_QUESTION.")
  const created = await createSimulationTask(root, capture.id, {
    kind: "assignment",
    source: prompt,
    mode: "outline",
  })
  const record = await readSimulationTask(root, created.id)
  expect(record.deliverableParserVersion).toBe(3)
  expect(record.task.deliverableParserVersion).toBe(3)
  expect(record.task.deliverable).toMatchObject({
    kind: "questions",
    items: [{ text: "Calculate baseline." }, { text: "Explain limitations." }],
  })
  await expect(
    completeSimulationTask(root, created.id, await candidate(root, record.task, false)),
  ).rejects.toThrow(/subheading/)
  const path = join(root, "_meta/simulations/tasks", created.id, "record.json")
  const changed = JSON.parse(await readFile(path, "utf8"))
  delete changed.deliverableParserVersion
  await writeFile(path, JSON.stringify(changed))
  await expect(readSimulationTask(root, created.id)).rejects.toThrow()
  delete record.deliverableParserVersion
  delete record.task.deliverableParserVersion
  record.task.deliverable = captureTaskDeliverable(
    record.task.kind,
    record.task.assignment?.mode,
    record.task.sources,
    record.task.guidance,
    record.task.deliverableScopeVersion,
  )
  const requirements = resolveRequirements(
    record.task.kind,
    record.task.assignment?.mode,
    record.task.sources,
    record.task.guidance,
    2,
    record.task.deliverable,
  )
  record.task.questions = requirements.questions
  record.task.workflow = workflowForRequirements(
    record.task.kind,
    record.task.assignment?.mode,
    record.task.requirements,
    requirements.questions,
    requirements.guidanceInstructions,
    3,
    record.task.deliverable,
  )
  const bytes = JSON.stringify(record)
  await writeFile(path, bytes)
  expect((await readSimulationTask(root, created.id)).task.deliverable).toEqual({
    version: 1,
    kind: "none",
    suppressed: false,
  })
  expect(await readFile(path, "utf8")).toBe(bytes)
})

it("rederives frozen deliverables solely from captured evidence and refuses changed recipes", async () => {
  const root = await fixture()
  const snapshot = await captureSimulation(root, "CS101", "2026-10-09")
  await writeFile(join(root, prompt), "Required: 1. NEWER LIVE REQUIREMENT.")
  const created = await createSimulationTask(root, snapshot.id, {
    kind: "assignment",
    source: prompt,
    mode: "draft",
  })
  const record = await readSimulationTask(root, created.id)
  expect(record.deliverableVersion).toBe(1)
  expect(record.task.deliverable).toMatchObject({
    kind: "requirements",
    items: [
      { text: "Calculate baseline contribution." },
      { text: "Explain the demand uncertainty." },
    ],
  })
  await expect(
    completeSimulationTask(root, created.id, await candidate(root, record.task, false)),
  ).rejects.toThrow(/subheading/)
  const path = join(root, "_meta/simulations/tasks", created.id, "record.json")
  const bytes = await readFile(path)
  const changed = JSON.parse(bytes.toString())
  changed.task.deliverable.items[0].id = "99"
  await writeFile(path, JSON.stringify(changed))
  await expect(readSimulationTask(root, created.id)).rejects.toThrow()
  await writeFile(path, bytes)
  await expect(
    completeSimulationTask(root, created.id, await candidate(root, record.task, true)),
  ).resolves.toMatchObject({ verdict: "pending-human" })
})

it("honors active suppression for fresh prep and frozen tasks, without rewriting an earlier recipe", async () => {
  const root = await fixture()
  await mkdir(join(root, "CS101/Week 01 - Oct 5"), { recursive: true })
  await writeFile(
    join(root, "CS101/Week 01 - Oct 5/questions.md"),
    "---\navailable_at: 2026-10-05\n---\n# Preparation Questions\n1. Why test demand?\n2. Explain the counterfactual.\n",
  )
  const prior = await createPrepTask(root, "CS101", "2026-10-05")
  expect(prior.deliverable).toHaveProperty("kind", "questions")
  const oldPath = join(root, "_meta/tasks", prior.id, "task.json")
  const oldBytes = await readFile(oldPath)
  await writeFile(
    join(root, "CS101/guidance/prep-guidance.md"),
    "---\navailable_at: 2026-10-05\n---\n## Deliverable\nnone\n\n## Permission\nSynthetic engineering test permits AI prep.\n",
  )
  const suppressed = await createPrepTask(root, "CS101", "2026-10-05")
  expect(suppressed.deliverable).toEqual({ version: 1, kind: "none", suppressed: true })
  expect(suppressed.questions).toEqual([])
  expect(await readFile(oldPath)).toEqual(oldBytes)
  const snapshot = await captureSimulation(root, "CS101", "2026-10-09")
  const frozen = await createSimulationTask(root, snapshot.id, { kind: "prep", week: "2026-10-05" })
  expect((await readSimulationTask(root, frozen.id)).task.deliverable).toEqual(
    suppressed.deliverable,
  )
})

it("detects deliverables in explicitly selected case material regardless of its filename", async () => {
  const root = await fixture()
  await writeFile(join(root, prompt), "Complete the task in the attached case material.")
  const attachment = "CS101/case-material.md"
  await writeFile(
    join(root, attachment),
    "Required: 1. Analyze the supplied case evidence. 2. Explain what remains unknown.",
  )
  const task = await createAssignmentTask(root, "CS101", prompt, "draft", undefined, [attachment])
  expect(task.deliverable).toMatchObject({
    kind: "requirements",
    sourcePath: attachment,
    items: [
      { text: "Analyze the supplied case evidence." },
      { text: "Explain what remains unknown." },
    ],
  })
  await expect(readTask(root, task.id)).resolves.toEqual(task)
})

it("keeps a coherent earlier v3 recipe unenriched and preserves mode boundaries", async () => {
  const root = await fixture()
  const old = await createAssignmentTask(root, "CS101", prompt, "draft")
  delete old.deliverable
  delete old.deliverableParserVersion
  delete old.deliverableScopeVersion
  old.workflow = workflowForRequirements(
    "assignment",
    "draft",
    old.requirements,
    old.questions ?? [],
    [],
    3,
  )
  const path = join(root, "_meta/tasks", old.id, "task.json")
  const bytes = JSON.stringify(old)
  await writeFile(path, bytes)
  await expect(readTask(root, old.id)).resolves.toEqual(old)
  expect(await readFile(path, "utf8")).toBe(bytes)
  await expect(
    completeTask(root, old.id, await candidate(root, old, false)),
  ).resolves.toHaveProperty("output")
  const outline = await createAssignmentTask(root, "CS101", prompt, "outline")
  expect(outline.workflow?.instructions.join(" ")).toContain(
    "Map each item to the planned response",
  )
  const discuss = await createAssignmentTask(
    root,
    "CS101",
    prompt,
    "discuss",
    undefined,
    [],
    undefined,
    "What does baseline mean?",
  )
  expect(discuss.deliverable).toEqual({ version: 1, kind: "none", suppressed: false })
})

async function multipartFixture() {
  const root = await fixture()
  const attachment = "CS101/questions.md"
  await writeFile(
    join(root, prompt),
    "---\ntype: assignment\navailable_at: 2026-10-05\n---\nComplete PART II of the attached case.",
  )
  await writeFile(
    join(root, attachment),
    "---\navailable_at: 2026-10-05\n---\nRequired: PART I: 1. Why ignore sunk costs? PART II: 1. Calculate baseline contribution. 2. Why test demand?",
  )
  return { root, attachment }
}

it("scopes an attached case from the unique prompt part and preserves previously unscoped evidence", async () => {
  const { root, attachment } = await multipartFixture()
  const task = await createAssignmentTask(root, "CS101", prompt, "draft", undefined, [attachment])
  expect(task.deliverableScopeVersion).toBe(1)
  expect(task.deliverable).toMatchObject({
    scope: "PART II",
    items: [
      { id: "1", text: "Calculate baseline contribution." },
      { id: "2", text: "Why test demand?" },
    ],
  })
  expect(task.questions).toEqual(["Why test demand?"])
  await expect(readTask(root, task.id)).resolves.toEqual(task)
  const path = join(root, "_meta/tasks", task.id, "task.json")
  const original = await readFile(path)
  const changed = JSON.parse(original.toString())
  changed.deliverable.scope = "PART I"
  await writeFile(path, JSON.stringify(changed))
  await expect(readTask(root, task.id)).rejects.toThrow()
  await writeFile(path, original)
  await expect(
    completeTask(root, task.id, await candidate(root, task, true)),
  ).resolves.toHaveProperty("output")
  // Synthetic earlier deliverable-v1 record: it captured every part, without
  // the later scope recipe. Reading it must not retroactively narrow its inputs.
  const old = await createAssignmentTask(root, "CS101", prompt, "outline", undefined, [attachment])
  delete old.deliverableScopeVersion
  old.deliverable = captureTaskDeliverable(
    old.kind,
    old.assignment?.mode,
    old.sources,
    old.guidance,
  )
  const requirements = resolveRequirements(
    old.kind,
    old.assignment?.mode,
    old.sources,
    old.guidance,
    2,
    old.deliverable,
  )
  old.questions = requirements.questions
  old.workflow = workflowForRequirements(
    old.kind,
    old.assignment?.mode,
    old.requirements,
    old.questions,
    requirements.guidanceInstructions,
    3,
    old.deliverable,
  )
  const oldPath = join(root, "_meta/tasks", old.id, "task.json")
  const bytes = JSON.stringify(old)
  await writeFile(oldPath, bytes)
  await expect(readTask(root, old.id)).resolves.toEqual(old)
  expect(old.deliverable).not.toHaveProperty("scope")
  expect(
    old.deliverable.kind !== "none" &&
      old.deliverable.items.some((item) => item.text.includes("sunk costs")),
  ).toBe(true)
  expect(await readFile(oldPath, "utf8")).toBe(bytes)
})

it("pins frozen part scope to the captured prompt rather than a later live edit", async () => {
  const { root, attachment } = await multipartFixture()
  const snapshot = await captureSimulation(root, "CS101", "2026-10-09")
  await writeFile(join(root, prompt), "Complete PART I instead.")
  const created = await createSimulationTask(root, snapshot.id, {
    kind: "assignment",
    source: prompt,
    mode: "draft",
    context: [attachment],
  })
  const record = await readSimulationTask(root, created.id)
  expect(record.deliverableScopeVersion).toBe(1)
  expect(record.task.deliverable).toMatchObject({
    scope: "PART II",
    items: [{ text: "Calculate baseline contribution." }, { text: "Why test demand?" }],
  })
  expect(record.task.questions).toEqual(["Why test demand?"])
  await expect(
    completeSimulationTask(root, created.id, await candidate(root, record.task, true)),
  ).resolves.toMatchObject({ verdict: "pending-human" })
})

it("never narrows multiple named parts to the first or guesses missing/numeric scopes", async () => {
  const { root, attachment } = await multipartFixture()
  await writeFile(join(root, prompt), "Complete PART I and PART II.")
  const task = await createAssignmentTask(root, "CS101", prompt, "outline", undefined, [attachment])
  expect(task.deliverable).not.toHaveProperty("scope")
  expect(task.deliverable?.kind !== "none" && task.deliverable?.items).toHaveLength(3)
  await writeFile(join(root, prompt), "Complete PART III.")
  await expect(
    createAssignmentTask(root, "CS101", prompt, "draft", undefined, [attachment]),
  ).rejects.toThrow(/named part has no detected deliverable/)
  await writeFile(join(root, prompt), "Complete Part 2.")
  await expect(
    createAssignmentTask(root, "CS101", prompt, "draft", undefined, [attachment]),
  ).rejects.toThrow(/named part has no detected deliverable/)
})

it("scopes explicit numeric parts in fresh ordinary/frozen recipes while preserving parser-v2 history", async () => {
  const { root, attachment } = await multipartFixture()
  const promptText =
    "---\ntype: assignment\navailable_at: 2026-10-05\n---\nComplete Part 2 of the attached case."
  const caseText =
    "Required:\nPART 1:\n1. Explain sunk costs.\n## Part 2\n(a) Calculate baseline.\n(b) State uncertainty.\nPART 3 (due Thursday):\n1. Recommend a test."
  await writeFile(join(root, prompt), promptText)
  await writeFile(join(root, attachment), `---\navailable_at: 2026-10-05\n---\n${caseText}`)
  const task = await createAssignmentTask(root, "CS101", prompt, "draft", undefined, [attachment])
  expect(task.deliverableParserVersion).toBe(3)
  expect(task.deliverable).toMatchObject({
    scope: "PART 2",
    items: [
      { id: "a", text: "Calculate baseline." },
      { id: "b", text: "State uncertainty." },
    ],
  })
  expect(JSON.stringify(task.deliverable)).not.toMatch(/sunk costs|Recommend a test/)
  await expect(completeTask(root, task.id, await candidate(root, task, false))).rejects.toThrow(
    /subheading/,
  )
  await expect(
    completeTask(root, task.id, await candidate(root, task, true)),
  ).resolves.toHaveProperty("output")
  const earlier = await createAssignmentTask(root, "CS101", prompt, "outline", undefined, [
    attachment,
  ])
  earlier.deliverableParserVersion = 2
  delete earlier.deliverableScopeVersion
  earlier.deliverable = captureTaskDeliverable(
    earlier.kind,
    earlier.assignment?.mode,
    earlier.sources,
    earlier.guidance,
    undefined,
    2,
  )
  const oldRequirements = resolveRequirements(
    earlier.kind,
    earlier.assignment?.mode,
    earlier.sources,
    earlier.guidance,
    2,
    earlier.deliverable,
  )
  earlier.questions = oldRequirements.questions
  earlier.workflow = workflowForRequirements(
    earlier.kind,
    earlier.assignment?.mode,
    earlier.requirements,
    earlier.questions,
    oldRequirements.guidanceInstructions,
    3,
    earlier.deliverable,
  )
  const earlierPath = join(root, "_meta/tasks", earlier.id, "task.json")
  const earlierBytes = JSON.stringify(earlier)
  await writeFile(earlierPath, earlierBytes)
  expect((await readTask(root, earlier.id)).deliverableParserVersion).toBe(2)
  expect(JSON.stringify(earlier.deliverable)).toContain("Explain sunk costs")
  expect(await readFile(earlierPath, "utf8")).toBe(earlierBytes)
  const captured = await captureSimulation(root, "CS101", "2026-10-09")
  await writeFile(join(root, attachment), "Required: PART 2: 1. NEWER_LIVE_NUMERIC_REQUIREMENT.")
  const frozen = await createSimulationTask(root, captured.id, {
    kind: "assignment",
    source: prompt,
    mode: "draft",
    context: [attachment],
  })
  const record = await readSimulationTask(root, frozen.id)
  expect(record.deliverableParserVersion).toBe(3)
  expect(record.task.deliverable).toEqual(task.deliverable)
  await expect(
    completeSimulationTask(root, frozen.id, await candidate(root, record.task, true)),
  ).resolves.toMatchObject({ verdict: "pending-human" })
  // Historical v2 knew this cue but not numeric boundaries; retain that pure result.
  expect(() =>
    captureTaskDeliverable("assignment", "draft", task.sources, task.guidance, 1, 2),
  ).toThrow(/Numeric named parts/)
})

it("does not treat numeric prose references as section boundaries or guess missing/duplicate parts", async () => {
  const { root, attachment } = await multipartFixture()
  expect(
    detectDeliverable(
      [
        {
          path: attachment,
          text: "Required:<h2>Part 1</h2><ol><li>Explain costs.</li></ol><h2>Part 2</h2><ol><li>Recommend a test.</li></ol>",
        },
      ],
      "part 2",
      3,
    ),
  ).toMatchObject({ items: [{ text: "Recommend a test." }] })
  await writeFile(join(root, prompt), "Complete Part 2.")
  for (const text of [
    "Required: 1. Compare this evidence with the example in part 2 of the notes.",
    "Required: PART 1: 1. Explain costs. PART 3: 1. Recommend a test.",
  ]) {
    await writeFile(join(root, attachment), text)
    await expect(
      createAssignmentTask(root, "CS101", prompt, "draft", undefined, [attachment]),
    ).rejects.toThrow(/named part has no detected deliverable/)
  }
  await writeFile(
    join(root, attachment),
    "Required: PART 2: 1. Explain costs. PART 2: 1. Recommend a test.",
  )
  await expect(
    createAssignmentTask(root, "CS101", prompt, "draft", undefined, [attachment]),
  ).rejects.toThrow(/boundaries are ambiguous/)
  await writeFile(
    join(root, attachment),
    "Required: PART 1: 1. Explain costs. PART 2: 1. Recommend a test.",
  )
  await writeFile(join(root, prompt), "Complete Part 1 and Part 2.")
  const task = await createAssignmentTask(root, "CS101", prompt, "outline", undefined, [attachment])
  expect(task.deliverable).not.toHaveProperty("scope")
  expect(task.deliverable).toMatchObject({
    items: [
      { id: "PART 1.1", text: "Explain costs." },
      { id: "PART 2.1", text: "Recommend a test." },
    ],
  })
})
