import type { Command } from "commander"
import { loadConfig } from "../config/index.js"
import type { ToolkitConfig } from "../shared/types.js"
import { compareTasks, inspectTask } from "../tasks/artifacts/inspection.js"
import { reviewGate } from "../tasks/tools.js"
import { vaultMutation } from "../vault/command-effects.js"

const defaultConfig = "./canvas-agent.config.json"

async function commandConfig(command: Command): Promise<ToolkitConfig> {
  const options = command.optsWithGlobals() as { config?: string }
  return loadConfig(options.config ?? defaultConfig)
}

function render(value: unknown, json: boolean, message: string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${message}\n`)
}

/** Register local, model-free review and inspection commands on the supplied CLI. */
export function registerToolCommands(program: Command): void {
  registerTaskInspectionCommands(program)
  registerReviewGateCommand(program)
}

function registerTaskInspectionCommands(program: Command): void {
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
}

function registerReviewGateCommand(program: Command): void {
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
}
