import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createConfig } from "../../src/config/index.js"
import {
  disableVaultHistory,
  enableVaultHistory,
  inspectVaultHistory,
} from "../../src/vault/history.js"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-history-health-"))
  roots.push(root)
  const vault = join(root, "vault"),
    store = join(root, "history"),
    config = join(root, "config.json")
  await mkdir(join(vault, "SYNTH101"), { recursive: true })
  await writeFile(join(vault, "SYNTH101", "reading.md"), "PRIVATE_SYNTHETIC_HISTORY_BODY\n")
  await createConfig(config, {
    vault,
    baseUrl: "https://canvas.example.test",
    tokenEnv: "SYNTH_HISTORY_TOKEN",
  })
  return { root, vault, store, config }
}
async function fingerprint(root: string) {
  const rows: string[] = []
  async function visit(path: string, prefix = "") {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const rel = `${prefix}${entry.name}`
      if (entry.isDirectory()) {
        rows.push(`${rel}/`)
        await visit(join(path, entry.name), `${rel}/`)
      } else
        rows.push(
          `${rel}:${createHash("sha256")
            .update(await readFile(join(path, entry.name)))
            .digest("hex")}`,
        )
    }
  }
  await visit(root)
  return rows
}
function cli(config: string, args: string[], path = process.env.PATH) {
  const result = spawnSync(
    process.execPath,
    [resolve("dist/cli.js"), ...args, "--config", config, "--json"],
    {
      env: { PATH: path, SYNTH_HISTORY_TOKEN: "synthetic-local-readiness-only" },
      encoding: "utf8",
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  )
  expect(result.error).toBeUndefined()
  expect(result.stderr).toBe("")
  expect(result.stdout).not.toContain("PRIVATE_SYNTHETIC_HISTORY_BODY")
  return { code: result.status, value: JSON.parse(result.stdout) }
}

it("keeps default-off diagnostics Git-free and does not create history metadata", async () => {
  const { root, vault, config } = await fixture()
  const before = await fingerprint(root)
  expect(await inspectVaultHistory(vault)).toMatchObject({
    status: "disabled",
    enabled: false,
    configured: false,
    writesPerformed: false,
  })
  expect(cli(config, ["vault", "history", "status"], "")).toMatchObject({
    code: 0,
    value: { status: "disabled" },
  })
  expect(cli(config, ["doctor", "--offline"], "").value.checks).toContainEqual(
    expect.objectContaining({ name: "vault-history", status: "ok" }),
  )
  expect(await fingerprint(root)).toEqual(before)
})

it("checks saved object headers without reading current vault bodies or claiming unsaved edits are backed up", async () => {
  const { root, vault, store, config } = await fixture()
  const baseline = await enableVaultHistory(vault, store)
  await writeFile(join(vault, ".env"), "PRIVATE_UNSAVED_CREDENTIAL_FIXTURE")
  await writeFile(join(vault, "SYNTH101", "reading.md"), "unsaved edits")
  const before = await fingerprint(root)
  expect(await inspectVaultHistory(vault)).toMatchObject({
    status: "ready",
    latestCommit: baseline.commit,
    files: 1,
    writesPerformed: false,
    fullHistoryIntegrityVerified: false,
    workingTreeCurrentnessVerified: false,
  })
  expect(cli(config, ["vault", "history", "status"])).toMatchObject({
    code: 0,
    value: { status: "ready", latestCommit: baseline.commit },
  })
  const doctor = cli(config, ["doctor", "--offline"])
  expect(doctor.code).toBe(0)
  expect(doctor.value.checks).toContainEqual(
    expect.objectContaining({ name: "vault-history", status: "ok" }),
  )
  expect(await fingerprint(root)).toEqual(before)
})

it("reports a held lock without inferring liveness or creating/removing files", async () => {
  const { root, vault, store, config } = await fixture()
  await enableVaultHistory(vault, store)
  await writeFile(join(store, "canvas-history.lock"), "PRIVATE_LOCK_SENTINEL")
  const before = await fingerprint(root)
  const status = await inspectVaultHistory(vault)
  expect(status).toMatchObject({ status: "locked", enabled: true, writesPerformed: false })
  expect(status.message).toContain("does not prove a live process")
  expect(cli(config, ["doctor", "--offline"]).value.checks).toContainEqual(
    expect.objectContaining({ name: "vault-history", status: "warning" }),
  )
  expect(await fingerprint(root)).toEqual(before)
})

it("reports missing Git as a backup error, not Canvas auth failure or a sync-only prerequisite", async () => {
  const { root, vault, store, config } = await fixture()
  await enableVaultHistory(vault, store)
  const before = await fingerprint(root)
  expect(cli(config, ["vault", "history", "status"], "")).toMatchObject({
    code: 1,
    value: { status: "unavailable" },
  })
  const doctor = cli(config, ["doctor", "--offline"], "")
  expect(doctor.code).toBe(1)
  expect(doctor.value.checks).toContainEqual(
    expect.objectContaining({ name: "vault-history", status: "error" }),
  )
  const sync = cli(config, ["doctor", "--sync-only"], "")
  expect(sync.code).toBe(0)
  expect(sync.value.checks.some((check: { name: string }) => check.name === "vault-history")).toBe(
    false,
  )
  const health = cli(config, ["vault", "health"], "")
  expect(health.code).toBe(1)
  expect(health.value.checks).toContainEqual(
    expect.objectContaining({ name: "vault-history", status: "error" }),
  )
  expect(await fingerprint(root)).toEqual(before)
})

it("detects a missing latest blob even when the saved commit and tree themselves remain readable", async () => {
  const { root, vault, store } = await fixture()
  const first = await enableVaultHistory(vault, store)
  const git = (args: string[], input: string) => {
    const result = spawnSync(
      "git",
      [`--git-dir=${store}`, "-c", "core.hooksPath=", "-c", "commit.gpgSign=false", ...args],
      {
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "synthetic",
          GIT_AUTHOR_EMAIL: "synthetic@local",
          GIT_COMMITTER_NAME: "synthetic",
          GIT_COMMITTER_EMAIL: "synthetic@local",
        },
        input,
        encoding: "utf8",
        timeout: 10_000,
      },
    )
    expect(result.status, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  const tree = git(["mktree", "--missing"], `100644 blob ${"f".repeat(40)}\tmissing.txt\n`)
  const commit = git(
    ["commit-tree", tree, "-p", first.commit ?? ""],
    "synthetic missing-blob fixture\n",
  )
  await writeFile(join(store, "refs/heads/canvas-history"), `${commit}\n`)
  const before = await fingerprint(root)
  expect(await inspectVaultHistory(vault)).toMatchObject({
    status: "unsafe",
    writesPerformed: false,
  })
  expect(await fingerprint(root)).toEqual(before)
})

it("distinguishes disabled retained history, unsafe control metadata and an enabled empty store", async () => {
  const { root, vault, store } = await fixture()
  await enableVaultHistory(vault, store)
  await disableVaultHistory(vault)
  expect(await inspectVaultHistory(vault)).toMatchObject({
    status: "disabled",
    configured: true,
    enabled: false,
  })
  const control = join(vault, "_meta/canvas-vault-history.json")
  const state = JSON.parse(await readFile(control, "utf8"))
  await writeFile(control, JSON.stringify({ ...state, enabled: true }))
  await rm(join(store, "refs/heads/canvas-history"))
  const before = await fingerprint(root)
  expect(await inspectVaultHistory(vault)).toMatchObject({ status: "empty", enabled: true })
  expect(await fingerprint(root)).toEqual(before)
  await writeFile(control, "PRIVATE_MALFORMED_CONTROL_SENTINEL")
  const unsafe = await inspectVaultHistory(vault)
  expect(unsafe.status).toBe("unsafe")
  expect(JSON.stringify(unsafe)).not.toContain("PRIVATE_MALFORMED_CONTROL_SENTINEL")
})
