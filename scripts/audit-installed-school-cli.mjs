import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import { pathToFileURL } from "node:url"

// Explicit installed-package operator audit, never a real vault/account/provider.
const school = await realpath(process.argv[2] ?? "")
const temporary = await realpath(tmpdir())
assert(
  /^canvas-installed-coexistence-[A-Za-z0-9]+\/installation\/node_modules\/school-agent$/.test(
    relative(temporary, school).split(sep).join("/"),
  ),
  "Supply only an owned installed School package from the coexistence audit",
)
const root = await mkdtemp(join(tmpdir(), "canvas-installed-school-cli-"))
const home = join(root, "home"),
  vault = join(root, "vault"),
  config = join(root, "school.config.json")
await mkdir(home)
const requireSchool = createRequire(join(school, "package.json"))
const aiPath = requireSchool.resolve("ai"),
  testPath = requireSchool.resolve("ai/test")
const commands = []
const env = {
  PATH: process.env.PATH,
  HOME: home,
  TMPDIR: root,
  SCHOOL_CLI_AUDIT_ROOT: root,
  AUDIT_CANVAS_TOKEN: "synthetic-token",
}
function execute(executable, args, cwd, accepted = [0], extraEnv = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 5_000_000,
  })
  commands.push({
    executable,
    args,
    cwd,
    status: result.status,
    signal: result.signal,
    stdoutHash: hash(result.stdout ?? ""),
    stderrHash: hash(result.stderr ?? ""),
  })
  writeFileSync(join(root, "commands.json"), JSON.stringify(commands, null, 2), { mode: 0o600 })
  if (result.error) throw result.error
  assert(
    accepted.includes(result.status),
    `Owned CLI audit failed (${result.status}): ${result.stderr}`,
  )
  return result
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const npmrc = join(root, "empty.npmrc")
await writeFile(npmrc, "", { flag: "wx", mode: 0o600 })
console.log(JSON.stringify({ root, phase: "native-sqlite-rebuild", syntheticOnly: true }))
execute(
  process.platform === "win32" ? "npm.cmd" : "npm",
  [
    "rebuild",
    "better-sqlite3",
    "--userconfig",
    npmrc,
    "--cache",
    join(root, "npm-cache"),
    "--registry",
    "https://registry.npmjs.org",
  ],
  join(school, "../.."),
)

const { VaultWriter } = await import(pathToFileURL(join(school, "dist/store/vault.js")).href)
const { coursePaths } = await import(pathToFileURL(join(school, "dist/store/paths.js")).href)
const { createSchoolIndex } = await import(pathToFileURL(join(school, "dist/store/db.js")).href)
const course = {
  code: "SYNTH401",
  canvasId: "17",
  canvasUrl: "https://canvas.example.invalid/courses/17",
  aiPolicy: "allowed",
}
const writer = new VaultWriter({ root: vault, gitInit: false })
await writer.writeMetadata({
  artifact: "alert",
  canvasUrl: course.canvasUrl,
  content: "Invented CLI acceptance fixture, not real coursework or an authentication alert.",
})
const period = { kind: "week", number: 1, date: "2026-10-12" }
const common = { course, source: "sync", status: "approved", period }
const reading = await writer.write({
  ...common,
  kind: "files",
  title: "Reading",
  canvasId: "501",
  canvasUrl: "https://canvas.example.invalid/files/501",
  bucket: "materials",
  content:
    "Observations provide evidence, whereas assumptions are labeled premises that may require further investigation.\n## Preparation questions\n1. Why separate observations from assumptions?",
})
await writer.write({
  ...common,
  kind: "modules",
  title: "Evidence session",
  canvasId: "201",
  canvasUrl: "https://canvas.example.invalid/modules/201",
  dates: { unlock_at: "2026-10-12T00:00:00Z" },
  content: "Evidence session\n- File: Reading (canvas_id: 501)",
})
const assignment = await writer.write({
  course,
  source: "sync",
  status: "approved",
  kind: "assignments",
  title: "Synthetic Memo",
  canvasId: "9",
  canvasUrl: "https://canvas.example.invalid/assignments/9",
  content:
    "Write an invented engineering memo using only the synthetic source evidence. Full AI drafting explicitly permitted for this fixture only.",
  assignment: { title: "Synthetic Memo", dueAt: "2026-10-16" },
})
const guidance = await writer.write({
  course,
  source: "user",
  status: "approved",
  kind: "guidance",
  title: "Prep guidance",
  canvasId: "guide",
  canvasUrl: course.canvasUrl,
  content:
    "Invented engineering fixture only; full AI prep/drafting/review explicitly permitted for this test.\n## Brief structure\nOverview, Readings, Preparation questions, Sources",
})
await writer.writeCourseManifest({
  course,
  restrictedFileHandling: "exclude",
  activeAssignmentIds: ["9"],
})
const paths = coursePaths(vault, course.code, course.canvasId)
// The generic writer chooses a title-based filename; prep reads this exact name.
const prepGuidance = join(paths.guidance, "prep-guidance.md")
if (guidance.path !== prepGuidance) {
  await mkdir(paths.guidance, { recursive: true })
  await writeFile(prepGuidance, await readFile(guidance.path), { flag: "wx", mode: 0o600 })
}
const { resolveRequirements } = await import(
  pathToFileURL(join(school, "dist/engines/requirements.js")).href
)
const requirements = await resolveRequirements({
  vaultRoot: vault,
  courseCode: course.code,
  courseCanvasId: course.canvasId,
  defaultSections: ["Agenda"],
  sources: [],
})
assert.equal(requirements.sectionsDeclared, true)
assert.deepEqual(requirements.sections, [
  "Overview",
  "Readings",
  "Preparation questions",
  "Sources",
])
const readingLink = relative(paths.root, reading.path).split(sep).join("/")
await writeFile(join(root, "fixture.json"), JSON.stringify({ readingLink }), {
  flag: "wx",
  mode: 0o600,
})
await writeFile(
  config,
  JSON.stringify({
    canvas: { baseUrl: "https://canvas.example.invalid", tokenEnv: "AUDIT_CANVAS_TOKEN" },
    vault: { path: vault, gitInit: false },
    index: { path: join(root, "index.sqlite") },
    models: {
      triage: "mock/triage",
      generation: "mock/generation",
      functions: {
        extractSummary: "mock/triage",
        prepBrief: "mock/prep",
        assignmentDraft: "mock/draft",
        assignmentDiscuss: "mock/discuss",
        coverageCompare: "mock/compare",
        playbookUpdate: "mock/playbook",
      },
    },
    aiPolicyDefault: "allowed",
    courses: { mode: "list", allowlist: ["17"], pilotCourseId: null },
    sync: { intervalMinutes: 60, staleAfterHours: 24, leadDays: 7 },
    assignments: { autoDraftUpcoming: false },
    cost: { maxMonthlySpendUSD: null },
    restrictedFileHandling: "exclude",
    renew: { warnDaysBefore: 5 },
    files: { maxSizeMB: 100 },
    prep: { granularity: "week" },
  }),
  { flag: "wx", mode: 0o600 },
)
const index = createSchoolIndex({ path: join(root, "index.sqlite") })
try {
  index.upsertCourse({
    canvasId: "17",
    name: "Synthetic evidence",
    courseCode: course.code,
    workflowState: "available",
    vaultPath: paths.root,
  })
  index.upsertAssignment({
    canvasId: "9",
    courseCanvasId: "17",
    name: "Synthetic Memo",
    dueAt: "2026-10-16T00:00:00Z",
    vaultPath: assignment.path,
    allDates: [],
  })
} finally {
  index.close()
}

const shim = join(root, "mock-ai.mjs"),
  preload = join(root, "preload.mjs")
await writeFile(
  shim,
  `export * from ${JSON.stringify(pathToFileURL(aiPath).href)};
import {MockLanguageModelV4} from ${JSON.stringify(pathToFileURL(testPath).href)};
import {readFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
export function createGateway(){return (model)=>new MockLanguageModelV4({provider:'mock',modelId:model,doGenerate:async ({prompt})=>{
 const root=process.env.SCHOOL_CLI_AUDIT_ROOT;const input=JSON.stringify(prompt);const fixture=JSON.parse(readFileSync(join(root,'fixture.json'),'utf8'));
 const revision=process.env.SCHOOL_CLI_AUDIT_REVISION==='1';
 const review=input.includes('Draft under review');
 if(revision&&!review&&model==='mock/draft'&&!input.includes('SYNTHETIC_STUDENT_EDIT'))throw new Error('Revision omitted student edit');
 const text=model==='mock/prep'?'## Overview\\nSynthetic evidence discussion.\\n## Readings\\n[Reading]('+fixture.readingLink+') distinguishes observations from assumptions.\\n## Preparation questions\\n### 1. Why separate observations from assumptions?\\nObservations provide evidence, while labeled assumptions remain premises rather than verified observations.\\n## Sources\\n[Reading]('+fixture.readingLink+')\\n':review?'Synthetic self-review only, not academic verification.':model==='mock/triage'?'Synthetic factual source summary.':revision?'# Synthetic revised memo\\n\\nSYNTHETIC_STUDENT_EDIT\\n\\nSynthetic revised evidence.':'# Synthetic memo\\n\\nSynthetic original evidence.';
 appendFileSync(join(root,process.env.SCHOOL_CLI_AUDIT_LABEL+'.model-calls.jsonl'),JSON.stringify({model,review,revision,promptHash:createHash('sha256').update(input).digest('hex')})+'\\n',{mode:0o600});
 return {content:[{type:'text',text}],finishReason:{unified:'stop'},usage:{inputTokens:{total:10,noCache:10},outputTokens:{total:5,text:5}},warnings:[]};}})}
import {createHash} from 'node:crypto';
`,
  { flag: "wx", mode: 0o600 },
)
await writeFile(
  preload,
  `import {registerHooks} from 'node:module';import {appendFileSync} from 'node:fs';import {join} from 'node:path';
globalThis.fetch=async()=>{appendFileSync(join(process.env.SCHOOL_CLI_AUDIT_ROOT,'network-attempts.txt'),'denied\\n');throw new Error('Network denied in synthetic installed School CLI audit')};
registerHooks({resolve(specifier,context,nextResolve){if(specifier==='ai')return {url:${JSON.stringify(pathToFileURL(shim).href)},shortCircuit:true};return nextResolve(specifier,context)}});
`,
  { flag: "wx", mode: 0o600 },
)
function cli(label, args, extraEnv) {
  const result = execute(
    process.execPath,
    ["--import", preload, join(school, "bin/school.js"), "--config", config, ...args],
    root,
    [0],
    { SCHOOL_CLI_AUDIT_LABEL: label, ...extraEnv },
  )
  return result.stdout.trim().split("\n").at(-1)
}
console.log(
  JSON.stringify({ root, phase: "actual-installed-cli-lifecycle", modelFactoryMocked: true }),
)
cli("doctor", ["doctor", "--sync-only"])
const prep = cli("prep", ["prep", course.code, "--week", "2026-10-12"])
assert(prep.includes("/Week 01 - Oct 12/Prep/"))
const prepBefore = await readFile(prep)
const draftLine = cli("draft", ["draft", "9"])
const [runId, draft] = draftLine.split("\t")
assert(runId && draft)
await writeFile(draft, `${await readFile(draft, "utf8")}\nSYNTHETIC_STUDENT_EDIT\n`)
const draftBefore = await readFile(draft)
const approved = cli("approve", ["approve", runId])
const finalBefore = await readFile(approved)
assert.deepEqual(await readFile(draft), draftBefore)
assert.equal(cli("approve-retry", ["approve", runId]), approved)
assert.deepEqual(await readFile(approved), finalBefore)
const revisionLine = cli(
  "revise",
  ["revise", runId, "Preserve my hand edits and clarify the evidence"],
  { SCHOOL_CLI_AUDIT_REVISION: "1" },
)
const [revisionRunId, revised] = revisionLine.split("\t")
assert.equal(revisionRunId, runId)
assert.notEqual(revised, draft)
assert.deepEqual(await readFile(draft), draftBefore)
assert.deepEqual(await readFile(approved), finalBefore)
const revisedApproval = cli("approve-revision", ["approve", runId])
const finalAfter = await readFile(revisedApproval)
const priorFinalPreserved = (await readFile(approved)).equals(finalBefore)
if (revisedApproval !== approved) {
  assert.equal(cli("approve-revision-retry", ["approve", runId]), revisedApproval)
  assert.deepEqual(await readFile(revisedApproval), finalAfter)
}
await writeFile(join(root, "retained-prior-final.md"), finalBefore, { flag: "wx", mode: 0o600 })
await writeFile(prep, `${prepBefore.toString()}\nSYNTHETIC_PREP_STUDENT_EDIT\n`)
const editedPrep = await readFile(prep)
await writeFile(join(root, "retained-edited-prep.md"), editedPrep, { flag: "wx", mode: 0o600 })
const rerunPrep = cli("prep-rerun", ["prep", course.code, "--week", "2026-10-12"])
assert(rerunPrep.includes("/Week 01 - Oct 12/Prep/"))
if (rerunPrep !== prep) {
  const rerunBytes = await readFile(rerunPrep)
  assert.equal(cli("prep-rerun-retry", ["prep", course.code, "--week", "2026-10-12"]), rerunPrep)
  assert.deepEqual(await readFile(rerunPrep), rerunBytes)
}
const prepEditPreserved = (await readFile(prep)).equals(editedPrep)
const networkFile = await readFile(join(root, "network-attempts.txt"), "utf8").catch((error) => {
  if (error.code !== "ENOENT") throw error
  return ""
})
assert.equal(networkFile, "")
const report = {
  root,
  status: priorFinalPreserved && prepEditPreserved ? "pass" : "preservation-gaps-found",
  commands,
  actualInstalledCliProcesses: commands.filter((row) => row.executable === process.execPath).length,
  sqliteDatabaseExecuted: true,
  modelFactoryMocked: true,
  realProviderTested: false,
  realSyncTested: false,
  sourcePackageVersion: requireSchool("./package.json").version,
  installedAiVersion: requireSchool("ai/package.json").version,
  originalDraftPreserved: true,
  revisionReceivesStudentEdit: true,
  approvalRetryPreserved: true,
  priorFinalPreservedAfterRevisionApproval: priorFinalPreserved,
  editedPrepPreservedAfterRerun: prepEditPreserved,
  networkAttempts: 0,
  academicQualityVerified: false,
}
await writeFile(join(root, "audit.json"), JSON.stringify(report, null, 2), {
  flag: "wx",
  mode: 0o600,
})
console.log(JSON.stringify(report, null, 2))
if (report.status !== "pass") process.exitCode = 2
