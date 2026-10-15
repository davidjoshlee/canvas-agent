import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"

// Explicit authenticated operator test only. Read login metadata, never secrets.
// A new ephemeral read-only host must discover old work without supplied IDs.
const [codexHome, fixtureRoot, upgrade] = process.argv.slice(2)
const resumePending = process.argv.includes("--resume-pending")
assert(
  !resumePending || upgrade === "--current-cli",
  "Pending authoring recovery requires a current CLI in a separate workspace",
)
assert(
  upgrade === undefined || upgrade === "--current-cli",
  "Optional third argument must be --current-cli",
)
assert(
  codexHome && fixtureRoot,
  "Supply the authorized isolated Codex home and completed native fixture",
)
const temp = await realpath(tmpdir())
const home = await realpath(codexHome)
const root = await realpath(fixtureRoot)
assert(
  basename(home) === "codex-home" && dirname(home).startsWith(`${temp}${sep}canvas-codex-plugin-`),
  "Only the authorized temporary Codex home is permitted",
)
assert(
  dirname(root) === temp &&
    /^canvas-host-(ordinary-prep|frozen-draft)-[A-Za-z0-9]+$/.test(basename(root)),
  "Only an owned native academic fixture is permitted",
)
const login = await lstat(join(home, "auth.json"))
assert(
  login.isFile() && !login.isSymbolicLink() && (login.mode & 0o077) === 0,
  "Private native login required; do not copy credentials",
)
async function metadata(path) {
  const stat = await lstat(path)
  assert(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16_384,
    "Unsafe synthetic fixture metadata",
  )
  return JSON.parse(await readFile(path, "utf8"))
}
const installation = await metadata(join(root, "native-installation.json"))
const completed = await metadata(join(root, "native-process-result.json"))
let interruption
if (resumePending) {
  interruption = await metadata(join(root, "native-interruption.json"))
  assert(
    interruption.status === "pass" &&
      completed.signal === "SIGKILL" &&
      interruption.pendingTaskPreserved === true &&
      interruption.stopped?.taskStatus === "pending",
    "Only a verified interrupted pending fixture can resume authoring",
  )
  assert.equal(
    await realpath(interruption.stopped.candidate),
    join(root, "interrupted-candidate.md"),
  )
} else
  assert.equal(
    completed.exitCode,
    0,
    "The original native host must already be terminal and successful",
  )
assert(["ordinary-prep", "frozen-draft"].includes(installation.mode))
assert(
  !resumePending || installation.mode === "ordinary-prep",
  "Pending recovery currently tests ordinary prep only",
)
assert.equal(await realpath(installation.codexHome), home)
let cli = join(root, "installed-cli/node_modules/canvas-agent/dist/cli.js")
assert.equal(await realpath(installation.cli), await realpath(cli))
const configPath = join(root, "config.json")
const config = await metadata(configPath)
assert.equal(config.canvas.baseUrl, "https://canvas.example.invalid")
assert.deepEqual(config.courses.allowlist, [])
const vault = await realpath(resolve(root, config.vault.path))
assert.equal(vault, join(root, "vault"))
async function inventory(folder, relative = "", result = []) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(relative, entry.name)
    if (entry.isDirectory()) await inventory(join(folder, entry.name), path, result)
    else {
      assert(entry.isFile(), "Unsafe synthetic vault entry")
      assert(result.length < 5000, "Synthetic recovery inventory exceeds bounds")
      const file = join(folder, entry.name)
      assert((await lstat(file)).size <= 5 * 1024 * 1024, "Synthetic recovery file exceeds bounds")
      result.push({
        path,
        hash: createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      })
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path))
}
const before = await inventory(vault)
const runRoot = await mkdtemp(join(root, "native-recovery-"))
if (upgrade) {
  const checkout = resolve(import.meta.dirname, "..")
  const install = join(runRoot, "cli-installation")
  await mkdir(install)
  await writeFile(join(install, "package.json"), JSON.stringify({ private: true }), {
    flag: "wx",
    mode: 0o600,
  })
  const npmrc = join(runRoot, "empty.npmrc")
  await writeFile(npmrc, "", { flag: "wx", mode: 0o600 })
  const env = { PATH: process.env.PATH, HOME: join(dirname(home), "os-home"), TMPDIR: runRoot }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"
  const options = [
    "--userconfig",
    npmrc,
    "--cache",
    join(runRoot, "npm-cache"),
    "--registry",
    "https://registry.npmjs.org",
  ]
  const packed = spawnSync(
    npm,
    ["pack", "--ignore-scripts", "--json", "--pack-destination", install, ...options],
    { cwd: checkout, env, encoding: "utf8", timeout: 60_000, maxBuffer: 10_000_000 },
  )
  assert.equal(packed.status, 0, "Packing current CLI failed")
  const pack = JSON.parse(packed.stdout)[0]
  const installed = spawnSync(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      join(install, pack.filename),
      ...options,
    ],
    { cwd: install, env, encoding: "utf8", timeout: 60_000, maxBuffer: 10_000_000 },
  )
  assert.equal(installed.status, 0, "Installing current CLI failed")
  cli = join(install, "node_modules/canvas-agent/dist/cli.js")
  await cp(join(checkout, "AGENTS.md"), join(runRoot, "AGENTS.md"), {
    errorOnExist: true,
    force: false,
  })
  await writeFile(
    join(runRoot, "upgrade-installation.json"),
    JSON.stringify(
      {
        cli,
        version: pack.version,
        integrity: pack.integrity,
        originalCli: installation.cli,
        originalInstallationReplaced: false,
        pluginCacheChangedByThisRun: false,
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  )
}
const workspace = upgrade ? runRoot : root
let pendingTask
if (resumePending) {
  assert.match(interruption.stopped.taskId, /^[a-f0-9-]{36}$/)
  const taskPath = join(vault, "_meta/tasks", interruption.stopped.taskId, "task.json")
  const taskStat = await lstat(taskPath)
  assert(taskStat.isFile() && !taskStat.isSymbolicLink() && taskStat.size < 1_000_000)
  pendingTask = JSON.parse(await readFile(taskPath, "utf8"))
  assert(
    pendingTask.id === interruption.stopped.taskId &&
      pendingTask.status === "pending" &&
      pendingTask.kind === "prep",
  )
  assert(
    pendingTask.destination.startsWith("ECON901/") &&
      !pendingTask.destination
        .split(/[\\/]/)
        .some((part) => !part || part === "." || part === ".." || part.startsWith("_")),
  )
  await mkdir(join(vault, pendingTask.destination), { recursive: true })
}
let matchingPluginCache = false
if (installation.requireCurrentPlugin === true) {
  const cache = await realpath(installation.pluginEvidence.cache)
  assert(
    cache.startsWith(
      `${home}${sep}plugins${sep}cache${sep}canvas-agent-tools${sep}canvas-agent${sep}`,
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
  for (const path of files)
    assert.deepEqual(
      await readFile(join(cache, path)),
      await readFile(join(dirname(dirname(cli)), "plugins/canvas-agent", path)),
      "Isolated plugin and selected CLI guidance do not match",
    )
  matchingPluginCache = true
}
await writeFile(
  join(runRoot, "plugin-evidence.json"),
  JSON.stringify({
    matchingPluginCache,
    pluginCacheChangedByThisRun: false,
    realRequestInjectionVerified: false,
  }),
  { flag: "wx", mode: 0o600 },
)
const frozen = installation.mode === "frozen-draft"
const prompt = `$canvas-agent:${frozen ? "assignment-workflow" : "canvas-workspace"} This is an authorized synthetic engineering recovery test, not real coursework. You are a new read-only session, with no supplied task IDs, capture IDs, previous answers or previous transcript. Explicit course ECON901, ${frozen ? "frozen assignment launch.md, Part 2 draft scope" : "ordinary prep, week 2026-10-12"}. Use the installed CLI node ${cli}, always --config ${configPath} --json. ${upgrade ? "This is a new student workspace using the current CLI package with old saved work. Discover its installed instruction paths before inspecting work; do not assume checkout-relative paths exist. The previously authorized plugin cache has not been refreshed, so do not claim matching active plugin bytes." : ""} Discover the existing completed ${frozen ? "frozen draft and capture" : "prep task"} through the appropriate saved metadata listing; inspect its original saved task, source bindings, output and existing arithmetic evidence. Read the actual saved output and report what was recovered, exact IDs/paths, quantitative conclusions, state, limitations and any failed step. Use read-only numeric diagnostics with the saved output if helpful. Confirm saved permission only as synthetic context, not permission for new generation. Do not create, recalculate, complete, save, revise, approve, repair, capture, sync, submit or regenerate anything. No filesystem writes by model tools, no network tool calls, real vault or credentials. Do not read baseline.json, native-*.json/jsonl/txt, any earlier candidate, calculations batch, report or prior host artifacts outside vault. You may read project AGENTS, installed CLI/plugin references and the synthetic config. Native runtime alone may use its login; never inspect Codex auth files. Return the recovery report in your final reply only. This is saved-work recovery, not proof of academic correctness, independent review or actual mid-generation goal-controller recovery.`
const truthfulPrompt = prompt.replace(
  "The previously authorized plugin cache has not been refreshed, so do not claim matching active plugin bytes.",
  matchingPluginCache
    ? "The isolated active plugin cache has been byte-checked against this installed CLI's packaged guidance."
    : "Plugin-cache freshness is unverified in this run; do not claim matching active plugin bytes.",
)
const effectivePrompt = resumePending
  ? `$canvas-agent:canvas-workspace Authorized synthetic engineering recovery test, not real coursework. You are a fresh authoring session in a new student workspace. Explicit course ECON901, week 2026-10-12, ordinary prep. An earlier host was interrupted before completing a saved task. No task ID, prior answer or transcript is supplied. Use node ${cli}, always --config ${configPath} --json. Discover installed instruction paths and the existing pending task through CLI metadata. Read the full saved workflow, sources and synthetic permission, then author a finished brief answering every scoped question and complete THAT SAME task. Execute all derived arithmetic and check-numbers before completion. Preserve source files, guidance, task identity and saved history. No new task/capture, revision, approval, sync, submission or network tools. Never read baseline.json, native-* files, prior candidates, old batch/report artifacts outside vault, or any Codex auth/credential files. Only the native runtime may use its login. Write a NEW candidate and any batch files inside this new current workspace using apply_patch; never edit the interrupted host workspace or its prior candidate. Use CLI commands alone for necessary saved calculations/completion files inside the explicitly writable private metadata and Prep folders. Report recovered ID, output, limitations and EVERY failed step. Validation is not a grade or actual-course permission. This is host-process recovery, not proof that a goal controller was paused.`
  : `${truthfulPrompt}${upgrade ? " Retrieve the saved text using the appropriate read-only task output command through this installed CLI. Do not substitute filesystem path guesses for that command's actual result. Distinguish output byte integrity from academic correctness and report every failed step." : ""}`
await writeFile(join(runRoot, "prompt.txt"), effectivePrompt, { flag: "wx", mode: 0o600 })
const output = await open(join(runRoot, "events.jsonl"), "wx", 0o600)
const errors = await open(join(runRoot, "stderr.txt"), "wx", 0o600)
const args = [
  "exec",
  "--skip-git-repo-check",
  "--ephemeral",
  "--json",
  "--model",
  "gpt-6-luna",
  "--sandbox",
  resumePending ? "workspace-write" : "read-only",
  ...(resumePending
    ? ["--add-dir", join(vault, "_meta"), "--add-dir", join(vault, pendingTask.destination)]
    : []),
  "-c",
  'approval_policy="never"',
  "-c",
  'cli_auth_credentials_store="file"',
  "-C",
  workspace,
  "-o",
  join(runRoot, "final.txt"),
  effectivePrompt,
]
console.log(
  JSON.stringify({ root, runRoot, mode: installation.mode, model: "gpt-6-luna", started: true }),
)
const child = spawn("codex", args, {
  cwd: workspace,
  env: {
    PATH: process.env.PATH,
    HOME: join(dirname(home), "os-home"),
    CODEX_HOME: home,
    TMPDIR: runRoot,
  },
  stdio: ["ignore", output.fd, errors.fd],
})
const timer = setTimeout(() => child.kill("SIGTERM"), 300_000)
const result = await new Promise((done, reject) => {
  child.once("error", reject)
  child.once("exit", (exitCode, signal) => done({ exitCode, signal }))
})
clearTimeout(timer)
await output.close()
await errors.close()
const after = await inventory(vault)
const unchanged = JSON.stringify(before) === JSON.stringify(after)
let resumeEvidence = null
if (resumePending) {
  const current = JSON.parse(
    await readFile(join(vault, "_meta/tasks", pendingTask.id, "task.json"), "utf8"),
  )
  const safeOutput =
    typeof current.output === "string" &&
    current.output.startsWith(`${pendingTask.destination}/`) &&
    !current.output.split(/[\\/]/).some((part) => part === ".." || part.startsWith("_"))
  const savedHash = safeOutput
    ? createHash("sha256")
        .update(await readFile(join(vault, current.output)))
        .digest("hex")
    : null
  const preserved = interruption.comparisons
    .filter((entry) => !entry.path.endsWith("/task.json"))
    .every(
      (entry) =>
        before.find((item) => item.path === entry.path)?.hash ===
        after.find((item) => item.path === entry.path)?.hash,
    )
  const priorCandidateHash = createHash("sha256")
    .update(await readFile(join(root, "interrupted-candidate.md")))
    .digest("hex")
  resumeEvidence = {
    sameTaskId: current.id === pendingTask.id,
    status: current.status,
    output: current.output,
    outputHash: current.outputHash,
    outputHashVerified: safeOutput && savedHash === current.outputHash,
    baselineSourcesAndHandoffPreserved: preserved,
    priorCandidatePreserved: priorCandidateHash === interruption.stopped.candidateHash,
    goalControllerPaused: false,
  }
}
await writeFile(
  join(runRoot, "result.json"),
  JSON.stringify(
    { ...result, vaultUnchanged: unchanged, resumePending, resumeEvidence, before, after },
    null,
    2,
  ),
  { flag: "wx", mode: 0o600 },
)
console.log(
  JSON.stringify({
    ...result,
    runRoot,
    vaultUnchanged: unchanged,
    vaultFiles: before.length,
    resumeEvidence,
  }),
)
process.exitCode = resumePending
  ? result.exitCode === 0 &&
    resumeEvidence.sameTaskId &&
    resumeEvidence.status === "completed" &&
    resumeEvidence.outputHashVerified &&
    resumeEvidence.baselineSourcesAndHandoffPreserved &&
    resumeEvidence.priorCandidatePreserved
    ? 0
    : 1
  : unchanged
    ? (result.exitCode ?? 1)
    : 1
