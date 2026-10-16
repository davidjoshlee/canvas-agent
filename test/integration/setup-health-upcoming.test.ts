import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { inspectVaultHealth } from "../../src/cli/health.js"
import { runCli } from "../../src/cli/program.js"
import { createConfig, loadAdjacentEnv, loadConfig, setupConfig } from "../../src/config/index.js"
import { selectOnboardingCourses as selectOnboarding } from "../../src/config/onboarding.js"
import type { WorkspaceContext } from "../../src/shared/types.js"
import { collectUpcoming } from "../../src/student/upcoming.js"
import { type CanvasFetch, createCanvasTestTransport } from "../helpers/canvas-client.js"

const roots: string[] = []
const canvasTransport = createCanvasTestTransport()
function useCanvasFetch(fetch?: CanvasFetch): void {
  canvasTransport.use(fetch ? { fetch } : {})
}
const selectOnboardingCourses = (...args: Parameters<typeof selectOnboarding>) =>
  selectOnboarding(args[0], args[1], args[2], canvasTransport.client(args[1]))
async function temp() {
  const root = await mkdtemp(join(tmpdir(), "canvas-agent-parity-"))
  roots.push(root)
  return root
}
async function invoke(args: string[]) {
  let stdout = ""
  let stderr = ""
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
  const priorCode = process.exitCode
  process.exitCode = undefined
  try {
    await runCli(args, { canvasClient: (config) => canvasTransport.client(config) })
    return { stdout, stderr, code: process.exitCode ?? 0 }
  } finally {
    process.exitCode = priorCode
    out.mockRestore()
    err.mockRestore()
  }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  delete process.env.PARITY_CANVAS_TOKEN
  canvasTransport.reset()
})

describe("setup and local upcoming inventory", () => {
  it("isolates new default vaults from School while preserving explicit existing paths", async () => {
    const root = await temp()
    const schoolVault = join(root, "school-vault")
    await mkdir(schoolVault)
    const original = "Synthetic School-owned work must remain unchanged.\n"
    await writeFile(join(schoolVault, "original.md"), original)
    vi.stubEnv("HOME", root)
    try {
      const direct = await setupConfig(join(root, "direct/config.json"), {
        baseUrl: "https://canvas.example.test",
      })
      expect(direct.vault.path).toBe(join(root, "canvas-vault"))
      const configPath = join(root, "cli/config.json")
      const result = await invoke([
        "setup",
        "--canvas-url",
        "https://canvas.example.test",
        "--config",
        configPath,
        "--json",
      ])
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout).vault).toBe(join(root, "canvas-vault"))
      const explicitPath = join(root, "existing/config.json")
      await createConfig(explicitPath, {
        vault: schoolVault,
        baseUrl: "https://canvas.example.test",
      })
      const before = await readFile(explicitPath)
      expect((await loadConfig(explicitPath)).vault.path).toBe(schoolVault)
      await expect(
        setupConfig(explicitPath, { baseUrl: "https://canvas.example.test" }),
      ).rejects.toThrow("already exists")
      expect(await readFile(explicitPath)).toEqual(before)
      expect(await readFile(join(schoolVault, "original.md"), "utf8")).toBe(original)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("creates a blank private env template and refuses either existing setup file", async () => {
    const root = await temp()
    const configPath = join(root, "agent.json")
    const config = await setupConfig(configPath, {
      baseUrl: "https://canvas.example.edu",
      vault: "./parity-vault",
      tokenEnv: "PARITY_CANVAS_TOKEN",
    })
    const envPath = join(root, ".env")
    expect(config.vault.path).toBe(join(root, "parity-vault"))
    expect(await readFile(envPath, "utf8")).toBe("PARITY_CANVAS_TOKEN=\n")
    expect((await lstat(envPath)).mode & 0o777).toBe(0o600)
    await expect(
      setupConfig(configPath, { baseUrl: "https://canvas.example.edu" }),
    ).rejects.toThrow("already exists")
    await chmod(envPath, 0o600)
  })

  it("exposes setup, local doctor, and redacted config inspection commands", async () => {
    const root = await temp()
    const config = join(root, "agent.json")
    const setup = await invoke([
      "setup",
      "--config",
      config,
      "--vault",
      "./vault",
      "--canvas-url",
      "https://canvas.example.edu",
      "--token-env",
      "PARITY_CANVAS_TOKEN",
    ])
    expect(setup.code).toBe(0)
    const shown = await invoke(["config", "show", "--config", config, "--json"])
    expect(shown.code).toBe(0)
    expect(JSON.parse(shown.stdout)).toMatchObject({ canvas: { tokenEnv: "PARITY_CANVAS_TOKEN" } })
    expect(shown.stdout).not.toContain("from-file")
    const doctor = await invoke(["doctor", "--config", config, "--json"])
    expect(doctor.code).toBe(0)
    expect(JSON.parse(doctor.stdout)).toHaveProperty("checks")
    expect(doctor.stderr).toBe("")
    const syncDoctor = await invoke(["doctor", "--sync-only", "--config", config, "--json"])
    expect(syncDoctor.code).toBe(1)
    expect(JSON.parse(syncDoctor.stdout).checks).toContainEqual(
      expect.objectContaining({ name: "token-env", status: "error" }),
    )
    const offline = await invoke(["doctor", "--offline", "--config", config, "--json"])
    expect(offline.code).toBe(0)
    expect(offline.stdout).toContain("offline commands remain available")
    const auth = await invoke(["auth", "status", "--config", config, "--json"])
    expect(JSON.parse(auth.stdout)).toEqual({
      configured: true,
      tokenEnv: "PARITY_CANVAS_TOKEN",
      available: false,
      renewal: "unrecorded",
      verified: false,
    })
  })

  it("loads only missing environment variables and treats an existing empty value as authoritative", async () => {
    const root = await temp()
    await writeFile(
      join(root, ".env"),
      "PARITY_CANVAS_TOKEN=from-file\nINLINE=$(touch /tmp/not-run)\n",
    )
    process.env.PARITY_CANVAS_TOKEN = ""
    await loadAdjacentEnv(join(root, "agent.json"))
    expect(process.env.PARITY_CANVAS_TOKEN).toBe("")
    expect(process.env.INLINE).toBe("$(touch /tmp/not-run)")
    delete process.env.INLINE
  })

  it("rejects oversized adjacent env files before loading their contents", async () => {
    const root = await temp()
    await writeFile(join(root, ".env"), `X=${"x".repeat(65 * 1024)}\n`)
    await expect(loadAdjacentEnv(join(root, "agent.json"))).rejects.toThrow("64 KB")
    expect(process.env.X).toBeUndefined()
  })

  it("persists only explicitly selected discovered active course IDs", async () => {
    const root = await temp()
    const configPath = join(root, "agent.json")
    const config = await createConfig(configPath, {
      vault: "./vault",
      baseUrl: "https://canvas.example.edu",
      tokenEnv: "PARITY_CANVAS_TOKEN",
    })
    process.env.PARITY_CANVAS_TOKEN = "test-token"
    useCanvasFetch(async (input) => {
      const url = String(input)
      const courses = url.includes("users/self/courses")
        ? [{ id: 101, name: "Active", course_code: "MGTE220", workflow_state: "available" }]
        : [
            { id: 101, name: "Active", course_code: "MGTE220" },
            { id: 202, name: "Inactive", course_code: "ACCT300" },
          ]
      return new Response(JSON.stringify(courses), { status: 200 })
    })
    const result = await selectOnboardingCourses(configPath, config, { ids: ["101"] })
    expect(result.selected).toEqual(["101"])
    expect((await loadConfig(configPath)).courses.allowlist).toEqual(["101"])
    await expect(selectOnboardingCourses(configPath, config, { ids: ["202"] })).rejects.toThrow(
      "active",
    )
    expect((await loadConfig(configPath)).courses.allowlist).toEqual(["101"])
  })

  it.each([403, 404, 401, "malformed", "invalid-profile", "active-denied"] as const)(
    "onboards with discovery %s only when active enrollment and profile evidence remain valid",
    async (mode) => {
      const root = await temp(),
        configPath = join(root, "agent.json")
      const config = await createConfig(configPath, {
        vault: "./vault",
        baseUrl: "https://canvas.example.edu",
        tokenEnv: "PARITY_CANVAS_TOKEN",
      })
      process.env.PARITY_CANVAS_TOKEN = "synthetic-token"
      const before = await readFile(configPath)
      const calls: string[] = []
      useCanvasFetch(async (input, init) => {
        expect(init?.method).toBe("GET")
        const path = new URL(String(input)).pathname
        calls.push(path)
        if (path === "/api/v1/users/self/courses")
          return mode === "active-denied"
            ? new Response("PRIVATE_ACTIVE_RESPONSE", { status: 403 })
            : new Response(
                JSON.stringify([
                  { id: 101, course_code: "CS101", name: "First", workflow_state: "available" },
                  { id: 202, course_code: "CS202", name: "Second", workflow_state: "available" },
                ]),
              )
        if (path === "/api/v1/courses")
          return mode === "malformed"
            ? new Response("{ PRIVATE_DISCOVERY_RESPONSE")
            : new Response("PRIVATE_DISCOVERY_RESPONSE", {
                status: typeof mode === "number" ? mode : 403,
              })
        if (path === "/api/v1/users/self")
          return mode === "invalid-profile"
            ? new Response("<html>PRIVATE_PROFILE_RESPONSE</html>")
            : new Response(JSON.stringify({ id: 99, name: "Synthetic student" }))
        throw new Error("Unexpected off-scope request")
      })
      if (mode === 403 || mode === 404) {
        const selected = await selectOnboardingCourses(configPath, config, { ids: ["101"] })
        expect(selected.selected).toEqual(["101"])
        expect(selected.warning).toContain("active-enrollment list")
        expect(selected.warning).toContain("coverage gap")
        expect(JSON.stringify(selected)).not.toContain("PRIVATE_")
        expect((await loadConfig(configPath)).courses.allowlist).toEqual(["101"])
        const selectedBytes = await readFile(configPath)
        await expect(
          selectOnboardingCourses(configPath, await loadConfig(configPath), { ids: ["303"] }),
        ).rejects.toThrow(/active/)
        expect(await readFile(configPath)).toEqual(selectedBytes)
        expect(
          (
            await selectOnboardingCourses(configPath, await loadConfig(configPath), {
              allActive: true,
            })
          ).selected,
        ).toEqual(["101", "202"])
        expect(calls).toContain("/api/v1/users/self")
      } else {
        await expect(
          selectOnboardingCourses(configPath, config, { ids: ["101"] }),
        ).rejects.toThrow()
        expect(await readFile(configPath)).toEqual(before)
      }
      expect(calls.some((path) => /^\/api\/v1\/courses\/\d/.test(path))).toBe(false)
    },
  )

  it("uses due metadata and legacy Due lines, keeps overdue separate, deduplicates, and ignores creation dates", () => {
    const context = {
      version: 1,
      vault: "/vault",
      courses: [
        {
          code: "MGTE220",
          title: "Management",
          root: "MGTE220",
          sources: [
            {
              path: "MGTE220/Assignments/Case A.md",
              title: "Case A",
              hash: "x",
              text: "---\ndue_at: 2026-10-11T18:00:00Z\ncreated_at: 2026-10-10T10:00:00Z\n---\n",
              type: "assignment",
              dates: [],
              canvasId: "44",
            },
            {
              path: "MGTE220/Canvas/Assignments/A-copy.md",
              title: "A copy",
              hash: "y",
              text: "Due: 2026-10-11T18:00:00Z",
              type: "assignment",
              dates: [],
              canvasId: "44",
            },
            {
              path: "MGTE220/Assignments/Old.md",
              title: "Old",
              hash: "z",
              text: "---\ncreated_at: 2026-10-01T00:00:00Z\n---\n",
              type: "assignment",
              dates: [],
            },
            {
              path: "MGTE220/Assignments/Past.md",
              title: "Past",
              hash: "p",
              text: "---\ndue_at: 2026-10-08T18:00:00Z\n---\n",
              type: "assignment",
              dates: [],
            },
          ],
          excluded: [],
          guidance: [],
          existingWork: [],
        },
      ],
      pendingTasks: [],
      notices: [],
    } as WorkspaceContext
    const result = collectUpcoming(context, { days: 14, now: new Date("2026-10-09T12:00:00Z") })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ title: "Case A", canvasId: "44", overdue: false })
    expect(result.overdue.map((row) => row.title)).toEqual(["Past"])
  })

  it("sorts equivalent due instants by timestamp rather than their textual timezone", () => {
    const context = {
      version: 1,
      vault: "/vault",
      courses: [
        {
          code: "MGTE220",
          title: "Management",
          root: "MGTE220",
          excluded: [],
          guidance: [],
          existingWork: [],
          sources: [
            {
              path: "MGTE220/Assignments/later.md",
              title: "Later",
              hash: "a",
              text: "",
              type: "assignment",
              dates: [],
              dueAt: "2026-10-11T11:00:00-07:00",
            },
            {
              path: "MGTE220/Assignments/earlier.md",
              title: "Earlier",
              hash: "b",
              text: "",
              type: "assignment",
              dates: [],
              dueAt: "2026-10-11T18:00:00Z",
            },
          ],
        },
      ],
      pendingTasks: [],
      notices: [],
    } as WorkspaceContext
    const result = collectUpcoming(context, { days: 14, now: new Date("2026-10-09T12:00:00Z") })
    expect(result.items.map((row) => row.title)).toEqual(["Earlier", "Later"])
  })

  it("warns about stale extraction sidecars without exposing source bodies", async () => {
    const root = await temp()
    const course = join(root, "MGTE220", "Canvas", "Files")
    await mkdir(course, { recursive: true })
    await writeFile(join(course, "reading.pdf"), "current bytes")
    await writeFile(
      join(course, "reading.pdf.extracted.md"),
      "---\noriginal_path: MGTE220/Canvas/Files/reading.pdf\noriginal_hash: " +
        `"${"0".repeat(64)}"` +
        "\n---\n\nPRIVATE BODY THAT MUST NOT APPEAR\n",
    )
    const result = await inspectVaultHealth(root)
    expect(result.checks).toContainEqual({
      name: "stale-extraction",
      status: "warning",
      message: "Extraction needs refreshing: MGTE220/Canvas/Files/reading.pdf.extracted.md",
    })
    expect(JSON.stringify(result)).not.toContain("PRIVATE BODY")
    await rm(join(course, "reading.pdf"))
    const missingOriginal = await inspectVaultHealth(root)
    expect(missingOriginal.checks).toContainEqual({
      name: "stale-extraction",
      status: "warning",
      message: "Extraction needs refreshing: MGTE220/Canvas/Files/reading.pdf.extracted.md",
    })
    expect(JSON.stringify(missingOriginal)).not.toContain("PRIVATE BODY")
  })
})
