import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, it } from "vitest"
import {
  CanvasSyncPartialError,
  isCanvasUnauthorized,
  syncCourses as syncCanvasCourses,
} from "../../src/canvas/sync.js"
import { createConfig } from "../../src/config/index.js"
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
it("uses the compiled CLI against a synthetic server with verified auth but forbidden course discovery", async () => {
  const calls: Array<{ path: string; method: string }> = []
  let discoveryStatus = 403
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname
    calls.push({ path, method: request.method ?? "" })
    response.setHeader("content-type", "application/json")
    if (path === "/api/v1/users/self")
      response.end(JSON.stringify({ id: 99, name: "Synthetic student" }))
    else if (path === "/api/v1/users/self/courses")
      response.end(
        JSON.stringify([
          {
            id: 1,
            course_code: "CS101",
            name: "Synthetic selected course",
            workflow_state: "available",
          },
          {
            id: 2,
            course_code: "CS102",
            name: "Synthetic other course",
            workflow_state: "available",
          },
        ]),
      )
    else if (path === "/api/v1/courses") {
      response.statusCode = discoveryStatus
      response.end("PRIVATE_DISCOVERY_RESPONSE")
    } else if (path === "/api/v1/courses/1")
      response.end(
        JSON.stringify({ id: 1, course_code: "CS101", name: "Synthetic selected course" }),
      )
    else if (path.startsWith("/api/v1/courses/1/")) response.end("[]")
    else {
      response.statusCode = 404
      response.end("PRIVATE_UNEXPECTED_RESPONSE")
    }
  })
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Synthetic address missing")
    const root = await mkdtemp(join(tmpdir(), "canvas-discovery-cli-"))
    roots.push(root)
    const configPath = join(root, "config.json")
    await createConfig(configPath, {
      vault: "vault",
      baseUrl: `http://127.0.0.1:${address.port}`,
      tokenEnv: "CANVAS_SYNTHETIC_MULTI_TOKEN",
      courses: ["1", "2"],
    })
    const before = await readFile(configPath)
    const env = {
      ...Object.fromEntries(
        ["PATH", "HOME", "TMPDIR", "SystemRoot", "COMSPEC", "PATHEXT"]
          .filter((name) => process.env[name] !== undefined)
          .map((name) => [name, process.env[name]]),
      ),
      CANVAS_SYNTHETIC_MULTI_TOKEN: "synthetic-token",
    }
    const run = async (args: string[], selectedConfig = configPath) => {
      try {
        return {
          code: 0,
          ...(await promisify(execFile)(
            process.execPath,
            [resolve("dist/cli.js"), ...args, "--config", selectedConfig, "--json"],
            { env, timeout: 15000 },
          )),
        }
      } catch (error) {
        return error as { code: number; stdout: string; stderr: string }
      }
    }
    const auth = await run(["auth", "verify"])
    expect(auth.code, auth.stderr).toBe(0)
    const beginner = join(root, "beginner.json")
    await createConfig(beginner, {
      vault: "beginner-vault",
      baseUrl: `http://127.0.0.1:${address.port}`,
      tokenEnv: "CANVAS_SYNTHETIC_MULTI_TOKEN",
    })
    const onboarding = await run(["onboard", "--course", "1"], beginner)
    expect(onboarding.code, onboarding.stderr).toBe(0)
    expect(JSON.parse(onboarding.stdout).selected).toEqual(["1"])
    expect(JSON.parse(await readFile(beginner, "utf8")).courses.allowlist).toEqual(["1"])
    expect((await run(["sync"], beginner)).code).toBe(0)
    const numeric = await run(["sync", "--course", "1"])
    expect(numeric.code, numeric.stderr).toBe(0)
    expect(JSON.parse(numeric.stdout).courses).toBe(1)
    expect(JSON.parse(numeric.stdout).notices.join(" ")).toContain(
      "Course discovery is unavailable",
    )
    const alias = await run(["sync", "--course", "CS101"])
    expect(alias.code, alias.stderr).toBe(0)
    expect(alias.stdout + alias.stderr).not.toContain("PRIVATE_")
    expect(await readFile(configPath)).toEqual(before)
    expect(calls.every((call) => call.method === "GET")).toBe(true)
    expect(calls.some((call) => /^\/api\/v1\/courses\/2(?:\/|$)/.test(call.path))).toBe(false)
    const offset = calls.length
    discoveryStatus = 401
    const denied = await run(["sync", "--course", "1"])
    expect(denied.code).not.toBe(0)
    expect(denied.stdout + denied.stderr).not.toContain("PRIVATE_")
    expect(calls.slice(offset).some((call) => call.path.startsWith("/api/v1/courses/1"))).toBe(
      false,
    )
    expect(await readFile(configPath)).toEqual(before)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((closed) => server.close(() => closed()))
  }
}, 30000)
it.each([403, 404, 401, "malformed"] as const)(
  "handles course-list %s without broadening selection or laundering auth/schema failure",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "canvas-discovery-gap-"))
    roots.push(root)
    const config = await createConfig(join(root, "config.json"), {
      vault: "vault",
      baseUrl: "https://canvas.example.test",
      tokenEnv: "CANVAS_SYNTHETIC_MULTI_TOKEN",
      courses: ["1", "2"],
    })
    process.env.CANVAS_SYNTHETIC_MULTI_TOKEN = "synthetic-token"
    const calls: string[] = []
    const json = (value: unknown) => new Response(JSON.stringify(value))
    useCanvasFetch(async (input, init) => {
      expect(init?.method).toBe("GET")
      const path = new URL(String(input)).pathname
      calls.push(path)
      if (path === "/api/v1/users/self") return json({ id: 99, name: "Synthetic student" })
      if (path === "/api/v1/courses")
        return mode === "malformed"
          ? new Response("{ PRIVATE_DISCOVERY_BODY")
          : new Response("PRIVATE_DISCOVERY_BODY", { status: mode })
      if (path === "/api/v1/courses/1")
        return json({ id: 1, course_code: "CS101", name: "Synthetic course" })
      if (path === "/api/v1/courses/2") return new Response("PRIVATE_COURSE_BODY", { status: 403 })
      if (path.startsWith("/api/v1/courses/1/")) return json([])
      throw new Error("Unexpected unselected request")
    })
    if (mode === 401 || mode === "malformed") {
      await expect(syncCourses(config)).rejects.toThrow()
      expect(calls.some((path) => /^\/api\/v1\/courses\/\d/.test(path))).toBe(false)
    } else {
      const report = await syncCourses(config)
      expect(report.courses).toBe(1)
      expect(report.notices.join(" ")).toContain("Course discovery is unavailable")
      expect(report.courseReports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ courseId: "2", status: "unavailable", httpStatus: 403 }),
        ]),
      )
      expect(JSON.stringify(report)).not.toContain("PRIVATE_")
      expect(calls).toContain("/api/v1/courses/1")
      expect(calls).toContain("/api/v1/courses/2")
      expect(calls.some((path) => /^\/api\/v1\/courses\/3/.test(path))).toBe(false)
    }
  },
)
afterEach(async () => {
  canvasTransport.reset()
  delete process.env.CANVAS_SYNTHETIC_MULTI_TOKEN
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
it.each([
  "http-500",
  "invalid-rubric",
  "missing-discovery",
  "http-401",
  "invalid-resource-json",
  "wrong-metadata",
])(
  "isolates %s without reading unselected courses or echoing source/error bodies",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "canvas-multi-sync-"))
    roots.push(root)
    const config = await createConfig(join(root, "config.json"), {
      vault: "vault",
      baseUrl: "https://canvas.example.test",
      tokenEnv: "CANVAS_SYNTHETIC_MULTI_TOKEN",
      courses: ["1", "2"],
    })
    process.env.CANVAS_SYNTHETIC_MULTI_TOKEN = "synthetic-token"
    const courses = [1, 2, 3].map((id) => ({
      id,
      course_code: `CS10${id}`,
      name: `Synthetic course ${id}`,
    }))
    const calls: string[] = []
    const json = (value: unknown) => new Response(JSON.stringify(value))
    useCanvasFetch(
      async (input, init) => {
        expect(init?.method).toBe("GET")
        const path = new URL(String(input)).pathname
        calls.push(path)
        if (path === "/api/v1/users/self") return json({ id: 99, name: "Synthetic student" })
        if (path === "/api/v1/courses")
          return json(
            mode === "missing-discovery"
              ? [courses[1], courses[2]]
              : [courses[0], courses[1], courses[1], courses[2]],
          )
        const metadata = path.match(/^\/api\/v1\/courses\/(1|2)$/)
        if (metadata) {
          if (metadata[1] === "1" && mode === "invalid-resource-json")
            return new Response("{ PRIVATE_RESOURCE_BODY")
          if (metadata[1] === "1" && mode === "wrong-metadata")
            return json({ id: 999, name: "PRIVATE_WRONG_COURSE" })
          if (metadata[1] === "1" && mode !== "invalid-rubric")
            return new Response("PRIVATE_ERROR_BODY", { status: mode === "http-401" ? 401 : 500 })
          return json(courses[Number(metadata[1]) - 1])
        }
        if (path === "/api/v1/courses/1/assignments" && mode === "invalid-rubric")
          return json([{ id: 50, name: "Case", rubric: [{ points: "PRIVATE_BAD_RUBRIC" }] }])
        if (
          /^\/api\/v1\/courses\/(1|2)\/(assignments|files|pages|modules|quizzes|discussion_topics)$/.test(
            path,
          )
        )
          return json([])
        throw new Error(`Unexpected synthetic request ${path}`)
      },
      async () => undefined,
    )
    if (mode === "http-401") {
      const error = await syncCourses(config).catch((error: unknown) => error)
      expect(isCanvasUnauthorized(error)).toBe(true)
      expect(calls).not.toContain("/api/v1/courses/2")
    } else {
      const report = await syncCourses(config).catch((error: unknown) => {
        if (!(error instanceof CanvasSyncPartialError)) throw error
        return error.report
      })
      expect(report).toMatchObject({ courses: 1, failedCourses: 1 })
      expect(report.courseReports?.map((course) => [course.courseId, course.status])).toEqual([
        ["1", "failed"],
        ["2", "synced"],
      ])
      expect(await readFile(join(config.vault.path, "CS102/00 Home.md"), "utf8")).toContain(
        "Synthetic course 2",
      )
      expect(JSON.stringify(report)).not.toMatch(/PRIVATE_/)
      if (mode === "invalid-resource-json") {
        await expect(syncCourses({ ...config, courses: { allowlist: ["1"] } })).rejects.toThrow(
          /invalid resource JSON; no response body/,
        )
      }
      const ownership = await readFile(
        join(config.vault.path, "_meta/canvas-sync-state.json"),
        "utf8",
      )
      expect(ownership).toContain("CS102/00 Home.md")
      await expect(stat(join(config.vault.path, "_meta/due-soon"))).rejects.toThrow()
    }
    expect(calls).not.toContain("/api/v1/courses/3")
  },
)

it("returns partial-failure JSON/nonzero through the compiled CLI and leaves an opted-in Current mirror unchanged", async () => {
  let failing = false,
    text = "INITIAL_SYNTHETIC_PROMPT"
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.headers.authorization !== "Bearer synthetic-token") {
      response.writeHead(401).end()
      return
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname
    if (path === "/api/v1/users/self") {
      response.end(JSON.stringify({ id: 99, name: "Synthetic student" }))
      return
    }
    const courses = [1, 2].map((id) => ({
      id,
      course_code: `CS10${id}`,
      name: `Synthetic course ${id}`,
    }))
    let data: unknown
    if (path === "/api/v1/courses") data = courses
    else if (path === "/api/v1/courses/1" && failing) {
      response.writeHead(500).end("PRIVATE_ERROR_BODY")
      return
    } else if (/^\/api\/v1\/courses\/(1|2)$/.test(path))
      data = courses[Number(path.split("/").at(-1)) - 1]
    else if (path === "/api/v1/courses/2/assignments")
      data = [{ id: 50, name: "Case", description: text }]
    else if (path.endsWith("/assignments/50/submissions/self")) data = { assignment_id: 50 }
    else if (
      /^\/api\/v1\/courses\/(1|2)\/(assignments|files|pages|modules|quizzes|discussion_topics)$/.test(
        path,
      )
    )
      data = []
    else {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(data))
  })
  try {
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("Synthetic server address unavailable")
    const root = await mkdtemp(join(tmpdir(), "canvas-multi-cli-"))
    roots.push(root)
    const configPath = join(root, "config.json"),
      phone = join(root, "phone")
    const config = await createConfig(configPath, {
      vault: "vault",
      baseUrl: `http://127.0.0.1:${address.port}`,
      tokenEnv: "CANVAS_SYNTHETIC_MULTI_TOKEN",
      courses: ["1", "2"],
    })
    const run = async (args: string[]) => {
      try {
        const value = await promisify(execFile)(
          process.execPath,
          [resolve("dist/cli.js"), ...args, "--config", configPath, "--json"],
          {
            env: { ...process.env, CANVAS_SYNTHETIC_MULTI_TOKEN: "synthetic-token" },
            timeout: 15000,
          },
        )
        return { code: 0, ...value }
      } catch (error) {
        return error as { code: number; stdout: string; stderr: string }
      }
    }
    expect((await run(["sync"])).code).toBe(0)
    await expect(stat(join(config.vault.path, "_meta/due-soon"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await mkdir(join(config.vault.path, "_meta/due-soon"), { recursive: true, mode: 0o700 })
    await writeFile(
      join(config.vault.path, "_meta/due-soon/ALERT.md"),
      "Retained legacy reminder bytes.\n",
      { mode: 0o600 },
    )
    expect(
      (await run(["vault", "reading-copy", "--destination", phone, "--current", "--apply"])).code,
    ).toBe(0)
    const copy = join(phone, "Current/CS102/Canvas/Assignments/Case-50.md.txt")
    const originalCopy = await readFile(copy),
      originalAlert = await readFile(join(config.vault.path, "_meta/due-soon/ALERT.md"))
    failing = true
    text = "NEW_SYNTHETIC_PROMPT"
    const partial = await run(["sync"])
    expect(partial.code).not.toBe(0)
    expect(JSON.parse(partial.stdout)).toMatchObject({
      status: "partial-failure",
      courses: 1,
      failedCourses: 1,
    })
    expect(partial.stdout + partial.stderr).not.toContain("PRIVATE_ERROR_BODY")
    expect(await readFile(copy)).toEqual(originalCopy)
    expect(await readFile(join(config.vault.path, "_meta/due-soon/ALERT.md"))).toEqual(
      originalAlert,
    )
    expect(
      await readFile(join(config.vault.path, "CS102/Canvas/Assignments/Case-50.md"), "utf8"),
    ).toContain("NEW_SYNTHETIC_PROMPT")
  } finally {
    server.closeAllConnections()
    await new Promise<void>((closed) => server.close(() => closed()))
  }
}, 30000)
