import type { Command } from "commander"
import { loadConfig } from "../config/index.js"
import type { ToolkitConfig } from "../shared/types.js"
import { compareTasks, inspectTask } from "../tasks/artifacts/inspection.js"
import { CALCULATION_OPERATIONS } from "../tasks/calculations/calculation-core.js"
import { readCalculationBatchFile } from "../tasks/calculations/calculation-input.js"
import { checkTaskNumbers } from "../tasks/calculations/numeric-review.js"
import {
  listCorrectnessReviews,
  prepareCorrectnessReview,
  saveCorrectnessReview,
  showCorrectnessReview,
} from "../tasks/review/correctness-review.js"
import { calculateBatchTask, calculateTask, reviewGate, workbookTask } from "../tasks/tools.js"
import { readHostUsage, renderHostUsage } from "../usage/host-usage.js"
import { vaultMutation } from "../vault/command-effects.js"

const defaultConfig = "./canvas-agent.config.json"

async function commandConfig(command: Command): Promise<ToolkitConfig> {
  const options = command.optsWithGlobals() as { config?: string }
  return loadConfig(options.config ?? defaultConfig)
}

function render(value: unknown, json: boolean, message: string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${message}\n`)
}

/** Register local, model-free review and calculation tools on the supplied CLI. */
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
