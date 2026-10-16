import { isAbsolute } from "node:path"
import type { Command } from "commander"
import { loadConfig } from "../config/index.js"
import { vaultMutation } from "./command-effects.js"
import {
  createReadingCopy,
  disableReadingMirror,
  planReadingCopy,
  refreshConfiguredReadingMirror,
  refreshReadingMirror,
} from "./reading-copy.js"

export function registerReadingCopyCommands(program: Command): void {
  const vault = program.commands.find((command) => command.name() === "vault")
  if (!vault) throw new Error("Vault commands must be registered before reading-copy commands")
  vault
    .command("reading-copy")
    .hook(
      "preAction",
      vaultMutation((options) => Boolean(options.apply)),
    )
    .description("preview or write a one-way phone reading copy; Current opts into CLI refreshes")
    .requiredOption(
      "--destination <path>",
      "explicit absolute local destination, optionally cloud-synced",
    )
    .option("--apply", "write files; may upload private course material if cloud sync is active")
    .option("--current", "refresh Current and enable later successful-write refreshes")
    .option(
      "--import-school-state",
      "explicitly transfer a School Agent mirror mapping to this CLI",
    )
    .option("--json", "emit JSON; no appended hook output")
    .action(async (options) => {
      if (!isAbsolute(options.destination))
        throw new Error("Reading-copy destination must be absolute")
      if (options.importSchoolState && !(options.apply && options.current))
        throw new Error("--import-school-state requires --current --apply")
      const config = await loadConfig(program.opts().config)
      const plan = await planReadingCopy(config.vault.path, options.destination)
      const result = options.apply
        ? options.current
          ? await refreshReadingMirror(config.vault.path, options.destination, {
              importSchoolState: options.importSchoolState,
            })
          : await createReadingCopy(config.vault.path, options.destination)
        : {
            preview: true,
            current: Boolean(options.current),
            destination: plan.destination,
            count: plan.files.length,
            skipped: plan.skipped,
            bytes: plan.totalBytes,
          }
      process.stdout.write(
        options.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `${JSON.stringify(result)}\n${options.apply ? "Working vault originals are unchanged. Wait for cloud upload before using the phone copy." : "Preview only. --apply may upload private course material; confirm the destination/account first."}\n`,
      )
    })
  vault
    .command("reading-copy-disable")
    .hook("preAction", vaultMutation())
    .description("disable automatic CLI refreshes; preserve existing copies and ownership")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const config = await loadConfig(program.opts().config)
      const result = await disableReadingMirror(config.vault.path)
      process.stdout.write(
        options.json
          ? `${JSON.stringify(result)}\n`
          : "Reading-copy refreshes disabled. Existing copies preserved.\n",
      )
    })
  program.hook("postAction", async (_root, action) => {
    if (Number(process.exitCode ?? 0) !== 0) return
    const name = action.name(),
      parent = action.parent?.name()
    if (
      !(
        ["sync", "ingest", "approve", "workbook"].includes(name) ||
        (parent === "task" && name === "complete")
      )
    )
      return
    try {
      const config = await loadConfig(program.opts().config)
      const result = await refreshConfiguredReadingMirror(config.vault.path)
      // Keep command --json stdout parseable; refresh diagnostics go to stderr.
      if (result)
        process.stderr.write(
          `Reading copy refreshed: ${result.updated} updated, ${result.unchanged} unchanged, ${result.recovered} recovered.\n`,
        )
    } catch {
      process.stderr.write(
        "Reading-copy refresh failed; the local command succeeded. Run vault reading-copy --current --apply with the saved destination to diagnose.\n",
      )
    }
  })
}
