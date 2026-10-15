import type { Command } from "commander"
import { loadConfig } from "./config.js"
import {
  disableVaultHistory,
  enableVaultHistory,
  exportVaultHistory,
  hasVaultHistory,
  inspectVaultHistory,
  listVaultHistory,
  showVaultHistory,
  snapshotVaultHistory,
} from "./vault-history.js"

const pending = new WeakSet<Command>()

export async function finishVaultHistory(program: Command, primarySucceeded: boolean) {
  if (!pending.has(program)) return
  pending.delete(program)
  let config: Awaited<ReturnType<typeof loadConfig>>
  try {
    config = await loadConfig(program.opts().config)
  } catch {
    return
  }
  if (!(await hasVaultHistory(config.vault.path))) return
  try {
    const result = await snapshotVaultHistory(config.vault.path)
    if (result.changed && "commit" in result)
      process.stderr.write(
        `Local vault history saved${primarySucceeded ? "" : " after failed command"}: ${result.commit}\n`,
      )
  } catch {
    process.stderr.write(
      `Local history snapshot failed; the primary command ${primarySucceeded ? "succeeded" : "failed"}. Inspect vault history and preserve its store/locks; no snapshot success is claimed.\n`,
    )
  }
}

export function registerVaultHistory(program: Command) {
  const vault = program.commands.find((command) => command.name() === "vault")
  if (!vault) throw new Error("Vault commands must exist before local history")
  const history = vault
    .command("history")
    .description("explicit private local Git snapshots; never remote or destructive checkout")
  const configured = async () => (await loadConfig(program.opts().config)).vault.path
  const print = (value: unknown) => {
    process.stdout.write(`${JSON.stringify(value)}\n`)
  }
  history
    .command("enable")
    .description("opt into private local Git snapshots; keep the store off shared/cloud folders")
    .requiredOption(
      "--directory <path>",
      "new absolute private Git store outside the vault (or the same saved store)",
    )
    .option("--json", "emit JSON")
    .action(async (options) =>
      print(await enableVaultHistory(await configured(), options.directory)),
    )
  history
    .command("status")
    .description(
      "read-only history/Git readiness; never snapshot, lock, repair or read vault bodies",
    )
    .option("--json", "emit bounded diagnostics without document bodies")
    .action(async () => {
      const result = await inspectVaultHistory(await configured())
      print(result)
      if (["unsafe", "unavailable"].includes(result.status)) process.exitCode = 1
    })
  history
    .command("snapshot")
    .description("save current bytes if changed; requires explicit enable")
    .option("--json", "emit JSON")
    .action(async () => print(await snapshotVaultHistory(await configured())))
  history
    .command("list")
    .description("list up to 100 saved commit IDs, no document bodies")
    .option("--json", "emit JSON")
    .action(async () => print(await listVaultHistory(await configured())))
  history
    .command("show")
    .argument("<commit>", "exact saved commit ID")
    .description("list a saved snapshot's file paths/object IDs without body text")
    .option("--json", "emit JSON")
    .action(async (commit) => print(await showVaultHistory(await configured(), commit)))
  history
    .command("export")
    .argument("<commit>", "exact saved commit ID")
    .requiredOption("--path <relative>", "exact path from history show")
    .requiredOption(
      "--file <absolute>",
      "new file outside vault and history store; never overwrite",
    )
    .option("--json", "emit JSON metadata; bytes go only to the new file")
    .action(async (commit, options) =>
      print(await exportVaultHistory(await configured(), commit, options.path, options.file)),
    )
  history
    .command("disable")
    .description("stop automatic snapshots; preserve history for recovery")
    .option("--json", "emit JSON")
    .action(async () => print(await disableVaultHistory(await configured())))
  program.hook("preAction", (_root, action) => {
    const name = action.name(),
      parent = action.parent?.name(),
      options = action.opts()
    const applied =
      ["migrate", "preserve-school", "reading-copy", "obsidian", "alerts", "reminders"].includes(
        name,
      ) && Boolean(options.apply)
    const conditional =
      (name === "compare" && parent !== "canvas-agent") ||
      (name === "export" && parent === "calendar") ||
      (["homework", "timeline"].includes(name) && Boolean(options.draft))
    if (
      !applied &&
      !conditional &&
      ![
        "sync",
        "ingest",
        "approve",
        "workbook",
        "prep",
        "assignment",
        "draft",
        "revise",
        "save",
        "complete",
        "capture",
        "derive",
        "create",
        "resume",
        "init-assignment",
        "propose",
        "override",
        "calculate",
        "prepare",
        "review",
        "m1",
        "import",
        "playbook-import",
        "dogfood",
        "sweep",
        "reading-copy-disable",
      ].includes(name)
    )
      return
    pending.add(program)
  })
  program.hook("postAction", async () =>
    finishVaultHistory(program, Number(process.exitCode ?? 0) === 0),
  )
}
