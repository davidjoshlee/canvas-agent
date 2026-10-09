import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { setCanvasFetchForTests } from "../src/canvas.js"
import { runCli } from "../src/cli.js"

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

describe("CLI", () => {
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
