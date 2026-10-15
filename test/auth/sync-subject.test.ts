import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { canvasSubjectHash, guardSyncSubject } from "../../src/auth/sync-subject.js"
import { setCanvasFetchForTests, syncCourses } from "../../src/canvas/sync.js"
import type { ToolkitConfig } from "../../src/shared/types.js"

const roots: string[] = []
afterEach(async () => {
  setCanvasFetchForTests()
  delete process.env.CANVAS_SUBJECT_TEST_TOKEN
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const origin = "https://canvas.example.test"
const json = (value: unknown) => new Response(JSON.stringify(value))
async function fixture() {
  const vault = await mkdtemp(join(tmpdir(), "canvas-subject-test-"))
  roots.push(vault)
  const config: ToolkitConfig = {
    version: 1,
    canvas: { baseUrl: origin, tokenEnv: "CANVAS_SUBJECT_TEST_TOKEN" },
    vault: { path: vault },
    courses: { allowlist: ["1"] },
  }
  process.env.CANVAS_SUBJECT_TEST_TOKEN = "synthetic-original-token"
  let subject: unknown = 99,
    feedbackSubject: unknown = 99,
    profileStatus = 200
  const calls: string[] = []
  setCanvasFetchForTests(async (input) => {
    const path = new URL(String(input)).pathname
    calls.push(path)
    if (path === "/api/v1/users/self")
      return profileStatus === 200
        ? json({ id: subject, name: "PRIVATE_STUDENT_NAME", primary_email: "PRIVATE_EMAIL" })
        : new Response("PRIVATE_DENIAL", { status: profileStatus })
    if (path === "/api/v1/courses") return json([{ id: 1, course_code: "CS101" }])
    if (path === "/api/v1/courses/1") return json({ id: 1, course_code: "CS101" })
    if (path.endsWith("/assignments"))
      return json([{ id: 50, name: "Case", description: "Synthetic prompt" }])
    if (path.endsWith("/submissions/self"))
      return json({
        user_id: feedbackSubject,
        assignment_id: 50,
        score: 7,
        submission_comments: [{ comment: "PRIVATE_FEEDBACK" }],
      })
    return json([])
  })
  await syncCourses(config)
  calls.length = 0
  return {
    vault,
    config,
    calls,
    subjectPath: join(vault, "_meta/canvas-subject.json"),
    feedbackPath: join(vault, "_meta/canvas-feedback/1/50/current.json"),
    setSubject: (value: unknown) => {
      subject = value
    },
    setFeedbackSubject: (value: unknown) => {
      feedbackSubject = value
    },
    setProfileStatus: (value: number) => {
      profileStatus = value
    },
  }
}
describe("verified Canvas API subject isolation", () => {
  it("permits token renewal and numeric/string IDs for the same subject without saving profile fields", async () => {
    const f = await fixture()
    const binding = await readFile(f.subjectPath, "utf8")
    expect(JSON.parse(binding).subjectHash).toBe(canvasSubjectHash(origin, 99))
    expect(binding).not.toMatch(/PRIVATE|synthetic-original-token/)
    process.env.CANVAS_SUBJECT_TEST_TOKEN = "synthetic-renewed-token"
    f.setSubject("99")
    await syncCourses(f.config)
    expect(await readFile(f.subjectPath, "utf8")).toBe(binding)
    expect(f.calls[0]).toBe("/api/v1/users/self")
    expect(() => canvasSubjectHash(origin, Number.MAX_SAFE_INTEGER + 1)).toThrow(/unsupported/)
  })
  it("stops a different subject after only the profile request, preserving cache and ownership", async () => {
    const f = await fixture()
    const binding = await readFile(f.subjectPath),
      feedback = await readFile(f.feedbackPath)
    f.setSubject(100)
    await expect(syncCourses(f.config)).rejects.toThrow(/account differs.*separate vault/)
    expect(f.calls).toEqual(["/api/v1/users/self"])
    expect(await readFile(f.subjectPath)).toEqual(binding)
    expect(await readFile(f.feedbackPath)).toEqual(feedback)
  })
  it("does not classify missing profile permission as expiry or save mismatched self-feedback", async () => {
    const f = await fixture()
    const feedback = await readFile(f.feedbackPath)
    f.setProfileStatus(403)
    await expect(syncCourses(f.config)).rejects.toThrow(/HTTP 403/)
    expect(f.calls).toEqual(["/api/v1/users/self"])
    f.setProfileStatus(200)
    f.setFeedbackSubject(100)
    await expect(syncCourses(f.config)).rejects.toThrow(
      /does not match the verified Canvas API subject/,
    )
    expect(await readFile(f.feedbackPath)).toEqual(feedback)
  })
  it("reserves one account atomically and rejects altered or exposed bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "canvas-subject-race-"))
    roots.push(root)
    const first = canvasSubjectHash(origin, 99),
      second = canvasSubjectHash(origin, 100)
    const result = await Promise.allSettled([
      guardSyncSubject(root, origin, first, true),
      guardSyncSubject(root, origin, second, true),
    ])
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1)
    const winner = result[0]?.status === "fulfilled" ? first : second
    const path = join(root, "_meta/canvas-subject.json")
    await expect(guardSyncSubject(root, origin, winner)).resolves.toBe(true)
    await chmod(path, 0o644)
    await expect(guardSyncSubject(root, origin, winner)).rejects.toThrow(/exposed/)
    await chmod(path, 0o600)
    await writeFile(path, "{PRIVATE_INVALID_BINDING")
    await expect(guardSyncSubject(root, origin, winner)).rejects.toThrow(/binding is invalid/)
    expect(await readFile(path, "utf8")).toBe("{PRIVATE_INVALID_BINDING")
  })
})
