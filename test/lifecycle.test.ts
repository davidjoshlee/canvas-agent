import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CourseContext, WorkspaceContext } from "../src/types.js"

const workspace = vi.hoisted(() => ({ inspectWorkspace: vi.fn(), selectCourse: vi.fn() }))
vi.mock("../src/workspace.js", () => workspace)

import { completeTask } from "../src/completion.js"
import { approveTask, reviseTask } from "../src/lifecycle.js"
import { createAssignmentTask, readTask } from "../src/tasks.js"
import { compareTasks, reviewGate } from "../src/tools.js"
import type { ToolkitConfig } from "../src/types.js"

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

async function completedDraft(extra = "") {
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
  await writeFile(candidate, `Task: ${task.id}\n\n${body}\n${extra}`)
  return completeTask(vault, task.id, candidate)
}

afterEach(async () => {
  vi.clearAllMocks()
  if (vault) await rm(vault, { recursive: true, force: true })
  if (candidate) await rm(join(candidate, ".."), { recursive: true, force: true })
})

describe("assignment lifecycle", () => {
  it("includes verified automatic companions in comparisons/review and refuses tampering before new bundles", async () => {
    await setup()
    const table = (value: number) =>
      `\n### Schedule\n| Label | Value |\n| --- | --- |\n| Cash | ${value} |\n`
    const left = await completedDraft(table(500))
    const right = await completedDraft(table(750))
    const config: ToolkitConfig = {
      version: 1,
      canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "UNUSED" },
      vault: { path: vault },
      courses: { allowlist: [] },
    }
    const compared = await compareTasks(vault, left.task.id, right.task.id)
    expect(compared.automaticWorkbooks).toMatchObject({
      change: "changed-bytes",
      before: { state: "verified", workbook: left.task.workbook },
      after: { state: "verified", workbook: right.task.workbook },
    })
    expect((await compareTasks(vault, left.task.id, left.task.id)).automaticWorkbooks.change).toBe(
      "same-bytes",
    )
    const gate = await reviewGate(config, left.task.id)
    expect(gate.automaticWorkbook).toMatchObject({
      state: "verified",
      workbook: left.task.workbook,
    })
    const report = await readFile(join(vault, gate.path), "utf8")
    expect(report).toContain(left.task.workbook?.hash)
    expect(report).toContain(left.task.workbook?.path)
    expect(report).toContain("Explicit workbook-command artifacts are not inventoried")
    const original = await readFile(join(vault, left.task.workbook?.path ?? "missing"))
    const before = await readdir(join(vault, left.task.destination))
    await writeFile(join(vault, left.task.workbook?.path ?? "missing"), "changed companion")
    await expect(reviewGate(config, left.task.id)).rejects.toThrow(/workbook.*modified/i)
    await expect(compareTasks(vault, left.task.id, right.task.id)).rejects.toThrow(
      /workbook.*modified/i,
    )
    expect(await readdir(join(vault, left.task.destination))).toEqual(before)
    await unlink(join(vault, left.task.workbook?.path ?? "missing"))
    await expect(reviewGate(config, left.task.id)).rejects.toThrow()
    await expect(
      readFile(join(vault, left.task.workbook?.path ?? "missing")),
    ).rejects.toMatchObject({ code: "ENOENT" })
    await writeFile(join(vault, left.task.workbook?.path ?? "missing"), original)
    expect((await compareTasks(vault, left.task.id, right.task.id)).automaticWorkbooks.change).toBe(
      "changed-bytes",
    )
  })

  it("distinguishes empty extraction, pending work and uncaptured legacy companions", async () => {
    await setup()
    const empty = await completedDraft()
    const config: ToolkitConfig = {
      version: 1,
      canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "UNUSED" },
      vault: { path: vault },
      courses: { allowlist: [] },
    }
    expect((await reviewGate(config, empty.task.id)).automaticWorkbook.state).toBe("verified-empty")
    expect(
      (await compareTasks(vault, empty.task.id, empty.task.id)).automaticWorkbooks.change,
    ).toBe("none-extracted")
    const withBook = await completedDraft(
      "\n### Schedule\n| Label | Value |\n| --- | --- |\n| Cash | 500 |\n",
    )
    expect(
      (await compareTasks(vault, empty.task.id, withBook.task.id)).automaticWorkbooks.change,
    ).toBe("added")
    expect(
      (await compareTasks(vault, withBook.task.id, empty.task.id)).automaticWorkbooks.change,
    ).toBe("removed")
    const pending = await createAssignmentTask(
      vault,
      "GSB-101",
      course.sources[0]?.path ?? "missing",
      "draft",
    )
    expect((await compareTasks(vault, pending.id, empty.task.id)).automaticWorkbooks).toMatchObject(
      { before: { state: "pending" }, change: "unknown" },
    )
    const recordPath = join(vault, "_meta/tasks", empty.task.id, "task.json")
    const legacy = JSON.parse(await readFile(recordPath, "utf8"))
    delete legacy.workbookVersion
    const bytes = JSON.stringify(legacy)
    await writeFile(recordPath, bytes)
    expect((await reviewGate(config, empty.task.id)).automaticWorkbook.state).toBe(
      "uncaptured-legacy",
    )
    expect(
      (await compareTasks(vault, empty.task.id, empty.task.id)).automaticWorkbooks.change,
    ).toBe("unknown")
    expect(await readFile(recordPath, "utf8")).toBe(bytes)
  })
  it("recovers a paired interrupted completion without replacing protected workbook versions", async () => {
    await setup()
    const prompt = course.sources[0]?.path ?? "missing"
    const task = await createAssignmentTask(vault, "GSB-101", prompt, "draft")
    const text = `Task: ${task.id}\n\n${task.requirements.map((heading) => `## ${heading}\n${heading === "Sources" ? `\`${prompt}\`` : "Synthetic grounded structural response."}`).join("\n\n")}\n\n### Schedule\n| Label | Value |\n| --- | --- |\n| Cash | 500 |\n`
    await writeFile(candidate, text)
    const destination = join(vault, task.destination)
    await mkdir(destination, { recursive: true })
    const protectedPath = join(destination, "01 Assignment Draft.xlsx")
    await writeFile(protectedPath, "student-owned workbook")
    const output = `${task.destination}/01 Assignment Draft.v2.md`
    // A crashed writer already reserved and wrote only the Markdown half.
    await writeFile(join(vault, output), text)
    await writeFile(
      join(vault, "_meta/tasks", task.id, "completion.transaction.json"),
      JSON.stringify({ hash: digest(text), output }),
    )
    const recovered = await completeTask(vault, task.id, candidate)
    expect(recovered.output).toBe(output)
    expect(recovered.task.workbook?.path).toBe(output.replace(/\.md$/, ".xlsx"))
    expect(await readFile(protectedPath, "utf8")).toBe("student-owned workbook")
    expect((await completeTask(vault, task.id, candidate)).output).toBe(output)
    const next = await createAssignmentTask(vault, "GSB-101", prompt, "draft")
    await writeFile(candidate, text.replace(task.id, next.id))
    const fresh = await completeTask(vault, next.id, candidate)
    expect(fresh.output).toBe(`${task.destination}/01 Assignment Draft.v3.md`)
    expect(fresh.task.workbook?.path).toBe(fresh.output.replace(/\.md$/, ".xlsx"))
    expect(await readFile(protectedPath, "utf8")).toBe("student-owned workbook")
  })

  it("does not retrofit workbook behavior into coherent older draft records", async () => {
    await setup()
    const prompt = course.sources[0]?.path ?? "missing"
    const task = await createAssignmentTask(vault, "GSB-101", prompt, "draft")
    const recordPath = join(vault, "_meta/tasks", task.id, "task.json")
    const older = JSON.parse(await readFile(recordPath, "utf8"))
    delete older.workbookVersion
    await writeFile(recordPath, JSON.stringify(older))
    const text = `Task: ${task.id}\n\n${task.requirements.map((heading) => `## ${heading}\n${heading === "Sources" ? `\`${prompt}\`` : "Synthetic structural response."}`).join("\n\n")}\n\n### Schedule\n| Label | Value |\n| --- | --- |\n| Cash | 500 |\n`
    await writeFile(candidate, text)
    const completed = await completeTask(vault, task.id, candidate)
    expect(completed.task.workbook).toBeUndefined()
    expect((await readTask(vault, task.id)).workbookVersion).toBeUndefined()
    await expect(
      readFile(join(vault, completed.output.replace(/\.md$/, ".xlsx"))),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })
  it("automatically binds a workbook, retries unchanged and refuses workbook tampering before revision/approval", async () => {
    await setup()
    const completed = await completedDraft(
      "\n### Cash schedule\n| Label | Value |\n| --- | --- |\n| Cash | $1,200 |\n",
    )
    expect(completed.task.workbookVersion).toBe(1)
    expect(completed.task.workbook?.path).toBe(completed.output.replace(/\.md$/, ".xlsx"))
    const path = join(vault, completed.task.workbook?.path ?? "missing")
    const original = await readFile(path)
    expect((await completeTask(vault, completed.task.id, candidate)).task.workbook).toEqual(
      completed.task.workbook,
    )
    await writeFile(path, "modified workbook")
    await expect(completeTask(vault, completed.task.id, candidate)).rejects.toThrow(
      /workbook.*modified/i,
    )
    await expect(reviseTask(vault, completed.task.id, "Revise this.")).rejects.toThrow(
      /workbook.*modified/i,
    )
    await expect(approveTask(vault, completed.task.id)).rejects.toThrow(/workbook.*modified/i)
    await writeFile(path, original)
    const revised = await reviseTask(vault, completed.task.id, "Revise this.")
    expect(revised.workbookVersion).toBe(1)
    const revisedText = (await readFile(candidate, "utf8")).replace(completed.task.id, revised.id)
    await writeFile(candidate, revisedText)
    const revisedCompletion = await completeTask(vault, revised.id, candidate)
    expect(revisedCompletion.output).toContain(".v2.md")
    expect(await readFile(join(vault, revisedCompletion.task.workbook?.path ?? "missing"))).toEqual(
      original,
    )
    expect(await readFile(path)).toEqual(original)
    const finalDir = "GSB-101/Assignments/Case/Finals"
    await mkdir(join(vault, finalDir), { recursive: true })
    const protectedBook = join(vault, finalDir, "01 Assignment Final.xlsx")
    await writeFile(protectedBook, "student-owned workbook")
    const approved = await approveTask(vault, completed.task.id)
    expect(approved.output).toContain(".v2.md")
    const finalBook = join(vault, approved.output.replace(/\.md$/, ".xlsx"))
    expect(await readFile(finalBook)).toEqual(original)
    expect(await readFile(protectedBook, "utf8")).toBe("student-owned workbook")
    expect((await approveTask(vault, completed.task.id)).output).toBe(approved.output)
    await writeFile(finalBook, "modified final workbook")
    await expect(approveTask(vault, completed.task.id)).rejects.toThrow(/workbook.*modified/i)
  })
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
    expect(revision.workflow?.version).toBe(3)
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
  it("preserves coherent older revision recipes but creates a fresh edited-work handoff", async () => {
    await setup()
    const completed = await completedDraft()
    const editedWork = "GSB-101/Assignments/Case/Drafts/student-edits.md"
    course.existingWork.push(editedWork)
    await writeFile(join(vault, editedWork), "Explicit synthetic edit")
    const revision = await reviseTask(vault, completed.task.id, "Use my edits", editedWork)
    const path = join(vault, "_meta/tasks", revision.id, "task.json")
    const legacy = JSON.parse(await readFile(path, "utf8"))
    delete legacy.revisionEdits
    legacy.workflow.instructions = legacy.workflow.instructions.filter(
      (item: string) => !item.startsWith("This revision includes an explicit"),
    )
    const bytes = JSON.stringify(legacy)
    await writeFile(path, bytes)
    expect((await readTask(vault, revision.id)).revisionEdits).toBeUndefined()
    expect(await readFile(path, "utf8")).toBe(bytes)
    const fresh = await reviseTask(vault, completed.task.id, "Use my edits", editedWork)
    expect(fresh.id).not.toBe(revision.id)
    expect(fresh.revisionEdits?.version).toBe(1)
    expect(await readFile(path, "utf8")).toBe(bytes)
  })
  it("captures fresh student edits instead of reusing an obsolete same-path revision task", async () => {
    await setup()
    const completed = await completedDraft()
    const original = await readFile(join(vault, completed.output), "utf8")
    const editedWork = "GSB-101/Assignments/Case/Drafts/student-edits.md"
    course.existingWork.push(editedWork)
    await writeFile(join(vault, editedWork), "Student's first explicit edit.")
    const feedback = "Incorporate my supplied edits and clarify the comparison."
    const first = await reviseTask(vault, completed.task.id, feedback, editedWork)
    expect(first.revisionEdits).toMatchObject({
      version: 1,
      work: editedWork,
      beforeHash: completed.task.outputHash,
    })
    expect(first.revisionEdits?.diff).toContain("+Student's first explicit edit.")
    expect(first.workflow?.instructions.join(" ")).toContain("Preserve and incorporate")
    expect(await readFile(join(vault, "_meta/tasks", first.id, "TASK.md"), "utf8")).toContain(
      "> +Student's first explicit edit.",
    )
    const saved = await readFile(join(vault, "_meta/tasks", first.id, "task.json"))
    await expect(reviseTask(vault, completed.task.id, feedback, editedWork)).resolves.toMatchObject(
      { id: first.id },
    )
    await writeFile(
      join(vault, editedWork),
      "Student's newer explicit edit, not in the old snapshot.",
    )
    const second = await reviseTask(vault, completed.task.id, feedback, editedWork)
    expect(second.id).not.toBe(first.id)
    expect(second.revisionEdits?.afterHash).not.toBe(first.revisionEdits?.afterHash)
    const recordPath = join(vault, "_meta/tasks", second.id, "task.json")
    const originalRecord = await readFile(recordPath, "utf8")
    const tampered = JSON.parse(originalRecord)
    tampered.revisionEdits.diff = "+Fabricated edit"
    await writeFile(recordPath, JSON.stringify(tampered))
    await expect(readTask(vault, second.id)).rejects.toThrow(/Invalid task/)
    await writeFile(recordPath, originalRecord)
    expect(second.sources.find((source) => source.path === editedWork)?.text).toContain(
      "newer explicit edit",
    )
    expect(first.sources.find((source) => source.path === editedWork)?.text).toBe(
      "Student's first explicit edit.",
    )
    expect(await readFile(join(vault, "_meta/tasks", first.id, "task.json"))).toEqual(saved)
    expect(await readFile(join(vault, completed.output), "utf8")).toBe(original)
    await expect(reviseTask(vault, completed.task.id, feedback, editedWork)).resolves.toMatchObject(
      { id: second.id },
    )
    await writeFile(
      join(vault, editedWork),
      "---\nai_policy: prohibited\n---\nRestricted student edit.",
    )
    await expect(reviseTask(vault, completed.task.id, feedback, editedWork)).rejects.toThrow(
      /restricted/,
    )
  })
})
