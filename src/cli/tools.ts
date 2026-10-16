import type { Command } from "commander"
import { loadConfig } from "../config/index.js"
import { calculateSimulationBatch, readSimulationCalculations } from "../evaluation/calculations.js"
import {
  captureSimulation,
  deriveSimulationCapture,
  listSimulationCaptures,
  replaySimulation,
} from "../evaluation/captures.js"
import { compareSimulationEvaluations } from "../evaluation/comparison.js"
import { readHostUsage, renderHostUsage } from "../evaluation/host-usage.js"
import { comparisonM1Bundle, legacyM1Bundle } from "../evaluation/m1.js"
import {
  completeSimulationTask,
  createSimulationTask,
  inspectSimulationTask,
  listSimulationTasks,
} from "../evaluation/tasks.js"
import {
  compareSimulationWindow,
  createSimulationWindow,
  inspectSimulationWindow,
  listSimulationWindows,
  resumeSimulationWindow,
} from "../evaluation/window.js"
import { createSimulationWorkbook, readSimulationWorkbooks } from "../evaluation/workbooks.js"
import type { ToolkitConfig } from "../shared/types.js"
import { CALCULATION_OPERATIONS } from "../tasks/calculation-core.js"
import { readCalculationBatchFile } from "../tasks/calculation-input.js"
import {
  listCorrectnessReviews,
  prepareCorrectnessReview,
  saveCorrectnessReview,
  showCorrectnessReview,
} from "../tasks/correctness-review.js"
import { compareTasks, inspectTask } from "../tasks/inspection.js"
import { taskInspectionCommand, taskLocations } from "../tasks/locations.js"
import { checkFrozenTaskNumbers, checkTaskNumbers } from "../tasks/numeric-review.js"
import { calculateBatchTask, calculateTask, reviewGate, workbookTask } from "../tasks/tools.js"
import { vaultMutation } from "../vault/command-effects.js"
import { readTaskOutput } from "./task-output.js"

const defaultConfig = "./canvas-agent.config.json"

async function commandConfig(command: Command): Promise<ToolkitConfig> {
  const options = command.optsWithGlobals() as { config?: string }
  return loadConfig(options.config ?? defaultConfig)
}

function render(value: unknown, json: boolean, message: string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${message}\n`)
}

/** Register local, model-free evaluation and calculation tools on the supplied CLI. */
export function registerToolCommands(program: Command): void {
  const correctness = program
    .command("correctness")
    .description("separate host-authored correctness review; never automatic grading or approval")
  correctness
    .command("prepare <taskId>")
    .hook("preAction", vaultMutation())
    .option("--frozen", "review a completed frozen evaluation using captured evidence only")
    .option("--json", "emit JSON")
    .action(async (taskId, options, command) => {
      const result = await prepareCorrectnessReview(
        (await commandConfig(command)).vault.path,
        taskId,
        { frozen: options.frozen },
      )
      render(
        result,
        options.json,
        `Review ${result.id}: read ${result.handoffPath}; a separate host pass must author the note.`,
      )
    })
  correctness
    .command("list")
    .requiredOption("--course <course>", "exact saved course code")
    .option("--json", "emit JSON")
    .action(async (options, command) => {
      const result = await listCorrectnessReviews(
        (await commandConfig(command)).vault.path,
        options.course,
      )
      render(
        result,
        options.json,
        result.reviews.map((value) => `${value.id}\t${value.taskId}`).join("\n") +
          `\nInventory complete: ${result.inventoryComplete}; currentness not checked.`,
      )
    })
  correctness
    .command("show <id>")
    .option("--json", "emit JSON")
    .action(async (id, options, command) => {
      const result = await showCorrectnessReview((await commandConfig(command)).vault.path, id)
      render(result, options.json, `Review ${id}: ${result.status}; handoff ${result.handoffPath}`)
    })
  correctness
    .command("save <id>")
    .hook("preAction", vaultMutation())
    .requiredOption("--file <file>", "separate host-authored Markdown review note")
    .option("--json", "emit JSON")
    .action(async (id, options, command) => {
      const result = await saveCorrectnessReview(
        (await commandConfig(command)).vault.path,
        id,
        options.file,
      )
      render(
        result,
        options.json,
        `Saved separate review ${id}: ${result.reviewPath}; not grading or approval.`,
      )
    })
  program
    .command("check-numbers <id>")
    .description(
      "review candidate numeric presence against saved sources and recomputed calculations; not grading",
    )
    .requiredOption("--file <path>", "absolute structurally valid Markdown candidate")
    .option("--json", "emit numeric findings without candidate/source bodies")
    .action(async (id: string, options, command: Command) => {
      const result = await checkTaskNumbers(
        (await commandConfig(command)).vault.path,
        id,
        options.file,
      )
      render(
        result,
        options.json,
        `Numeric review: ${result.flagged.length} value(s) need review. ${result.limitation}`,
      )
    })
  program
    .command("cost")
    .description("summarize an explicitly supplied host usage export; no provider access")
    .requiredOption("--file <path>", "absolute host export JSON, not credentials")
    .option("--weeks <number>", "look back 1–520 weeks; default current UTC month")
    .option("--json", "emit metadata and exact supplied-cost totals")
    .action(async (options, command: Command) => {
      await commandConfig(command)
      const result = await readHostUsage(options.file, {
        weeks: options.weeks === undefined ? undefined : Number(options.weeks),
      })
      render(result, options.json, renderHostUsage(result))
    })
  program
    .command("calculate")
    .hook("preAction", vaultMutation())
    .description("perform a bounded numeric calculation and log its inputs")
    .requiredOption("--task <id>", "approved task UUID")
    .option("--operation <operation>", `supported operation: ${CALCULATION_OPERATIONS.join(", ")}`)
    .option("--values <values>", "comma-separated finite numbers")
    .option("--file <path>", "JSON file containing up to 100 safe operations")
    .option("--rate <number>", "NPV discount rate (greater than -1 and at most 100)")
    .option("--source <path>", "approved task source path to record as context")
    .option("--json", "emit JSON")
    .addHelpText("after", '\nBatch file: {"operations":[{"operation":"sum","values":[1,2]}]}')
    .action(async (options, command: Command) => {
      if (
        (options.file && (options.values || options.operation || options.rate)) ||
        (!options.file && (!options.values || !options.operation))
      )
        throw new Error(
          "Provide either --file or both --operation and --values; --rate applies only to single-operation mode",
        )
      const config = await commandConfig(command)
      if (options.file) {
        const items = await readCalculationBatchFile(options.file)
        const result = await calculateBatchTask(config, options.task, items)
        render(result, options.json, `Completed ${result.length} calculations.`)
        return
      }
      const result = await calculateTask(config, {
        taskId: options.task,
        operation: options.operation,
        values: options.values,
        ...(options.rate === undefined ? {} : { rate: Number(options.rate) }),
        ...(options.source ? { source: options.source } : {}),
      })
      render(result, options.json, `${result.operation}: ${result.result}`)
    })

  const simulate = program
    .command("simulate")
    .description("capture and replay a fixed, private source snapshot")
  simulate
    .command("list")
    .description("discover saved capture metadata without reading current course sources")
    .requiredOption("--course <code>", "explicit saved course code")
    .option("--json", "emit capture metadata only, not source bodies")
    .action(async (options, command: Command) => {
      const result = await listSimulationCaptures(
        (await commandConfig(command)).vault.path,
        options.course,
      )
      render(
        result,
        options.json,
        `${result.captures.map((capture) => `${capture.id} — ${capture.asOf}`).join("\n") || "No saved captures."}\n${result.inventoryComplete ? "" : "Warning: capture inventory is incomplete.\n"}${result.limitation}`,
      )
    })
  simulate
    .command("capture <course>")
    .hook("preAction", vaultMutation())
    .description("capture the current source version classified by an explicit as-of cutoff")
    .requiredOption("--as-of <iso>", "ISO date or timestamp cutoff")
    .option(
      "--work <path>",
      "explicit course student-work path to capture; repeatable",
      (path: string, prior: string[]) => [...prior, path],
      [],
    )
    .option("--json", "emit JSON")
    .action(async (course: string, options, command: Command) => {
      const result = await captureSimulation(
        (await commandConfig(command)).vault.path,
        course,
        options.asOf,
        options.work,
      )
      render(
        result,
        options.json,
        `Captured ${result.sourceCount} dated source(s) and ${result.guidanceCount} guidance file(s) for ${result.course.code}: ${result.id}. ${result.limitation}`,
      )
    })
  simulate
    .command("derive <id>")
    .hook("preAction", vaultMutation())
    .description(
      "derive an earlier cutoff view from one original capture, without live source reads",
    )
    .requiredOption("--as-of <iso>", "ISO cutoff no later than the original capture")
    .option("--json", "emit derived-capture metadata, not source bodies")
    .action(async (id: string, options, command: Command) => {
      const result = await deriveSimulationCapture(
        (await commandConfig(command)).vault.path,
        id,
        options.asOf,
      )
      render(
        result,
        options.json,
        `Derived ${result.sourceCount} source(s) and ${result.guidanceCount} guidance file(s) for ${result.course.code}: ${result.id}. ${result.limitation}`,
      )
    })
  simulate
    .command("replay <id>")
    .description("replay a fixed snapshot as a handoff for an external agent")
    .option("--json", "emit JSON")
    .action(async (id: string, options, command: Command) => {
      const result = await replaySimulation((await commandConfig(command)).vault.path, id)
      render(
        result,
        options.json,
        `Replay ${result.id} for ${result.course.code}: ${result.sources.length} fixed source(s). ${result.limitation}`,
      )
    })
  const window = simulate
    .command("window")
    .description("plan and inspect weekly frozen prep/draft handoffs from one capture")
  window
    .command("list")
    .requiredOption("--course <code>", "explicit saved course code")
    .option("--json", "emit saved window metadata only")
    .action(async (options, command: Command) => {
      const result = await listSimulationWindows(
        (await commandConfig(command)).vault.path,
        options.course,
      )
      render(
        result,
        options.json,
        `${result.windows.map((plan) => `${plan.id} — ${plan.range} (${plan.phase})`).join("\n") || "No saved windows."}\n${result.inventoryComplete ? "" : "Warning: window inventory is incomplete.\n"}${result.limitation}`,
      )
    })
  window
    .command("create <capture>")
    .hook("preAction", vaultMutation())
    .requiredOption("--course <code>", "explicit course code matching the original capture")
    .requiredOption(
      "--weeks <start>..<end>",
      "inclusive real date range sampled every 7 days, at most 52 cutoffs",
    )
    .option(
      "--module <id-or-path>",
      "limit draft selection to one captured module; prep remains weekly",
    )
    .option("--json", "emit private plan metadata and task IDs, not source bodies")
    .action(async (capture: string, options, command: Command) => {
      const result = await createSimulationWindow(
        (await commandConfig(command)).vault.path,
        capture,
        options.course,
        options.weeks,
        options.module,
      )
      render(
        result,
        options.json,
        `Window ${result.id}: ${result.state}; ${result.counts.pending} pending, ${result.counts.completed} completed-pending-human, ${result.counts.unavailable} recorded failures. ${result.limitation}`,
      )
    })
  window
    .command("show <id>")
    .requiredOption("--course <code>", "explicit captured course code")
    .option("--json", "emit validated window metadata and current handoff states")
    .action(async (id: string, options, command: Command) => {
      const result = await inspectSimulationWindow(
        (await commandConfig(command)).vault.path,
        id,
        options.course,
      )
      render(
        result,
        options.json,
        `Window ${result.id}: ${result.state}; ${result.counts.pending} pending, ${result.counts.completed} completed-pending-human, ${result.counts.unavailable} recorded failures.`,
      )
    })
  window
    .command("resume <id>")
    .hook("preAction", vaultMutation())
    .description("explicitly continue a versioned partial plan without replacing saved handoffs")
    .requiredOption("--course <code>", "explicit captured course code")
    .option("--json", "emit validated window metadata and handoff states")
    .action(async (id: string, options, command: Command) => {
      const result = await resumeSimulationWindow(
        (await commandConfig(command)).vault.path,
        id,
        options.course,
      )
      render(result, options.json, `Window ${result.id}: ${result.state}; human verdict pending.`)
    })
  window
    .command("compare <id>")
    .hook("preAction", vaultMutation())
    .requiredOption("--course <code>", "explicit captured course code")
    .option(
      "--week <date>",
      "compare one exact planned cutoff or teaching Monday rather than the full window",
    )
    .option(
      "--reference <path>",
      "eligible review-only reference; never earlier generation context",
      (path: string, previous: string[]) => [...previous, path],
      [],
    )
    .option("--json", "emit comparison metadata; human verdict remains pending")
    .option(
      "--feedback-assignment <id>",
      "exact cached own-feedback assignment for review only; repeatable",
      (id: string, previous: string[]) => [...previous, id],
      [],
    )
    .action(async (id: string, options, command: Command) => {
      const result = await compareSimulationWindow(
        (await commandConfig(command)).vault.path,
        id,
        options.course,
        options.week,
        options.reference,
        options.feedbackAssignment,
      )
      render(
        result,
        options.json,
        `Window comparison ${result.id} created; human review remains pending.`,
      )
    })
  const simulationTask = simulate
    .command("task")
    .description("persist and validate fixed-snapshot generation handoffs")
  simulationTask
    .command("check-numbers <id>")
    .description(
      "review a frozen candidate's numeric presence; no current-source reads or academic verdict",
    )
    .requiredOption("--file <path>", "absolute structurally valid Markdown candidate")
    .option("--json", "emit numeric findings only")
    .action(async (id: string, options, command: Command) => {
      const result = await checkFrozenTaskNumbers(
        (await commandConfig(command)).vault.path,
        id,
        options.file,
      )
      render(
        result,
        options.json,
        `Frozen numeric review: ${result.flagged.length} value(s) need review. ${result.limitation}`,
      )
    })
  simulationTask
    .command("list")
    .description("discover immutable frozen task recipes without current sources or output bodies")
    .requiredOption("--course <code>", "explicit saved course code")
    .option("--json", "emit validated frozen recipe metadata only")
    .action(async (options, command: Command) => {
      const result = await listSimulationTasks(
        (await commandConfig(command)).vault.path,
        options.course,
      )
      render(
        {
          ...result,
          scope: "frozen",
          tasks: result.tasks.map((row) => ({
            ...row,
            inspectionCommand: taskInspectionCommand(
              "frozen",
              row.id,
              command.optsWithGlobals().config ?? defaultConfig,
            ),
          })),
        },
        options.json,
        `${result.tasks.map((task) => `${task.id} — ${task.kind}`).join("\n") || "No saved frozen tasks."}\n${result.inventoryComplete ? "" : "Warning: frozen task inventory is incomplete.\n"}${result.limitation}`,
      )
    })
  simulationTask
    .command("workbook <id>")
    .hook("preAction", vaultMutation())
    .description("save a private values-only workbook bound to selected fixed evidence")
    .requiredOption("--file <path>", "absolute bounded sheets/rows JSON file")
    .option("--source <path>", "optional exact selected frozen source as context")
    .option("--json", "emit companion metadata, not cell contents")
    .action(async (id: string, options, command: Command) => {
      const result = await createSimulationWorkbook(
        (await commandConfig(command)).vault.path,
        id,
        options.file,
        options.source,
      )
      render(result, options.json, `Private evaluation workbook: ${result.output}\n${result.note}`)
    })
  simulationTask
    .command("workbooks <id>")
    .description("revalidate this evaluation's private workbook companions")
    .option("--json", "emit companion metadata, not cell contents")
    .action(async (id: string, options, command: Command) => {
      const result = await readSimulationWorkbooks((await commandConfig(command)).vault.path, id)
      render(
        result,
        options.json,
        `Validated ${result.records.length} private workbook companion(s); grounding remains unverified.`,
      )
    })
  simulationTask
    .command("calculate <id>")
    .hook("preAction", vaultMutation())
    .description("execute bounded arithmetic bound to this evaluation's selected frozen evidence")
    .option("--operation <operation>", `supported operation: ${CALCULATION_OPERATIONS.join(", ")}`)
    .option("--values <values>", "comma-separated finite numeric inputs")
    .option("--rate <number>", "NPV discount rate only")
    .option(
      "--source <path>",
      "optional exact selected frozen source as context, not proof of grounding",
    )
    .option("--file <path>", "bounded JSON batch; each operation supplies its own source")
    .option("--json", "emit private numeric evidence, never source bodies")
    .addHelpText("after", '\nBatch file: {"operations":[{"operation":"sum","values":[1,2]}]}')
    .action(async (id: string, options, command: Command) => {
      if (
        (options.file &&
          (options.operation !== undefined ||
            options.values !== undefined ||
            options.rate !== undefined ||
            options.source !== undefined)) ||
        (!options.file && (!options.operation || options.values === undefined))
      )
        throw new Error(
          "Choose --file or --operation with --values; batch sources/rates belong in its operations",
        )
      const items = options.file
        ? await readCalculationBatchFile(options.file)
        : [
            {
              operation: options.operation,
              values: (options.values as string).split(",").map((value) => {
                if (!value.trim() || !Number.isFinite(Number(value)))
                  throw new Error("Values must be finite comma-separated numbers")
                return Number(value)
              }),
              ...(options.rate !== undefined ? { rate: Number(options.rate) } : {}),
              ...(options.source !== undefined ? { source: options.source } : {}),
            },
          ]
      const result = await calculateSimulationBatch(
        (await commandConfig(command)).vault.path,
        id,
        items,
      )
      render(
        result,
        options.json,
        `${result.results.map((entry) => `${entry.operation}: ${entry.result}`).join("\n")}\n${result.note}`,
      )
    })
  simulationTask
    .command("calculations <id>")
    .description("recompute and inspect this evaluation's private arithmetic records")
    .option("--json", "emit numeric records and bindings, never source bodies")
    .action(async (id: string, options, command: Command) => {
      const result = await readSimulationCalculations((await commandConfig(command)).vault.path, id)
      render(
        result,
        options.json,
        `Validated ${result.records.length} calculation record(s). Source grounding remains unverified.`,
      )
    })
  simulate
    .command("compare")
    .hook("preAction", vaultMutation())
    .description(
      "package completed evaluations and explicit review-only references with blank human scorecards",
    )
    .requiredOption("--course <course>", "explicit current course selector")
    .requiredOption(
      "--task <id>",
      "completed evaluation task ID; repeatable",
      (id: string, prior: string[]) => [...prior, id],
      [],
    )
    .option(
      "--reference <path>",
      "eligible course reference for review only; repeatable",
      (path: string, prior: string[]) => [...prior, path],
      [],
    )
    .option("--json", "emit private bundle metadata only")
    .option(
      "--feedback-assignment <id>",
      "exact cached own-feedback assignment for review only; repeatable",
      (id: string, prior: string[]) => [...prior, id],
      [],
    )
    .action(async (options, command: Command) => {
      const result = await compareSimulationEvaluations(
        (await commandConfig(command)).vault.path,
        options.course,
        options.task,
        options.reference,
        options.feedbackAssignment,
      )
      render(
        result,
        options.json,
        `Comparison: ${result.comparison}\nHuman scorecard: ${result.scorecard}\nHuman verdict pending; literal mentions/citations are not grades.`,
      )
    })
  simulationTask
    .command("create <simulationId>")
    .hook("preAction", vaultMutation())
    .requiredOption("--kind <kind>", "prep or assignment")
    .option("--week <date>", "explicit Monday for prep")
    .option("--session <selector>", "explicit frozen session for prep")
    .option("--source <path>", "exact captured assignment prompt path")
    .option("--mode <mode>", "outline, draft, review or discuss for assignment")
    .option("--work <path>", "exact explicitly captured student-work path; required for review")
    .option("--message <text>", "required student inquiry for discuss mode only")
    .option(
      "--context <path>",
      "additional exact captured path; repeatable",
      (path: string, prior: string[]) => [...prior, path],
      [],
    )
    .option("--json", "emit metadata only")
    .action(async (simulationId: string, options, command: Command) => {
      const result = await createSimulationTask(
        (await commandConfig(command)).vault.path,
        simulationId,
        {
          kind: options.kind,
          ...(options.week ? { week: options.week } : {}),
          ...(options.session ? { session: options.session } : {}),
          ...(options.source ? { source: options.source } : {}),
          ...(options.mode ? { mode: options.mode } : {}),
          ...(options.work !== undefined ? { work: options.work } : {}),
          ...(options.message !== undefined ? { message: options.message } : {}),
          context: options.context,
        },
      )
      render(
        result,
        options.json,
        `Fixed-snapshot task: ${result.id}\nRead ${result.taskFile} and simulate task show. The chosen host generates a separate candidate; confirm course permission first.`,
      )
    })
  simulationTask
    .command("output <id>")
    .description("read verified existing frozen output; never generate or record a human verdict")
    .option("--json", "emit private saved text and integrity metadata")
    .action(async (id: string, options, command: Command) => {
      const config = await commandConfig(command)
      const result = await readTaskOutput(
        command.optsWithGlobals().config ?? defaultConfig,
        config.vault.path,
        id,
        "frozen",
      )
      if (options.json) render(result, true, "")
      else process.stdout.write(result.text)
    })
  simulationTask
    .command("show <id>")
    .option("--json", "emit private fixed source bodies and validated state")
    .action(async (id: string, options, command: Command) => {
      const config = await commandConfig(command)
      const result = await inspectSimulationTask(config.vault.path, id)
      render(
        {
          ...result,
          ...taskLocations(
            command.optsWithGlobals().config ?? defaultConfig,
            config.vault.path,
            result.task.id,
            "frozen",
            "completion" in result ? result.completion.output : undefined,
            "completion" in result ? result.completion.workbook?.output : undefined,
          ),
        },
        options.json,
        `Simulation task ${id}: ${result.state}; course ${result.task.course.code}; ${result.task.sources.length} frozen sources. Use --json for the private handoff; do not share it publicly.`,
      )
    })
  simulationTask
    .command("complete <id>")
    .hook("preAction", vaultMutation())
    .requiredOption("--file <path>", "absolute Markdown candidate path")
    .option("--json", "emit completion metadata")
    .action(async (id: string, options, command: Command) => {
      const result = await completeSimulationTask(
        (await commandConfig(command)).vault.path,
        id,
        options.file,
      )
      render(
        result,
        options.json,
        `Private evaluation output saved: ${result.output}. Human verdict pending; no coursework or Canvas submission was changed.`,
      )
    })

  program
    .command("inspect <id>")
    .description("inspect task metadata and current source provenance")
    .option("--json", "emit JSON")
    .action(async (id: string, options, command: Command) => {
      const result = await inspectTask((await commandConfig(command)).vault.path, id)
      render(
        result,
        options.json,
        `${result.kind} task ${result.id}: ${result.status}; ${result.sources.length} sources; snapshots ${result.snapshots.current ? "current" : "stale"}.`,
      )
    })

  program
    .command("compare <id> <otherid>")
    .description("compare source hashes and completed output lines between tasks")
    .option("--json", "emit JSON")
    .action(async (id: string, otherid: string, options, command: Command) => {
      const result = await compareTasks((await commandConfig(command)).vault.path, id, otherid)
      render(
        result,
        options.json,
        `Compared ${id} with ${otherid}: ${result.sourceChanges.length} source changes, ${result.guidanceChanges.length} guidance changes.`,
      )
    })

  const gate = program.command("gate").description("run structural, provenance-only evaluation")
  gate
    .command("m1")
    .hook("preAction", vaultMutation())
    .description(
      "package an existing School simulation for anchored human review; stop pending verdict",
    )
    .option("--run <id>", "explicit legacy _simulations directory name")
    .option("--comparison <id>", "explicit validated fixed-snapshot comparison UUID")
    .requiredOption(
      "--course <course>",
      "explicit course selector; old reports do not establish course identity",
    )
    .option("--json", "emit metadata only, not artifact bodies")
    .action(async (options, command: Command) => {
      if (Boolean(options.run) === Boolean(options.comparison))
        throw new Error("M1 needs exactly one --run or --comparison")
      const vault = (await commandConfig(command)).vault.path
      const result = options.comparison
        ? await comparisonM1Bundle(vault, options.course, options.comparison)
        : await legacyM1Bundle(vault, options.course, options.run)
      render(
        result,
        options.json,
        `M1 bundle saved: ${result.path}\nHuman verdict pending. Review grounding, visibility, usefulness and dates; STOP until the student explicitly passes M1.`,
      )
    })
  gate
    .command("review <taskId>")
    .hook("preAction", vaultMutation())
    .description("save a versioned human review bundle for a completed task")
    .option("--json", "emit JSON")
    .action(async (taskId: string, options, command: Command) => {
      const result = await reviewGate(await commandConfig(command), taskId)
      render(result, options.json, `Review bundle saved: ${result.path}`)
    })

  program
    .command("workbook <taskId>")
    .hook("preAction", vaultMutation())
    .description("create a values-only XLSX workbook from bounded JSON input")
    .requiredOption("--file <path>", "JSON file containing sheets and rows")
    .option("--json", "emit JSON")
    .action(async (taskId: string, options, command: Command) => {
      const result = await workbookTask(await commandConfig(command), taskId, options.file)
      render(result, options.json, `Workbook saved: ${result.path}`)
    })
}
