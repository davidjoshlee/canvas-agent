import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { assignmentRelatedSources, relatedSources } from "../src/module-context.js"
import { createAssignmentTask } from "../src/tasks.js"
import type { CourseContext, SourceRecord } from "../src/types.js"

const source = (path: string, type: string, extra: Partial<SourceRecord> = {}): SourceRecord => ({
  path,
  type,
  title: path,
  hash: "0".repeat(64),
  text: "Synthetic content",
  dates: [],
  ...extra,
})
function fixture() {
  const prompt = source("CS101/Assignments/prompt.md", "assignment")
  const sources = [
    prompt,
    source("CS101/modules/01-theory.md", "modules", {
      canvasId: "100",
      relatedPaths: ["CS101/readings/theory.md"],
    }),
    source("CS101/modules/02-task.md", "modules", {
      canvasId: "200",
      relatedPaths: [prompt.path, "CS101/readings/task.md"],
    }),
    source("CS101/modules/03-next.md", "modules", {
      canvasId: "300",
      relatedPaths: ["CS101/readings/future.md"],
    }),
    source("CS101/readings/theory.md", "file"),
    source("CS101/readings/task.md", "file"),
    source("CS101/readings/future.md", "file"),
  ]
  const course: CourseContext = {
    code: "CS101",
    title: "Synthetic",
    root: "CS101",
    sources,
    guidance: [],
    existingWork: [],
    excluded: [],
  }
  return { prompt, course }
}
it("selects owning and preceding modules and readings, not following material", () => {
  const { course, prompt } = fixture()
  expect(assignmentRelatedSources(course, prompt).map((item) => item.path)).toEqual([
    prompt.path,
    "CS101/modules/01-theory.md",
    "CS101/modules/02-task.md",
    "CS101/readings/task.md",
    "CS101/readings/theory.md",
  ])
})
it("recognizes explicit owning-module IDs and refuses competing preceding identities", () => {
  const { course, prompt } = fixture()
  prompt.moduleCanvasId = "200"
  const owner = course.sources[2]
  if (!owner) throw new Error("Missing synthetic owner")
  owner.relatedPaths = ["CS101/readings/task.md"]
  expect(assignmentRelatedSources(course, prompt).some((item) => item.canvasId === "200")).toBe(
    true,
  )
  course.sources.push(source("CS101/modules/01-other.md", "modules", { canvasId: "other" }))
  expect(() => assignmentRelatedSources(course, prompt)).toThrow(/ambiguous/)
  expect(
    assignmentRelatedSources(course, prompt, ["CS101/modules/01-theory.md"]).some(
      (item) => item.canvasId === "other",
    ),
  ).toBe(false)
})
it("does not infer module membership or a predecessor without persisted order", () => {
  const { course, prompt } = fixture()
  prompt.path = "CS101/Assignments/unlinked.md"
  expect(assignmentRelatedSources(course, prompt)).toEqual([prompt])
  prompt.moduleCanvasId = "200"
  const owner = course.sources[2]
  if (!owner) throw new Error("Missing synthetic owner")
  owner.path = "CS101/Modules/undated.md"
  const result = assignmentRelatedSources(course, prompt)
  expect(result.some((item) => item.canvasId === "100")).toBe(false)
  expect(result.some((item) => item.canvasId === "200")).toBe(true)
})
it("persists owning/preceding reading snapshots in a real assignment handoff without changing originals", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvas-assignment-modules-"))
  try {
    const { course, prompt } = fixture()
    for (const item of course.sources) {
      await mkdir(join(root, item.path, ".."), { recursive: true })
      await writeFile(
        join(root, item.path),
        `---\ntype: ${item.type}\n${item.canvasId ? `canvas_id: '${item.canvasId}'\n` : ""}${item.relatedPaths ? `related_paths: ${JSON.stringify(item.relatedPaths)}\n` : ""}---\nSynthetic source body for ${item.title}.\n`,
      )
    }
    const original = await readFile(join(root, prompt.path))
    const task = await createAssignmentTask(root, "CS101", prompt.path, "outline")
    expect(task.sources.some((source) => source.path === "CS101/readings/theory.md")).toBe(true)
    expect(task.sources.some((source) => source.path === "CS101/readings/task.md")).toBe(true)
    expect(task.sources.some((source) => source.path === "CS101/readings/future.md")).toBe(false)
    expect(task.assignment?.context).toContain("CS101/modules/01-theory.md")
    expect(await readFile(join(root, prompt.path))).toEqual(original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

describe("related module sources", () => {
  const source = (path: string, relatedPaths: string[] = []): SourceRecord => ({
    path,
    title: path,
    hash: "hash",
    text: path,
    type: "document",
    dates: [],
    relatedPaths,
  })
  it("follows only explicit relationships within the approved course sources", () => {
    const module = source("ACCT340/Canvas/Modules/Week-1.md", [
      "ACCT340/Canvas/Assignments/Case.md",
      "../../OTHER/secret.md",
      "ACCT340/Canvas/Files/raw.pdf",
    ])
    const assignment = source("ACCT340/Canvas/Assignments/Case.md", [
      "ACCT340/Resources/Reading.md",
    ])
    const reading = source("ACCT340/Resources/Reading.md")
    const course = {
      code: "ACCT340",
      title: "Accounting",
      root: "ACCT340",
      sources: [module, assignment, reading],
      excluded: [],
      guidance: [],
      existingWork: [],
    } satisfies CourseContext
    expect(relatedSources(course, [module]).map((record) => record.path)).toEqual([
      "ACCT340/Canvas/Assignments/Case.md",
      "ACCT340/Canvas/Modules/Week-1.md",
      "ACCT340/Resources/Reading.md",
    ])
  })
})
