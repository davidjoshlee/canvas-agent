import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import JSZip from "jszip"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  listCourses,
  setCanvasDnsForTests,
  setCanvasFetchForTests,
  syncCourses,
} from "../src/canvas.js"
import { createPrepTask } from "../src/tasks.js"
import type { ToolkitConfig } from "../src/types.js"
import { inspectWorkspace, selectCourse } from "../src/workspace.js"

const dirs: string[] = []
async function temp() {
  const d = await mkdtemp(join(tmpdir(), "canvas-agent-canvas-"))
  dirs.push(d)
  return d
}
afterEach(async () => {
  setCanvasFetchForTests()
  setCanvasDnsForTests()
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
  it("continues after disabled Pages and forbidden Files lists and recovers module-linked files/pages", async () => {
    process.env.CANVAS_TEST_TOKEN = "synthetic-secret"
    const vault = await temp()
    setCanvasFetchForTests(async (input) => {
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
    setCanvasFetchForTests(
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
    setCanvasFetchForTests(async (input) => {
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
    setCanvasDnsForTests(async (hostname) => {
      dnsHosts.push(hostname)
      return ["93.184.216.34"]
    })
    const vault = await temp()
    const calls: Array<{ url: string; auth: string | null }> = []
    setCanvasFetchForTests(
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
    setCanvasDnsForTests(async (hostname) => {
      dnsCalls++
      return hostname.startsWith("ipv6.") ? ["2606:4700:4700::1111", "fd12::1"] : ["10.20.30.40"]
    })
    setCanvasFetchForTests(async (input) => {
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
    setCanvasFetchForTests(async (input) => {
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
    const docxZip = new JSZip()
    docxZip.file(
      "word/document.xml",
      "<w:document><w:body><w:p><w:r><w:t>Local DOCX reading contents</w:t></w:r></w:p></w:body></w:document>",
    )
    const docxBytes = await docxZip.generateAsync({ type: "uint8array" })
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
