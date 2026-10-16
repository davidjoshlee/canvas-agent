import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CourseContext, SourceRecord, WorkspaceContext } from "../../src/shared/types.js"
import { captureSimulation } from "../../src/simulation/captures.js"
import { createSimulationTask, readSimulationTask } from "../../src/simulation/tasks.js"
import { completeTask } from "../../src/tasks/completion.js"
import { resolveRequirements } from "../../src/tasks/requirements.js"

const workspace = vi.hoisted(() => ({ inspectWorkspace: vi.fn(), selectCourse: vi.fn() }))
vi.mock("../../src/vault/workspace.js", () => workspace)

import { createPrepTask, readTask } from "../../src/tasks/store.js"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const source = (path: string, text: string, type = "guidance"): SourceRecord => ({
  path,
  title: path.split("/").at(-1) ?? path,
  hash: hash(text),
  text,
  type,
  dates: [],
})
let vault = ""
let course: CourseContext
let context: WorkspaceContext

async function setup() {
  vault = await mkdtemp(join(tmpdir(), "canvas-prep-structure-"))
  const lecture = "---\navailable_at: 2026-10-05\n---\nWeek notes: pricing and market structure."
  const guide =
    "---\navailable_at: 2026-10-05\n---\n## Prep brief structure\nOverview, Framework analysis\nDiscussion points"
  await mkdir(join(vault, "GSB-101/Week 03 - Oct 12"), { recursive: true })
  await mkdir(join(vault, "GSB-101/guidance"), { recursive: true })
  await writeFile(join(vault, "GSB-101/Week 03 - Oct 12/lecture.md"), lecture)
  await writeFile(join(vault, "GSB-101/guidance/prep.md"), guide)
  course = {
    code: "GSB-101",
    title: "Strategy",
    root: "GSB-101",
    sources: [source("GSB-101/Week 03 - Oct 12/lecture.md", lecture, "markdown")],
    excluded: [],
    guidance: ["GSB-101/guidance/prep.md"],
    existingWork: [],
  }
  context = { version: 1, vault, courses: [course], pendingTasks: [], notices: [] }
  workspace.inspectWorkspace.mockResolvedValue(context)
  workspace.selectCourse.mockReturnValue(course)
}

afterEach(async () => {
  vi.clearAllMocks()
  if (vault) await rm(vault, { recursive: true, force: true })
})

describe("versioned prep structure recipe", () => {
  it("accepts plain and comma-separated names under prep structure declarations", () => {
    const guide = source(
      "GSB-101/guidance/prep.md",
      "## Prep brief structure\nOverview, Framework analysis\n### Discussion points\nFollow the declared structure exactly.\nFollow the cited structure exactly. `GSB-101/syllabus.md`",
    )
    const reading = source(
      "GSB-101/Week/reading.md",
      "## Preparation questions\n1. What drives pricing?",
    )
    const resolved = resolveRequirements(
      "prep",
      undefined,
      [reading],
      [guide],
      2,
      undefined,
      undefined,
      1,
    )
    expect(resolved.sections).toEqual([
      "Overview",
      "Framework analysis",
      "Discussion points",
      "Sources",
    ])
    expect(resolved.questions).toEqual(["What drives pricing?"])
  })

  it("keeps unflagged parsing unchanged and rejects unsafe or oversized declarations", () => {
    expect(
      resolveRequirements(
        "prep",
        undefined,
        [],
        [source("g.md", "## Assignment structure\nGraded submission")],
        2,
        undefined,
        undefined,
        1,
      ).sections,
    ).toContain("Reading synthesis")
    const plain = source("g.md", "## Brief structure\nOverview, Framework analysis")
    expect(resolveRequirements("prep", undefined, [], [plain]).sections).toEqual([
      "Overview",
      "Reading synthesis",
      "Key concepts",
      "Preparation questions",
      "Discussion points",
      "Sources",
    ])
    expect(() =>
      resolveRequirements(
        "prep",
        undefined,
        [],
        [source("g.md", "## Brief structure\nOverview, <script>")],
        2,
        undefined,
        undefined,
        1,
      ),
    ).toThrow(/unsafe or exceeds bounds/)
    const tooMany = Array.from({ length: 41 }, (_, i) => `Section ${i + 1}`).join("\n")
    expect(() =>
      resolveRequirements(
        "prep",
        undefined,
        [],
        [source("g.md", `## Brief structure\n${tooMany}`)],
        2,
        undefined,
        undefined,
        1,
      ),
    ).toThrow(/exceeds 40 headings/)
  })

  it("persists and rederives the new ordinary task recipe through read and completion validation", async () => {
    await setup()
    const task = await createPrepTask(vault, "GSB-101", "2026-10-12")
    expect(task.prepStructureVersion).toBe(1)
    expect(task.requirements).toEqual([
      "Overview",
      "Framework analysis",
      "Discussion points",
      "Sources",
    ])
    await expect(readTask(vault, task.id)).resolves.toEqual(task)
    const candidate = join(vault, "candidate.md")
    await writeFile(
      candidate,
      `Task: ${task.id}\n${task.requirements.map((heading) => `## ${heading}\n${heading === "Sources" ? "`GSB-101/Week 03 - Oct 12/lecture.md`" : "Synthetic substantive fixture response."}`).join("\n")}`,
    )
    await expect(completeTask(vault, task.id, candidate)).resolves.toMatchObject({
      task: { status: "completed" },
    })
    const taskPath = join(vault, "_meta/tasks", task.id, "task.json")
    const saved = JSON.parse(await readFile(taskPath, "utf8"))
    saved.requirements[0] = "Changed"
    await writeFile(taskPath, JSON.stringify(saved))
    await expect(readTask(vault, task.id)).rejects.toThrow()
  })

  it("binds frozen prep structure to the captured guidance and rederives it without live reads", async () => {
    await setup()
    const capture = await captureSimulation(vault, "GSB-101", "2026-10-12")
    const guidePath = join(vault, "GSB-101/guidance/prep.md")
    const original = await readFile(guidePath, "utf8")
    await writeFile(
      guidePath,
      "---\navailable_at: 2026-10-05\n---\n## Prep brief structure\nChanged later",
    )
    const task = await createSimulationTask(vault, capture.id, {
      kind: "prep",
      week: "2026-10-12",
    })
    expect(task.requirements).toEqual([
      "Overview",
      "Framework analysis",
      "Discussion points",
      "Sources",
    ])
    const frozen = await readSimulationTask(vault, task.id)
    expect(frozen.prepStructureVersion).toBe(1)
    expect(frozen.task.prepStructureVersion).toBe(1)
    expect(frozen.task.requirements).toEqual([
      "Overview",
      "Framework analysis",
      "Discussion points",
      "Sources",
    ])
    await writeFile(guidePath, original)
  })
})
