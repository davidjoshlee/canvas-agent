import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { INSTRUCTION_FILE_MAX_BYTES } from "../dist/cli/instruction-policy.js"
import { runInstalledAcademicWorkflowSmoke } from "./lib/package-smoke-academic.mjs"

// Exercise an actual npm package and executable outside the checkout. All CLI
// inputs are synthetic/offline; registry installation is the only network step.
const checkout = resolve(import.meta.dirname, "..")
const root = await mkdtemp(join(tmpdir(), "canvas-agent-package-"))
const env = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "SystemRoot", "COMSPEC", "PATHEXT"]
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
)
const commands = []
const journal = join(root, "commands.jsonl")
let sequence = 0
let succeeded = false
function execute(executable, args, options) {
  const id = ++sequence
  const started = Date.now()
  const record = (entry) =>
    appendFileSync(journal, `${JSON.stringify({ id, ...entry })}\n`, { mode: 0o600 })
  record({
    event: "started",
    executable,
    args: args.map((arg) =>
      arg.length > 512
        ? { bytes: Buffer.byteLength(arg), sha256: createHash("sha256").update(arg).digest("hex") }
        : arg,
    ),
    cwd: options.cwd,
  })
  const result = spawnSync(executable, args, options)
  record({
    event: "finished",
    elapsedMs: Date.now() - started,
    status: result.status,
    signal: result.signal,
    errorCode: result.error?.code ?? null,
  })
  return result
}
function run(executable, args, cwd, status = 0, extraEnv = {}) {
  const result = execute(executable, args, {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 10_000_000,
  })
  if (result.error) throw result.error
  assert.equal(result.status, status, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`)
  return result.stdout
}
function block(text, name) {
  const start = `<!-- canvas-agent-${name}:start -->`
  const end = `<!-- canvas-agent-${name}:end -->`
  assert(text.includes(start) && text.includes(end), `Missing ${name} instruction block`)
  return text.slice(text.indexOf(start) + start.length, text.indexOf(end)).trim()
}
try {
  assert.deepEqual(
    JSON.parse(await readFile(join(checkout, "npm-shrinkwrap.json"), "utf8")),
    JSON.parse(await readFile(join(checkout, "package-lock.json"), "utf8")),
    "Published shrinkwrap and development lock differ; update both before packaging",
  )
  const installation = join(root, "installation")
  const workspace = join(root, "student-workspace")
  await mkdir(installation)
  await mkdir(workspace)
  const userconfig = join(root, "empty.npmrc")
  await writeFile(userconfig, "")
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"
  const npmConfig = [
    "--userconfig",
    userconfig,
    "--cache",
    join(root, "npm-cache"),
    "--registry",
    "https://registry.npmjs.org",
  ]
  const packed = JSON.parse(
    run(
      npm,
      ["pack", "--ignore-scripts", "--json", "--pack-destination", root, ...npmConfig],
      checkout,
    ),
  )[0]
  assert(
    packed.files.every(({ path }) => !/^(?:tools\/|dist\/evaluation\/)/.test(path)),
    "Development evaluation tooling leaked into the package",
  )
  assert(
    packed.files.every(
      ({ path }) =>
        !/^dist\/(?:student\/reminders|auth\/alerts|canvas\/sync-workflow)\.(?:js|d\.ts)$/.test(
          path,
        ),
    ),
    "Retired runtime modules leaked into the package",
  )
  const bundledRoots = new Set(packed.bundled.map((name) => `node_modules/${name}/`))
  const packagedDocs = new Set(["docs/ARCHITECTURE.md", "docs/PLUGIN.md", "docs/DEVELOPMENT.md"])
  assert(
    packed.files.every(({ path }) => !path.startsWith("docs/") || packagedDocs.has(path)),
    "Historical reports or unexpected documents leaked into the package",
  )
  assert(
    packed.files.every(
      ({ path }) =>
        !/^dist\/(?:migration|root-migration|index-reconciliation|school-index|preservation-migration|legacy)[^/]*\.(?:js|d\.ts)$/.test(
          path,
        ),
    ),
    "Removed compatibility modules leaked into generated output",
  )
  assert(bundledRoots.has("node_modules/mammoth/"), "Word reader was not bundled")
  assert(!bundledRoots.has("node_modules/sprintf-js/"), "Vulnerable formatter was bundled")
  assert(
    packed.files.every(
      ({ path }) =>
        /^(?:dist\/|plugins\/canvas-agent\/|docs\/|AGENTS\.md$|CONTRACT\.md$|README\.md$|LICENSE$|package\.json$|npm-shrinkwrap\.json$)/.test(
          path,
        ) || [...bundledRoots].some((prefix) => path.startsWith(prefix)),
    ),
    "Package contains an unexpected file",
  )
  assert(
    packed.files.some(({ path }) => path === "npm-shrinkwrap.json"),
    "CLI dependency shrinkwrap missing from package",
  )
  await writeFile(join(installation, "package.json"), JSON.stringify({ private: true }))
  run(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      join(root, packed.filename),
      ...npmConfig,
    ],
    installation,
  )
  const installed = join(installation, "node_modules/canvas-agent")
  const audit = JSON.parse(run(npm, ["audit", "--omit=dev", "--json", ...npmConfig], installation))
  assert.equal(audit.metadata.vulnerabilities.total, 0, "Installed dependency audit is not clean")
  const dependencyCheck = `const {createRequire}=require("node:module"); const own=createRequire(${JSON.stringify(join(installed, "package.json"))}); const word=createRequire(own.resolve("mammoth/package.json")); if(word("argparse/package.json").version!=="2.0.1") throw new Error("Installed argparse version differs"); try {word.resolve("sprintf-js"); throw new Error("Vulnerable formatter still installed")} catch(error) {if(error.code!=="MODULE_NOT_FOUND") throw error}`
  run(process.execPath, ["-e", dependencyCheck], workspace)
  const mammothBin = run(
    process.execPath,
    [
      "-e",
      `const {createRequire}=require("node:module"); const own=createRequire(${JSON.stringify(join(installed, "package.json"))}); console.log(own.resolve("mammoth/bin/mammoth"))`,
    ],
    workspace,
  ).trim()
  assert(run(process.execPath, [mammothBin, "--help"], workspace).includes("docx-path"))
  const bin = join(
    installation,
    "node_modules/.bin",
    process.platform === "win32" ? "canvas-agent.cmd" : "canvas-agent",
  )
  assert(run(bin, ["--help"], workspace).includes("Usage: canvas-agent"))
  for (const args of [
    ["dogfood"],
    ["simulate", "window"],
    ["simulate", "compare"],
    ["gate", "m1"],
    ["reminders"],
    ["auth", "alerts"],
    ["sync", "--notify-due-soon"],
    ["sync", "--lead-days", "7"],
  ]) {
    commands.push(`${args.join(" ")} unavailable in installed CLI`)
    run(bin, args, workspace, 1)
  }
  const canonical = await readFile(
    join(installed, "plugins/canvas-agent/references/cli.md"),
    "utf8",
  )
  assert.equal(
    canonical,
    await readFile(join(checkout, "plugins/canvas-agent/references/cli.md"), "utf8"),
  )
  const core = block(canonical, "cli")
  const fullWorkflowPath = "plugins/canvas-agent/references/workflows.md"
  assert.equal(
    await readFile(join(installed, fullWorkflowPath), "utf8"),
    await readFile(join(checkout, fullWorkflowPath), "utf8"),
  )
  const agents = await readFile(join(installed, "AGENTS.md"), "utf8")
  assert(
    Buffer.byteLength(agents, "utf8") <= INSTRUCTION_FILE_MAX_BYTES,
    "Packaged AGENTS exceeds the file safety limit",
  )
  assert.equal(block(agents, "cli"), core)
  for (const [skill, workflows] of [
    ["setup-and-sync", []],
    ["canvas-workspace", ["prep"]],
    ["assignment-workflow", ["outline", "draft", "review", "discuss"]],
  ]) {
    const relative = `plugins/canvas-agent/skills/${skill}/SKILL.md`
    const text = await readFile(join(installed, relative), "utf8")
    assert(
      Buffer.byteLength(text, "utf8") <= INSTRUCTION_FILE_MAX_BYTES,
      "Packaged skill exceeds the file safety limit",
    )
    assert.equal(text, await readFile(join(checkout, relative), "utf8"))
    assert.equal(block(text, "cli"), core)
    for (const mode of workflows)
      assert.equal(block(text, `workflow:${mode}`), block(agents, `workflow:${mode}`))
  }
  await runInstalledAcademicWorkflowSmoke({
    root,
    installation,
    workspace,
    env,
    commands,
    run,
    execute,
    bin,
    packed,
  })
  succeeded = true
  console.log(
    JSON.stringify(
      {
        status: "pass",
        version: JSON.parse(await readFile(join(installed, "package.json"), "utf8")).version,
        commands: commands.length,
        installedVersionTested: true,
        removedCommandsRejected: true,
        installedInstructionDiscoveryTested: true,
        optionalLocalVaultHistoryTested: true,
        historyMetadataReadinessTested: true,
        configuredTaskArtifactLocationsTested: true,
        verifiedSavedOutputReadTested: true,
        packagedInstructionsMatch: true,
        boundedAgentEntrypointsTested: true,
        fullWorkflowReferenceBundled: true,
        separateDefaultVaultTested: true,
        vaultLocationPersistenceTested: true,
        savedTaskRecoveryDiscoveryTested: true,
        savedGuidanceRecoveryTested: true,
        feedbackGuidanceProposalInstalledTested: true,
        guidanceStructureInstalledTested: true,
        prepAnswerEvidenceInstalledTested: true,
        missingBriefRecoveryTested: true,
        developmentEvaluationExcluded: true,
        savedCaptureDiscoveryTested: true,
        savedFrozenTaskDiscoveryTested: true,
        harnessExecutionBoundaryTested: true,
        originalsUnchanged: true,
        noAutomaticDraftOrFrozenWorkbooksTested: true,
        derivedFixedCutoffTested: true,
        preservedNamespaceHomeworkTested: true,
        relatedDraftContinuityTested: true,
        numericMultipartInstalledTested: true,
        preservedIngestionInstalledTested: true,
        namedSpreadsheetInputTested: true,
        structuredHtmlInstalledTested: true,
        wordReaderDependencyAuditResolved: true,
        installedDependencyAuditFindings: audit.metadata.vulnerabilities.total,
        authoritativeBillingVerified: false,
        liveCanvasTested: false,
        installedHostPluginTested: false,
      },
      null,
      2,
    ),
  )
} finally {
  if (succeeded) await rm(root, { recursive: true, force: true })
  else console.error(JSON.stringify({ status: "failed", retainedSyntheticFixture: root, journal }))
}
