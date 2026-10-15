import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const roots: string[] = []
const tokenEnv = "CANVAS_AGENT_FRESH_STUDENT_FIXTURE_TOKEN"

async function temp() {
  const root = await mkdtemp(join(tmpdir(), "canvas-agent-new-student-"))
  roots.push(root)
  return root
}

function cli(args: string[]) {
  const env = { ...process.env }
  delete env[tokenEnv]
  const result = spawnSync(process.execPath, [resolve("dist/cli.js"), ...args], {
    encoding: "utf8",
    env,
  })
  if (result.error) throw result.error
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

function json<T extends object>(args: string[], config: string): T {
  const result = cli([...args, "--config", config, "--json"])
  expect(result.status, result.stderr).toBe(0)
  expect(result.stderr).toBe("")
  return JSON.parse(result.stdout) as T
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("compiled CLI fresh-student workflow", () => {
  it("sets up privately, reports offline readiness, inventories local work, and completes a custom session brief", async () => {
    const root = await temp()
    const config = join(root, "student", "canvas-agent.json")
    const vault = join(root, "student-vault")
    const setup = cli([
      "setup",
      "--config",
      config,
      "--canvas-url",
      "https://canvas.example.edu",
      "--vault",
      vault,
      "--token-env",
      tokenEnv,
      "--json",
    ])
    expect(setup.status, setup.stderr).toBe(0)
    expect(JSON.parse(setup.stdout)).toMatchObject({ vault, tokenEnv })
    expect(await readFile(join(root, "student", ".env"), "utf8")).toBe(`${tokenEnv}=\n`)

    const course = "MBA-101"
    const session = `${course}/Modules/Week 03 - Oct 12/Session 3.md`
    const reading = `${course}/Modules/Week 03 - Oct 12/reading.md`
    const questions = `${course}/Modules/Week 03 - Oct 12/prepquestions.md`
    await mkdir(join(vault, course, "Resources", "Guidance"), { recursive: true })
    await mkdir(join(vault, course, "Modules", "Week 03 - Oct 12"), { recursive: true })
    await mkdir(join(vault, course, "Assignments"), { recursive: true })
    await writeFile(
      join(vault, course, "Resources", "Guidance", "prep.md"),
      [
        "---",
        "ai_policy: allowed",
        "---",
        "## Brief structure",
        "- Decision frame",
        "- Evidence and tradeoffs",
        "- Preparation questions",
        "Follow the three-section brief structure exactly.",
        "",
      ].join("\n"),
    )
    await writeFile(
      join(vault, session),
      `---\nrelated_paths:\n  - ${reading}\n  - ${questions}\n---\nSession overview.\n`,
    )
    await writeFile(
      join(vault, reading),
      "# Reading\n\nThe supplied reading compares centralized and decentralized decisions. Centralization improves consistency and economies of scale, while decentralization uses local information and can respond faster.\n",
    )
    await writeFile(
      join(vault, questions),
      "# Preparation questions\n\n1. When should a firm decentralize a decision?\n",
    )
    const dueAt = new Date(Date.now() + 86_400_000).toISOString()
    await writeFile(
      join(vault, course, "Assignments", "Case.md"),
      `---\ndue_at: ${dueAt}\ncanvas_id: case-1\n---\n# Case\nA decision is due soon.\n`,
    )

    const envPath = join(root, "student", ".env")
    await writeFile(envPath, `${tokenEnv}=fixture-only-value\n`)
    const envProbe = cli(["auth", "status", "--config", config, "--json"])
    expect(envProbe.status, envProbe.stderr).toBe(0)
    expect(JSON.parse(envProbe.stdout)).toMatchObject({
      configured: true,
      tokenEnv,
      available: true,
    })
    expect(envProbe.stdout).not.toContain("fixture-only-value")
    await writeFile(envPath, `${tokenEnv}=\n`)

    const offline = json<{ ok: boolean; checks: Array<{ name: string; status: string }> }>(
      ["doctor", "--offline"],
      config,
    )
    expect(offline.ok).toBe(true)
    expect(offline.checks).toContainEqual(
      expect.objectContaining({ name: "token-env", status: "warning" }),
    )
    const syncOnly = cli(["doctor", "--sync-only", "--config", config, "--json"])
    expect(syncOnly.status).toBe(1)
    expect(JSON.parse(syncOnly.stdout).checks).toContainEqual(
      expect.objectContaining({ name: "token-env", status: "error" }),
    )
    expect(json<{ ok: boolean }>(["config", "validate"], config).ok).toBe(true)
    expect(json<{ canvas: { tokenEnv: string } }>(["config", "show"], config).canvas).toMatchObject(
      { tokenEnv },
    )

    expect(
      json<{ items: Array<{ title: string; canvasId: string }> }>(
        ["homework", "--days", "14"],
        config,
      ),
    ).toMatchObject({
      items: [expect.objectContaining({ title: "Case", canvasId: "case-1" })],
    })
    expect(json<{ items: unknown[] }>(["timeline", "--weeks", "4"], config).items).toHaveLength(1)

    const prep = json<{ id: string }>(["prep", course, "--session", "Session 3"], config)
    const taskId = prep.id as string
    const task = JSON.parse(
      await readFile(join(vault, "_meta", "tasks", taskId, "task.json"), "utf8"),
    ) as { requirements: string[]; questions: string[]; sources: Array<{ path: string }> }
    expect(task.requirements).toEqual([
      "Decision frame",
      "Evidence and tradeoffs",
      "Preparation questions",
      "Sources",
    ])
    expect(task.questions).toEqual(["When should a firm decentralize a decision?"])
    expect(task.sources.map((source) => source.path)).toContain(reading)
    expect(task.sources.map((source) => source.path)).toContain(questions)

    const candidate = join(root, "candidate.md")
    await writeFile(
      candidate,
      [
        `Task: ${taskId}`,
        "",
        "## Decision frame",
        "Use centralization when consistency and scale matter; use local authority when local information changes the best choice.",
        "",
        "## Evidence and tradeoffs",
        `The reading links centralized decisions to consistency and scale, and decentralization to local information and speed. \`${reading}\``,
        "",
        "## Preparation questions",
        "### When should a firm decentralize a decision?",
        `A firm should decentralize when local information is important and faster local responses outweigh the benefits of consistent centralized choices. \`${reading}\``,
        "",
        "## Sources",
        `- \`${reading}\``,
        `- \`${questions}\``,
        "",
      ].join("\n"),
    )
    const completed = json<{ task: { status: string; output: string } }>(
      ["task", "complete", taskId, "--file", candidate],
      config,
    )
    expect(completed.task).toMatchObject({
      status: "completed",
      output: `${course}/Modules/Week 03 - Oct 12/Prep/01 Prep Brief.md`,
    })
    expect(await readFile(join(vault, completed.task.output), "utf8")).toBe(
      await readFile(candidate, "utf8"),
    )
    const originalRecord = join(vault, "_meta/tasks", taskId, "task.json")
    const originalRecordBytes = await readFile(originalRecord)
    const editedPrep = `${await readFile(join(vault, completed.task.output), "utf8")}\nSYNTHETIC_PREP_STUDENT_EDIT\n`
    await writeFile(join(vault, completed.task.output), editedPrep)
    const rejectedRetry = cli([
      "task",
      "complete",
      taskId,
      "--file",
      candidate,
      "--config",
      config,
      "--json",
    ])
    expect(rejectedRetry.status).toBe(1)
    expect(await readFile(join(vault, completed.task.output), "utf8")).toBe(editedPrep)
    const next = json<{ id: string }>(["prep", course, "--session", "Session 3"], config)
    expect(next.id).not.toBe(taskId)
    const nextCandidate = join(root, "next-prep.md")
    await writeFile(nextCandidate, (await readFile(candidate, "utf8")).replace(taskId, next.id))
    const nextCompleted = json<{ task: { output: string } }>(
      ["task", "complete", next.id, "--file", nextCandidate],
      config,
    )
    expect(nextCompleted.task.output).not.toBe(completed.task.output)
    expect(await readFile(join(vault, completed.task.output), "utf8")).toBe(editedPrep)
    expect(await readFile(originalRecord)).toEqual(originalRecordBytes)
  })

  it("creates, completes, revises, and idempotently approves a synthetic draft without overwriting an existing Final", async () => {
    const root = await temp()
    const config = join(root, "student", "canvas-agent.json")
    const vault = join(root, "student-vault")
    const setup = cli([
      "setup",
      "--config",
      config,
      "--canvas-url",
      "https://canvas.example.edu",
      "--vault",
      vault,
      "--token-env",
      tokenEnv,
      "--json",
    ])
    expect(setup.status, setup.stderr).toBe(0)

    const course = "MBA-202"
    const assignmentPath = `${course}/Assignments/Growth memo.md`
    const contextPath = `${course}/Resources/Market context.md`
    await mkdir(join(vault, course, "Assignments"), { recursive: true })
    await mkdir(join(vault, course, "Resources", "Guidance"), { recursive: true })
    await writeFile(
      join(vault, course, "Resources", "Guidance", "AI.md"),
      "---\nai_policy: allowed\n---\nDrafting from supplied evidence is permitted.\n",
    )
    await writeFile(
      join(vault, assignmentPath),
      "---\ntitle: Growth memo\ncanvas_id: growth-22\n---\nPrepare a concise draft recommendation on expansion using the supplied market context. State the key tradeoff and one next step.\n",
    )
    await writeFile(
      join(vault, contextPath),
      "The synthetic market context reports steady demand, limited distribution capacity, and uncertainty about acquisition cost.\n",
    )

    const created = json<{ id: string; assignment: { mode: string } }>(
      ["draft", "Growth memo", "--course", course, "--context", contextPath],
      config,
    )
    expect(created.assignment.mode).toBe("draft")

    const finish = async (taskId: string, filename: string) => {
      const task = json<{
        requirements: string[]
        sources: Array<{ path: string }>
        status: string
      }>(["task", "show", taskId], config)
      expect(task.status).toBe("pending")
      const candidate = join(root, filename)
      const sections = task.requirements.map((heading) => {
        const body =
          heading === "Sources"
            ? task.sources.map((source) => `- \`${source.path}\``).join("\n")
            : "The draft weighs the supplied evidence, states its tradeoff, and identifies a next step grounded in the approved material."
        return `## ${heading}\n\n${body}`
      })
      await writeFile(candidate, [`Task: ${taskId}`, "", ...sections, ""].join("\n\n"))
      const completed = json<{ task: { status: string; output: string } }>(
        ["task", "complete", taskId, "--file", candidate],
        config,
      )
      expect(completed.task.status).toBe("completed")
      expect(await readFile(join(vault, completed.task.output), "utf8")).toBe(
        await readFile(candidate, "utf8"),
      )
      return completed.task.output
    }

    const firstOutput = await finish(created.id, "first-draft.md")
    const finals = join(vault, course, "Assignments", "Finals")
    await mkdir(finals, { recursive: true })
    const existingFinal = join(finals, "01 Assignment Final.md")
    await writeFile(existingFinal, "preserve pre-existing student Final\n")
    const firstApproval = json<{ output: string }>(["approve", created.id], config)
    const firstFinalBytes = await readFile(join(vault, firstApproval.output))
    const firstDraftBytes = await readFile(join(vault, firstOutput))
    const firstTaskRecord = join(vault, "_meta/tasks", created.id, "task.json")
    const firstTaskBytes = await readFile(firstTaskRecord)
    const revised = json<{ id: string; parentTaskId: string; feedback: string }>(
      ["revise", created.id, "--feedback", "Make the capacity tradeoff more explicit."],
      config,
    )
    expect(revised.parentTaskId).toBe(created.id)
    expect(revised.feedback).toBe("Make the capacity tradeoff more explicit.")
    const revisedOutput = await finish(revised.id, "revised-draft.md")
    expect(revisedOutput).not.toBe(firstOutput)

    const approvalArgs = ["approve", revised.id]
    const approved = json<{ output: string }>(approvalArgs, config)
    const approvedAgain = json<{ output: string }>(approvalArgs, config)
    expect(firstApproval.output).toBe(`${course}/Assignments/Finals/01 Assignment Final.v2.md`)
    expect(approved.output).toBe(`${course}/Assignments/Finals/01 Assignment Final.v3.md`)
    expect(approvedAgain.output).toBe(approved.output)
    expect(await readFile(existingFinal, "utf8")).toBe("preserve pre-existing student Final\n")
    expect(await readFile(join(vault, firstApproval.output))).toEqual(firstFinalBytes)
    expect(await readFile(join(vault, firstOutput))).toEqual(firstDraftBytes)
    expect(await readFile(firstTaskRecord)).toEqual(firstTaskBytes)
    expect(await readFile(join(vault, approved.output), "utf8")).toBe(
      await readFile(join(vault, revisedOutput), "utf8"),
    )
  })
})
