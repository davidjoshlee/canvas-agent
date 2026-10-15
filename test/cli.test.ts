import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { setCanvasFetchForTests } from "../src/canvas.js"
import { runCli } from "../src/cli.js"
import { CALCULATION_OPERATIONS, calculateValues, parseCalculationBatch } from "../src/tools.js"

const roots: string[] = []
async function temp() {
  const root = await mkdtemp(join(tmpdir(), "canvas-agent-cli-"))
  roots.push(root)
  return root
}
async function invoke(args: string[]) {
  let stdout = "",
    stderr = ""
  const out = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stdout += String(chunk)
    return true
  }) as never)
  const err = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stderr += String(chunk)
    return true
  }) as never)
  const oldExit = process.exitCode
  process.exitCode = undefined
  try {
    await runCli(args)
    return { stdout, stderr, exitCode: process.exitCode ?? 0 }
  } finally {
    process.exitCode = oldExit
    out.mockRestore()
    err.mockRestore()
  }
}
afterEach(async () => {
  setCanvasFetchForTests()
  delete process.env.CANVAS_CLI_TEST_TOKEN
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it("reports the package version without loading a missing configuration or contacting Canvas", async () => {
  const root = await temp()
  const version = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ).version
  setCanvasFetchForTests(async () => {
    throw new Error("Version must not access Canvas")
  })
  for (const flag of ["--version", "-V"]) {
    const result = await invoke(["--config", join(root, "missing.json"), flag])
    expect(result).toEqual({ stdout: `${version}\n`, stderr: "", exitCode: 0 })
  }
})

it("advertises supported arithmetic and a runnable batch shape in both calculator help commands", async () => {
  for (const args of [
    ["calculate", "--help"],
    ["simulate", "task", "calculate", "--help"],
  ]) {
    const result = await invoke(args)
    expect(result.exitCode, result.stderr).toBe(0)
    for (const operation of CALCULATION_OPERATIONS) expect(result.stdout).toContain(operation)
    const example = result.stdout.match(/Batch file: (\{[^\n]+\})/)?.[1]
    expect(example).toBeDefined()
    const batch = parseCalculationBatch(JSON.parse(example ?? ""))
    expect(batch).toHaveLength(1)
    expect(calculateValues(batch[0]?.operation ?? "", batch[0]?.values ?? [])).toBe(3)
  }
})

describe("CLI", () => {
  it("targets known IDs and mapped codes when discovery is forbidden without changing the allowlist", async () => {
    const root = await temp(),
      vault = join(root, "vault"),
      config = join(root, "config.json")
    await mkdir(vault)
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "CANVAS_CLI_TEST_TOKEN" },
        vault: { path: vault },
        courses: { allowlist: ["1", "2"] },
      }),
    )
    process.env.CANVAS_CLI_TEST_TOKEN = "synthetic-token"
    const before = await readFile(config)
    const calls: string[] = []
    const json = (value: unknown) => new Response(JSON.stringify(value))
    setCanvasFetchForTests(async (input, init) => {
      expect(init?.method).toBe("GET")
      const path = new URL(String(input)).pathname
      calls.push(path)
      if (path === "/api/v1/users/self") return json({ id: 99, name: "Synthetic student" })
      if (path === "/api/v1/courses") return new Response("PRIVATE_DISCOVERY_BODY", { status: 403 })
      if (path === "/api/v1/courses/1")
        return json({ id: 1, course_code: "CS101", name: "Synthetic course" })
      if (path === "/api/v1/courses/1/assignments")
        return json([{ id: 50, name: "Case", description: "Synthetic prompt." }])
      if (path.endsWith("/submissions/self")) return json({ assignment_id: 50, user_id: 99 })
      if (path.startsWith("/api/v1/courses/1/")) return json([])
      throw new Error("Unexpected unselected request")
    })
    const numeric = await invoke(["sync", "--course", "1", "--config", config, "--json"])
    expect(numeric.exitCode, numeric.stderr).toBe(0)
    expect(calls.filter((path) => path === "/api/v1/courses")).toHaveLength(1)
    const prompt = JSON.parse(numeric.stdout).written.find((path: string) =>
      path.includes("/Assignments/"),
    )
    await writeFile(prompt, "Student-owned unchanged by retries.")
    const alias = await invoke(["sync", "--course", "CS101", "--config", config, "--json"])
    expect(alias.exitCode, alias.stderr).toBe(0)
    expect(JSON.parse(alias.stdout).courses).toBe(1)
    expect(alias.stdout).not.toContain("PRIVATE_DISCOVERY_BODY")
    expect(await readFile(config)).toEqual(before)
    expect(await readFile(prompt, "utf8")).toBe("Student-owned unchanged by retries.")
    expect(calls.some((path) => /^\/api\/v1\/courses\/2(?:\/|$)/.test(path))).toBe(false)
    const rejected = await invoke(["sync", "--course", "3", "--config", config, "--json"])
    expect(rejected.exitCode).toBe(1)
    expect(calls.some((path) => /^\/api\/v1\/courses\/3(?:\/|$)/.test(path))).toBe(false)
    expect(await readFile(config)).toEqual(before)
  })
  it("discovers and onboards one concluded pilot, then syncs it outside the active list while preserving student files", async () => {
    const root = await temp(),
      vault = join(root, "vault"),
      config = join(root, "config.json")
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        canvas: { baseUrl: "https://canvas.example.edu", tokenEnv: "CANVAS_CLI_TEST_TOKEN" },
        vault: { path: vault },
        courses: { allowlist: [] },
      }),
    )
    process.env.CANVAS_CLI_TEST_TOKEN = "synthetic-token"
    const pilot = { id: 909, course_code: "HIST101", name: "Synthetic concluded pilot" }
    const calls: string[] = []
    const json = (value: unknown) => new Response(JSON.stringify(value))
    let inaccessible = false
    setCanvasFetchForTests(async (input, init) => {
      expect(init?.method).toBe("GET")
      const url = new URL(String(input)),
        path = url.pathname
      calls.push(path)
      if (path === "/api/v1/users/self") return json({ id: 99, name: "Synthetic student" })
      if (path === "/api/v1/courses") {
        if (url.searchParams.get("enrollment_state") === "completed") {
          expect(url.searchParams.getAll("state[]")).toEqual(["completed"])
          return json([pilot])
        }
        return json([])
      }
      if (path === "/api/v1/users/self/courses") return json([{ id: 1, course_code: "CS101" }])
      if (path === "/api/v1/courses/909")
        return inaccessible ? new Response("PRIVATE_ERROR", { status: 403 }) : json(pilot)
      if (path === "/api/v1/courses/909/assignments")
        return json([{ id: 50, name: "Case", description: "Synthetic case requirements." }])
      if (path === "/api/v1/courses/909/assignments/50/submissions/self")
        return json({ assignment_id: 50, score: 0 })
      if (/^\/api\/v1\/courses\/909\/(files|pages|modules|quizzes|discussion_topics)$/.test(path))
        return json([])
      throw new Error(`Unexpected synthetic request ${path}`)
    })
    const originalConfig = await readFile(config)
    for (const args of [
      ["onboard", "909"],
      ["onboard", "1", "--pilot"],
      ["onboard", "909", "--pilot", "--all-active"],
      ["onboard", "909", "--pilot", "--course", "1"],
    ]) {
      const denied = await invoke([...args, "--config", config, "--json"])
      expect(denied.exitCode).not.toBe(0)
      expect(await readFile(config)).toEqual(originalConfig)
    }
    const discovered = await invoke(["courses", "list", "--all", "--config", config, "--json"])
    expect(discovered.exitCode, discovered.stderr).toBe(0)
    expect(JSON.parse(discovered.stdout)).toEqual([
      { id: "909", code: "HIST101", name: pilot.name },
    ])
    const onboard = await invoke(["onboard", "909", "--pilot", "--config", config, "--json"])
    expect(onboard.exitCode, onboard.stderr).toBe(0)
    expect(JSON.parse(onboard.stdout)).toMatchObject({ selected: ["909"], sync: { courses: 1 } })
    const promptPath = JSON.parse(onboard.stdout).sync.written.find((path: string) =>
      path.includes("/Assignments/"),
    )
    expect(promptPath).toBeTruthy()
    const prompt = promptPath
    await writeFile(prompt, "Student-owned edited prompt.")
    const narrowed = await invoke(["sync", "--course", "HIST101", "--config", config, "--json"])
    expect(narrowed.exitCode, narrowed.stderr).toBe(0)
    expect(JSON.parse(narrowed.stdout).courses).toBe(1)
    expect(await readFile(prompt, "utf8")).toBe("Student-owned edited prompt.")
    inaccessible = true
    const unavailable = await invoke(["sync", "--config", config, "--json"])
    expect(unavailable.exitCode, unavailable.stderr).toBe(0)
    expect(JSON.parse(unavailable.stdout).notices.join(" ")).toContain(
      "Allowlisted course 909 is unavailable",
    )
    expect(unavailable.stdout).not.toContain("PRIVATE_ERROR")
    expect(await readFile(prompt, "utf8")).toBe("Student-owned edited prompt.")
    expect(calls.some((path) => /^\/api\/v1\/courses\/1(?:\/|$)/.test(path))).toBe(false)
  })
  it("supports sync --full as an honest current refresh while preserving edited originals and the allowlist", async () => {
    const root = await temp(),
      vault = join(root, "vault"),
      config = join(root, "config.json")
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        canvas: { baseUrl: "https://canvas.example.edu", tokenEnv: "CANVAS_CLI_TEST_TOKEN" },
        vault: { path: vault },
        courses: { allowlist: ["1"] },
      }),
    )
    process.env.CANVAS_CLI_TEST_TOKEN = "synthetic-token"
    let download = "Synthetic original reading."
    const calls: string[] = []
    setCanvasFetchForTests(async (input, init) => {
      expect(init?.method).toBe("GET")
      const path = new URL(String(input)).pathname
      if (path === "/api/v1/users/self")
        return new Response(JSON.stringify({ id: 99, name: "Synthetic student" }))
      calls.push(path)
      const course = { id: 1, course_code: "CS101", name: "Synthetic course" }
      if (path === "/api/v1/courses")
        return new Response(
          JSON.stringify([course, { id: 2, course_code: "OTHER101", name: "Out of scope" }]),
        )
      if (path === "/api/v1/courses/1") return new Response(JSON.stringify(course))
      if (path === "/api/v1/courses/1/files")
        return new Response(
          JSON.stringify([
            {
              id: 31,
              filename: "reading.txt",
              url: "https://canvas.example.edu/files/31/download",
            },
          ]),
        )
      if (path === "/files/31/download") return new Response(download)
      if (
        /^\/api\/v1\/courses\/1\/(assignments|pages|modules|quizzes|discussion_topics)$/.test(path)
      )
        return new Response("[]")
      throw new Error(`Unexpected synthetic request ${path}`)
    })
    const full = await invoke(["sync", "--full", "--json", "--config", config])
    expect(full.exitCode, full.stderr).toBe(0)
    expect(JSON.parse(full.stdout)).toMatchObject({
      refreshMode: "full",
      fullRequested: true,
      courses: 1,
      dueSoon: { status: "saved", notification: "not-requested" },
    })
    const original = join(vault, "CS101/Canvas/Files/31-reading.txt")
    await writeFile(original, "Student-edited original.")
    download = "New remote bytes must not replace the student edit."
    const retry = await invoke(["sync", "--full", "--json", "--config", config])
    expect(retry.exitCode, retry.stderr).toBe(0)
    expect(await readFile(original, "utf8")).toBe("Student-edited original.")
    expect(
      JSON.parse(retry.stdout).notices.some((notice: string) => /Preserved changed/.test(notice)),
    ).toBe(true)
    const defaultSync = await invoke(["sync", "--json", "--config", config])
    expect(defaultSync.exitCode, defaultSync.stderr).toBe(0)
    expect(JSON.parse(defaultSync.stdout)).toMatchObject({
      refreshMode: "full",
      fullRequested: false,
    })
    expect(calls.filter((path) => path === "/files/31/download")).toHaveLength(3)
    expect(calls.some((path) => path.startsWith("/api/v1/courses/2"))).toBe(false)
  })
  it("supports School Agent's draft --discuss shortcut as a separate, source-bound pending workflow", async () => {
    const root = await temp(),
      config = join(root, "agent.json"),
      vault = join(root, "vault")
    await invoke([
      "init",
      "--vault",
      vault,
      "--canvas-url",
      "https://canvas.example.edu",
      "--config",
      config,
    ])
    const source = "MBA101/Assignments/Case/prompt.md"
    await mkdir(join(vault, "MBA101/Assignments/Case"), { recursive: true })
    await writeFile(
      join(vault, source),
      "---\ntype: assignment\ncanvas_id: '22'\n---\n## Questions\n1. What is the complete solution?",
    )
    const result = await invoke([
      "draft",
      "22",
      "--course",
      "MBA101",
      "--discuss",
      "What evidence is missing?",
      "--json",
      "--config",
      config,
    ])
    expect(result.exitCode, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "pending",
      assignment: { mode: "discuss" },
      discussion: { message: "What evidence is missing?" },
      requirements: ["Student question", "Discussion", "Open questions", "Sources"],
    })
    const explicit = await invoke([
      "assignment",
      "MBA101",
      "--source",
      source,
      "--mode",
      "discuss",
      "--message",
      "Clarify this rubric.",
      "--json",
      "--config",
      config,
    ])
    expect(explicit.exitCode, explicit.stderr).toBe(0)
    expect(JSON.parse(explicit.stdout).discussion.message).toBe("Clarify this rubric.")
    await expect(
      readFile(join(vault, "MBA101/Assignments/Case/Drafts/01 Assignment Draft.md")),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })
  it("creates pending drafts from homework IDs and legacy plural assignment types, rejecting ambiguous identities", async () => {
    const root = await temp(),
      config = join(root, "agent.json"),
      vault = join(root, "vault")
    await invoke([
      "init",
      "--vault",
      vault,
      "--canvas-url",
      "https://canvas.example.edu",
      "--config",
      config,
    ])
    const source = "MBA101/Assignments/Undated - Strategic analysis/00 Prompt.md"
    await mkdir(join(vault, "MBA101/Assignments/Undated - Strategic analysis"), { recursive: true })
    await writeFile(
      join(vault, source),
      "---\ntype: assignments\ncanvas_id: '22'\n---\nAnalyze the synthetic case.",
    )
    const direct = await invoke([
      "draft",
      "Strategic analysis",
      "--course",
      "MBA101",
      "--json",
      "--config",
      config,
    ])
    expect(direct.exitCode, direct.stderr).toBe(0)
    expect(JSON.parse(direct.stdout)).toMatchObject({
      status: "pending",
      assignment: { source, mode: "draft" },
    })
    const homework = await invoke(["homework", "--draft", "22", "--json", "--config", config])
    expect(homework.exitCode, homework.stderr).toBe(0)
    expect(JSON.parse(homework.stdout)).toMatchObject({
      status: "pending",
      course: { code: "MBA101" },
      assignment: { source, mode: "draft" },
    })
    await mkdir(join(vault, "MBA102/Assignments/Other"), { recursive: true })
    await writeFile(
      join(vault, "MBA102/Assignments/Other/prompt.md"),
      "---\ntype: assignment\ncanvas_id: '22'\n---\nDifferent class.",
    )
    const ambiguous = await invoke(["homework", "--draft", "22", "--json", "--config", config])
    expect(ambiguous.exitCode).toBe(1)
    expect(ambiguous.stderr).toContain("ambiguous")
    const narrowed = await invoke([
      "homework",
      "--draft",
      "22",
      "--course",
      "MBA101",
      "--json",
      "--config",
      config,
    ])
    expect(narrowed.exitCode, narrowed.stderr).toBe(0)
    expect(JSON.parse(narrowed.stdout).course.code).toBe("MBA101")
    expect(
      (await invoke(["homework", "--draft", "Strategic analysis", "--json", "--config", config]))
        .exitCode,
    ).toBe(1)
  })
  it("previews Obsidian readiness as JSON and creates a preserved local guide without enabling Sync", async () => {
    const root = await temp(),
      config = join(root, "agent.json"),
      vault = join(root, "vault")
    await invoke([
      "init",
      "--vault",
      vault,
      "--canvas-url",
      "https://canvas.example.edu",
      "--config",
      config,
    ])
    await mkdir(join(vault, "MBA101"))
    await writeFile(join(vault, "MBA101/00 Home.md"), "PRIVATE COURSE BODY")
    const preview = await invoke(["vault", "obsidian", "--json", "--config", config])
    expect(preview.exitCode, preview.stderr).toBe(0)
    const result = JSON.parse(preview.stdout)
    expect(result.created).toBe(false)
    expect(result.opened).toBe(false)
    expect(preview.stdout).not.toContain("PRIVATE COURSE BODY")
    await expect(readFile(result.plan.guidePath)).rejects.toMatchObject({ code: "ENOENT" })
    const apply = await invoke(["vault", "obsidian", "--apply", "--json", "--config", config])
    expect(JSON.parse(apply.stdout)).toMatchObject({ created: true, opened: false })
    expect(await readFile(result.plan.guidePath, "utf8")).toContain("does not configure Obsidian")
    expect(await readFile(join(vault, "MBA101/00 Home.md"), "utf8")).toBe("PRIVATE COURSE BODY")
  })
  it("exposes explicit legacy inspection/import as pending handoffs without printing student-work bodies", async () => {
    const root = await temp(),
      config = join(root, "agent.json"),
      vault = join(root, "vault")
    await invoke([
      "init",
      "--vault",
      vault,
      "--canvas-url",
      "https://canvas.example.edu",
      "--config",
      config,
    ])
    const source = "MBA101/Assignments/Undated - Case/00 Prompt.md",
      work = "MBA101/Assignments/Undated - Case/Drafts/Old.md"
    await mkdir(join(vault, "MBA101/Assignments/Undated - Case/Drafts"), { recursive: true })
    await writeFile(
      join(vault, "MBA101/00 Home.md"),
      "---\ncanvas_url: https://canvas.example.edu/courses/99\n---\n# Management\n**Course:** F26-MBA-101-01",
    )
    await writeFile(
      join(vault, source),
      "---\ntype: assignments\ncanvas_id: '22'\n---\nAnalyze the case.",
    )
    const runId = "d354a530-d5ce-4f57-895e-9a01fe0a1f27"
    const record = {
      course: {
        code: "F26-MBA-101-01",
        canvas_id: "99",
        canvas_url: "https://canvas.example.edu/courses/99",
      },
      assignment: {
        canvas_id: "22",
        title: "Case",
        slug: "case",
        canvas_url: "https://canvas.example.edu/courses/99/assignments/22",
        due_at: null,
        group_category_id: null,
      },
      ai_policy: "allowed",
      model_ids: { draft: "old-model", discuss: "old-model" },
      source_files: ["missing.md"],
      timestamp: "2026-10-01T00:00:00Z",
      version: 1,
      run_id: runId,
    }
    const original = `<!-- school-agent-provenance\n${JSON.stringify(record)}\n-->\nPRIVATE STUDENT BODY`
    await writeFile(join(vault, work), original)
    const inspection = await invoke([
      "legacy",
      "inspect",
      runId,
      "--course",
      "99",
      "--work",
      work,
      "--json",
      "--config",
      config,
    ])
    expect(inspection.exitCode, inspection.stderr).toBe(0)
    expect(JSON.parse(inspection.stdout)).toMatchObject({ historicalSourcesVerified: false })
    expect(inspection.stdout).not.toContain("PRIVATE STUDENT BODY")
    const imported = await invoke([
      "legacy",
      "import",
      runId,
      "--course",
      "99",
      "--source",
      source,
      "--work",
      work,
      "--mode",
      "review",
      "--json",
      "--config",
      config,
    ])
    expect(imported.exitCode, imported.stderr).toBe(0)
    const result = JSON.parse(imported.stdout)
    expect(result).toMatchObject({
      status: "pending",
      assignment: { mode: "review", work },
      legacy: { legacyRunId: runId },
    })
    expect(result.id).not.toBe(runId)
    expect(imported.stdout).not.toContain("PRIVATE STUDENT BODY")
    expect(await readFile(join(vault, work), "utf8")).toBe(original)
    const linked = await invoke(["inspect", result.id, "--json", "--config", config])
    expect(linked.exitCode, linked.stderr).toBe(0)
    expect(JSON.parse(linked.stdout).legacy.legacyRunId).toBe(runId)
    await writeFile(
      join(vault, "_meta/model-context-log.jsonl"),
      JSON.stringify({
        runId,
        function: "prepBrief",
        sources: [{ path: "Assignments/Undated - Case/00 Prompt.md", tier: "full-text" }],
      }),
    )
    const prepLog = await invoke([
      "legacy",
      "prep-inspect",
      runId,
      "--course",
      "99",
      "--json",
      "--config",
      config,
    ])
    expect(prepLog.exitCode, prepLog.stderr).toBe(0)
    expect(JSON.parse(prepLog.stdout)).toMatchObject({
      courseBindingVerified: false,
      historicalSourcesVerified: false,
      modelRunBindingVerified: false,
    })
    expect(prepLog.stdout).not.toContain("PRIVATE STUDENT BODY")
  })
  it("previews reading copies, refreshes completed prep artifacts automatically, and preserves JSON stdout", async () => {
    const root = await temp(),
      config = join(root, "agent.json"),
      vault = join(root, "vault"),
      destination = join(root, "phone")
    await invoke([
      "init",
      "--vault",
      vault,
      "--canvas-url",
      "https://canvas.example.edu",
      "--config",
      config,
    ])
    const week = join(vault, "MBA101", "Week 01 - Oct 5")
    await mkdir(week, { recursive: true })
    await writeFile(
      join(week, "case.md"),
      "Class case evidence: incentives shape decisions. AI preparation is expressly permitted for this synthetic test course.",
    )
    const preview = await invoke([
      "vault",
      "reading-copy",
      "--destination",
      destination,
      "--current",
      "--json",
      "--config",
      config,
    ])
    expect(JSON.parse(preview.stdout)).toMatchObject({ preview: true, current: true, count: 1 })
    await expect(readFile(join(destination, "Current", "00 READ ME.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    const apply = await invoke([
      "vault",
      "reading-copy",
      "--destination",
      destination,
      "--current",
      "--apply",
      "--json",
      "--config",
      config,
    ])
    expect(apply.exitCode, apply.stderr).toBe(0)
    expect(JSON.parse(apply.stdout)).toMatchObject({ updated: 2 })
    const prep = await invoke([
      "prep",
      "MBA101",
      "--week",
      "2026-10-05",
      "--json",
      "--config",
      config,
    ])
    const task = JSON.parse(prep.stdout)
    const candidate = join(root, "candidate.md")
    await writeFile(candidate, "Task: wrong-identity\n\n## Overview\nRejected test candidate.")
    const rejected = await invoke([
      "task",
      "complete",
      task.id,
      "--file",
      candidate,
      "--json",
      "--config",
      config,
    ])
    expect(rejected.exitCode).toBe(1)
    expect(rejected.stderr).not.toContain("Reading copy refreshed")
    await writeFile(
      candidate,
      [
        `Task: ${task.id}`,
        ...task.requirements.map(
          (heading: string) =>
            `## ${heading}\nSynthetic case evidence shows that incentives shape decisions; review assumptions carefully. \`MBA101/Week 01 - Oct 5/case.md\``,
        ),
      ].join("\n\n"),
    )
    const complete = await invoke([
      "task",
      "complete",
      task.id,
      "--file",
      candidate,
      "--json",
      "--config",
      config,
    ])
    expect(complete.exitCode, complete.stderr).toBe(0)
    expect(() => JSON.parse(complete.stdout)).not.toThrow()
    expect(complete.stderr).toContain("Reading copy refreshed:")
    const lock = join(vault, "_meta/reading-copy.lock")
    await mkdir(lock)
    const retry = await invoke([
      "task",
      "complete",
      task.id,
      "--file",
      candidate,
      "--json",
      "--config",
      config,
    ])
    expect(retry.exitCode, retry.stderr).toBe(0)
    expect(() => JSON.parse(retry.stdout)).not.toThrow()
    expect(retry.stderr).toContain("the local command succeeded")
    await rmdir(lock)
    expect(
      await readFile(
        join(destination, "Current", "MBA101/Week 01 - Oct 5/Prep/01 Prep Brief.md.txt"),
        "utf8",
      ),
    ).toContain("Synthetic case evidence")
    await expect(
      readFile(join(destination, "Current", "_meta/tasks", task.id, "task.json")),
    ).rejects.toMatchObject({ code: "ENOENT" })
    expect(
      JSON.parse(
        (await invoke(["vault", "reading-copy-disable", "--json", "--config", config])).stdout,
      ),
    ).toMatchObject({ disabled: true, copiesPreserved: true })
  })
  it("supports local login/renew/status without leaking tokens and keeps API verification independent of expiry hints", async () => {
    const root = await temp(),
      config = join(root, "agent.json")
    await invoke([
      "init",
      "--vault",
      "vault",
      "--canvas-url",
      "https://canvas.example.edu",
      "--token-env",
      "CANVAS_CLI_TEST_TOKEN",
      "--config",
      config,
    ])
    process.env.CANVAS_CLI_TEST_TOKEN = "synthetic-secret"
    const login = await invoke([
      "auth",
      "login",
      "--expires-at",
      "2030-10-10T12:00:00Z",
      "--account",
      "student",
      "--json",
      "--config",
      config,
    ])
    expect(login.exitCode, login.stderr).toBe(0)
    expect(JSON.parse(login.stdout)).toMatchObject({
      stored: true,
      storage: "private-dotenv",
      verified: false,
    })
    expect(login.stdout + login.stderr).not.toContain("synthetic-secret")
    const metadataPath = `${config}.auth.json`
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"))
    await writeFile(
      metadataPath,
      JSON.stringify({ ...metadata, expiresAt: "2020-01-01T00:00:00Z" }),
    )
    const status = await invoke(["auth", "status", "--json", "--config", config])
    expect(status.exitCode).toBe(0)
    expect(JSON.parse(status.stdout)).toMatchObject({ renewal: "expired", verified: false })
    const calls: string[] = []
    setCanvasFetchForTests(async (input) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ id: 1, name: "Student" }), {
        headers: { "content-type": "application/json" },
      })
    })
    const renew = await invoke(["auth", "renew", "--json", "--config", config])
    expect(JSON.parse(renew.stdout)).toMatchObject({
      automaticRenewal: false,
      settingsUrl: "https://canvas.example.edu/profile/settings",
    })
    expect(calls).toHaveLength(0)
    const verify = await invoke(["auth", "verify", "--json", "--config", config])
    expect(verify.exitCode, verify.stderr).toBe(0)
    expect(calls).toHaveLength(1)
    expect(verify.stdout + verify.stderr + status.stdout + renew.stdout).not.toContain(
      "synthetic-secret",
    )
    setCanvasFetchForTests(
      async () => new Response("<html>PRIVATE STUDENT SIGN-IN PAGE</html>", { status: 200 }),
    )
    const unexpected = await invoke(["auth", "verify", "--json", "--config", config])
    expect(unexpected.exitCode).toBe(1)
    expect(unexpected.stdout).toBe("")
    expect(unexpected.stderr).toContain("authorization was not verified")
    expect(unexpected.stderr).not.toContain("PRIVATE STUDENT")
    expect(unexpected.stderr).not.toContain("synthetic-secret")
  })
  it("honors JSON on nested courses list and the legacy courses command", async () => {
    const root = await temp(),
      config = join(root, "agent.json")
    await invoke([
      "init",
      "--vault",
      "vault",
      "--canvas-url",
      "https://canvas.example.edu",
      "--token-env",
      "CANVAS_CLI_TEST_TOKEN",
      "--config",
      config,
    ])
    process.env.CANVAS_CLI_TEST_TOKEN = "synthetic-secret"
    setCanvasFetchForTests(
      async () =>
        new Response(JSON.stringify([{ id: 1, course_code: "MBA101", name: "Test" }]), {
          headers: { "content-type": "application/json" },
        }),
    )
    for (const args of [
      ["courses", "list", "--json"],
      ["courses", "--json", "list"],
      ["courses", "--json"],
    ]) {
      const result = await invoke([...args, "--config", config])
      expect(result.exitCode, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual([{ id: "1", code: "MBA101", name: "Test" }])
    }
  })
  it("initializes an explicit Canvas URL, repeatable allowlist, and empty vault", async () => {
    const root = await temp(),
      config = join(root, "agent.json"),
      vault = join(root, "vault")
    const result = await invoke([
      "init",
      "--config",
      config,
      "--vault",
      vault,
      "--canvas-url",
      "https://canvas.example.edu",
      "--token-env",
      "MY_CANVAS_TOKEN",
      "--course",
      "101",
      "--course",
      "202",
    ])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Vault directory ready:")
    const saved = JSON.parse(await readFile(config, "utf8"))
    expect(saved.canvas.baseUrl).toBe("https://canvas.example.edu")
    expect(saved.canvas.tokenEnv).toBe("MY_CANVAS_TOKEN")
    expect(saved.courses.allowlist).toEqual(["101", "202"])
    expect(await readFile(vault).catch(() => null)).toBeNull()
  })

  it("accepts global config before and after commands and reports empty local context as JSON", async () => {
    const root = await temp(),
      config = join(root, "agent.json")
    await invoke([
      "init",
      "--vault",
      "vault",
      "--canvas-url",
      "https://canvas.example.edu",
      "--config",
      config,
    ])
    const result = await invoke(["context", "--json", "--config", config])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout)).toMatchObject({ version: 1, courses: [], pendingTasks: [] })
  })

  it("creates prep and shows human instructions and full approved JSON snapshots", async () => {
    const root = await temp(),
      config = join(root, "agent.json")
    await invoke([
      "init",
      "--vault",
      "vault",
      "--canvas-url",
      "https://canvas.example.edu",
      "--config",
      config,
    ])
    const vault = join(root, "vault")
    await mkdir(join(vault, "GSB-101", "Week 03 - Oct 12"), { recursive: true })
    await writeFile(
      join(vault, "GSB-101", "Week 03 - Oct 12", "notes.md"),
      "Market structure and pricing notes.",
    )
    const prep = await invoke([
      "prep",
      "GSB-101",
      "--week",
      "2026-10-12",
      "--config",
      config,
      "--json",
    ])
    expect(prep.exitCode).toBe(0)
    const created = JSON.parse(prep.stdout)
    expect(created.taskFile).toContain("TASK.md")
    expect(created.sources).toEqual(["GSB-101/Week 03 - Oct 12/notes.md"])
    const id = created.id as string
    const show = await invoke(["task", "show", id, "--config", config])
    expect(show.stdout).toContain(`Task: ${id}`)
    const json = await invoke(["task", "show", id, "--json", "--config", config])
    expect(JSON.parse(json.stdout)).toMatchObject({
      id,
      status: "pending",
      sources: [
        { path: "GSB-101/Week 03 - Oct 12/notes.md", text: "Market structure and pricing notes." },
      ],
    })
    expect(json.stdout).toContain("Market structure and pricing notes.")
  })

  it("keeps JSON errors on stderr and returns nonzero without leaking a stack", async () => {
    const result = await invoke([
      "context",
      "--json",
      "--config",
      "/definitely/missing/config.json",
    ])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toMatch(/^\{"error":"/)
    expect(result.stderr).not.toContain(" at ")
  })

  it("returns success for help and reports JSON usage errors only once", async () => {
    const help = await invoke(["--help"])
    expect(help.exitCode).toBe(0)
    expect(help.stderr).toBe("")
    expect(help.stdout).toContain("Usage:")
    const missing = await invoke(["prep", "--json"])
    expect(missing.exitCode).toBe(1)
    expect(missing.stdout).toBe("")
    expect(JSON.parse(missing.stderr).error).toContain("course")
  })
})
