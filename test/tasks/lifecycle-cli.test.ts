import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"

it("recreates revisions for changed student edits through the compiled CLI without changing prior artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvas-revision-cli-"))
  try {
    const vault = join(root, "vault"),
      config = join(root, "config.json")
    const command = (args: string[]) => {
      const result = spawnSync(
        process.execPath,
        [resolve("dist/cli.js"), ...args, "--config", config, "--json"],
        { encoding: "utf8" },
      )
      expect(result.status, result.stderr).toBe(0)
      return JSON.parse(result.stdout)
    }
    command(["init", "--vault", vault, "--canvas-url", "https://canvas.example.test"])
    const prompt = "CS101/Assignments/Case/prompt.md"
    await mkdir(join(vault, "CS101/Assignments/Case"), { recursive: true })
    await writeFile(
      join(vault, prompt),
      "---\ntype: assignment\n---\nExplain the supplied synthetic framework.",
    )
    const draft = command(["assignment", "CS101", "--source", prompt, "--mode", "draft"])
    const shown = command(["task", "show", draft.id])
    const candidate = join(root, "candidate.md")
    await writeFile(
      candidate,
      [
        `Task: ${draft.id}`,
        ...shown.requirements.map(
          (heading: string) =>
            `## ${heading}\n\n${heading === "Sources" ? `\`${prompt}\`` : "Synthetic structural test, not academic work."}`,
        ),
        "### Synthetic cash schedule\n| Label | Value |\n| --- | --- |\n| Cash | $1,200 |",
      ].join("\n\n"),
    )
    const completed = command(["task", "complete", draft.id, "--file", candidate])
    expect(completed.task.workbook).toBeUndefined()
    expect(command(["task", "show", draft.id]).hostExecutionVersion).toBe(1)
    const original = await readFile(join(vault, completed.output))
    const homework = command(["homework", "--course", "CS101"])
    expect(homework.undated[0]).toMatchObject({
      draftVersion: 1,
      draftBinding: "task-metadata",
      draftContentsVerified: false,
      draftPaths: [completed.output],
    })
    expect(homework.unreadableTaskRecords).toBe(0)
    const saved = command(["task", "show", draft.id])
    expect(saved.workbook).toBeUndefined()
    const comparison = command(["compare", draft.id, draft.id])
    expect(comparison.automaticWorkbooks).toMatchObject({
      change: "unknown",
      before: { state: "harness-owned", workbook: null },
    })
    const gate = command(["gate", "review", draft.id])
    expect(gate.automaticWorkbook).toMatchObject({ state: "harness-owned", workbook: null })
    // ZIP directory timestamps used to drift across two-second DOS time ticks.
    await new Promise((resolve) => setTimeout(resolve, 2200))
    expect(command(["task", "complete", draft.id, "--file", candidate]).output).toBe(
      completed.output,
    )
    const approved = command(["approve", draft.id])
    expect(approved.workbook).toBeUndefined()
    const edits = "CS101/Assignments/Case/Drafts/student-edits.md"
    await writeFile(join(vault, edits), "Student first edit.")
    const args = ["revise", draft.id, "--feedback", "Incorporate my edits.", "--work", edits]
    const first = command(args)
    expect(command(args).id).toBe(first.id)
    const firstRecord = await readFile(join(vault, "_meta/tasks", first.id, "task.json"))
    await writeFile(join(vault, edits), "Student second edit, including a changed conclusion.")
    const second = command(args)
    expect(second.id).not.toBe(first.id)
    const task = command(["task", "show", second.id])
    expect(task.revisionEdits).toMatchObject({
      version: 1,
      work: edits,
      beforeHash: saved.outputHash,
    })
    expect(task.revisionEdits.diff).toContain(
      "+Student second edit, including a changed conclusion.",
    )
    expect(task.sources.find((source: { path: string }) => source.path === edits)?.text).toContain(
      "second edit",
    )
    expect(task.sources.some((source: { path: string }) => source.path === completed.output)).toBe(
      true,
    )
    expect(command(args).id).toBe(second.id)
    expect(await readFile(join(vault, "_meta/tasks", first.id, "task.json"))).toEqual(firstRecord)
    expect(await readFile(join(vault, completed.output))).toEqual(original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)
