import { resolve } from "node:path"
import { type Command, Option } from "commander"
import { readVaultLocation, setVaultLocation } from "../config/index.js"
import { ingestFile } from "../documents/content.js"
import { withHomeworkDraftStatus } from "../student/homework-status.js"
import { readTimeline, renderTimeline } from "../student/timeline.js"
import { readUpcoming } from "../student/upcoming.js"
import { createAssignmentTask } from "../tasks/authoring/creation.js"
import { vaultMutation } from "../vault/command-effects.js"
import { isAssignmentSource } from "../vault/source-kind.js"
import { inspectWorkspace, selectCourse } from "../vault/workspace.js"
import { inspectVaultHealth } from "./health.js"
import { configWithEnv, render, summary, taskMarkdownPath } from "./output.js"

export function registerWorkspaceCommands(program: Command): void {
  const addSchedule = (
    name: "homework" | "timeline",
    periodOption: "days" | "weeks",
    fallback: number,
  ) => {
    const schedule = program
      .command(name)
      .hook(
        "preAction",
        vaultMutation((options) => Boolean(options.draft)),
      )
      .description(
        name === "homework"
          ? "show upcoming and overdue assignments"
          : "show the assignment and announcement timeline",
      )
      .option(`--${periodOption} <count>`, `look ahead in ${periodOption}`, String(fallback))
      .option("--course <code>", "limit to one course")
      .option("--json", "emit metadata-only JSON")
      .action(async (options) => {
        const config = await configWithEnv(program.opts().config)
        const context = await inspectWorkspace(config.vault.path)
        if (options.draft) {
          if (name !== "homework") throw new Error("--draft is supported only by homework")
          if (!/^\d+$/.test(options.draft))
            throw new Error("homework --draft requires an exact Canvas assignment ID")
          const candidates = options.course
            ? [selectCourse(context, options.course)]
            : context.courses
          const matches = candidates.flatMap((course) =>
            course.sources
              .filter((source) => isAssignmentSource(source) && source.canvasId === options.draft)
              .map((prompt) => ({ course, prompt })),
          )
          if (matches.length !== 1)
            throw new Error(
              matches.length
                ? "Assignment ID is ambiguous; provide --course and an exact prompt"
                : "No eligible assignment matches that Canvas ID in the selected vault/course",
            )
          const selected = matches[0]
          if (!selected) throw new Error("Assignment ID selection failed")
          const task = await createAssignmentTask(
            config.vault.path,
            selected.course.code,
            selected.prompt.path,
            "draft",
          )
          render(
            { ...summary(task), taskFile: taskMarkdownPath(config, task.id) },
            options.json,
            `Created pending draft task ${task.id} for ${task.course.code}. Read task show and generate with your chosen agent; nothing was submitted.`,
          )
          return
        }
        const rawCount = String(options[periodOption])
        if (!/^\d+$/.test(rawCount))
          throw new Error(`--${periodOption} must be an integer between 0 and 365`)
        const count = Number(rawCount)
        if (!Number.isSafeInteger(count) || count > 365)
          throw new Error(`--${periodOption} must be between 0 and 365`)
        if (options.course) selectCourse(context, options.course)
        if (name === "timeline") {
          const result = await readTimeline(config.vault.path, context, {
            weeks: count,
            course: options.course,
          })
          render(result, options.json, renderTimeline(result))
          return
        }
        const upcoming = await readUpcoming(config.vault.path, context, {
          days: periodOption === "weeks" ? count * 7 : count,
          course: options.course,
          includeAnnouncements: false,
        })
        const result = await withHomeworkDraftStatus(config.vault.path, context, upcoming)
        const draftLabel = (
          item: (typeof result.items)[number] | (typeof result.undated)[number],
        ) =>
          name === "homework" && "draftVersion" in item
            ? `\tdraft: ${"draftBinding" in item && item.draftBinding === "ambiguous-legacy-filename" ? "ambiguous legacy filenames" : item.draftVersion === null ? "none found" : `v${item.draftVersion}`} (presence only)${item.relatedDrafts.length ? `; related: ${item.relatedDrafts.length} saved draft(s), different prompt snapshot` : ""}`
            : ""
        const lines = [
          `Upcoming (${result.items.length})`,
          ...result.items.map(
            (item) =>
              `${item.dueAt}\t${item.course}\t${item.title}\t${item.path}${draftLabel(item)}`,
          ),
          `Overdue (${result.overdue.length})`,
          ...result.overdue.map(
            (item) =>
              `${item.dueAt}\t${item.course}\t${item.title}\t${item.path}${draftLabel(item)}`,
          ),
          `Undated (${result.undated.length})`,
          ...result.undated.map(
            (item) => `${item.course}\t${item.title}\t${item.path}${draftLabel(item)}`,
          ),
        ]
        if ("unreadableTaskRecords" in result && result.unreadableTaskRecords)
          lines.push(
            `Draft inventory incomplete: ${result.unreadableTaskRecords} unreadable task record(s); inspect before relying on missing-draft status.`,
          )
        if (
          [...result.items, ...result.overdue, ...result.undated].some(
            (item) => item.relatedDrafts.length,
          )
        )
          lines.push(
            "Related drafts are not current-prompt completion: use --json for their task IDs and original prompt paths, then inspect those tasks.",
          )
        render(result, options.json, lines.join("\n"))
      })
    if (name === "homework")
      schedule.option("--draft <id>", "create a pending draft by exact Canvas assignment ID")
  }
  addSchedule("homework", "days", 14)
  addSchedule("timeline", "weeks", 4)

  program
    .command("ingest")
    .hook("preAction", vaultMutation())
    .description("copy a selected local file into one course and extract supported text")
    .argument("<file>", "absolute path to the chosen local file")
    .requiredOption("--course <course>", "explicit course code or title")
    .option("--title <title>", "optional extraction title")
    .option("--week <date>", "associate extracted text with an explicit Monday")
    .option("--as-of <date>", "student-confirmed availability date, YYYY-MM-DD")
    .option("--module <id>", "associate extracted text with an existing course module")
    .option(
      "--school-compatible",
      "create a separate School-readable sidecar with explicit policy metadata",
    )
    .addOption(
      new Option(
        "--ai-policy <policy>",
        "declared metadata, not a grant of AI-use permission",
      ).choices(["allowed", "prohibited"]),
    )
    .addOption(
      new Option(
        "--redistribution <policy>",
        "declared file handling metadata, not a license grant",
      ).choices(["allowed", "restricted"]),
    )
    .option("--json", "emit JSON")
    .action(async (file, options) => {
      const configPath = resolve(program.opts().config)
      if ([configPath, `${configPath}.auth.json`].includes(resolve(String(file))))
        throw new Error("Selected CLI config/auth files cannot be ingested into an academic vault")
      const config = await configWithEnv(program.opts().config)
      if (
        options.schoolCompatible
          ? !options.aiPolicy || !options.redistribution
          : options.aiPolicy || options.redistribution
      )
        throw new Error(
          "Use --school-compatible with both explicit --ai-policy and --redistribution declarations",
        )
      const result = await ingestFile(config.vault.path, options.course, file, options.title, {
        week: options.week,
        asOf: options.asOf,
        module: options.module,
        ...(options.schoolCompatible
          ? {
              compatibility: {
                canvasOrigin: config.canvas.baseUrl,
                aiPolicy: options.aiPolicy,
                redistribution: options.redistribution,
              },
            }
          : {}),
      })
      render(
        result,
        options.json,
        `Copied file: ${result.original}${result.text ? `\nExtracted text: ${result.text}` : ""}${result.notices.length ? `\n${result.notices.join("\n")}` : ""}`,
      )
    })

  const vault = program.command("vault").description("inspect local vault")
  vault
    .command("location")
    .description("show or change the configured vault directory")
    .option("--set <path>", "point the config to an existing vault directory")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const configPath = resolve(program.opts().config)
      const result =
        options.set !== undefined
          ? await setVaultLocation(configPath, options.set)
          : await readVaultLocation(configPath)
      const status = result.exists
        ? "Vault directory exists."
        : "Vault directory is missing; reconnect by selecting an existing vault with --set <path>."
      const human =
        options.set !== undefined
          ? `Config: ${result.config}\nVault: ${result.vault}\n${"changed" in result && !result.changed ? "Location already configured" : "Config updated"}; vault files were not moved.\n${status}`
          : `Config: ${result.config}\nVault: ${result.vault}\n${status}\nChange the configured location with: canvas-agent vault location --set <existing-directory> --config CONFIG_PATH`
      render(result, options.json, human)
    })

  vault
    .command("health")
    .description("check vault structure read-only")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const config = await configWithEnv(program.opts().config)
      const result = await inspectVaultHealth(config.vault.path, config.courses.allowlist)
      render(
        result,
        options.json,
        result.checks.map((c) => `${c.status.toUpperCase()} ${c.name}: ${c.message}`).join("\n"),
      )
      if (!result.ok) process.exitCode = 1
    })
}
