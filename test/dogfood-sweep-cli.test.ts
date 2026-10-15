import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
it("runs two scoped teaching sessions, refreshes aggregate states and continues after one child fails", async () => {
  const base = await mkdtemp(join(tmpdir(), "canvas-sweep-cli-"))
  roots.push(base)
  const vault = join(base, "vault"),
    config = join(base, "config.json")
  await mkdir(join(vault, "CS101/Modules"), { recursive: true })
  await mkdir(join(vault, "CS101/Assignments"))
  await writeFile(
    join(vault, "CS101/Assignments/prompt.md"),
    "---\ntype: assignment\n---\nSynthetic assignment.",
  )
  for (const number of [1, 2])
    await writeFile(
      join(vault, `CS101/Modules/session${number}.md`),
      `---\ntype: module\ncanvas_id: '${100 * number}'\ntitle: Session ${number} - Synthetic topic\n${number === 1 ? "related_paths: [CS101/Assignments/prompt.md]\n" : ""}---\nPRIVATE-SWEEP-BODY substantive teaching material.\n`,
    )
  const cli = (args: string[]) =>
    spawnSync(process.execPath, [resolve("dist/cli.js"), ...args, "--config", config, "--json"], {
      encoding: "utf8",
    })
  const command = (args: string[]) => {
    const result = cli(args)
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  }
  command(["init", "--vault", vault, "--canvas-url", "https://canvas.example.test"])
  for (const count of ["0", "2x", "101"])
    expect(cli(["dogfood", "--course", "CS101", "--sessions", count, "--offline"]).status).toBe(1)
  expect(
    cli(["dogfood", "--course", "CS101", "--sessions", "2", "--week", "2026-10-05", "--offline"])
      .status,
  ).toBe(1)
  await expect(readdir(join(vault, "_meta/dogfood-sweeps"))).rejects.toThrow()
  const started = command(["dogfood", "--course", "CS101", "--sessions", "2", "--offline"])
  expect(started).toMatchObject({ complete: false, failed: false, evidenceRevalidated: true })
  expect(started.sessions.map((session: { state: string }) => session.state)).toEqual([
    "pending-host",
    "pending-host",
  ])
  expect(started.sessions[0].assignment).toBe("CS101/Assignments/prompt.md")
  expect(started.sessions[1].assignment).toBeNull()
  expect(JSON.stringify(started)).not.toContain("PRIVATE-SWEEP-BODY")
  const manifestPath = join(vault, "_meta/dogfood-sweeps", started.id, "manifest.json")
  const manifestBefore = await readFile(manifestPath)
  const inventory = command(["dogfood", "sweep", "list", "--course", "CS101"])
  expect(inventory).toMatchObject({ inventoryComplete: true, unreadableRecords: 0 })
  expect(inventory.sweeps).toEqual([
    {
      id: started.id,
      createdAt: JSON.parse(JSON.parse(manifestBefore.toString()).payload).createdAt,
      sessionCount: 2,
      runIds: started.sessions.map((session: { runId: string }) => session.runId),
    },
  ])
  expect(command(["dogfood", "--course", "CS101", "sweep", "list"])).toEqual(inventory)
  expect(JSON.stringify(inventory)).not.toContain("PRIVATE-SWEEP-BODY")
  expect(JSON.stringify(inventory)).not.toContain("nextSteps")
  expect(await readFile(manifestPath)).toEqual(manifestBefore)
  expect(cli(["dogfood", "sweep", "list"]).status).toBe(1)
  expect(JSON.parse(await readFile(join(vault, started.report), "utf8")).sessions).toHaveLength(2)
  const shown = command(["dogfood", "sweep", "show", started.id, "--course", "CS101"])
  expect(shown.evidenceRevalidated).toBe(false)
  expect(shown.sessions.map((session: { runId: string }) => session.runId)).toEqual(
    started.sessions.map((session: { runId: string }) => session.runId),
  )
  const second = started.sessions[1],
    task = command(["task", "show", second.activeTaskId])
  const file = join(base, "candidate.md")
  await writeFile(
    file,
    [
      `Task: ${task.id}`,
      ...task.requirements.map(
        (heading: string) =>
          `## ${heading}\n\n${heading === "Sources" ? task.sources.map((entry: { path: string }) => `\`${entry.path}\``).join("\n") : "Synthetic structural test only."}`,
      ),
    ].join("\n\n"),
  )
  command(["task", "complete", task.id, "--file", file])
  const reviewed = command([
    "dogfood",
    "resume",
    second.runId,
    "--course",
    "CS101",
    "--offline",
    "--verdict",
    `${task.id}=pass`,
  ])
  expect(reviewed.complete).toBe(true)
  const broken = join(vault, "_meta/tasks", started.sessions[0].activeTaskId, "task.json")
  const record = JSON.parse(await readFile(broken, "utf8"))
  record.id = "invalid-identity"
  await writeFile(broken, JSON.stringify(record))
  const result = cli(["dogfood", "sweep", "resume", started.id, "--course", "CS101", "--offline"])
  expect(result.status).toBe(1)
  const aggregate = JSON.parse(result.stdout)
  expect(aggregate).toMatchObject({ failed: true, complete: false, evidenceRevalidated: false })
  expect(aggregate.sessions[0].state).toBe("fail")
  expect(aggregate.sessions[1].recordedComplete).toBe(true)
  expect(aggregate.report).not.toBe(started.report)
  expect(JSON.parse(await readFile(join(vault, aggregate.report), "utf8")).failed).toBe(true)
  expect(await readdir(join(vault, "_meta/dogfood"))).toHaveLength(2)
  expect(await readFile(join(vault, "CS101/Modules/session1.md"), "utf8")).toContain(
    "PRIVATE-SWEEP-BODY",
  )
  expect(cli(["dogfood", "sweep", "show", "../outside", "--course", "CS101"]).status).toBe(1)
  expect(cli(["dogfood", "sweep", "resume", started.id, "--offline"]).status).toBe(1)
}, 30_000)
