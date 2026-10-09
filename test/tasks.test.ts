import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CourseContext, WorkspaceContext } from "../src/types.js"

const workspace = vi.hoisted(() => ({ inspectWorkspace: vi.fn(), selectCourse: vi.fn() }))
vi.mock("../src/workspace.js", () => workspace)

import { createPrepTask, readTask } from "../src/tasks.js"

const digest = (text: string) => createHash("sha256").update(text).digest("hex")
let vault = ""
let sourceText = "Week notes: pricing and market structure."
let course: CourseContext
let context: WorkspaceContext

async function setup() {
  vault = await mkdtemp(join(tmpdir(), "canvas-agent-task-"))
  sourceText = "Week notes: pricing and market structure."
  await mkdir(join(vault, "GSB-101", "Week 03 - Oct 12"), { recursive: true })
  await writeFile(join(vault, "GSB-101", "Week 03 - Oct 12", "lecture.md"), sourceText)
  course = {
    code: "GSB-101",
    title: "Strategy",
    root: "GSB-101",
    sources: [
      {
        path: "GSB-101/Week 03 - Oct 12/lecture.md",
        title: "lecture.md",
        hash: digest(sourceText),
        text: sourceText,
        type: "markdown",
        dates: [],
      },
    ],
    excluded: [],
    guidance: [],
    existingWork: ["GSB-101/Week 03 - Oct 12"],
  }
  context = { version: 1, vault, courses: [course], pendingTasks: [], notices: [] }
  workspace.inspectWorkspace.mockResolvedValue(context)
  workspace.selectCourse.mockReturnValue(course)
}

afterEach(async () => {
  vi.clearAllMocks()
  if (vault) await rm(vault, { recursive: true, force: true })
})

describe("prep task persistence", () => {
  it("snapshots target week sources and persists a readable identity and citation contract", async () => {
    await setup()
    const task = await createPrepTask(vault, "GSB-101", "2026-10-12")
    expect(task.destination).toBe("GSB-101/Week 03 - Oct 12/Prep")
    expect(task.sources).toHaveLength(1)
    expect(task.sources[0]?.text).toBe(sourceText)
    expect(task.requirements).toEqual([
      "Summary",
      "Key concepts",
      "Discussion questions",
      "Sources",
    ])
    const taskDir = join(vault, "_meta", "tasks", task.id)
    const markdown = await readFile(join(taskDir, "TASK.md"), "utf8")
    expect(markdown).toContain(`Task: ${task.id}`)
    expect(markdown).toContain("`GSB-101/Week 03 - Oct 12/lecture.md`")
    expect(markdown).toContain("does not authorize AI use")
    expect(markdown).toContain("untrusted reference material")
    await expect(readTask(vault, task.id)).resolves.toEqual(task)
  })

  it("requires an actual Monday and refuses stale source bytes", async () => {
    await setup()
    await expect(createPrepTask(vault, "GSB-101", "2026-10-13")).rejects.toThrow(/Monday/)
    await writeFile(
      join(vault, "GSB-101", "Week 03 - Oct 12", "lecture.md"),
      "edited after inspection",
    )
    await expect(createPrepTask(vault, "GSB-101", "2026-10-12")).rejects.toThrow(/Source changed/)
  })

  it("uses the conventional Other/Prep destination and explains absent source context", async () => {
    await setup()
    course.sources = []
    course.existingWork = []
    const task = await createPrepTask(vault, "GSB-101", "2026-10-12")
    expect(task.destination).toBe("GSB-101/Other/Prep/2026-10-12")
    expect(task.sources).toEqual([])
    expect(task.notices.join(" ")).toContain("No readable source material")
    expect(task.notices.join(" ")).toContain("No matching dated Week folder")
  })

  it("selects dated week materials and course references without sweeping unrelated resources", async () => {
    await setup()
    const dated = "Assignment prompt for the week."
    const resource = "An unrelated reading."
    await mkdir(join(vault, "GSB-101", "Assignments"), { recursive: true })
    await mkdir(join(vault, "GSB-101", "Resources"), { recursive: true })
    await writeFile(join(vault, "GSB-101", "Assignments", "case.md"), dated)
    await writeFile(join(vault, "GSB-101", "Resources", "extra.md"), resource)
    course.sources.push(
      {
        path: "GSB-101/Assignments/case.md",
        title: "Case",
        hash: digest(dated),
        text: dated,
        type: "assignment",
        dates: ["2026-10-14"],
      },
      {
        path: "GSB-101/Resources/extra.md",
        title: "Extra",
        hash: digest(resource),
        text: resource,
        type: "resource",
        dates: [],
      },
    )
    const task = await createPrepTask(vault, "GSB-101", "2026-10-12")
    expect(task.sources.map((source) => source.path)).toContain("GSB-101/Assignments/case.md")
    expect(task.sources.map((source) => source.path)).not.toContain("GSB-101/Resources/extra.md")
  })

  it("rejects invalid identities, modified schema, and symlinked private task paths", async () => {
    await setup()
    const task = await createPrepTask(vault, "GSB-101", "2026-10-12")
    await expect(readTask(vault, "../../task.json")).rejects.toThrow(/ID/)
    const recordPath = join(vault, "_meta", "tasks", task.id, "task.json")
    const record = JSON.parse(await readFile(recordPath, "utf8"))
    record.course.root = "../outside"
    await writeFile(recordPath, JSON.stringify(record))
    await expect(readTask(vault, task.id)).rejects.toThrow()
    await rm(join(vault, "_meta", "tasks"), { recursive: true })
    await symlink(tmpdir(), join(vault, "_meta", "tasks"))
    await expect(readTask(vault, task.id)).rejects.toThrow(/Symbolic links/)
  })
})
