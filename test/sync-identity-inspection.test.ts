import { spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { doctorChecks } from "../src/health.js"
import { inspectSyncIdentity } from "../src/sync-identity-inspection.js"
import type { ToolkitConfig } from "../src/types.js"

const roots: string[] = [],
  origin = "https://canvas.example.test",
  other = "https://other.example.test",
  hash = "a".repeat(64)
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-identity-inspection-"))
  roots.push(root)
  const vault = join(root, "vault"),
    meta = join(vault, "_meta")
  await mkdir(meta, { recursive: true })
  const config: ToolkitConfig = {
    version: 1,
    canvas: { baseUrl: origin, tokenEnv: "SYNTHETIC_UNUSED_IDENTITY_TOKEN" },
    vault: { path: vault },
    courses: { allowlist: ["1"] },
  }
  const configPath = join(root, "config.json")
  await writeFile(configPath, JSON.stringify(config))
  return { root, vault, meta, config, configPath }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe("read-only sync ownership diagnostics", () => {
  it("reports absent and legacy-unbound evidence without writing or claiming cache ownership", async () => {
    const f = await fixture()
    expect(await inspectSyncIdentity(f.vault, origin)).toEqual({
      origin: "absent",
      account: "absent",
      currentAccountVerified: false,
      historicalCacheOwnershipVerified: false,
    })
    expect(await readdir(f.meta)).toEqual([])
    const bytes = JSON.stringify({ version: 1, files: { PRIVATE_PATH: hash } })
    await writeFile(join(f.meta, "canvas-sync-state.json"), bytes)
    expect(await inspectSyncIdentity(f.vault, origin)).toMatchObject({
      origin: "unbound",
      account: "absent",
    })
    expect(await readFile(join(f.meta, "canvas-sync-state.json"), "utf8")).toBe(bytes)
  })
  it("reports matching stored server and reserved account, never a verified current subject or hash", async () => {
    const f = await fixture()
    await writeFile(join(f.meta, "canvas-origin.json"), JSON.stringify({ version: 1, origin }))
    await writeFile(
      join(f.meta, "canvas-sync-state.json"),
      JSON.stringify({ version: 1, origin, files: { PRIVATE_COURSEWORK: hash } }),
    )
    await writeFile(
      join(f.meta, "canvas-subject.json"),
      JSON.stringify({ version: 1, origin, subjectHash: hash }),
      { mode: 0o600 },
    )
    const result = await inspectSyncIdentity(f.vault, origin)
    expect(result).toEqual({
      origin: "matched",
      account: "reserved",
      currentAccountVerified: false,
      historicalCacheOwnershipVerified: false,
    })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|aaaaaaaa/)
    const doctor = await doctorChecks(f.configPath, f.config, { offline: true })
    expect(doctor.ok).toBe(true)
    expect(doctor.checks).toContainEqual(
      expect.objectContaining({
        name: "vault-sync-account",
        status: "warning",
        message: expect.stringContaining("not verified offline"),
      }),
    )
  })
  it("detects mismatched origins including contradictory reservation/state records", async () => {
    const f = await fixture()
    await writeFile(join(f.meta, "canvas-origin.json"), JSON.stringify({ version: 1, origin }))
    await writeFile(
      join(f.meta, "canvas-sync-state.json"),
      JSON.stringify({ version: 1, origin: other, files: {} }),
    )
    await writeFile(
      join(f.meta, "canvas-subject.json"),
      JSON.stringify({ version: 1, origin: other, subjectHash: hash }),
      { mode: 0o600 },
    )
    expect(await inspectSyncIdentity(f.vault, origin)).toMatchObject({
      origin: "mismatched",
      account: "mismatched",
    })
    const result = await doctorChecks(f.configPath, f.config, { offline: true })
    expect(result.ok).toBe(false)
    expect(
      result.checks
        .filter((check) => check.name.startsWith("vault-sync-"))
        .every((check) => check.status === "error"),
    ).toBe(true)
  })
  it("rejects malformed, oversized, exposed and linked bindings without exposing payloads or following targets", async () => {
    const f = await fixture()
    await writeFile(join(f.meta, "canvas-origin.json"), "PRIVATE_INVALID_JSON")
    await writeFile(
      join(f.meta, "canvas-subject.json"),
      JSON.stringify({ version: 1, origin, subjectHash: hash }),
      { mode: 0o644 },
    )
    expect(await inspectSyncIdentity(f.vault, origin)).toMatchObject({
      origin: "invalid",
      account: "invalid",
    })
    await chmod(join(f.meta, "canvas-subject.json"), 0o600)
    await writeFile(join(f.meta, "canvas-origin.json"), "X".repeat(4097))
    expect((await inspectSyncIdentity(f.vault, origin)).origin).toBe("invalid")
    const linked = await fixture()
    await symlink(join(f.meta, "canvas-subject.json"), join(linked.meta, "canvas-subject.json"))
    expect((await inspectSyncIdentity(linked.vault, origin)).account).toBe("invalid")
    expect(JSON.stringify(await doctorChecks(f.configPath, f.config))).not.toContain(
      "PRIVATE_INVALID_JSON",
    )
  })
  it("makes the compiled offline doctor fail a conflicting binding without fetching Canvas or modifying evidence", async () => {
    const f = await fixture()
    const bytes = JSON.stringify({ version: 1, origin: other })
    const path = join(f.meta, "canvas-origin.json")
    await writeFile(path, bytes)
    const result = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), "doctor", "--offline", "--config", f.configPath, "--json"],
      { cwd: tmpdir(), encoding: "utf8" },
    )
    expect(result.status).not.toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "vault-sync-origin", status: "error" }),
    )
    expect(await readFile(path, "utf8")).toBe(bytes)
    expect(await readdir(f.meta)).toEqual(["canvas-origin.json"])
  })
})
