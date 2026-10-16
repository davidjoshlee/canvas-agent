import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import JSZip from "jszip"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  listCourses as listCanvasCourses,
  syncCourses as syncCanvasCourses,
  verifyAuth as verifyCanvasAuth,
} from "../../src/canvas/sync.js"
import type { ToolkitConfig } from "../../src/shared/types.js"
import { captureSimulation, replaySimulation } from "../../src/simulation/captures.js"
import { createSimulationTask, readSimulationTask } from "../../src/simulation/tasks.js"
import { createAssignmentTask, createPrepTask } from "../../src/tasks/store.js"
import { inspectWorkspace, selectCourse } from "../../src/vault/workspace.js"
import {
  type CanvasAddressResolver,
  type CanvasFetch,
  type CanvasSleep,
  createCanvasTestTransport,
} from "../helpers/canvas-client.js"

const dirs: string[] = []
const canvasTransport = createCanvasTestTransport()
const syncCourses = (...args: Parameters<typeof syncCanvasCourses>) =>
  syncCanvasCourses(args[0], args[1], canvasTransport.client(args[0]))
const listCourses = (config: ToolkitConfig, includeConcluded = false) =>
  listCanvasCourses(config, includeConcluded, canvasTransport.client(config))
const verifyAuth = (config: ToolkitConfig) =>
  verifyCanvasAuth(config, canvasTransport.client(config))
async function temp() {
  const d = await mkdtemp(join(tmpdir(), "canvas-agent-canvas-"))
  dirs.push(d)
  return d
}
afterEach(async () => {
  canvasTransport.reset()
  delete process.env.CANVAS_TEST_TOKEN
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
const cfg = (vault: string, allowlist = ["1"]): ToolkitConfig => ({
  version: 1,
  canvas: { baseUrl: "https://canvas.example.edu", tokenEnv: "CANVAS_TEST_TOKEN" },
  vault: { path: vault },
  courses: { allowlist },
})
const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  })

// Legacy fixtures define no quizzes/own feedback. Dedicated resource tests use
// the actual fetch hook to exercise pagination, permissions and private payloads.
function useCanvasFetch(fn?: CanvasFetch, wait?: CanvasSleep) {
  canvasTransport.use({
    ...(fn
      ? {
          fetch: async (input, init) => {
            const path = new URL(String(input)).pathname
            if (path === "/api/v1/users/self") return json({ id: 99, name: "Synthetic student" })
            if (path.endsWith("/quizzes")) return json([])
            const self = path.match(/\/assignments\/([1-9]\d*)\/submissions\/self$/)
            return self ? json({ assignment_id: self[1] }) : fn(input, init)
          },
        }
      : {}),
    ...(wait ? { sleep: wait } : {}),
  })
}

function useCanvasDns(resolver?: CanvasAddressResolver): void {
  canvasTransport.use({ ...(resolver ? { resolveAddresses: resolver } : {}) })
}
function useCanvasRawFetch(fetch: CanvasFetch): void {
  canvasTransport.use({ fetch })
}

describe("Canvas read-only sync", () => {
  it("extracts extensionless Office downloads by Canvas MIME metadata into original-bound task sources", async () => {
    process.env.CANVAS_TEST_TOKEN = "synthetic-token"
    const vault = await temp()
    const archive = new JSZip()
    archive.file("ppt/slides/slide2.xml", "<a:t>Second synthetic evidence</a:t>")
    archive.file("ppt/slides/slide1.xml", "<a:t>First synthetic evidence</a:t>")
    const bytes = await archive.generateAsync({ type: "uint8array" })
    useCanvasFetch(async (input, init) => {
      expect(init?.method).toBe("GET")
      const path = new URL(String(input)).pathname
      if (path === "/api/v1/courses")
        return json([{ id: 1, name: "Synthetic", course_code: "CS101" }])
      if (path === "/api/v1/courses/1")
        return json({ id: 1, name: "Synthetic", course_code: "CS101" })
      if (path.endsWith("/assignments"))
        return json([
          {
            id: 50,
            name: "Evidence analysis",
            description: "Analyze the supplied slide evidence.",
          },
        ])
      if (path.endsWith("/files"))
        return json([
          {
            id: 45,
            filename: "download",
            display_name: "Synthetic slide deck",
            content_type:
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            url: "https://canvas.example.edu/files/45/download",
          },
        ])
      if (path === "/files/45/download") return new Response(bytes)
      if (path.endsWith("/pages") || path.endsWith("/modules") || path.endsWith("/announcements"))
        return json([])
      throw new Error(`Unexpected synthetic endpoint ${path}`)
    })
    await syncCourses(cfg(vault))
    const original = "CS101/Canvas/Files/45-download"
    const sidecar = `${original}.extracted.md`
    expect(await readFile(join(vault, original))).toEqual(Buffer.from(bytes))
    const course = selectCourse(await inspectWorkspace(vault), "CS101")
    const extracted = course.sources.find((source) => source.path === sidecar)
    expect(extracted).toMatchObject({
      text: expect.stringContaining("First synthetic evidence\nSecond synthetic evidence"),
      originalPath: original,
    })
    const prompt = course.sources.find(
      (source) => source.canvasId === "50" && /assignment/i.test(source.type),
    )
    if (!prompt || !extracted) throw new Error("Expected synthetic prompt and slide sidecar")
    const task = await createAssignmentTask(vault, "CS101", prompt.path, "outline", undefined, [
      sidecar,
    ])
    expect(task.sources.find((source) => source.path === sidecar)).toMatchObject({
      originalPath: original,
      originalHash: extracted.originalHash,
      text: extracted.text,
    })
    expect(await readFile(join(vault, original))).toEqual(Buffer.from(bytes))
  })
  it("preserves group assignment metadata without fetching membership", async () => {
    process.env.CANVAS_TEST_TOKEN = "synthetic-token"
    const vault = await temp()
    const calls: string[] = []
    useCanvasFetch(async (input) => {
      const path = new URL(String(input)).pathname
      calls.push(path)
      if (path === "/api/v1/courses")
        return json([{ id: 1, name: "Synthetic", course_code: "CS101" }])
      if (path.endsWith("/assignments"))
        return json([
          {
            id: 50,
            name: "Group case",
            description: "Explain the framework",
            group_category_id: 7,
            assignment_group_id: 99,
          },
        ])
      if (
        path.endsWith("/pages") ||
        path.endsWith("/files") ||
        path.endsWith("/modules") ||
        path.endsWith("/announcements")
      )
        return json([])
      if (path === "/api/v1/courses/1")
        return json({ id: 1, name: "Synthetic", course_code: "CS101" })
      throw new Error(`Unexpected synthetic endpoint ${path}`)
    })
    await syncCourses(cfg(vault))
    const context = await inspectWorkspace(vault)
    const course = selectCourse(context, "CS101")
    const prompt = course.sources.find((source) => source.path.includes("/Assignments/"))
    if (!prompt) throw new Error("Missing synthetic synced prompt")
    expect(prompt.text).toContain("Group category: 7")
    expect(prompt.text).not.toContain("Group category: 99")
    const task = await createAssignmentTask(vault, "CS101", prompt.path, "outline")
    expect(task.assignment?.groupCategoryId).toBe("7")
    expect(calls.some((path) => /group_categories|groups|users/.test(path))).toBe(false)
  })
  it.each([401, 403, 404, "wrong-id"])(
    "handles an absent allowlisted course's %s response without reading other courses or overwriting files",
    async (status) => {
      process.env.CANVAS_TEST_TOKEN = "synthetic-token"
      const vault = await temp(),
        sentinel = join(vault, "student.md")
      await writeFile(sentinel, "Private synthetic existing student file")
      const calls: string[] = []
      useCanvasFetch(async (input, init) => {
        expect(init?.method).toBe("GET")
        const path = new URL(String(input)).pathname
        calls.push(path)
        if (path === "/api/v1/courses") return json([])
        if (path === "/api/v1/courses/1")
          return status === "wrong-id"
            ? json({ id: 2, name: "PRIVATE_WRONG_COURSE" })
            : new Response("PRIVATE_ERROR", { status })
        throw new Error("Unexpected synthetic course read")
      })
      if (status === 403 || status === 404) {
        const result = await syncCourses(cfg(vault))
        expect(result.courses).toBe(0)
        expect(result.notices.join(" ")).toContain(`HTTP ${status}`)
        expect(JSON.stringify(result)).not.toContain("PRIVATE_ERROR")
      } else
        await expect(syncCourses(cfg(vault))).rejects.toThrow(
          status === 401 ? /HTTP 401/ : /mismatched identity/,
        )
      expect(calls).toEqual(["/api/v1/courses", "/api/v1/courses/1"])
      expect(await readFile(sentinel, "utf8")).toBe("Private synthetic existing student file")
    },
  )
  it.each(["locked", "hidden", "locked_for_user", "hidden_for_user"])(
    "does not download or extract a file marked %s even when it carries a URL",
    async (flag) => {
      process.env.CANVAS_TEST_TOKEN = "synthetic-token"
      const vault = await temp()
      let downloads = 0
      useCanvasFetch(async (input) => {
        const path = new URL(String(input)).pathname
        const course = { id: 1, course_code: "CS101", name: "Synthetic course" }
        if (path === "/api/v1/courses") return json([course])
        if (path === "/api/v1/courses/1") return json(course)
        if (path.endsWith("/files"))
          return json([
            {
              id: 31,
              filename: "blocked.txt",
              url: "https://canvas.example.edu/files/31/download",
              [flag]: true,
            },
          ])
        if (path === "/files/31/download") {
          downloads++
          return new Response("PRIVATE_BLOCKED_CONTENT")
        }
        if (/\/(assignments|pages|modules|discussion_topics)$/.test(path)) return json([])
        throw new Error(`Unexpected synthetic request ${path}`)
      })
      const result = await syncCourses(cfg(vault))
      expect(downloads).toBe(0)
      expect(
        result.notices.some((notice) =>
          /Skipped inaccessible Canvas file blocked.txt/.test(notice),
        ),
      ).toBe(true)
      expect(result.written.some((path) => /blocked\.txt/.test(path))).toBe(false)
      expect(JSON.stringify(await inspectWorkspace(vault))).not.toContain("PRIVATE_BLOCKED_CONTENT")
    },
  )
  it("carries title-derived session dates from term evidence into ordinary and frozen prep without leaking the next session", async () => {
    process.env.CANVAS_TEST_TOKEN = "synthetic-token"
    const vault = await temp()
    const course = {
      id: 1,
      course_code: "CS101",
      name: "Synthetic session course",
      term: { start_at: "2026-09-20T00:00:00Z" },
    }
    const originals = new Map([
      ["31", "Substantive synthetic framework reading for the first session."],
      ["32", "Future synthetic reading for the following session."],
    ])
    useCanvasFetch(async (input) => {
      const url = new URL(String(input)),
        path = url.pathname
      if (path === "/api/v1/courses") return json([course])
      if (path === "/api/v1/courses/1") {
        expect(url.searchParams.getAll("include[]")).toContain("term")
        return json(course)
      }
      if (path.endsWith("/assignments"))
        return json([
          {
            id: 50,
            name: "Case",
            due_at: "2026-10-16T08:00:00Z",
            description: "Explain the supplied framework.",
          },
        ])
      if (path.endsWith("/pages") || path.endsWith("/discussion_topics")) return json([])
      if (path.endsWith("/files"))
        return json(
          [...originals.keys()].map((id) => ({
            id,
            filename: `reading-${id}.txt`,
            created_at: "2026-09-01T08:00:00Z",
            url: `https://canvas.example.edu/files/${id}/download`,
          })),
        )
      const download = path.match(/^\/files\/(31|32)\/download$/)
      if (download) return new Response(originals.get(download[1] ?? ""))
      if (path.endsWith("/modules"))
        return json([
          {
            id: 11,
            position: 1,
            name: "Session 1 (October 12)",
            created_at: "2026-09-01T08:00:00Z",
            items: [{ type: "File", content_id: 31, title: "First reading" }],
          },
          {
            id: 22,
            position: 2,
            name: "Session 2 (October 19)",
            created_at: "2026-09-01T08:00:00Z",
            items: [{ type: "File", content_id: 32, title: "Future reading" }],
          },
          { id: 33, position: 3, name: "Session 3 (February 30)", items: [] },
        ])
      throw new Error(`Unexpected synthetic request ${path}`)
    })
    const synced = await syncCourses(cfg(vault))
    expect(synced.notices.some((notice) => /Module 33.*invalid-date/.test(notice))).toBe(true)
    const context = selectCourse(await inspectWorkspace(vault), "CS101")
    const first = context.sources.find((source) => source.canvasId === "11")
    if (!first) throw new Error("Synthetic module missing")
    expect(first.dates).toContain("2026-10-12")
    const markdown = await readFile(join(vault, first.path), "utf8")
    expect(markdown).toContain('session_at: "2026-10-12"')
    expect(markdown).toContain('session_date_source: "module-title-v1/term-start"')
    const ordinary = await createPrepTask(vault, "CS101", "2026-10-12")
    expect(ordinary.sources.some((source) => source.text.includes("first session"))).toBe(true)
    expect(ordinary.sources.some((source) => source.text.includes("following session"))).toBe(false)
    const capture = await captureSimulation(vault, "CS101", "2026-10-09")
    const replay = await replaySimulation(vault, capture.id)
    expect(replay.sources.find((source) => source.canvasId === "11")?.availabilitySignals).toEqual([
      { field: "school.module_release", value: "2026-10-05" },
    ])
    expect(replay.sources.some((source) => source.text.includes("following session"))).toBe(false)
    const evaluation = await createSimulationTask(vault, capture.id, {
      kind: "prep",
      week: "2026-10-12",
    })
    expect(
      (await readSimulationTask(vault, evaluation.id)).task.sources.some((source) =>
        source.text.includes("first session"),
      ),
    ).toBe(true)
    for (const [id, body] of originals)
      expect(
        await readFile(join(vault, `CS101/Canvas/Files/${id}-reading-${id}.txt`), "utf8"),
      ).toBe(body)
  })
  it("preserves explicit page, prompt and extracted-file release dates into frozen handoffs without guessing from creation dates", async () => {
    process.env.CANVAS_TEST_TOKEN = "synthetic-token"
    const vault = await temp()
    const released = "2026-10-05T08:00:00Z"
    const files = [
      { id: 31, filename: "released.txt", unlock_at: released },
      { id: 32, filename: "future.txt", unlock_at: "2026-10-12T08:00:00Z" },
      { id: 33, filename: "undated.txt", created_at: "2026-10-01T08:00:00Z" },
    ].map((file) => ({ ...file, url: `https://canvas.example.edu/files/${file.id}/download` }))
    useCanvasFetch(async (input, init) => {
      expect(init?.method).toBe("GET")
      const path = new URL(String(input)).pathname
      const course = { id: 1, course_code: "CS101", name: "Synthetic release course" }
      if (path === "/api/v1/courses") return json([course])
      if (path === "/api/v1/courses/1") return json(course)
      if (path.endsWith("/assignments"))
        return json([
          {
            id: 50,
            name: "Case",
            posted_at: released,
            description: "Explain the supplied framework.",
          },
        ])
      if (path.endsWith("/pages")) return json([{ page_id: 7, url: "theory", title: "Theory" }])
      if (path.endsWith("/pages/theory"))
        return json({
          page_id: 7,
          url: "theory",
          title: "Theory",
          published_at: released,
          body: "Substantive synthetic publication-date reading.",
        })
      if (path.endsWith("/files")) return json(files)
      const download = path.match(/^\/files\/(31|32|33)\/download$/)
      if (download) return new Response(`Synthetic extracted reading ${download[1]}.`)
      if (path.endsWith("/modules"))
        return json([
          {
            id: 22,
            name: "Session 1",
            unlock_at: released,
            position: 1,
            items: [
              { type: "Assignment", content_id: 50, title: "Case" },
              { type: "Page", page_url: "theory", title: "Theory" },
              ...files
                .filter((file) => file.id !== 33)
                .map((file) => ({ type: "File", content_id: file.id, title: file.filename })),
            ],
          },
        ])
      if (path.endsWith("/discussion_topics")) return json([])
      throw new Error(`Unexpected synthetic request ${path}`)
    })
    await syncCourses(cfg(vault))
    const course = selectCourse(await inspectWorkspace(vault), "CS101")
    const original = await readFile(join(vault, "CS101/Canvas/Files/31-released.txt"))
    const prompt = course.sources.find((source) => source.canvasId === "50")
    if (!prompt) throw new Error("Synthetic prompt missing")
    const capture = await captureSimulation(vault, "CS101", "2026-10-09")
    const replay = await replaySimulation(vault, capture.id)
    expect(replay.sources.find((source) => source.canvasId === "7")?.availabilitySignals).toEqual([
      { field: "published_at", value: released },
      { field: "dates.published_at", value: released },
    ])
    const extracted = replay.sources.find((source) =>
      source.path.endsWith("31-released.txt.extracted.md"),
    )
    expect(extracted?.availabilitySignals).toEqual([
      { field: "unlock_at", value: released },
      { field: "dates.unlock_at", value: released },
    ])
    expect(
      replay.excluded.some(
        (source) =>
          source.path.endsWith("32-future.txt.extracted.md") && /future/.test(source.reason),
      ),
    ).toBe(true)
    expect(
      replay.excluded.some(
        (source) =>
          source.path.endsWith("33-undated.txt.extracted.md") && /Unknown/.test(source.reason),
      ),
    ).toBe(true)
    const task = await createSimulationTask(vault, capture.id, {
      kind: "assignment",
      source: prompt.path,
      mode: "outline",
    })
    const frozen = await readSimulationTask(vault, task.id)
    expect(
      frozen.task.sources.some((source) => source.text.includes("publication-date reading")),
    ).toBe(true)
    expect(frozen.task.sources.some((source) => source.text.includes("extracted reading 31"))).toBe(
      true,
    )
    expect(
      frozen.task.sources.some((source) => /extracted reading (32|33)/.test(source.text)),
    ).toBe(false)
    expect(await readFile(join(vault, "CS101/Canvas/Files/31-released.txt"))).toEqual(original)
  })
  it("requires a bounded actual user profile rather than treating every HTTP 200 as authorization", async () => {
    process.env.CANVAS_TEST_TOKEN = "synthetic-auth-secret"
    const config = cfg(await temp())
    useCanvasRawFetch(async (_input, init) => {
      expect(init?.method).toBe("GET")
      expect(init?.redirect).toBe("error")
      return json({
        id: "123",
        name: "PRIVATE STUDENT NAME",
        primary_email: "private@example.test",
      })
    })
    const result = await verifyAuth(config)
    expect(result).toEqual({ ok: true })
    expect(JSON.stringify(result)).not.toContain("PRIVATE")
    for (const body of [
      "<html>PRIVATE LOGIN PAGE</html>",
      "PRIVATE_INVALID_JSON",
      "{}",
      "[]",
      '{"id":0,"name":"PRIVATE"}',
      '{"id":"self","name":"PRIVATE"}',
      '{"id":1}',
    ]) {
      useCanvasRawFetch(async () => new Response(body, { status: 200 }))
      await expect(verifyAuth(config)).rejects.toThrow(/authorization was not verified/)
    }
    useCanvasRawFetch(
      async () => new Response(`{"id":1,"name":"Student","bio":"${"x".repeat(256 * 1024)}"}`),
    )
    await expect(verifyAuth(config)).rejects.toThrow(/bounded user profile/)
  })
  it("times out a stalled HTTP 200 profile stream without emitting partial private data", async () => {
    process.env.CANVAS_TEST_TOKEN = "synthetic-auth-secret"
    const config = cfg(await temp())
    const cancelled = vi.fn()
    useCanvasRawFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"id":1,"name":"PRIVATE_PARTIAL'))
            },
            cancel: cancelled,
          }),
        ),
    )
    vi.useFakeTimers()
    try {
      const rejected = expect(verifyAuth(config)).rejects.toThrow(/authorization was not verified/)
      await vi.advanceTimersByTimeAsync(10_001)
      await rejected
      expect(cancelled).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
  it("retains real API module type/order so fresh assignment and frozen handoffs include preceding readings", async () => {
    process.env.CANVAS_TEST_TOKEN = "synthetic-token"
    const vault = await temp()
    useCanvasFetch(async (input) => {
      const url = new URL(String(input)),
        path = url.pathname
      const course = { id: 1, course_code: "CS101", name: "Synthetic course" }
      if (path === "/api/v1/courses") return json([course])
      if (path === "/api/v1/courses/1") return json(course)
      if (path.endsWith("/assignments"))
        return json([
          {
            id: 50,
            name: "Case",
            description: "Explain the supplied framework.",
            unlock_at: "2026-10-05T00:00:00Z",
          },
        ])
      if (path.endsWith("/pages"))
        return json([
          { page_id: 7, url: "theory", title: "Theory" },
          { page_id: 8, url: "future", title: "Future" },
        ])
      if (path.endsWith("/pages/theory"))
        return json({
          page_id: 7,
          url: "theory",
          title: "Theory",
          body: "Substantive synthetic preceding theory reading.",
          unlock_at: "2026-10-05T00:00:00Z",
        })
      if (path.endsWith("/pages/future"))
        return json({
          page_id: 8,
          url: "future",
          title: "Future",
          body: "Following reading must not be selected.",
          unlock_at: "2026-10-05T00:00:00Z",
        })
      if (path.endsWith("/modules"))
        return json([
          {
            id: 21,
            name: "Session 1",
            position: 1,
            unlock_at: "2026-10-05T00:00:00Z",
            items: [{ type: "Page", page_url: "theory", title: "Theory" }],
          },
          {
            id: 22,
            name: "Session 2",
            position: 2,
            unlock_at: "2026-10-05T00:00:00Z",
            items: [{ type: "Assignment", content_id: 50, title: "Case" }],
          },
          {
            id: 23,
            name: "Session 3",
            position: 3,
            unlock_at: "2026-10-05T00:00:00Z",
            items: [{ type: "Page", page_url: "future", title: "Future" }],
          },
        ])
      if (/\/(files|announcements|discussion_topics)$/.test(path)) return json([])
      throw new Error(`Unexpected synthetic request ${path}`)
    })
    await syncCourses(cfg(vault))
    const course = selectCourse(await inspectWorkspace(vault), "CS101")
    const modules = course.sources.filter((source) => source.type === "modules")
    expect(modules.map((source) => source.modulePosition).sort()).toEqual([1, 2, 3])
    const prompt = course.sources.find((source) => source.canvasId === "50")
    if (!prompt) throw new Error("Synthetic prompt missing")
    const task = await createAssignmentTask(vault, "CS101", prompt.path, "outline")
    expect(task.sources.some((source) => source.text.includes("preceding theory reading"))).toBe(
      true,
    )
    expect(task.sources.some((source) => source.text.includes("Following reading"))).toBe(false)
    const snapshot = await captureSimulation(vault, "CS101", "2026-10-09")
    const evaluation = await createSimulationTask(vault, snapshot.id, {
      kind: "assignment",
      source: prompt.path,
      mode: "outline",
    })
    const frozen = await readSimulationTask(vault, evaluation.id)
    expect(
      frozen.task.sources.some((source) => source.text.includes("preceding theory reading")),
    ).toBe(true)
    expect(frozen.task.sources.some((source) => source.modulePosition === 2)).toBe(true)
    expect(frozen.task.sources.some((source) => source.modulePosition === 3)).toBe(false)
  })
  it("keeps section-suffixed term codes in the existing School Agent course root", async () => {
    process.env.CANVAS_TEST_TOKEN = "synthetic-token"
    const vault = await temp()
    await mkdir(join(vault, "ACCT340"))
    const studentFile = join(vault, "ACCT340", "notes.md")
    await writeFile(studentFile, "Student-owned notes")
    useCanvasFetch(async (input) => {
      const u = String(input)
      const course = { id: 1, course_code: "F26-ACCT-340-01", name: "Accounting" }
      if (u.includes("/courses?")) return json([course])
      if (/\/courses\/1(?:\?|$)/.test(u)) return json(course)
      if (/\/(assignments|pages|modules|files)\?/.test(u)) return json([])
      throw new Error("Unexpected synthetic request")
    })
    await syncCourses(cfg(vault))
    const manifest = JSON.parse(await readFile(join(vault, "_meta", "canvas-courses.json"), "utf8"))
    expect(manifest.courses[0].root).toBe("ACCT340")
    expect(await readFile(studentFile, "utf8")).toBe("Student-owned notes")
    expect(await readFile(join(vault, "F26ACCT34001", "00 Home.md")).catch(() => null)).toBeNull()
    const context = await inspectWorkspace(vault)
    expect(selectCourse(context, "1").root).toBe("ACCT340")
    expect(selectCourse(context, "F26-ACCT-340-01").root).toBe("ACCT340")
  })
  it("continues after disabled Pages and forbidden Files lists and recovers module-linked files/pages", async () => {
    process.env.CANVAS_TEST_TOKEN = "synthetic-secret"
    const vault = await temp()
    useCanvasFetch(async (input) => {
      const url = new URL(String(input))
      if (url.pathname === "/api/v1/courses")
        return json([{ id: 1, course_code: "MBA101", name: "Test course" }])
      if (url.pathname === "/api/v1/courses/1") return json({ id: 1 })
      if (url.pathname.endsWith("/pages")) return new Response("disabled", { status: 404 })
      if (url.pathname.endsWith("/files")) return new Response("denied", { status: 403 })
      if (url.pathname.endsWith("/modules"))
        return json([
          {
            id: 3,
            name: "Session 3",
            items: [
              { type: "File", content_id: 45, title: "Reading" },
              { type: "Page", page_url: "lesson", title: "Lesson" },
            ],
          },
        ])
      if (url.pathname.endsWith("/pages/lesson"))
        return json({
          page_id: 7,
          url: "lesson",
          title: "Lesson",
          body: '<p>Module lesson <a href="/files/46">extra reading</a></p>',
        })
      if (/\/files\/(45|46)$/.test(url.pathname))
        return json({
          id: Number(url.pathname.split("/").at(-1)),
          filename: "reading.txt",
          url: `https://canvas.example.edu/download/${url.pathname.split("/").at(-1)}`,
        })
      if (url.pathname.startsWith("/download/")) return new Response("Accessible reading content")
      return json([])
    })
    const result = await syncCourses(cfg(vault))
    expect(result.notices.join(" ")).toContain("Pages list unavailable")
    expect(result.notices.join(" ")).toContain("Files list unavailable")
    const module = await readFile(
      join(vault, "MBA101", "Canvas", "Modules", "Session-3-3.md"),
      "utf8",
    )
    expect(module).toContain("45-reading.txt.extracted.md")
    expect(module).toContain("Lesson-7.md")
    expect(
      await readFile(join(vault, "MBA101", "Canvas", "Pages", "Lesson-7.md"), "utf8"),
    ).toContain("46-reading.txt.extracted.md")
  })
  it.each([401, 500])("does not treat HTTP %s on Pages as a disabled tab", async (status) => {
    process.env.CANVAS_TEST_TOKEN = "synthetic-secret"
    const vault = await temp()
    useCanvasFetch(
      async (input) => {
        const url = String(input)
        if (url.includes("/courses?")) return json([{ id: 1, course_code: "MBA101", name: "Test" }])
        if (url.includes("/courses/1?")) return json({ id: 1 })
        if (url.includes("/pages?")) return new Response("unavailable", { status })
        return json([])
      },
      async () => {},
    )
    await expect(syncCourses(cfg(vault))).rejects.toThrow(`HTTP ${status}`)
  })
  it("stops when linked-file lookup loses authentication", async () => {
    process.env.CANVAS_TEST_TOKEN = "synthetic-secret"
    const vault = await temp()
    useCanvasFetch(async (input) => {
      const url = String(input)
      if (url.includes("/courses?")) return json([{ id: 1, course_code: "MBA101", name: "Test" }])
      if (url.includes("/courses/1?"))
        return json({ id: 1, syllabus_body: '<a href="/files/45">Reading</a>' })
      if (url.endsWith("/files/45")) return new Response("expired", { status: 401 })
      return json([])
    })
    await expect(syncCourses(cfg(vault))).rejects.toThrow("HTTP 401")
  })
  it("discovers linked file references and fetches verifier URLs without forwarding Canvas auth", async () => {
    process.env.CANVAS_TEST_TOKEN = "private-token"
    const dnsHosts: string[] = []
    useCanvasDns(async (hostname) => {
      dnsHosts.push(hostname)
      return ["93.184.216.34"]
    })
    const vault = await temp()
    const calls: Array<{ url: string; auth: string | null }> = []
    useCanvasFetch(
      async (input, init) => {
        const url = String(input)
        calls.push({ url, auth: new Headers(init?.headers).get("authorization") })
        if (url.includes("/courses?"))
          return json([{ id: 1, course_code: "ACCT340", name: "Accounting" }])
        if (url.includes("/courses/1?"))
          return json({
            id: 1,
            course_code: "ACCT340",
            name: "Accounting",
            syllabus_body: '<p><a href="/files/45/download?verifier=secret">Reader</a></p>',
          })
        if (url.includes("/files?")) return json([])
        if (url.endsWith("/files/45"))
          return json({
            id: 45,
            filename: "reader.txt",
            content_type: "text/plain",
            url: "https://cdn.example.net/reader?verifier=secret",
          })
        if (url.startsWith("https://cdn.example.net/")) return new Response("Reader text")
        if (
          ["assignments?", "pages?", "modules?", "discussion_topics?"].some((part) =>
            url.includes(part),
          )
        )
          return json([])
        throw new Error("unexpected synthetic request")
      },
      async () => {},
    )
    const result = await syncCourses(cfg(vault))
    const cdnCall = calls.find((call) => call.url.startsWith("https://cdn.example.net/"))
    expect(
      cdnCall?.auth,
      JSON.stringify({ urls: calls.map((call) => call.url), dnsHosts }),
    ).toBeNull()
    expect(result.notices.join(" ")).not.toContain("verifier")
    expect(result.notices.join(" ")).not.toContain("private-token")
    expect(
      await readFile(
        join(vault, "ACCT340", "Canvas", "Files", "45-reader.txt.extracted.md"),
        "utf8",
      ),
    ).toContain("Reader text")
    expect(await readFile(join(vault, "ACCT340", "Resources", "Syllabus.md"), "utf8")).toContain(
      "related_paths:",
    )
  })
  it("rejects external file hosts resolving to private addresses and non-443 ports before fetch", async () => {
    process.env.CANVAS_TEST_TOKEN = "private-token"
    const vault = await temp()
    let externalFetched = false
    let dnsCalls = 0
    useCanvasDns(async (hostname) => {
      dnsCalls++
      return hostname.startsWith("ipv6.") ? ["2606:4700:4700::1111", "fd12::1"] : ["10.20.30.40"]
    })
    useCanvasFetch(async (input) => {
      const url = String(input)
      if (url.startsWith("https://private.cdn.example.net")) externalFetched = true
      if (url.includes("/courses?"))
        return json([{ id: 1, course_code: "ACCT340", name: "Accounting" }])
      if (url.includes("/courses/1?"))
        return json({ id: 1, course_code: "ACCT340", name: "Accounting" })
      if (url.includes("/files?"))
        return json([
          {
            id: 45,
            filename: "reader.txt",
            url: "https://private.cdn.example.net/file",
          },
          {
            id: 46,
            filename: "reader-v6.txt",
            url: "https://ipv6.cdn.example.net/file",
          },
        ])
      return json([])
    })
    const result = await syncCourses(cfg(vault))
    expect(dnsCalls).toBe(2)
    expect(externalFetched).toBe(false)
    expect(result.notices.join(" ")).toContain("Skipped external or unsafe Canvas file")

    const portVault = await temp()
    dnsCalls = 0
    useCanvasFetch(async (input) => {
      const url = String(input)
      if (url.includes("/courses?"))
        return json([{ id: 1, course_code: "ACCT340", name: "Accounting" }])
      if (url.includes("/courses/1?"))
        return json({ id: 1, course_code: "ACCT340", name: "Accounting" })
      if (url.includes("/files?"))
        return json([
          {
            id: 45,
            filename: "reader.txt",
            url: "https://files.example.net:8443/file",
          },
        ])
      if (url.startsWith("https://files.example.net")) externalFetched = true
      return json([])
    })
    await syncCourses(cfg(portVault))
    expect(dnsCalls).toBe(0)
    expect(externalFetched).toBe(false)
  })
  it("explains missing credentials before making a network request", async () => {
    const network = vi.fn()
    useCanvasFetch(network)
    await expect(listCourses(cfg("/unused", []))).rejects.toThrow("CANVAS_TEST_TOKEN is not set")
    expect(network).not.toHaveBeenCalled()
  })
  it("lists all user's courses for discovery and follows same-origin pagination with GET and bearer auth", async () => {
    process.env.CANVAS_TEST_TOKEN = "synthetic-secret"
    const calls: Array<{ url: string; method?: string; auth?: string }> = []
    useCanvasFetch(async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
        auth: new Headers(init?.headers).get("Authorization") ?? undefined,
      })
      if (String(input).includes("page=2")) return json([{ id: 2, course_code: "B", name: "Bee" }])
      return json(
        [
          { id: 1, course_code: "A", name: "Ay" },
          { id: 2, course_code: "B", name: "Bee" },
        ],
        { link: '<https://canvas.example.edu/api/v1/courses?page=2>; rel="next"' },
      )
    })
    expect(await listCourses(cfg("/tmp/v", []))).toEqual([
      { id: "1", code: "A", name: "Ay" },
      { id: "2", code: "B", name: "Bee" },
    ])
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.method === "GET" && c.auth === "Bearer synthetic-secret")).toBe(
      true,
    )
  })

  it("syncs metadata, normalized HTML, and same-origin files without overwriting edits", async () => {
    process.env.CANVAS_TEST_TOKEN = "synthetic-secret"
    const vault = await temp()
    let course = {
      id: 1,
      course_code: "F26-ACCT-340",
      name: "Intro",
      syllabus_body: "<p>Course syllabus contents</p>",
    }
    let assignmentDescription = "<p>Hello <b>class</b></p><script>secret()</script>"
    const docxZip = new JSZip()
    docxZip.file(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Local DOCX reading contents</w:t></w:r></w:p></w:body></w:document>',
    )
    const docxBytes = await docxZip.generateAsync({ type: "uint8array" })
    useCanvasFetch(async (input) => {
      const u = String(input)
      if (u.includes("/courses?")) return json([course])
      if (/\/courses\/1(?:\?|$)/.test(u)) return json(course)
      if (u.includes("assignments?"))
        return json([
          {
            id: 22,
            name: "Case",
            description: assignmentDescription,
            due_at: "2026-10-12T23:59:00Z",
          },
        ])
      if (u.includes("/pages?")) return json([{ page_id: 23, title: "Overview", url: "overview" }])
      if (u.endsWith("/pages/overview"))
        return json({
          page_id: 23,
          title: "Overview",
          url: "overview",
          body: "<h1>Actual page body</h1>",
        })
      if (u.includes("/modules?"))
        return json([
          {
            id: 24,
            name: "Week 1",
            items: [
              { title: "Case", type: "Assignment", content_id: 22 },
              { title: "Reading", type: "File", content_id: 26 },
              { title: "Overview", type: "Page", page_url: "overview" },
            ],
          },
        ])
      if (u.includes("/files?"))
        return json([
          { id: 25, filename: "notes.bin", url: "https://canvas.example.edu/files/25/download" },
          {
            id: 26,
            filename: "reading.docx",
            content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            url: "https://canvas.example.edu/files/26/download",
          },
        ])
      if (u.includes("/files/25/download"))
        return new Response(new Uint8Array([0, 1, 2, 255]), { status: 200 })
      if (u.includes("/files/26/download")) return new Response(docxBytes)
      if (u.includes("discussion_topics?only_announcements=true"))
        return json([
          {
            id: 27,
            title: "Class update",
            message: "Synthetic announcement",
            posted_at: "2026-10-12T08:00:00Z",
          },
        ])
      if (u.includes("discussion_topics?")) return json([])
      throw new Error("unexpected request")
    })
    const result = await syncCourses(cfg(vault))
    expect(result.courses).toBe(1)
    expect(result.written.length).toBeGreaterThanOrEqual(6)
    const files = result.written
    const assignment = files.find((p) => p.includes("Assignments")) ?? ""
    const text = await readFile(assignment, "utf8")
    expect(text).toContain("Hello class")
    expect(text).not.toContain("secret()")
    expect(text).toContain('due_at: "2026-10-12T23:59:00Z"')
    expect(await readFile(join(vault, "ACCT340", "00 Home.md"), "utf8")).toContain("Intro")
    const page = files.find((p) => p.includes("Overview")) ?? ""
    expect(await readFile(page, "utf8")).toContain("Actual page body")
    expect(page).toContain("Overview-23.md")
    const announcement = files.find((p) => p.includes("Announcements")) ?? ""
    expect(await readFile(announcement, "utf8")).toContain('posted_at: "2026-10-12T08:00:00Z"')
    const binary = files.find((p) => p.endsWith("notes.bin")) ?? ""
    expect([...(await readFile(binary))]).toEqual([0, 1, 2, 255])
    const extractedPath = files.find((p) => p.endsWith("reading.docx.extracted.md")) ?? ""
    expect(await readFile(extractedPath, "utf8")).toContain("Local DOCX reading contents")
    const task = await createPrepTask(vault, "ACCT340", "2026-10-12")
    expect(task.sources.map((source) => source.path)).toContain(
      "ACCT340/Canvas/Assignments/Case-22.md",
    )
    expect(task.sources.find((source) => source.path.includes("Assignments"))?.dates).toContain(
      "2026-10-12",
    )
    const syncedCourse = selectCourse(await inspectWorkspace(vault), "ACCT340")
    expect(
      syncedCourse.sources.find((source) => source.path === announcement.replace(`${vault}/`, ""))
        ?.postedAt,
    ).toBe("2026-10-12T08:00:00Z")
    const module = syncedCourse.sources.find((source) => source.path.includes("Modules"))
    expect(module?.relatedPaths).toEqual(
      expect.arrayContaining([
        "ACCT340/Canvas/Assignments/Case-22.md",
        "ACCT340/Canvas/Files/26-reading.docx.extracted.md",
        "ACCT340/Canvas/Pages/Overview-23.md",
      ]),
    )
    const modulePrep = await createPrepTask(vault, "ACCT340", undefined, { session: "Week 1" })
    expect(modulePrep.sources.map((source) => source.path)).toContain(
      "ACCT340/Canvas/Files/26-reading.docx.extracted.md",
    )
    expect(
      modulePrep.sources.find(
        (source) => source.path === "ACCT340/Canvas/Files/26-reading.docx.extracted.md",
      ),
    ).toMatchObject({
      originalPath: "ACCT340/Canvas/Files/26-reading.docx",
    })
    expect(modulePrep.sources.map((source) => source.path)).toContain(
      "ACCT340/Canvas/Pages/Overview-23.md",
    )
    await writeFile(assignment, "student edit")
    assignmentDescription = "<p>Updated remote description</p>"
    course = { ...course, name: "Intro Updated" }
    const second = await syncCourses(cfg(vault))
    expect(await readFile(assignment, "utf8")).toBe("student edit")
    expect(
      second.notices.some(
        (n) => n.includes("Preserved changed or untracked file") && n.includes("Assignments"),
      ),
    ).toBe(true)
    expect(await readFile(join(vault, "ACCT340", "00 Home.md"), "utf8")).toContain("Intro Updated")
    expect(
      JSON.parse(await readFile(join(vault, "_meta", "canvas-courses.json"), "utf8")).courses[0]
        .name,
    ).toBe("Intro Updated")
    expect(await readFile(assignment, "utf8")).not.toContain("Updated remote description")
  })

  it("rejects cross-origin pagination and course-code collisions before course writes", async () => {
    process.env.CANVAS_TEST_TOKEN = "x"
    const vault = await temp()
    useCanvasFetch(async () =>
      json([
        { id: 1, course_code: "Same" },
        { id: 2, course_code: "Same" },
      ]),
    )
    await expect(syncCourses(cfg(vault, ["1", "2"]))).rejects.toThrow("collision")
    expect(await readFile(join(vault, "_meta", "canvas-courses.json")).catch(() => "missing")).toBe(
      "missing",
    )
    useCanvasFetch(async () =>
      json([], {
        link: '<https://user:pass@canvas.example.edu/api/v1/courses?page=2>; rel="next"',
      }),
    )
    await expect(listCourses(cfg(vault))).rejects.toThrow("same-origin")
  })

  it("rejects reserved and symlink course roots before any write", async () => {
    process.env.CANVAS_TEST_TOKEN = "x"
    const vault = await temp(),
      outside = await temp()
    useCanvasFetch(async () => json([{ id: 1, course_code: "_meta", name: "Bad" }]))
    await expect(syncCourses(cfg(vault))).rejects.toThrow("Reserved or unsafe")
    expect(await readFile(join(vault, "_meta", "canvas-courses.json")).catch(() => "missing")).toBe(
      "missing",
    )
    await symlink(outside, join(vault, "ACCT340"))
    useCanvasFetch(async () => json([{ id: 1, course_code: "F26-ACCT-340", name: "Bad" }]))
    await expect(syncCourses(cfg(vault))).rejects.toThrow("Symbolic links")
    expect(await readFile(join(vault, "_meta", "canvas-courses.json")).catch(() => "missing")).toBe(
      "missing",
    )
  })

  it("reuses an existing raw course root only when the canonical root is absent", async () => {
    process.env.CANVAS_TEST_TOKEN = "x"
    const rawVault = await temp()
    await mkdir(join(rawVault, "F26-ACCT-340"))
    useCanvasFetch(async (input) => {
      const u = String(input)
      if (u.includes("/courses?"))
        return json([{ id: 1, course_code: "F26-ACCT-340", name: "Accounting" }])
      if (u.includes("/courses/1?"))
        return json({ id: 1, course_code: "F26-ACCT-340", name: "Accounting" })
      if (
        u.includes("/assignments?") ||
        u.includes("/pages?") ||
        u.includes("/modules?") ||
        u.includes("/files?")
      )
        return json([])
      throw new Error("unexpected synthetic request")
    })
    await syncCourses(cfg(rawVault))
    expect(await readFile(join(rawVault, "F26-ACCT-340", "00 Home.md"), "utf8")).toContain(
      "Accounting",
    )
    expect(
      JSON.parse(await readFile(join(rawVault, "_meta", "canvas-courses.json"), "utf8")).courses[0]
        .root,
    ).toBe("F26-ACCT-340")

    const canonicalVault = await temp()
    await mkdir(join(canonicalVault, "F26-ACCT-340"))
    await mkdir(join(canonicalVault, "ACCT340"))
    await syncCourses(cfg(canonicalVault))
    expect(await readFile(join(canonicalVault, "ACCT340", "00 Home.md"), "utf8")).toContain(
      "Accounting",
    )
    expect(
      await readFile(join(canonicalVault, "F26-ACCT-340", "00 Home.md")).catch(() =>
        Buffer.from("missing"),
      ),
    ).toEqual(Buffer.from("missing"))
  })

  it("does not log or expose the credential in errors", async () => {
    process.env.CANVAS_TEST_TOKEN = "do-not-leak"
    useCanvasFetch(async () => new Response("", { status: 403 }))
    try {
      await listCourses(cfg("/tmp/v"))
    } catch (error) {
      expect(String(error)).not.toContain("do-not-leak")
      expect(String(error)).toContain("403")
    }
    expect(vi.isMockFunction(fetch)).toBe(false)
  })

  it("keeps ownership evidence after an interrupted sync so a retry can refresh safely", async () => {
    process.env.CANVAS_TEST_TOKEN = "synthetic-secret"
    const vault = await temp()
    let interrupted = true
    let name = "Initial name"
    useCanvasFetch(async (input) => {
      const url = String(input)
      const course = { id: 1, course_code: "ACCT340", name }
      if (url.includes("/courses?")) return json([course])
      if (url.includes("/courses/1?")) return json(course)
      if (url.includes("/pages?") && interrupted) throw new Error("Synthetic connection failure")
      return json([])
    })
    await expect(syncCourses(cfg(vault))).rejects.toThrow("Canvas GET request failed")
    const state = JSON.parse(await readFile(join(vault, "_meta", "canvas-sync-state.json"), "utf8"))
    expect(state.files["ACCT340/00 Home.md"]).toMatch(/^[a-f0-9]{64}$/)
    interrupted = false
    name = "Refreshed name"
    await syncCourses(cfg(vault))
    expect(await readFile(join(vault, "ACCT340", "00 Home.md"), "utf8")).toContain("Refreshed name")
  })

  it("rejects a root owned by another previously mapped course even outside the current allowlist", async () => {
    process.env.CANVAS_TEST_TOKEN = "synthetic-secret"
    const vault = await temp()
    await mkdir(join(vault, "_meta"))
    await writeFile(
      join(vault, "_meta", "canvas-courses.json"),
      JSON.stringify({
        version: 1,
        courses: [{ id: "2", code: "ACCT340", root: "ACCT340", name: "Old term" }],
      }),
    )
    useCanvasFetch(async () => json([{ id: 1, course_code: "ACCT340", name: "New term" }]))
    await expect(syncCourses(cfg(vault))).rejects.toThrow("existing mapping")
    expect(await readFile(join(vault, "ACCT340", "00 Home.md")).catch(() => null)).toBeNull()
  })
})
