import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createRequire, syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"

// Run with tsx and an explicit maintainer checkout. No sibling edits, real
// config/vault/environment reads, provider calls, or student approval occur.
const publicBaseline = process.argv.includes("--public-baseline")
const [school, mode, root, runId] = process.argv
  .slice(2)
  .filter((arg) => arg !== "--public-baseline")
if (!school || !isAbsolute(school)) throw new Error("Supply an absolute School source checkout")
const script = import.meta.filename
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
const source = (path) => import(pathToFileURL(join(school, path)).href)

if (mode) {
  if (!root || !isAbsolute(root)) throw new Error("Worker requires an absolute synthetic root")
  let networkAttempts = 0
  globalThis.fetch = async () => {
    networkAttempts++
    throw new Error("Network denied in synthetic School recovery audit")
  }
  const requireSchool = createRequire(join(school, "package.json"))
  const { tool } = await import(pathToFileURL(requireSchool.resolve("ai")).href)
  const { MockLanguageModelV4 } = await import(pathToFileURL(requireSchool.resolve("ai/test")).href)
  const { z } = await import(pathToFileURL(requireSchool.resolve("zod")).href)
  const { AISDKAgentRunner } = await source("src/agents/runner.ts")
  const vault = join(root, "vault")
  const gate = tool({
    description: "Synthetic approval gate",
    inputSchema: z.object({ artifact: z.string() }),
    execute: async () => {
      await writeFile(join(root, "gate-executed.json"), JSON.stringify({ runId }), { flag: "wx" })
      return { approved: true }
    },
  })
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  }
  const prepReading = "Week 01 - Oct 12/Materials/reading.md"
  const prepText = `## Overview\nSynthetic evidence discussion.\n## Readings\n[Reading](${prepReading}) distinguishes observations from assumptions.\n## Preparation questions\n### 1. Why separate observations from assumptions?\nObservations provide evidence, while labeled assumptions remain premises rather than verified observations.\n## Sources\n[Reading](${prepReading})\n`
  let revisionInputVerified = false
  let generationCalls = 0
  const runner = new AISDKAgentRunner({
    runsDir: join(vault, ".agent-runs"),
    tools: { assignment_gate: gate },
    toolApproval: { assignment_gate: "user-approval" },
    model: new MockLanguageModelV4({
      provider: "mock",
      modelId: "mock-recovery",
      doGenerate: ({ prompt }) => {
        generationCalls++
        const review = JSON.stringify(prompt).includes("Draft under review")
        if (mode === "revise" && !review) {
          assert(JSON.stringify(prompt).includes("SYNTHETIC_STUDENT_EDIT"))
          assert(JSON.stringify(prompt).includes("Keep the synthetic student edit"))
          revisionInputVerified = true
        }
        return {
          content:
            mode === "park"
              ? [
                  {
                    type: "tool-call",
                    toolCallId: "synthetic-gate",
                    toolName: "assignment_gate",
                    input: '{"artifact":"synthetic"}',
                  },
                ]
              : [
                  {
                    type: "text",
                    text:
                      mode === "resume"
                        ? "Recovered synthetic run"
                        : review
                          ? "Synthetic self-review only; not academic verification."
                          : mode === "prep-reject-filler"
                            ? prepText.replace(
                                "Observations provide evidence, while labeled assumptions remain premises rather than verified observations.",
                                "This answer discusses various important factors that are very interesting.",
                              )
                            : mode === "prep" || mode === "prep-rerun"
                              ? prepText
                              : mode === "revise"
                                ? "# Synthetic revised memo\n\nSYNTHETIC_STUDENT_EDIT\n\nSynthetic revision after process restart."
                                : "# Synthetic memo\n\nSynthetic draft retained across process death.",
                  },
                ],
          finishReason: { unified: mode === "park" ? "tool-calls" : "stop" },
          usage,
        }
      },
    }),
  })
  let result
  if (mode === "park") {
    result = await runner.run("Synthetic process recovery gate")
    assert.equal(result.status, "pending_approval")
  } else if (mode === "resume") {
    const parked = await runner.get(runId)
    assert.equal(parked.status, "pending_approval")
    result = await runner.approve(runId)
    assert.equal(result.status, "completed")
    assert.equal(result.text, "Recovered synthetic run")
  } else if (mode === "stage") {
    const { AgentRunStore } = await source("src/agents/run-store.ts")
    const store = new AgentRunStore(join(vault, ".agent-runs"))
    const original = await store.get(runId)
    const destination = join(vault, ".agent-runs", `${runId}.json`)
    const rename = fs.promises.rename
    fs.promises.rename = async (from, to) => {
      if (to === destination) {
        // The actual store has written its temporary file, but has not replaced
        // the authoritative record. Kill only this confirmed synthetic writer.
        assert.equal(
          JSON.parse(await readFile(from, "utf8")).resultText,
          "UNCOMMITTED_SYNTHETIC_REPLACEMENT",
        )
        assert.equal(networkAttempts, 0)
        process.send({ result: { runId }, networkAttempts })
        await new Promise(() => {
          setInterval(() => {}, 1000)
        })
      }
      return rename(from, to)
    }
    syncBuiltinESMExports()
    await store.save({ ...original, resultText: "UNCOMMITTED_SYNTHETIC_REPLACEMENT" })
    throw new Error("Interrupted record replacement unexpectedly returned")
  } else if (mode === "inspect") {
    const saved = await runner.get(runId)
    assert.equal(saved.status, "completed")
    assert.equal(saved.resultText, "Recovered synthetic run")
    result = { runId: saved.id, text: saved.resultText }
  } else if (mode === "draft") {
    const { schoolConfig } = await source("test/helpers/schoolConfig.ts")
    const { coursePaths } = await source("src/store/paths.ts")
    const { createVaultFrontmatter, renderVaultDocument } = await source(
      "src/store/vault-document.ts",
    )
    const { createSchoolIndex } = await source("src/store/db.ts")
    const { draftAssignment } = await source("src/engines/assignment.ts")
    const { VaultWriter } = await source("src/store/vault.ts")
    // Let the actual writer initialize an empty owned vault before raw fixture
    // documents exist; the public release correctly refuses unmarked old roots.
    await new VaultWriter({ root: vault, gitInit: false }).writeMetadata({
      artifact: "alert",
      canvasUrl: "https://canvas.example.invalid/resource",
      content: "Synthetic recovery fixture marker only; not an authentication alert.",
    })
    const config = schoolConfig({
      vaultPath: vault,
      courses: { pilotCourseId: null, allowlist: [] },
      canvas: { baseUrl: "https://canvas.example.invalid" },
    })
    await writeFile(join(root, "school.config.json"), JSON.stringify(config), {
      flag: "wx",
      mode: 0o600,
    })
    const course = {
      code: "SYNTH101",
      canvasId: "17",
      canvasUrl: "https://canvas.example.invalid/courses/17",
      aiPolicy: "allowed",
    }
    const assignment = {
      canvasId: "9",
      title: "Synthetic Memo",
      canvasUrl: "https://canvas.example.invalid/assignments/9",
    }
    const paths = coursePaths(vault, course.code, course.canvasId)
    for (const [path, content] of [
      [paths.syllabus, "Synthetic engineering fixture, not coursework."],
      [join(paths.assignments, "memo.md"), "Write a synthetic memo."],
      [
        paths.index,
        "| title | type | dates | path | token estimate |\n| --- | --- | --- | --- | --- |\n| Synthetic Memo | assignment | 2026-10-14 | assignments/memo.md | 10 |",
      ],
    ]) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(
        path,
        renderVaultDocument(
          createVaultFrontmatter({
            canvasId: "fixture",
            canvasUrl: "https://canvas.example.invalid/resource",
            type: "fixture",
            content,
            source: "sync",
            status: "approved",
            aiPolicy: "allowed",
          }),
          content,
        ),
        { flag: "wx" },
      )
    }
    const index = createSchoolIndex({ path: config.index.path })
    try {
      result = await draftAssignment({
        vaultRoot: vault,
        config,
        course,
        assignment,
        runner,
        index,
        triage: { summarize: async () => "Synthetic summary" },
      })
    } finally {
      index.close()
    }
    assert.equal((await runner.get(result.runId)).status, "completed")
    const originalDraft = await readFile(result.path, "utf8")
    assert(originalDraft.includes("## Correctness check"))
    await writeFile(
      result.path,
      `${originalDraft.replace(
        "## Correctness check",
        "SYNTHETIC_STUDENT_EDIT\n\n## Correctness check",
      )}\nSYNTHETIC_REVIEW_NOTE\n`,
    )
  } else if (mode === "revise") {
    const { reviseAssignment } = await source("src/engines/assignment.ts")
    const { createSchoolIndex } = await source("src/store/db.ts")
    const config = JSON.parse(await readFile(join(root, "school.config.json"), "utf8"))
    const index = createSchoolIndex({ path: config.index.path })
    try {
      result = await reviseAssignment({
        vaultRoot: vault,
        config,
        runner,
        runId,
        feedback: "Keep the synthetic student edit and clarify the evidence.",
        index,
        triage: { summarize: async () => "Synthetic summary" },
      })
    } finally {
      index.close()
    }
    assert(revisionInputVerified)
    assert.equal(result.runId, runId)
    assert((await readFile(result.path, "utf8")).includes("SYNTHETIC_STUDENT_EDIT"))
  } else if (
    ["prep", "prep-rerun", "prep-inspect", "prep-reject-filler", "prep-no-period"].includes(mode)
  ) {
    const { schoolConfig } = await source("test/helpers/schoolConfig.ts")
    const { coursePaths } = await source("src/store/paths.ts")
    const { createVaultFrontmatter, renderVaultDocument, parseVaultDocument } = await source(
      "src/store/vault-document.ts",
    )
    const { createSchoolIndex } = await source("src/store/db.ts")
    const { generatePrepBrief } = await source("src/engines/prep.ts")
    const { VaultWriter } = await source("src/store/vault.ts")
    const course = {
      code: "SYNTH201",
      canvasId: "18",
      canvasUrl: "https://canvas.example.invalid/courses/18",
      aiPolicy: "allowed",
    }
    const paths = coursePaths(vault, course.code, course.canvasId)
    const config = schoolConfig({
      vaultPath: vault,
      courses: { pilotCourseId: null, allowlist: [] },
      canvas: { baseUrl: "https://canvas.example.invalid" },
    })
    if (mode === "prep") {
      await new VaultWriter({ root: vault, gitInit: false }).writeMetadata({
        artifact: "alert",
        canvasUrl: "https://canvas.example.invalid/resource",
        content: "Synthetic recovery fixture marker only; not an authentication alert.",
      })
      for (const [path, content, type, id, dates] of [
        [
          paths.syllabus,
          "Synthetic evidence course, engineering fixture only.",
          "fixture",
          "syllabus",
          {},
        ],
        [
          join(paths.guidance, "prep-guidance.md"),
          "## Brief structure\nOverview, Readings, Preparation questions, Sources",
          "guidance",
          "guide",
          {},
        ],
        [
          join(paths.root, "Week 01 - Oct 12/00 Overview.md"),
          "Evidence session\n- File: Reading (canvas_id: 501)",
          "modules",
          "201",
          { unlock_at: "2026-10-12T00:00:00Z" },
        ],
        [
          join(paths.root, prepReading),
          "Observations provide evidence, whereas assumptions are labeled premises that may require further investigation.\n## Preparation questions\n1. Why separate observations from assumptions?",
          "files",
          "501",
          {},
        ],
        [
          paths.index,
          `| title | type | dates | path | token estimate |\n| --- | --- | --- | --- | --- |\n| Reading | file | 2026-10-12 | ${prepReading} | 30 |`,
          "fixture",
          "index",
          {},
        ],
      ]) {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(
          path,
          renderVaultDocument(
            createVaultFrontmatter({
              canvasId: id,
              canvasUrl: "https://canvas.example.invalid/resource",
              type,
              content,
              dates,
              source: "sync",
              status: "approved",
              aiPolicy: "allowed",
            }),
            content,
          ),
          { flag: "wx" },
        )
      }
    }
    const checkpointPath = join(root, "prep-checkpoint.json")
    if (mode === "prep-reject-filler" || mode === "prep-no-period") {
      assert(publicBaseline)
      const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"))
      const originalBytes = await readFile(checkpoint.path)
      const index = createSchoolIndex({ path: config.index.path })
      let errorName
      try {
        await generatePrepBrief({
          vaultRoot: vault,
          config,
          course,
          period: { kind: "week", value: mode === "prep-no-period" ? "2026-10-19" : "2026-10-12" },
          index,
          runner,
          triage: { summarize: async () => "Synthetic summary" },
        })
      } catch (error) {
        errorName = error.name
      } finally {
        index.close()
      }
      assert.equal(
        errorName,
        mode === "prep-no-period" ? "PrepPeriodNotFoundError" : "PrepContentError",
      )
      assert.equal(generationCalls, mode === "prep-no-period" ? 0 : 1)
      assert.deepEqual(await readFile(checkpoint.path), originalBytes)
      result = { rejected: true, originalPrepPreserved: true, errorName, generationCalls }
    } else if (mode === "prep-inspect") {
      result = JSON.parse(await readFile(checkpointPath, "utf8"))
      const saved = await runner.get(result.runId)
      assert.equal(saved.status, "completed")
      const parsed = parseVaultDocument(await readFile(result.path, "utf8"), result.path)
      assert.equal(parsed.frontmatter.dates.period, "week-2026-10-12")
      assert.equal(parsed.frontmatter.status, "auto-final")
      assert(parsed.content.includes("### 1. Why separate observations from assumptions?"))
      assert(result.path.includes("/SYNTH201/Week 01 - Oct 12/Prep/"))
    } else {
      const index = createSchoolIndex({ path: config.index.path })
      try {
        result = await generatePrepBrief({
          vaultRoot: vault,
          config,
          course,
          period: { kind: "week", value: "2026-10-12" },
          index,
          runner,
          triage: { summarize: async () => "Synthetic summary" },
        })
      } finally {
        index.close()
      }
      if (mode === "prep") {
        const runs = await runner.list()
        assert.equal(runs.length, 1)
        result = { ...result, runId: runs[0].id }
        await writeFile(checkpointPath, JSON.stringify(result), { flag: "wx", mode: 0o600 })
      }
    }
  } else if (mode === "cli") {
    // Full command registration/config loading, not a direct approval engine call.
    const { runCli } = await source("src/cli.ts")
    const printed = []
    const originalLog = console.log
    try {
      console.log = (...values) => {
        printed.push(values.join(" "))
      }
      assert.equal(
        await runCli(["--config", join(root, "school.config.json"), "approve", runId]),
        0,
      )
    } finally {
      console.log = originalLog
    }
    assert.equal(printed.length, 1)
    assert(printed[0].startsWith(`${vault}/`))
    assert(printed[0].includes("/Final/"))
    result = { runId, path: printed[0] }
  } else throw new Error("Unknown synthetic audit worker")
  assert.equal(networkAttempts, 0)
  process.send({ result, networkAttempts })
  if (["park", "draft", "revise", "prep"].includes(mode)) {
    // Parent kills this confirmed live process only after the durable checkpoint.
    await new Promise(() => {
      setInterval(() => {}, 1000)
    })
  } else process.disconnect()
} else {
  const ownedRoot = await mkdtemp(join(tmpdir(), "canvas-school-process-recovery-"))
  const childEnv = Object.fromEntries(
    ["PATH", "SystemRoot", "COMSPEC", "PATHEXT"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  )
  // HOME/TMPDIR are owned fixtures: no user config, adjacent .env or real index.
  childEnv.HOME = join(ownedRoot, "home")
  childEnv.TMPDIR = ownedRoot
  await mkdir(childEnv.HOME)
  let processes = 0
  async function worker(workerMode, fixture, id, kill = false) {
    processes++
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        script,
        school,
        workerMode,
        fixture,
        ...(id ? [id] : []),
        ...(publicBaseline ? ["--public-baseline"] : []),
      ],
      { cwd: ownedRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe", "ipc"] },
    )
    let stderr = ""
    child.stderr.on("data", (bytes) => {
      stderr += bytes
    })
    child.stdout.resume()
    return new Promise((resolve, reject) => {
      let checkpoint
      let killed = false
      const timeout = setTimeout(() => {
        child.kill("SIGKILL")
        reject(new Error("Synthetic recovery worker timed out"))
      }, 30_000)
      child.once("error", (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.on("message", (message) => {
        checkpoint = message
        if (kill) killed = child.kill("SIGKILL")
      })
      child.once("exit", (code, signal) => {
        clearTimeout(timeout)
        try {
          assert(checkpoint, `No durable checkpoint: ${stderr}`)
          if (kill) {
            assert(killed)
            assert.equal(signal, "SIGKILL")
          } else assert.equal(code, 0, stderr)
          resolve(checkpoint.result)
        } catch (error) {
          reject(error)
        }
      })
    })
  }
  const gated = join(ownedRoot, "gated")
  await mkdir(gated)
  const parked = await worker("park", gated, undefined, true)
  const parkedPath = join(gated, "vault/.agent-runs", `${parked.runId}.json`)
  const before = JSON.parse(await readFile(parkedPath, "utf8"))
  const resumed = await worker("resume", gated, parked.runId)
  assert.equal(resumed.runId, parked.runId)
  const after = JSON.parse(await readFile(parkedPath, "utf8"))
  assert.equal(after.createdAt, before.createdAt)
  assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages)
  assert.equal(
    JSON.parse(await readFile(join(gated, "gate-executed.json"), "utf8")).runId,
    parked.runId,
  )
  const completedBytes = await readFile(parkedPath)
  await worker("stage", gated, parked.runId, true)
  assert.deepEqual(await readFile(parkedPath), completedBytes)
  const inspected = await worker("inspect", gated, parked.runId)
  assert.equal(inspected.runId, parked.runId)
  assert.deepEqual(await readFile(parkedPath), completedBytes)
  const draftRoot = join(ownedRoot, "draft")
  await mkdir(draftRoot)
  const draft = await worker("draft", draftRoot, undefined, true)
  const draftBytes = await readFile(draft.path)
  const runPath = join(draftRoot, "vault/.agent-runs", `${draft.runId}.json`)
  const runBytes = await readFile(runPath)
  const approved = await worker("cli", draftRoot, draft.runId)
  const finalBytes = await readFile(approved.path)
  assert(finalBytes.toString().includes("Synthetic draft retained across process death."))
  assert(finalBytes.toString().includes("SYNTHETIC_STUDENT_EDIT"))
  assert(!finalBytes.toString().includes("SYNTHETIC_REVIEW_NOTE"))
  assert(draftBytes.toString().includes("SYNTHETIC_REVIEW_NOTE"))
  assert.deepEqual(await readFile(draft.path), draftBytes)
  assert.deepEqual(await readFile(runPath), runBytes)
  // Retry the first approval before deliberately revising its same School run.
  const retried = await worker("cli", draftRoot, draft.runId)
  assert.equal(retried.path, approved.path)
  assert.deepEqual(await readFile(approved.path), finalBytes)
  assert.deepEqual(await readFile(draft.path), draftBytes)
  assert.deepEqual(await readFile(runPath), runBytes)
  const revised = await worker("revise", draftRoot, draft.runId, true)
  assert.notEqual(revised.path, draft.path)
  assert.deepEqual(await readFile(draft.path), draftBytes)
  assert.deepEqual(await readFile(approved.path), finalBytes)
  const revisedRunBytes = await readFile(runPath)
  const revisedRun = JSON.parse(revisedRunBytes)
  const originalRun = JSON.parse(runBytes)
  assert.equal(revisedRun.id, originalRun.id)
  assert.equal(revisedRun.createdAt, originalRun.createdAt)
  assert.deepEqual(revisedRun.messages.slice(0, originalRun.messages.length), originalRun.messages)
  const revisedBytes = await readFile(revised.path)
  const revisedApproval = await worker("cli", draftRoot, revised.runId)
  const revisedFinalBytes = await readFile(revisedApproval.path)
  assert(revisedFinalBytes.toString().includes("Synthetic revision after process restart."))
  assert(revisedFinalBytes.toString().includes("SYNTHETIC_STUDENT_EDIT"))
  const priorFinalPreserved =
    revisedApproval.path !== approved.path || revisedFinalBytes.equals(finalBytes)
  await writeFile(join(draftRoot, "retained-prior-final.md"), finalBytes, { flag: "wx" })
  const revisedRetry = await worker("cli", draftRoot, revised.runId)
  assert.equal(revisedRetry.path, revisedApproval.path)
  assert.deepEqual(await readFile(revisedApproval.path), revisedFinalBytes)
  assert.deepEqual(await readFile(revised.path), revisedBytes)
  assert.deepEqual(await readFile(draft.path), draftBytes)
  assert.deepEqual(await readFile(runPath), revisedRunBytes)
  const prepRoot = join(ownedRoot, "prep")
  await mkdir(prepRoot)
  const prep = await worker("prep", prepRoot, undefined, true)
  const prepBytes = await readFile(prep.path)
  const prepRunPath = join(prepRoot, "vault/.agent-runs", `${prep.runId}.json`)
  const prepRunBytes = await readFile(prepRunPath)
  const inspectedPrep = await worker("prep-inspect", prepRoot)
  assert.equal(inspectedPrep.runId, prep.runId)
  assert.deepEqual(await readFile(prep.path), prepBytes)
  assert.deepEqual(await readFile(prepRunPath), prepRunBytes)
  let publicGenericAnswerRejected = false
  let publicUnmatchedPeriodRejectedBeforeModelCall = false
  if (publicBaseline) {
    const rejected = await worker("prep-reject-filler", prepRoot)
    publicGenericAnswerRejected = rejected.rejected && rejected.originalPrepPreserved
    const unmatched = await worker("prep-no-period", prepRoot)
    publicUnmatchedPeriodRejectedBeforeModelCall =
      unmatched.rejected && unmatched.generationCalls === 0
    assert.deepEqual(await readFile(prep.path), prepBytes)
  }
  await writeFile(prep.path, `${prepBytes.toString()}\nSYNTHETIC_PREP_STUDENT_EDIT\n`)
  const editedPrepBytes = await readFile(prep.path)
  await writeFile(join(prepRoot, "retained-edited-prep.md"), editedPrepBytes, { flag: "wx" })
  const refreshed = await worker("prep-rerun", prepRoot)
  const prepEditPreserved = (await readFile(prep.path, "utf8")).includes(
    "SYNTHETIC_PREP_STUDENT_EDIT",
  )
  assert.equal(refreshed.path, prep.path)
  assert.deepEqual(await readFile(prepRunPath), prepRunBytes)
  const report = {
    status: priorFinalPreserved && prepEditPreserved ? "pass" : "preservation-gaps-found",
    syntheticRoot: ownedRoot,
    schoolProcesses: processes,
    actualProcessKills: 5,
    parkedRunRecoveryTested: true,
    completedDraftCliApprovalTested: true,
    originalDraftAndRunPreservedBeforeRevision: true,
    finalRetryBytesPreserved: true,
    studentEditPreserved: true,
    interruptedAtomicReplacementTested: true,
    completedRevisionProcessRecoveryTested: true,
    revisionUsesOriginalRunIdAndHistoryPrefix: true,
    revisionReceivesStudentEditAndFeedback: true,
    originalDraftPreservedAfterRevision: true,
    revisedFinalRetryBytesPreserved: true,
    priorFinalPreservedAfterRevisionApproval: priorFinalPreserved,
    completedPrepProcessRecoveryTested: true,
    prepCoursePeriodStructureQuestionsVerified: true,
    editedPrepPreservedAfterExplicitRerun: prepEditPreserved,
    fullPreservationRequirementMet: priorFinalPreserved && prepEditPreserved,
    publicBaselineChecksRequested: publicBaseline,
    publicGenericAnswerRejected,
    publicUnmatchedPeriodRejectedBeforeModelCall,
    networkAttempts: 0,
    goalControllerInterruptionTested: false,
    pendingGateCliProviderTested: false,
    prepEngineCliProviderTested: false,
    revisionCliProviderTested: false,
    siblingSourceWritesPerformed: false,
    sourceHashes: Object.fromEntries(
      await Promise.all(
        [
          "src/agents/runner.ts",
          "src/agents/run-store.ts",
          "src/engines/assignment.ts",
          "src/engines/assignment-cli.ts",
          "src/engines/prep.ts",
          "src/store/vault.ts",
        ].map(async (path) => [path, digest(await readFile(join(school, path)))]),
      ),
    ),
  }
  const serialized = JSON.stringify(report, null, 2)
  await writeFile(join(ownedRoot, "audit-report.json"), `${serialized}\n`, {
    flag: "wx",
    mode: 0o600,
  })
  console.log(serialized)
}
