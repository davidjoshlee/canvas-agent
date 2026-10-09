import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CourseContext, WorkspaceContext } from "../src/types.js"

const workspace = vi.hoisted(() => ({ inspectWorkspace: vi.fn(), selectCourse: vi.fn() }))
vi.mock("../src/workspace.js", () => workspace)

import { completeTask } from "../src/completion.js"
import { approveTask, reviseTask } from "../src/lifecycle.js"
import { createAssignmentTask } from "../src/tasks.js"

const digest = (text: string) => createHash("sha256").update(text).digest("hex")
let vault = ""
let candidate = ""
let course: CourseContext
let context: WorkspaceContext

async function setup() {
  vault = await mkdtemp(join(tmpdir(), "canvas-lifecycle-"))
  candidate = join(await mkdtemp(join(tmpdir(), "canvas-lifecycle-candidate-")), "draft.md")
  const sourcePath = "GSB-101/Assignments/Case/prompt.md"
  const prompt = "Explain the case's strategic choice using the supplied evidence."
  await mkdir(join(vault, "GSB-101/Assignments/Case"), { recursive: true })
  await writeFile(join(vault, sourcePath), prompt)
  course = {
    code: "GSB-101",
    title: "Strategy",
    root: "GSB-101",
    sources: [
      {
        path: sourcePath,
        title: "Prompt",
        hash: digest(prompt),
        text: prompt,
        type: "assignment",
        dates: [],
      },
    ],
    excluded: [],
    guidance: [],
    existingWork: [],
  }
  context = { version: 1, vault, courses: [course], pendingTasks: [], notices: [] }
  workspace.inspectWorkspace.mockResolvedValue(context)
  workspace.selectCourse.mockReturnValue(course)
}

async function completedDraft() {
  const prompt = course.sources[0]
  if (!prompt) throw new Error("Fixture prompt is missing")
  const task = await createAssignmentTask(vault, "GSB-101", prompt.path, "draft")
  const body = task.requirements
    .map((heading) =>
      heading === "Sources"
        ? `## Sources\n- \`${prompt.path}\``
        : `## ${heading}\nA careful response grounded in the supplied case evidence.`,
    )
    .join("\n\n")
  await writeFile(candidate, `Task: ${task.id}\n\n${body}\n`)
  return completeTask(vault, task.id, candidate)
}

afterEach(async () => {
  vi.clearAllMocks()
  if (vault) await rm(vault, { recursive: true, force: true })
  if (candidate) await rm(join(candidate, ".."), { recursive: true, force: true })
})

describe("assignment lifecycle", () => {
  it("approves a completed draft by preserving a versioned copy and returning it on retries", async () => {
    await setup()
    const completed = await completedDraft()
    const protectedFinal = "GSB-101/Assignments/Case/Finals/01 Assignment Final.md"
    await mkdir(join(vault, "GSB-101/Assignments/Case/Finals"), { recursive: true })
    await writeFile(join(vault, protectedFinal), "student-authored final")
    const first = await approveTask(vault, completed.task.id)
    expect(first.output).toBe("GSB-101/Assignments/Case/Finals/01 Assignment Final.v2.md")
    expect(await readFile(join(vault, first.output), "utf8")).toBe(
      await readFile(join(vault, completed.output), "utf8"),
    )
    const retry = await approveTask(vault, completed.task.id)
    expect(retry.output).toBe(first.output)
    expect(await readFile(join(vault, protectedFinal), "utf8")).toBe("student-authored final")
  })

  it("creates a new draft task from the verified completed output without changing it", async () => {
    await setup()
    const completed = await completedDraft()
    const original = await readFile(join(vault, completed.output), "utf8")
    const revision = await reviseTask(
      vault,
      completed.task.id,
      "Add a clearer comparison of the alternatives.",
    )
    expect(revision).toMatchObject({
      status: "pending",
      kind: "assignment",
      parentTaskId: completed.task.id,
      feedback: "Add a clearer comparison of the alternatives.",
      assignment: { mode: "draft", work: completed.output },
    })
    expect(revision.workflow?.version).toBe(2)
    expect(revision.sources[0]?.path).toBe(course.sources[0]?.path)
    expect(
      revision.sources.some(
        (source) => source.path === completed.output && source.type === "student-work",
      ),
    ).toBe(true)
    expect(await readFile(join(vault, completed.output), "utf8")).toBe(original)
    await expect(
      reviseTask(vault, completed.task.id, "Add a clearer comparison of the alternatives."),
    ).resolves.toMatchObject({ id: revision.id, parentTaskId: completed.task.id })
  })
})
