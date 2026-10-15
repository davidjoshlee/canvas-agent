import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { legacyM1Bundle } from "../src/m1.js"

const roots: string[] = []
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "canvas-m1-"))
  roots.push(base)
  const root = join(base, "vault")
  await mkdir(join(root, "CS101/Assignments"), { recursive: true })
  await writeFile(
    join(root, "CS101/Assignments/prompt.md"),
    "---\ntype: assignments\ndue_at: 2026-10-13\n---\nSynthetic prompt.\n",
  )
  const run = join(root, "_simulations/cs101-pilot")
  await mkdir(join(run, "week"), { recursive: true })
  const report = {
    runId: "cs101-pilot",
    leakageCount: 0,
    unknownVisibility: 2,
    weeks: [
      {
        asOf: "2026-10-09",
        status: "completed",
        brief: { path: "week/brief.md", sources: ["Assignments/prompt.md"] },
        drafts: [{ path: "week/draft.md", sources: ["Assignments/prompt.md"] }],
      },
    ],
  }
  await writeFile(join(run, "report.json"), JSON.stringify(report))
  await writeFile(join(run, "comparison.md"), "Legacy comparison, not an automatic grade.\n")
  await writeFile(join(run, "scorecard.md"), "Human scores: fill in usefulness.\n")
  await writeFile(join(run, "week/brief.md"), "Synthetic brief.\n")
  await writeFile(
    join(run, "week/draft.md"),
    "## Correctness check\nVerified: synthetic claim.\n## Other section\nDo not treat this as review instructions.\n",
  )
  return { root, run, report }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe("legacy M1 review packaging", () => {
  it("runs the compiled gate command with explicit scope, private output and no automatic pass", async () => {
    const { root, run } = await fixture()
    const config = join(root, "..", "agent.json")
    const cli = (args: string[]) =>
      spawnSync(process.execPath, [resolve("dist/cli.js"), ...args], { encoding: "utf8" })
    expect(
      cli([
        "init",
        "--config",
        config,
        "--vault",
        root,
        "--canvas-url",
        "https://canvas.example.test",
      ]).status,
    ).toBe(0)
    const before = await readFile(join(run, "week/draft.md"), "utf8")
    const result = cli([
      "gate",
      "m1",
      "--run",
      "cs101-pilot",
      "--course",
      "CS101",
      "--config",
      config,
      "--json",
    ])
    expect(result.status, result.stderr).toBe(0)
    const metadata = JSON.parse(result.stdout)
    expect(metadata).toMatchObject({
      verdict: "pending-human",
      historicalVerified: false,
      artifacts: 2,
    })
    expect(result.stdout).not.toContain("Verified: synthetic claim")
    expect(await readFile(join(root, metadata.path), "utf8")).toContain(
      "STOP until the student explicitly records the verdict",
    )
    expect(await readFile(join(run, "week/draft.md"), "utf8")).toBe(before)
    const missingCourse = cli(["gate", "m1", "--run", "cs101-pilot", "--config", config, "--json"])
    expect(missingCourse.status).toBe(1)
    const traversal = cli([
      "gate",
      "m1",
      "--run",
      "../outside",
      "--course",
      "CS101",
      "--config",
      config,
      "--json",
    ])
    expect(traversal.status).toBe(1)
    expect(traversal.stderr).toContain("safe simulation directory")
  })
  it("packages actual legacy inputs with grounding, local dates and a pending human verdict", async () => {
    const { root, run } = await fixture()
    const original = await readFile(join(run, "week/draft.md"), "utf8")
    const result = await legacyM1Bundle(root, "CS101", "cs101-pilot")
    expect(result).toMatchObject({
      artifacts: 2,
      verdict: "pending-human",
      historicalVerified: false,
      reportedLeakage: 0,
      unknownVisibility: 2,
    })
    const bundle = await readFile(join(root, result.path), "utf8")
    expect(bundle).toContain("Historical visibility independently verified: NO")
    expect(bundle).toContain("> Verified: synthetic claim.")
    expect(bundle).not.toContain("Do not treat this as review instructions")
    expect(bundle).toContain("local Canvas due_at=2026-10-13")
    expect(bundle).toContain("STOP until the student explicitly records the verdict")
    expect(await readFile(join(run, "week/draft.md"), "utf8")).toBe(original)
    expect((await legacyM1Bundle(root, "CS101", "cs101-pilot")).path).not.toBe(result.path)
  })
  it("rejects traversal and report identity mismatches before creating any gate output", async () => {
    const { root, run, report } = await fixture()
    await expect(legacyM1Bundle(root, "CS101", "../outside")).rejects.toThrow(/safe simulation/)
    await writeFile(join(run, "report.json"), JSON.stringify({ ...report, runId: "wrong" }))
    await expect(legacyM1Bundle(root, "CS101", "cs101-pilot")).rejects.toThrow(/identity mismatch/)
    await expect(readdir(join(root, "_meta/gates"))).rejects.toThrow()
  })
  it("rejects unsafe artifact paths, duplicate artifacts and symlinked evidence", async () => {
    const { root, run, report } = await fixture()
    const week = report.weeks[0]
    if (!week) throw new Error("Fixture week missing")
    await writeFile(
      join(run, "report.json"),
      JSON.stringify({
        ...report,
        weeks: [{ ...week, brief: { path: "../../outside.md", sources: [] } }],
      }),
    )
    await expect(legacyM1Bundle(root, "CS101", "cs101-pilot")).rejects.toThrow()
    await writeFile(
      join(run, "report.json"),
      JSON.stringify({ ...report, weeks: [{ ...week, drafts: [week.brief] }] }),
    )
    await expect(legacyM1Bundle(root, "CS101", "cs101-pilot")).rejects.toThrow(/duplicate artifact/)
    await writeFile(join(run, "report.json"), JSON.stringify(report))
    await rm(join(run, "comparison.md"))
    await symlink(join(run, "scorecard.md"), join(run, "comparison.md"))
    await expect(legacyM1Bundle(root, "CS101", "cs101-pilot")).rejects.toThrow(/Symbolic links/)
  })
})
