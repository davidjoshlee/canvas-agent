import type { Command } from "commander"
import { loadConfig } from "../../src/config/index.js"
import type { ToolkitConfig } from "../../src/shared/types.js"
import { vaultMutation } from "../../src/vault/command-effects.js"
import { compareSimulationEvaluations } from "./comparison.js"
import { registerDogfoodCommand } from "./dogfood-cli.js"
import { comparisonM1Bundle, legacyM1Bundle } from "./m1.js"
import {
  compareSimulationWindow,
  createSimulationWindow,
  inspectSimulationWindow,
  listSimulationWindows,
  resumeSimulationWindow,
} from "./window.js"

async function commandConfig(command: Command): Promise<ToolkitConfig> {
  return loadConfig(command.optsWithGlobals().config ?? "./canvas-agent.config.json")
}
function render(value: unknown, json: boolean, message: string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${message}\n`)
}

/** Checkout-only experiments extend the normal CLI without becoming product dependencies. */
export function registerEvaluationCommands(program: Command): void {
  registerDogfoodCommand(program)
  const simulate = program.commands.find((command) => command.name() === "simulate")
  const gate = program.commands.find((command) => command.name() === "gate")
  if (!simulate || !gate) throw new Error("Evaluation requires the simulation and review commands")
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
}
