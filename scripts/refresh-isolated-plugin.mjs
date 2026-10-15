import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve, sep } from "node:path"

// Explicit operator for the already authorized temporary login only. Never read,
// copy, hash or print credentials, or use the user's ordinary Codex home/cache.
const home = await realpath(process.argv[2] ?? "")
const temporary = await realpath(tmpdir())
assert(
  basename(home) === "codex-home" &&
    dirname(home).startsWith(`${temporary}${sep}canvas-codex-plugin-`),
  "Supply only the authorized temporary Codex home",
)
const auth = await lstat(join(home, "auth.json"))
assert(
  auth.isFile() && !auth.isSymbolicLink() && (auth.mode & 0o077) === 0,
  "Native private login metadata is required",
)
const checkout = resolve(import.meta.dirname, "..")
const root = await mkdtemp(join(tmpdir(), "canvas-native-plugin-refresh-"))
const workspace = join(root, "workspace"),
  marketplace = join(root, "marketplace")
await mkdir(workspace)
await mkdir(join(marketplace, ".agents/plugins"), { recursive: true })
const env = {
  PATH: process.env.PATH,
  HOME: join(dirname(home), "os-home"),
  CODEX_HOME: home,
  TMPDIR: root,
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "localhost,127.0.0.1",
}
const commands = []
const digest = (value) => createHash("sha256").update(value).digest("hex")
function command(args) {
  const result = spawnSync("codex", args, {
    cwd: workspace,
    env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 500_000,
  })
  commands.push({
    args,
    status: result.status,
    signal: result.signal,
    stdoutHash: digest(result.stdout ?? ""),
    stderrHash: digest(result.stderr ?? ""),
  })
  writeFileSync(join(root, "commands.json"), JSON.stringify(commands, null, 2), { mode: 0o600 })
  if (result.error) throw result.error
  assert.equal(
    result.status,
    0,
    "Isolated native plugin command failed; inspect the private command journal",
  )
  return result.stdout
}
const files = [
  ".codex-plugin/plugin.json",
  "plugin.json",
  "references/cli.md",
  "references/workflows.md",
  "skills/assignment-workflow/SKILL.md",
  "skills/canvas-workspace/SKILL.md",
  "skills/setup-and-sync/SKILL.md",
]
async function inventory(directory, prefix = "") {
  const rows = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name),
      name = join(prefix, entry.name).split(sep).join("/")
    assert(!entry.isSymbolicLink(), "Plugin contains a link")
    if (entry.isDirectory()) rows.push(...(await inventory(path, name)))
    else {
      assert(
        entry.isFile() && files.includes(name),
        "Plugin contains an unexpected file; nothing removed",
      )
      const stat = await lstat(path)
      assert(stat.size <= 2_000_000, "Plugin file exceeds bounds")
      rows.push({ path: name, hash: digest(await readFile(path)) })
    }
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path))
}
const before = JSON.parse(
  command(["plugin", "list", "--marketplace", "canvas-agent-tools", "--json"]),
)
const rows = before.installed.filter(
  (entry) => entry.pluginId === "canvas-agent@canvas-agent-tools",
)
assert.equal(rows.length, 1, "Expected the isolated audit plugin to be installed exactly once")
const old = rows[0]
assert.match(old.version, /^[A-Za-z0-9.+_-]{1,80}$/)
const oldMarketplace = await realpath(old.marketplaceSource.source)
if (oldMarketplace !== join(dirname(home), "marketplace")) {
  const priorRoot = dirname(oldMarketplace)
  assert(
    dirname(priorRoot) === temporary &&
      /^canvas-native-plugin-refresh-[A-Za-z0-9]+$/.test(basename(priorRoot)) &&
      basename(oldMarketplace) === "marketplace",
    "Refuse a marketplace outside an owned isolated refresh",
  )
  const receiptPath = join(priorRoot, "audit.json"),
    stat = await lstat(receiptPath)
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 100_000)
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"))
  assert(
    receipt.status === "pass" && (await realpath(receipt.codexHome)) === home,
    "The previous refresh is not bound to this isolated home",
  )
}
const cache = await realpath(
  join(home, "plugins/cache/canvas-agent-tools/canvas-agent", old.version),
)
assert.equal(
  relative(home, cache).split(sep).join("/"),
  `plugins/cache/canvas-agent-tools/canvas-agent/${old.version}`,
)
const beforeFiles = await inventory(cache)
await cp(cache, join(root, "prior-plugin"), { recursive: true, errorOnExist: true, force: false })
assert.deepEqual(await inventory(join(root, "prior-plugin")), beforeFiles)
await cp(join(checkout, "plugins/canvas-agent"), join(marketplace, "plugins/canvas-agent"), {
  recursive: true,
  errorOnExist: true,
  force: false,
})
await cp(
  join(checkout, ".agents/plugins/marketplace.json"),
  join(marketplace, ".agents/plugins/marketplace.json"),
  { errorOnExist: true, force: false },
)
const expectedFiles = await inventory(join(marketplace, "plugins/canvas-agent"))
assert.equal(expectedFiles.length, files.length)
const metadata = {
  root,
  codexHome: home,
  priorMarketplace: oldMarketplace,
  priorCache: cache,
  archive: join(root, "prior-plugin"),
  beforeFiles,
  expectedFiles,
  credentialsReadOrCopied: false,
}
await writeFile(join(root, "before.json"), JSON.stringify(metadata, null, 2), {
  flag: "wx",
  mode: 0o600,
})
console.log(
  JSON.stringify({
    root,
    phase: "archived-isolated-plugin",
    archive: metadata.archive,
    credentialsReadOrCopied: false,
  }),
)
command(["plugin", "remove", "canvas-agent@canvas-agent-tools", "--json"])
command(["plugin", "marketplace", "remove", "canvas-agent-tools", "--json"])
const added = JSON.parse(command(["plugin", "marketplace", "add", marketplace, "--json"]))
const installed = JSON.parse(
  command(["plugin", "add", "canvas-agent@canvas-agent-tools", "--json"]),
)
const installedPath = await realpath(installed.installedPath)
assert(
  installedPath.startsWith(
    `${home}${sep}plugins${sep}cache${sep}canvas-agent-tools${sep}canvas-agent${sep}`,
  ),
)
const currentFiles = await inventory(installedPath)
assert.deepEqual(currentFiles, expectedFiles)
const after = JSON.parse(
  command(["plugin", "list", "--marketplace", "canvas-agent-tools", "--json"]),
)
assert.equal(
  after.installed.filter(
    (entry) => entry.pluginId === "canvas-agent@canvas-agent-tools" && entry.enabled,
  ).length,
  1,
)
const afterAuth = await lstat(join(home, "auth.json"))
assert.equal(afterAuth.ino, auth.ino)
assert.equal(afterAuth.size, auth.size)
assert.equal(afterAuth.mtimeMs, auth.mtimeMs)
const report = {
  ...metadata,
  status: "pass",
  added,
  installed,
  currentFiles,
  currentCacheMatchesSource: true,
  oldCacheArchivedBeforeRemoval: true,
  authFileMetadataUnchanged: true,
  normalSettingsOrCacheTouched: false,
  commands,
}
await writeFile(join(root, "audit.json"), JSON.stringify(report, null, 2), {
  flag: "wx",
  mode: 0o600,
})
console.log(
  JSON.stringify({
    root,
    status: "pass",
    installedPath,
    files: currentFiles.length,
    currentCacheMatchesSource: true,
    archive: metadata.archive,
    authFileMetadataUnchanged: true,
    normalSettingsOrCacheTouched: false,
  }),
)
