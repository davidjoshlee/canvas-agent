import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  authStatus,
  importSchoolKeychainAuth,
  loginAuth,
  renewalInstructions,
} from "../../src/auth/credentials.js"
import { createConfig, loadAdjacentEnv } from "../../src/config/index.js"

const roots: string[] = [],
  now = new Date("2026-10-10T12:00:00Z"),
  expiry = "2026-11-10T12:00:00Z"
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-auth-test-"))
  roots.push(root)
  const path = join(root, "config.json")
  const config = await createConfig(path, {
    vault: "vault",
    baseUrl: "https://canvas.example.edu",
    tokenEnv: "CANVAS_AUTH_TEST_TOKEN",
  })
  return { root, path, config }
}
afterEach(async () => {
  delete process.env.CANVAS_AUTH_TEST_TOKEN
  delete process.env.CANVAS_AUTH_TEST_OTHER
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe("local token provisioning and expiry", () => {
  it("imports only one exact School Keychain account into private dotenv without modifying the environment or Keychain", async () => {
    const { root, path, config } = await fixture()
    await writeFile(join(root, ".env"), "# Retained settings\nCANVAS_AUTH_TEST_OTHER=retained\n")
    process.env.CANVAS_AUTH_TEST_TOKEN = "different-shell-token"
    const readToken = vi.fn(async () => "synthetic-keychain-secret\n")
    const result = await importSchoolKeychainAuth(
      path,
      config,
      { account: "student@example.test", expiresAt: expiry, now },
      { platform: "darwin", readToken },
    )
    expect(readToken).toHaveBeenCalledExactlyOnceWith([
      "find-generic-password",
      "-s",
      "school-agent-canvas",
      "-a",
      "student@example.test",
      "-w",
    ])
    expect(result).toMatchObject({
      stored: true,
      storage: "private-dotenv",
      importedFrom: "school-keychain",
      keychainModified: false,
      shellOverridesImport: true,
      verified: false,
    })
    expect(JSON.stringify(result)).not.toContain("synthetic-keychain-secret")
    expect(process.env.CANVAS_AUTH_TEST_TOKEN).toBe("different-shell-token")
    expect(await readFile(join(root, ".env"), "utf8")).toContain("CANVAS_AUTH_TEST_OTHER=retained")
    expect((await lstat(join(root, ".env"))).mode & 0o777).toBe(0o600)
    delete process.env.CANVAS_AUTH_TEST_TOKEN
    await loadAdjacentEnv(path)
    expect(process.env.CANVAS_AUTH_TEST_TOKEN).toBe("synthetic-keychain-secret")
    expect(await authStatus(path, config, now)).toMatchObject({
      available: true,
      renewal: "valid",
      account: "student@example.test",
      verified: false,
    })
  })
  it("refuses unsupported platforms, invalid choices and unsafe storage before any Keychain lookup", async () => {
    const { root, path, config } = await fixture()
    const readToken = vi.fn(async () => "synthetic-secret")
    const options = { account: "student", expiresAt: expiry, now }
    await expect(
      importSchoolKeychainAuth(path, config, options, { platform: "linux", readToken }),
    ).rejects.toThrow(/macOS-only/)
    for (const account of ["", "-service-override", "student\nother"])
      await expect(
        importSchoolKeychainAuth(
          path,
          config,
          { ...options, account },
          { platform: "darwin", readToken },
        ),
      ).rejects.toThrow(/account label/)
    await expect(
      importSchoolKeychainAuth(
        path,
        config,
        { ...options, expiresAt: "2026-01-01T00:00:00Z" },
        { platform: "darwin", readToken },
      ),
    ).rejects.toThrow(/future ISO/)
    await mkdir(config.vault.path)
    await expect(
      importSchoolKeychainAuth(join(config.vault.path, "inside.json"), config, options, {
        platform: "darwin",
        readToken,
      }),
    ).rejects.toThrow(/outside the vault/)
    expect(readToken).not.toHaveBeenCalled()
    await expect(readFile(join(root, ".env"))).rejects.toThrow()
  })
  it("redacts Keychain errors, preserves saved secrets unless replacement is explicit, and never falls back to another account", async () => {
    const { root, path, config } = await fixture()
    const options = { account: "student", expiresAt: expiry, now }
    const failing = vi.fn(async () => {
      throw new Error("PRIVATE_KEYCHAIN_ERROR_CONTENT")
    })
    await expect(
      importSchoolKeychainAuth(path, config, options, { platform: "darwin", readToken: failing }),
    ).rejects.toThrow("Could not read the selected School Keychain account")
    expect(failing).toHaveBeenCalledTimes(1)
    await expect(readFile(join(root, ".env"))).rejects.toThrow()
    await writeFile(join(root, ".env"), "CANVAS_AUTH_TEST_TOKEN=existing-token\n")
    const runtime = { platform: "darwin" as const, readToken: async () => "synthetic-import-token" }
    await expect(importSchoolKeychainAuth(path, config, options, runtime)).rejects.toThrow(
      /--replace/,
    )
    expect(await readFile(join(root, ".env"), "utf8")).toBe(
      "CANVAS_AUTH_TEST_TOKEN=existing-token\n",
    )
    await importSchoolKeychainAuth(path, config, { ...options, replace: true }, runtime)
    expect(await readFile(join(root, ".env"), "utf8")).toBe(
      "CANVAS_AUTH_TEST_TOKEN=synthetic-import-token\n",
    )
  })
  it("persists only the provisioned secret outside the vault with private permissions and preserves unrelated env lines", async () => {
    const { root, path, config } = await fixture()
    await writeFile(
      join(root, ".env"),
      "# Student settings\nCANVAS_AUTH_TEST_OTHER=retained\nCANVAS_AUTH_TEST_TOKEN=\n",
    )
    process.env.CANVAS_AUTH_TEST_TOKEN = "synthetic~secret"
    const result = await loginAuth(path, config, { expiresAt: expiry, account: "student", now })
    expect(JSON.stringify(result)).not.toContain("synthetic")
    expect(await readFile(join(root, ".env"), "utf8")).toContain("CANVAS_AUTH_TEST_OTHER=retained")
    expect((await lstat(join(root, ".env"))).mode & 0o777).toBe(0o600)
    expect(await readFile(`${path}.auth.json`, "utf8")).not.toContain("synthetic")
    delete process.env.CANVAS_AUTH_TEST_TOKEN
    await loadAdjacentEnv(path)
    expect(process.env.CANVAS_AUTH_TEST_TOKEN).toBe("synthetic~secret")
    expect(await authStatus(path, config, now)).toMatchObject({
      available: true,
      renewal: "valid",
      verified: false,
      expiresAt: expiry,
    })
    expect(await authStatus(path, config, new Date("2026-11-09T12:00:00Z"))).toMatchObject({
      renewal: "renewal-warning",
    })
    expect(await authStatus(path, config, new Date("2026-11-11T12:00:00Z"))).toMatchObject({
      renewal: "expired",
    })
  })
  it("does not apply a prior token's expiry when shell environment supplies a different token", async () => {
    const { path, config } = await fixture()
    process.env.CANVAS_AUTH_TEST_TOKEN = "first-secret"
    await loginAuth(path, config, { expiresAt: expiry, now })
    process.env.CANVAS_AUTH_TEST_TOKEN = "second-secret"
    expect(await authStatus(path, config, now)).toMatchObject({
      renewal: "token-changed",
      verified: false,
    })
    await expect(loginAuth(path, config, { expiresAt: expiry, now })).rejects.toThrow(/--replace/)
    await loginAuth(path, config, { expiresAt: expiry, replace: true, now })
    expect(await authStatus(path, config, now)).toMatchObject({ renewal: "valid" })
  })
  it("rejects missing secrets, malformed/past expiry, unsafe paths and dotenv injection", async () => {
    const { root, path, config } = await fixture()
    await expect(loginAuth(path, config, { expiresAt: expiry, now })).rejects.toThrow(/locally/)
    process.env.CANVAS_AUTH_TEST_TOKEN = "secret"
    for (const expiresAt of ["tomorrow", "2026-10-01T12:00:00Z", "2026-11-10"])
      await expect(loginAuth(path, config, { expiresAt, now })).rejects.toThrow(/future ISO/)
    process.env.CANVAS_AUTH_TEST_TOKEN = "secret\nOTHER=bad"
    await expect(loginAuth(path, config, { expiresAt: expiry, now })).rejects.toThrow(/dotenv/)
    process.env.CANVAS_AUTH_TEST_TOKEN = "secret"
    await mkdir(config.vault.path)
    await expect(
      loginAuth(join(config.vault.path, "inside.json"), config, { expiresAt: expiry, now }),
    ).rejects.toThrow(/outside the vault/)
    const outside = join(root, "outside.txt")
    await writeFile(outside, "preserve")
    await symlink(outside, join(root, ".env"))
    await expect(loginAuth(path, config, { expiresAt: expiry, now })).rejects.toThrow(
      /Symbolic links/,
    )
    expect(await readFile(outside, "utf8")).toBe("preserve")
  })
  it("reports missing/invalid metadata without leaking file contents and supplies manual renewal steps", async () => {
    const { path, config } = await fixture()
    expect(await authStatus(path, config, now)).toMatchObject({
      available: false,
      renewal: "unrecorded",
    })
    await writeFile(`${path}.auth.json`, '{"secret":"not-valid-metadata"}')
    await expect(authStatus(path, config, now)).rejects.toThrow("Auth expiry metadata is invalid")
    expect(renewalInstructions(config)).toMatchObject({
      settingsUrl: "https://canvas.example.edu/profile/settings",
      automaticRenewal: false,
    })
  })
})
