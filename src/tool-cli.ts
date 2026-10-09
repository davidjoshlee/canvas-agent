import { lstat, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { Command } from "commander"
import { loadConfig } from "./config.js"
import { assertNoSymlinks } from "./fs-safety.js"
import { captureSimulation, replaySimulation } from "./simulation.js"
import {
  calculateBatchTask,
  calculateTask,
  compareTasks,
  inspectTask,
  parseCalculationBatch,
  reviewGate,
  workbookTask,
} from "./tools.js"
import type { ToolkitConfig } from "./types.js"

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
  program
    .command("calculate")
    .description("perform a bounded numeric calculation and log its inputs")
    .requiredOption("--task <id>", "approved task UUID")
    .option("--operation <operation>", "safe numeric operation")
    .option("--values <values>", "comma-separated finite numbers")
    .option("--file <path>", "JSON file containing up to 100 safe operations")
    .option("--rate <number>", "NPV discount rate (greater than -1 and at most 100)")
    .option("--source <path>", "approved task source path to record as context")
    .option("--json", "emit JSON")
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
        const path = resolve(options.file as string)
        await assertNoSymlinks(path)
        const info = await lstat(path)
        if (!info.isFile() || info.size > 5 * 1024 * 1024)
          throw new Error("Calculation input must be a regular file up to 5 MB")
        const items = parseCalculationBatch(JSON.parse(await readFile(path, "utf8")))
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
    .command("capture <course>")
    .description("capture the current source version classified by an explicit as-of cutoff")
    .requiredOption("--as-of <iso>", "ISO date or timestamp cutoff")
    .option("--json", "emit JSON")
    .action(async (course: string, options, command: Command) => {
      const result = await captureSimulation(
        (await commandConfig(command)).vault.path,
        course,
        options.asOf,
      )
      render(
        result,
        options.json,
        `Captured ${result.sourceCount} dated source(s) for ${result.course.code}: ${result.id}. ${result.limitation}`,
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
    .description("save a versioned human review bundle for a completed task")
    .option("--json", "emit JSON")
    .action(async (taskId: string, options, command: Command) => {
      const result = await reviewGate(await commandConfig(command), taskId)
      render(result, options.json, `Review bundle saved: ${result.path}`)
    })

  program
    .command("workbook <taskId>")
    .description("create a values-only XLSX workbook from bounded JSON input")
    .requiredOption("--file <path>", "JSON file containing sheets and rows")
    .option("--json", "emit JSON")
    .action(async (taskId: string, options, command: Command) => {
      const result = await workbookTask(await commandConfig(command), taskId, options.file)
      render(result, options.json, `Workbook saved: ${result.path}`)
    })
}
