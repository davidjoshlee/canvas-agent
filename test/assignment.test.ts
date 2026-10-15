import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CourseContext, WorkspaceContext } from "../src/types.js"

const workspace = vi.hoisted(() => ({ inspectWorkspace: vi.fn(), selectCourse: vi.fn() }))
vi.mock("../src/workspace.js", () => workspace)

import { completeTask } from "../src/completion.js"
import { createAssignmentTask, readTask } from "../src/tasks.js"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
let vault = ""
const roots: string[] = []
let course: CourseContext
const source = "Prompt requirements"
const work = "Student's preliminary response"

async function setup() {
  vault = await mkdtemp(join(tmpdir(), "canvas-agent-assignment-"))
  roots.push(vault)
  await mkdir(join(vault, "GSB-101", "Assignments"), { recursive: true })
  await mkdir(join(vault, "GSB-101", "Drafts"), { recursive: true })
  await mkdir(join(vault, "GSB-101", "Guidance"), { recursive: true })
  await writeFile(join(vault, "GSB-101", "Assignments", "prompt.md"), source)
  await writeFile(join(vault, "GSB-101", "Drafts", "my draft.md"), work)
  await writeFile(join(vault, "GSB-101", "Guidance", "AI.md"), "AI review is permitted")
  course = {
    code: "GSB-101",
    title: "Strategy",
    root: "GSB-101",
    sources: [
      {
        path: "GSB-101/Assignments/prompt.md",
        title: "Prompt",
        hash: hash(source),
        text: source,
        type: "assignment",
        dates: [],
      },
    ],
    excluded: [],
    guidance: ["GSB-101/Guidance/AI.md"],
    existingWork: ["GSB-101/Drafts/my draft.md"],
  }
  const context: WorkspaceContext = {
    version: 1,
    vault,
    courses: [course],
    pendingTasks: [],
    notices: [],
  }
  workspace.inspectWorkspace.mockResolvedValue(context)
  workspace.selectCourse.mockReturnValue(course)
}

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("assignment task workflows", () => {
  it("binds group contribution scope to the saved prompt and rejects changed identities", async () => {
    await setup()
    const prompt = course.sources[0]
    if (!prompt) throw new Error("Missing synthetic prompt")
    prompt.text = "Group category: 7\nPrompt requirements"
    prompt.hash = hash(prompt.text)
    await writeFile(join(vault, prompt.path), prompt.text)
    const task = await createAssignmentTask(vault, course.code, prompt.path, "draft")
    expect(task.groupScopeVersion).toBe(1)
    expect(task.assignment?.groupCategoryId).toBe("7")
    expect(task.workflow?.instructions.join(" ")).toContain(
      "student's explicitly identified contribution",
    )
    expect(task.workflow?.instructions.join(" ")).toContain("PENDING")
    await expect(readTask(vault, task.id)).resolves.toEqual(task)
    const path = join(vault, "_meta/tasks", task.id, "task.json")
    const changed = JSON.parse(await readFile(path, "utf8"))
    changed.assignment.groupCategoryId = "8"
    await writeFile(path, JSON.stringify(changed))
    await expect(readTask(vault, task.id)).rejects.toThrow()
    changed.assignment.groupCategoryId = "7"
    delete changed.groupScopeVersion
    await writeFile(path, JSON.stringify(changed))
    await expect(readTask(vault, task.id)).rejects.toThrow()
  })
  it.each(["outline", "draft", "review"] as const)(
    "persists the complete %s workflow",
    async (mode) => {
      await setup()
      const task = await createAssignmentTask(
        vault,
        "GSB-101",
        "GSB-101/Assignments/prompt.md",
        mode,
        mode === "review" ? "GSB-101/Drafts/my draft.md" : undefined,
        ["GSB-101/Guidance/AI.md"],
      )
      expect(task.kind).toBe("assignment")
      expect(task.assignment?.mode).toBe(mode)
      expect(task.destination).toBe("GSB-101/Assignments/Drafts")
      expect(task.workflow?.instructions.length).toBeGreaterThan(0)
      expect(task.requirements).toEqual(task.workflow?.requiredSections)
      const persisted = JSON.parse(
        await readFile(join(vault, "_meta", "tasks", task.id, "task.json"), "utf8"),
      )
      expect(persisted.workflow).toEqual(task.workflow)
      expect(await readFile(join(vault, "_meta", "tasks", task.id, "TASK.md"), "utf8")).toContain(
        task.workflow?.instructions[0] ?? "",
      )
      await expect(readTask(vault, task.id)).resolves.toEqual(task)
    },
  )

  it("requires selected work for review and rejects cross-course, restricted, or unapproved inputs", async () => {
    await setup()
    await expect(
      createAssignmentTask(vault, "GSB-101", "GSB-101/Assignments/prompt.md", "review"),
    ).rejects.toThrow(/requires --work/)
    await expect(
      createAssignmentTask(vault, "GSB-101", "OTHER/Assignments/prompt.md", "outline"),
    ).rejects.toThrow()
    course.excluded.push({
      path: "GSB-101/Assignments/restricted.md",
      reason: "Restricted policy metadata",
    })
    await expect(
      createAssignmentTask(vault, "GSB-101", "GSB-101/Assignments/restricted.md", "outline"),
    ).rejects.toThrow(/restricted|approved/i)
    await expect(
      createAssignmentTask(
        vault,
        "GSB-101",
        "GSB-101/Assignments/prompt.md",
        "review",
        "GSB-101/Guidance/AI.md",
      ),
    ).rejects.toThrow(/existing-work/)
  })

  it("automatically snapshots syllabus, references, and every active course guidance file", async () => {
    await setup()
    const syllabus = "Course syllabus"
    const reference = "Reference material"
    const unrelated = "Unrelated optional reading"
    const extraGuidance = "Additional course policy"
    await mkdir(join(vault, "GSB-101", "Resources", "References"), { recursive: true })
    await mkdir(join(vault, "GSB-101", "Resources", "Files"), { recursive: true })
    await writeFile(
      join(vault, "GSB-101", "Resources", "Files", "Detailed syllabus.pdf.md"),
      "Detailed course policy",
    )
    await writeFile(join(vault, "GSB-101", "Resources", "Syllabus.md"), syllabus)
    await writeFile(join(vault, "GSB-101", "Resources", "References", "reading.md"), reference)
    await writeFile(join(vault, "GSB-101", "Resources", "unrelated.md"), unrelated)
    await writeFile(join(vault, "GSB-101", "Guidance", "AI-extra.md"), extraGuidance)
    const record = (path: string, text: string, type = "resource") => ({
      path,
      title: path.split("/").at(-1) ?? "",
      hash: hash(text),
      text,
      type,
      dates: [],
    })
    course.sources.push(
      record("GSB-101/Resources/Syllabus.md", syllabus),
      record("GSB-101/Resources/Files/Detailed syllabus.pdf.md", "Detailed course policy"),
      record("GSB-101/Resources/References/reading.md", reference),
      record("GSB-101/Resources/unrelated.md", unrelated),
    )
    course.guidance.push("GSB-101/Guidance/AI-extra.md")
    const task = await createAssignmentTask(
      vault,
      "GSB-101",
      "GSB-101/Assignments/prompt.md",
      "outline",
    )
    expect(task.sources.map((item) => item.path)).toEqual([
      "GSB-101/Assignments/prompt.md",
      "GSB-101/Resources/Files/Detailed syllabus.pdf.md",
      "GSB-101/Resources/References/reading.md",
      "GSB-101/Resources/Syllabus.md",
    ])
    expect(task.sources.map((item) => item.path)).not.toContain("GSB-101/Resources/unrelated.md")
    expect(task.guidance.map((item) => item.path)).toEqual(course.guidance)
  })

  it("detects prompt and selected work changes during task creation", async () => {
    await setup()
    await writeFile(join(vault, "GSB-101", "Assignments", "prompt.md"), "changed")
    await expect(
      createAssignmentTask(vault, "GSB-101", "GSB-101/Assignments/prompt.md", "outline"),
    ).rejects.toThrow(/changed/)
    await setup()
    const task = await createAssignmentTask(
      vault,
      "GSB-101",
      "GSB-101/Assignments/prompt.md",
      "review",
      "GSB-101/Drafts/my draft.md",
    )
    await writeFile(join(vault, "GSB-101", "Drafts", "my draft.md"), "changed")
    const candidatePath = join(vault, "candidate.md")
    await writeFile(
      candidatePath,
      `Task: ${task.id}\n\n## Assignment requirements\nMap requirements.\n\n## Review\nReview.\n\n## Suggested revisions\nRevise.\n\n## Open questions\nNone.\n\n## Sources\n- \`GSB-101/Assignments/prompt.md\`\n- \`GSB-101/Drafts/my draft.md\`\n`,
    )
    await expect(completeTask(vault, task.id, candidatePath)).rejects.toThrow(/stale|changed/i)
  })

  it("saves completion beside the prompt without overwriting existing work and rejects workflow edits", async () => {
    await setup()
    const task = await createAssignmentTask(
      vault,
      "GSB-101",
      "GSB-101/Assignments/prompt.md",
      "outline",
    )
    const destination = join(vault, task.destination)
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, "01 Assignment Outline.md"), "student-owned file")
    const candidatePath = join(vault, "candidate.md")
    const sections = task.workflow?.requiredSections ?? []
    await writeFile(
      candidatePath,
      [
        `Task: ${task.id}`,
        ...sections.map((heading) =>
          heading === "Sources"
            ? `## Sources\n- \`GSB-101/Assignments/prompt.md\``
            : `## ${heading}\nEvidence.`,
        ),
        "",
      ].join("\n\n"),
    )
    const result = await completeTask(vault, task.id, candidatePath)
    expect(result.output).toBe(`${task.destination}/01 Assignment Outline.v2.md`)
    expect(await readFile(join(destination, "01 Assignment Outline.md"), "utf8")).toBe(
      "student-owned file",
    )

    const recordPath = join(vault, "_meta", "tasks", task.id, "task.json")
    const record = JSON.parse(await readFile(recordPath, "utf8"))
    record.workflow.instructions[0] = "Changed instructions"
    await writeFile(recordPath, JSON.stringify(record))
    await expect(readTask(vault, task.id)).rejects.toThrow(/workflow was modified/i)
  })

  it("rejects edited source and guidance snapshots at completion", async () => {
    await setup()
    const task = await createAssignmentTask(
      vault,
      "GSB-101",
      "GSB-101/Assignments/prompt.md",
      "outline",
      undefined,
      ["GSB-101/Guidance/AI.md"],
    )
    const candidatePath = join(vault, "candidate.md")
    await writeFile(
      candidatePath,
      [
        `Task: ${task.id}`,
        ...(task.workflow?.requiredSections ?? []).map((heading) =>
          heading === "Sources"
            ? `## Sources\n- \`GSB-101/Assignments/prompt.md\``
            : `## ${heading}\nEvidence.`,
        ),
        "",
      ].join("\n\n"),
    )
    const path = join(vault, "_meta", "tasks", task.id, "task.json")
    const record = JSON.parse(await readFile(path, "utf8"))
    record.sources[0].text = "Forged prompt snapshot"
    await writeFile(path, JSON.stringify(record))
    await expect(completeTask(vault, task.id, candidatePath)).rejects.toThrow(/stale|snapshot/i)

    await setup()
    const second = await createAssignmentTask(
      vault,
      "GSB-101",
      "GSB-101/Assignments/prompt.md",
      "outline",
    )
    await writeFile(join(vault, "GSB-101", "Guidance", "AI.md"), "Changed policy")
    const candidate2 = join(vault, "candidate.md")
    await writeFile(
      candidate2,
      [
        `Task: ${second.id}`,
        ...(second.workflow?.requiredSections ?? []).map((heading) =>
          heading === "Sources"
            ? `## Sources\n- \`GSB-101/Assignments/prompt.md\``
            : `## ${heading}\nEvidence.`,
        ),
        "",
      ].join("\n\n"),
    )
    await expect(completeTask(vault, second.id, candidate2)).rejects.toThrow(/guidance|stale/i)
  })
})
