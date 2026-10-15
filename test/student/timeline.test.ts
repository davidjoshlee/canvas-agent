import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createConfig } from "../../src/config/index.js"
import { setCalendarOverride } from "../../src/student/calendar.js"
import { isoWeek, readTimeline, renderTimeline } from "../../src/student/timeline.js"
import { inspectWorkspace } from "../../src/vault/workspace.js"

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-timeline-"))
  roots.push(root)
  const vault = join(root, "vault")
  await mkdir(join(vault, "CS101/Assignments"), { recursive: true })
  await mkdir(join(vault, "CS101/Announcements"))
  const add = async (id: string, kind: "assignment" | "announcement", date?: string) => {
    const path = `CS101/${kind === "assignment" ? "Assignments" : "Announcements"}/${id}.md`
    await writeFile(
      join(vault, path),
      `---\ncanvas_id: "${id}"\ntype: ${kind}\n${date ? `${kind === "assignment" ? "due_at" : "posted_at"}: ${JSON.stringify(date)}\n` : ""}---\n\n# ${id}\n\nPRIVATE_SYNTHETIC_SOURCE_BODY`,
    )
    return path
  }
  return { root, vault, add }
}
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

it("groups by UTC day and ISO week, includes earlier today, excludes the exact end boundary and flags announcements", async () => {
  const f = await fixture()
  await f.add("1", "assignment", "2026-10-13T08:00:00Z")
  await f.add("2", "announcement", "2026-10-13T09:00:00Z")
  await f.add("3", "assignment", "2026-10-20T00:00:00Z")
  await f.add("4", "assignment", "2026-10-19T23:59:59Z")
  await f.add("5", "assignment", "2026-10-12T23:59:59Z")
  await f.add("6", "announcement")
  const result = await readTimeline(f.vault, await inspectWorkspace(f.vault), {
    weeks: 1,
    now: new Date("2026-10-13T18:00:00Z"),
  })
  expect(result.window).toEqual({
    from: "2026-10-13T00:00:00.000Z",
    toExclusive: "2026-10-20T00:00:00.000Z",
    weeks: 1,
    timeZone: "UTC",
  })
  expect(
    result.dated.map((day) => [day.week, day.date, day.items.map((item) => item.canvasId)]),
  ).toEqual([
    ["2026-W42", "2026-10-13", ["1", "2"]],
    ["2026-W43", "2026-10-19", ["4"]],
  ])
  expect(result.items[0]?.overdue).toBe(false)
  expect(result.overdue.map((item) => item.canvasId)).toEqual(["5"])
  expect(result.items.find((item) => item.canvasId === "2")?.actionRequired).toBe(true)
  expect(result.undated[0]).toMatchObject({ canvasId: "6", actionRequired: true })
  expect(renderTimeline(result)).toContain("2026-W42 — 2026-10-13")
  expect(renderTimeline(result)).toContain("2 [ACTION]")
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SYNTHETIC_SOURCE_BODY")
})

it("handles ISO year rollover and offset timestamps using their actual UTC day", async () => {
  const f = await fixture()
  await f.add("1", "assignment", "2021-01-01T00:30:00+02:00")
  const result = await readTimeline(f.vault, await inspectWorkspace(f.vault), {
    weeks: 1,
    now: new Date("2020-12-31T12:00:00Z"),
  })
  expect(result.dated[0]).toMatchObject({ week: "2020-W53", date: "2020-12-31" })
  expect(isoWeek("2021-01-01")).toBe("2020-W53")
  expect(isoWeek("2021-01-04")).toBe("2021-W01")
  expect(renderTimeline(result)).toContain("22:30 CS101")
})

it("applies private local overrides without changing originals and validates scope/count/time", async () => {
  const f = await fixture(),
    path = await f.add("1", "assignment", "2026-11-10T00:00:00Z")
  const original = await readFile(join(f.vault, path))
  const context = await inspectWorkspace(f.vault)
  await setCalendarOverride(f.vault, context, path, "2026-10-15T08:00:00Z")
  const options = { weeks: 1, now: new Date("2026-10-13T18:00:00Z") }
  const result = await readTimeline(f.vault, context, { ...options, course: "CS101" })
  expect(result.dated[0]?.date).toBe("2026-10-15")
  expect(await readFile(join(f.vault, path))).toEqual(original)
  await expect(
    readTimeline(f.vault, context, { ...options, course: "not a course" }),
  ).rejects.toThrow(/No course/)
  for (const weeks of [0, -1, 1.5, 366])
    await expect(readTimeline(f.vault, context, { ...options, weeks })).rejects.toThrow(/1 to 365/)
  await expect(readTimeline(f.vault, context, { now: new Date(NaN) })).rejects.toThrow(/valid time/)
})

it("renders grouped and metadata-only compiled CLI timelines without loading a model or exposing source bodies", async () => {
  const f = await fixture(),
    config = join(f.root, "config.json")
  const due = new Date(Date.now() + 2 * 86_400_000).toISOString()
  await f.add("1", "assignment", due)
  await f.add("2", "announcement", due)
  await createConfig(config, { vault: f.vault, baseUrl: "https://canvas.example.test" })
  const run = (json: boolean) =>
    spawnSync(
      process.execPath,
      [
        resolve("dist/cli.js"),
        "timeline",
        "--weeks",
        "1",
        "--course",
        "CS101",
        "--config",
        config,
        ...(json ? ["--json"] : []),
      ],
      { encoding: "utf8" },
    )
  const text = run(false),
    json = run(true)
  expect(text.status, text.stderr).toBe(0)
  expect(json.status, json.stderr).toBe(0)
  expect(text.stdout).toContain("Timeline (UTC)")
  expect(text.stdout).toContain("[ACTION]")
  expect(JSON.parse(json.stdout).dated[0].items).toHaveLength(2)
  expect(JSON.parse(json.stdout).window.timeZone).toBe("UTC")
  expect(text.stdout + json.stdout).not.toContain("PRIVATE_SYNTHETIC_SOURCE_BODY")
})
