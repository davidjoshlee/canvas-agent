import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(metadata: string) {
  const root = await mkdtemp(join(tmpdir(), "canvas-period-gate-"))
  roots.push(root)
  const vault = join(root, "vault"),
    config = join(root, "config.json")
  await mkdir(join(vault, "CS101/Resources"), { recursive: true })
  await writeFile(
    join(vault, "CS101/Syllabus.md"),
    "Synthetic course syllabus: discuss evidence and assumptions.",
  )
  await writeFile(
    join(vault, "CS101/Resources/reading.md"),
    `---\n${metadata}\n---\nSynthetic reading about observations, assumptions and evidence.\n`,
  )
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      canvas: { baseUrl: "https://canvas.example.invalid", tokenEnv: "UNSET_PERIOD_TOKEN" },
      vault: { path: vault },
      courses: { allowlist: [] },
    }),
  )
  const cli = (args: string[]) =>
    spawnSync(process.execPath, [resolve("dist/cli.js"), ...args, "--config", config, "--json"], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root },
      encoding: "utf8",
      timeout: 30_000,
    })
  return { root, vault, cli }
}

it("rejects unmatched weeks and operational timestamps instead of keyword-fallback prep success", async () => {
  for (const metadata of [
    "type: files\ndates: { created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z' }",
    "type: files\ndates: { session_at: '2026-10-19T00:00:00Z' }",
    "type: modules\ncanvas_id: '12'",
  ]) {
    const f = await fixture(metadata)
    const source = join(f.vault, "CS101/Resources/reading.md"),
      before = await readFile(source)
    const result = f.cli(["prep", "CS101", "--week", "2026-10-12"])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/No readable course materials/)
    await expect(readdir(join(f.vault, "_meta/tasks"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(source)).toEqual(before)
  }
})

it("accepts explicitly dated local material without inventing a module or silently claiming a Week folder", async () => {
  const f = await fixture("type: files\ndates: { session_at: '2026-10-12T00:00:00Z' }")
  const result = f.cli(["prep", "CS101", "--week", "2026-10-12"])
  expect(result.status, result.stderr).toBe(0)
  const created = JSON.parse(result.stdout)
  const task = JSON.parse(
    await readFile(join(f.vault, "_meta/tasks", created.id, "task.json"), "utf8"),
  )
  expect(task.period).toMatchObject({ kind: "week", value: "2026-10-12" })
  expect(task.destination).toBe("CS101/Other/Prep/2026-10-12")
  expect(task.sources.map((source: { path: string }) => source.path)).toContain(
    "CS101/Resources/reading.md",
  )
  expect(task.notices).toContain(
    "No matching dated Week folder; using date-labelled Other/Prep fallback.",
  )
})
