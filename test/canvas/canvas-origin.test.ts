import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { setCanvasFetchForTests, syncCourses } from "../../src/canvas/sync.js"
import type { ToolkitConfig } from "../../src/shared/types.js"

const roots: string[] = []
afterEach(async () => {
  setCanvasFetchForTests()
  delete process.env.CANVAS_ORIGIN_TEST_TOKEN
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-origin-test-"))
  roots.push(root)
  const vault = join(root, "vault")
  const config: ToolkitConfig = {
    version: 1,
    canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "CANVAS_ORIGIN_TEST_TOKEN" },
    vault: { path: vault },
    courses: { allowlist: ["1"] },
  }
  process.env.CANVAS_ORIGIN_TEST_TOKEN = "synthetic-token"
  setCanvasFetchForTests(async (input) => {
    const path = new URL(String(input)).pathname
    if (path === "/api/v1/users/self") return json({ id: 99, name: "Synthetic student" })
    if (path === "/api/v1/courses")
      return json([{ id: 1, course_code: "CS101", name: "Synthetic course" }])
    if (path === "/api/v1/courses/1")
      return json({ id: 1, course_code: "CS101", name: "Synthetic course" })
    if (path.endsWith("/assignments"))
      return json([{ id: 50, name: "Case", description: "Synthetic prompt" }])
    if (path.endsWith("/submissions/self"))
      return json({
        assignment_id: 50,
        score: 7,
        submission_comments: [{ comment: "PRIVATE_SYNTHETIC_COMMENT" }],
      })
    if (/\/(quizzes|pages|files|modules|discussion_topics)$/.test(path)) return json([])
    throw new Error("Unexpected synthetic endpoint")
  })
  await syncCourses(config)
  return {
    config,
    vault,
    statePath: join(vault, "_meta/canvas-sync-state.json"),
    feedbackPath: join(vault, "_meta/canvas-feedback/1/50/current.json"),
  }
}
describe("Canvas server-bound sync ownership", () => {
  it("exclusively reserves one server during competing first-time syncs", async () => {
    const initial = await fixture()
    const vault = join(initial.vault, "..", "concurrent-vault")
    const first = { ...initial.config, vault: { path: vault } }
    const second = {
      ...first,
      canvas: { ...first.canvas, baseUrl: "https://another-canvas.example.test" },
    }
    let discoveries = 0
    let release: () => void = () => undefined
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    setCanvasFetchForTests(async (input) => {
      const url = new URL(String(input)),
        path = url.pathname
      if (path === "/api/v1/users/self") return json({ id: 99, name: "Synthetic student" })
      if (path === "/api/v1/courses") {
        if (++discoveries === 2) release()
        await barrier
        return json([{ id: 1, course_code: "CS101", name: "Synthetic" }])
      }
      if (path === "/api/v1/courses/1")
        return json({ id: 1, name: "Synthetic", html_url: `${url.origin}/courses/1` })
      return json([])
    })
    const results = await Promise.allSettled([syncCourses(first), syncCourses(second)])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    const winner = results[0]?.status === "fulfilled" ? first : second
    const origin = new URL(winner.canvas.baseUrl).origin
    expect(JSON.parse(await readFile(join(vault, "_meta/canvas-origin.json"), "utf8")).origin).toBe(
      origin,
    )
    expect(
      JSON.parse(await readFile(join(vault, "_meta/canvas-sync-state.json"), "utf8")).origin,
    ).toBe(origin)
    expect(await readFile(join(vault, "CS101/00 Home.md"), "utf8")).toContain(`${origin}/courses/1`)
  })
  it("stops another server before any request or write, even when numeric course and assignment IDs collide", async () => {
    const { config, statePath, feedbackPath } = await fixture()
    const state = await readFile(statePath),
      feedback = await readFile(feedbackPath)
    expect(JSON.parse(state.toString()).origin).toBe("https://canvas.example.test")
    let calls = 0
    setCanvasFetchForTests(async () => {
      calls++
      throw new Error("No request authorized after scope mismatch")
    })
    await expect(
      syncCourses({
        ...config,
        canvas: { ...config.canvas, baseUrl: "https://another-canvas.example.test" },
      }),
    ).rejects.toThrow(/server differs.*separate vault/)
    expect(calls).toBe(0)
    expect(await readFile(statePath)).toEqual(state)
    expect(await readFile(feedbackPath)).toEqual(feedback)
  })
  it("does not silently discard invalid origin bindings into a fresh untrusted state", async () => {
    const { config, statePath, feedbackPath } = await fixture()
    const state = JSON.parse(await readFile(statePath, "utf8")),
      feedback = await readFile(feedbackPath)
    let calls = 0
    setCanvasFetchForTests(async () => {
      calls++
      throw new Error("No request expected")
    })
    for (const origin of [
      "NOT_A_URL",
      "https://canvas.example.test/path",
      "https://private-user:private-pass@canvas.example.test",
      123,
    ]) {
      const bytes = JSON.stringify({ ...state, origin })
      await writeFile(statePath, bytes)
      await expect(syncCourses(config)).rejects.toThrow(/binding is invalid/)
      expect(await readFile(statePath, "utf8")).toBe(bytes)
    }
    expect(calls).toBe(0)
    expect(await readFile(feedbackPath)).toEqual(feedback)
  })
  it("labels the legacy first binding without certifying old feedback, and preserves its cached receipt", async () => {
    const { config, statePath, feedbackPath } = await fixture()
    const legacy = JSON.parse(await readFile(statePath, "utf8"))
    delete legacy.origin
    await writeFile(statePath, JSON.stringify(legacy))
    const feedback = JSON.parse(await readFile(feedbackPath, "utf8"))
    const result = await syncCourses(config)
    expect(result.notices.join(" ")).toContain(
      "historical feedback/account ownership remains unverified",
    )
    expect(JSON.parse(await readFile(statePath, "utf8")).origin).toBe("https://canvas.example.test")
    expect(JSON.parse(await readFile(feedbackPath, "utf8")).dataHash).toBe(feedback.dataHash)
    expect(JSON.parse(await readFile(feedbackPath, "utf8")).observations).toEqual(
      feedback.observations,
    )
    expect((await syncCourses(config)).notices.join(" ")).not.toContain("Legacy sync state")
  })
  it("rejects cross-server reuse through the compiled CLI without echoing private feedback", async () => {
    const { config, vault, statePath, feedbackPath } = await fixture()
    const path = join(vault, "..", "config.json")
    await writeFile(
      path,
      JSON.stringify({ ...config, canvas: { ...config.canvas, baseUrl: "http://127.0.0.1:9" } }),
    )
    const state = await readFile(statePath),
      feedback = await readFile(feedbackPath)
    const result = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), "sync", "--config", path, "--json"],
      { cwd: tmpdir(), encoding: "utf8" },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("server differs")
    expect(result.stdout + result.stderr).not.toContain("PRIVATE_SYNTHETIC_COMMENT")
    expect(await readFile(statePath)).toEqual(state)
    expect(await readFile(feedbackPath)).toEqual(feedback)
  })
})
