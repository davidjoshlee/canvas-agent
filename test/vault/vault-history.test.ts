import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  disableVaultHistory,
  enableVaultHistory,
  exportVaultHistory,
  listVaultHistory,
  showVaultHistory,
  snapshotVaultHistory,
} from "../../src/vault/history.js"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-history-test-"))
  roots.push(root)
  const vault = join(root, "vault"),
    store = join(root, "private-history")
  await mkdir(join(vault, "SYNTH101"), { recursive: true })
  await writeFile(join(vault, "SYNTH101", "café notes.md"), "original synthetic class notes\n")
  return { root, vault, store }
}

it("is disabled by default without creating history or touching an existing vault Git repository", async () => {
  const { vault, store } = await fixture()
  await mkdir(join(vault, ".git"))
  await writeFile(join(vault, ".git", "config"), "PRIVATE_EXISTING_GIT_SENTINEL")
  expect(await snapshotVaultHistory(vault)).toEqual({ enabled: false, changed: false })
  expect(await listVaultHistory(vault)).toMatchObject({ configured: false, commits: [] })
  expect(await readdir(vault)).toEqual([".git", "SYNTH101"])
  expect(await readFile(join(vault, ".git", "config"), "utf8")).toBe(
    "PRIVATE_EXISTING_GIT_SENTINEL",
  )
  await expect(stat(store)).rejects.toMatchObject({ code: "ENOENT" })
  await enableVaultHistory(vault, store)
  expect(await readFile(join(vault, ".git", "config"), "utf8")).toBe(
    "PRIVATE_EXISTING_GIT_SENTINEL",
  )
  const listed = await listVaultHistory(vault)
  expect(
    (await showVaultHistory(vault, listed.commits[0]?.id ?? "")).files.some((file) =>
      file.path.startsWith(".git/"),
    ),
  ).toBe(false)
})

it("keeps unchanged snapshots stable and exports earlier text/binary/deleted files without replacing live work", async () => {
  const { root, vault, store } = await fixture()
  await writeFile(join(vault, "SYNTH101", "data.bin"), Buffer.from([0, 1, 255]))
  const first = await enableVaultHistory(vault, store)
  expect(first).toMatchObject({ enabled: true, changed: true, files: 2 })
  expect(await snapshotVaultHistory(vault)).toMatchObject({ changed: false, commit: first.commit })
  await writeFile(join(vault, "SYNTH101", "café notes.md"), "student edited current notes\n")
  await rm(join(vault, "SYNTH101", "data.bin"))
  const second = await snapshotVaultHistory(vault)
  expect(second.changed).toBe(true)
  expect(second.commit).not.toBe(first.commit)
  const listed = await listVaultHistory(vault)
  expect(listed.commits.map((item) => item.id)).toEqual([second.commit, first.commit])
  expect(listed.commits[0]?.parents).toEqual([first.commit])
  expect(listed.commits[1]?.parents).toEqual([])
  const shown = await showVaultHistory(vault, first.commit ?? "")
  expect(shown.files.map((file) => file.path)).toEqual([
    "SYNTH101/café notes.md",
    "SYNTH101/data.bin",
  ])
  const exported = join(root, "recovered.md")
  await exportVaultHistory(vault, first.commit ?? "", "SYNTH101/café notes.md", exported)
  expect(await readFile(exported, "utf8")).toBe("original synthetic class notes\n")
  expect(await readFile(join(vault, "SYNTH101", "café notes.md"), "utf8")).toBe(
    "student edited current notes\n",
  )
  await expect(
    exportVaultHistory(vault, first.commit ?? "", "SYNTH101/café notes.md", exported),
  ).rejects.toMatchObject({ code: "EEXIST" })
  await exportVaultHistory(
    vault,
    first.commit ?? "",
    "SYNTH101/data.bin",
    join(root, "restored.bin"),
  )
  expect(await readFile(join(root, "restored.bin"))).toEqual(Buffer.from([0, 1, 255]))
  if (process.platform !== "win32") expect((await stat(store)).mode & 0o777).toBe(0o700)
})

it("preserves retained history when disabled and re-enables only the same owned store", async () => {
  const { root, vault, store } = await fixture()
  const first = await enableVaultHistory(vault, store)
  await disableVaultHistory(vault)
  await writeFile(join(vault, "SYNTH101", "new.md"), "new student note")
  expect(await snapshotVaultHistory(vault)).toMatchObject({ enabled: false, changed: false })
  expect((await listVaultHistory(vault)).commits).toHaveLength(1)
  await expect(enableVaultHistory(vault, join(root, "another-store"))).rejects.toThrow(
    "another store",
  )
  const next = await enableVaultHistory(vault, store)
  expect(next.commit).not.toBe(first.commit)
  expect((await listVaultHistory(vault)).commits).toHaveLength(2)
})

it("rejects unsafe, linked, oversized, credential-like and foreign-store inputs without advancing saved history", async () => {
  const { root, vault, store } = await fixture()
  await expect(enableVaultHistory(vault, join(vault, "history"))).rejects.toThrow("disjoint")
  await expect(enableVaultHistory(vault, "relative")).rejects.toThrow("absolute")
  await mkdir(store)
  await writeFile(join(store, "unrelated.txt"), "preserve")
  await expect(enableVaultHistory(vault, store)).rejects.toMatchObject({ code: "EEXIST" })
  expect(await readFile(join(store, "unrelated.txt"), "utf8")).toBe("preserve")
  const owned = join(root, "owned-history")
  const first = await enableVaultHistory(vault, owned)
  for (const [name, data] of [
    [".env", "PRIVATE_HISTORY_SENTINEL"],
    ["token.txt", "password=PRIVATE_HISTORY_SENTINEL"],
  ] as const) {
    const file = join(vault, name)
    await writeFile(file, data)
    await expect(snapshotVaultHistory(vault)).rejects.toThrow(/history/i)
    expect((await listVaultHistory(vault)).commits[0]?.id).toBe(first.commit)
    await rm(file)
  }
  const huge = join(vault, "huge.bin")
  await writeFile(huge, "")
  await truncate(huge, 50 * 1024 * 1024 + 1)
  await expect(snapshotVaultHistory(vault)).rejects.toThrow("bounds")
  await rm(huge)
  const linked = join(vault, "link.md")
  await symlink(join(vault, "SYNTH101", "café notes.md"), linked)
  await expect(snapshotVaultHistory(vault)).rejects.toThrow(/links/)
  await rm(linked)
  await expect(
    exportVaultHistory(vault, first.commit ?? "", "../escape", join(root, "bad")),
  ).rejects.toThrow("relative path")
  await expect(
    exportVaultHistory(
      vault,
      first.commit ?? "",
      "SYNTH101/café notes.md",
      join(vault, "overwrite.md"),
    ),
  ).rejects.toThrow("outside")
  await writeFile(join(owned, "config"), "[include]\npath = PRIVATE_HISTORY_SENTINEL\n")
  await expect(snapshotVaultHistory(vault)).rejects.toThrow("configuration changed")
})

it("refuses hooks, object alternates and stale locks instead of executing or repairing them", async () => {
  const { root, vault, store } = await fixture()
  await enableVaultHistory(vault, store)
  await mkdir(join(store, "hooks"), { recursive: true })
  await writeFile(join(store, "hooks", "reference-transaction"), "PRIVATE_HOOK_SENTINEL")
  await expect(listVaultHistory(vault)).rejects.toThrow("unexpected")
  await rm(join(store, "hooks", "reference-transaction"))
  await writeFile(join(store, "objects", "info", "alternates"), root)
  await expect(snapshotVaultHistory(vault)).rejects.toThrow("unexpected")
  await rm(join(store, "objects", "info", "alternates"))
  await writeFile(join(store, "canvas-history.lock"), "held by another owner")
  await expect(snapshotVaultHistory(vault)).rejects.toThrow("locked")
  expect(await readFile(join(store, "canvas-history.lock"), "utf8")).toBe("held by another owner")
})

it("uses the compiled CLI for explicit enable, automatic post-write snapshots, disable and separate export", async () => {
  const { root, vault, store } = await fixture()
  const configPath = join(root, "agent.json")
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "CANVAS_API_TOKEN" },
      vault: { path: vault },
      courses: { allowlist: [] },
    }),
  )
  const cli = (args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), ...args, "--config", configPath, "--json"],
      {
        encoding: "utf8",
        timeout: 15_000,
        killSignal: "SIGKILL",
        env: {
          ...process.env,
          GIT_DIR: join(root, "foreign-repository"),
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "include.path",
          GIT_CONFIG_VALUE_0: join(root, "must-not-load"),
        },
      },
    )
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  }
  const baseline = cli(["vault", "history", "enable", "--directory", store])
  const input = join(root, "reading.txt")
  await writeFile(input, "Synthetic class reading for a new device workflow.")
  cli(["ingest", input, "--course", "SYNTH101"])
  const listing = cli(["vault", "history", "list"])
  expect(listing.commits).toHaveLength(2)
  expect(cli(["vault", "history", "show", baseline.commit]).files).toHaveLength(1)
  const output = join(root, "exported.md")
  expect(
    cli([
      "vault",
      "history",
      "export",
      baseline.commit,
      "--path",
      "SYNTH101/café notes.md",
      "--file",
      output,
    ]).restoredIntoVault,
  ).toBe(false)
  cli(["vault", "history", "disable"])
  expect(cli(["vault", "history", "snapshot"])).toMatchObject({ enabled: false, changed: false })
})

it("captures actual partial ingest writes after failure without overwriting its error or conflicting sidecar", async () => {
  const { root, vault, store } = await fixture()
  const configPath = join(root, "agent.json")
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "CANVAS_API_TOKEN" },
      vault: { path: vault },
      courses: { allowlist: [] },
    }),
  )
  const body = "Synthetic partial-ingest original bytes\n"
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 12)
  const original = `SYNTH101/Canvas/Files/reading-${hash}.txt`
  const sidecar = `${original}.extracted.md`
  await mkdir(join(vault, "SYNTH101/Canvas/Files"), { recursive: true })
  await writeFile(join(vault, sidecar), "student-owned conflicting sidecar\n")
  const first = await enableVaultHistory(vault, store)
  const input = join(root, "reading.txt")
  await writeFile(input, body)
  const result = spawnSync(
    process.execPath,
    [
      resolve("dist/cli.js"),
      "ingest",
      input,
      "--course",
      "SYNTH101",
      "--config",
      configPath,
      "--json",
    ],
    { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" },
  )
  expect(result.status).toBe(1)
  expect(result.stdout).toBe("")
  expect(JSON.parse(result.stderr.split("\n")[0] ?? "").error).toContain("conflicting provenance")
  expect(result.stderr).toContain("Local vault history saved after failed command")
  expect(await readFile(join(vault, original), "utf8")).toBe(body)
  expect(await readFile(join(vault, sidecar), "utf8")).toBe("student-owned conflicting sidecar\n")
  const listing = await listVaultHistory(vault)
  expect(listing.commits).toHaveLength(2)
  expect(listing.commits[1]?.id).toBe(first.commit)
  expect(
    (await showVaultHistory(vault, listing.commits[0]?.id ?? "")).files.map((file) => file.path),
  ).toContain(original)
})

it("keeps unconfigured command failures and config-free discovery free of history side effects", async () => {
  const { root, vault, store } = await fixture()
  const invalid = join(root, "invalid.json")
  await writeFile(invalid, "PRIVATE_INVALID_CONFIG_SENTINEL")
  const failed = spawnSync(
    process.execPath,
    [
      resolve("dist/cli.js"),
      "ingest",
      join(root, "missing.txt"),
      "--course",
      "SYNTH101",
      "--config",
      invalid,
      "--json",
    ],
    { encoding: "utf8", timeout: 15_000 },
  )
  expect(failed.status).toBe(1)
  expect(JSON.parse(failed.stderr).error).toBe("Config file is not valid JSON")
  expect(failed.stderr).not.toContain("history")
  const initial = await enableVaultHistory(vault, store)
  await writeFile(join(vault, "SYNTH101", "new.md"), "Not captured by a documentation read.")
  const discovered = spawnSync(
    process.execPath,
    [
      resolve("dist/cli.js"),
      "instructions",
      "--topic",
      "correctness",
      "--config",
      invalid,
      "--json",
    ],
    { encoding: "utf8", timeout: 15_000 },
  )
  expect(discovered.status, discovered.stderr).toBe(0)
  expect(discovered.stderr).toBe("")
  expect((await listVaultHistory(vault)).commits.map((item) => item.id)).toEqual([initial.commit])
})
