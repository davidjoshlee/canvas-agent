import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { syncContext, workflowBlock } from "../scripts/sync-context.mjs"

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
  "AGENTS.md": ["prep", "outline", "draft", "review"],
  "plugins/canvas-agent/skills/canvas-workspace/SKILL.md": ["prep"],
  "plugins/canvas-agent/skills/assignment-workflow/SKILL.md": ["outline", "draft", "review"],
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
  return root
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("shared agent CLI context", () => {
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
