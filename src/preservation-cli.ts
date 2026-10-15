import type { Command } from "commander"
import { loadConfig } from "./config.js"
import { applyPreservationMigration, planPreservationMigration } from "./preservation-migration.js"

export function registerPreservationCommand(program: Command): void {
  const vault = program.commands.find((command) => command.name() === "vault")
  if (!vault) throw new Error("Vault commands must exist before preservation commands")
  vault
    .command("preserve-school")
    .description(
      "preview/archive one hash-owned root Canvas Home and enable separate-product paths",
    )
    .requiredOption("--course <id>", "one explicitly allowlisted numeric Canvas course ID")
    .option(
      "--apply",
      "archive owned navigation and update Canvas ownership; never rewrite School/student files",
    )
    .option("--json", "emit plan metadata only, never navigation bodies")
    .action(async (options) => {
      const config = await loadConfig(program.opts().config)
      const plan = await planPreservationMigration(config, options.course)
      const result =
        options.apply && plan.ready
          ? await applyPreservationMigration(config, plan)
          : { preview: true, ...plan }
      if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`)
      else console.log(JSON.stringify(result, null, 2))
      if (!plan.ready) process.exitCode = 1
    })
}
