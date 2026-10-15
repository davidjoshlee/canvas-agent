import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, writeSync } from "node:fs"
import { cp, lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { StringDecoder } from "node:string_decoder"

// Explicitly authenticated, synthetic-only native host acceptance. Credentials
// stay in a separately logged-in Codex home, never copied or read by this script.
const [codexHome, mode = "frozen-review"] = process.argv.slice(2)
const interruptAfterCandidate = process.argv.includes("--interrupt-after-candidate")
assert(
  !interruptAfterCandidate ||
    (mode === "ordinary-prep" &&
      process.argv.includes("--require-current-plugin") &&
      process.platform !== "win32"),
  "Candidate interruption requires current-plugin ordinary prep on a POSIX host",
)
assert(
  ["frozen-review", "ordinary-prep", "frozen-draft"].includes(mode),
  "Choose frozen-review, ordinary-prep or frozen-draft",
)
assert(codexHome?.includes("canvas-codex-plugin-"), "Supply the owned isolated Codex home")
const canonicalHome = await realpath(codexHome)
assert(
  basename(canonicalHome) === "codex-home" &&
    dirname(canonicalHome).startsWith(`${await realpath(tmpdir())}${sep}canvas-codex-plugin-`),
  "Only the separately authorized temporary Codex home is permitted",
)
const credentialStat = await lstat(join(canonicalHome, "auth.json"))
assert(
  credentialStat.isFile() &&
    !credentialStat.isSymbolicLink() &&
    (credentialStat.mode & 0o077) === 0,
  "A private native login is required; do not copy credentials",
)
const checkout = resolve(import.meta.dirname, "..")
const built = spawnSync(
  process.execPath,
  mode === "frozen-review"
    ? [join(checkout, "scripts/create-correctness-host-acceptance.mjs"), "--frozen"]
    : [join(checkout, "scripts/create-host-acceptance.mjs"), mode],
  { encoding: "utf8", timeout: 30_000 },
)
assert.equal(built.status, 0, "Synthetic fixture creation failed")
const fixture = JSON.parse(built.stdout)
const root = fixture.root
await cp(join(checkout, "AGENTS.md"), join(root, "AGENTS.md"), { errorOnExist: true, force: false })
const install = join(root, "installed-cli")
await mkdir(install)
await writeFile(join(install, "package.json"), JSON.stringify({ private: true }), {
  flag: "wx",
  mode: 0o600,
})
const env = {
  PATH: process.env.PATH,
  HOME: join(dirname(codexHome), "os-home"),
  CODEX_HOME: codexHome,
  TMPDIR: root,
}
const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const pack = spawnSync(npm, ["pack", "--json", "--pack-destination", install], {
  cwd: checkout,
  env,
  encoding: "utf8",
  timeout: 60_000,
  maxBuffer: 10_000_000,
})
assert.equal(pack.status, 0, "Packing CLI failed")
const packed = JSON.parse(pack.stdout)[0]
const installed = spawnSync(
  npm,
  [
    "install",
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    join(install, packed.filename),
  ],
  { cwd: install, env, encoding: "utf8", timeout: 60_000, maxBuffer: 10_000_000 },
)
assert.equal(installed.status, 0, "Isolated CLI install failed")
const cli = join(install, "node_modules/canvas-agent/dist/cli.js")
const requireCurrentPlugin = process.argv.includes("--require-current-plugin")
let pluginEvidence = null
if (requireCurrentPlugin) {
  const plugin = join(checkout, "plugins/canvas-agent")
  const version = JSON.parse(await readFile(join(plugin, "plugin.json"), "utf8")).version
  assert.match(version, /^[A-Za-z0-9.+_-]{1,80}$/)
  const cache = await realpath(
    join(canonicalHome, "plugins/cache/canvas-agent-tools/canvas-agent", version),
  )
  assert(
    cache.startsWith(
      `${canonicalHome}${sep}plugins${sep}cache${sep}canvas-agent-tools${sep}canvas-agent${sep}`,
    ),
  )
  const files = [
    ".codex-plugin/plugin.json",
    "plugin.json",
    "references/cli.md",
    "references/workflows.md",
    "skills/assignment-workflow/SKILL.md",
    "skills/canvas-workspace/SKILL.md",
    "skills/setup-and-sync/SKILL.md",
  ]
  const hashes = []
  for (const path of files) {
    const source = await readFile(join(plugin, path))
    assert.deepEqual(
      await readFile(join(cache, path)),
      source,
      "Refresh the isolated plugin before running matching-cache acceptance",
    )
    assert.deepEqual(
      await readFile(join(install, "node_modules/canvas-agent/plugins/canvas-agent", path)),
      source,
      "Installed CLI guidance differs from the current plugin",
    )
    hashes.push({ path, hash: createHash("sha256").update(source).digest("hex") })
  }
  assert.deepEqual(
    await readFile(join(root, "AGENTS.md")),
    await readFile(join(install, "node_modules/canvas-agent/AGENTS.md")),
  )
  pluginEvidence = {
    cache,
    files: hashes,
    cacheMatchesSourceAndInstalledCli: true,
    workspaceAgentsMatchesInstalledCli: true,
    realRequestInjectionVerified: false,
  }
}
const shared = `This is an authorized synthetic engineering acceptance test, not real coursework. The current directory is a student workspace, not the toolkit development repository. Use the installed Canvas Agent CLI: node ${cli}, always --config ${fixture.config} --json. You are not supplied IDs or expected answers. Confirm the saved synthetic permission before authoring. Read the full saved workflow, source bodies and guidance. No replacement capture/task, revision, approval, M1 pass, Canvas/network tool calls, real vault, credentials, or submission. Do not inspect removed-live-course, baseline.json, fixture-building source or any credential/Codex auth files. Only the native runtime may use its login. Preserve original sources and saved history. Author candidates and a short report outside vault within this workspace using apply_patch; let the CLI save the completed artifact. Use the installed skill and applicable detailed references; do not manually load a skill from the toolkit source checkout. Validation is not an academic grade. Report discovered IDs, saved paths, calculations, limitations and every failed step.`
const basePrompt =
  mode === "frozen-review"
    ? `$canvas-agent:assignment-workflow ${shared} Explicit course ECON903, frozen scope. Discover the existing completed frozen draft and capture, then prepare its separate frozen correctness-review handoff and author/save a substantive review after reading the draft and calculation evidence. No ordinary review task or new draft. Only new private correctness review files go inside vault; keep all original vault bytes. Review claims are not an authenticated independent reviewer.`
    : mode === "ordinary-prep"
      ? `$canvas-agent:canvas-workspace ${shared} Explicit course ECON901, week 2026-10-12. Discover the existing pending ordinary prep task, author a finished prep brief following that task's exact requirements and answer all preparation questions, then complete the same task. Execute every derived numeric result, including intermediates and prose comparisons, with calculate and run check-numbers before completion. Do not create a new prep task.`
      : `$canvas-agent:assignment-workflow ${shared} Explicit course ECON901, assignment launch.md, draft mode, frozen scope. Discover the existing capture and pending frozen assignment draft task. Author the actual complete permitted Part 2 deliverable following its exact saved requirements, then complete the same frozen task. Execute every derived numeric result, including intermediates and prose comparisons, with frozen calculations and run the frozen numeric check before completion. No ordinary assignment task or new capture/draft.`
const interruptedCandidate = join(root, "interrupted-candidate.md")
const prompt = `${basePrompt}${interruptAfterCandidate ? ` Write the proposed brief using apply_patch at ${interruptedCandidate} before invoking candidate validation or task completion; do not combine authoring and CLI completion in a single tool call.` : ""}`
await writeFile(join(root, "native-prompt.txt"), prompt, { flag: "wx", mode: 0o600 })
await writeFile(
  join(root, "native-installation.json"),
  JSON.stringify(
    {
      version: packed.version,
      cli,
      requestedModel: "gpt-6-luna",
      codexHome,
      realModelRequested: true,
      mode,
      requireCurrentPlugin,
      pluginEvidence,
      interruptAfterCandidate,
    },
    null,
    2,
  ),
  { flag: "wx", mode: 0o600 },
)
const output = await open(join(root, "native-events.jsonl"), "wx", 0o600)
const errors = await open(join(root, "native-stderr.txt"), "wx", 0o600)
const args = [
  "exec",
  "--skip-git-repo-check",
  "--json",
  "--model",
  "gpt-6-luna",
  "--sandbox",
  "workspace-write",
  "-c",
  'approval_policy="never"',
  "-c",
  'cli_auth_credentials_store="file"',
  "-C",
  root,
  "-o",
  join(root, "native-final.txt"),
  prompt,
]
console.log(
  JSON.stringify({
    root,
    mode,
    model: "gpt-6-luna",
    installedCliVersion: packed.version,
    started: true,
  }),
)
const child = spawn("codex", args, {
  cwd: root,
  env,
  detached: interruptAfterCandidate,
  stdio: ["ignore", interruptAfterCandidate ? "pipe" : output.fd, errors.fd],
})
let stopped = null,
  pending = ""
const decoder = new StringDecoder("utf8")
if (interruptAfterCandidate)
  child.stdout.on("data", (chunk) => {
    let offset = 0
    while (offset < chunk.length)
      offset += writeSync(output.fd, chunk, offset, chunk.length - offset)
    pending += decoder.write(chunk)
    while (pending.includes("\n")) {
      const end = pending.indexOf("\n")
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (
        !stopped &&
        event.type === "item.completed" &&
        event.item?.type === "file_change" &&
        event.item.status === "completed" &&
        event.item.changes?.some((change) => resolve(root, change.path) === interruptedCandidate)
      ) {
        const baseline = JSON.parse(readFileSync(join(root, "baseline.json"), "utf8"))
        const task = JSON.parse(
          readFileSync(join(root, "vault/_meta/tasks", baseline.taskId, "task.json"), "utf8"),
        )
        stopped = {
          taskId: task.id,
          taskStatus: task.status,
          eventId: event.item.id,
          candidate: interruptedCandidate,
          candidateHash: createHash("sha256")
            .update(readFileSync(interruptedCandidate))
            .digest("hex"),
          trigger: "completed-candidate-file-change",
        }
        process.kill(-child.pid, "SIGKILL")
      }
    }
  })
const timer = setTimeout(
  () => (interruptAfterCandidate ? process.kill(-child.pid, "SIGTERM") : child.kill("SIGTERM")),
  300_000,
)
const result = await new Promise((done, reject) => {
  child.once("error", reject)
  child.once("close", (exitCode, signal) => done({ exitCode, signal }))
})
clearTimeout(timer)
await output.close()
await errors.close()
await writeFile(join(root, "native-process-result.json"), JSON.stringify(result), {
  flag: "wx",
  mode: 0o600,
})
console.log(JSON.stringify({ ...result, root, transcriptStoredPrivately: true }))
if (interruptAfterCandidate) {
  const baseline = JSON.parse(await readFile(join(root, "baseline.json"), "utf8"))
  const comparisons = await Promise.all(
    baseline.files.map(async (entry) => ({
      path: entry.path,
      unchanged:
        createHash("sha256")
          .update(await readFile(join(root, "vault", entry.path)))
          .digest("hex") === entry.hash,
    })),
  )
  const task = JSON.parse(
    await readFile(join(root, "vault/_meta/tasks", baseline.taskId, "task.json"), "utf8"),
  )
  const pass =
    result.signal === "SIGKILL" &&
    stopped?.taskStatus === "pending" &&
    task.status === "pending" &&
    comparisons.every((entry) => entry.unchanged)
  await writeFile(
    join(root, "native-interruption.json"),
    JSON.stringify(
      {
        status: pass ? "pass" : "fail",
        stopped,
        result,
        comparisons,
        pendingTaskPreserved: task.status === "pending",
        goalControllerPaused: false,
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  )
  console.log(
    JSON.stringify({
      root,
      interruptionStatus: pass ? "pass" : "fail",
      taskId: task.id,
      taskStatus: task.status,
    }),
  )
  process.exitCode = pass ? 0 : 1
} else process.exitCode = result.exitCode ?? 1
