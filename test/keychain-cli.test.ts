import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"

const keychain = vi.hoisted(() => ({
  calls: [] as Array<{ executable: string; args: string[]; options: Record<string, unknown> }>,
}))
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process")
  const execute = () => {
    throw new Error("Only the captured promisified boundary is permitted")
  }
  Object.defineProperty(execute, Symbol.for("nodejs.util.promisify.custom"), {
    value: async (executable: string, args: string[], options: Record<string, unknown>) => {
      keychain.calls.push({ executable, args, options })
      return { stdout: "SYNTHETIC_KEYCHAIN_SECRET\n", stderr: "" }
    },
  })
  return { ...actual, execFile: execute }
})

import { runCli } from "../src/cli.js"
import { createConfig } from "../src/config.js"

it("wires explicit Keychain import to a bounded exact-account lookup and redacted CLI output", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvas-keychain-cli-"))
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")
  const priorExit = process.exitCode
  let stdout = "",
    stderr = ""
  const out = vi.spyOn(process.stdout, "write").mockImplementation(((value: unknown) => {
    stdout += String(value)
    return true
  }) as never)
  const err = vi.spyOn(process.stderr, "write").mockImplementation(((value: unknown) => {
    stderr += String(value)
    return true
  }) as never)
  try {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
    process.exitCode = undefined
    const config = join(root, "config.json")
    await createConfig(config, {
      vault: join(root, "vault"),
      baseUrl: "https://canvas.example.test",
      tokenEnv: "CANVAS_KEYCHAIN_CLI_TEST_TOKEN",
    })
    const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString()
    await runCli([
      "auth",
      "import-school-keychain",
      "--account",
      "student@example.test",
      "--expires-at",
      expiresAt,
      "--config",
      config,
      "--json",
    ])
    expect(process.exitCode ?? 0, stderr).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({
      stored: true,
      importedFrom: "school-keychain",
      keychainModified: false,
      verified: false,
    })
    expect(stdout + stderr).not.toContain("SYNTHETIC_KEYCHAIN_SECRET")
    expect(keychain.calls).toEqual([
      {
        executable: "/usr/bin/security",
        args: [
          "find-generic-password",
          "-s",
          "school-agent-canvas",
          "-a",
          "student@example.test",
          "-w",
        ],
        options: { encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024 },
      },
    ])
    expect(await readFile(join(root, ".env"), "utf8")).toBe(
      "CANVAS_KEYCHAIN_CLI_TEST_TOKEN=SYNTHETIC_KEYCHAIN_SECRET\n",
    )
    expect(await readFile(`${config}.auth.json`, "utf8")).not.toContain("SYNTHETIC_KEYCHAIN_SECRET")
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor)
    process.exitCode = priorExit
    out.mockRestore()
    err.mockRestore()
    keychain.calls.length = 0
    await rm(root, { recursive: true, force: true })
  }
})
