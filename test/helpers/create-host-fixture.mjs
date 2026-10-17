import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = await mkdtemp(join(tmpdir(), "canvas-host-journal-"))
const vault = join(root, "vault")
const config = join(root, "config.json")
await mkdir(join(root, "home"))
const initialized = spawnSync(
  process.execPath,
  [
    resolve(import.meta.dirname, "../../dist/cli.js"),
    "init",
    "--vault",
    vault,
    "--canvas-url",
    "https://canvas.example.invalid",
    "--config",
    config,
    "--json",
  ],
  {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: join(root, "home"), TMPDIR: root },
    encoding: "utf8",
    timeout: 30_000,
  },
)
assert.equal(initialized.status, 0, initialized.stderr)
await writeFile(
  join(root, "acceptance-fixture.json"),
  JSON.stringify({ version: 1, synthetic: true, course: "ECON903" }),
  { flag: "wx", mode: 0o600 },
)
console.log(JSON.stringify({ root, config, course: "ECON903" }))
