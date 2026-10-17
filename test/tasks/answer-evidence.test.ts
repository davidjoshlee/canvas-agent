import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  CourseContext,
  SourceRecord,
  TaskRecord,
  WorkspaceContext,
} from "../../src/shared/types.js"
import { captureSimulation } from "../../src/simulation/captures.js"
import { createSimulationTask, readSimulationTask } from "../../src/simulation/tasks.js"
import { checkCandidate, completeTask } from "../../src/tasks/artifacts/completion.js"
import { workflowForRequirements } from "../../src/tasks/authoring/workflows.js"
import { prepareAnswerEvidence } from "../../src/tasks/evidence/answer-evidence.js"
import { TaskRecordSchema } from "../../src/tasks/store.js"

const workspace = vi.hoisted(() => ({ inspectWorkspace: vi.fn(), selectCourse: vi.fn() }))
vi.mock("../../src/vault/workspace.js", () => workspace)

import { createPrepTask, readTask } from "../../src/tasks/store.js"

const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const path = "GSB-101/Week 03 - Oct 12/lecture.md"
const question = "How does commitment change bargaining leverage?"
const material = `---\navailable_at: 2026-10-05\n---\nCommitment enables credible promises and strategic investment, improving bargaining leverage and industry outcomes.

## Preparation questions
${question}`
const source: SourceRecord = {
  path,
  title: "lecture",
  hash: hash(material),
  text: material,
  type: "markdown",
  dates: [],
}
let vault = ""
let course: CourseContext
let context: WorkspaceContext

async function setup() {
  vault = await mkdtemp(join(tmpdir(), "canvas-answer-evidence-"))
  await mkdir(join(vault, "GSB-101/Week 03 - Oct 12"), { recursive: true })
  await writeFile(join(vault, path), material)
  course = {
    code: "GSB-101",
    title: "Strategy",
    root: "GSB-101",
    sources: [{ ...source }],
    excluded: [],
    guidance: [],
    existingWork: ["GSB-101/Week 03 - Oct 12"],
  }
  context = { version: 1, vault, courses: [course], pendingTasks: [], notices: [] }
  workspace.inspectWorkspace.mockResolvedValue(context)
  workspace.selectCourse.mockReturnValue(course)
}

function taskWith(flag?: 1): TaskRecord {
  return {
    version: 1,
    id: randomUUID(),
    kind: "prep",
    status: "pending",
    createdAt: new Date().toISOString(),
    course: { code: course.code, title: course.title, root: course.root },
    week: "2026-10-12",
    period: { kind: "week", value: "2026-10-12" },
    destination: "GSB-101/Week 03 - Oct 12/Prep",
    requirements: ["Discussion questions", "Sources"],
    sources: [{ ...source }],
    excluded: [],
    guidance: [],
    notices: [],
    questions: [question],
    ...(flag ? { answerEvidenceVersion: flag } : {}),
    parserVersion: 2,
    workflow: {
      version: 3,
      requiredSections: ["Discussion questions", "Sources"],
      instructions: [],
    },
  }
}

function candidate(task: TaskRecord, answer: string) {
  return `Task: ${task.id}\n\n## Discussion questions\n### ${question}\n${answer}\n\n## Sources\n- \`${path}\`\n`
}

afterEach(async () => {
  vi.clearAllMocks()
  if (vault) await rm(vault, { recursive: true, force: true })
})

describe("versioned prep answer evidence", () => {
  it("distinguishes prose code from source citations and permits registered artifact paths", async () => {
    await setup()
    const task = taskWith()
    const authored = candidate(
      task,
      `Commitment changes bargaining leverage by making promises credible. \`${path}\`\n\nThe calculations are \`revenue / units\`, \`revenue/units\`, and \`revenue / 1.2\`; the analysis is in \`analysis/model.py\`.\n\n\`\`\`text\n\`other/course/source.md\`\n\`\`\``,
    )
    expect(() => checkCandidate(authored, task.id, task, [], ["analysis/model.py"])).not.toThrow()
    expect(() => checkCandidate(authored, task.id, task)).toThrow(/exact task source path/)
    const unknownCitation = authored.replace("`analysis/model.py`", "`other/course/source.md`")
    expect(() => checkCandidate(unknownCitation, task.id, task, [], ["analysis/model.py"])).toThrow(
      /exact task source path/,
    )
    const unknownSpacedCitation = authored.replace(
      "`analysis/model.py`",
      "`Other Course/Week 03 - Oct 12/source.md`",
    )
    expect(() =>
      checkCandidate(unknownSpacedCitation, task.id, task, [], ["analysis/model.py"]),
    ).toThrow(/exact task source path/)
    const artifactOnlySources = authored.replace(`- \`${path}\``, "- `analysis/model.py`")
    expect(() =>
      checkCandidate(artifactOnlySources, task.id, task, [], ["analysis/model.py"]),
    ).toThrow(/Sources section must cite exact task source paths/)
  })

  it("also applies the prep evidence flag to detected imperative requirements without question marks", async () => {
    await setup()
    const task = taskWith(1)
    const requirement = "Compare credible promises and strategic investment."
    task.questions = []
    task.deliverable = {
      version: 1,
      kind: "requirements",
      cue: "Required",
      sourcePath: path,
      items: [{ id: "1", text: requirement }],
    }
    const text = candidate(
      task,
      `This answer discusses various important factors that are very interesting. \`${path}\``,
    ).replace(`### ${question}`, `### ${requirement}`)
    expect(() => checkCandidate(text, task.id, task)).toThrow(/five distinct content words/)
    delete task.answerEvidenceVersion
    expect(() => checkCandidate(text, task.id, task)).not.toThrow()
  })
  it("rejects generic cited filler while accepting substantive source vocabulary", async () => {
    await setup()
    const task = taskWith(1)
    expect(() =>
      checkCandidate(
        candidate(
          task,
          `This answer discusses various important factors that are very interesting. \`${path}\``,
        ),
        task.id,
        task,
      ),
    ).toThrow(/five distinct content words/)
    expect(() =>
      checkCandidate(
        candidate(
          task,
          `Commitment enables credible promises and strategic investment, improving bargaining leverage and industry outcomes. \`${path}\``,
        ),
        task.id,
        task,
      ),
    ).not.toThrow()
  })

  it("keeps explicit evidence gaps and unflagged saved tasks compatible", async () => {
    await setup()
    const flagged = taskWith(1)
    expect(() =>
      checkCandidate(
        candidate(
          flagged,
          "PENDING — the supplied sources do not address this question; the required case exhibit is unavailable.",
        ),
        flagged.id,
        flagged,
      ),
    ).not.toThrow()
    const legacy = taskWith()
    expect(() =>
      checkCandidate(
        candidate(
          legacy,
          `This answer discusses various important factors that are very interesting. \`${path}\``,
        ),
        legacy.id,
        legacy,
      ),
    ).not.toThrow()
  })

  it("requires vocabulary from selected sources and strips exact citation paths", () => {
    const irrelevant = { ...source, text: "unrelated vocabulary only" }
    expect(
      prepareAnswerEvidence([irrelevant])(
        question,
        `alpha beta gamma delta epsilon zeta \`${path}\``,
      ).valid,
    ).toBe(false)
    expect(
      prepareAnswerEvidence([source])(question, `alpha beta gamma delta epsilon zeta \`${path}\``)
        .answerTerms,
    ).toBe(6)
  })

  it("matches public token lengths/punctuation and rejects source bounds before tokenizing", () => {
    expect(
      prepareAnswerEvidence([source])(question, `AI ML x2 alpha-beta isn't row1 \`${path}\``)
        .answerTerms,
    ).toBe(3)
    expect(() => prepareAnswerEvidence(Array.from({ length: 1001 }, () => source))).toThrow(
      /1000 paths/,
    )
    expect(() => prepareAnswerEvidence([{ ...source, text: "x".repeat(20_000_001) }])).toThrow(
      /20 MB/,
    )
    const checked = prepareAnswerEvidence([source])
    expect(() => checked(question, "x".repeat(20_000_001))).toThrow(/20 MB/)
  })

  it("reads and completes an earlier unflagged v3 recipe without upgrading its instructions", async () => {
    await setup()
    const fresh = await createPrepTask(vault, course.code, "2026-10-12")
    const old = { ...fresh }
    delete old.hostExecutionVersion
    delete old.answerEvidenceVersion
    old.workflow = workflowForRequirements({
      kind: "prep",
      sections: old.requirements,
      questions: old.questions ?? [],
      guidanceInstructions: [],
      version: 3,
      deliverable: old.deliverable,
    })
    const record = join(vault, "_meta/tasks", old.id, "task.json")
    await writeFile(record, JSON.stringify(old))
    const handoff = join(vault, "_meta/tasks", old.id, "TASK.md")
    await writeFile(
      handoff,
      `# Earlier prep handoff\nTask: ${old.id}\nUse the captured prior workflow, not newer answer evidence rules.\n`,
    )
    const handoffBefore = await readFile(handoff)
    expect((await readTask(vault, old.id)).answerEvidenceVersion).toBeUndefined()
    const file = join(vault, "legacy-candidate.md")
    await writeFile(
      file,
      `Task: ${old.id}\n${old.requirements.map((heading) => `## ${heading}\n${heading === "Sources" ? `\`${path}\`` : heading === "Preparation questions" ? `### ${question}\nThis answer discusses various important factors that are very interesting. \`${path}\`` : "Synthetic prior-validator fixture content."}`).join("\n")}`,
    )
    const completed = await completeTask(vault, old.id, file)
    expect(completed.task.answerEvidenceVersion).toBeUndefined()
    expect(completed.task.workflow).toEqual(old.workflow)
    expect(await readFile(handoff)).toEqual(handoffBefore)
  })

  it("rejects the flag for assignments, legacy workflows, and legacy parsers", async () => {
    await setup()
    const prep = taskWith(1)
    expect(TaskRecordSchema.safeParse({ ...prep, kind: "assignment" }).success).toBe(false)
    expect(
      TaskRecordSchema.safeParse({
        ...prep,
        workflow: { ...prep.workflow, version: 1 },
      }).success,
    ).toBe(false)
    expect(TaskRecordSchema.safeParse({ ...prep, parserVersion: 1 }).success).toBe(false)
  })

  it("leaves new ordinary and frozen prep recipes free of the historical vocabulary gate", async () => {
    await setup()
    const ordinary = await createPrepTask(vault, course.code, "2026-10-12")
    expect(ordinary.answerEvidenceVersion).toBeUndefined()
    expect((await readTask(vault, ordinary.id)).answerEvidenceVersion).toBeUndefined()
    const ordinaryCandidate = `Task: ${ordinary.id}\n\n${ordinary.requirements
      .map((heading) =>
        heading === "Sources"
          ? `## ${heading}\n\n\`${path}\``
          : heading === "Preparation questions"
            ? `## ${heading}\n\n### ${question}\nIt lets negotiators make believable commitments. \`${path}\``
            : `## ${heading}\n\nSynthetic preparation content.`,
      )
      .join("\n\n")}\n`
    const ordinaryPath = join(vault, "ordinary-candidate.md")
    await writeFile(ordinaryPath, ordinaryCandidate)
    await expect(completeTask(vault, ordinary.id, ordinaryPath)).resolves.toBeDefined()

    const capture = await captureSimulation(vault, course.code, "2026-10-12")
    const frozen = await createSimulationTask(vault, capture.id, {
      kind: "prep",
      week: "2026-10-12",
    })
    const frozenRecord = await readSimulationTask(vault, frozen.id)
    expect(frozenRecord.answerEvidenceVersion).toBeUndefined()
    expect(frozenRecord.task.answerEvidenceVersion).toBeUndefined()
    expect(await readSimulationTask(vault, frozen.id)).toEqual(frozenRecord)
  })
})
