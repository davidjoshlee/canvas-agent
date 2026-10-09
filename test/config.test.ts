import { mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createConfig, loadConfig } from "../src/config.js"

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
})
