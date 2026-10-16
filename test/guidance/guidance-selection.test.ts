import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  captureSimulation,
  deriveSimulationCapture,
  replaySimulation,
} from "../../src/evaluation/captures.js"
import {
  completeSimulationTask,
  createSimulationTask,
  readSimulationTask,
} from "../../src/evaluation/tasks.js"
import { proposeGuidance, saveGuidanceProposal } from "../../src/guidance/proposals.js"
import { restrictedGuidancePaths, selectTaskGuidance } from "../../src/guidance/selection.js"
import type { TaskRecord } from "../../src/shared/types.js"
import { completeTask } from "../../src/tasks/completion.js"
import {
  createAssignmentTask,
  createPrepTask,
  readGuidanceSnapshot,
  readSelectedGuidance,
  readTask,
} from "../../src/tasks/store.js"
import { inspectWorkspace, selectCourse } from "../../src/vault/workspace.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const prompt = "CS101/Assignments/pricing.md"
const ownGuide = "CS101/guidance/pricing-guidance.md"
const otherGuide = "CS101/guidance/other-guidance.md"
const commonGuide = "CS101/guidance/prep-guidance.md"
const body = (id: string, text: string) =>
  `---\ntype: guidance\ncanvas_id: '${id}'\ncanvas_url: https://canvas.example.test/courses/1/assignments/${id}?token=PRIVATE_SYNTHETIC_QUERY\n---\n${text}\n`
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-guidance-selection-"))
  roots.push(root)
  await mkdir(join(root, "CS101/Assignments"), { recursive: true })
  await mkdir(join(root, "CS101/guidance"), { recursive: true })
  await mkdir(join(root, "CS101/Week 01 - Oct 5"), { recursive: true })
  await writeFile(
    join(root, prompt),
    "---\ntype: assignment\ncanvas_id: '50'\n---\nRequired: 1. Explain the framework. 2. Identify missing evidence.\n",
  )
  await writeFile(
    join(root, commonGuide),
    "Synthetic engineering course explicitly permits AI prep/drafting.\n",
  )
  await writeFile(
    join(root, ownGuide),
    body("50", "# Assignment guidance\n- Explain uncertainty rather than inventing outcomes."),
  )
  await writeFile(
    join(root, otherGuide),
    body("60", "## Deliverable\nnone\n\nUNRELATED_ASSIGNMENT_SENTINEL"),
  )
  await writeFile(
    join(root, "CS101/Week 01 - Oct 5/reading.md"),
    "Synthetic framework: compare alternatives using marginal evidence.\n",
  )
  return root
}

it("uses stable exclusion codes for restricted guidance and fails closed on unknown formats", () => {
  const guidancePath = "CS101/guidance/prep-guidance.md"
  expect(
    restrictedGuidancePaths({
      excluded: [
        {
          path: guidancePath,
          reason: "Display text can be reworded without changing the classification.",
          reasonCode: "source.restricted_policy_metadata",
        },
      ],
    }),
  ).toEqual([guidancePath])
  expect(
    restrictedGuidancePaths({
      excluded: [{ path: guidancePath, reason: "Restricted policy metadata; text omitted" }],
    }),
  ).toEqual([guidancePath])
  expect(
    restrictedGuidancePaths({
      excluded: [{ path: guidancePath, reason: "New legacy wording with no known classification" }],
    }),
  ).toEqual([guidancePath])
  expect(
    restrictedGuidancePaths({
      excluded: [
        {
          path: guidancePath,
          reason: "Unknown coded exclusion",
          reasonCode: "source.future_code" as never,
        },
      ],
    }),
  ).toEqual([guidancePath])
  expect(
    restrictedGuidancePaths({
      excluded: [{ path: "CS101/guidance/prep-guidance.proposed.md", reason: "unknown" }],
    }),
  ).toEqual([])
})
async function candidate(root: string, task: TaskRecord) {
  const cite = `\`${prompt}\``
  const items =
    task.deliverable && task.deliverable.kind !== "none"
      ? task.deliverable.items
          .map(
            (item) =>
              `### ${item.text}\nPENDING — requires the missing case evidence or inputs before making a supported claim. ${cite}`,
          )
          .join("\n\n")
      : ""
  const file = join(root, "candidate.md")
  await writeFile(
    file,
    [
      `Task: ${task.id}`,
      ...task.requirements.map(
        (section, index) =>
          `## ${section}\nSynthetic structural test identifies evidence limits and cites exact selected materials. ${cite}\n${index === 1 ? items : ""}`,
      ),
    ].join("\n\n"),
  )
  return file
}

it("selects only common and matching assignment guidance, keeping another assignment's suppression out", async () => {
  const root = await fixture()
  const task = await createAssignmentTask(root, "CS101", prompt, "draft")
  expect(task.guidanceSelectionVersion).toBe(1)
  expect(task.guidance.map((source) => source.path)).toEqual([commonGuide, ownGuide])
  expect(task.guidance.find((source) => source.path === ownGuide)).toMatchObject({
    canvasId: "50",
    canvasUrl: "https://canvas.example.test/courses/1/assignments/50",
  })
  expect(task.deliverable).toHaveProperty("kind", "requirements")
  expect(JSON.stringify(task)).not.toMatch(/UNRELATED_ASSIGNMENT_SENTINEL|PRIVATE_SYNTHETIC_QUERY/)
  await expect(readTask(root, task.id)).resolves.toEqual(task)
  const before = await readFile(join(root, ownGuide))
  await writeFile(
    join(root, otherGuide),
    body("60", "Changed unrelated assignment guidance, still not this task's policy."),
  )
  await expect(completeTask(root, task.id, await candidate(root, task))).resolves.toHaveProperty(
    "output",
  )
  expect(await readFile(join(root, ownGuide))).toEqual(before)
  const prep = await createPrepTask(root, "CS101", "2026-10-05")
  expect(prep.guidance.map((source) => source.path)).toEqual([commonGuide])
})

it("refuses explicit wrong-task guidance, conflicting identities and modified captured identities", async () => {
  const root = await fixture()
  await expect(
    createAssignmentTask(root, "CS101", prompt, "draft", undefined, [otherGuide]),
  ).rejects.toThrow(/bound to another assignment/)
  const task = await createAssignmentTask(root, "CS101", prompt, "draft")
  const path = join(root, "_meta/tasks", task.id, "task.json")
  const changed = JSON.parse(await readFile(path, "utf8"))
  const guide = changed.guidance.find((source: { path: string }) => source.path === ownGuide)
  guide.canvasId = "60"
  await writeFile(path, JSON.stringify(changed))
  await expect(readTask(root, task.id)).rejects.toThrow()
  const identity = await readGuidanceSnapshot(root, ownGuide, 1)
  expect(() =>
    selectTaskGuidance("assignment", [{ ...identity, canvasId: "60" }], task.sources[0]),
  ).toThrow(/identity conflicts/)
})

it("keeps earlier guidance snapshots minimal and enforces selected policy after metadata-only inspection", async () => {
  const root = await fixture()
  const legacy = await readGuidanceSnapshot(root, ownGuide)
  expect(legacy.canvasId).toBeUndefined()
  expect(legacy.canvasUrl).toBeUndefined()
  const original = await readFile(join(root, ownGuide), "utf8")
  await writeFile(
    join(root, ownGuide),
    original.replace("type: guidance", "type: guidance\nai_policy: prohibited"),
  )
  const identity = await readGuidanceSnapshot(root, ownGuide, 1, true)
  expect(identity.text).toBe("")
  expect(identity.canvasId).toBe("50")
  await expect(
    readSelectedGuidance(root, [ownGuide], "assignment", { ...legacy, canvasId: "50" }),
  ).rejects.toThrow(/restricted or unknown policy/)
  await expect(readSelectedGuidance(root, [ownGuide], "prep")).resolves.toEqual([])
})

it("does not mistake a course-owned Canvas guidance identity for an assignment", async () => {
  const root = await fixture()
  const guide = "CS101/guidance/general-guidance.md"
  await writeFile(
    join(root, guide),
    "---\ncanvas_id: '1'\ncanvas_url: https://canvas.example.test/courses/1\n---\nCommon synthetic course guidance.\n",
  )
  const snapshot = await readGuidanceSnapshot(root, guide, 1)
  expect(selectTaskGuidance("prep", [snapshot])).toEqual([snapshot])
  expect(selectTaskGuidance("assignment", [snapshot])).toEqual([snapshot])
  expect(() => selectTaskGuidance("prep", [{ ...snapshot, canvasId: "2" }])).toThrow(
    /course identity conflicts/,
  )
})

it("does not bypass an excluded matching assignment policy while unrelated restrictions remain out of scope", async () => {
  const root = await fixture()
  await writeFile(
    join(root, otherGuide),
    body("60", "Restricted unrelated assignment guide.").replace(
      "type: guidance",
      "type: guidance\nai_policy: prohibited",
    ),
  )
  const task = await createAssignmentTask(root, "CS101", prompt, "draft")
  expect(task.guidance.map((source) => source.path)).not.toContain(otherGuide)
  await writeFile(
    join(root, ownGuide),
    body(
      "50",
      "Restricted matching guide; never replace policy with a permissive placeholder.",
    ).replace("type: guidance", "type: guidance\nai_policy: prohibited"),
  )
  await expect(createAssignmentTask(root, "CS101", prompt, "draft")).rejects.toThrow(
    /excluded by policy/,
  )
  await expect(completeTask(root, task.id, await candidate(root, task))).rejects.toThrow(
    /excluded by policy/,
  )
  expect(await readFile(join(root, ownGuide), "utf8")).toContain("ai_policy: prohibited")
})

it("stops prep and course proposals on excluded common guidance instead of treating its absence as permission", async () => {
  const root = await fixture()
  await writeFile(
    join(root, commonGuide),
    "---\nai_policy: prohibited\n---\nRestricted synthetic common guidance.\n",
  )
  await expect(createPrepTask(root, "CS101", "2026-10-05")).rejects.toThrow(/excluded by policy/)
  await writeFile(
    join(root, "CS101/syllabus.md"),
    "Synthetic syllabus does not override a restricted guide.\n",
  )
  const workspace = await inspectWorkspace(root)
  await expect(proposeGuidance(root, workspace, selectCourse(workspace, "CS101"))).rejects.toThrow(
    /excluded by policy/,
  )
})

it("preserves an earlier unversioned selection recipe rather than retroactively dropping its guidance", async () => {
  const root = await fixture()
  const task = await createAssignmentTask(root, "CS101", prompt, "draft")
  // A coherent old-selection fixture must capture the old fields/instructions,
  // including the former suppression from another assignment; it is not a
  // statement that this earlier selection is academically correct.
  delete task.guidanceSelectionVersion
  delete task.assignmentStructureVersion
  task.guidance = await Promise.all(
    [otherGuide, commonGuide, ownGuide].map((path) => readGuidanceSnapshot(root, path)),
  )
  const { captureTaskDeliverable } = await import("../../src/tasks/deliverable-evidence.js")
  const { resolveRequirements } = await import("../../src/tasks/requirements.js")
  const { workflowForRequirements } = await import("../../src/tasks/workflows.js")
  task.deliverable = captureTaskDeliverable(
    task.kind,
    task.assignment?.mode,
    task.sources,
    task.guidance,
    task.deliverableScopeVersion,
  )
  const req = resolveRequirements(
    task.kind,
    task.assignment?.mode,
    task.sources,
    task.guidance,
    2,
    task.deliverable,
  )
  task.questions = req.questions
  task.workflow = workflowForRequirements(
    task.kind,
    task.assignment?.mode,
    task.requirements,
    req.questions,
    req.guidanceInstructions,
    3,
    task.deliverable,
  )
  const path = join(root, "_meta/tasks", task.id, "task.json")
  const bytes = JSON.stringify(task)
  await writeFile(path, bytes)
  await expect(readTask(root, task.id)).resolves.toEqual(task)
  expect(await readFile(path, "utf8")).toBe(bytes)
  expect(task.guidance.map((source) => source.path)).toContain(otherGuide)
})

async function frozenFixture() {
  const root = await fixture()
  for (const path of [prompt, ownGuide, otherGuide]) {
    const bytes = await readFile(join(root, path), "utf8")
    await writeFile(join(root, path), bytes.replace(/^---\n/, "---\navailable_at: 2026-10-05\n"))
  }
  await writeFile(
    join(root, commonGuide),
    `---\navailable_at: 2026-10-05\n---\n${await readFile(join(root, commonGuide), "utf8")}`,
  )
  const snapshot = await captureSimulation(root, "CS101", "2026-10-09")
  return { root, snapshot }
}

it("uses captured guidance identities for frozen selection despite newer live guides", async () => {
  const { root, snapshot } = await frozenFixture()
  expect((await replaySimulation(root, snapshot.id)).guidanceIdentityVersion).toBe(1)
  await writeFile(join(root, ownGuide), body("60", "NEWER_LIVE_GUIDANCE"))
  await writeFile(join(root, otherGuide), body("50", "LIVE_OTHER_GUIDE"))
  const created = await createSimulationTask(root, snapshot.id, {
    kind: "assignment",
    source: prompt,
    mode: "draft",
  })
  const record = await readSimulationTask(root, created.id)
  expect(record.guidanceSelectionVersion).toBe(1)
  expect(record.task.guidance.map((source) => source.path)).toEqual([commonGuide, ownGuide])
  expect(record.task.deliverable).toHaveProperty("kind", "requirements")
  expect(JSON.stringify(record.task)).not.toMatch(
    /NEWER_LIVE_GUIDANCE|LIVE_OTHER_GUIDE|UNRELATED_ASSIGNMENT_SENTINEL|PRIVATE_SYNTHETIC_QUERY/,
  )
  const path = join(root, "_meta/simulations/tasks", created.id, "record.json")
  const changed = JSON.parse(await readFile(path, "utf8"))
  changed.task.guidance.find((source: { path: string }) => source.path === ownGuide).canvasId = "60"
  await writeFile(path, JSON.stringify(changed))
  await expect(readSimulationTask(root, created.id)).rejects.toThrow()
})

it("captures restricted guide identities without bodies and blocks matching frozen work after live edits", async () => {
  const { root } = await frozenFixture()
  const restricted = body("60", "RESTRICTED_BODY_SENTINEL").replace(
    "type: guidance",
    "type: guidance\nai_policy: prohibited",
  )
  await writeFile(join(root, otherGuide), restricted)
  const snapshot = await captureSimulation(root, "CS101", "2026-10-09")
  const frozen = await replaySimulation(root, snapshot.id)
  expect(frozen.restrictedGuidanceVersion).toBe(1)
  expect(frozen.restrictedGuidance).toHaveLength(1)
  expect(frozen.restrictedGuidance?.[0]).toMatchObject({
    path: otherGuide,
    canvasId: "60",
    text: "",
  })
  expect(JSON.stringify(frozen)).not.toMatch(/RESTRICTED_BODY_SENTINEL|PRIVATE_SYNTHETIC_QUERY/)
  // A live ownership change must neither block the unrelated frozen prompt nor clear its restriction.
  await writeFile(join(root, otherGuide), body("50", "NEW_LIVE_GUIDE"))
  const task = await createSimulationTask(root, snapshot.id, {
    kind: "assignment",
    source: prompt,
    mode: "draft",
  })
  expect(
    (await readSimulationTask(root, task.id)).task.guidance.map((source) => source.path),
  ).not.toContain(otherGuide)
  await writeFile(
    join(root, ownGuide),
    body("50", "OWN_RESTRICTED_BODY").replace(
      "type: guidance",
      "type: guidance\nai_policy: prohibited",
    ),
  )
  const matching = await captureSimulation(root, "CS101", "2026-10-09")
  await writeFile(join(root, ownGuide), body("50", "NEW_ALLOWED_LIVE_GUIDE"))
  await expect(
    createSimulationTask(root, matching.id, { kind: "assignment", source: prompt, mode: "draft" }),
  ).rejects.toThrow(/frozen guidance is excluded by policy/)
  expect(await readFile(join(root, otherGuide), "utf8")).toContain("NEW_LIVE_GUIDE")
})

it("retains restricted common guidance through earlier cutoffs and rejects rehashed omission or body injection", async () => {
  const { root } = await frozenFixture()
  await writeFile(
    join(root, commonGuide),
    "---\nai_policy: prohibited\n---\nRESTRICTED_COMMON_BODY",
  )
  await writeFile(
    join(root, "CS101/Week 01 - Oct 5/reading.md"),
    "---\navailable_at: 2026-10-05\n---\nSynthetic marginal evidence reading.",
  )
  const snapshot = await captureSimulation(root, "CS101", "2026-10-09")
  const child = await deriveSimulationCapture(root, snapshot.id, "2026-10-08")
  expect(
    (await replaySimulation(root, child.id)).restrictedGuidance?.map((source) => source.path),
  ).toEqual([commonGuide])
  await expect(
    createSimulationTask(root, child.id, { kind: "assignment", source: prompt, mode: "outline" }),
  ).rejects.toThrow(/excluded by policy/)
  await expect(
    createSimulationTask(root, child.id, { kind: "prep", week: "2026-10-05" }),
  ).rejects.toThrow(/excluded by policy/)
  const path = join(root, "_meta/simulations", `${child.id}.json`)
  const bytes = await readFile(path, "utf8")
  for (const mutation of ["omit", "body", "downgrade"]) {
    const altered = JSON.parse(bytes)
    if (mutation === "omit") altered.restrictedGuidance = []
    if (mutation === "body") altered.restrictedGuidance[0].text = "BODY_INJECTION"
    if (mutation === "downgrade") {
      delete altered.restrictedGuidanceVersion
      delete altered.restrictedGuidance
    }
    const { hash: _hash, ...base } = altered
    altered.hash = createHash("sha256").update(JSON.stringify(base)).digest("hex")
    await writeFile(path, JSON.stringify(altered))
    await expect(replaySimulation(root, child.id)).rejects.toThrow()
  }
})

it("retains guidance identity through cutoff derivation and refuses a rehashed child downgrade", async () => {
  const { root, snapshot } = await frozenFixture()
  const child = await deriveSimulationCapture(root, snapshot.id, "2026-10-08")
  expect((await replaySimulation(root, child.id)).guidanceIdentityVersion).toBe(1)
  const task = await createSimulationTask(root, child.id, {
    kind: "assignment",
    source: prompt,
    mode: "outline",
  })
  expect(
    (await readSimulationTask(root, task.id)).task.guidance.map((source) => source.path),
  ).toEqual([commonGuide, ownGuide])
  const path = join(root, "_meta/simulations", `${child.id}.json`)
  const altered = JSON.parse(await readFile(path, "utf8"))
  delete altered.guidanceIdentityVersion
  const { hash: _hash, ...base } = altered
  altered.hash = createHash("sha256").update(JSON.stringify(base)).digest("hex")
  await writeFile(path, JSON.stringify(altered))
  await expect(replaySimulation(root, child.id)).rejects.toThrow()
})

it("labels new tasks from old captures uncaptured without rewriting the old snapshot or borrowing identities", async () => {
  const { root, snapshot } = await frozenFixture()
  const path = join(root, "_meta/simulations", `${snapshot.id}.json`)
  const old = JSON.parse(await readFile(path, "utf8"))
  delete old.guidanceIdentityVersion
  delete old.restrictedGuidanceVersion
  delete old.restrictedGuidance
  for (const guide of old.guidance) {
    delete guide.canvasId
    delete guide.canvasUrl
  }
  const { hash: _hash, ...base } = old
  old.hash = createHash("sha256").update(JSON.stringify(base)).digest("hex")
  const bytes = JSON.stringify(old)
  await writeFile(path, bytes)
  const created = await createSimulationTask(root, snapshot.id, {
    kind: "assignment",
    source: prompt,
    mode: "draft",
  })
  const record = await readSimulationTask(root, created.id)
  expect(record.guidanceSelectionVersion).toBe(0)
  expect(record.task.guidanceSelectionVersion).toBeUndefined()
  expect(record.task.notices.join(" ")).toContain(
    "Whole-course guidance selection remains unverified",
  )
  expect(record.task.guidance.map((source) => source.path)).toContain(otherGuide)
  expect(await readFile(path, "utf8")).toBe(bytes)
})

const customFormat =
  "# Assignment guidance\n## Brief structure\nAnalysis, Computations\n- Limitations\n## Instructions\n- Explain uncertainty rather than inventing outcomes."

it("keeps course-guidance proposals isolated from assignment guides and saves without changing active guidance", async () => {
  const root = await fixture()
  const syllabus = "CS101/syllabus.md"
  await writeFile(
    join(root, syllabus),
    "Synthetic syllabus: compare alternatives; instructor AI permission must be confirmed separately.\n",
  )
  const context = await inspectWorkspace(root)
  const proposal = await proposeGuidance(root, context, selectCourse(context, "CS101"))
  const recordPath = join(root, "_meta/guidance-proposals", proposal.id, "proposal.json")
  const record = JSON.parse(await readFile(recordPath, "utf8"))
  expect(record.guidanceSelectionVersion).toBe(1)
  expect(record.guidance.map((source: { path: string }) => source.path)).toEqual([commonGuide])
  expect(JSON.stringify(record)).not.toContain("UNRELATED_ASSIGNMENT_SENTINEL")
  const active = await readFile(join(root, commonGuide))
  await writeFile(
    join(root, otherGuide),
    body("60", "Changed unrelated guide does not invalidate this course proposal."),
  )
  const file = join(root, "guidance-candidate.md")
  await writeFile(
    file,
    `# Proposed course guidance\n\nCompare alternatives using the supplied syllabus; confirm the course's AI policy independently before student work.\n\n## Brief structure\nReading synthesis, Discussion preparation\n\n## Sources\n- \`${syllabus}\`\n`,
  )
  const saved = await saveGuidanceProposal(root, proposal.id, file)
  expect(saved).toContain("prep-guidance.proposed.v1.md")
  expect(await readFile(join(root, commonGuide))).toEqual(active)
  expect(await readFile(saved, "utf8")).toContain("confirm the course's AI policy")
})
it("honors a matching assignment's declared headings without inheriting prep structure or mode changes", async () => {
  const root = await fixture()
  await writeFile(join(root, ownGuide), body("50", customFormat))
  await writeFile(
    join(root, commonGuide),
    "## Brief structure\n- Prep overview\n- Prep concepts\n## Permission\nSynthetic course explicitly permits AI assistance.\n",
  )
  const task = await createAssignmentTask(root, "CS101", prompt, "draft")
  expect(task.assignmentStructureVersion).toBe(1)
  expect(task.requirements).toEqual(["Analysis", "Computations", "Limitations", "Sources"])
  expect(task.workflow?.instructions.join(" ")).toContain("clearly label missing evidence or scope")
  expect(task.workflow?.instructions).not.toContain("Limitations")
  expect(task.workflow?.instructions).toContain(
    "Explain uncertainty rather than inventing outcomes.",
  )
  await expect(readTask(root, task.id)).resolves.toEqual(task)
  await expect(completeTask(root, task.id, await candidate(root, task))).resolves.toHaveProperty(
    "output",
  )
  const prep = await createPrepTask(root, "CS101", "2026-10-05")
  expect(prep.requirements).toEqual(["Prep overview", "Prep concepts", "Sources"])
  const outline = await createAssignmentTask(root, "CS101", prompt, "outline")
  expect(outline.assignmentStructureVersion).toBeUndefined()
  expect(outline.requirements).toContain("Outline")
})

it("pins frozen custom structure to captured guide text despite later live edits", async () => {
  const root = await fixture()
  await writeFile(
    join(root, ownGuide),
    body("50", customFormat).replace(/^---\n/, "---\navailable_at: 2026-10-05\n"),
  )
  for (const path of [prompt, otherGuide])
    await writeFile(
      join(root, path),
      (await readFile(join(root, path), "utf8")).replace(
        /^---\n/,
        "---\navailable_at: 2026-10-05\n",
      ),
    )
  const snapshot = await captureSimulation(root, "CS101", "2026-10-09")
  await writeFile(join(root, ownGuide), body("50", "## Brief structure\n- NEWER FORMAT"))
  const created = await createSimulationTask(root, snapshot.id, {
    kind: "assignment",
    source: prompt,
    mode: "draft",
  })
  const record = await readSimulationTask(root, created.id)
  expect(record.assignmentStructureVersion).toBe(1)
  expect(record.task.requirements).toEqual(["Analysis", "Computations", "Limitations", "Sources"])
  await expect(
    completeSimulationTask(root, created.id, await candidate(root, record.task)),
  ).resolves.toMatchObject({ verdict: "pending-human" })
})

it("refuses conflicting declarations and keeps an older default-structure draft recipe unchanged", async () => {
  const root = await fixture()
  await writeFile(join(root, ownGuide), body("50", customFormat))
  const task = await createAssignmentTask(root, "CS101", prompt, "draft")
  // Synthetic pre-structure recipe with the same captured guide; no real task
  // is edited, redirected or certified as historically well-selected.
  delete task.assignmentStructureVersion
  const { resolveRequirements } = await import("../../src/tasks/requirements.js")
  const { workflowForRequirements } = await import("../../src/tasks/workflows.js")
  const old = resolveRequirements(
    task.kind,
    task.assignment?.mode,
    task.sources,
    task.guidance,
    2,
    task.deliverable,
  )
  task.requirements = old.sections
  task.workflow = workflowForRequirements(
    task.kind,
    task.assignment?.mode,
    old.sections,
    old.questions,
    old.guidanceInstructions,
    3,
    task.deliverable,
  )
  const path = join(root, "_meta/tasks", task.id, "task.json")
  const bytes = JSON.stringify(task)
  await writeFile(path, bytes)
  await expect(readTask(root, task.id)).resolves.toEqual(task)
  expect(task.requirements).toContain("Draft")
  expect(await readFile(path, "utf8")).toBe(bytes)
  await writeFile(
    join(root, "CS101/guidance/assignment-50.md"),
    "## Brief structure\n- Conflicting structure\n",
  )
  await expect(createAssignmentTask(root, "CS101", prompt, "draft")).rejects.toThrow(
    /conflicting output structures/,
  )
})
