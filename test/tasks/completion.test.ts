import { createHash } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { diagnostic } from "../../src/shared/diagnostics.js"
import type { CourseContext, WorkspaceContext } from "../../src/shared/types.js"

const workspace = vi.hoisted(() => ({ inspectWorkspace: vi.fn(), selectCourse: vi.fn() }))
vi.mock("../../src/vault/workspace.js", () => workspace)

import { completeTask } from "../../src/tasks/artifacts/completion.js"
import * as tasks from "../../src/tasks/store.js"
import { createPrepTask } from "../../src/tasks/store.js"

const digest = (text: string) => createHash("sha256").update(text).digest("hex")
let vault = ""
let candidatePath = ""
let course: CourseContext
let context: WorkspaceContext
let sourceText = "Market structure and pricing lecture notes."

const candidate = (id: string, path = "GSB-101/Week 03 - Oct 12/lecture.md") => `Task: ${id}

## Summary
A concise summary of the lecture.

## Overview
The lecture introduces market structure and pricing.

## Reading synthesis
The supplied lecture connects competitive entry and pricing.

## Key concepts
Market structure affects pricing.

## Preparation questions
No explicit preparation questions were posted in these sources.

## Discussion points
Discuss the connection between entry and pricing in the lecture.

## Discussion questions
How does entry change pricing?

## Sources
- \`${path}\`
`

async function setup() {
  vault = await realpath(await mkdtemp(join(tmpdir(), "canvas-agent-complete-")))
  candidatePath = join(
    await realpath(await mkdtemp(join(tmpdir(), "canvas-agent-candidate-"))),
    "candidate.md",
  )
  sourceText = "Market structure and pricing lecture notes."
  await mkdir(join(vault, "GSB-101", "Week 03 - Oct 12"), { recursive: true })
  await mkdir(join(vault, "GSB-101", "Resources"), { recursive: true })
  await mkdir(join(vault, "GSB-101", "Assignments"), { recursive: true })
  await writeFile(join(vault, "GSB-101", "Week 03 - Oct 12", "lecture.md"), sourceText)
  const syllabus = "Course overview and syllabus."
  const assignment = "Prompt for the week of October 14."
  await writeFile(join(vault, "GSB-101", "Resources", "Syllabus.md"), syllabus)
  await writeFile(join(vault, "GSB-101", "Assignments", "case.md"), assignment)
  course = {
    code: "GSB-101",
    title: "Strategy",
    root: "GSB-101",
    sources: [
      {
        path: "GSB-101/Week 03 - Oct 12/lecture.md",
        title: "lecture",
        hash: digest(sourceText),
        text: sourceText,
        type: "markdown",
        dates: [],
      },
      {
        path: "GSB-101/Resources/Syllabus.md",
        title: "Syllabus",
        hash: digest(syllabus),
        text: syllabus,
        type: "markdown",
        dates: [],
      },
      {
        path: "GSB-101/Assignments/case.md",
        title: "Case",
        hash: digest(assignment),
        text: assignment,
        type: "assignment",
        dates: ["2026-10-14"],
      },
    ],
    excluded: [],
    guidance: [],
    existingWork: ["GSB-101/Week 03 - Oct 12"],
  }
  context = { version: 1, vault, courses: [course], pendingTasks: [], notices: [], diagnostics: [] }
  workspace.inspectWorkspace.mockResolvedValue(context)
  workspace.selectCourse.mockReturnValue(course)
}

async function makeTask() {
  const task = await createPrepTask(vault, "GSB-101", "2026-10-12")
  await writeFile(candidatePath, candidate(task.id))
  return task
}

afterEach(async () => {
  vi.clearAllMocks()
  if (vault) await rm(vault, { recursive: true, force: true })
  if (candidatePath) await rm(join(candidatePath, ".."), { recursive: true, force: true })
})

describe("safe task completion", () => {
  it("continues completing persisted v1 prep tasks with their saved headings", async () => {
    await setup()
    const source = course.sources[0]
    if (!source) throw new Error("Fixture source is missing")
    course.sources = [source]
    const task = await createPrepTask(vault, "GSB-101", "2026-10-12")
    const taskPath = join(vault, "_meta", "tasks", task.id, "task.json")
    const legacy = JSON.parse(await readFile(taskPath, "utf8"))
    delete legacy.period
    delete legacy.workflow
    delete legacy.answerEvidenceVersion
    delete legacy.questions
    delete legacy.parserVersion
    delete legacy.deliverable
    delete legacy.deliverableParserVersion
    delete legacy.guidanceSelectionVersion
    legacy.requirements = ["Summary", "Key concepts", "Discussion questions", "Sources"]
    await writeFile(taskPath, JSON.stringify(legacy))
    await writeFile(
      candidatePath,
      `Task: ${task.id}\n\n## Summary\nA concise summary of the reading.\n\n## Key concepts\nMarket structure affects pricing.\n\n## Discussion questions\nNo questions were supplied.\n\n## Sources\n- \`${source.path}\`\n`,
    )
    const completed = await completeTask(vault, task.id, candidatePath)
    expect(completed.task.status).toBe("completed")
    expect(completed.task.workflow).toBeUndefined()
    const savedRecord = await readFile(taskPath)
    const savedOutput = await readFile(join(vault, completed.output))
    expect((await completeTask(vault, task.id, candidatePath)).output).toBe(completed.output)
    expect(await readFile(taskPath)).toEqual(savedRecord)
    expect(await readFile(join(vault, completed.output))).toEqual(savedOutput)
  })

  it("requires substantive source-linked coverage for every captured prep question", async () => {
    await setup()
    const source = course.sources[0]
    if (!source) throw new Error("Fixture source is missing")
    sourceText =
      "The reading explains how commitment changes bargaining outcomes and strategic choices.\n\n## Preparation questions\nHow does commitment change bargaining outcomes?"
    await writeFile(join(vault, source.path), sourceText)
    course.sources[0] = { ...source, text: sourceText, hash: digest(sourceText) }
    const task = await createPrepTask(vault, "GSB-101", "2026-10-12")
    expect(task.workflow?.version).toBe(3)
    expect(task.questions).toEqual(["How does commitment change bargaining outcomes?"])
    const base = (answer: string) =>
      `Task: ${task.id}\n\n${task.requirements
        .map(
          (heading) =>
            `## ${heading}\n${heading === "Sources" ? `- \`${source.path}\`` : heading === "Preparation questions" ? `### How does commitment change bargaining outcomes?\n${answer}` : "A concise synthesis grounded in the supplied reading."}`,
        )
        .join("\n\n")}\n`
    const questionElsewhere = base("A concise synthesis grounded in the supplied reading.")
      .replace("### How does commitment change bargaining outcomes?", "")
      .replace(
        "## Summary\nA concise synthesis",
        "## Summary\nHow does commitment change bargaining outcomes?\n\nA concise synthesis",
      )
    await writeFile(candidatePath, questionElsewhere)
    await expect(completeTask(vault, task.id, candidatePath)).rejects.toThrow(
      /exact Markdown subheading/,
    )
    await writeFile(candidatePath, base(""))
    await expect(completeTask(vault, task.id, candidatePath)).rejects.toThrow(/substantive answer/)
    await writeFile(
      candidatePath,
      base(
        "The reading explains how commitment changes bargaining outcomes by limiting later strategic choices, which makes promises more credible. See `GSB-101/Week 03 - Oct 12/lecture.md`.",
      ),
    )
    await expect(completeTask(vault, task.id, candidatePath)).resolves.toMatchObject({
      task: { status: "completed" },
    })
  })
  it("accepts an explicit PENDING missing-source answer without requiring a fabricated citation", async () => {
    await setup()
    const source = course.sources[0]
    if (!source) throw new Error("Fixture source is missing")
    sourceText =
      "The supplied notes do not contain Exhibit 2.\n\n## Preparation questions\nWhat conversion rate is shown in Exhibit 2?"
    await writeFile(join(vault, source.path), sourceText)
    course.sources[0] = { ...source, text: sourceText, hash: digest(sourceText) }
    const task = await createPrepTask(vault, "GSB-101", "2026-10-12")
    const content = (answer: string) =>
      `Task: ${task.id}\n\n${task.requirements.map((heading) => `## ${heading}\n${heading === "Sources" ? `\`${source.path}\`` : heading === "Preparation questions" ? `### What conversion rate is shown in Exhibit 2?\n${answer}` : "Synthetic discussion of the supplied notes."}`).join("\n\n")}`
    await writeFile(candidatePath, content("PENDING"))
    await expect(completeTask(vault, task.id, candidatePath)).rejects.toThrow(/substantive answer/)
    await writeFile(
      candidatePath,
      content(
        "PENDING — requires Exhibit 2, which the student must supply before its conversion rate can be stated. No conversion value is asserted.",
      ),
    )
    await expect(completeTask(vault, task.id, candidatePath)).resolves.toMatchObject({
      task: { status: "completed" },
    })
  })

  it("rejects a symlinked recovery marker before writing any output", async () => {
    await setup()
    const task = await makeTask()
    const outside = join(candidatePath, "..", "marker.json")
    await writeFile(
      outside,
      JSON.stringify({
        hash: digest(candidate(task.id)),
        output: `${task.destination}/01 Prep Brief.md`,
      }),
    )
    await symlink(outside, join(vault, "_meta", "tasks", task.id, "completion.transaction.json"))
    await expect(completeTask(vault, task.id, candidatePath)).rejects.toThrow("Symbolic links")
    expect(
      await readFile(join(vault, task.destination, "01 Prep Brief.md")).catch(() => null),
    ).toBeNull()
  })
  it("writes once, persists completion, and makes identical retries idempotent", async () => {
    await setup()
    const task = await makeTask()
    const first = await completeTask(vault, task.id, candidatePath)
    expect(task.sources.map((source) => source.path)).toContain("GSB-101/Resources/Syllabus.md")
    expect(task.sources.map((source) => source.path)).toContain("GSB-101/Assignments/case.md")
    expect(first.output).toBe("GSB-101/Week 03 - Oct 12/Prep/01 Prep Brief.md")
    expect(await readFile(join(vault, first.output), "utf8")).toBe(candidate(task.id))
    expect(first.task.status).toBe("completed")
    await expect(completeTask(vault, task.id, candidatePath)).resolves.toEqual(first)
    await writeFile(candidatePath, candidate(task.id).replace("concise", "different"))
    await expect(completeTask(vault, task.id, candidatePath)).rejects.toThrow(/different candidate/)
  })

  it("allocates versions without overwriting existing student output", async () => {
    await setup()
    const task = await makeTask()
    const prep = join(vault, task.destination)
    await mkdir(prep, { recursive: true })
    await writeFile(join(prep, "01 Prep Brief.md"), "student work")
    const result = await completeTask(vault, task.id, candidatePath)
    expect(result.output).toBe(`${task.destination}/01 Prep Brief.v2.md`)
    expect(await readFile(join(prep, "01 Prep Brief.md"), "utf8")).toBe("student work")
  })

  it("rejects bad identity, empty sections, traversal citations, and private paths", async () => {
    await setup()
    const task = await makeTask()
    for (const bad of [
      candidate("00000000-0000-4000-8000-000000000000"),
      candidate(task.id).replace(
        "## Overview\nThe lecture introduces market structure and pricing.",
        "## Overview\n",
      ),
      candidate(task.id, "../../private.md"),
      candidate(task.id).replace("Market structure affects pricing.", "See _meta/tasks/secret."),
    ]) {
      await writeFile(candidatePath, bad)
      await expect(completeTask(vault, task.id, candidatePath)).rejects.toThrow()
    }
  })

  it("rejects stale and newly relevant sources and changed course restrictions", async () => {
    await setup()
    const task = await makeTask()
    await writeFile(join(vault, course.sources[0]?.path ?? "missing-fixture"), "source changed")
    await expect(completeTask(vault, task.id, candidatePath)).rejects.toThrow(/stale|changed/i)
    await setup()
    const second = await makeTask()
    const addedPath = "GSB-101/Week 03 - Oct 12/handout.md"
    const added = "New handout"
    await writeFile(join(vault, addedPath), added)
    course.sources.push({
      path: addedPath,
      title: "handout",
      hash: digest(added),
      text: added,
      type: "markdown",
      dates: [],
    })
    await expect(completeTask(vault, second.id, candidatePath)).rejects.toThrow(/stale/)
  })

  it("detects a changed symlink path even when the warning count is unchanged", async () => {
    await setup()
    context.notices = ["Skipped symbolic link: GSB-101/old.md"]
    context.diagnostics = [
      diagnostic("workspace.symlink_skipped", context.notices[0] ?? "", {
        scope: "course",
        path: "GSB-101/old.md",
      }),
    ]
    const task = await makeTask()
    context.notices = ["Skipped symbolic link: GSB-101/new.md"]
    context.diagnostics = [
      diagnostic("workspace.symlink_skipped", context.notices[0] ?? "", {
        scope: "course",
        path: "GSB-101/new.md",
      }),
    ]
    await expect(completeTask(vault, task.id, candidatePath)).rejects.toThrow(
      /restriction notices changed/i,
    )
  })

  it("does not double-count unchanged restricted exclusions as workspace notices", async () => {
    await setup()
    course.excluded.push({
      path: "GSB-101/Week 03 - Oct 12/restricted.md",
      reason: "restricted by policy",
    })
    const task = await makeTask()
    expect(task.notices).toContain(
      "Excluded GSB-101/Week 03 - Oct 12/restricted.md: restricted by policy",
    )
    await expect(completeTask(vault, task.id, candidatePath)).resolves.toMatchObject({
      task: { status: "completed" },
    })
  })

  it("rejects symlinks in the output hierarchy and candidate path", async () => {
    await setup()
    const task = await makeTask()
    await rm(join(vault, "GSB-101", "Week 03 - Oct 12"), { recursive: true })
    await symlink(tmpdir(), join(vault, "GSB-101", "Week 03 - Oct 12"))
    await expect(completeTask(vault, task.id, candidatePath)).rejects.toThrow(
      /symlink|symbolic link/i,
    )
    await setup()
    const another = await makeTask()
    const linkCandidate = join(candidatePath, "..", "linked.md")
    await symlink(candidatePath, linkCandidate)
    await expect(completeTask(vault, another.id, linkCandidate)).rejects.toThrow(/symbolic link/i)
  })

  it("serializes concurrent identical requests to one output", async () => {
    await setup()
    const task = await makeTask()
    const results = await Promise.all([
      completeTask(vault, task.id, candidatePath),
      completeTask(vault, task.id, candidatePath),
    ])
    expect(results[0]?.output).toBe(results[1]?.output)
    expect(
      (await readdir(join(vault, task.destination))).filter((name) =>
        name.startsWith("01 Prep Brief"),
      ),
    ).toHaveLength(1)
  })

  it("rechecks task status after marker acquisition when a caller read stale pending state", async () => {
    await setup()
    const task = await makeTask()
    const first = await completeTask(vault, task.id, candidatePath)
    const actualRead = tasks.readTask
    let staleOnce = true
    const spy = vi.spyOn(tasks, "readTask").mockImplementation(async (...args) => {
      const latest = await actualRead(...args)
      if (!staleOnce) return latest
      staleOnce = false
      return {
        ...latest,
        status: "pending",
        completedAt: undefined,
        output: undefined,
        outputHash: undefined,
      }
    })
    try {
      const retry = await completeTask(vault, task.id, candidatePath)
      expect(retry.output).toBe(first.output)
      expect(
        (await readdir(join(vault, task.destination))).filter((name) =>
          name.startsWith("01 Prep Brief"),
        ),
      ).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })

  it("detects tampered snapshot text and invalid completed output references", async () => {
    await setup()
    const task = await makeTask()
    const recordPath = join(vault, "_meta", "tasks", task.id, "task.json")
    const record = JSON.parse(await readFile(recordPath, "utf8"))
    record.sources[0].text = "modified task snapshot"
    await writeFile(recordPath, JSON.stringify(record))
    await expect(completeTask(vault, task.id, candidatePath)).rejects.toThrow(/stale/)

    await setup()
    const next = await makeTask()
    const completed = await completeTask(vault, next.id, candidatePath)
    const completedPath = join(vault, "_meta", "tasks", next.id, "task.json")
    const completedRecord = JSON.parse(await readFile(completedPath, "utf8"))
    completedRecord.output = `${next.destination}/unexpected.md`
    await writeFile(completedPath, JSON.stringify(completedRecord))
    await expect(completeTask(vault, next.id, candidatePath)).rejects.toThrow(/filename/)
    expect(await readFile(join(vault, completed.output), "utf8")).toBe(candidate(next.id))
  })

  it("detects guidance snapshot text tampering even when source bytes are unchanged", async () => {
    await setup()
    const guidancePath = "GSB-101/_meta/guidance/policy.md"
    await mkdir(join(vault, "GSB-101", "_meta", "guidance"), { recursive: true })
    await writeFile(
      join(vault, guidancePath),
      "---\nai_policy: allowed\n---\nUse concise citations.\n",
    )
    course.guidance = [guidancePath]
    const task = await makeTask()
    const taskJsonPath = join(vault, "_meta", "tasks", task.id, "task.json")
    const record = JSON.parse(await readFile(taskJsonPath, "utf8"))
    record.guidance[0].text = "tampered guidance"
    await writeFile(taskJsonPath, JSON.stringify(record))
    await expect(completeTask(vault, task.id, candidatePath)).rejects.toThrow(/guidance snapshot/i)
  })

  it("stops completion when active guidance changes to a restricted policy", async () => {
    await setup()
    const guidancePath = "GSB-101/_meta/guidance/policy.md"
    const absoluteGuidance = join(vault, guidancePath)
    await mkdir(join(vault, "GSB-101", "_meta", "guidance"), { recursive: true })
    await writeFile(absoluteGuidance, "---\nai_policy: allowed\n---\nUse concise citations.\n")
    course.guidance = [guidancePath]
    const task = await makeTask()
    await writeFile(absoluteGuidance, "---\nai_policy: prohibited\n---\nUse concise citations.\n")
    await expect(completeTask(vault, task.id, candidatePath)).rejects.toThrow(/restricted|policy/i)
  })
})
