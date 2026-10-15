import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Command } from "commander"
import { syncCourses } from "./canvas.js"
import { loadAdjacentEnv, loadConfig } from "./config.js"
import { readDogfood, runDogfood } from "./dogfood.js"
import {
  buildCoreDogfoodFlows,
  type CoreDogfoodInput,
  dogfoodCourseFingerprint,
} from "./dogfood-core-flows.js"
import { buildReviewDogfoodFlows } from "./dogfood-review-flows.js"
import {
  createDogfoodSweep,
  initializeDogfoodSweep,
  inspectDogfoodSweep,
  listDogfoodSweeps,
  validateDogfoodSweepSelection,
} from "./dogfood-sweep.js"
import { assertNoSymlinks } from "./fs-safety.js"
import { refreshConfiguredReadingMirror } from "./reading-copy.js"
import { inspectWorkspace, selectCourse } from "./workspace.js"

type SweepOptions = { course?: string; offline?: boolean; sync?: boolean; json?: boolean }
function emit(
  value: Awaited<ReturnType<typeof inspectDogfoodSweep>> & {
    evidenceRevalidated: boolean
    failed?: boolean
    complete?: boolean
    report?: string
    reportedAt?: string
  },
  json?: boolean,
) {
  process.stdout.write(
    json
      ? `${JSON.stringify(value, null, 2)}\n`
      : `Dogfood sweep: ${value.id}\n${value.sessions.map((entry) => `Session ${entry.number}: ${entry.runId} — ${entry.state}`).join("\n")}\nResume individual runs for host generation, human verdicts and explicit approval.\n`,
  )
  if (value.failed) process.exitCode = 1
}
/** Start/resume every child once; host/human stops remain independent per session. */
export async function executeDogfoodSweep(
  program: Command,
  options: SweepOptions,
  request: { count: number } | { id: string },
) {
  if (!options.course) throw new Error("Dogfood sweep requires an explicit course")
  if (options.offline && options.sync) throw new Error("Choose --offline or --sync, not both")
  const config = await loadConfig(program.opts().config)
  let course = selectCourse(await inspectWorkspace(config.vault.path), options.course)
  let studentWrite = false,
    preSynced: CoreDogfoodInput["preSynced"]
  let needsSync = "count" in request
  if ("id" in request) {
    let existing = await inspectDogfoodSweep(config.vault.path, course.code, request.id)
    if (existing.sessions.some((session) => session.state === "not-initialized")) {
      await initializeDogfoodSweep(config.vault.path, course.code, request.id)
      existing = await inspectDogfoodSweep(config.vault.path, course.code, request.id)
    }
    for (const session of existing.sessions) {
      try {
        const run = await readDogfood(config.vault.path, session.runId),
          sync = run.flows[0]
        if (sync?.status !== "pass" || sync.data.fingerprint !== dogfoodCourseFingerprint(course))
          needsSync = true
      } catch {
        needsSync = true
      }
    }
  }
  if (options.sync && needsSync) {
    if (!course.canvasId || !config.courses.allowlist.includes(course.canvasId))
      throw new Error("Sweep course must already be allowlisted for sync")
    await loadAdjacentEnv(program.opts().config)
    const report = await syncCourses({ ...config, courses: { allowlist: [course.canvasId] } })
    if (report.courses !== 1) throw new Error("Sweep sync did not return exactly one course")
    course = selectCourse(await inspectWorkspace(config.vault.path), course.code)
    preSynced = {
      fingerprint: dogfoodCourseFingerprint(course),
      written: report.written.length,
      notices: report.notices.length,
    }
    studentWrite = report.written.length > 0
  } else if (options.sync) await loadAdjacentEnv(program.opts().config)
  const id =
    "count" in request
      ? (await createDogfoodSweep(config.vault.path, course.code, request.count)).id
      : request.id
  let saved = await inspectDogfoodSweep(config.vault.path, course.code, id)
  await validateDogfoodSweepSelection(config.vault.path, course.code, id)
  if (saved.sessions.some((session) => session.state === "not-initialized")) {
    await initializeDogfoodSweep(config.vault.path, course.code, id)
    saved = await inspectDogfoodSweep(config.vault.path, course.code, id)
  }
  const input: CoreDogfoodInput = {
    config,
    offline: Boolean(options.offline),
    syncAuthorized: Boolean(options.sync),
    ...(preSynced ? { preSynced } : {}),
    onStudentWrite: () => {
      studentWrite = true
    },
  }
  const sessions = []
  for (const session of saved.sessions) {
    try {
      const result = await runDogfood(
        config.vault.path,
        session.runId,
        {
          course: saved.course,
          period: { kind: "session", value: session.selector },
          assignment: session.assignment,
        },
        [...buildCoreDogfoodFlows(input), ...buildReviewDogfoodFlows(input)],
      )
      const last = result.flows.at(-1)
      sessions.push({
        ...session,
        state: last?.status ?? "not-started",
        flowsRecorded: result.flows.length,
        activeTaskId: last?.data.taskId ?? null,
        nextSteps: last?.nextSteps ?? "",
        recordedComplete:
          result.flows.length === 10 &&
          result.flows.every((flow) => ["pass", "skipped"].includes(flow.status)),
      })
    } catch {
      sessions.push({ ...session, state: "invalid", recordedComplete: false })
    }
  }
  const failed = sessions.some((session) => ["fail", "invalid"].includes(session.state))
  if (studentWrite && !failed) {
    try {
      await refreshConfiguredReadingMirror(config.vault.path)
    } catch {
      process.stderr.write(
        "Reading-copy refresh failed after successful sweep writes; inspect the saved mirror destination.\n",
      )
    }
  }
  const report = {
    ...saved,
    sessions,
    evidenceRevalidated: !failed,
    failed,
    complete: sessions.every((session) => session.recordedComplete),
    reportedAt: new Date().toISOString(),
    limitation:
      "Current child attempts and recorded states; invalid/failed evidence never counts as complete. Human decisions remain explicit. This does not establish academic correctness, live acceptance or full parity.",
  }
  const directory = join(config.vault.path, "_meta/dogfood-sweeps", id, "reports")
  await assertNoSymlinks(directory, true)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const reportPath = `_meta/dogfood-sweeps/${id}/reports/${randomUUID()}.json`
  await assertNoSymlinks(join(config.vault.path, reportPath), true)
  await writeFile(join(config.vault.path, reportPath), JSON.stringify(report, null, 2), {
    flag: "wx",
    mode: 0o600,
  })
  emit({ ...report, report: reportPath }, options.json)
}
export function registerDogfoodSweepCommands(program: Command, dogfood: Command) {
  const sweep = dogfood
    .command("sweep")
    .description("inspect or resume an explicitly scoped multi-session sweep")
  sweep
    .command("list")
    .option("--course <course>", "explicit saved course (required)")
    .option("--json")
    .action(async (_options, command: Command) => {
      const options = command.optsWithGlobals()
      if (!options.course) throw new Error("Dogfood sweep requires an explicit course")
      const config = await loadConfig(program.opts().config)
      const result = await listDogfoodSweeps(config.vault.path, options.course)
      process.stdout.write(
        options.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `${result.sweeps.map((entry) => `${entry.id} — ${entry.sessionCount} saved sessions`).join("\n") || "No saved sweeps."}\n${result.inventoryComplete ? "" : "Warning: sweep inventory is incomplete.\n"}${result.limitation}\n`,
      )
    })
  sweep
    .command("show <id>")
    .option("--course <course>", "explicit saved course (required)")
    .option("--json")
    .action(async (id, _options, command: Command) => {
      const options = command.optsWithGlobals()
      if (!options.course) throw new Error("Dogfood sweep requires an explicit course")
      const config = await loadConfig(program.opts().config)
      emit(await inspectDogfoodSweep(config.vault.path, options.course, id), options.json)
    })
  sweep
    .command("resume <id>")
    .option("--course <course>", "explicit saved course (required)")
    .option("--offline", "skip live sync deliberately")
    .option("--sync", "authorize selected-course sync")
    .option("--json")
    .action(async (id, _options, command: Command) => {
      await executeDogfoodSweep(program, command.optsWithGlobals(), { id })
    })
}
