import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, isAbsolute, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { expect, it } from "vitest"
import { createConfig } from "../src/config.js"
import {
  enableVaultHistory,
  inspectVaultHistory,
  snapshotVaultHistory,
} from "../src/vault-history.js"

async function hashes(root: string) {
  const rows: { path: string; hash: string }[] = []
  async function walk(directory: string, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(prefix, entry.name)
      if (entry.isDirectory()) await walk(join(directory, entry.name), path)
      else
        rows.push({
          path,
          hash: createHash("sha256")
            .update(await readFile(join(directory, entry.name)))
            .digest("hex"),
        })
    }
  }
  await walk(root)
  return rows.sort((a, b) => a.path.localeCompare(b.path))
}

it.skipIf(process.platform === "win32")(
  "preserves prior snapshots and current edits after SIGKILL during real Git import without pretending a stale lock is live",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "canvas-history-interruption-"))
    const vault = join(root, "vault"),
      store = join(root, "history"),
      config = join(root, "config.json")
    let child: ReturnType<typeof spawn> | undefined
    let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined
    let terminal = false
    try {
      let realGit: string | undefined
      for (const directory of (process.env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
        try {
          await access(join(directory, "git"), constants.X_OK)
          realGit = await realpath(join(directory, "git"))
          break
        } catch {
          /* try next actual PATH entry */
        }
      }
      expect(realGit).toBeDefined()
      await mkdir(join(vault, "SYNTH101"), { recursive: true })
      await writeFile(join(vault, "SYNTH101", "reading.md"), "original synthetic reading\n")
      await createConfig(config, { vault, baseUrl: "https://canvas.example.test" })
      const baseline = await enableVaultHistory(vault, store)
      expect(baseline.commit).toMatch(/^[a-f0-9]{40}$/)
      const oldStore = await hashes(store)
      await writeFile(join(vault, "SYNTH101", "a-new.bin"), Buffer.alloc(32 * 1024, 65))
      await writeFile(join(vault, "SYNTH101", "b-new.bin"), Buffer.alloc(128 * 1024, 66))
      await writeFile(
        join(vault, "SYNTH101", "reading.md"),
        "student edit before interrupted snapshot\n",
      )
      const currentVault = await hashes(vault)
      const bin = join(root, "bin"),
        checkpoint = join(root, "checkpoint.json")
      await mkdir(bin)
      await copyFile(resolve("test/fixtures/history-interruption/git.cjs"), join(bin, "git"))
      await chmod(join(bin, "git"), 0o700)
      await writeFile(
        join(bin, "control.json"),
        JSON.stringify({
          realGit,
          store: await realpath(store),
          checkpoint,
          beforePackFiles: await readdir(join(store, "objects/pack")),
        }),
        { mode: 0o600 },
      )
      child = spawn(
        process.execPath,
        [resolve("dist/cli.js"), "vault", "history", "snapshot", "--config", config, "--json"],
        {
          cwd: root,
          detached: true,
          env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
          stdio: "ignore",
        },
      )
      closed = new Promise((accept, reject) => {
        child?.once("error", reject)
        child?.once("close", (code, signal) => {
          terminal = true
          accept({ code, signal })
        })
      })
      let receipt:
        | { gitPid: number; partialBytes: number; totalBytes: number; newPackFiles: string[] }
        | undefined
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && !terminal) {
        try {
          receipt = JSON.parse(await readFile(checkpoint, "utf8"))
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        await delay(10)
      }
      expect(
        receipt,
        "Real Git must reach a partial import checkpoint before fault injection",
      ).toBeDefined()
      if (!receipt || !child.pid || child.pid <= 1 || receipt.gitPid <= 1)
        throw new Error("Fault injection requires exact owned live process IDs")
      expect(receipt.newPackFiles.length).toBeGreaterThan(0)
      expect(receipt.partialBytes).toBeLessThan(receipt.totalBytes)
      expect(() => process.kill(receipt.gitPid, 0)).not.toThrow()
      process.kill(-child.pid, "SIGKILL")
      expect(await closed).toEqual({ code: null, signal: "SIGKILL" })
      expect(await hashes(vault)).toEqual(currentVault)
      for (const row of oldStore)
        expect(
          createHash("sha256")
            .update(await readFile(join(store, row.path)))
            .digest("hex"),
        ).toBe(row.hash)
      expect(await readFile(join(store, "refs/heads/canvas-history"), "utf8")).toBe(
        `${baseline.commit}\n`,
      )
      const recovered = spawnSync(
        realGit ?? "git",
        [
          `--git-dir=${store}`,
          "-c",
          "core.hooksPath=",
          "show",
          `${baseline.commit}:SYNTH101/reading.md`,
        ],
        {
          env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
          encoding: "utf8",
          timeout: 10_000,
        },
      )
      expect(recovered.status, recovered.stderr).toBe(0)
      expect(recovered.stdout).toBe("original synthetic reading\n")
      const beforeInspect = await hashes(store)
      const status = await inspectVaultHistory(vault)
      expect(status.status).toBe("locked")
      expect(status.message).toContain("does not prove a live process")
      await expect(snapshotVaultHistory(vault)).rejects.toThrow(/unexpected|locked/)
      expect(await hashes(store)).toEqual(beforeInspect)
      expect(await hashes(vault)).toEqual(currentVault)
      const resumedInput = join(root, "resumed-reading.txt")
      await writeFile(resumedInput, "new synthetic reading after host restart\n")
      const continued = spawnSync(
        process.execPath,
        [
          resolve("dist/cli.js"),
          "ingest",
          resumedInput,
          "--course",
          "SYNTH101",
          "--config",
          config,
          "--json",
        ],
        {
          env: { PATH: process.env.PATH },
          encoding: "utf8",
          timeout: 10_000,
          killSignal: "SIGKILL",
        },
      )
      expect(continued.error).toBeUndefined()
      expect(continued.status, continued.stderr).toBe(0)
      expect(continued.stderr).toContain(
        "Local history snapshot failed; the primary command succeeded",
      )
      const ingested = JSON.parse(continued.stdout)
      expect(await readFile(ingested.original, "utf8")).toBe(
        "new synthetic reading after host restart\n",
      )
      expect(ingested.text).toBeTruthy()
      for (const row of currentVault)
        expect(
          createHash("sha256")
            .update(await readFile(join(vault, row.path)))
            .digest("hex"),
        ).toBe(row.hash)
      expect(await hashes(store)).toEqual(beforeInspect)
      expect((await inspectVaultHistory(vault)).status).toBe("locked")
    } finally {
      if (child?.pid && child.pid > 1 && !terminal) {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          /* already terminal */
        }
      }
      if (closed) await closed.catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  },
)
