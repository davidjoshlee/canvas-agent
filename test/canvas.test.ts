import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { listCourses, setCanvasFetchForTests, syncCourses } from "../src/canvas.js"
import { createPrepTask } from "../src/tasks.js"
import type { ToolkitConfig } from "../src/types.js"

const dirs: string[] = []
async function temp() {
  const d = await mkdtemp(join(tmpdir(), "canvas-agent-canvas-"))
  dirs.push(d)
  return d
}
afterEach(async () => {
  setCanvasFetchForTests()
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

describe("Canvas read-only sync", () => {
  it("explains missing credentials before making a network request", async () => {
    const network = vi.fn()
    setCanvasFetchForTests(network)
    await expect(listCourses(cfg("/unused", []))).rejects.toThrow("CANVAS_TEST_TOKEN is not set")
    expect(network).not.toHaveBeenCalled()
  })
  it("lists all user's courses for discovery and follows same-origin pagination with GET and bearer auth", async () => {
    process.env.CANVAS_TEST_TOKEN = "synthetic-secret"
    const calls: Array<{ url: string; method?: string; auth?: string }> = []
    setCanvasFetchForTests(async (input, init) => {
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
    setCanvasFetchForTests(async (input) => {
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
      if (u.includes("/pages?")) return json([{ id: 23, title: "Overview", url: "overview" }])
      if (u.endsWith("/pages/overview"))
        return json({
          id: 23,
          title: "Overview",
          url: "overview",
          body: "<h1>Actual page body</h1>",
        })
      if (u.includes("/modules?"))
        return json([{ id: 24, name: "Week 1", items: [{ title: "Read" }] }])
      if (u.includes("/files?"))
        return json([
          { id: 25, filename: "notes.bin", url: "https://canvas.example.edu/files/25/download" },
        ])
      if (u.includes("/files/25/download"))
        return new Response(new Uint8Array([0, 1, 2, 255]), { status: 200 })
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
    const binary = files.find((p) => p.endsWith("notes.bin")) ?? ""
    expect([...(await readFile(binary))]).toEqual([0, 1, 2, 255])
    const task = await createPrepTask(vault, "ACCT340", "2026-10-12")
    expect(task.sources.map((source) => source.path)).toContain(
      "ACCT340/Canvas/Assignments/Case-22.md",
    )
    expect(task.sources.map((source) => source.path)).toContain("ACCT340/Resources/Syllabus.md")
    expect(task.sources.find((source) => source.path.includes("Assignments"))?.dates).toContain(
      "2026-10-12",
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
    setCanvasFetchForTests(async () =>
      json([
        { id: 1, course_code: "Same" },
        { id: 2, course_code: "Same" },
      ]),
    )
    await expect(syncCourses(cfg(vault, ["1", "2"]))).rejects.toThrow("collision")
    expect(await readFile(join(vault, "_meta", "canvas-courses.json")).catch(() => "missing")).toBe(
      "missing",
    )
    setCanvasFetchForTests(async () =>
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
    setCanvasFetchForTests(async () => json([{ id: 1, course_code: "_meta", name: "Bad" }]))
    await expect(syncCourses(cfg(vault))).rejects.toThrow("Reserved or unsafe")
    expect(await readFile(join(vault, "_meta", "canvas-courses.json")).catch(() => "missing")).toBe(
      "missing",
    )
    await symlink(outside, join(vault, "ACCT340"))
    setCanvasFetchForTests(async () => json([{ id: 1, course_code: "F26-ACCT-340", name: "Bad" }]))
    await expect(syncCourses(cfg(vault))).rejects.toThrow("Symbolic links")
    expect(await readFile(join(vault, "_meta", "canvas-courses.json")).catch(() => "missing")).toBe(
      "missing",
    )
  })

  it("reuses an existing raw course root only when the canonical root is absent", async () => {
    process.env.CANVAS_TEST_TOKEN = "x"
    const rawVault = await temp()
    await mkdir(join(rawVault, "F26-ACCT-340"))
    setCanvasFetchForTests(async (input) => {
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
    setCanvasFetchForTests(async () => new Response("", { status: 403 }))
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
    setCanvasFetchForTests(async (input) => {
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
    setCanvasFetchForTests(async () => json([{ id: 1, course_code: "ACCT340", name: "New term" }]))
    await expect(syncCourses(cfg(vault))).rejects.toThrow("existing mapping")
    expect(await readFile(join(vault, "ACCT340", "00 Home.md")).catch(() => null)).toBeNull()
  })
})
