import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readFile, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve, sep } from "node:path"

// Synthetic acceptance only: record actual argv/status, not a reconstructed log.
// Never accept arbitrary config, credentials, live Canvas or shell commands.
const [flag, requestedRoot, delimiter, ...args] = process.argv.slice(2)
assert(flag === "--root" && delimiter === "--", "Use --root ABS_FIXTURE -- CLI_ARGUMENTS")
const root = await realpath(requestedRoot)
const temporary = await realpath(tmpdir())
assert(
  root.startsWith(`${temporary}${sep}canvas-host-journal-`),
  "Only owned journal fixtures are accepted",
)
const { assertNoSymlinks } = await import(
  new URL("../../dist/shared/fs-safety.js", import.meta.url)
)
await assertNoSymlinks(root)
const markerPath = join(root, "acceptance-fixture.json")
await assertNoSymlinks(markerPath)
assert((await lstat(markerPath)).size < 1000, "Fixture marker exceeds bounds")
function parse(text) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error("Invalid synthetic fixture metadata; inspect locally")
  }
}
const marker = parse(await readFile(markerPath, "utf8"))
assert(
  marker.version === 1 && marker.synthetic === true && marker.course === "ECON903",
  "Synthetic fixture marker is required",
)
const config = join(root, "config.json")
await assertNoSymlinks(config)
assert((await lstat(config)).size < 20_000, "Config exceeds bounds")
const settings = parse(await readFile(config, "utf8"))
assert(
  settings.canvas?.baseUrl === "https://canvas.example.invalid",
  "Live Canvas is not permitted",
)
assert(
  typeof settings.vault?.path === "string" &&
    (await realpath(resolve(root, settings.vault.path))) === join(root, "vault"),
  "Vault must remain inside the fixture",
)
assert(settings.courses?.allowlist?.length === 0, "Synthetic allowlist must remain empty")
try {
  await lstat(join(root, ".env"))
  throw new Error("Adjacent credentials are not permitted")
} catch (error) {
  if (error.code !== "ENOENT") throw error
}
assert(
  args.length > 0 && args.length <= 30 && args.every((value) => value.length < 10_000),
  "Argument bounds exceeded",
)
assert(
  !args.some((value) => value === "--config" || value.startsWith("--config=")),
  "The fixture config cannot be overridden",
)
const allowed =
  (args[0] === "task" && ["list", "show"].includes(args[1])) ||
  (args[0] === "simulate" &&
    (["list", "replay"].includes(args[1]) ||
      (args[1] === "task" &&
        ["list", "show", "calculations", "check-numbers"].includes(args[2])))) ||
  args[0] === "check-numbers"
assert(
  allowed,
  "Only review/discovery commands are permitted; no sync, authentication, generation, approval or submission",
)
for (let index = 0; index < args.length; index++) {
  if (args[index] !== "--file" && !args[index].startsWith("--file=")) continue
  const requestedFile = args[index] === "--file" ? args[index + 1] : args[index].slice(7)
  const file = await realpath(requestedFile)
  const rel = relative(root, file)
  assert(
    rel && rel !== ".." && !rel.startsWith(`..${sep}`),
    "Candidate must be inside the owned fixture",
  )
  await assertNoSymlinks(resolve(requestedFile))
}
const executable = process.execPath
const argv = [
  resolve(import.meta.dirname, "../../dist/cli.js"),
  ...args,
  "--config",
  config,
  "--json",
]
const digest = (text) =>
  createHash("sha256")
    .update(text ?? "")
    .digest("hex")
const log = join(root, "actual-cli-commands.jsonl")
await assertNoSymlinks(log, true)
const handle = await open(
  log,
  constants.O_WRONLY |
    constants.O_APPEND |
    constants.O_CREAT |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK,
  0o600,
)
try {
  const stat = await handle.stat()
  assert(
    stat.isFile() && stat.size < 2 * 1024 * 1024,
    "Command journal exceeds regular-file bounds",
  )
  const start = Date.now()
  const result = spawnSync(executable, argv, {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: join(root, "home"), TMPDIR: root },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 20 * 1024 * 1024,
  })
  await handle.writeFile(
    `${JSON.stringify({ version: 1, executable, argv, cwd: root, exitCode: result.status, signal: result.signal, errorCode: result.error?.code ?? null, elapsedMs: Date.now() - start, stdoutHash: digest(result.stdout), stderrHash: digest(result.stderr) })}\n`,
  )
  await handle.sync()
  process.stdout.write(result.stdout ?? "")
  process.stderr.write(result.stderr ?? "")
  process.exitCode = result.status ?? 1
} finally {
  await handle.close()
}
