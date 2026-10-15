import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, it } from "vitest"

it("resumes a killed completion between Markdown and workbook commits without allocating a new version", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvas-completion-kill-"))
  const vault = join(root, "vault"),
    config = join(root, "config.json")
  const env = { PATH: process.env.PATH, HOME: root }
  const cli = (args: string[]) =>
    spawnSync(process.execPath, [resolve("dist/cli.js"), ...args, "--config", config, "--json"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 30_000,
    })
  const command = (args: string[]) => {
    const result = cli(args)
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  }
  try {
    command(["init", "--vault", vault, "--canvas-url", "https://canvas.example.test"])
    const prompt = "CS101/Assignments/Case/prompt.md"
    await mkdir(join(vault, "CS101/Assignments/Case"), { recursive: true })
    await writeFile(
      join(vault, prompt),
      "---\ntype: assignment\n---\nExplain the synthetic framework.",
    )
    const sourceBefore = await readFile(join(vault, prompt))
    const task = command(["assignment", "CS101", "--source", prompt, "--mode", "draft"])
    const shown = command(["task", "show", task.id])
    const recordPath = join(vault, "_meta/tasks", task.id, "task.json")
    const recordBefore = await readFile(recordPath)
    const destination = join(vault, shown.destination)
    await mkdir(destination, { recursive: true })
    const studentPath = join(destination, "01 Assignment Draft.md")
    await writeFile(studentPath, "Student-owned earlier draft; do not replace.\n")
    const studentBefore = await readFile(studentPath)
    const candidate = join(root, "candidate.md")
    const body = [
      `Task: ${task.id}`,
      ...shown.requirements.map(
        (heading: string) =>
          `## ${heading}\n\n${heading === "Sources" ? `\`${prompt}\`` : "Synthetic crash recovery, not academic acceptance."}`,
      ),
      "### Synthetic schedule\n| Label | Value |\n| --- | --- |\n| Cash | $1,200 |",
    ].join("\n\n")
    await writeFile(candidate, body)
    // Intercept the real compiled writer only in this worker. Pause after its
    // durable Markdown hard link, before workbook/task-record writes.
    const program = `
      import fs from "node:fs/promises";
      import {syncBuiltinESMExports} from "node:module";
      const link=fs.link;
      fs.link=async(from,to)=>{
        await link(from,to);
        if(String(to).endsWith(".md")) {
          setInterval(()=>{},1000);
          process.send({output:String(to)});
          await new Promise(()=>{});
        }
      };
      syncBuiltinESMExports();
      const {completeTask}=await import(${JSON.stringify(pathToFileURL(resolve("dist/tasks/completion.js")).href)});
      await completeTask(process.argv[1],process.argv[2],process.argv[3]);
    `
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", program, vault, task.id, candidate],
      { cwd: root, env, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    )
    const exited = once(child, "exit")
    let output: string
    try {
      output = await new Promise<string>((done, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Completion did not reach Markdown checkpoint")),
          10_000,
        )
        child.once("message", (message) => {
          clearTimeout(timeout)
          done((message as { output: string }).output)
        })
        child.once("error", (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        child.once("exit", () => {
          clearTimeout(timeout)
          reject(new Error("Worker exited before checkpoint"))
        })
      })
    } finally {
      child.kill("SIGKILL")
      expect((await exited)[1]).toBe("SIGKILL")
    }
    expect(await readFile(recordPath)).toEqual(recordBefore)
    const outputBefore = await readFile(output)
    expect(outputBefore.toString()).toBe(body)
    const markerPath = join(vault, "_meta/tasks", task.id, "completion.transaction.json")
    const markerBefore = await readFile(markerPath)
    const marker = JSON.parse(markerBefore.toString())
    expect(command(["task", "show", task.id]).status).toBe("pending")
    const conflicting = join(root, "conflicting.md")
    await writeFile(conflicting, `${body}\nDifferent content.\n`)
    expect(cli(["task", "complete", task.id, "--file", conflicting]).status).not.toBe(0)
    expect(await readFile(markerPath)).toEqual(markerBefore)
    expect(await readFile(output)).toEqual(outputBefore)
    const completed = command(["task", "complete", task.id, "--file", candidate])
    expect(completed.output).toBe(marker.output)
    expect(completed.task.status).toBe("completed")
    const workbookBefore = await readFile(join(vault, completed.task.workbook.path))
    expect(workbookBefore.length).toBeGreaterThan(0)
    const completedRecord = await readFile(recordPath)
    expect(command(["task", "complete", task.id, "--file", candidate]).output).toBe(marker.output)
    expect(await readFile(recordPath)).toEqual(completedRecord)
    expect(await readFile(join(vault, completed.task.workbook.path))).toEqual(workbookBefore)
    expect(await readFile(output)).toEqual(outputBefore)
    expect(await readFile(studentPath)).toEqual(studentBefore)
    expect(await readFile(join(vault, prompt))).toEqual(sourceBefore)
    expect((await readdir(destination)).filter((name) => name.endsWith(".md"))).toHaveLength(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
