import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { captureSimulation, replaySimulation } from "../src/simulation.js"

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-simulation-"))
  roots.push(root)
  const course = join(root, "ACCT312", "Week 42")
  await mkdir(course, { recursive: true })
  await writeFile(
    join(course, "known.md"),
    "---\ndates:\n  date: 2026-10-08\navailable_at: 2026-10-08\n---\n# Known\nSnapshot text.\n",
  )
  await writeFile(
    join(course, "future.md"),
    "---\ndates:\n  date: 2026-10-12\nposted_at: 2026-10-12\n---\n# Future\nFuture text.\n",
  )
  await writeFile(join(course, "unknown.md"), "# Unknown\nNo date signal.\n")
  await writeFile(
    join(course, "due-only.md"),
    "---\ndue_at: 2026-10-08\n---\n# Due only\nA deadline does not establish availability.\n",
  )
  await mkdir(join(root, "ACCT312", "_meta", "tasks"), { recursive: true })
  await writeFile(join(root, "ACCT312", "_meta", "tasks", "private.md"), "Private metadata\n")
  await writeFile(
    join(root, "outside.md"),
    "---\ndates:\n  date: 2026-10-08\navailable_at: 2026-10-08\n---\nSecret outside text\n",
  )
  await symlink(join(root, "outside.md"), join(course, "linked.md"))
  return { root, known: join(course, "known.md") }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("historical source replay", () => {
  it("captures date-qualified sources privately and replays its fixed version after vault changes", async () => {
    const { root, known } = await fixture()
    const capture = await captureSimulation(root, "ACCT312", "2026-10-09")
    expect(capture.sourceCount).toBe(1)
    expect(capture.limitation).toContain("not a reconstruction")
    await writeFile(
      known,
      "---\ndates:\n  date: 2026-10-08\navailable_at: 2026-10-08\n---\n# Known\nChanged current vault.\n",
    )
    const replay = await replaySimulation(root, capture.id)
    expect(replay.sources.map((source) => source.path)).toContain("ACCT312/Week 42/known.md")
    expect(replay.sources[0]?.text).toContain("Snapshot text")
    expect(replay.sources[0]?.text).not.toContain("Changed current vault")
    expect(replay.hostHandoff.instructions.join(" ")).toContain("external")
    expect(replay.limitation).toContain("cannot establish historical file contents")
    expect(await readFile(join(root, capture.path), "utf8")).toContain("Snapshot text")
  })

  it("fails closed for unknown and future date signals and excludes private metadata and symlinks", async () => {
    const { root } = await fixture()
    const capture = await captureSimulation(root, "ACCT312", "2026-10-09")
    const replay = await replaySimulation(root, capture.id)
    expect(replay.sources.map((source) => source.path)).not.toContain("ACCT312/Week 42/future.md")
    expect(replay.sources.map((source) => source.path)).not.toContain("ACCT312/Week 42/unknown.md")
    expect(replay.sources.map((source) => source.path).join(" ")).not.toMatch(/private|linked\.md/)
    expect(replay.sources.map((source) => source.path)).not.toContain("ACCT312/Week 42/due-only.md")
    expect(replay.excluded.map((entry) => entry.reason).join(" ")).toMatch(
      /Unknown availability evidence/,
    )
    expect(replay.excluded.map((entry) => entry.reason).join(" ")).toMatch(
      /future availability signal/,
    )
  })

  it("rejects future cutoffs and tampered snapshot content", async () => {
    const { root } = await fixture()
    await expect(captureSimulation(root, "ACCT312", "2999-01-01")).rejects.toThrow(
      "cannot be in the future",
    )
    const capture = await captureSimulation(root, "ACCT312", "2026-10-09")
    const path = join(root, capture.path)
    await writeFile(path, (await readFile(path, "utf8")).replace("Snapshot text", "tampered text"))
    await expect(replaySimulation(root, capture.id)).rejects.toThrow("hash mismatch")
  })
})
