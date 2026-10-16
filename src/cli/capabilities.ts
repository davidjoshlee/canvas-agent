import type { Command } from "commander"

export interface CapabilityCommand {
  path: string
  description: string
  options: { flags: string; description: string }[]
}

export function collectCapabilities(command: Command, prefix = ""): CapabilityCommand[] {
  const path = prefix ? `${prefix} ${command.name()}` : command.name()
  const result: CapabilityCommand[] = [
    {
      path,
      description: command.description() || "",
      options: command.options.map((option) => ({
        flags: option.flags,
        description: option.description,
      })),
    },
  ]
  for (const child of command.commands) {
    result.push(...collectCapabilities(child, path))
  }
  return result
}

export function registerCapabilityCommands(program: Command): void {
  program
    .command("capabilities")
    .description("list installed CLI commands for agents")
    .option("--json", "emit JSON")
    .action((options) => {
      const commands = collectCapabilities(program).slice(1)
      if (options.json) console.log(JSON.stringify({ commands }, null, 2))
      else
        for (const command of commands)
          console.log(`${command.path.padEnd(32)} ${command.description}`)
    })
}
