import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { setCanvasFetchForTests, syncCourses } from "../../src/canvas/sync.js"
import { createConfig, loadConfig } from "../../src/config/index.js"
import { selectOnboardingCourses } from "../../src/config/onboarding.js"
import { inspectWorkspace } from "../../src/vault/workspace.js"

const roots: string[] = []
afterEach(async () => {
  setCanvasFetchForTests()
  delete process.env.CANVAS_PILOT_FIXTURE_TOKEN
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
it.each([
  "zero-score",
  "rubric-only",
  "short-history",
  "no-grade",
  "assignments-denied",
  "feedback-denied",
  "wrong-submission",
  "auth-failed",
  "active",
])(
  "checks unresolved pilot eligibility with %s without retaining probe bodies or widening scope",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "canvas-pilot-eligibility-"))
    roots.push(root)
    const configPath = join(root, "config.json")
    const config = await createConfig(configPath, {
      vault: "vault",
      baseUrl: "https://canvas.example.test",
      tokenEnv: "CANVAS_PILOT_FIXTURE_TOKEN",
    })
    process.env.CANVAS_PILOT_FIXTURE_TOKEN = "synthetic-token"
    const originalConfig = await readFile(configPath)
    const calls: string[] = []
    const json = (value: unknown) => new Response(JSON.stringify(value))
    setCanvasFetchForTests(async (input, init) => {
      expect(init?.method).toBe("GET")
      const url = new URL(String(input)),
        path = url.pathname
      calls.push(path)
      if (path === "/api/v1/users/self") return json({ id: 99, name: "Synthetic student" })
      if (path === "/api/v1/courses") return json([])
      if (path === "/api/v1/users/self/courses")
        return json(mode === "active" ? [{ id: 909, course_code: "CS101" }] : [])
      if (path === "/api/v1/courses/909") return new Response("PRIVATE_PROFILE", { status: 403 })
      if (path === "/api/v1/courses/909/assignments")
        return mode === "assignments-denied"
          ? new Response("PRIVATE_ASSIGNMENTS", { status: 403 })
          : json([
              { id: 50, due_at: "2026-09-01T00:00:00Z", description: "Synthetic requirements" },
              {
                id: 51,
                due_at: mode === "short-history" ? "2026-09-14T00:00:00Z" : "2026-09-15T00:00:00Z",
              },
            ])
      const submission = path.match(/\/assignments\/(50|51)\/submissions\/self$/)
      if (submission) {
        expect(url.searchParams.getAll("include[]")).toContain("rubric_assessment")
        if (mode === "auth-failed" || mode === "feedback-denied")
          return new Response("PRIVATE_RESPONSE", { status: mode === "auth-failed" ? 401 : 403 })
        return json({
          assignment_id: mode === "wrong-submission" ? 999 : Number(submission[1]),
          score: mode === "zero-score" ? 0 : null,
          grade: "no-grade-is-not-evidence",
          rubric_assessment: mode === "rubric-only" ? { evidence: { points: 0 } } : null,
          body: "PRIVATE_SUBMITTED_WORK",
        })
      }
      if (/\/909\/(files|pages|modules|quizzes|discussion_topics)$/.test(path)) return json([])
      throw new Error(`Unexpected synthetic request ${path}`)
    })
    const operation = selectOnboardingCourses(configPath, config, { ids: ["909"], pilot: true })
    if (mode === "zero-score" || mode === "rubric-only") {
      const result = await operation
      expect(result.pilotEligibility).toEqual({
        basis: "assignment-date-span-and-own-feedback",
        dateSpanDays: 14,
        gradedAssignmentId: "50",
      })
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|score|rubric_assessment/)
      expect((await loadConfig(configPath)).courses.allowlist).toEqual(["909"])
      const synced = await syncCourses(
        { ...config, courses: { allowlist: ["909"] } },
        { unresolvedPilot: result.courses[0] },
      )
      expect(synced.courses).toBe(1)
      expect(synced.notices.join(" ")).toContain("metadata/syllabus is unavailable")
      expect(JSON.stringify(await inspectWorkspace(config.vault.path))).not.toContain(
        "PRIVATE_SUBMITTED_WORK",
      )
      await expect(syncCourses(config, { unresolvedPilot: result.courses[0] })).rejects.toThrow(
        /exactly one/,
      )
    } else {
      await expect(operation).rejects.toThrow()
      expect(await readFile(configPath)).toEqual(originalConfig)
      if (mode === "short-history" || mode === "active")
        expect(calls.some((path) => path.includes("/submissions/"))).toBe(false)
    }
    expect(
      calls.some((path) => /\/courses\/\d+/.test(path) && !path.includes("/courses/909")),
    ).toBe(false)
  },
)
