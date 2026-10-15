import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CourseContext, WorkspaceContext } from "../../src/shared/types.js"

const workspace = vi.hoisted(() => ({ inspectWorkspace: vi.fn(), selectCourse: vi.fn() }))
vi.mock("../../src/vault/workspace.js", () => workspace)

import { createPrepTask, readTask } from "../../src/tasks/store.js"

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
  it("rejects heading-only sessions even when an empty reading is linked", async () => {
    await setup()
    const source = course.sources[0]
    if (!source) throw new Error("Missing fixture source")
    source.text = "## Session 4: Dispute Resolution\n"
    source.hash = digest(source.text)
    source.type = "modules"
    await writeFile(join(vault, source.path), source.text)
    await mkdir(join(vault, "GSB-101", "Week 03 - Oct 12", "Materials"))
    const path = "GSB-101/Week 03 - Oct 12/Materials/empty.pdf.md"
    await writeFile(join(vault, path), "")
    course.sources.push({
      path,
      title: "Empty reading",
      hash: digest(""),
      text: "",
      type: "files",
      dates: [],
    })
    await expect(createPrepTask(vault, "GSB-101", "2026-10-12")).rejects.toThrow(
      /No readable course materials/,
    )
  })
  it("warns about empty readings when other substantive notes support the task", async () => {
    await setup()
    const path = "GSB-101/Week 03 - Oct 12/empty.md"
    await writeFile(join(vault, path), "")
    course.sources.push({
      path,
      title: "Empty reading",
      hash: digest(""),
      text: "",
      type: "files",
      dates: [],
    })
    const task = await createPrepTask(vault, "GSB-101", "2026-10-12")
    expect(task.notices).toContain(
      `No readable text in selected source: ${path}; supply extracted text before synthesizing this reading.`,
    )
  })
  it.each(["Session 4: Dispute Resolution", "<h2>Session 4: Dispute Resolution</h2>"])(
    "rejects plain or HTML title-only module content: %s",
    async (text) => {
      await setup()
      const source = course.sources[0]
      if (!source) throw new Error("Missing fixture source")
      source.title = "Session 4: Dispute Resolution"
      source.type = "modules"
      source.text = text
      source.hash = digest(text)
      await writeFile(join(vault, source.path), text)
      await expect(createPrepTask(vault, "GSB-101", "2026-10-12")).rejects.toThrow(
        /No readable course materials/,
      )
    },
  )
  it("does not count an empty reading sidecar as readable preparation material", async () => {
    await setup()
    const source = course.sources[0]
    if (!source) throw new Error("Missing fixture source")
    source.text = ""
    source.hash = digest("")
    source.type = "files"
    await writeFile(join(vault, source.path), "")
    await expect(createPrepTask(vault, "GSB-101", "2026-10-12")).rejects.toThrow(
      /No readable course materials/,
    )
  })
  it("snapshots target week sources and persists a readable identity and citation contract", async () => {
    await setup()
    const task = await createPrepTask(vault, "GSB-101", "2026-10-12")
    expect(task.destination).toBe("GSB-101/Week 03 - Oct 12/Prep")
    expect(task.sources).toHaveLength(1)
    expect(task.sources[0]?.text).toBe(sourceText)
    expect(task.requirements).toEqual([
      "Overview",
      "Reading synthesis",
      "Key concepts",
      "Preparation questions",
      "Discussion points",
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

  it("defaults to the current Monday and rejects simultaneous week and session selectors", async () => {
    await setup()
    const task = await createPrepTask(vault, "GSB-101", undefined, {
      now: new Date("2026-10-14T18:00:00.000Z"),
    })
    expect(task.period).toMatchObject({ kind: "week", value: "2026-10-12" })
    await expect(
      createPrepTask(vault, "GSB-101", "2026-10-12", { session: "Session 3" }),
    ).rejects.toThrow(/either a week or a session/)
  })

  it("selects session sources by exact title, snapshots related sources and course references", async () => {
    await setup()
    const moduleText = "Session 4 lecture overview."
    const readingText = "The reading develops bargaining and commitment."
    const syllabusText = "The course studies strategy."
    await mkdir(join(vault, "GSB-101", "Week 03 - Oct 12", "Modules"), { recursive: true })
    await mkdir(join(vault, "GSB-101", "Resources"), { recursive: true })
    await writeFile(
      join(vault, "GSB-101", "Week 03 - Oct 12", "Modules", "Session 4.md"),
      moduleText,
    )
    await writeFile(join(vault, "GSB-101", "Week 03 - Oct 12", "reading.md"), readingText)
    await writeFile(join(vault, "GSB-101", "Resources", "Syllabus.md"), syllabusText)
    course.sources = [
      {
        path: "GSB-101/Week 03 - Oct 12/Modules/Session 4.md",
        title: "Session 4",
        hash: digest(moduleText),
        text: moduleText,
        type: "module",
        dates: [],
        canvasId: "module-4",
        relatedPaths: ["Week 03 - Oct 12/reading.md"],
      },
      {
        path: "GSB-101/Week 03 - Oct 12/reading.md",
        title: "Reading",
        hash: digest(readingText),
        text: readingText,
        type: "reading",
        dates: [],
      },
      {
        path: "GSB-101/Resources/Syllabus.md",
        title: "Syllabus",
        hash: digest(syllabusText),
        text: syllabusText,
        type: "resource",
        dates: [],
      },
    ]
    const task = await createPrepTask(vault, "GSB-101", undefined, { session: "Session 4" })
    expect(task.period).toMatchObject({
      kind: "session",
      value: "Session 4",
      root: "GSB-101/Week 03 - Oct 12",
    })
    expect(task.sources.map((source) => source.path)).toEqual([
      "GSB-101/Resources/Syllabus.md",
      "GSB-101/Week 03 - Oct 12/Modules/Session 4.md",
      "GSB-101/Week 03 - Oct 12/reading.md",
    ])
    await expect(readTask(vault, task.id)).resolves.toEqual(task)
  })

  it("rejects a flat Canvas module index plus syllabus when linked readings are unavailable", async () => {
    await setup()
    const modulePath = "GSB-101/Canvas/Modules/2026-10-12-24.md"
    const syllabusPath = "GSB-101/Resources/Syllabus.md"
    const moduleText =
      "# 2026-10-12\n\n- Case (https://canvas.example.edu/cases/1)\n- Reading (https://canvas.example.edu/files/2)"
    const syllabusText = "# Course overview\nA broad description of the course."
    await mkdir(join(vault, "GSB-101/Canvas/Modules"), { recursive: true })
    await mkdir(join(vault, "GSB-101/Resources"), { recursive: true })
    await writeFile(join(vault, modulePath), moduleText)
    await writeFile(join(vault, syllabusPath), syllabusText)
    course.sources = [
      {
        path: modulePath,
        title: "2026-10-12",
        hash: digest(moduleText),
        text: moduleText,
        type: "module",
        dates: ["2026-10-12"],
        canvasId: "24",
      },
      {
        path: syllabusPath,
        title: "Syllabus",
        hash: digest(syllabusText),
        text: syllabusText,
        type: "resource",
        dates: [],
      },
    ]
    await expect(
      createPrepTask(vault, "GSB-101", undefined, { session: "2026-10-12" }),
    ).rejects.toThrow(/No readable course materials/)
  })

  it("accepts a flat module when it contains substantive questions and follows an exact dated title to its reading", async () => {
    await setup()
    const modulePath = "GSB-101/Canvas/Modules/2026-10-12-24.md"
    const readingPath = "GSB-101/Canvas/Files/reading.txt.extracted.md"
    const syllabusPath = "GSB-101/Resources/Syllabus.md"
    const moduleText =
      "# 2026-10-12\n\n## Preparation questions\n- How does entry change the market outcome?"
    const readingText =
      "The reading explains that entry changes market outcomes through competitive pricing and cost pressure."
    const syllabusText = "# Course overview\nA broad description of the course."
    await mkdir(join(vault, "GSB-101/Canvas/Modules"), { recursive: true })
    await mkdir(join(vault, "GSB-101/Canvas/Files"), { recursive: true })
    await mkdir(join(vault, "GSB-101/Resources"), { recursive: true })
    await writeFile(join(vault, modulePath), moduleText)
    await writeFile(join(vault, readingPath), readingText)
    await writeFile(join(vault, syllabusPath), syllabusText)
    course.sources = [
      {
        path: modulePath,
        title: "2026-10-12",
        hash: digest(moduleText),
        text: moduleText,
        type: "module",
        dates: ["2026-10-12"],
        canvasId: "24",
        relatedPaths: [readingPath],
      },
      {
        path: readingPath,
        title: "Reading",
        hash: digest(readingText),
        text: readingText,
        type: "reading",
        dates: [],
      },
      {
        path: syllabusPath,
        title: "Syllabus",
        hash: digest(syllabusText),
        text: syllabusText,
        type: "resource",
        dates: [],
      },
    ]
    const bySession = await createPrepTask(vault, "GSB-101", undefined, { session: "2026-10-12" })
    expect(bySession.sources.map((source) => source.path)).toContain(readingPath)
    expect(bySession.questions).toEqual(["How does entry change the market outcome?"])
    const byWeek = await createPrepTask(vault, "GSB-101", "2026-10-12")
    expect(byWeek.sources.map((source) => source.path)).toContain(modulePath)
    expect(byWeek.sources.map((source) => source.path)).toContain(readingPath)
  })

  it("does not guess that an unknown undated Canvas module belongs to a selected week", async () => {
    await setup()
    const lecturePath = "GSB-101/Week 03 - Oct 12/lecture.md"
    const modulePath = "GSB-101/Canvas/Modules/Untitled-24.md"
    const readingPath = "GSB-101/Canvas/Files/unrelated.txt.extracted.md"
    const lectureText = "Week notes: pricing and market structure."
    const moduleText = "# Untitled\n\n- Unrelated reading (https://canvas.example.edu/files/2)"
    const readingText = "This reading belongs to another module."
    await mkdir(join(vault, "GSB-101/Canvas/Modules"), { recursive: true })
    await mkdir(join(vault, "GSB-101/Canvas/Files"), { recursive: true })
    await writeFile(join(vault, lecturePath), lectureText)
    await writeFile(join(vault, modulePath), moduleText)
    await writeFile(join(vault, readingPath), readingText)
    course.sources = [
      {
        path: lecturePath,
        title: "Lecture",
        hash: digest(lectureText),
        text: lectureText,
        type: "week",
        dates: [],
      },
      {
        path: modulePath,
        title: "Untitled",
        hash: digest(moduleText),
        text: moduleText,
        type: "module",
        dates: [],
        canvasId: "24",
        relatedPaths: [readingPath],
      },
      {
        path: readingPath,
        title: "Other reading",
        hash: digest(readingText),
        text: readingText,
        type: "reading",
        dates: [],
      },
    ]
    const task = await createPrepTask(vault, "GSB-101", "2026-10-12")
    expect(task.sources.map((source) => source.path)).not.toContain(modulePath)
    expect(task.sources.map((source) => source.path)).not.toContain(readingPath)
  })

  it("rejects ambiguous session selectors and course-reference-only prep", async () => {
    await setup()
    const syllabus = "Course overview."
    await mkdir(join(vault, "GSB-101", "Resources"), { recursive: true })
    await writeFile(join(vault, "GSB-101", "Resources", "Syllabus.md"), syllabus)
    course.sources = [
      {
        path: "GSB-101/Resources/Syllabus.md",
        title: "Syllabus",
        hash: digest(syllabus),
        text: syllabus,
        type: "resource",
        dates: [],
      },
    ]
    await expect(createPrepTask(vault, "GSB-101", "2026-10-12")).rejects.toThrow(
      /No readable course materials/,
    )
    course.sources.push(
      ...["A", "B"].map((label) => ({
        path: `GSB-101/Modules/Session 2 ${label}.md`,
        title: "Session 2",
        hash: digest(label),
        text: label,
        type: "module",
        dates: [],
        canvasId: `module-${label}`,
      })),
    )
    await expect(
      createPrepTask(vault, "GSB-101", undefined, { session: "Session 2" }),
    ).rejects.toThrow(/ambiguous/)
  })

  it("keeps task sources bound to the selected course when the workspace has two courses", async () => {
    await setup()
    const firstSource = course.sources[0]
    if (!firstSource) throw new Error("Fixture source is missing")
    const second: CourseContext = {
      ...course,
      code: "GSB-202",
      title: "Finance",
      root: "GSB-202",
      sources: [
        {
          ...firstSource,
          path: "GSB-202/Week 03 - Oct 12/lecture.md",
          title: "Finance lecture",
        },
      ],
    }
    await mkdir(join(vault, "GSB-202", "Week 03 - Oct 12"), { recursive: true })
    const secondSource = second.sources[0]
    if (!secondSource) throw new Error("Second-course fixture source is missing")
    await writeFile(join(vault, secondSource.path), sourceText)
    context.courses.push(second)
    workspace.selectCourse.mockReturnValue(second)
    const task = await createPrepTask(vault, "GSB-202", "2026-10-12")
    expect(task.course).toMatchObject({ code: "GSB-202", root: "GSB-202" })
    expect(task.sources.map((source) => source.path)).toEqual([secondSource.path])
  })

  it("refuses a syllabus-only or empty prep handoff rather than pretending the class is prepared", async () => {
    await setup()
    course.sources = []
    course.existingWork = []
    await expect(createPrepTask(vault, "GSB-101", "2026-10-12")).rejects.toThrow(
      /No readable course materials/,
    )
  })

  it("reads tasks saved under a conventional one-digit week folder", async () => {
    await setup()
    course.sources = []
    course.existingWork = []
    course.periods = ["GSB-101/Week 2 - Oct 12"]
    await mkdir(join(vault, "GSB-101", "Week 2 - Oct 12"), { recursive: true })
    const path = "GSB-101/Week 2 - Oct 12/lecture.md"
    await writeFile(join(vault, path), sourceText)
    course.sources.push({
      path,
      title: "Lecture",
      hash: digest(sourceText),
      text: sourceText,
      type: "week",
      dates: [],
    })
    const task = await createPrepTask(vault, "GSB-101", "2026-10-12")
    expect(task.destination).toBe("GSB-101/Week 2 - Oct 12/Prep")
    await expect(readTask(vault, task.id)).resolves.toEqual(task)
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
