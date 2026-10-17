import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
it("runs current dogfood flows through the checkout evaluation CLI with explicit generation, review and approval", async () => {
  const base = await mkdtemp(join(tmpdir(), "canvas-dogfood-cli-"))
  roots.push(base)
  const vault = join(base, "vault"),
    config = join(base, "agent.json")
  await mkdir(join(vault, "CS101/Week 01 - Oct 5"), { recursive: true })
  await mkdir(join(vault, "CS101/Assignments"))
  const source = "CS101/Week 01 - Oct 5/reading.md",
    prompt = "CS101/Assignments/prompt.md"
  await writeFile(
    join(vault, source),
    "Synthetic PRIVATE-READING-BODY with substantive framework evidence.",
  )
  await writeFile(
    join(vault, prompt),
    "---\ntype: assignment\n---\nExplain the supplied framework.",
  )
  const cli = (args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        resolve("tools/evaluation/run.ts"),
        ...args,
        "--config",
        config,
        "--json",
      ],
      {
        encoding: "utf8",
      },
    )
  const command = (args: string[]) => {
    const result = cli(args)
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  }
  command(["init", "--vault", vault, "--canvas-url", "https://canvas.example.test"])
  const mirror = join(base, "phone-reading-copy")
  command(["vault", "reading-copy", "--destination", mirror, "--current", "--apply"])
  let journal = command([
    "dogfood",
    "--course",
    "CS101",
    "--week",
    "2026-10-05",
    "--assignment",
    prompt,
    "--offline",
  ])
  const id = journal.id
  const discovery = command(["dogfood", "list", "--course", "CS101"])
  expect(discovery.inventoryComplete).toBe(true)
  expect(discovery.runs.map((run: { id: string }) => run.id)).toEqual([id])
  expect(discovery.runs[0].lastCheckpoint.status).toBe("pending-host")
  expect(JSON.stringify(discovery)).not.toContain("PRIVATE-READING-BODY")
  expect(command(["dogfood", "--course", "CS101", "list"])).toEqual(discovery)
  expect(cli(["dogfood", "list"]).status).toBe(1)
  expect(journal.complete).toBe(false)
  expect(journal.flows.at(-1).status).toBe("pending-host")
  expect(JSON.stringify(journal)).not.toContain("PRIVATE-READING-BODY")
  const resume = ["dogfood", "resume", id, "--course", "CS101", "--offline"]
  const checkpoints = join(vault, "_meta/dogfood", id)
  const before = await readdir(checkpoints)
  for (const extra of [
    ["--verdict", `${journal.flows.at(-1).data.taskId}=pass`],
    ["--verdict", "00000000-0000-4000-8000-000000000000=pass"],
    ["--approve-task", journal.flows.at(-1).data.taskId],
  ]) {
    expect(cli([...resume, ...extra]).status).toBe(1)
    expect(await readdir(checkpoints)).toEqual(before)
  }
  for (let attempt = 0; attempt < 20 && !journal.complete; attempt++) {
    const last = journal.flows.at(-1),
      taskId = last.data.taskId
    expect(taskId).toBeTruthy()
    let decisions: string[] = []
    if (last.status === "pending-host") {
      const task = command(["task", "show", taskId])
      const file = join(base, "candidate.md")
      await writeFile(
        file,
        [
          `Task: ${taskId}`,
          ...task.requirements.map(
            (heading: string) =>
              `## ${heading}\n\n${heading === "Student question" ? `> ${task.discussion.message}` : heading === "Sources" ? task.sources.map((entry: { path: string }) => `\`${entry.path}\``).join("\n") : "Synthetic structural fixture only, not academic coursework."}`,
          ),
        ].join("\n\n"),
      )
      command(["task", "complete", taskId, "--file", file])
    } else if (last.name === "approve") {
      await expect(readdir(join(vault, "CS101/Assignments/Finals"))).rejects.toThrow()
      decisions = ["--approve-task", taskId]
    } else decisions = ["--verdict", `${taskId}=pass`]
    journal = command([...resume, ...decisions])
  }
  expect(journal.complete).toBe(true)
  expect(journal.passed).toBe(8)
  expect(journal.skipped).toBe(1)
  expect(command(["dogfood", "show", id, "--course", "CS101"])).toEqual(journal)
  expect(command(resume)).toEqual(journal)
  const mirroredFinal = join(mirror, "Current", `${journal.flows[6].data.output}.txt`)
  const copiedFinal = await readFile(mirroredFinal, "utf8")
  expect(copiedFinal).toContain("Synthetic structural fixture")
  expect(await readFile(join(vault, source), "utf8")).toContain("PRIVATE-READING-BODY")
  await writeFile(join(vault, journal.flows[6].data.output), "Changed Final.")
  const failed = cli(resume)
  expect(failed.status).toBe(1)
  expect(JSON.parse(failed.stdout)).toMatchObject({ complete: false, failed: true })
  expect(await readFile(join(vault, journal.flows[6].data.output), "utf8")).toBe("Changed Final.")
  expect(await readFile(mirroredFinal, "utf8")).toBe(copiedFinal)
  expect(cli(["dogfood", "show", "../outside", "--course", "CS101"]).status).toBe(1)
  expect(cli(["dogfood", "show", id, "--course", "OTHER101"]).status).toBe(1)
  expect(cli(["dogfood", "show", id]).status).toBe(1)
  expect(cli(["dogfood", "resume", id, "--offline"]).status).toBe(1)
}, 30_000)
