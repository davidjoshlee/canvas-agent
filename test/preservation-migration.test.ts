import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { setCanvasFetchForTests, syncCourses } from "../src/canvas.js"
import {
  applyPreservationMigration,
  planPreservationMigration,
  preservationLock,
  setPreservationHookForTests,
} from "../src/preservation-migration.js"
import type { ToolkitConfig } from "../src/types.js"

const roots: string[] = []
afterEach(async () => {
  setCanvasFetchForTests()
  setPreservationHookForTests()
  delete process.env.CANVAS_PRESERVE_TEST_TOKEN
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const json = (value: unknown) => new Response(JSON.stringify(value))
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-preservation-migration-"))
  roots.push(root)
  const vault = join(root, "vault"),
    configPath = join(root, "config.json")
  const config: ToolkitConfig = {
    version: 1,
    canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "CANVAS_PRESERVE_TEST_TOKEN" },
    vault: { path: vault },
    courses: { allowlist: ["1"] },
  }
  process.env.CANVAS_PRESERVE_TEST_TOKEN = "synthetic-token"
  let calls = 0
  setCanvasFetchForTests(async (input) => {
    calls++
    const path = new URL(String(input)).pathname
    if (path === "/api/v1/users/self") return json({ id: 99, name: "Synthetic" })
    if (path === "/api/v1/courses")
      return json([{ id: 1, name: "Synthetic", course_code: "CS101" }])
    if (path === "/api/v1/courses/1")
      return json({ id: 1, name: "Synthetic", course_code: "CS101" })
    return json([])
  })
  await writeFile(configPath, JSON.stringify(config))
  await syncCourses(config)
  const home = join(vault, "CS101/00 Home.md"),
    mapping = join(vault, "_meta/canvas-courses.json"),
    state = join(vault, "_meta/canvas-sync-state.json")
  await mkdir(join(vault, "CS101/Assignments"))
  const student = join(vault, "CS101/Assignments/student.md")
  await writeFile(student, "PRIVATE_STUDENT_ORIGINAL")
  return { root, vault, config, configPath, home, mapping, state, student, calls: () => calls }
}
describe("archive-backed preservation activation", () => {
  it("previews without writes and archives exact owned navigation before sticky namespace sync", async () => {
    const f = await fixture(),
      before = await readdir(join(f.vault, "_meta")),
      original = await readFile(f.home)
    const plan = await planPreservationMigration(f.config, "1")
    expect(plan).toMatchObject({ ready: true, alreadyEnabled: false, root: "CS101" })
    expect(await readdir(join(f.vault, "_meta"))).toEqual(before)
    const result = await applyPreservationMigration(f.config, plan)
    expect(result.changed).toBe(true)
    if (!("archivedHome" in result)) throw new Error("Missing archive")
    expect(await readFile(join(f.vault, result.archivedHome))).toEqual(original)
    await expect(readFile(f.home)).rejects.toMatchObject({ code: "ENOENT" })
    expect(JSON.parse(await readFile(f.mapping, "utf8")).courses[0].syncNamespace).toBe(
      "Canvas Agent",
    )
    expect(JSON.parse(await readFile(f.state, "utf8")).files["CS101/00 Home.md"]).toBeUndefined()
    await syncCourses(f.config)
    expect(await readFile(join(f.vault, "CS101/Canvas Agent/00 Home.md"), "utf8")).toContain(
      "Synthetic",
    )
    expect(await readFile(f.student, "utf8")).toBe("PRIVATE_STUDENT_ORIGINAL")
    expect(
      await applyPreservationMigration(f.config, await planPreservationMigration(f.config, "1")),
    ).toMatchObject({ changed: false, historicalArchiveVerified: false })
  })
  it("refuses edited originals, stale/forged plans and courses outside the explicit allowlist", async () => {
    const f = await fixture(),
      plan = await planPreservationMigration(f.config, "1")
    await expect(planPreservationMigration(f.config, "2")).rejects.toThrow(/allowlisted/)
    await expect(
      applyPreservationMigration(f.config, { ...plan, root: "../other" }),
    ).rejects.toThrow(/stale/)
    await writeFile(f.home, "PRIVATE_EDITED_NAVIGATION")
    expect((await planPreservationMigration(f.config, "1")).ready).toBe(false)
    await expect(applyPreservationMigration(f.config, plan)).rejects.toThrow(/stale|conflicted/)
    expect(await readFile(f.home, "utf8")).toBe("PRIVATE_EDITED_NAVIGATION")
  })
  it.each(["after-home-move", "after-map-write"] as const)(
    "rolls back owned changes on %s failure while retaining private backups",
    async (phase) => {
      const f = await fixture(),
        plan = await planPreservationMigration(f.config, "1")
      const originals = await Promise.all(
        [f.home, f.mapping, f.state].map((path) => readFile(path)),
      )
      setPreservationHookForTests(async (current) => {
        if (current === phase) throw new Error("Synthetic injected failure")
      })
      await expect(applyPreservationMigration(f.config, plan)).rejects.toThrow(/rolled back/)
      for (const [index, path] of [f.home, f.mapping, f.state].entries())
        expect(await readFile(path)).toEqual(originals[index])
      expect(await readdir(join(f.vault, "_meta/canvas-preservation"))).toHaveLength(1)
      await expect(readFile(preservationLock(f.vault))).rejects.toMatchObject({ code: "ENOENT" })
    },
  )
  it("never overwrites concurrent replacement navigation and retains recoverable original bytes", async () => {
    const f = await fixture(),
      plan = await planPreservationMigration(f.config, "1"),
      original = await readFile(f.home)
    setPreservationHookForTests(async (phase) => {
      if (phase === "after-home-move") await writeFile(f.home, "CONCURRENT_SCHOOL_HOME")
    })
    await expect(applyPreservationMigration(f.config, plan)).rejects.toThrow(/manual recovery/)
    expect(await readFile(f.home, "utf8")).toBe("CONCURRENT_SCHOOL_HOME")
    const dirs = await readdir(join(f.vault, "_meta/canvas-preservation"))
    expect(
      await readFile(
        join(f.vault, "_meta/canvas-preservation", dirs[0] ?? "missing", "Home.original.md"),
      ),
    ).toEqual(original)
    expect(await readFile(f.student, "utf8")).toBe("PRIVATE_STUDENT_ORIGINAL")
  })
  it("preserves a held lock and prevents sync requests during a transaction", async () => {
    const f = await fixture(),
      plan = await planPreservationMigration(f.config, "1")
    const path = preservationLock(f.vault)
    await writeFile(path, "OTHER_OWNER", { mode: 0o600 })
    const calls = f.calls()
    await expect(syncCourses(f.config)).rejects.toThrow(/lock is held/)
    expect(f.calls()).toBe(calls)
    await expect(applyPreservationMigration(f.config, plan)).rejects.toMatchObject({
      code: "EEXIST",
    })
    expect(await readFile(path, "utf8")).toBe("OTHER_OWNER")
  })
  it("runs compiled preview/apply from outside the checkout without exposing document bodies", async () => {
    const f = await fixture(),
      original = await readFile(f.home)
    const run = (apply: boolean) => {
      const result = spawnSync(
        process.execPath,
        [
          resolve("dist/cli.js"),
          "vault",
          "preserve-school",
          "--course",
          "1",
          ...(apply ? ["--apply"] : []),
          "--config",
          f.configPath,
          "--json",
        ],
        { cwd: tmpdir(), encoding: "utf8" },
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout + result.stderr).not.toMatch(
        /PRIVATE_STUDENT_ORIGINAL|Canvas course ID|# Synthetic/,
      )
      return JSON.parse(result.stdout)
    }
    expect(run(false)).toMatchObject({ preview: true, ready: true })
    expect(await readFile(f.home)).toEqual(original)
    const result = run(true)
    expect(result.changed).toBe(true)
    expect(await readFile(join(f.vault, result.archivedHome))).toEqual(original)
    expect(await readFile(f.student, "utf8")).toBe("PRIVATE_STUDENT_ORIGINAL")
  })
})
