import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { expect, it } from "vitest"

it.each(["concluded", "unresolved"])(
  "runs %s pilot onboarding through the compiled CLI against a GET-only synthetic server",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "canvas-pilot-cli-"))
    const pilot = { id: 909, course_code: "HIST101", name: "Synthetic concluded course" }
    const calls: string[] = []
    const server = createServer((request, response) => {
      calls.push(`${request.method} ${request.url}`)
      if (
        request.method !== "GET" ||
        request.headers.authorization !== "Bearer synthetic-pilot-token"
      ) {
        response.writeHead(401).end()
        return
      }
      const url = new URL(request.url ?? "/", "http://localhost")
      let body: unknown
      if (url.pathname === "/api/v1/users/self") body = { id: 99, name: "Synthetic student" }
      else if (url.pathname === "/api/v1/courses")
        body =
          mode === "concluded" && url.searchParams.get("enrollment_state") === "completed"
            ? [pilot]
            : []
      else if (url.pathname === "/api/v1/users/self/courses") body = []
      else if (url.pathname === "/api/v1/courses/909") body = pilot
      else if (url.pathname === "/api/v1/courses/909/assignments" && mode === "unresolved")
        body = [
          { id: 50, due_at: "2026-09-01T00:00:00Z", description: "Synthetic assignment" },
          { id: 51, due_at: "2026-09-15T00:00:00Z" },
        ]
      else if (/\/assignments\/(50|51)\/submissions\/self$/.test(url.pathname))
        body = { assignment_id: Number(url.pathname.split("/").at(-3)), score: 0 }
      else if (
        /^\/api\/v1\/courses\/909\/(assignments|files|pages|modules|quizzes|discussion_topics)$/.test(
          url.pathname,
        )
      )
        body = []
      else {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body))
    })
    try {
      await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
      const address = server.address()
      if (!address || typeof address === "string")
        throw new Error("Synthetic server address unavailable")
      const vault = join(root, "vault"),
        config = join(root, "config.json")
      await writeFile(
        config,
        JSON.stringify({
          version: 1,
          canvas: {
            baseUrl: `http://127.0.0.1:${address.port}`,
            tokenEnv: "CANVAS_SYNTHETIC_PILOT_TOKEN",
          },
          vault: { path: vault },
          courses: { allowlist: [] },
        }),
      )
      const run = async (args: string[]) => {
        const result = await promisify(execFile)(
          process.execPath,
          [resolve("dist/cli.js"), ...args, "--config", config, "--json"],
          {
            env: { ...process.env, CANVAS_SYNTHETIC_PILOT_TOKEN: "synthetic-pilot-token" },
            timeout: 15000,
          },
        )
        expect(result.stdout).not.toContain("synthetic-pilot-token")
        return JSON.parse(result.stdout)
      }
      expect(await run(["courses", "list", "--all"])).toEqual(
        mode === "concluded" ? [{ id: "909", code: "HIST101", name: pilot.name }] : [],
      )
      const selected = await run(["onboard", "909", "--pilot", "--preserve-school"])
      expect(selected).toMatchObject({
        selected: ["909"],
        sync: { courses: 1 },
      })
      expect(
        selected.sync.written
          .filter((path: string) => path.includes("/HIST101/"))
          .every((path: string) => path.includes("/HIST101/Canvas Agent/")),
      ).toBe(true)
      expect(JSON.parse(await readFile(config, "utf8")).courses.allowlist).toEqual(["909"])
      const home = join(vault, "HIST101/00 Home.md")
      await writeFile(home, "Synthetic student edited home.")
      expect(
        await run(["sync", "--course", mode === "concluded" ? "HIST101" : "909"]),
      ).toMatchObject({ courses: 1 })
      expect(await readFile(home, "utf8")).toBe("Synthetic student edited home.")
      expect(calls.every((call) => call.startsWith("GET "))).toBe(true)
      expect(
        calls.some((call) => /\/courses\/\d+/.test(call) && !call.includes("/courses/909")),
      ).toBe(false)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((closed) => server.close(() => closed()))
      await rm(root, { recursive: true, force: true })
    }
  },
  30000,
)
