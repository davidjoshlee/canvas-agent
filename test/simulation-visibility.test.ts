import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { captureSimulation, deriveSimulationCapture, replaySimulation } from "../src/simulation.js"
import { createSimulationTask, readSimulationTask } from "../src/simulation-tasks.js"

const roots: string[] = []
async function fixture() {
  const vault = await mkdtemp(join(tmpdir(), "canvas-structural-visibility-"))
  roots.push(vault)
  await mkdir(join(vault, "CS101"))
  const documents: Record<string, string> = {
    "module.md":
      'type: modules\ncanvas_id: "11"\ndates: {unlock_at: "2026-10-05T08:00:00Z", session_at: "2026-10-12T08:00:00Z"}\nrelated_paths: [CS101/member.md, CS101/prompt.md]',
    "lead-module.md": 'type: modules\ncanvas_id: "22"\ndates: {session_at: "2026-10-12T08:00:00Z"}',
    "member.md": "type: files",
    "lead-member.md": 'type: files\nmodule_canvas_id: "22"',
    "prompt.md": 'type: assignments\ndates: {due_at: "2026-10-09T08:00:00Z"}',
    "due.md": 'type: files\ndates: {due_at: "2026-10-09T08:00:00Z"}',
    "late.md": 'type: files\ndates: {created_at: "2026-10-06T08:00:00Z"}',
    "bulk.md": 'type: files\ndates: {created_at: "2026-09-01T08:00:00Z"}',
    "future.md": 'type: files\nmodule_canvas_id: "11"\nunlock_at: "2026-10-12T08:00:00Z"',
    "invalid.md": 'type: files\nmodule_canvas_id: "11"\nunlock_at: not-a-date',
    "unknown.md": "type: files",
    "explicit.md": 'type: files\navailable_at: "2026-10-05"',
    "restricted.md": 'type: files\nredistribution: restricted\ndates: {due_at: "2026-10-09"}',
  }
  for (const [name, metadata] of Object.entries(documents))
    await writeFile(
      join(vault, "CS101", name),
      `---\n${metadata}\n---\n# Synthetic source\nSubstantive synthetic framework evidence for ${name}, not student coursework.`,
    )
  return vault
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex")
async function rehash(path: string, value: Record<string, unknown>) {
  const { hash: _prior, ...base } = value
  value.hash = sha(JSON.stringify(base))
  await writeFile(path, JSON.stringify(value))
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("versioned structural replay visibility", () => {
  it("runs compiled capture, inferred-source task completion, comparison and M1 with human verdicts pending", async () => {
    const vault = await fixture()
    const config = join(vault, "config.json")
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
    const capture = cli(["simulate", "capture", "CS101", "--as-of", "2026-10-09"])
    expect(capture.visibilityRule).toBe("explicit-release-with-school-structural-fallback-v1")
    const task = cli([
      "simulate",
      "task",
      "create",
      capture.id,
      "--kind",
      "assignment",
      "--source",
      "CS101/prompt.md",
      "--mode",
      "outline",
    ])
    const shown = cli(["simulate", "task", "show", task.id])
    expect(
      shown.task.sources.some((source: { path: string }) => source.path === "CS101/member.md"),
    ).toBe(true)
    const candidate = join(vault, "candidate.md")
    await writeFile(
      candidate,
      [
        `Task: ${task.id}`,
        ...shown.task.requirements.map(
          (heading: string) =>
            `## ${heading}\n${heading === "Sources" ? "`CS101/prompt.md`" : "Synthetic structural fixture only, not academic work."}`,
        ),
      ].join("\n\n"),
    )
    cli(["simulate", "task", "complete", task.id, "--file", candidate])
    const comparison = cli(["simulate", "compare", "--course", "CS101", "--task", task.id])
    const evidence = JSON.parse(
      await readFile(
        join(vault, "_meta/simulation-comparisons", comparison.id, "evidence.json"),
        "utf8",
      ),
    )
    expect(evidence.visibility[0].inferredSourceCount).toBeGreaterThan(0)
    expect(evidence.visibility[0].historicalVisibilityVerified).toBe(false)
    const gate = cli(["gate", "m1", "--course", "CS101", "--comparison", comparison.id])
    expect(gate.verdict).toBe("pending-human")
    expect(gate.historicalVerified).toBe(false)
    evidence.visibility[0].inferredSourceCount += 1
    const evidenceText = JSON.stringify(evidence)
    await writeFile(
      join(vault, "_meta/simulation-comparisons", comparison.id, "evidence.json"),
      evidenceText,
    )
    await writeFile(
      join(vault, "_meta/simulation-comparisons", comparison.id, "integrity.json"),
      JSON.stringify({ version: 1, id: comparison.id, evidenceHash: sha(evidenceText) }),
    )
    const invalid = spawnSync(
      process.execPath,
      [
        resolve("dist/cli.js"),
        "gate",
        "m1",
        "--course",
        "CS101",
        "--comparison",
        comparison.id,
        "--config",
        config,
        "--json",
      ],
      { encoding: "utf8" },
    )
    expect(invalid.status).not.toBe(0)
    expect(invalid.stderr).toContain("visibility evidence differs")
  })
  it("uses exact module membership, seven-day lead, due and post-setup creation without overriding explicit future/invalid dates or policy", async () => {
    const vault = await fixture()
    const capture = await captureSimulation(vault, "CS101", "2026-10-09")
    const replay = await replaySimulation(vault, capture.id)
    expect(replay.visibilityRule).toBe("explicit-release-with-school-structural-fallback-v1")
    const signal = (name: string) =>
      replay.sources.find((source) => source.path === `CS101/${name}`)?.availabilitySignals
    expect(signal("member.md")).toEqual([{ field: "school.module_release", value: "2026-10-05" }])
    expect(signal("lead-member.md")).toEqual([
      { field: "school.module_release", value: "2026-10-05" },
    ])
    expect(signal("due.md")).toEqual([{ field: "school.due_at", value: "2026-10-09" }])
    expect(signal("late.md")).toEqual([{ field: "school.created_at", value: "2026-10-06" }])
    for (const name of ["bulk.md", "future.md", "invalid.md", "unknown.md", "restricted.md"])
      expect(signal(name)).toBeUndefined()
    const task = await createSimulationTask(vault, capture.id, {
      kind: "assignment",
      source: "CS101/prompt.md",
      mode: "outline",
    })
    expect(
      (await readSimulationTask(vault, task.id)).task.sources.some(
        (source) => source.path === "CS101/member.md",
      ),
    ).toBe(true)
    expect(JSON.stringify(replay)).not.toContain("for restricted.md")
  })

  it("derives earlier views using only captured metadata and rejects rehashed inventory or signal substitution", async () => {
    const vault = await fixture()
    const parent = await captureSimulation(vault, "CS101", "2026-10-09")
    const parentBytes = await readFile(join(vault, parent.path))
    await writeFile(join(vault, "CS101/module.md"), "Changed live module must not change replay.")
    const child = await deriveSimulationCapture(vault, parent.id, "2026-10-05")
    const replay = await replaySimulation(vault, child.id)
    expect(replay.sources.some((source) => source.path === "CS101/member.md")).toBe(true)
    expect(
      replay.sources.some(
        (source) => source.path === "CS101/due.md" || source.path === "CS101/late.md",
      ),
    ).toBe(false)
    expect(await readFile(join(vault, parent.path))).toEqual(parentBytes)
    const path = join(vault, child.path)
    const original = JSON.parse(await readFile(path, "utf8"))
    for (const mutation of ["signal", "relabel", "scope", "parent-inventory"]) {
      const value = structuredClone(original)
      if (mutation === "signal")
        value.sources.find((source: { path: string }) =>
          source.path.endsWith("member.md"),
        ).availabilitySignals[0].value = "2026-10-04"
      if (mutation === "relabel")
        value.sources.find((source: { path: string }) =>
          source.path.endsWith("member.md"),
        ).availabilitySignals[0].field = "available_at"
      if (mutation === "scope") value.visibility.documents[0].path = "OTHER101/secret.md"
      if (mutation === "parent-inventory")
        value.visibility.documents.find((source: { path: string }) =>
          source.path.endsWith("bulk.md"),
        ).dates.created_at = "2026-09-02"
      await rehash(path, value)
      await expect(replaySimulation(vault, child.id)).rejects.toThrow(/visibility|original frozen/)
    }
  })

  it("keeps unflagged captures explicit-only without reading current metadata or rewriting bytes", async () => {
    const vault = await fixture()
    const capture = await captureSimulation(vault, "CS101", "2026-10-09")
    const path = join(vault, capture.path)
    const value = JSON.parse(await readFile(path, "utf8"))
    delete value.visibility
    value.sources = value.sources.filter(
      (source: { availabilitySignals: { field: string }[] }) =>
        !source.availabilitySignals.some((signal) => signal.field.startsWith("school.")),
    )
    await rehash(path, value)
    const before = await readFile(path)
    const replay = await replaySimulation(vault, capture.id)
    expect(replay.visibilityRule).toBe("explicit-release-only-legacy")
    expect(replay.sources.some((source) => source.path.endsWith("due.md"))).toBe(false)
    const derived = await deriveSimulationCapture(vault, capture.id, "2026-10-05")
    expect((await replaySimulation(vault, derived.id)).visibilityRule).toBe(
      "explicit-release-only-legacy",
    )
    expect(await readFile(path)).toEqual(before)
  })

  it("refuses ambiguous structural membership rather than choosing an earlier module", async () => {
    const vault = await fixture()
    await writeFile(
      join(vault, "CS101/competing.md"),
      '---\ntype: modules\ncanvas_id: "33"\nunlock_at: "2026-10-01"\nrelated_paths: [CS101/member.md]\n---\nSynthetic competing module.',
    )
    await expect(captureSimulation(vault, "CS101", "2026-10-09")).rejects.toThrow(
      /membership is ambiguous/,
    )
  })
})
