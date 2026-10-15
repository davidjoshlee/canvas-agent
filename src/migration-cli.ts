import type { Command } from "commander"
import { loadConfig } from "./config.js"
import { applyRootMigration, planRootMigration } from "./root-migration.js"

export function registerMigrationCommand(program: Command) {
  const vault = program.commands.find((command) => command.name() === "vault")
  if (!vault) throw new Error("Vault commands must be registered before migration")
  vault
    .command("migrate")
    .description(
      "preview combined School Agent layout/root/index migration; apply only on explicit direction",
    )
    .requiredOption(
      "--index-path <path>",
      "explicit absolute School SQLite index outside the vault",
    )
    .requiredOption(
      "--course <id>",
      "explicit Canvas course ID; repeat to select more courses",
      (id: string, prior: string[]) => [...prior, id],
      [],
    )
    .option("--apply", "apply the fresh conflict-free plan and archive originals privately")
    .option(
      "--wiki-target <name=path>",
      "explicit short wiki filename to selected-course vault path (repeatable)",
      (value: string, prior: string[]) => [...prior, value],
      [] as string[],
    )
    .option(
      "--check-incoming",
      "opt into read-only reference scanning of indexed unselected course text",
    )
    .option("--json", "emit metadata only, not course document bodies")
    .action(async (options) => {
      const wikiTargets = (options.wikiTarget as string[]).map((choice) => {
        const separator = choice.indexOf("=")
        if (separator <= 0 || separator === choice.length - 1)
          throw new Error("Wiki target requires NAME=VAULT_PATH")
        return { name: choice.slice(0, separator), target: choice.slice(separator + 1) }
      })
      const config = await loadConfig(program.opts().config)
      const plan = await planRootMigration(config.vault.path, options.indexPath, options.course, {
        layout: true,
        checkIncoming: Boolean(options.checkIncoming),
        wikiTargets,
      })
      const incoming = {
        requested: plan.incomingCheck,
        scanCompleted: plan.incomingDigest !== null,
        documents: plan.incomingDocuments,
        digest: plan.incomingDigest,
        limits: plan.incomingLimits,
      }
      const changes = plan.files.filter(
        (file) => file.current !== file.destination || file.destinationHash,
      )
      if (!plan.ready || !options.apply) {
        const result = {
          preview: true,
          ready: plan.ready,
          courses: plan.ids,
          roots: plan.moves,
          documents: changes,
          conflicts: plan.conflicts,
          incoming,
          schoolLayout: plan.schoolLayout,
          wikiTargets: plan.wikiTargets,
          limits:
            "No files or index rows changed. Review every destination; --apply requires student direction. Global School layout markers, historical snapshots and unselected-course incoming references are not migrated.",
        }
        process.stdout.write(`${JSON.stringify(result, null, options.json ? 2 : undefined)}\n`)
        if (!plan.ready) process.exitCode = 1
        return
      }
      const result = await applyRootMigration(plan)
      process.stdout.write(
        `${JSON.stringify({ preview: false, courses: plan.ids, documents: changes.length, incoming, schoolLayout: plan.schoolLayout, wikiTargets: plan.wikiTargets, ...result }, null, options.json ? 2 : undefined)}\n`,
      )
    })
}
