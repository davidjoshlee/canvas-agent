import { isAbsolute } from "node:path"
import type { Command } from "commander"
import { loadConfig } from "../config/index.js"
import { readCoursePlaybook, readOwnFeedback } from "../feedback/history.js"
import { initializeAssignmentGuidance } from "../guidance/assignment-guidance.js"
import { listGuidanceProposals, showGuidanceProposal } from "../guidance/inventory.js"
import { proposeGuidance, saveGuidanceProposal } from "../guidance/proposals.js"
import {
  applyCalendarOverrides,
  compareCalendar,
  exportCalendar,
  readCalendarFile,
  setCalendarOverride,
} from "../student/calendar.js"
import { readUpcoming } from "../student/upcoming.js"
import { vaultMutation } from "../vault/command-effects.js"
import { inspectWorkspace, selectCourse } from "../vault/workspace.js"

type RootOptions = { config: string }
function emit(value: unknown, json: boolean, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`)
}
async function localConfig(path: string) {
  return loadConfig(path)
}

/** Register model-free student conveniences over the local vault. */
export function registerStudentCommands(program: Command): void {
  program
    .command("playbook <course>")
    .description("read private retained feedback/learning history, not a chronological grading log")
    .option(
      "--assignment <id>",
      "restrict to explicit assignment IDs",
      (value: string, all: string[]) => [...all, value],
      [] as string[],
    )
    .option("--json", "include explicitly requested private learning-history bodies")
    .action(async (course: string, options) => {
      const config = await localConfig(program.opts<RootOptions>().config)
      const result = await readCoursePlaybook(config.vault.path, course, options.assignment)
      emit(
        result,
        Boolean(options.json),
        `${JSON.stringify(result.history, null, 2)}\n${result.limitation}`,
      )
    })
  program
    .command("feedback <course>")
    .description(
      "read explicitly scoped cached own-submission feedback; never submit or infer instructor authorship",
    )
    .requiredOption("--assignment <id>", "exact Canvas assignment ID")
    .option("--json", "include private scores/comments only for this explicit request")
    .action(async (course: string, options) => {
      const config = await localConfig(program.opts<RootOptions>().config)
      const result = await readOwnFeedback(config.vault.path, course, options.assignment)
      emit(
        result,
        Boolean(options.json),
        `${result.course} assignment ${result.assignmentId}: ${result.status}\n${JSON.stringify(result.feedback, null, 2)}\n${result.limitation}`,
      )
    })
  const guidance =
    program.commands.find((command) => command.name() === "guidance") ??
    program.command("guidance").description("create and save local course guidance proposals")
  guidance
    .command("list")
    .description("discover saved course guidance proposals without generating replacements")
    .requiredOption("--course <course>", "explicit course code, root or Canvas ID")
    .option("--json", "emit metadata-only JSON")
    .action(async (options: { course: string; json?: boolean }) => {
      const config = await localConfig(program.opts<RootOptions>().config)
      const result = await listGuidanceProposals(config.vault.path, options.course)
      emit(
        result,
        Boolean(options.json),
        `${result.proposals.length} saved guidance proposals for ${result.course}. ${result.unreadableRecords} unreadable records. Use guidance show UUID; no currentness or activation was verified.`,
      )
    })
  guidance
    .command("show <id>")
    .description("locate an original proposal record and handoffs without changing history")
    .option("--json", "emit metadata-only JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      const config = await localConfig(program.opts<RootOptions>().config)
      const result = await showGuidanceProposal(config.vault.path, id)
      emit(
        result,
        Boolean(options.json),
        `Proposal ${result.id} for ${result.course}\nRecord: ${result.recordPath}\nTask: ${result.task ?? "missing"}\nInstructions: ${result.instructions ?? "missing"}\nRead the private record to continue; nothing was generated, activated or repaired.`,
      )
    })
  guidance
    .command("init-assignment <course>")
    .hook("preAction", vaultMutation())
    .description(
      "create a missing assignment-bound student-preference starter without overwriting guides",
    )
    .requiredOption("--source <path>", "exact vault-relative assignment prompt")
    .option("--json", "emit metadata-only JSON")
    .action(async (query: string, options: { source: string; json?: boolean }) => {
      const config = await localConfig(program.opts<RootOptions>().config)
      const result = await initializeAssignmentGuidance(config.vault.path, query, options.source)
      emit(
        result,
        Boolean(options.json),
        `${result.created ? "Created assignment guidance starter" : "Preserved existing assignment guidance"}: ${result.paths.join(", ")}\nAI permission was not verified. No student work was generated.`,
      )
    })
  guidance
    .command("propose <course>")
    .hook("preAction", vaultMutation())
    .description("create a source-bound, model-free guidance task handoff")
    .option(
      "--feedback-assignment <id>",
      "scope cached own-feedback to an exact assignment (repeat, at most five)",
      (value: string, all: string[]) => [...all, value],
      [] as string[],
    )
    .option("--json", "emit metadata-only JSON")
    .action(async (query: string, options: { json?: boolean; feedbackAssignment: string[] }) => {
      const config = await localConfig(program.opts<RootOptions>().config)
      const context = await inspectWorkspace(config.vault.path)
      const course = selectCourse(context, query)
      const result = await proposeGuidance(
        config.vault.path,
        context,
        course,
        options.feedbackAssignment.length
          ? { feedbackAssignments: options.feedbackAssignment }
          : {},
      )
      emit(
        result,
        Boolean(options.json),
        `Created guidance proposal task ${result.id} for ${result.course}.\nTask: ${result.task}\nInstructions: ${result.instructions}\nNo guidance was generated and active guidance was not changed.`,
      )
    })
  guidance
    .command("save <id>")
    .hook("preAction", vaultMutation())
    .description("save a candidate as a new versioned proposed guidance file")
    .requiredOption("--file <path>", "absolute candidate Markdown file")
    .option("--json", "emit JSON")
    .action(async (id: string, options: { file: string; json?: boolean }) => {
      if (!isAbsolute(options.file)) throw new Error("Candidate file path must be absolute")
      const config = await localConfig(program.opts<RootOptions>().config)
      const path = await saveGuidanceProposal(config.vault.path, id, options.file)
      emit(
        { id, path },
        Boolean(options.json),
        `Saved guidance proposal: ${path}\nActive guidance was not changed.`,
      )
    })

  const calendar =
    program.commands.find((command) => command.name() === "calendar") ??
    program.command("calendar").description("compare, override, and export local assignment dates")
  calendar
    .command("override <path>")
    .hook("preAction", vaultMutation())
    .description("set a private due-date override for a synced assignment path")
    .requiredOption("--due <iso>", "due date in ISO format")
    .option("--json", "emit JSON")
    .action(async (path: string, options: { due: string; json?: boolean }) => {
      const config = await localConfig(program.opts<RootOptions>().config)
      const context = await inspectWorkspace(config.vault.path)
      const result = await setCalendarOverride(config.vault.path, context, path, options.due)
      emit(result, Boolean(options.json), `Saved private date override for ${path}: ${options.due}`)
    })
  calendar
    .command("check")
    .description("compare a local ICS calendar with synced assignment dates")
    .requiredOption("--file <path>", "absolute ICS file")
    .option("--json", "emit JSON")
    .action(async (options: { file: string; json?: boolean }) => {
      if (!isAbsolute(options.file)) throw new Error("ICS path must be absolute")
      const config = await localConfig(program.opts<RootOptions>().config)
      const context = await applyCalendarOverrides(
        config.vault.path,
        await inspectWorkspace(config.vault.path),
      )
      const result = compareCalendar(context, await readCalendarFile(options.file))
      const lines = result.map(
        (row) =>
          `${row.kind.toUpperCase()}\t${row.title}${row.path ? `\t${row.path}` : ""}${row.canvasDueAt || row.calendarDueAt ? `\tCanvas ${row.canvasDueAt ?? "undated"} / calendar ${row.calendarDueAt ?? "undated"}` : ""}${row.detail ? `\t${row.detail}` : ""}`,
      )
      emit(
        result,
        Boolean(options.json),
        lines.length ? lines.join("\n") : "No calendar events or assignments to compare.",
      )
    })
  calendar
    .command("export")
    .hook("preAction", vaultMutation())
    .description("export dated assignments to a new ICS file")
    .requiredOption("--file <path>", "absolute destination ICS file; must not exist")
    .option("--days <count>", "days to include", "365")
    .option("--course <course>", "limit to a course")
    .option("--json", "emit JSON")
    .action(async (options: { file: string; days: string; course?: string; json?: boolean }) => {
      if (!isAbsolute(options.file)) throw new Error("ICS destination path must be absolute")
      const days = boundedDays(options.days)
      const config = await localConfig(program.opts<RootOptions>().config)
      const context = await inspectWorkspace(config.vault.path)
      const result = await readUpcoming(config.vault.path, context, {
        days,
        course: options.course,
      })
      const assignments = [...result.items, ...result.overdue].filter(
        (item) => item.kind === "assignment",
      )
      await exportCalendar(options.file, assignments)
      emit(
        { file: options.file, count: assignments.length },
        Boolean(options.json),
        `Exported dated assignment events to ${options.file}`,
      )
    })

  program
    .command("upcoming")
    .description("show upcoming, overdue, and undated course work")
    .option("--days <count>", "look ahead in days", "14")
    .option("--course <course>", "limit to a course")
    .option("--json", "emit JSON")
    .action(async (options: { days: string; course?: string; json?: boolean }) => {
      const config = await localConfig(program.opts<RootOptions>().config)
      const result = await readUpcoming(
        config.vault.path,
        await inspectWorkspace(config.vault.path),
        { days: boundedDays(options.days), course: options.course },
      )
      const lines = [
        `Upcoming (${result.items.length})`,
        ...result.items.map((item) => `${item.dueAt}\t${item.course}\t${item.title}\t${item.path}`),
        `Overdue (${result.overdue.length})`,
        ...result.overdue.map(
          (item) => `${item.dueAt}\t${item.course}\t${item.title}\t${item.path}`,
        ),
        `Undated (${result.undated.length})`,
        ...result.undated.map((item) => `${item.course}\t${item.title}\t${item.path}`),
      ]
      emit(result, Boolean(options.json), lines.join("\n"))
    })
}
function boundedDays(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 365)
    throw new Error("Days must be an integer between 0 and 365")
  return Number(value)
}
