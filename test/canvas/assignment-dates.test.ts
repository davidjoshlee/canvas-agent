import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { AssignmentDatesSchema, captureAssignmentDates } from "../../src/canvas/assignment-dates.js"
import { syncCourses as syncCanvasCourses } from "../../src/canvas/sync.js"
import { captureSimulation } from "../../src/simulation/captures.js"
import { createSimulationTask, readSimulationTask } from "../../src/simulation/tasks.js"
import { compareCalendar } from "../../src/student/calendar.js"
import { collectUpcoming } from "../../src/student/upcoming.js"
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
  delete process.env.CANVAS_DATE_TEST_TOKEN
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const due = "2026-10-15T08:00:00Z",
  alternate = "2026-11-25T08:00:00Z"
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "canvas-date-evidence-"))
  roots.push(base)
  const vault = join(base, "vault"),
    config = join(base, "config.json")
  process.env.CANVAS_DATE_TEST_TOKEN = "synthetic-token"
  useCanvasFetch(async (input, init) => {
    expect(init?.method).toBe("GET")
    const url = new URL(String(input)),
      path = url.pathname
    if (path === "/api/v1/users/self") return json({ id: 99, name: "Synthetic student" })
    if (path === "/api/v1/courses")
      return json([{ id: 1, name: "Synthetic course", course_code: "CS101" }])
    if (path === "/api/v1/courses/1")
      return json({ id: 1, name: "Synthetic course", course_code: "CS101" })
    if (path.endsWith("/assignments")) {
      expect(url.searchParams.getAll("include[]")).toContain("all_dates")
      expect(url.searchParams.get("override_assignment_dates")).toBe("true")
      return json([
        {
          id: 50,
          name: "Case",
          description: "Explain the framework.",
          unlock_at: "2026-10-05T08:00:00Z",
          due_at: due,
          has_overrides: true,
          all_dates: [
            { id: 7, title: "PRIVATE_SECTION", student_ids: [999], due_at: alternate },
            { base: true, due_at: due },
          ],
        },
        {
          id: 51,
          name: "Undated",
          description: `Due: ${alternate}\nOld description deadline is not the current API deadline.`,
          due_at: null,
          has_overrides: true,
          all_dates: [{ id: 8, due_at: alternate }],
        },
      ])
    }
    const self = path.match(/\/assignments\/(\d+)\/submissions\/self$/)
    if (self) return json({ assignment_id: self[1] })
    if (/\/(quizzes|pages|files|modules|discussion_topics)$/.test(path)) return json([])
    throw new Error(`Unexpected synthetic endpoint ${path}`)
  })
  const cfg = {
    version: 1 as const,
    canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "CANVAS_DATE_TEST_TOKEN" },
    vault: { path: vault },
    courses: { allowlist: ["1"] },
  }
  await writeFile(config, JSON.stringify(cfg))
  await syncCourses(cfg)
  return { vault, config, context: await inspectWorkspace(vault) }
}
describe("assignment effective and alternate date evidence", () => {
  it("distinguishes missing/null/empty evidence and drops targeting identities", () => {
    expect(captureAssignmentDates({})).toEqual({
      version: 1,
      alternativesCaptured: false,
      alternatives: [],
    })
    expect(captureAssignmentDates({ due_at: null, all_dates: [] })).toMatchObject({
      effectiveDueAt: null,
      alternativesCaptured: true,
    })
    const value = captureAssignmentDates({
      due_at: due,
      all_dates: [{ id: 123, student_ids: [999], title: "PRIVATE", due_at: alternate }],
    })
    expect(value.effectiveDueAt).toBe(due)
    expect(value.alternatives).toEqual([{ dueAt: alternate }])
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE|student_ids|123|999/)
  })
  it("rejects malformed dates, oversized inventories and contradictory capture claims without echo", () => {
    for (const value of [
      { due_at: "PRIVATE_BAD_DATE" },
      { all_dates: "PRIVATE_BAD_DATES" },
      { all_dates: [null] },
      { all_dates: [{ due_at: "2026-02-30T00:00:00Z" }] },
      { all_dates: Array(1001).fill({}) },
    ])
      expect(() => captureAssignmentDates(value)).toThrow(/unsupported; no payload was echoed/)
    expect(
      AssignmentDatesSchema.safeParse({
        version: 1,
        alternativesCaptured: false,
        alternatives: [{ dueAt: due }],
      }).success,
    ).toBe(false)
  })
  it("retains API-effective dates in upcoming scope and never schedules alternatives or stale null-date prose", async () => {
    const { context, vault } = await fixture()
    const result = collectUpcoming(context, {
      course: "CS101",
      now: new Date("2026-10-13T00:00:00Z"),
      days: 60,
    })
    expect(result.items.map((item) => [item.canvasId, item.dueAt])).toEqual([["50", due]])
    expect(result.undated.map((item) => item.canvasId)).toEqual(["51"])
    expect(result.items[0]?.assignmentDates?.alternatives).toHaveLength(2)
    const course = selectCourse(context, "CS101")
    const prompt = course.sources.find((source) => source.canvasId === "50")
    if (!prompt) throw new Error("Missing synthetic prompt")
    expect(prompt.dates).not.toContain("2026-11-25")
    expect(await readFile(join(vault, prompt.path), "utf8")).not.toContain("PRIVATE_SECTION")
    const task = await createAssignmentTask(vault, "CS101", prompt.path, "outline")
    expect(task.sources[0]?.assignmentDates).toEqual(prompt.assignmentDates)
    const snapshot = await captureSimulation(vault, "CS101", "2026-10-09")
    const evaluation = await createSimulationTask(vault, snapshot.id, {
      kind: "assignment",
      source: prompt.path,
      mode: "outline",
    })
    expect(
      (await readSimulationTask(vault, evaluation.id)).task.sources[0]?.assignmentDates,
    ).toEqual(prompt.assignmentDates)
    // A later live prompt change must not enrich the frozen evidence.
    await writeFile(join(vault, prompt.path), "Changed live prompt without date evidence")
    expect(
      (await readSimulationTask(vault, evaluation.id)).task.sources[0]?.assignmentDates
        ?.effectiveDueAt,
    ).toBe(due)
  })
  it("flags alternative-only calendar matches without changing the effective deadline", async () => {
    const { context } = await fixture()
    const rows = compareCalendar(
      context,
      `BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Case\nDTSTART:20261125T080000Z\nEND:VEVENT\nEND:VCALENDAR`,
    )
    expect(rows.find((row) => row.canvasId === "50")).toMatchObject({
      kind: "mismatch",
      canvasDueAt: due,
      calendarDueAt: alternate,
      alternativeDateMatch: true,
    })
    expect(rows.find((row) => row.canvasId === "50")?.detail).toContain("confirm applicability")
    expect(
      selectCourse(context, "CS101").sources.find((source) => source.canvasId === "50")?.dueAt,
    ).toBe(due)
  })
  it("exposes minimized cached evidence through the compiled CLI outside the checkout", async () => {
    const { config } = await fixture()
    const command = (args: string[]) => {
      const result = spawnSync(
        process.execPath,
        [resolve("dist/cli.js"), ...args, "--config", config, "--json"],
        { cwd: tmpdir(), encoding: "utf8" },
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).not.toMatch(/PRIVATE_SECTION|student_ids/)
      return JSON.parse(result.stdout)
    }
    const context = command(["context"])
    expect(
      context.courses[0].sources.find((source: { canvasId: string }) => source.canvasId === "50")
        .assignmentDates.effectiveDueAt,
    ).toBe(due)
    const upcoming = command(["upcoming", "--course", "CS101", "--days", "365"])
    expect(upcoming.undated.some((item: { canvasId: string }) => item.canvasId === "51")).toBe(true)
  })
})
