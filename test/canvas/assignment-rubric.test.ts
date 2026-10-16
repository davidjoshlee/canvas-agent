import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { assignmentRubricHtml, renderAssignmentRubric } from "../../src/canvas/assignment-rubric.js"
import { syncCourses as syncCanvasCourses } from "../../src/canvas/sync.js"
import { captureSimulation } from "../../src/simulation/captures.js"
import { createSimulationTask, readSimulationTask } from "../../src/simulation/tasks.js"
import { createAssignmentTask } from "../../src/tasks/store.js"
import { inspectWorkspace, selectCourse } from "../../src/vault/workspace.js"
import {
  type CanvasFetch,
  type CanvasSleep,
  createCanvasTestTransport,
} from "../helpers/canvas-client.js"

const roots: string[] = []
const canvasTransport = createCanvasTestTransport()
function useCanvasFetch(fetch?: CanvasFetch, sleep?: CanvasSleep): void {
  canvasTransport.use({ ...(fetch ? { fetch } : {}), ...(sleep ? { sleep } : {}) })
}
const syncCourses = (...args: Parameters<typeof syncCanvasCourses>) =>
  syncCanvasCourses(args[0], args[1], canvasTransport.client(args[0]))
afterEach(async () => {
  canvasTransport.reset()
  delete process.env.CANVAS_RUBRIC_FIXTURE_TOKEN
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe("complete rubric definition context", () => {
  it("preserves labels, detail, weights, range flags and zero-valued ratings without inventing missing points", () => {
    const value = [
      {
        id: "evidence",
        description: "Evidence",
        long_description: "Trace all claims.",
        points: 10,
        criterion_use_range: false,
        ratings: [
          {
            id: "full",
            description: "Complete",
            long_description: "Use source citations.",
            points: 10,
          },
          { id: "none", description: "Missing", points: 0 },
        ],
        rubric_assessment: { private: "PRIVATE_ASSESSMENT" },
      },
      { description: "Presentation" },
    ]
    const text = renderAssignmentRubric(value, (text) => text)
    for (const required of [
      'Criterion ID: "evidence"',
      'Description: "Evidence"',
      'Details: "Trace all claims."',
      "Maximum points: 10",
      "Use point range: false",
      "Rating points: 0",
      'Rating details: "Use source citations."',
      "Maximum points: not provided",
    ])
      expect(text).toContain(required)
    expect(text).not.toContain("PRIVATE_ASSESSMENT")
    expect(renderAssignmentRubric(null, (text) => text)).toBe("")
  })
  it("bounds definitions and recovers only description links rather than assessment text", () => {
    const html = assignmentRubricHtml([
      {
        description: "Label",
        long_description: '<a href="/files/31">Data</a>',
        ratings: [{ description: "Rating", long_description: '<a href="/files/32">Guide</a>' }],
        rubric_assessment: { comments: '<a href="/files/999">Private</a>' },
      },
    ])
    expect(html).toHaveLength(4)
    expect(html.join(" ")).not.toContain("999")
    for (const value of [
      [{ points: "PRIVATE_BAD_POINTS" }],
      Array(201).fill({ description: "x" }),
      [{ ratings: Array(101).fill({}) }],
      [{ long_description: "x".repeat(12001) }],
    ])
      expect(() => renderAssignmentRubric(value, (text) => text)).toThrow(
        /unsupported fields|bounds/,
      )
  })
  it("carries sanitized complete rubrics and rubric-linked readings through fresh sync to ordinary/frozen tasks without fake question gates", async () => {
    const vault = await mkdtemp(join(tmpdir(), "canvas-rubric-"))
    roots.push(vault)
    process.env.CANVAS_RUBRIC_FIXTURE_TOKEN = "synthetic-token"
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
    useCanvasFetch(async (input, init) => {
      expect(init?.method).toBe("GET")
      const path = new URL(String(input)).pathname
      if (path === "/api/v1/users/self") return json({ id: 99, name: "Synthetic student" })
      const course = { id: 1, course_code: "CS101", name: "Synthetic rubric course" }
      if (path === "/api/v1/courses") return json([course])
      if (path === "/api/v1/courses/1") return json(course)
      if (path.endsWith("/assignments"))
        return json([
          {
            id: 50,
            name: "Case",
            unlock_at: "2026-10-05T08:00:00Z",
            description:
              "<h2>Assignment questions</h2><ol><li>Which alternative should the firm choose?</li></ol><p>Assume a < b and b > 0.</p>",
            rubric: [
              {
                id: "evidence",
                description: "Evidence",
                long_description:
                  'Use the <a href="/files/31">dataset</a>. <script>PRIVATE_SCRIPT()</script>',
                points: 10,
                criterion_use_range: true,
                ratings: [
                  {
                    id: "full",
                    description: "Do the citations support the claims?",
                    long_description: "Use two distinct sources.",
                    points: 10,
                  },
                  { id: "none", description: "Missing", points: 0 },
                ],
              },
            ],
          },
        ])
      if (path.endsWith("/submissions/self")) return json({ assignment_id: 50 })
      if (/\/(quizzes|pages|modules|files|discussion_topics)$/.test(path)) return json([])
      if (path === "/api/v1/files/31")
        return json({
          id: 31,
          filename: "dataset.txt",
          url: "https://canvas.example.test/files/31/download",
          unlock_at: "2026-10-05T08:00:00Z",
        })
      if (path === "/files/31/download")
        return new Response("Synthetic dataset evidence supports comparison of the alternatives.")
      throw new Error(`Unexpected synthetic request ${path}`)
    })
    await syncCourses({
      version: 1,
      canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "CANVAS_RUBRIC_FIXTURE_TOKEN" },
      vault: { path: vault },
      courses: { allowlist: ["1"] },
    })
    const course = selectCourse(await inspectWorkspace(vault), "CS101"),
      prompt = course.sources.find((source) => source.canvasId === "50")
    if (!prompt) throw new Error("Synthetic prompt missing")
    const task = await createAssignmentTask(vault, "CS101", prompt.path, "outline")
    expect(task.questions).toEqual(["Which alternative should the firm choose?"])
    expect(task.sources[0]?.text).toContain("Maximum points: 10")
    expect(task.sources[0]?.text).toContain("Rating points: 0")
    expect(task.sources[0]?.text).toContain("Assume a < b and b > 0.")
    expect(task.sources[0]?.text).not.toContain("PRIVATE_SCRIPT")
    expect(task.sources.some((source) => source.text.includes("dataset evidence"))).toBe(true)
    const capture = await captureSimulation(vault, "CS101", "2026-10-09")
    const evaluation = await createSimulationTask(vault, capture.id, {
      kind: "assignment",
      source: prompt.path,
      mode: "outline",
    })
    const frozen = await readSimulationTask(vault, evaluation.id)
    expect(frozen.task.questions).toEqual(task.questions)
    expect(frozen.task.sources[0]?.text).toBe(task.sources[0]?.text)
    expect(frozen.task.sources.some((source) => source.text.includes("dataset evidence"))).toBe(
      true,
    )
    expect(await readFile(join(vault, "CS101/Canvas/Files/31-dataset.txt"), "utf8")).toContain(
      "Synthetic dataset evidence",
    )
  })
})
