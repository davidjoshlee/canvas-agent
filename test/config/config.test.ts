import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createConfig,
  loadConfig,
  readVaultLocation,
  setVaultLocation,
} from "../../src/config/index.js"

const dirs: string[] = []
async function temp() {
  const d = await mkdtemp(join(tmpdir(), "canvas-agent-config-"))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe("config", () => {
  it("creates a restrictive config and resolves the vault relative to the config", async () => {
    const dir = await temp(),
      path = join(dir, "config.json")
    const created = await createConfig(path, {
      vault: "./vault",
      baseUrl: "https://canvas.example.edu",
      courses: ["12", "12"],
    })
    expect(created.vault.path).toBe(join(dir, "vault"))
    expect(created.courses.allowlist).toEqual(["12"])
    expect(JSON.parse(await readFile(path, "utf8")).courses.allowlist).toEqual(["12"])
    expect(await loadConfig(path)).toEqual(created)
  })
  it("defaults to an empty allowlist and refuses replacement", async () => {
    const dir = await temp(),
      path = join(dir, "config.json")
    await createConfig(path, { vault: "vault", baseUrl: "http://localhost:3000" })
    await expect(
      createConfig(path, { vault: "other", baseUrl: "https://canvas.example.edu" }),
    ).rejects.toThrow("already exists")
    expect((await loadConfig(path)).courses.allowlist).toEqual([])
  })
  it("rejects unsafe hosts and malformed config", async () => {
    const dir = await temp()
    await expect(
      createConfig(join(dir, "bad.json"), { vault: "v", baseUrl: "http://canvas.example.edu" }),
    ).rejects.toThrow("HTTPS")
    await expect(
      createConfig(join(dir, "bad.json"), {
        vault: "v",
        baseUrl: "https://user:secret@canvas.example.edu",
      }),
    ).rejects.toThrow("credentials")
  })
  it("rejects config and vault paths that pass through symlinks", async () => {
    const dir = await temp(),
      target = await temp(),
      link = join(dir, "linked")
    await symlink(target, link)
    await expect(
      createConfig(join(link, "config.json"), {
        vault: "vault",
        baseUrl: "https://canvas.example.edu",
      }),
    ).rejects.toThrow("Symbolic links")
    await expect(
      createConfig(join(dir, "other.json"), {
        vault: join(link, "vault"),
        baseUrl: "https://canvas.example.edu",
      }),
    ).rejects.toThrow("Symbolic links")
  })

  it("reads a missing configured root without creating it", async () => {
    const dir = await temp()
    const path = join(dir, "config.json")
    await createConfig(path, { vault: "old-vault", baseUrl: "https://canvas.example.edu" })
    const result = await readVaultLocation(path)
    expect(result).toEqual({ config: path, vault: join(dir, "old-vault"), exists: false })
    await expect(lstat(result.vault)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("changes the root by config-relative mapping and preserves config and adjacent env", async () => {
    const dir = await temp()
    const path = join(dir, "nested", "config.json")
    await mkdir(join(dir, "nested"))
    const oldRoot = join(dir, "nested", "old")
    const nextRoot = join(dir, "next")
    await mkdir(oldRoot)
    await mkdir(nextRoot)
    await createConfig(path, {
      vault: "old",
      baseUrl: "https://canvas.example.edu",
      tokenEnv: "MY_CANVAS_TOKEN",
      courses: ["12", "34"],
    })
    const envPath = join(dir, "nested", ".env")
    await writeFile(envPath, "MY_CANVAS_TOKEN=keep-this-secret\n", { mode: 0o600 })

    const changed = await setVaultLocation(path, "../next")
    expect(changed).toEqual({
      config: path,
      vault: nextRoot,
      exists: true,
      previousVault: oldRoot,
      changed: true,
    })
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      canvas: { baseUrl: "https://canvas.example.edu", tokenEnv: "MY_CANVAS_TOKEN" },
      vault: { path: "../next" },
      courses: { allowlist: ["12", "34"] },
    })
    expect(await readFile(envPath, "utf8")).toBe("MY_CANVAS_TOKEN=keep-this-secret\n")

    const previousCwd = process.cwd()
    try {
      process.chdir(tmpdir())
      expect(await loadConfig(path)).toMatchObject({ vault: { path: nextRoot } })
      expect(await readVaultLocation(path)).toMatchObject({
        config: path,
        vault: nextRoot,
        exists: true,
      })
    } finally {
      process.chdir(previousCwd)
    }
  })

  it("rejects empty, missing, file, and symlink targets without changing config bytes", async () => {
    const dir = await temp()
    const target = await temp()
    const path = join(dir, "config.json")
    const oldRoot = join(dir, "old")
    const file = join(dir, "file")
    const linked = join(dir, "linked")
    await mkdir(oldRoot)
    await writeFile(file, "not a directory")
    await symlink(target, linked)
    await createConfig(path, { vault: "old", baseUrl: "https://canvas.example.edu" })
    const original = await readFile(path, "utf8")

    for (const invalid of ["", "missing", "file", "linked"]) {
      await expect(setVaultLocation(path, invalid)).rejects.toThrow()
      expect(await readFile(path, "utf8")).toBe(original)
    }
    await expect(readVaultLocation(path)).resolves.toMatchObject({ vault: oldRoot, exists: true })
  })
})
