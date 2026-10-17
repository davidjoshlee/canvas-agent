import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync } from "node:fs"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import JSZip from "jszip"
import { INSTRUCTION_FILE_MAX_BYTES } from "../dist/cli/instruction-policy.js"

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
  const config = join(workspace, "private/config.json")
  commands.push("instructions without config")
  const instructions = JSON.parse(
    run(bin, ["instructions", "--config", config, "--json"], workspace),
  )
  assert.equal(instructions.packageVersion, packed.version)
  assert.equal(instructions.packageRoot, await realpath(installed))
  assert.equal(instructions.sharedCoreConsistent, true)
  assert.equal(instructions.contextInjectionVerified, false)
  assert.equal(instructions.instructionAuthenticityVerified, false)
  assert.equal(instructions.files.length, 6)
  for (const file of instructions.files) {
    assert.equal(file.path, await realpath(join(installed, file.relativePath)))
    const bytes = await readFile(file.path)
    assert.equal(file.bytes, bytes.length)
    assert.equal(file.sha256, createHash("sha256").update(bytes).digest("hex"))
  }
  commands.push("installed instruction topic without config")
  const topic = JSON.parse(
    run(bin, ["instructions", "--topic", "correctness", "--config", config, "--json"], workspace),
  )
  assert.equal(topic.lookup.completeReference, false)
  assert(topic.lookup.excerpts.length > 0)
  assert.deepEqual(topic.files, instructions.files)
  const reference = instructions.files.find((file) => file.id === "cli")
  const lines = (await readFile(reference.path, "utf8")).split("\n")
  for (const excerpt of topic.lookup.excerpts) {
    assert.equal(lines.slice(excerpt.startLine - 1, excerpt.endLine).join("\n"), excerpt.text)
    assert(excerpt.text.toLowerCase().includes("correctness"))
  }
  commands.push("installed instruction unknown topic refusal")
  run(bin, ["instructions", "--topic", "NO_SUCH_SYNTHETIC_TOPIC", "--json"], workspace, 1)
  commands.push("version without config")
  assert.equal(
    run(bin, ["--config", config, "--version"], workspace).trim(),
    JSON.parse(await readFile(join(installed, "package.json"), "utf8")).version,
  )
  for (const args of [
    ["calculate"],
    ["check-numbers"],
    ["workbook"],
    ["simulate", "task", "calculate"],
    ["simulate", "task", "check-numbers"],
    ["simulate", "task", "workbook"],
  ]) {
    commands.push(`retired execution command: ${args.join(" ")}`)
    run(bin, args, workspace, 1)
  }
  const vault = join(workspace, "vault")
  function cli(args, status = 0) {
    commands.push(args.slice(0, 2).join(" "))
    const stdout = run(bin, [...args, "--config", config, "--json"], workspace, status)
    return status === 0 ? JSON.parse(stdout) : stdout
  }
  const syntheticHome = join(root, "default-vault-home")
  const schoolVault = join(syntheticHome, "school-vault")
  await mkdir(schoolVault, { recursive: true })
  const schoolOriginal = "Synthetic School work remains separate.\n"
  await writeFile(join(schoolVault, "original.md"), schoolOriginal)
  commands.push("setup default-vault")
  const defaultSetup = JSON.parse(
    run(
      bin,
      [
        "setup",
        "--canvas-url",
        "https://canvas.example.test",
        "--config",
        join(root, "default-setup/config.json"),
        "--json",
      ],
      workspace,
      0,
      { HOME: syntheticHome },
    ),
  )
  assert.equal(defaultSetup.vault, join(syntheticHome, "canvas-vault"))
  assert.equal(await readFile(join(schoolVault, "original.md"), "utf8"), schoolOriginal)
  cli(["setup", "--canvas-url", "https://canvas.example.test", "--vault", vault])
  const initialLocation = cli(["vault", "location"])
  assert.equal(initialLocation.vault, vault)
  assert.equal(initialLocation.exists, true)
  assert.equal(initialLocation.config, config)
  const alternateVault = join(workspace, "alternate vault")
  await mkdir(alternateVault)
  const originalMarker = join(vault, ".location-original")
  const alternateMarker = join(alternateVault, ".location-alternate")
  await writeFile(originalMarker, "Original files remain here.\n")
  await writeFile(alternateMarker, "Alternate files remain here.\n")
  const envBeforeLocation = await readFile(join(workspace, "private/.env"))
  const changedLocation = cli(["vault", "location", "--set", alternateVault])
  assert.equal(changedLocation.vault, alternateVault)
  assert.equal(cli(["config", "show"]).vault, alternateVault)
  assert.equal(cli(["vault", "location"]).vault, alternateVault)
  assert.equal(await readFile(originalMarker, "utf8"), "Original files remain here.\n")
  assert.equal(await readFile(alternateMarker, "utf8"), "Alternate files remain here.\n")
  await assert.rejects(stat(join(alternateVault, ".location-original")), { code: "ENOENT" })
  const configBeforeBadLocation = await readFile(config)
  cli(["vault", "location", "--set", join(workspace, "missing-vault")], 1)
  assert.deepEqual(await readFile(config), configBeforeBadLocation)
  cli(["vault", "location", "--set", vault])
  assert.deepEqual(await readFile(join(workspace, "private/.env")), envBeforeLocation)
  cli(["config", "validate"])
  cli(["doctor", "--offline"])
  assert.equal(cli(["sync", "--full", "--preserve-school"]).fullRequested, true)
  cli(["auth", "status"])
  cli(["auth", "verify"], 1) // Missing token must fail before any HTTP request.
  const usageFile = join(workspace, "host-usage.json")
  const usage = JSON.stringify({
    version: 1,
    host: "Synthetic-host",
    rows: [
      {
        id: "synthetic-prep",
        at: new Date().toISOString(),
        function: "prep",
        model: "synthetic/model",
        source: "host-reported",
        inputTokens: 100,
        outputTokens: 20,
        costUsd: "0.000000001",
      },
      {
        id: "synthetic-draft",
        at: new Date().toISOString(),
        function: "draft",
        model: "synthetic/model",
        source: "estimated",
      },
    ],
  })
  await writeFile(usageFile, usage)
  const cost = cli(["cost", "--file", usageFile, "--weeks", "4"])
  assert.equal(cost.authoritativeBillingVerified, false)
  assert.equal(cost.totals.rows, 2)
  assert.deepEqual(cost.totals.costUsd, {
    total: null,
    knownSubtotal: "0.000000001",
    missingRows: 1,
  })
  assert.equal(cost.groups.length, 2)
  assert.equal(await readFile(usageFile, "utf8"), usage)
  const malformedUsage = join(workspace, "malformed-usage.json")
  const privateLiteral = "PRIVATE_SYNTHETIC_LITERAL_NOT_JSON"
  await writeFile(malformedUsage, privateLiteral)
  const rejected = execute(bin, ["cost", "--file", malformedUsage, "--config", config, "--json"], {
    cwd: workspace,
    env,
    encoding: "utf8",
    timeout: 30_000,
  })
  if (rejected.error) throw rejected.error
  commands.push("cost malformed-input")
  assert.equal(rejected.status, 1)
  assert(!`${rejected.stdout}${rejected.stderr}`.includes(privateLiteral))
  const source = "CS101/Week 01 - Oct 5/reading.md"
  const prompt = "CS101/Assignments/prompt.md"
  const originals = new Map([
    [
      source,
      "---\navailable_at: 2026-10-05\n---\nSynthetic reading: compare two strategies using evidence.\n",
    ],
    [
      prompt,
      '---\ntype: assignment\ncanvas_id: "50"\navailable_at: 2026-10-05\n---\nExplain the supplied strategy framework.\n',
    ],
  ])
  for (const [path, body] of originals) {
    await mkdir(resolve(vault, path, ".."), { recursive: true })
    await writeFile(join(vault, path), body)
  }
  cli(["vault", "health"])
  await mkdir(join(vault, "_meta"), { recursive: true })
  await writeFile(
    join(vault, "_meta/canvas-courses.json"),
    JSON.stringify({
      version: 1,
      courses: [{ id: "1", code: "CS101", name: "Synthetic", root: "CS101" }],
    }),
  )
  const starter = cli(["guidance", "init-assignment", "CS101", "--source", prompt])
  assert.equal(starter.created, true)
  assert.equal(starter.aiPermissionVerified, false)
  const starterPath = join(vault, starter.paths[0])
  const starterBytes = await readFile(starterPath)
  assert.equal(cli(["guidance", "init-assignment", "CS101", "--source", prompt]).created, false)
  assert.deepEqual(await readFile(starterPath), starterBytes)
  const feedback = {
    version: 1,
    courseId: "1",
    assignmentId: "50",
    score: 8.5,
    grade: null,
    gradedAt: null,
    comments: [{ text: "Synthetic cached feedback only.", createdAt: null }],
    rubric: [{ criterion: "evidence_quality", points: 8.5, comments: null }],
  }
  const feedbackHash = createHash("sha256").update(JSON.stringify(feedback)).digest("hex")
  const feedbackDir = join(vault, "_meta/canvas-feedback/1/50")
  await mkdir(feedbackDir, { recursive: true, mode: 0o700 })
  await writeFile(join(feedbackDir, `${feedbackHash}.json`), JSON.stringify(feedback), {
    mode: 0o600,
  })
  await writeFile(
    join(feedbackDir, "current.json"),
    JSON.stringify({
      version: 1,
      checkedAt: "2026-10-05T08:00:00.000Z",
      dataHash: feedbackHash,
      data: feedback,
    }),
    { mode: 0o600 },
  )
  assert.equal(cli(["feedback", "CS101", "--assignment", "50"]).feedback.score, 8.5)
  assert.equal(cli(["playbook", "CS101", "--assignment", "50"]).history.records.length, 1)
  const syllabus = "CS101/Syllabus.md"
  const syllabusText =
    "Synthetic syllabus: weekly reading synthesis and discussion differ from graded submissions."
  originals.set(syllabus, syllabusText)
  await writeFile(join(vault, syllabus), syllabusText)
  const proposal = cli(["guidance", "propose", "CS101", "--feedback-assignment", "50"])
  const proposalRecordPath = join(vault, "_meta/guidance-proposals", proposal.id, "proposal.json")
  const proposalRecord = JSON.parse(await readFile(proposalRecordPath, "utf8"))
  assert.equal(proposalRecord.proposalFeedbackVersion, 1)
  assert.equal(proposalRecord.proposalStructureVersion, 1)
  assert.deepEqual(proposalRecord.feedbackAssignments, ["50"])
  assert.equal(proposalRecord.learningHistory.records.length, 1)
  const proposalInventory = cli(["guidance", "list", "--course", "CS101"])
  assert.deepEqual(
    proposalInventory.proposals.map((row) => row.id),
    [proposal.id],
  )
  assert.equal(proposalInventory.inventoryComplete, true)
  const proposalShown = cli(["guidance", "show", proposal.id])
  assert.equal(proposalShown.privateFeedbackRecordCount, 1)
  assert.equal(proposalShown.currentnessChecked, false)
  assert(!JSON.stringify(proposalShown).includes("Synthetic cached feedback"))
  const guidanceCandidate = join(workspace, "guidance-candidate.md")
  await writeFile(
    guidanceCandidate,
    `# Synthetic proposed guide\nSynthesize evidence before class discussion.\n## Brief structure\nReading synthesis, Discussion preparation, Sources\n## Sources\n\`${syllabus}\`\n`,
  )
  const proposed = cli(["guidance", "save", proposal.id, "--file", guidanceCandidate])
  assert.equal(await readFile(proposed.path, "utf8"), await readFile(guidanceCandidate, "utf8"))
  assert.equal(cli(["guidance", "show", proposal.id]).savedCandidateCount, 1)
  const evidenceSource = "EVID101/Week 01 - Oct 5/reading.md"
  await mkdir(join(vault, evidenceSource, ".."), { recursive: true })
  await writeFile(
    join(vault, evidenceSource),
    "Random assignment with valid measurement reduces confounding and supports comparisons across groups.\n## Preparation questions\nWhy compare groups?\n",
  )
  const evidenceTask = cli(["prep", "EVID101", "--week", "2026-10-05"])
  const evidenceRecord = cli(["task", "show", evidenceTask.id])
  assert.equal(evidenceRecord.answerEvidenceVersion, 1)
  const evidenceCandidate = join(workspace, "answer-evidence.md")
  const evidenceBody = (answer) =>
    `Task: ${evidenceTask.id}\n${evidenceRecord.requirements.map((heading) => `## ${heading}\n${heading === "Sources" ? `\`${evidenceSource}\`` : heading === "Preparation questions" ? `### Why compare groups?\n${answer} \`${evidenceSource}\`` : "Synthetic structural fixture only, not real student coursework."}`).join("\n")}`
  await writeFile(
    evidenceCandidate,
    evidenceBody(
      "SYNTHETIC_BAD_FILLER_CANARY: This answer discusses various important factors that are very interesting.",
    ),
  )
  const rejectedEvidence = execute(
    process.execPath,
    [
      bin,
      "task",
      "complete",
      evidenceTask.id,
      "--file",
      evidenceCandidate,
      "--config",
      config,
      "--json",
    ],
    { cwd: workspace, env, encoding: "utf8", timeout: 30_000 },
  )
  if (rejectedEvidence.error) throw rejectedEvidence.error
  commands.push("prep answer-evidence rejection")
  assert.equal(rejectedEvidence.status, 1)
  assert(rejectedEvidence.stderr.includes("five distinct content words"))
  assert(
    !`${rejectedEvidence.stdout}${rejectedEvidence.stderr}`.includes("SYNTHETIC_BAD_FILLER_CANARY"),
  )
  await writeFile(
    evidenceCandidate,
    evidenceBody(
      "Random assignment with valid measurement reduces confounding, supporting comparisons across groups rather than attributing group differences to confounded factors.",
    ),
  )
  assert.equal(
    cli(["task", "complete", evidenceTask.id, "--file", evidenceCandidate]).task.status,
    "completed",
  )
  await mkdir(join(vault, "CS101/_meta"), { recursive: true })
  cli(["context"])
  cli(["upcoming", "--course", "CS101"])
  async function complete(task, frozen = false) {
    const shown = cli(frozen ? ["simulate", "task", "show", task.id] : ["task", "show", task.id])
    assert.equal(shown.scope, frozen ? "frozen" : "ordinary")
    assert.equal(shown.locations.config, resolve(config))
    assert.equal(shown.locations.vaultRoot, resolve(vault))
    assert.equal(shown.locations.pathsExistenceVerified, false)
    const record = frozen ? shown.task : shown
    assert(record.sources.length > 0)
    assert.equal(record.hostExecutionVersion, 1)
    assert.equal(record.workbookVersion, undefined)
    assert(
      record.sources.some((entry) => {
        const original = originals.get(entry.path)
        return original && entry.text.includes(original.split("---\n").at(-1).trim())
      }),
      "Task must include an unchanged synthetic reading or prompt",
    )
    const file = join(workspace, `${task.id}.md`)
    await writeFile(
      file,
      [
        `Task: ${task.id}`,
        ...record.requirements.map(
          (heading, index) =>
            `## ${heading}\n\n${
              heading === "Sources"
                ? record.sources.map((entry) => `\`${entry.path}\``).join("\n")
                : "Synthetic structural fixture only, not student coursework."
            }${index === 1 && record.deliverable?.kind !== "none" && record.deliverable?.items ? `\n\n${record.deliverable.items.map((item) => `### ${item.text}\nPENDING — requires missing numerical inputs or empirical evidence in this synthetic fixture. \`${record.deliverable.sourcePath}\``).join("\n\n")}` : ""}`,
        ),
        ...(record.assignment?.mode === "draft"
          ? ["### Synthetic cash schedule\n| Label | Value |\n| --- | --- |\n| Cash | $1,200 |"]
          : []),
      ].join("\n\n"),
    )
    const result = cli(
      frozen
        ? ["simulate", "task", "complete", task.id, "--file", file]
        : ["task", "complete", task.id, "--file", file],
    )
    if (record.workbookVersion) {
      const book = frozen ? result.workbook : result.task.workbook
      assert(book, "Automatic workbook is missing")
      const bytes = await readFile(join(vault, frozen ? book.output : book.path))
      assert.equal(createHash("sha256").update(bytes).digest("hex"), book.hash)
      assert.equal(bytes.subarray(0, 2).toString(), "PK")
    }
    const completedLocations = cli(shown.inspectionCommand).locations
    assert.equal(completedLocations.output, join(vault, result.output))
    const savedOutput = cli(
      frozen ? ["simulate", "task", "output", task.id] : ["task", "output", task.id],
    )
    assert.equal(savedOutput.outputIntegrityVerified, true)
    assert.equal(savedOutput.academicCorrectnessVerified, false)
    assert.equal(savedOutput.sourceCurrentnessVerified, false)
    assert.equal(savedOutput.scope, frozen ? "frozen" : "ordinary")
    assert.equal(savedOutput.text, await readFile(file, "utf8"))
    assert.equal(savedOutput.locations.output, completedLocations.output)
    if (record.workbookVersion) {
      const book = frozen ? result.workbook : result.task.workbook
      assert.equal(completedLocations.workbook, join(vault, frozen ? book.output : book.path))
    }
    return result
  }
  const prep = cli(["prep", "CS101", "--week", "2026-10-05"])
  const pendingTasks = cli(["task", "list", "--course", "CS101", "--status", "pending"])
  assert(pendingTasks.tasks.some((task) => task.id === prep.id))
  assert.equal(pendingTasks.scope, "ordinary")
  assert.deepEqual(
    pendingTasks.tasks.find((task) => task.id === prep.id).inspectionCommand.slice(0, 3),
    ["task", "show", prep.id],
  )
  assert(!JSON.stringify(pendingTasks).includes("sourceSnapshots"))
  const prepDirectory = join(vault, "_meta/tasks", prep.id)
  const prepRecord = await readFile(join(prepDirectory, "task.json"))
  const retainedPrepBrief = join(root, "retained-prep-brief.md")
  await rename(join(prepDirectory, "TASK.md"), retainedPrepBrief)
  const recoveredPrep = cli(["task", "show", prep.id])
  assert.equal(recoveredPrep.briefStatus, "missing")
  assert.equal(recoveredPrep.taskFile, undefined)
  assert.deepEqual(await readFile(join(prepDirectory, "task.json")), prepRecord)
  await complete(prep)
  await assert.rejects(stat(join(prepDirectory, "TASK.md")), { code: "ENOENT" })
  assert((await readFile(retainedPrepBrief, "utf8")).includes(prep.id))
  assert(
    cli(["task", "list", "--course", "CS101", "--status", "completed"]).tasks.some(
      (task) => task.id === prep.id,
    ),
  )
  cli(["inspect", prep.id])
  cli(["gate", "review", prep.id])
  await mkdir(join(vault, "SWEEP101/Modules"), { recursive: true })
  await writeFile(
    join(vault, "SWEEP101/Modules/session.md"),
    "---\ntype: module\ncanvas_id: '900'\ntitle: Session 1 - Synthetic sweep\n---\nPRIVATE_SWEEP_SOURCE substantive marginal-analysis reading.\n",
  )
  const draft = cli([
    "assignment",
    "CS101",
    "--source",
    prompt,
    "--mode",
    "draft",
    "--context",
    source,
  ])
  const completedDraft = await complete(draft)
  const draftBeforeReview = await readFile(join(vault, completedDraft.output))
  const correctnessReview = cli(["correctness", "prepare", draft.id])
  const reviewHandoff = await readFile(correctnessReview.handoffPath, "utf8")
  assert(reviewHandoff.includes("Use the coding harness"))
  assert(reviewHandoff.includes("Perform a separate correctness-review pass"))
  assert.equal(correctnessReview.academicCorrectnessVerified, false)
  assert.equal(correctnessReview.independentReviewerVerified, false)
  assert(
    cli(["correctness", "list", "--course", "CS101"]).reviews.some(
      (entry) => entry.id === correctnessReview.id,
    ),
  )
  assert.equal(cli(["correctness", "show", correctnessReview.id]).taskId, draft.id)
  const reviewCandidate = join(workspace, "separate-review.md")
  await writeFile(
    reviewCandidate,
    `Review: ${correctnessReview.id}\n\n## Verified\n- Synthetic source paths and output identity were inspected; harness calculations still require substantive verification. \`${prompt}\`\n\n## Needs verification\n- Independent reviewer identity, course permission and substantive source coverage remain unverified by this synthetic package fixture. \`${prompt}\`\n- Review the validated draft \`${completedDraft.output}\`  for substantive correctness; byte validation is not a grade.\n`,
  )
  const savedReview = cli(["correctness", "save", correctnessReview.id, "--file", reviewCandidate])
  assert.equal(savedReview.status, "completed")
  assert.equal(
    cli(["correctness", "save", correctnessReview.id, "--file", reviewCandidate]).reviewHash,
    savedReview.reviewHash,
  )
  assert.deepEqual(await readFile(join(vault, completedDraft.output)), draftBeforeReview)
  const draftGate = cli(["gate", "review", draft.id])
  assert.equal(draftGate.automaticWorkbook.state, "harness-owned")
  assert.equal(completedDraft.task.workbook, undefined)
  const draftComparison = cli(["compare", draft.id, draft.id])
  assert.equal(draftComparison.automaticWorkbooks.change, "unknown")
  const revision = cli(["revise", draft.id, "--feedback", "Synthetic verification feedback."])
  await complete(revision)
  const approved = cli(["approve", draft.id])
  assert.equal(approved.workbook, undefined)
  const snapshot = cli(["simulate", "capture", "CS101", "--as-of", "2026-10-09"])
  const earlier = cli(["simulate", "derive", snapshot.id, "--as-of", "2026-10-05"])
  assert.equal(earlier.derivedFrom.id, snapshot.id)
  assert.equal(earlier.derivedFrom.hash, snapshot.hash)
  const frozenPaths = [snapshot, earlier].map((capture) => join(vault, capture.path))
  const frozenBefore = await Promise.all(frozenPaths.map((path) => readFile(path)))
  const captureInventory = cli(["simulate", "list", "--course", "CS101"])
  assert.equal(captureInventory.inventoryComplete, true)
  assert.deepEqual(
    captureInventory.captures.map((capture) => capture.id).sort(),
    [snapshot.id, earlier.id].sort(),
  )
  assert.equal(cli(["simulate", "list", "--course", "SWEEP101"]).captures.length, 0)
  assert(
    captureInventory.captures.every(
      (capture) => !Object.hasOwn(capture, "sources") && !Object.hasOwn(capture, "guidance"),
    ),
  )
  assert.deepEqual(await Promise.all(frozenPaths.map((path) => readFile(path))), frozenBefore)
  const evaluation = cli([
    "simulate",
    "task",
    "create",
    earlier.id,
    "--kind",
    "prep",
    "--week",
    "2026-10-05",
  ])
  await complete(evaluation, true)
  const frozenRecipePath = join(vault, "_meta/simulations/tasks", evaluation.id, "record.json")
  const frozenRecipeBefore = await readFile(frozenRecipePath)
  const frozenTaskInventory = cli(["simulate", "task", "list", "--course", "CS101"])
  assert.equal(frozenTaskInventory.inventoryComplete, true)
  assert(
    frozenTaskInventory.tasks.some(
      (task) => task.id === evaluation.id && task.captureId === earlier.id,
    ),
  )
  assert.equal(cli(["simulate", "task", "list", "--course", "SWEEP101"]).tasks.length, 0)
  assert(
    frozenTaskInventory.tasks.every(
      (task) =>
        !Object.hasOwn(task, "status") &&
        !Object.hasOwn(task, "sources") &&
        !Object.hasOwn(task, "workflow"),
    ),
  )
  assert.deepEqual(await readFile(frozenRecipePath), frozenRecipeBefore)
  const frozenDraft = cli([
    "simulate",
    "task",
    "create",
    snapshot.id,
    "--kind",
    "assignment",
    "--source",
    prompt,
    "--mode",
    "draft",
    "--context",
    source,
  ])
  const completedFrozen = await complete(frozenDraft, true)
  const frozenOutputBeforeReview = await readFile(join(vault, completedFrozen.output))
  const frozenReview = cli(["correctness", "prepare", frozenDraft.id, "--frozen"])
  assert.equal(frozenReview.kind, "frozen")
  assert.equal(frozenReview.simulationId, snapshot.id)
  assert.equal(frozenReview.frozenHumanVerdict, "pending-human")
  assert((await readFile(frozenReview.handoffPath, "utf8")).includes("Use the coding harness"))
  assert(
    cli(["correctness", "list", "--course", "CS101"]).reviews.some(
      (entry) => entry.id === frozenReview.id && entry.frozen,
    ),
  )
  const frozenReviewCandidate = join(workspace, "frozen-review.md")
  await writeFile(
    frozenReviewCandidate,
    `Review: ${frozenReview.id}\n\n## Verified\n- Captured source paths and output identity were inspected; harness execution and academic correctness remain unverified. \`${prompt}\`\n\n## Needs verification\n- The validated frozen output \`${completedFrozen.output}\`  still need academic review, never automatic human approval.\n`,
  )
  const savedFrozenReview = cli([
    "correctness",
    "save",
    frozenReview.id,
    "--file",
    frozenReviewCandidate,
  ])
  assert.equal(savedFrozenReview.status, "completed")
  assert.equal(
    cli(["correctness", "save", frozenReview.id, "--file", frozenReviewCandidate]).reviewHash,
    savedFrozenReview.reviewHash,
  )
  assert.equal(cli(["correctness", "show", frozenReview.id]).frozenHumanVerdict, "pending-human")
  assert.deepEqual(await readFile(join(vault, completedFrozen.output)), frozenOutputBeforeReview)
  const workbooks = cli(["simulate", "task", "workbooks", frozenDraft.id])
  assert.equal(workbooks.records.length, 0)
  assert.equal(completedFrozen.workbook, undefined)
  // Isolated fixture ownership only: exercise the installed binary with a
  // persistent namespace while retaining all earlier root-level task outputs.
  const oldDraftBytes = await readFile(join(vault, completedDraft.output))
  await writeFile(
    join(vault, "_meta/canvas-courses.json"),
    JSON.stringify({
      version: 1,
      courses: [
        { id: "1", code: "CS101", name: "Synthetic", root: "CS101", syncNamespace: "Canvas Agent" },
      ],
    }),
  )
  await writeFile(
    join(vault, "_meta/canvas-sync-state.json"),
    JSON.stringify({ version: 1, files: {} }),
  )
  const preservedDraft = cli([
    "assignment",
    "CS101",
    "--source",
    prompt,
    "--mode",
    "draft",
    "--context",
    source,
  ])
  assert.equal(preservedDraft.destination, "CS101/Canvas Agent/Generated/Assignments/Drafts")
  const completedPreserved = await complete(preservedDraft)
  const homework = cli(["homework", "--course", "CS101"])
  const homeworkRow = homework.undated.find((row) => row.path === prompt)
  assert(homeworkRow, "Prompt is missing from homework inventory")
  assert.equal(homeworkRow.draftBinding, "task-metadata")
  assert.equal(homeworkRow.draftContentsVerified, false)
  assert(homeworkRow.draftPaths.includes(completedDraft.output))
  assert(homeworkRow.draftPaths.includes(completedPreserved.output))
  assert.deepEqual(await readFile(join(vault, completedDraft.output)), oldDraftBytes)
  const localDocument = join(workspace, "installed-reading.docx")
  const document = new JSZip()
  document.file(
    "word/document.xml",
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic ingested evidence distinguishes assumptions from observed results.</w:t><w:tab/><w:t>Separated context.</w:t></w:r></w:p></w:body></w:document>',
  )
  const documentBytes = await document.generateAsync({ type: "nodebuffer" })
  await writeFile(localDocument, documentBytes)
  const ingestionArgs = [
    "ingest",
    localDocument,
    "--course",
    "CS101",
    "--week",
    "2026-10-05",
    "--as-of",
    "2026-10-05",
  ]
  const ingestion = cli(ingestionArgs)
  assert(ingestion.original.includes("CS101/Canvas Agent/Canvas/Files/"))
  assert(ingestion.text, "Namespaced extraction sidecar missing")
  const extractedBytes = await readFile(ingestion.text)
  assert(extractedBytes.toString("utf8").includes("results.\tSeparated context."))
  assert.equal(cli(ingestionArgs).text, ingestion.text)
  assert.deepEqual(await readFile(ingestion.text), extractedBytes)
  assert.deepEqual(await readFile(ingestion.original), documentBytes)
  assert.deepEqual(await readFile(localDocument), documentBytes)
  const ingestedPrep = cli(["prep", "CS101", "--week", "2026-10-05"])
  assert(ingestedPrep.sources.some((path) => ingestion.text.endsWith(path)))
  const ingestionTaskPath = join(vault, "_meta/tasks", ingestedPrep.id, "task.json")
  const ingestionTaskBytes = await readFile(ingestionTaskPath)
  const compatibleIngestionArgs = [
    ...ingestionArgs,
    "--school-compatible",
    "--ai-policy",
    "allowed",
    "--redistribution",
    "allowed",
  ]
  const compatibleIngestion = cli(compatibleIngestionArgs)
  assert.equal(compatibleIngestion.original, ingestion.original)
  assert.notEqual(compatibleIngestion.text, ingestion.text)
  assert(compatibleIngestion.text.includes(".school-"))
  const compatibleBytes = await readFile(compatibleIngestion.text)
  assert.equal(cli(compatibleIngestionArgs).text, compatibleIngestion.text)
  assert.deepEqual(await readFile(compatibleIngestion.text), compatibleBytes)
  assert.deepEqual(await readFile(ingestion.text), extractedBytes)
  assert.deepEqual(await readFile(ingestionTaskPath), ingestionTaskBytes)
  cli([...ingestionArgs, "--school-compatible"], 1)
  const boundPrep = cli(["prep", "CS101", "--week", "2026-10-05"])
  const boundPrepRecord = cli(["task", "show", boundPrep.id])
  const compatiblePath = compatibleIngestion.text
    .slice(vault.length + 1)
    .split("\\")
    .join("/")
  const provenanceHash = createHash("sha256")
    .update(await readFile(`${compatibleIngestion.text}.ingest.json`))
    .digest("hex")
  assert.deepEqual(
    boundPrepRecord.sources.find((source) => source.path === compatiblePath).ingestProvenance,
    { path: `${compatiblePath}.ingest.json`, hash: provenanceHash },
  )
  const compatibleCapture = cli(["simulate", "capture", "CS101", "--as-of", "2026-10-09"])
  const compatibleReplay = cli(["simulate", "replay", compatibleCapture.id])
  assert.deepEqual(
    compatibleReplay.sources.find((source) => source.path === compatiblePath).ingestProvenance,
    { path: `${compatiblePath}.ingest.json`, hash: provenanceHash },
  )
  const rejectedConfig = execute(
    bin,
    ["ingest", config, "--course", "CS101", "--config", config, "--json"],
    { cwd: workspace, env, encoding: "utf8", timeout: 30_000 },
  )
  if (rejectedConfig.error) throw rejectedConfig.error
  commands.push("ingest selected-config rejection")
  assert.equal(rejectedConfig.status, 1)
  assert(rejectedConfig.stderr.includes("Selected CLI config/auth files"))
  const spreadsheet = new JSZip()
  spreadsheet.file(
    "xl/workbook.xml",
    '<workbook><sheets><sheet name="Assumptions" sheetId="1" r:id="r1"/></sheets></workbook>',
  )
  spreadsheet.file(
    "xl/_rels/workbook.xml.rels",
    '<Relationships><Relationship Id="r1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  )
  spreadsheet.file(
    "xl/worksheets/sheet1.xml",
    '<row><c t="inlineStr"><is><t>Synthetic scenario input</t></is></c><c><v>42</v></c></row>',
  )
  const spreadsheetBytes = await spreadsheet.generateAsync({ type: "nodebuffer" })
  const spreadsheetFile = join(workspace, "named-input.xlsx")
  await writeFile(spreadsheetFile, spreadsheetBytes)
  const namedInput = cli(["ingest", spreadsheetFile, "--course", "CS101", "--week", "2026-10-05"])
  assert(
    (await readFile(namedInput.text, "utf8")).includes(
      "## Assumptions\nSynthetic scenario input | 42",
    ),
  )
  assert.deepEqual(await readFile(namedInput.original), spreadsheetBytes)
  assert.deepEqual(await readFile(spreadsheetFile), spreadsheetBytes)
  const htmlInput = join(workspace, "structured-requirements.html")
  const htmlBytes = Buffer.from(
    "<h1>Preparation</h1><p>Required:</p><ol><li>Explain the framework.</li><li>Compare the evidence.</li></ol><script>OMITTED_ACTIVE_CONTENT</script>",
  )
  await writeFile(htmlInput, htmlBytes)
  const htmlIngest = cli(["ingest", htmlInput, "--course", "CS101"])
  const htmlText = await readFile(htmlIngest.text, "utf8")
  assert(/1\.\s+Explain the framework/.test(htmlText))
  assert(!htmlText.includes("OMITTED_ACTIVE_CONTENT"))
  assert.deepEqual(await readFile(htmlIngest.original), htmlBytes)
  assert.deepEqual(await readFile(htmlInput), htmlBytes)
  const numberedPrompt = "CS101/Canvas Agent/Canvas/Assignments/numbered.md"
  const numberedCase = "CS101/Canvas Agent/numbered-case.md"
  for (const [path, body] of [
    [
      numberedPrompt,
      "---\ntype: assignment\ncanvas_id: '60'\n---\nComplete Part 2 of the attached synthetic case.",
    ],
    [
      numberedCase,
      "Required: PART 1: 1. Explain costs. PART 2: 1. Calculate margin. 2. Explain limits.",
    ],
  ]) {
    originals.set(path, body)
    await mkdir(resolve(vault, path, ".."), { recursive: true })
    await writeFile(join(vault, path), body)
  }
  const numbered = cli([
    "assignment",
    "CS101",
    "--source",
    numberedPrompt,
    "--mode",
    "outline",
    "--context",
    numberedCase,
  ])
  assert.equal(numbered.deliverableParserVersion, 3)
  assert.equal(numbered.deliverable.scope, "PART 2")
  assert.deepEqual(
    numbered.deliverable.items.map((item) => item.text),
    ["Calculate margin.", "Explain limits."],
  )
  await complete(numbered)
  const refreshedPrompt = "CS101/Canvas Agent/Canvas/Assignments/refreshed.md"
  await mkdir(join(vault, "CS101/Canvas Agent/Canvas/Assignments"), { recursive: true })
  await writeFile(
    join(vault, refreshedPrompt),
    "---\ntype: assignment\ncanvas_id: '50'\n---\n# Refreshed synthetic prompt\nDifferent current requirements.",
  )
  const relatedHomework = cli(["homework", "--course", "CS101"])
  const refreshedRow = relatedHomework.undated.find((row) => row.path === refreshedPrompt)
  assert(refreshedRow, "Refreshed prompt missing from homework")
  assert.equal(refreshedRow.draftVersion, null)
  assert.equal(refreshedRow.draftBinding, "not-found")
  assert(
    refreshedRow.relatedDrafts.some(
      (entry) => entry.taskId === draft.id && entry.promptPath === prompt,
    ),
  )
  assert(refreshedRow.relatedDrafts.every((entry) => entry.draftContentsVerified === false))
  assert.deepEqual(await readFile(join(vault, completedDraft.output)), oldDraftBytes)
  const historyDirectory = join(workspace, "private-vault-history")
  const baselineHistory = cli(["vault", "history", "enable", "--directory", historyDirectory])
  assert.equal(baselineHistory.changed, true)
  const historyStatus = cli(["vault", "history", "status"])
  assert.equal(historyStatus.status, "ready")
  assert.equal(historyStatus.latestCommit, baselineHistory.commit)
  assert.equal(historyStatus.writesPerformed, false)
  assert.equal(historyStatus.workingTreeCurrentnessVerified, false)
  commands.push("installed history status without Git")
  const unavailableHistory = JSON.parse(
    run(
      process.execPath,
      [join(installed, "dist/cli.js"), "vault", "history", "status", "--config", config, "--json"],
      workspace,
      1,
      { PATH: "" },
    ),
  )
  assert.equal(unavailableHistory.status, "unavailable")
  assert.equal(cli(["vault", "history", "list"]).commits.length, 1)
  assert.equal(cli(["vault", "history", "snapshot"]).changed, false)
  const historyPath = [...originals.keys()][0]
  assert(historyPath)
  assert(
    cli(["vault", "history", "show", baselineHistory.commit]).files.some(
      (file) => file.path === historyPath,
    ),
  )
  const historyExport = join(workspace, "history-export.md")
  assert.equal(
    cli([
      "vault",
      "history",
      "export",
      baselineHistory.commit,
      "--path",
      historyPath,
      "--file",
      historyExport,
    ]).restoredIntoVault,
    false,
  )
  assert.equal(await readFile(historyExport, "utf8"), originals.get(historyPath))
  const historyInput = join(workspace, "history-new-reading.txt")
  await writeFile(
    historyInput,
    "Additional synthetic reading captured by the automatic history hook.\n",
  )
  cli(["ingest", historyInput, "--course", "CS101"])
  const automaticHistory = cli(["vault", "history", "list"])
  assert.equal(automaticHistory.commits.length, 2)
  assert.equal(automaticHistory.commits[1].id, baselineHistory.commit)
  assert.equal(cli(["vault", "history", "disable"]).historyPreserved, true)
  assert.equal(cli(["vault", "history", "status"]).status, "disabled")
  assert.equal(cli(["vault", "history", "snapshot"]).enabled, false)
  assert.equal(cli(["vault", "history", "list"]).commits.length, 2)
  for (const [path, body] of originals)
    assert.equal(await readFile(join(vault, path), "utf8"), body)
  assert(
    !(await readdir(join(installation, "node_modules"))).includes("vitest"),
    "Install unexpectedly requires dev dependencies",
  )
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
        separateCorrectnessReviewInstalledTested: true,
        frozenCorrectnessReviewInstalledTested: true,
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
        hostUsageExportTested: true,
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
