import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { setCalendarOverride } from "../src/calendar.js"
import { createConfig } from "../src/config.js"
import { planReadingCopy } from "../src/reading-copy.js"
import { notifyDueSoon, planDueSoon, renderDueSoon, saveDueSoon } from "../src/reminders.js"
import { inspectWorkspace } from "../src/workspace.js"

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-reminders-"))
  roots.push(root)
  const vault = join(root, "vault")
  await mkdir(join(vault, "CS101/Assignments"), { recursive: true })
  await mkdir(join(vault, "CS101/Announcements"))
  const add = async (id: string, kind: "assignment" | "announcement", due: string) => {
    const path = `CS101/${kind === "assignment" ? "Assignments" : "Announcements"}/${id}.md`
    await writeFile(
      join(vault, path),
      `---\ncanvas_id: "${id}"\ntype: ${kind}\n${kind === "assignment" ? "due_at" : "posted_at"}: ${JSON.stringify(due)}\n---\n\n# ${id}\n\nPRIVATE_SOURCE_BODY`,
    )
    return path
  }
  const now = new Date("2026-10-13T18:00:00Z")
  const plan = async () => planDueSoon(vault, await inspectWorkspace(vault), { now })
  return { root, vault, now, add, plan }
}
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

it("uses School's inclusive due-soon boundary, excludes past/announcements and applies local overrides without changing sources", async () => {
  const f = await fixture()
  await f.add("1", "assignment", "2026-10-13T18:00:00Z")
  await f.add("2", "assignment", "2026-10-20T18:00:00Z")
  await f.add("3", "assignment", "2026-10-20T18:00:00.001Z")
  await f.add("4", "assignment", "2026-10-13T17:59:59Z")
  await f.add("5", "announcement", "2026-10-14T18:00:00Z")
  const path = await f.add("6", "assignment", "2026-11-01T18:00:00Z")
  const original = await readFile(join(f.vault, path))
  await setCalendarOverride(f.vault, await inspectWorkspace(f.vault), path, "2026-10-15T18:00:00Z")
  const plan = await f.plan()
  expect(plan.items.map((item) => item.canvasId)).toEqual(["1", "6", "2"])
  expect(plan.sourceCoverageVerified).toBe(false)
  expect(plan.submissionStatusVerified).toBe(false)
  expect(JSON.stringify(plan) + renderDueSoon(plan)).not.toContain("PRIVATE_SOURCE_BODY")
  expect(await readFile(join(f.vault, path))).toEqual(original)
})

it("saves private retained reports and an owned current alert, refuses edits/held locks, and excludes alerts from the reading copy", async () => {
  const f = await fixture()
  const path = await f.add("1", "assignment", "2026-10-14T18:00:00Z")
  const plan = await f.plan(),
    first = await saveDueSoon(f.vault, plan)
  expect(await saveDueSoon(f.vault, plan)).toEqual(first)
  const archive = await readFile(join(f.vault, first.reportFile))
  expect((await stat(join(f.vault, first.alertFile))).mode & 0o777).toBe(0o600)
  expect((await stat(join(f.vault, "_meta/due-soon"))).mode & 0o777).toBe(0o700)
  await setCalendarOverride(f.vault, await inspectWorkspace(f.vault), path, "2026-11-01T18:00:00Z")
  const second = await saveDueSoon(f.vault, await f.plan())
  expect(second.assignments).toBe(0)
  expect(await readFile(join(f.vault, first.reportFile))).toEqual(archive)
  expect(await readFile(join(f.vault, second.alertFile), "utf8")).toContain("No active due-soon")
  const copy = await planReadingCopy(f.vault, join(f.root, "phone"))
  expect(JSON.stringify(copy)).not.toContain("due-soon/")
  const current = await readFile(join(f.vault, "_meta/due-soon/current.json"))
  await writeFile(join(f.vault, second.alertFile), "STUDENT_EDITED_ALERT")
  await expect(saveDueSoon(f.vault, plan)).rejects.toThrow(/changed/)
  expect(await readFile(join(f.vault, second.alertFile), "utf8")).toBe("STUDENT_EDITED_ALERT")
  expect(await readFile(join(f.vault, "_meta/due-soon/current.json"))).toEqual(current)
  await writeFile(join(f.vault, "_meta/due-soon/refresh.lock"), "another owner", { mode: 0o600 })
  await expect(saveDueSoon(f.vault, plan)).rejects.toThrow()
  expect(await readFile(join(f.vault, "_meta/due-soon/refresh.lock"), "utf8")).toBe("another owner")
})

it("refuses unowned alerts and symlinked state without reading targets or overwriting student files", async () => {
  const f = await fixture(),
    plan = await f.plan()
  await mkdir(join(f.vault, "_meta/due-soon"), { recursive: true, mode: 0o700 })
  const alert = join(f.vault, "_meta/due-soon/ALERT.md")
  await writeFile(alert, "STUDENT_ALERT", { mode: 0o600 })
  await expect(saveDueSoon(f.vault, plan)).rejects.toThrow(/Unowned/)
  expect(await readFile(alert, "utf8")).toBe("STUDENT_ALERT")
  await rm(alert)
  await symlink(join(f.root, "private-target"), join(f.vault, "_meta/due-soon/current.json"))
  await expect(saveDueSoon(f.vault, plan)).rejects.toThrow(/Symbolic links/)
})

it("never invokes desktop delivery for empty/unsupported plans and quotes opt-in macOS notifications with bounded transport", async () => {
  const f = await fixture()
  const execute = vi.fn(async () => ({ stdout: "", stderr: "" }))
  const empty = await f.plan()
  expect(await notifyDueSoon(empty, execute, "darwin")).toBe("nothing-due")
  await f.add("1", "assignment", "2026-10-14T18:00:00Z")
  const plan = await f.plan()
  plan.items[0] = {
    ...plan.items[0],
    course: "CS101",
    path: "CS101/Assignments/1.md",
    dueAt: "2026-10-14T18:00:00Z",
    title: 'Case "; do shell script "inert"\nnew line',
  }
  expect(await notifyDueSoon(plan, execute, "linux")).toBe("unsupported-platform")
  expect(execute).not.toHaveBeenCalled()
  expect(await notifyDueSoon(plan, execute, "darwin")).toBe("sent")
  expect(execute).toHaveBeenCalledWith(
    "/usr/bin/osascript",
    ["-e", expect.stringContaining('Case \\"; do shell script \\"inert\\" new line')],
    { timeout: 2000, maxBuffer: 4096 },
  )
  execute.mockRejectedValueOnce(new Error("PRIVATE_OS_ERROR"))
  expect(await notifyDueSoon(plan, execute, "darwin")).toBe("failed")
})

it("previews and saves reminders with the compiled CLI, requiring explicit apply for notifications", async () => {
  const f = await fixture(),
    config = join(f.root, "config.json")
  await f.add("1", "assignment", new Date(Date.now() + 86_400_000).toISOString())
  await createConfig(config, { vault: f.vault, baseUrl: "https://canvas.example.test" })
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      [
        resolve("dist/cli.js"),
        "reminders",
        "--course",
        "CS101",
        ...args,
        "--config",
        config,
        "--json",
      ],
      { encoding: "utf8" },
    )
  const preview = run([])
  expect(preview.status, preview.stderr).toBe(0)
  expect(JSON.parse(preview.stdout)).toMatchObject({
    applied: false,
    notification: "not-requested",
    plan: { items: [expect.objectContaining({ canvasId: "1" })] },
  })
  await expect(stat(join(f.vault, "_meta/due-soon"))).rejects.toThrow()
  expect(run(["--notify"]).status).not.toBe(0)
  const saved = run(["--apply"])
  expect(saved.status, saved.stderr).toBe(0)
  expect(JSON.parse(saved.stdout)).toMatchObject({
    applied: true,
    notification: "not-requested",
    receipt: { assignments: 1 },
  })
  expect(saved.stdout + preview.stdout).not.toContain("PRIVATE_SOURCE_BODY")
})
