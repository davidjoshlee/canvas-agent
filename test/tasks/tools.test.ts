import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ToolkitConfig } from "../../src/shared/types.js"
import { compareTasks, inspectTask } from "../../src/tasks/artifacts/inspection.js"
import { createPrepTask, readTask } from "../../src/tasks/store.js"
import { reviewGate } from "../../src/tasks/tools.js"

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-tools-"))
  roots.push(root)
  const course = join(root, "ACCT312", "Week 42")
  await mkdir(course, { recursive: true })
  await writeFile(
    join(course, "Reading.md"),
    "---\ndates:\n  date: 2026-10-12\n---\n# Reading\nApproved evidence.\n",
  )
  const config: ToolkitConfig = {
    version: 1,
    canvas: { baseUrl: "https://canvas.example", tokenEnv: "UNUSED" },
    vault: { path: root },
    courses: { allowlist: [] },
  }
  return { root, config }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("task tools", () => {
  it("inspects provenance and compares source and completed-output changes", async () => {
    const { root, config } = await fixture()
    const first = await createPrepTask(root, "ACCT312", "2026-10-12")
    const second = await createPrepTask(root, "ACCT312", "2026-10-12")
    expect(await inspectTask(root, first.id)).toMatchObject({
      id: first.id,
      snapshots: { current: true },
    })
    expect((await compareTasks(root, first.id, second.id)).sourceChanges).toEqual([])
    const candidate = join(root, "candidate.md")
    const draft = (id: string, body: string) =>
      `Task: ${id}\n\n${first.requirements.map((heading) => `## ${heading}\n\n${heading === "Sources" ? `- \`${first.sources[0]?.path}\`` : body}`).join("\n")}`
    await writeFile(candidate, draft(first.id, "One version."))
    const { completeTask } = await import("../../src/tasks/artifacts/completion.js")
    await completeTask(root, first.id, candidate)
    await writeFile(candidate, draft(second.id, "Another version."))
    await completeTask(root, second.id, candidate)
    const comparison = await compareTasks(root, first.id, second.id)
    expect(comparison.outputDiff.available).toBe(true)
    expect(comparison.outputDiff.added).toBeGreaterThan(0)
    expect(comparison.outputDiff.removed).toBeGreaterThan(0)
    const gate = await reviewGate(config, first.id)
    expect(gate.sections.every((item) => item.present)).toBe(true)
    expect(await readFile(join(root, gate.path), "utf8")).toContain(
      "does not assess factual accuracy",
    )
    const completedFirst = await readTask(root, first.id)
    const savedOutput = join(root, completedFirst.output as string)
    const external = join(root, "outside-output.md")
    await writeFile(external, "same bytes")
    await unlink(savedOutput)
    await symlink(external, savedOutput)
    await expect(compareTasks(root, first.id, first.id)).rejects.toThrow("Symbolic links")
  })

  it("audits extracted originals up to the document ingestion size bound", async () => {
    const { root } = await fixture()
    const original = Buffer.alloc(6 * 1024 * 1024, 0x61)
    const originalPath = "ACCT312/Week 42 - Oct 12/large.pdf"
    await mkdir(join(root, "ACCT312", "Week 42 - Oct 12"), { recursive: true })
    await writeFile(join(root, originalPath), original)
    const originalHash = createHash("sha256").update(original).digest("hex")
    await writeFile(
      join(root, `${originalPath}.extracted.md`),
      `---\noriginal_path: ${originalPath}\noriginal_hash: ${originalHash}\n---\n\nExtracted readable text.\n`,
    )
    const task = await createPrepTask(root, "ACCT312", "2026-10-12")
    expect(task.sources.some((source) => source.originalPath === originalPath)).toBe(true)
    expect((await inspectTask(root, task.id)).snapshots.current).toBe(true)
  })
})
