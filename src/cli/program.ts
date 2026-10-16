import { createRequire } from "node:module"
import { Command, Option } from "commander"
import { writeAuthAlert } from "../auth/alerts.js"
import type { CanvasClientFactory } from "../canvas/client.js"
import { isCanvasUnauthorized } from "../canvas/sync.js"
import { loadConfig } from "../config/index.js"
import { finishVaultHistory, registerVaultHistory } from "../vault/history-cli.js"
import { registerObsidianCommand } from "../vault/obsidian.js"
import { registerReadingCopyCommands } from "../vault/reading-copy-cli.js"
import { registerAcademicCommands } from "./academic.js"
import { registerAccessCommands } from "./access.js"
import { registerCapabilityCommands } from "./capabilities.js"
import { registerSetupCommands } from "./setup.js"
import { registerSimulationCommands } from "./simulation.js"
import { registerStudentCommands } from "./student.js"
import { registerSyncCommands } from "./sync.js"
import { registerToolCommands } from "./tools.js"
import { registerWorkspaceCommands } from "./workspace.js"

const DEFAULT_CONFIG = "./canvas-agent.config.json"
const packageVersion = (createRequire(import.meta.url)("../../package.json") as { version: string })
  .version

function configOptionArgs(args: string[]): string[] {
  // Commander normally accepts inherited options after a command. Moving only this
  // global option to the front also covers nested commands consistently.
  const rest: string[] = [],
    options: string[] = []
  for (let i = 0; i < args.length; i++) {
    const value = args[i] ?? ""
    if (value === "--config") {
      if (i + 1 < args.length) options.push(value, args[++i] ?? "")
      else rest.push(value)
    } else if (value.startsWith("--config=")) options.push(value)
    else rest.push(value)
  }
  return [...options, ...rest]
}

function safeError(error: unknown, configPath: string): string {
  let message = error instanceof Error ? error.message : "Command failed"
  try {
    for (const [name, value] of Object.entries(process.env)) {
      if (value && /token|secret|password|credential|api[_-]?key/i.test(name))
        message = message.replaceAll(value, "[redacted]")
    }
  } catch {
    /* redaction must never obscure the original safe error */
  }
  // A config path is user supplied and may include sensitive directory names.
  if (!message) message = `Command failed using config ${configPath}`
  return message.replace(/\r?\n/g, " ")
}

export interface CliRuntime {
  canvasClient?: CanvasClientFactory
  /** Checkout tooling can extend registration without becoming a runtime dependency. */
  registerCommands?: (program: Command) => void
}

function makeProgram(runtime: CliRuntime): Command {
  const program = new Command()
  program
    .name("canvas-agent")
    .version(packageVersion)
    .description("Model-free Canvas workspace and task handoffs")
    .showHelpAfterError(false)
  program.addOption(new Option("--config <path>", "configuration file").default(DEFAULT_CONFIG))

  registerSetupCommands(program, runtime.canvasClient)
  registerSyncCommands(program, runtime.canvasClient)
  registerAcademicCommands(program)
  registerAccessCommands(program, runtime.canvasClient)
  registerWorkspaceCommands(program)
  registerCapabilityCommands(program)
  registerToolCommands(program)
  registerSimulationCommands(program)
  registerStudentCommands(program)
  registerReadingCopyCommands(program)
  registerVaultHistory(program)
  registerObsidianCommand(program)
  runtime.registerCommands?.(program)
  return program
}

export async function runCli(
  args: string[] = process.argv.slice(2),
  runtime: CliRuntime = {},
): Promise<void> {
  const jsonRequested = args.includes("--json")
  const program = makeProgram(runtime)
  const configure = (command: Command): void => {
    command.exitOverride()
    command.configureOutput({
      writeOut: (text) => process.stdout.write(text),
      writeErr: () => undefined,
      outputError: () => undefined,
    })
    command.commands.forEach(configure)
  }
  configure(program)
  try {
    await program.parseAsync(configOptionArgs(args), { from: "user" })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (
      code === "commander.helpDisplayed" ||
      code === "commander.help" ||
      code === "commander.version"
    )
      return
    const configIndex = args.indexOf("--config")
    const configPath = configIndex >= 0 ? (args[configIndex + 1] ?? DEFAULT_CONFIG) : DEFAULT_CONFIG
    const message = safeError(error, configPath)
    let authAlert:
      | Awaited<ReturnType<typeof writeAuthAlert>>
      | { status: "not-updated" }
      | undefined
    if (isCanvasUnauthorized(error)) {
      try {
        const selectedPath = program.opts().config as string
        authAlert = await writeAuthAlert(selectedPath, await loadConfig(selectedPath), "http-401")
      } catch {
        authAlert = { status: "not-updated" }
      }
    }
    process.stderr.write(
      `${jsonRequested ? `${JSON.stringify({ error: message, ...(authAlert ? { authAlert } : {}) })}\n` : `Error: ${message}${authAlert && "alertFile" in authAlert ? `\nPrivate auth alert: ${authAlert.alertFile}` : ""}\n`}`,
    )
    process.exitCode = 1
    await finishVaultHistory(program, false)
  }
}
