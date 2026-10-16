import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  CONTEXT_CORE_BUDGET_BYTES,
  CONTEXT_ENTRY_BUDGET_BYTES,
  CONTEXT_SKILL_BUDGET_BYTES,
  syncContext,
  WORKFLOW_REFERENCE,
  workflowBlock,
  workflowReference,
} from "../../scripts/sync-context.mjs"

const source = "plugins/canvas-agent/references/cli.md"
const targets = [
  "AGENTS.md",
  "plugins/canvas-agent/skills/canvas-workspace/SKILL.md",
  "plugins/canvas-agent/skills/assignment-workflow/SKILL.md",
  "plugins/canvas-agent/skills/setup-and-sync/SKILL.md",
]
const start = "<!-- canvas-agent-cli:start -->"
const end = "<!-- canvas-agent-cli:end -->"
const canonical = `${start}\nShared contract\n${end}`
const workflowTargets: Record<string, string[]> = {
  "AGENTS.md": ["prep", "outline", "draft", "review", "discuss"],
  "plugins/canvas-agent/skills/canvas-workspace/SKILL.md": ["prep"],
  "plugins/canvas-agent/skills/assignment-workflow/SKILL.md": [
    "outline",
    "draft",
    "review",
    "discuss",
  ],
}
const temporary: string[] = []

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "canvas-context-"))
  temporary.push(root)
  for (const file of [source, ...targets]) {
    await mkdir(dirname(resolve(root, file)), { recursive: true })
    await writeFile(
      resolve(root, file),
      `Before ${file}\n${canonical}\n${(workflowTargets[file] ?? []).map(workflowBlock).join("\n")}\nAfter ${file}\n`,
    )
  }
  await writeFile(resolve(root, WORKFLOW_REFERENCE), workflowReference())
  return root
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("shared agent CLI context", () => {
  it("does not copy detailed reference bodies into entrypoints", async () => {
    const root = await fixture()
    await writeFile(
      resolve(root, source),
      `${canonical}\n## Detailed reference\n${"x".repeat(100_000)}`,
    )
    expect(await syncContext(root)).toEqual([])
    expect(await readFile(resolve(root, targets[0]), "utf8")).not.toContain("x".repeat(100))
  })

  it("warns about a large shared core while synchronizing it without truncation", async () => {
    const root = await fixture()
    const core = `${start}\n${"x".repeat(CONTEXT_CORE_BUDGET_BYTES)}\n${end}`
    await writeFile(resolve(root, source), core)
    const warnings: string[] = []
    await syncContext(root, true, (warning: string) => warnings.push(warning))
    expect(warnings.some((warning) => warning.startsWith("Shared CLI core"))).toBe(true)
    for (const target of targets)
      expect(await readFile(resolve(root, target), "utf8")).toContain(core)
    expect(await syncContext(root, false, () => {})).toEqual([])
  })

  it("warns about a large skill without blocking repairs or changing surrounding content", async () => {
    const root = await fixture()
    const stalePath = resolve(root, targets[1])
    await writeFile(
      stalePath,
      (await readFile(stalePath, "utf8")).replace("Shared contract", "Stale contract"),
    )
    const largePath = resolve(root, targets[2])
    const large = `${"x".repeat(CONTEXT_SKILL_BUDGET_BYTES)}\n${await readFile(largePath, "utf8")}`
    await writeFile(largePath, large)
    const warnings: string[] = []
    expect(await syncContext(root, true, (warning: string) => warnings.push(warning))).toEqual([
      targets[1],
    ])
    expect(warnings.some((warning) => warning.includes(targets[2]))).toBe(true)
    expect(await readFile(largePath, "utf8")).toBe(large)
    expect(await readFile(stalePath, "utf8")).toContain(canonical)
  })

  it("detects full workflow reference drift and repairs only that generated reference", async () => {
    const root = await fixture()
    const path = resolve(root, WORKFLOW_REFERENCE)
    const before = await Promise.all(targets.map((file) => readFile(resolve(root, file))))
    await writeFile(path, "Stale defaults must not override a saved task")
    await expect(syncContext(root)).rejects.toThrow("CLI context drift")
    expect(await readFile(path, "utf8")).toBe("Stale defaults must not override a saved task")
    expect(await syncContext(root, true)).toEqual([WORKFLOW_REFERENCE])
    expect(await readFile(path, "utf8")).toBe(workflowReference())
    expect(await Promise.all(targets.map((file) => readFile(resolve(root, file))))).toEqual(before)
  })

  it("warns about large surrounding instructions and retains a separate hard file bound", async () => {
    const root = await fixture()
    const path = resolve(root, targets[0])
    const original = await readFile(path, "utf8")
    const large = `${"x".repeat(CONTEXT_ENTRY_BUDGET_BYTES)}\n${original}`
    await writeFile(path, large)
    const warnings: string[] = []
    expect(await syncContext(root, false, (warning: string) => warnings.push(warning))).toEqual([])
    expect(warnings.some((warning) => warning.includes("AGENTS.md"))).toBe(true)
    expect(await readFile(path, "utf8")).toBe(large)
    const stalePath = resolve(root, targets[1])
    const stale = (await readFile(stalePath, "utf8")).replace("Shared contract", "Stale contract")
    await writeFile(stalePath, stale)
    await writeFile(path, "x".repeat(1024 * 1024 + 1))
    await expect(syncContext(root, true)).rejects.toThrow(/bounds/)
    expect(await readFile(stalePath, "utf8")).toBe(stale)
  })
  it("keeps all repository entry points identical to the authoritative reference", async () => {
    expect(await syncContext(resolve("."))).toEqual([])
  })

  it("detects drift without mutating instructions", async () => {
    const root = await fixture()
    const file = resolve(root, targets[0])
    const changed = (await readFile(file, "utf8")).replace("Shared contract", "Different commands")
    await writeFile(file, changed)
    await expect(syncContext(root)).rejects.toThrow("CLI context drift: AGENTS.md")
    expect(await readFile(file, "utf8")).toBe(changed)
  })

  it("repairs only the shared block and is idempotent", async () => {
    const root = await fixture()
    const file = resolve(root, targets[1])
    const original = await readFile(file, "utf8")
    await writeFile(file, original.replace("Shared contract", "Stale contract"))
    expect(await syncContext(root, true)).toEqual([targets[1]])
    expect(await readFile(file, "utf8")).toBe(original)
    expect(await syncContext(root, true)).toEqual([])
  })

  it.each([
    "Missing markers",
    `${end}\n${start}`,
    `${canonical}\n${start}`,
    `${canonical}\n${end}`,
  ])("rejects malformed blocks before repairing other documents: %s", async (malformed) => {
    const root = await fixture()
    const stale = resolve(root, targets[0])
    await writeFile(stale, canonical.replace("Shared contract", "Stale contract"))
    await writeFile(resolve(root, targets[2]), malformed)
    await expect(syncContext(root, true)).rejects.toThrow("exactly one ordered")
    expect(await readFile(stale, "utf8")).toContain("Stale contract")
  })

  it("rejects a malformed authoritative source without writing targets", async () => {
    const root = await fixture()
    await writeFile(resolve(root, source), "No shared contract")
    await expect(syncContext(root, true)).rejects.toThrow(source)
    expect(await readFile(resolve(root, targets[0]), "utf8")).toContain(canonical)
  })

  it("detects and repairs academic workflow drift without changing surrounding instructions", async () => {
    const root = await fixture()
    const file = resolve(root, targets[2])
    const original = await readFile(file, "utf8")
    await writeFile(
      file,
      original.replace(
        workflowBlock("draft"),
        "<!-- canvas-agent-workflow:draft:start -->\nInvent results\n<!-- canvas-agent-workflow:draft:end -->",
      ),
    )
    await expect(syncContext(root)).rejects.toThrow("academic workflow")
    expect(await syncContext(root, true)).toEqual([targets[2]])
    expect(await readFile(file, "utf8")).toBe(original)
  })
})
