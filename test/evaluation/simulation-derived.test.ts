import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  captureSimulation,
  deriveSimulationCapture,
  replaySimulation,
} from "../../src/evaluation/captures.js"
import { createSimulationTask, readSimulationTask } from "../../src/evaluation/tasks.js"

const roots: string[] = []
const sha = (text: string) => createHash("sha256").update(text).digest("hex")
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "canvas-derived-capture-"))
  roots.push(base)
  const vault = join(base, "vault")
  await mkdir(join(vault, "CS101/Week 01 - Oct 5"), { recursive: true })
  await mkdir(join(vault, "CS101/Week 02 - Oct 12"), { recursive: true })
  await mkdir(join(vault, "CS101/Guidance"), { recursive: true })
  await writeFile(
    join(vault, "CS101/Week 01 - Oct 5/reading.md"),
    "---\navailable_at: 2026-10-05\ndates:\n  date: 2026-10-05\n---\n# Reading\nSynthetic older reading explains fixed evidence and availability filtering in enough detail for a substantive mechanical fixture.",
  )
  await writeFile(
    join(vault, "CS101/Week 02 - Oct 12/reading.md"),
    "---\navailable_at: 2026-10-12\ndates:\n  date: 2026-10-12\n---\n# Later reading\nSynthetic later reading must not enter earlier cutoff evidence.",
  )
  await writeFile(
    join(vault, "AGENTS.md"),
    "---\navailable_at: 2026-10-05\n---\nSynthetic global reference guidance, not instructor permission.",
  )
  await writeFile(
    join(vault, "CS101/Guidance/prep-guidance.md"),
    "---\navailable_at: 2026-10-12\n---\nSynthetic later course guidance, not instructor permission.",
  )
  await writeFile(
    join(vault, "CS101/undated.md"),
    "Undated reference must stay unknown, not be backfilled.",
  )
  const parent = await captureSimulation(vault, "CS101", "2026-10-12")
  return { base, vault, parent }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe("derived fixed-cutoff captures", () => {
  it("runs compiled derivation, frozen completion, comparison and M1 without newer source substitution", async () => {
    const { base, vault, parent } = await fixture()
    const config = join(base, "config.json")
    const cli = (args: string[]) => {
      const result = spawnSync(
        process.execPath,
        [resolve("dist/cli.js"), ...args, "--config", config, "--json"],
        { encoding: "utf8" },
      )
      expect(result.status, result.stderr).toBe(0)
      return JSON.parse(result.stdout)
    }
    cli(["init", "--vault", vault, "--canvas-url", "https://canvas.example.test"])
    await writeFile(
      join(vault, "CS101/Week 01 - Oct 5/reading.md"),
      "Changed live reading, not the frozen body.",
    )
    const child = cli(["simulate", "derive", parent.id, "--as-of", "2026-10-05"])
    expect(child.derivedFrom).toEqual({ id: parent.id, hash: parent.hash })
    const handoff = cli([
      "simulate",
      "task",
      "create",
      child.id,
      "--kind",
      "prep",
      "--week",
      "2026-10-05",
    ])
    const shown = cli(["simulate", "task", "show", handoff.id])
    expect(
      shown.task.sources.some((s: { text: string }) => s.text.includes("Synthetic older reading")),
    ).toBe(true)
    expect(shown.task.sources.some((s: { path: string }) => s.path.includes("Week 02"))).toBe(false)
    const file = join(vault, "candidate.md")
    await writeFile(
      file,
      [
        `Task: ${handoff.id}`,
        ...shown.task.requirements.map(
          (heading: string) =>
            `## ${heading}\n${heading === "Sources" ? `\`${shown.task.sources[0].path}\`` : "Synthetic structural-validator output, not coursework."}`,
        ),
      ].join("\n\n"),
    )
    expect(cli(["simulate", "task", "complete", handoff.id, "--file", file]).verdict).toBe(
      "pending-human",
    )
    const compared = cli(["simulate", "compare", "--course", "CS101", "--task", handoff.id])
    expect(cli(["gate", "m1", "--course", "CS101", "--comparison", compared.id]).verdict).toBe(
      "pending-human",
    )
    expect(await readFile(join(vault, "CS101/Week 01 - Oct 5/reading.md"), "utf8")).toBe(
      "Changed live reading, not the frozen body.",
    )
  }, 15_000)
  it("filters sources and guidance solely from one frozen parent, preserving bytes after live edits", async () => {
    const { vault, parent } = await fixture()
    const parentBytes = await readFile(join(vault, parent.path))
    const before = await replaySimulation(vault, parent.id)
    expect(before.sources).toHaveLength(2)
    expect(before.guidance).toHaveLength(2)
    await writeFile(
      join(vault, "CS101/Week 01 - Oct 5/reading.md"),
      "Changed live body must not replace captured content.",
    )
    await writeFile(
      join(vault, "AGENTS.md"),
      "Changed live guidance must not replace captured content.",
    )
    const child = await deriveSimulationCapture(vault, parent.id, "2026-10-05")
    const replay = await replaySimulation(vault, child.id)
    expect(replay.derivedFrom).toEqual({ id: parent.id, hash: parent.hash })
    expect(replay.capturedAt).toBe(parent.capturedAt)
    expect(replay.sources).toEqual(before.sources.filter((s) => s.path.includes("Week 01")))
    expect(replay.guidance).toEqual(before.guidance.filter((s) => s.path === "AGENTS.md"))
    expect(replay.excluded.some((s) => s.path.includes("Week 02") && /future/.test(s.reason))).toBe(
      true,
    )
    expect(
      replay.excluded.some((s) => s.path.endsWith("undated.md") && /Unknown/.test(s.reason)),
    ).toBe(true)
    const prep = await createSimulationTask(vault, child.id, { kind: "prep", week: "2026-10-05" })
    const task = await readSimulationTask(vault, prep.id)
    expect(task.task.sources.some((s) => s.text.includes("Synthetic older reading"))).toBe(true)
    expect(task.task.sources.some((s) => s.path.includes("Week 02"))).toBe(false)
    expect(await readFile(join(vault, parent.path))).toEqual(parentBytes)
  })

  it("permits equal/earlier cutoffs and rejects later, invalid or nested derivations without new files", async () => {
    const { vault, parent } = await fixture()
    const equal = await deriveSimulationCapture(vault, parent.id, "2026-10-12")
    expect((await replaySimulation(vault, equal.id)).sources).toEqual(
      (await replaySimulation(vault, parent.id)).sources,
    )
    const empty = await deriveSimulationCapture(vault, parent.id, "2026-10-01")
    expect((await replaySimulation(vault, empty.id)).sources).toEqual([])
    const before = await readdir(join(vault, "_meta/simulations"))
    await expect(deriveSimulationCapture(vault, parent.id, "2026-10-19")).rejects.toThrow(/later/)
    await expect(deriveSimulationCapture(vault, parent.id, "2026-02-30")).rejects.toThrow(
      /real calendar/,
    )
    await expect(deriveSimulationCapture(vault, empty.id, "2026-10-01")).rejects.toThrow(
      /original parent/,
    )
    expect(await readdir(join(vault, "_meta/simulations"))).toEqual(before)
  })

  it("rejects rehashed child-body substitution and parent rebinding, not just checksum failures", async () => {
    const { vault, parent } = await fixture()
    const child = await deriveSimulationCapture(vault, parent.id, "2026-10-05")
    const path = join(vault, child.path)
    const bytes = await readFile(path, "utf8")
    const value = JSON.parse(bytes)
    value.sources[0].text = "Rehashed fabricated source text."
    const { hash: _digest, ...base } = value
    value.hash = sha(JSON.stringify(base))
    await writeFile(path, JSON.stringify(value))
    await expect(replaySimulation(vault, child.id)).rejects.toThrow(/original frozen inventory/)
    await writeFile(path, bytes)
    const changed = JSON.parse(bytes)
    changed.derivedFrom.hash = "0".repeat(64)
    const { hash: _oldHash, ...changedBase } = changed
    changed.hash = sha(JSON.stringify(changedBase))
    await writeFile(path, JSON.stringify(changed))
    await expect(replaySimulation(vault, child.id)).rejects.toThrow(/original frozen inventory/)
  })

  it("binds the unchanged original capture and redacts malformed private snapshot JSON", async () => {
    const { vault, parent } = await fixture()
    const child = await deriveSimulationCapture(vault, parent.id, "2026-10-05")
    const path = join(vault, parent.path)
    const bytes = await readFile(path, "utf8")
    const value = JSON.parse(bytes)
    value.sources[0].text = "Edited parent body with a new checksum."
    const { hash: _digest, ...base } = value
    value.hash = sha(JSON.stringify(base))
    await writeFile(path, JSON.stringify(value))
    await expect(replaySimulation(vault, child.id)).rejects.toThrow(/original frozen inventory/)
    await writeFile(path, "PRIVATE_MALFORMED_CAPTURE_BODY")
    await expect(replaySimulation(vault, child.id)).rejects.toThrow(
      "Simulation snapshot must contain valid JSON; inspect privately",
    )
    await writeFile(path, bytes)
    expect((await replaySimulation(vault, child.id)).derivedFrom?.hash).toBe(parent.hash)
  })
})
