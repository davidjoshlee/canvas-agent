import type { Command } from "commander"
import { loadConfig } from "../config/index.js"
import type { ToolkitConfig } from "../shared/types.js"
import { calculateSimulationBatch, readSimulationCalculations } from "../simulation/calculations.js"
import {
  captureSimulation,
  deriveSimulationCapture,
  listSimulationCaptures,
  replaySimulation,
} from "../simulation/captures.js"
import {
  completeSimulationTask,
  createSimulationTask,
  inspectSimulationTask,
  listSimulationTasks,
} from "../simulation/tasks.js"
import { createSimulationWorkbook, readSimulationWorkbooks } from "../simulation/workbooks.js"
import { taskInspectionCommand, taskLocations } from "../tasks/artifacts/locations.js"
import { CALCULATION_OPERATIONS } from "../tasks/calculations/calculation-core.js"
import { readCalculationBatchFile } from "../tasks/calculations/calculation-input.js"
import { checkFrozenTaskNumbers } from "../tasks/calculations/numeric-review.js"
import { vaultMutation } from "../vault/command-effects.js"
import { readTaskOutput } from "./task-output.js"

const defaultConfig = "./canvas-agent.config.json"

async function commandConfig(command: Command): Promise<ToolkitConfig> {
  return loadConfig(command.optsWithGlobals().config ?? defaultConfig)
}
function render(value: unknown, json: boolean, message: string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${message}\n`)
}

export function registerSimulationCommands(program: Command): void {
  const simulate = program
    .command("simulate")
    .description("capture and replay a fixed, private source snapshot")
  registerCaptureInventory(simulate)
  registerCaptureCreation(simulate)
  registerCaptureReplay(simulate)
  const simulationTask = simulate
    .command("task")
    .description("persist and validate fixed-snapshot generation handoffs")
  registerFrozenTaskInventory(simulationTask)
  registerFrozenWorkbookCommands(simulationTask)
  registerFrozenCalculationCommands(simulationTask)
  registerFrozenTaskCreation(simulationTask)
  registerFrozenTaskOutput(simulationTask)
  registerFrozenTaskInspection(simulationTask)
  registerFrozenTaskCompletion(simulationTask)
}

function registerCaptureInventory(simulate: Command): void {
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
}

function registerCaptureCreation(simulate: Command): void {
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
}

function registerCaptureReplay(simulate: Command): void {
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
}

function registerFrozenTaskInventory(simulationTask: Command): void {
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
}

function registerFrozenWorkbookCommands(simulationTask: Command): void {
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
}

function registerFrozenCalculationCommands(simulationTask: Command): void {
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
}

function registerFrozenTaskCreation(simulationTask: Command): void {
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
}

function registerFrozenTaskOutput(simulationTask: Command): void {
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
}

function registerFrozenTaskInspection(simulationTask: Command): void {
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
}

function registerFrozenTaskCompletion(simulationTask: Command): void {
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
}
