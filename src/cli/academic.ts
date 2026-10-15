import { lstat, readFile } from "node:fs/promises"
import { type Command, Option } from "commander"
import { assertNoSymlinks } from "../shared/fs-safety.js"
import type { WorkspaceContext } from "../shared/types.js"
import { completeTask } from "../tasks/completion.js"
import { listCourseTasks } from "../tasks/inventory.js"
import { approveTask, reviseTask } from "../tasks/lifecycle.js"
import { taskInspectionCommand, taskLocations } from "../tasks/locations.js"
import { readTaskOutput } from "../tasks/output.js"
import {
  createAssignmentTask,
  createPrepTask,
  readTask,
  selectAssignmentPrompt,
} from "../tasks/store.js"
import { inspectWorkspace, selectCourse } from "../vault/workspace.js"
import { configWithEnv, render, summary, taskMarkdownPath } from "./output.js"

export function registerAcademicCommands(program: Command): void {
  program
    .command("context")
    .description("inspect local course context")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const config = await configWithEnv(program.opts().config)
      const context: WorkspaceContext = await inspectWorkspace(config.vault.path)
      const inventory = {
        ...context,
        courses: context.courses.map((course) => ({
          ...course,
          sources: course.sources.map(({ text: _text, ...metadata }) => metadata),
        })),
      }
      render(
        inventory,
        options.json,
        context.courses.length
          ? context.courses
              .map((c) => `${c.code}\t${c.title} (${c.sources.length} readable sources)`)
              .join("\n")
          : "No course-code folders found in the vault.",
      )
    })

  program
    .command("prep")
    .description("create a prep task for a week or module session")
    .argument("<course>", "course code or title")
    .option("--week <date|current>", "explicit Monday date or current week")
    .option("--session <selector>", "explicit module or session selector")
    .option("--json", "emit JSON")
    .action(async (course, options) => {
      if (options.week && options.session)
        throw new Error("Provide either --week or --session, not both")
      const config = await configWithEnv(program.opts().config)
      const task = await createPrepTask(
        config.vault.path,
        course,
        options.week,
        options.session ? { session: options.session } : {},
      )
      const taskFile = taskMarkdownPath(config, task.id)
      render(
        { ...summary(task), taskFile },
        options.json,
        `Created prep task ${task.id} for ${task.course.code}, ${task.period?.kind ?? "week"} ${task.period?.value ?? task.week}.\nRead: ${taskFile}`,
      )
    })

  program
    .command("assignment")
    .description("create an assignment discussion, outline, draft, or review task")
    .argument("<course>", "course code or title")
    .requiredOption("--source <path>", "approved vault-relative assignment prompt")
    .requiredOption("--mode <mode>", "outline, draft, review, or discuss")
    .option("--message <text>", "required student inquiry for discuss mode only")
    .option("--work <path>", "explicit Markdown/text student work in a Drafts folder")
    .option(
      "--context <path>",
      "approved explicit context path (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--json", "emit JSON")
    .action(async (course, options) => {
      const config = await configWithEnv(program.opts().config)
      const task = await createAssignmentTask(
        config.vault.path,
        course,
        options.source,
        options.mode,
        options.work,
        options.context,
        undefined,
        options.message,
      )
      const taskFile = taskMarkdownPath(config, task.id)
      render(
        { ...summary(task), taskFile },
        options.json,
        `Created ${task.assignment?.mode} assignment task ${task.id} for ${task.course.code}.\nRead: ${taskFile}`,
      )
    })

  program
    .command("draft")
    .description("create an explicit draft task from a course assignment prompt")
    .argument("<assignment>", "assignment title, Canvas ID, or exact vault path")
    .requiredOption("--course <course>", "explicit course code or title")
    .option(
      "--discuss <message>",
      "create a separate discussion handoff instead of a draft version",
    )
    .option("--work <path>", "explicit student work in a Drafts folder")
    .option(
      "--context <path>",
      "approved context path (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--json", "emit JSON")
    .action(async (assignmentQuery, options) => {
      const config = await configWithEnv(program.opts().config)
      const context = await inspectWorkspace(config.vault.path)
      const course = selectCourse(context, options.course)
      const prompt = selectAssignmentPrompt(course, String(assignmentQuery))
      const taskRecord = await createAssignmentTask(
        config.vault.path,
        course.code,
        prompt.path,
        options.discuss !== undefined ? "discuss" : "draft",
        options.work,
        options.context,
        undefined,
        options.discuss,
      )
      const taskFile = taskMarkdownPath(config, taskRecord.id)
      render(
        { ...summary(taskRecord), taskFile },
        options.json,
        `Created ${taskRecord.assignment?.mode} task ${taskRecord.id} for ${course.code}: ${prompt.title}.\nRead: ${taskFile}`,
      )
    })

  program
    .command("revise")
    .description("create a fresh revision task from a completed draft")
    .argument("<id>", "completed draft task UUID")
    .argument("[feedback]", "optional revision feedback")
    .option("--feedback <text>", "explicit revision feedback")
    .option("--work <path>", "additional vault-relative student work path")
    .option("--file <path>", "additional vault-relative student work path")
    .option("--json", "emit JSON")
    .action(async (id, feedback, options) => {
      if (feedback && options.feedback)
        throw new Error("Use positional feedback or --feedback, not both")
      if (options.file && options.work) throw new Error("Use --file or --work, not both")
      const config = await configWithEnv(program.opts().config)
      const direction =
        options.feedback ??
        feedback ??
        "Create a revised draft using the existing task sources and prior draft."
      const revised = await reviseTask(
        config.vault.path,
        id,
        direction,
        options.work ?? options.file,
      )
      const taskFile = taskMarkdownPath(config, revised.id)
      render(
        { ...summary(revised), taskFile },
        options.json,
        `Created revision task ${revised.id} from ${id}.\nRead: ${taskFile}`,
      )
    })

  program
    .command("approve")
    .description("copy a completed draft to a non-overwriting Finals output")
    .argument("<id>", "completed draft task UUID")
    .option("--json", "emit JSON")
    .action(async (id, options) => {
      const config = await configWithEnv(program.opts().config)
      const result = await approveTask(config.vault.path, id)
      render(
        {
          task: summary(result.task),
          output: result.output,
          ...(result.workbook ? { workbook: result.workbook } : {}),
        },
        options.json,
        `Approved local draft ${id}.\nCopied to: ${result.output}${result.workbook ? `\nWorkbook: ${result.workbook.path}` : ""}`,
      )
    })

  const task = program.command("task").description("show or complete persisted academic tasks")
  task
    .command("output <id>")
    .description("read verified existing ordinary output; never regenerate or approve")
    .option("--json", "emit private saved text and integrity metadata")
    .action(async (id: string, options) => {
      const configPath = program.opts().config
      const config = await configWithEnv(configPath)
      const result = await readTaskOutput(configPath, config.vault.path, id, "ordinary")
      if (options.json) render(result, true, "")
      else process.stdout.write(result.text)
    })
  task
    .command("list")
    .description("find saved ordinary tasks for one course; metadata only")
    .requiredOption("--course <course>", "explicit local course identity")
    .addOption(
      new Option("--status <status>", "filter saved status").choices(["pending", "completed"]),
    )
    .option("--json", "emit metadata-only JSON")
    .action(async (options) => {
      const config = await configWithEnv(program.opts().config)
      const result = await listCourseTasks(config.vault.path, options.course, options.status)
      render(
        {
          ...result,
          scope: "ordinary",
          tasks: result.tasks.map((row) => ({
            ...row,
            inspectionCommand: taskInspectionCommand("ordinary", row.id, program.opts().config),
          })),
        },
        options.json,
        [
          `Saved tasks for ${result.course}: ${result.tasks.length}`,
          ...result.tasks.map(
            (row) =>
              `${row.id}\t${row.status}\t${row.kind}${row.mode ? `/${row.mode}` : ""}\t${row.promptPath ?? row.period?.value ?? row.week ?? ""}`,
          ),
          ...(result.unreadableRecords
            ? [
                `Inventory incomplete: ${result.unreadableRecords} unreadable record(s), course scope unknown.`,
              ]
            : []),
          result.limitation,
        ].join("\n"),
      )
    })
  task
    .command("show")
    .description("show a task brief")
    .argument("<id>", "task UUID")
    .option("--json", "emit the full task including approved source snapshots")
    .action(async (id, options) => {
      const config = await configWithEnv(program.opts().config)
      const record = await readTask(config.vault.path, id)
      const file = taskMarkdownPath(config, id)
      await assertNoSymlinks(file, true)
      let briefStatus: "present" | "missing" = "present"
      try {
        const stat = await lstat(file)
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error("Task brief is not a regular file")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        briefStatus = "missing"
      }
      if (options.json)
        render(
          {
            ...record,
            ...taskLocations(
              program.opts().config,
              config.vault.path,
              record.id,
              "ordinary",
              record.output,
              record.workbook?.path,
            ),
            briefStatus,
            ...(briefStatus === "present" ? { taskFile: file } : {}),
          },
          true,
          "",
        )
      else if (briefStatus === "missing")
        throw new Error(
          "Task brief is missing; use task show UUID --json to read the validated saved recipe. No history was rewritten.",
        )
      else process.stdout.write(await readFile(file, "utf8"))
    })
  task
    .command("complete")
    .description("validate and save a candidate prep or assignment artifact")
    .argument("<id>", "task UUID")
    .requiredOption("--file <path>", "candidate Markdown file")
    .option("--json", "emit JSON")
    .action(async (id, options) => {
      const config = await configWithEnv(program.opts().config)
      const result = await completeTask(config.vault.path, id, options.file)
      render(
        { task: summary(result.task), output: result.output },
        options.json,
        `Completed task ${id}.\nSaved: ${result.output}${result.task.workbook ? `\nWorkbook: ${result.task.workbook.path}` : ""}`,
      )
    })
}
