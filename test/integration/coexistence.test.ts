import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { syncCourses as syncCanvasCourses } from "../../src/canvas/sync.js"
import type { ToolkitConfig } from "../../src/shared/types.js"
import { completeTask } from "../../src/tasks/completion.js"
import { approveTask, reviseTask } from "../../src/tasks/lifecycle.js"
import { createAssignmentTask, createPrepTask, readTask } from "../../src/tasks/store.js"
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
  delete process.env.CANVAS_COEXIST_TEST_TOKEN
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const vault = await mkdtemp(join(tmpdir(), "canvas-coexistence-"))
  roots.push(vault)
  const config: ToolkitConfig = {
    version: 1,
    canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "CANVAS_COEXIST_TEST_TOKEN" },
    vault: { path: vault },
    courses: { allowlist: ["1"] },
  }
  process.env.CANVAS_COEXIST_TEST_TOKEN = "synthetic-token"
  let description = "Synthetic framework evidence"
  let dueAt = "2026-10-15T12:00:00Z"
  const json = (value: unknown) => new Response(JSON.stringify(value))
  useCanvasFetch(async (input) => {
    const path = new URL(String(input)).pathname
    if (path === "/api/v1/users/self") return json({ id: 99, name: "Synthetic student" })
    if (path === "/api/v1/courses")
      return json([{ id: 1, name: "Synthetic", course_code: "CS101" }])
    if (path === "/api/v1/courses/1")
      return json({ id: 1, name: "Synthetic", course_code: "CS101" })
    if (path.endsWith("/assignments"))
      return json([{ id: 50, name: "Case", description, due_at: dueAt }])
    if (path.endsWith("/submissions/self")) return json({ assignment_id: 50, user_id: 99 })
    return json([])
  })
  return {
    vault,
    config,
    setDescription: (value: string) => {
      description = value
    },
    setDueAt: (value: string) => {
      dueAt = value
    },
  }
}
describe("separate-product writable course namespace", () => {
  it("reports public School's missing-marker block after Canvas-first preserved sync without inventing a marker", async () => {
    const f = await fixture()
    const first = await syncCourses(f.config, { preserveSchool: true })
    expect(first.notices.join("\n")).toContain("blocked-by-marker (missing)")
    expect(first.notices.join("\n")).toContain("Public School 0.1.1 refuses writes")
    await expect(readFile(join(f.vault, "_meta/layout.json"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect((await syncCourses(f.config)).notices.join("\n")).toContain(
      "blocked-by-marker (missing)",
    )
    const marker = '{"layout_version":2,"course_root_version":2,"student_setting":"keep"}\n'
    await writeFile(join(f.vault, "_meta/layout.json"), marker)
    const next = await syncCourses(f.config)
    expect(next.notices.join("\n")).toContain("readiness remains unverified (current)")
    expect(await readFile(join(f.vault, "_meta/layout.json"), "utf8")).toBe(marker)
  })
  it("refuses fresh context without safe ownership evidence instead of guessing retired paths", async () => {
    const f = await fixture()
    await syncCourses(f.config, { preserveSchool: true })
    const state = join(f.vault, "_meta/canvas-sync-state.json")
    const bytes = await readFile(state)
    await rm(state)
    await expect(inspectWorkspace(f.vault)).rejects.toThrow(/source ownership is missing or unsafe/)
    await writeFile(state, "{invalid")
    await expect(inspectWorkspace(f.vault)).rejects.toThrow(/source ownership is missing or unsafe/)
    await writeFile(state, Buffer.alloc(10 * 1024 * 1024 + 1, " "))
    await expect(inspectWorkspace(f.vault)).rejects.toThrow(/source ownership is missing or unsafe/)
    await rm(state)
    const target = join(f.vault, "synthetic-ownership.json")
    await writeFile(target, bytes)
    await symlink(target, state)
    await expect(inspectWorkspace(f.vault)).rejects.toThrow(/source ownership is missing or unsafe/)
    await rm(state)
    await writeFile(state, bytes)
    await expect(inspectWorkspace(f.vault)).resolves.toHaveProperty("courses")
  })
  it("isolates fresh drafts, revisions and Finals even when the prompt is an existing School source", async () => {
    const f = await fixture()
    await mkdir(join(f.vault, "CS101/Assignments"), { recursive: true })
    const source = "CS101/Assignments/school-prompt.md",
      original = "Explain this supplied synthetic framework."
    await writeFile(join(f.vault, source), original)
    await syncCourses(f.config, { preserveSchool: true })
    const task = await createAssignmentTask(f.vault, "CS101", source, "draft")
    expect(task.productNamespaceVersion).toBe(1)
    expect(task.destination).toBe("CS101/Canvas Agent/Generated/Assignments/Drafts")
    await expect(readTask(f.vault, task.id)).resolves.toEqual(task)
    const file = join(f.vault, "candidate.md")
    await writeFile(
      file,
      [
        `Task: ${task.id}`,
        ...task.requirements.map(
          (heading) =>
            `## ${heading}\n\nSynthetic structural test with exact supplied source evidence, not an academic quality verdict. \`${source}\``,
        ),
      ].join("\n\n"),
    )
    const completed = await completeTask(f.vault, task.id, file)
    const approved = await approveTask(f.vault, task.id)
    expect(completed.output).toContain("CS101/Canvas Agent/Generated/Assignments/Drafts/")
    expect(approved.output).toContain("CS101/Canvas Agent/Generated/Assignments/Finals/")
    const revision = await reviseTask(f.vault, task.id, "Clarify the synthetic argument")
    expect(revision.destination).toBe(task.destination)
    expect(revision.productNamespaceVersion).toBe(1)
    await expect(readTask(f.vault, revision.id)).resolves.toEqual(revision)
    expect(await readFile(join(f.vault, source), "utf8")).toBe(original)
    const path = join(f.vault, "_meta/tasks", revision.id, "task.json")
    const altered = JSON.parse(await readFile(path, "utf8"))
    altered.destination = "CS101/Assignments/Drafts"
    await writeFile(path, JSON.stringify(altered))
    await expect(readTask(f.vault, revision.id)).rejects.toThrow()
  })
  it("prepares School week material into the product namespace and refuses unsafe mapping fallback", async () => {
    const f = await fixture()
    const path = "CS101/Week 01 - Oct 5/reading.md"
    await mkdir(join(f.vault, "CS101/Week 01 - Oct 5"), { recursive: true })
    const original = "The synthetic framework explains why entry costs constrain strategic choices."
    await writeFile(join(f.vault, path), original)
    await syncCourses(f.config, { preserveSchool: true })
    const task = await createPrepTask(f.vault, "CS101", "2026-10-05")
    expect(task.productNamespaceVersion).toBe(1)
    expect(task.destination).toBe("CS101/Canvas Agent/Generated/Week 01 - Oct 5/Prep")
    await expect(readTask(f.vault, task.id)).resolves.toEqual(task)
    const candidateFile = join(f.vault, "prep-candidate.md")
    await writeFile(
      candidateFile,
      [
        `Task: ${task.id}`,
        ...task.requirements.map((heading) => `## ${heading}\n\n${original} \`${path}\``),
      ].join("\n\n"),
    )
    const completed = await completeTask(f.vault, task.id, candidateFile)
    expect(completed.output).toContain(`${task.destination}/`)
    const completedBytes = await readFile(join(f.vault, completed.output))
    expect((await completeTask(f.vault, task.id, candidateFile)).output).toBe(completed.output)
    expect(await readFile(join(f.vault, completed.output))).toEqual(completedBytes)
    expect((await createPrepTask(f.vault, "CS101", "2026-10-05")).destination).toBe(
      task.destination,
    )
    expect(await readFile(join(f.vault, path), "utf8")).toBe(original)
    await writeFile(join(f.vault, "_meta/canvas-courses.json"), "{INVALID_MAPPING")
    await expect(createPrepTask(f.vault, "CS101", "2026-10-05")).rejects.toThrow(
      /mappings are unsafe/,
    )
    await expect(
      createAssignmentTask(
        f.vault,
        "CS101",
        "CS101/Canvas Agent/Canvas/Assignments/Case-50.md",
        "draft",
      ),
    ).rejects.toThrow(/mappings are unsafe/)
  })
  it("preserves School originals/navigation and retains the namespace on later unflagged syncs", async () => {
    const f = await fixture()
    await mkdir(join(f.vault, "CS101/Assignments"), { recursive: true })
    const home = join(f.vault, "CS101/00 Home.md"),
      prompt = join(f.vault, "CS101/Assignments/student.md")
    await writeFile(home, "Existing School navigation, preserve exactly")
    await writeFile(prompt, "Student-owned School prompt, preserve exactly")
    const result = await syncCourses(f.config, { preserveSchool: true })
    expect(
      result.written
        .filter((path) => path.includes("/CS101/"))
        .every((path) => path.includes("/CS101/Canvas Agent/")),
    ).toBe(true)
    const synced = join(f.vault, "CS101/Canvas Agent/Canvas/Assignments/Case-50.md")
    expect(await readFile(synced, "utf8")).toContain("Synthetic framework evidence")
    f.setDescription("Refreshed Canvas framework evidence")
    await syncCourses(f.config)
    expect(await readFile(synced, "utf8")).toContain("Refreshed Canvas framework evidence")
    expect(await readFile(home, "utf8")).toBe("Existing School navigation, preserve exactly")
    expect(await readFile(prompt, "utf8")).toBe("Student-owned School prompt, preserve exactly")
    const course = selectCourse(await inspectWorkspace(f.vault), "CS101")
    expect(
      course.sources.some((source) => source.path.includes("Canvas Agent/Canvas/Assignments/Case")),
    ).toBe(true)
    expect(course.sources.some((source) => source.path === "CS101/Assignments/student.md")).toBe(
      true,
    )
    expect(
      JSON.parse(await readFile(join(f.vault, "_meta/canvas-courses.json"), "utf8")).courses[0]
        .syncNamespace,
    ).toBe("Canvas Agent")
  })
  it("does not pretend an existing native root Home can be shared safely without reviewed migration", async () => {
    const f = await fixture()
    await syncCourses(f.config)
    const path = join(f.vault, "CS101/00 Home.md"),
      bytes = await readFile(path)
    const mapping = await readFile(join(f.vault, "_meta/canvas-courses.json"))
    await expect(syncCourses(f.config, { preserveSchool: true })).rejects.toThrow(
      /reviewed migration/,
    )
    expect(await readFile(path)).toEqual(bytes)
    expect(await readFile(join(f.vault, "_meta/canvas-courses.json"))).toEqual(mapping)
  })
  it("refuses linked namespaces and unsupported saved namespace values before course writes", async () => {
    const f = await fixture()
    await mkdir(join(f.vault, "CS101"))
    const other = await mkdtemp(join(tmpdir(), "canvas-coexistence-target-"))
    roots.push(other)
    await writeFile(join(other, "sentinel.md"), "Do not touch")
    await symlink(other, join(f.vault, "CS101/Canvas Agent"))
    await expect(syncCourses(f.config, { preserveSchool: true })).rejects.toThrow(/symbolic link/i)
    expect(await readFile(join(other, "sentinel.md"), "utf8")).toBe("Do not touch")
    const safe = await fixture()
    await mkdir(join(safe.vault, "_meta"))
    await writeFile(
      join(safe.vault, "_meta/canvas-courses.json"),
      JSON.stringify({
        version: 1,
        courses: [{ id: "1", root: "CS101", syncNamespace: "../outside" }],
      }),
    )
    await expect(syncCourses(safe.config)).rejects.toThrow(/Unsupported Canvas product namespace/)
  })
})
