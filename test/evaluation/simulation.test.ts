import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { captureSimulation, replaySimulation } from "../../src/evaluation/captures.js"

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
  it("captures permitted global/course guidance with cutoff evidence and reports undated/future/restricted exclusions", async () => {
    const { root } = await fixture()
    await mkdir(join(root, "ACCT312/Guidance"))
    await writeFile(
      join(root, "AGENTS.md"),
      "---\navailable_at: 2026-10-05\n---\nGlobal permitted workflow guidance.",
    )
    await writeFile(
      join(root, "ACCT312/Guidance/active.md"),
      "---\ndates:\n  available_at: 2026-10-05\n---\nCourse-specific permitted guidance.",
    )
    await writeFile(
      join(root, "ACCT312/Guidance/undated.md"),
      "Undated guidance is not automatically historical.",
    )
    await writeFile(
      join(root, "ACCT312/Guidance/future.md"),
      "---\navailable_at: 2026-10-10\n---\nFuture guidance.",
    )
    await writeFile(
      join(root, "ACCT312/Guidance/restricted.md"),
      "---\navailable_at: 2026-10-05\nredistribution: restricted\n---\nRestricted guidance body.",
    )
    const capture = await captureSimulation(root, "ACCT312", "2026-10-09")
    expect(capture.guidanceCount).toBe(2)
    const replay = await replaySimulation(root, capture.id)
    expect(replay.guidance.map((item) => item.path)).toEqual([
      "ACCT312/Guidance/active.md",
      "AGENTS.md",
    ])
    expect(replay.excluded.find((item) => item.path.endsWith("undated.md"))?.reason).toMatch(
      /Unknown availability/,
    )
    expect(replay.excluded.find((item) => item.path.endsWith("future.md"))?.reason).toMatch(
      /future availability/,
    )
    expect(JSON.stringify(replay)).not.toContain("Restricted guidance body")
    await writeFile(
      join(root, "ACCT312/Guidance/active.md"),
      "Changed active guidance after capture.",
    )
    expect((await replaySimulation(root, capture.id)).guidance[0]?.text).toContain(
      "Course-specific",
    )
  })
  it("reads old snapshots without injecting current guidance and rejects forged guidance role/path metadata", async () => {
    const { root } = await fixture()
    const capture = await captureSimulation(root, "ACCT312", "2026-10-09")
    const path = join(root, capture.path),
      original = JSON.parse(await readFile(path, "utf8"))
    delete original.guidance
    delete original.guidanceIdentityVersion
    delete original.restrictedGuidanceVersion
    delete original.restrictedGuidance
    const { hash: _old, ...base } = original
    original.hash = createHash("sha256").update(JSON.stringify(base)).digest("hex")
    const oldBytes = JSON.stringify(original)
    await writeFile(path, oldBytes)
    await mkdir(join(root, "ACCT312/Guidance"))
    await writeFile(
      join(root, "ACCT312/Guidance/current.md"),
      "---\navailable_at: 2026-10-05\n---\nNew current guidance.",
    )
    expect((await replaySimulation(root, capture.id)).guidance).toEqual([])
    expect(await readFile(path, "utf8")).toBe(oldBytes)
    for (const forgedPath of [
      "OTHER101/Guidance/policy.md",
      "ACCT312/_meta/tasks/task.md",
      "ACCT312/readings/not-guidance.md",
      "ACCT312/_meta/guidance/secrets.md",
    ]) {
      const changed = {
        ...original,
        guidance: [{ ...original.sources[0], type: "guidance", path: forgedPath }],
      }
      const { hash: _hash, ...payload } = changed
      changed.hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex")
      await writeFile(path, JSON.stringify(changed))
      await expect(replaySimulation(root, capture.id)).rejects.toThrow(/invalid source/)
    }
  })
  it("captures nested availability and preserves module relationships through replay", async () => {
    const { root, known } = await fixture()
    await writeFile(
      known,
      "---\nmodule_canvas_id: '123'\ndates:\n  available_at: 2026-10-08\n---\nSynthetic linked reading.\n",
    )
    const capture = await captureSimulation(root, "ACCT312", "2026-10-09")
    const replay = await replaySimulation(root, capture.id)
    expect(replay.sources.find((source) => source.path.endsWith("known.md"))).toMatchObject({
      moduleCanvasId: "123",
      availabilitySignals: [{ field: "dates.available_at", value: "2026-10-08" }],
    })
  })
  it.each(["invalid-date", "cross-course"])(
    "refuses rehashed snapshots with %s evidence",
    async (mode) => {
      const { root } = await fixture()
      const capture = await captureSimulation(root, "ACCT312", "2026-10-09")
      const path = join(root, capture.path),
        record = JSON.parse(await readFile(path, "utf8"))
      if (mode === "invalid-date") record.sources[0].availabilitySignals[0].value = "invalid-date"
      else record.sources[0].path = "OTHER101/secret.md"
      const { hash: _prior, ...base } = record
      record.hash = createHash("sha256").update(JSON.stringify(base)).digest("hex")
      await writeFile(path, JSON.stringify(record))
      await expect(replaySimulation(root, capture.id)).rejects.toThrow(/invalid source/)
    },
  )
  it("captures date-qualified sources privately and replays its fixed version after vault changes", async () => {
    const { root, known } = await fixture()
    const capture = await captureSimulation(root, "ACCT312", "2026-10-09")
    expect(capture.sourceCount).toBe(2)
    expect(capture.limitation).toContain("not a reconstruction")
    await writeFile(
      known,
      "---\ndates:\n  date: 2026-10-08\navailable_at: 2026-10-08\n---\n# Known\nChanged current vault.\n",
    )
    const replay = await replaySimulation(root, capture.id)
    expect(replay.sources.map((source) => source.path)).toContain("ACCT312/Week 42/known.md")
    expect(replay.sources.find((source) => source.path.endsWith("known.md"))?.text).toContain(
      "Snapshot text",
    )
    expect(replay.sources.find((source) => source.path.endsWith("known.md"))?.text).not.toContain(
      "Changed current vault",
    )
    expect(replay.hostHandoff.instructions.join(" ")).toContain("external")
    expect(replay.limitation).toContain("neither establishes historical contents")
    expect(await readFile(join(root, capture.path), "utf8")).toContain("Snapshot text")
  })

  it("fails closed for unknown and future date signals and excludes private metadata and symlinks", async () => {
    const { root } = await fixture()
    const capture = await captureSimulation(root, "ACCT312", "2026-10-09")
    const replay = await replaySimulation(root, capture.id)
    expect(replay.sources.map((source) => source.path)).not.toContain("ACCT312/Week 42/future.md")
    expect(replay.sources.map((source) => source.path)).not.toContain("ACCT312/Week 42/unknown.md")
    expect(replay.sources.map((source) => source.path).join(" ")).not.toMatch(/private|linked\.md/)
    expect(
      replay.sources.find((source) => source.path === "ACCT312/Week 42/due-only.md")
        ?.availabilitySignals,
    ).toEqual([{ field: "school.due_at", value: "2026-10-08" }])
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
