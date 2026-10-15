import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { setCanvasFetchForTests, syncCourses } from "../src/canvas.js"
import { captureSimulation } from "../src/simulation.js"
import { createSimulationTask, readSimulationTask } from "../src/simulation-tasks.js"
import { createPrepTask } from "../src/tasks.js"
import type { ToolkitConfig } from "../src/types.js"
import { inspectWorkspace, selectCourse } from "../src/workspace.js"

const roots: string[] = []
const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
  })
async function fixture(quizStatus?: number) {
  const vault = await mkdtemp(join(tmpdir(), "canvas-quiz-sync-"))
  roots.push(vault)
  process.env.CANVAS_QUIZ_FIXTURE_TOKEN = "synthetic-token"
  const config: ToolkitConfig = {
    version: 1,
    canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "CANVAS_QUIZ_FIXTURE_TOKEN" },
    vault: { path: vault },
    courses: { allowlist: ["1"] },
  }
  const calls: string[] = []
  setCanvasFetchForTests(async (input, init) => {
    expect(init?.method).toBe("GET")
    const url = new URL(String(input)),
      path = url.pathname
    expect(url.origin).toBe("https://canvas.example.test")
    calls.push(path + url.search)
    if (path === "/api/v1/users/self") return json({ id: 99, name: "Synthetic student" })
    expect(path).not.toMatch(/questions|attempts|answers/)
    if (path.endsWith("/submissions/self")) return json({ assignment_id: 7 })
    const course = { id: 1, course_code: "F26-CS-101", name: "Synthetic quiz course" }
    if (path === "/api/v1/courses") return json([course])
    if (path === "/api/v1/courses/1") return json(course)
    if (path.endsWith("/assignments"))
      return json([
        {
          id: 7,
          name: "Unrelated assignment",
          description: "Unrelated assignment must not replace the quiz.",
          unlock_at: "2026-10-05T08:00:00Z",
        },
      ])
    if (path.endsWith("/pages") || path.endsWith("/discussion_topics")) return json([])
    if (path.endsWith("/modules"))
      return json([
        {
          id: 11,
          name: "Session 1 (October 12)",
          position: 1,
          items: [{ type: "Quiz", content_id: 7, title: "Quiz reading" }],
        },
      ])
    if (path.endsWith("/quizzes")) {
      if (quizStatus) return new Response("PRIVATE_PERMISSION_RESPONSE", { status: quizStatus })
      if (url.searchParams.get("page") === "2")
        return json([
          {
            id: 8,
            title: "Unlinked quiz",
            description: "Unlinked quiz description.",
            published_at: "2026-10-05T08:00:00Z",
          },
        ])
      return json(
        [
          {
            id: 7,
            title: "Quiz reading",
            description:
              '<p>Substantive synthetic quiz framework reading.</p><script>PRIVATE_SCRIPT()</script><a href="/files/31">Reference</a>',
            published_at: "2026-10-05T08:00:00Z",
          },
        ],
        { link: '<https://canvas.example.test/api/v1/courses/1/quizzes?page=2>; rel="next"' },
      )
    }
    if (path.endsWith("/files")) return json([])
    if (path === "/api/v1/files/31")
      return json({
        id: 31,
        filename: "quiz-reference.txt",
        url: "https://canvas.example.test/files/31/download",
        unlock_at: "2026-10-05T08:00:00Z",
      })
    if (path === "/files/31/download")
      return new Response("Synthetic reference text linked only from the quiz description.")
    throw new Error(`Unexpected synthetic request ${path}`)
  })
  return { vault, config, calls }
}
afterEach(async () => {
  setCanvasFetchForTests()
  delete process.env.CANVAS_QUIZ_FIXTURE_TOKEN
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("GET-only quiz description sync", () => {
  it("paginates descriptions, resolves module Quiz identity and linked readings into ordinary/frozen prep", async () => {
    const { vault, config, calls } = await fixture()
    await syncCourses(config)
    expect(calls.some((path) => path.endsWith("/quizzes?page=2"))).toBe(true)
    const course = selectCourse(await inspectWorkspace(vault), "CS101")
    const quiz = course.sources.find(
      (source) => source.type === "quizzes" && source.canvasId === "7",
    )
    if (!quiz) throw new Error("Synthetic quiz missing")
    expect(course.sources.filter((source) => source.type === "quizzes")).toHaveLength(2)
    expect(quiz.text).toContain("quiz framework reading")
    expect(quiz.text).not.toContain("PRIVATE_SCRIPT")
    expect(quiz.relatedPaths?.[0]).toContain("31-quiz-reference.txt.extracted.md")
    expect(course.sources.find((source) => source.canvasId === "11")?.relatedPaths).toEqual([
      quiz.path,
    ])
    const ordinary = await createPrepTask(vault, "CS101", "2026-10-12")
    expect(ordinary.sources.some((source) => source.path === quiz.path)).toBe(true)
    expect(
      ordinary.sources.some((source) => source.text.includes("linked only from the quiz")),
    ).toBe(true)
    expect(
      ordinary.sources.some((source) => /Unrelated assignment|Unlinked quiz/.test(source.text)),
    ).toBe(false)
    const capture = await captureSimulation(vault, "CS101", "2026-10-09")
    const task = await createSimulationTask(vault, capture.id, { kind: "prep", week: "2026-10-12" })
    expect(
      (await readSimulationTask(vault, task.id)).task.sources.map((source) => source.path),
    ).toEqual(
      ordinary.sources
        .filter((source) => !source.path.endsWith("00 Home.md"))
        .map((source) => source.path),
    )
    const original = await readFile(join(vault, "CS101/Canvas/Files/31-quiz-reference.txt"))
    const edited = "Student-edited quiz description must be preserved."
    await writeFile(join(vault, quiz.path), edited)
    await syncCourses(config)
    expect(await readFile(join(vault, quiz.path), "utf8")).toBe(edited)
    expect(await readFile(join(vault, "CS101/Canvas/Files/31-quiz-reference.txt"))).toEqual(
      original,
    )
  })
  it.each([403, 404])(
    "reports an unavailable quiz endpoint (HTTP %i) without claiming full coverage or echoing the response",
    async (status) => {
      const { vault, config } = await fixture(status)
      const result = await syncCourses(config)
      expect(result.notices.some((notice) => /Quizzes list.*unavailable/.test(notice))).toBe(true)
      expect(JSON.stringify(result)).not.toContain("PRIVATE_PERMISSION_RESPONSE")
      expect(
        selectCourse(await inspectWorkspace(vault), "CS101").sources.some(
          (source) => source.type === "quizzes",
        ),
      ).toBe(false)
    },
  )
  it("stops on lost authentication rather than treating quizzes as a permission gap", async () => {
    const { config } = await fixture(401)
    await expect(syncCourses(config)).rejects.toThrow(/HTTP 401/)
  })
})
