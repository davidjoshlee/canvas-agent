import type { Command } from "commander"
import { z } from "zod"
import { loadAdjacentEnv, loadConfig } from "../../src/config/index.js"
import type { ToolkitConfig } from "../../src/shared/types.js"
import { readTask } from "../../src/tasks/artifacts/records.js"
import {
  hasPrepMaterial,
  selectAssignmentPrompt,
  selectPrepInputs,
} from "../../src/tasks/authoring/recipes.js"
import { vaultMutation } from "../../src/vault/command-effects.js"
import { refreshConfiguredReadingMirror } from "../../src/vault/reading-copy.js"
import { inspectWorkspace, selectCourse } from "../../src/vault/workspace.js"
import { buildCoreDogfoodFlows } from "./core-flows.js"
import {
  createDogfood,
  type DogfoodJournal,
  listDogfood,
  readDogfood,
  runDogfood,
} from "./dogfood.js"
import { buildReviewDogfoodFlows } from "./review-flows.js"
import { executeDogfoodSweep, registerDogfoodSweepCommands } from "./sweep-cli.js"

const collect = (value: string, prior: string[]) => [...prior, value]
function emit(journal: DogfoodJournal, json: boolean) {
  const failed = journal.flows.some((flow) => flow.status === "fail")
  const last = journal.flows.at(-1)
  const complete =
    journal.flows.length === 10 &&
    journal.flows.every((flow) => ["pass", "skipped"].includes(flow.status))
  const value = {
    ...journal,
    complete,
    failed,
    passed: journal.flows.filter((flow) => flow.status === "pass").length,
    skipped: journal.flows.filter((flow) => flow.status === "skipped").length,
    limitation:
      "Mechanical workflow evidence, not academic correctness or full feature parity. Skipped flows are not passes. No Canvas submission or automatic human verdict.",
  }
  process.stdout.write(
    json
      ? `${JSON.stringify(value, null, 2)}\n`
      : `Dogfood run: ${journal.id}\n${complete ? "Workflow finished" : `Stopped at ${last?.name ?? "start"}: ${last?.status ?? "pending"}`}\n${last?.nextSteps ?? ""}\n`,
  )
  if (failed) process.exitCode = 1
}
async function scoped(program: Command, query: string) {
  const config = await loadConfig(program.opts().config)
  const course = selectCourse(await inspectWorkspace(config.vault.path), query)
  return { config, course }
}
async function execute(
  program: Command,
  config: ToolkitConfig,
  journal: DogfoodJournal,
  options: {
    offline?: boolean
    sync?: boolean
    json?: boolean
    verdict?: string[]
    approveTask?: string[]
  },
) {
  if (options.offline && options.sync) throw new Error("Choose --offline or --sync, not both")
  const verdicts: Record<string, "pass" | "fail"> = {}
  if ((options.verdict?.length ?? 0) > 100 || (options.approveTask?.length ?? 0) > 100)
    throw new Error("Too many dogfood review decisions")
  const known = new Set(
    journal.flows
      .flatMap((flow) => [flow.data.taskId, flow.data.revisionTaskId, flow.data.discussionTaskId])
      .filter(Boolean),
  )
  for (const item of options.verdict ?? []) {
    const match = item.match(/^([a-f0-9-]{36})=(pass|fail)$/i)
    const id = match?.[1] ?? "",
      verdict = match?.[2]?.toLowerCase()
    if (!z.string().uuid().safeParse(id).success || !known.has(id) || id in verdicts || !verdict)
      throw new Error(
        "Verdict must name a distinct completed task in this dogfood run: UUID=pass|fail",
      )
    if ((await readTask(config.vault.path, id)).status !== "completed")
      throw new Error("Cannot review an unfinished task")
    verdicts[id] = verdict as "pass" | "fail"
  }
  const approve = options.approveTask ?? []
  const approval = journal.flows.find((flow) => flow.name === "approve")
  if (
    new Set(approve).size !== approve.length ||
    approve.some((id) => !z.string().uuid().safeParse(id).success || id !== approval?.data.taskId)
  )
    throw new Error("Approval must name the exact task at this run's approval step")
  if (options.sync) await loadAdjacentEnv(program.opts().config)
  let studentWrite = false
  const input = {
    config,
    offline: Boolean(options.offline),
    syncAuthorized: Boolean(options.sync),
    humanVerdicts: verdicts,
    approveTaskIds: approve,
    onStudentWrite: () => {
      studentWrite = true
    },
  }
  const result = await runDogfood(config.vault.path, journal.id, journal.target, [
    ...buildCoreDogfoodFlows(input),
    ...buildReviewDogfoodFlows(input),
  ])
  if (studentWrite && !result.flows.some((flow) => flow.status === "fail")) {
    try {
      await refreshConfiguredReadingMirror(config.vault.path)
    } catch {
      process.stderr.write(
        "Reading-copy refresh failed after successful dogfood writes; inspect the saved mirror destination.\n",
      )
    }
  }
  emit(result, Boolean(options.json))
}
export function registerDogfoodCommand(program: Command) {
  const dogfood = program
    .command("dogfood")
    .hook("preAction", vaultMutation())
    .description("run resumable student-workflow checks with explicit host/human stops")
    .option("--course <course>", "explicit local course")
    .option("--week <date>", "explicit Monday for prep")
    .option("--session <selector>", "unique local session for prep")
    .option("--sessions <count>", "sweep the first N teaching sessions; 1–100")
    .option(
      "--assignment <selector>",
      "explicit assignment title, ID or path; omitted means prep-only",
    )
    .option("--offline", "deliberately skip live sync")
    .option("--sync", "authorize GET-only sync of this selected allowlisted course")
    .option("--json", "emit private run metadata, never source/output bodies")
    .action(async (options) => {
      if (options.sessions !== undefined) {
        if (
          !/^[1-9]\d*$/.test(options.sessions) ||
          Number(options.sessions) > 100 ||
          options.week ||
          options.session ||
          options.assignment
        )
          throw new Error(
            "Sweep requires a count from 1 to 100 and no single-period/assignment options",
          )
        await executeDogfoodSweep(program, options, { count: Number(options.sessions) })
        return
      }
      if (!options.course || Boolean(options.week) === Boolean(options.session))
        throw new Error("Dogfood needs an explicit course and exactly one week/session")
      if (options.offline && options.sync) throw new Error("Choose --offline or --sync, not both")
      const { config, course } = await scoped(program, options.course)
      const period = {
        kind: options.week ? ("week" as const) : ("session" as const),
        value: options.week ?? options.session,
      }
      if (!hasPrepMaterial(course, selectPrepInputs(course, period).sources))
        throw new Error("No substantive prep material for the chosen dogfood period")
      const assignment = options.assignment
        ? selectAssignmentPrompt(course, options.assignment).path
        : null
      const journal = await createDogfood(config.vault.path, {
        course: course.code,
        period,
        assignment,
      })
      await execute(program, config, journal, options)
    })
  registerDogfoodSweepCommands(program, dogfood)
  dogfood
    .command("list")
    .option("--course <course>", "explicit local course for saved journals (required)")
    .option("--json", "emit saved checkpoint metadata only")
    .action(async (_options, command: Command) => {
      const options = command.optsWithGlobals()
      if (!options.course) throw new Error("Dogfood list requires an explicit course")
      const { config, course } = await scoped(program, options.course)
      const result = await listDogfood(config.vault.path, course.code)
      process.stdout.write(
        options.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `${[
              `Saved dogfood runs for ${result.course}: ${result.runs.length}`,
              ...result.runs.map(
                (run) =>
                  `${run.id}\t${run.period.kind}: ${run.period.value}\tcheckpoint: ${run.lastCheckpoint?.name ?? "not started"}/${run.lastCheckpoint?.status ?? "none"}`,
              ),
              ...(result.unreadableRecords
                ? [
                    `Inventory incomplete: ${result.unreadableRecords} unreadable journal(s), scope unknown.`,
                  ]
                : []),
              result.limitation,
            ].join("\n")}\n`,
      )
    })
  dogfood
    .command("show <id>")
    .option("--course <course>", "explicit saved course scope (required)")
    .option("--json")
    .action(async (id, _options, command: Command) => {
      const options = command.optsWithGlobals()
      if (!options.course) throw new Error("Dogfood requires an explicit course")
      const { config, course } = await scoped(program, options.course)
      const journal = await readDogfood(config.vault.path, id)
      if (course.code !== journal.target.course)
        throw new Error("Dogfood course does not match the saved run")
      emit(journal, Boolean(options.json))
    })
  dogfood
    .command("resume <id>")
    .hook("preAction", vaultMutation())
    .option("--course <course>", "explicit saved course scope (required)")
    .option("--offline", "deliberately skip live sync")
    .option("--sync", "authorize selected-course sync")
    .option(
      "--verdict <UUID=pass|fail>",
      "explicit human verdict for a completed run task; repeatable",
      collect,
      [],
    )
    .option(
      "--approve-task <UUID>",
      "student-directed local approval of the exact waiting revised task",
      collect,
      [],
    )
    .option("--json")
    .action(async (id, _options, command: Command) => {
      const options = command.optsWithGlobals()
      if (!options.course) throw new Error("Dogfood requires an explicit course")
      const { config, course } = await scoped(program, options.course)
      const journal = await readDogfood(config.vault.path, id)
      if (course.code !== journal.target.course)
        throw new Error("Dogfood course does not match the saved run")
      await execute(program, config, journal, options)
    })
}
