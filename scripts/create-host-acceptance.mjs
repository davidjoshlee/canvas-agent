import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

// Synthetic maintainer fixture only. Retain it for independent host acceptance;
// no live account, user config, credential, student vault or publication access.
const mode = process.argv[2]
assert(["ordinary-prep", "frozen-draft"].includes(mode), "Choose ordinary-prep or frozen-draft")
const checkout = resolve(import.meta.dirname, "..")
const root = await mkdtemp(join(tmpdir(), `canvas-host-${mode}-`))
const vault = join(root, "vault")
const config = join(root, "config.json")
const home = join(root, "home")
await mkdir(home)
const env = Object.fromEntries(
  ["PATH", "SystemRoot", "COMSPEC", "PATHEXT"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
)
env.HOME = home
env.TMPDIR = root
function cli(args) {
  const result = spawnSync(
    process.execPath,
    [join(checkout, "dist/cli.js"), ...args, "--config", config, "--json"],
    { cwd: root, env, encoding: "utf8", timeout: 30_000, maxBuffer: 5_000_000 },
  )
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
cli(["init", "--vault", vault, "--canvas-url", "https://canvas.example.invalid"])
for (const [fixture, path] of [
  ["prompt.md", "ECON901/Assignments/launch.md"],
  ["case.md", "ECON901/Week 02 - Oct 12/launch-case.md"],
  ["marginal-analysis.md", "ECON901/Week 02 - Oct 12/marginal-analysis.md"],
  ["course-guidance.md", "ECON901/Guidance/course-guidance.md"],
  ["assignment-guidance.md", "ECON901/Guidance/assignment-50.md"],
]) {
  const destination = join(vault, path)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(join(checkout, "test/fixtures/host-numeric", fixture), destination)
}
let task
if (mode === "ordinary-prep") task = cli(["prep", "ECON901", "--week", "2026-10-12"])
else {
  const capture = cli(["simulate", "capture", "ECON901", "--as-of", "2026-10-13"])
  task = cli([
    "simulate",
    "task",
    "create",
    capture.id,
    "--kind",
    "assignment",
    "--source",
    "ECON901/Assignments/launch.md",
    "--mode",
    "draft",
    "--context",
    "ECON901/Week 02 - Oct 12/launch-case.md",
  ])
}
const baseline = []
async function inventory(folder, relative = "") {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(relative, entry.name)
    if (entry.isDirectory()) await inventory(join(folder, entry.name), path)
    else {
      assert(entry.isFile())
      baseline.push({
        path,
        hash: createHash("sha256")
          .update(await readFile(join(folder, entry.name)))
          .digest("hex"),
      })
    }
  }
}
await inventory(vault)
await writeFile(
  join(root, "baseline.json"),
  JSON.stringify({ mode, taskId: task.id, files: baseline }, null, 2),
  { flag: "wx" },
)
console.log(
  JSON.stringify(
    {
      mode,
      root,
      config,
      vault,
      course: "ECON901",
      week: "2026-10-12",
      checkout,
      baselineFiles: baseline.length,
    },
    null,
    2,
  ),
)
