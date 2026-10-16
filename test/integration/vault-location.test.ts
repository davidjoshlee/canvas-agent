import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { expect, it } from "vitest"

it("reports, reconnects, and safely changes the configured vault from another cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvas-vault-location-"))
  try {
    const configDir = join(root, "config-home")
    const workingDir = join(root, "different-cwd")
    const oldVault = join(root, "former-vault")
    const newVault = join(root, "selected-vault")
    const config = join(configDir, "canvas-agent.json")
    await Promise.all([mkdir(configDir), mkdir(workingDir), mkdir(newVault)])
    const marker = join(newVault, "student-work.md")
    await writeFile(marker, "Student-owned synthetic file.\n")
    await writeFile(
      config,
      `${JSON.stringify(
        {
          version: 1,
          canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "CANVAS_SYNTHETIC_TOKEN" },
          vault: { path: "../former-vault" },
          courses: { allowlist: ["SYNTH101"] },
        },
        null,
        2,
      )}\n`,
    )
    const run = async (args: string[]) =>
      await promisify(execFile)(process.execPath, [resolve("dist/cli.js"), ...args], {
        cwd: workingDir,
        env: { PATH: process.env.PATH, HOME: root },
        timeout: 15_000,
      })
    const runJson = async (args: string[]) => {
      const result = await run([...args, "--config", config, "--json"])
      return JSON.parse(result.stdout) as Record<string, unknown>
    }

    const before = await runJson(["vault", "location"])
    expect(before).toEqual({ config, vault: oldVault, exists: false })
    const human = await run(["vault", "location", "--config", config])
    expect(human.stdout).toContain(config)
    expect(human.stdout).toContain(oldVault)
    expect(human.stdout).toContain("is missing")
    expect(human.stdout).toContain("--set <existing-directory>")

    const updated = await runJson(["vault", "location", "--set", "../selected-vault"])
    expect(updated).toEqual({
      config,
      vault: newVault,
      exists: true,
      previousVault: oldVault,
      changed: true,
    })
    const afterSet = await run(["vault", "location", "--config", config])
    expect(afterSet.stdout).toContain(newVault)
    expect(await runJson(["vault", "location"])).toEqual({ config, vault: newVault, exists: true })
    const sameLocation = await run([
      "vault",
      "location",
      "--set",
      "~/selected-vault",
      "--config",
      config,
    ])
    expect(sameLocation.stdout).toContain(
      "Location already configured; vault files were not moved.",
    )
    expect(await readFile(marker, "utf8")).toBe("Student-owned synthetic file.\n")
    expect(await readdir(root)).not.toContain("former-vault") // No implicit directory migration.
    expect(JSON.parse(await readFile(config, "utf8")).vault.path).toBe("../selected-vault")

    const savedConfig = await readFile(config, "utf8")
    await expect(run(["vault", "location", "--set", "", "--config", config])).rejects.toMatchObject(
      { code: 1 },
    )
    await expect(
      run(["vault", "location", "--set", join(root, "missing-target"), "--config", config]),
    ).rejects.toMatchObject({ code: 1 })
    expect(await readFile(config, "utf8")).toBe(savedConfig)
    expect(await readFile(marker, "utf8")).toBe("Student-owned synthetic file.\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
