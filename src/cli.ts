#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { lstat, mkdir, readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Command, Option } from "commander"
import { authStatus, importSchoolKeychainAuth, loginAuth, renewalInstructions } from "./auth.js"
import { writeAuthAlert } from "./auth-alerts.js"
import {
  CanvasSyncPartialError,
  isCanvasDiscoveryUnavailable,
  isCanvasUnauthorized,
  listActiveCourses,
  listCourses,
  syncCourses,
  verifyAuth,
} from "./canvas.js"
import { completeTask } from "./completion.js"
import { createConfig, loadAdjacentEnv, loadConfig, setupConfig } from "./config.js"
import { ingestFile } from "./content.js"
import { registerDogfoodCommand } from "./dogfood-cli.js"
import { assertNoSymlinks } from "./fs-safety.js"
import { doctorChecks, inspectVaultHealth } from "./health.js"
import { withHomeworkDraftStatus } from "./homework-status.js"
import { reconcileSchoolIndex } from "./index-reconciliation.js"
import { discoverInstructions } from "./instructions.js"
import { approveTask, reviseTask } from "./lifecycle.js"
import { registerMigrationCommand } from "./migration-cli.js"
import { registerObsidianCommand } from "./obsidian.js"
import { selectOnboardingCourses } from "./onboarding.js"
import { registerPreservationCommand } from "./preservation-cli.js"
import { registerReadingCopyCommands } from "./reading-copy-cli.js"
import { registerStudentCommands } from "./student-cli.js"
import { listCourseTasks } from "./task-inventory.js"
import { taskInspectionCommand, taskLocations } from "./task-locations.js"
import { readTaskOutput } from "./task-output.js"
import { createAssignmentTask, createPrepTask, readTask, selectAssignmentPrompt } from "./tasks.js"
import { readTimeline, renderTimeline } from "./timeline.js"
import { registerToolCommands } from "./tool-cli.js"
import type { TaskRecord, ToolkitConfig, WorkspaceContext } from "./types.js"
import { readUpcoming } from "./upcoming.js"
import { finishVaultHistory, registerVaultHistory } from "./vault-history-cli.js"
import { inspectWorkspace, selectCourse } from "./workspace.js"

const DEFAULT_CONFIG = "./canvas-agent.config.json"
const packageVersion = (createRequire(import.meta.url)("../package.json") as { version: string })
  .version

function summary(task: TaskRecord) {
  return {
    id: task.id,
    kind: task.kind,
    parserVersion: task.parserVersion,
    ...(task.deliverable ? { deliverable: task.deliverable } : {}),
    ...(task.deliverableScopeVersion
      ? { deliverableScopeVersion: task.deliverableScopeVersion }
      : {}),
    ...(task.deliverableParserVersion
      ? { deliverableParserVersion: task.deliverableParserVersion }
      : {}),
    ...(task.guidanceSelectionVersion
      ? { guidanceSelectionVersion: task.guidanceSelectionVersion }
      : {}),
    ...(task.assignmentStructureVersion
      ? { assignmentStructureVersion: task.assignmentStructureVersion }
      : {}),
    status: task.status,
    course: task.course,
    week: task.week,
    period: task.period,
    assignment: task.assignment,
    parentTaskId: task.parentTaskId,
    feedback: task.feedback,
    ...(task.learningHistory
      ? {
          learningHistory: {
            hash: task.learningHistory.hash,
            records: task.learningHistory.records.length,
            legacyPlaybooks: task.learningHistory.legacyPlaybooks?.length ?? 0,
          },
        }
      : {}),
    discussion: task.discussion,
    destination: task.destination,
    requirements: task.requirements,
    workflow: task.workflow,
    sources: task.sources.map((s) => s.path),
    guidance: task.guidance.map((s) => s.path),
    excluded: task.excluded,
    notices: task.notices,
    ...(task.output ? { output: task.output } : {}),
    ...(task.workbookVersion
      ? { workbookVersion: task.workbookVersion, workbook: task.workbook ?? null }
      : {}),
  }
}

function taskMarkdownPath(config: ToolkitConfig, id: string): string {
  return join(config.vault.path, "_meta", "tasks", id, "TASK.md")
}

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

function render(value: unknown, json: boolean, human: string): void {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  else process.stdout.write(`${human}\n`)
}

async function configWithEnv(configPath: string): Promise<ToolkitConfig> {
  await loadAdjacentEnv(configPath)
  return loadConfig(configPath)
}

function makeProgram(): Command {
  const program = new Command()
  program
    .name("canvas-agent")
    .version(packageVersion)
    .description("Model-free Canvas workspace and task handoffs")
    .showHelpAfterError(false)
  program.addOption(new Option("--config <path>", "configuration file").default(DEFAULT_CONFIG))

  program
    .command("instructions")
    .description(
      "locate this installation's agent instructions without config, credentials or vault access",
    )
    .option("--topic <text>", "read matching installed CLI paragraphs (literal, case-insensitive)")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const result = await discoverInstructions(undefined, options.topic)
      render(
        result,
        options.json,
        result.lookup
          ? `${result.lookup.excerpts.map((part) => `${part.heading} (lines ${part.startLine}–${part.endLine})\n${part.text}`).join("\n\n")}\n\n${result.lookup.note}`
          : `Canvas Agent ${result.packageVersion} instructions\n${result.files.map((file) => `${file.id}: ${file.path}`).join("\n")}\n${result.note}`,
      )
    })

  program
    .command("init")
    .description("create a new config and prepare the vault directory")
    .option("--json", "emit JSON")
    .requiredOption("--vault <path>", "vault directory")
    .requiredOption("--canvas-url <url>", "Canvas base URL")
    .option("--token-env <name>", "environment variable containing the Canvas token")
    .option(
      "--course <id>",
      "allowlist a Canvas course ID (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .action(async (options, command) => {
      const configPath = command.parent?.opts().config as string
      const config = await createConfig(configPath, {
        vault: options.vault,
        baseUrl: options.canvasUrl,
        tokenEnv: options.tokenEnv,
        courses: options.course,
      })
      // Creating an already existing directory is safe; mkdir never removes vault data.
      await assertNoSymlinks(config.vault.path, true)
      await mkdir(config.vault.path, { recursive: true })
      await assertNoSymlinks(config.vault.path)
      const value = {
        config: resolve(configPath),
        vault: config.vault.path,
        canvasUrl: config.canvas.baseUrl,
        tokenEnv: config.canvas.tokenEnv,
        courses: config.courses.allowlist,
      }
      render(
        value,
        options.json,
        `Created config: ${value.config}\nVault directory ready: ${value.vault}\nCanvas token will be read from ${value.tokenEnv}.`,
      )
    })

  program
    .command("courses")
    .description("discover readable Canvas courses (sync still requires an allowlist)")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const config = await configWithEnv(program.opts().config)
      const courses = await listCourses(config)
      render(
        courses,
        options.json,
        courses.length
          ? courses.map((c) => `${c.id}\t${c.code}\t${c.name}`).join("\n")
          : "No readable Canvas courses.",
      )
    })

  program
    .command("setup")
    .description("create a new config, blank token template, and vault")
    .option("--json", "emit JSON")
    .requiredOption("--canvas-url <url>", "Canvas base URL")
    .option("--vault <path>", "vault directory (default: ~/canvas-vault)")
    .option("--token-env <name>", "environment variable containing the Canvas token")
    .action(async (options, command) => {
      const configPath = command.parent?.opts().config as string
      const config = await setupConfig(configPath, {
        vault: options.vault,
        baseUrl: options.canvasUrl,
        tokenEnv: options.tokenEnv,
      })
      const envTemplate = join(dirname(resolve(configPath)), ".env")
      render(
        {
          config: resolve(configPath),
          vault: config.vault.path,
          canvasUrl: config.canvas.baseUrl,
          tokenEnv: config.canvas.tokenEnv,
          courses: config.courses.allowlist,
          envTemplate,
        },
        options.json,
        `Created config: ${resolve(configPath)}\nVault directory ready: ${config.vault.path}\nBlank token template: ${envTemplate}\nSet ${config.canvas.tokenEnv} locally before Canvas access.`,
      )
    })

  program
    .command("sync")
    .description("sync allowlisted Canvas courses")
    .option(
      "--preserve-school",
      "persist a separate Canvas Agent writable namespace in each selected course; preserve existing School files",
    )
    .option(
      "--full",
      "refresh current metadata/originals (already the default); never overwrite student edits",
    )
    .option(
      "--course <id-or-code>",
      "sync one or more allowlisted courses only (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--json", "emit JSON")
    .option(
      "--notify-due-soon",
      "explicitly deliver a due-soon macOS notification after saving the private alert",
    )
    .option("--lead-days <days>", "due-soon reminder horizon, 1–365 days", "7")
    .action(async (options) => {
      const config = await configWithEnv(program.opts().config)
      let selectedConfig = config
      if (!/^[1-9]\d*$/.test(String(options.leadDays)) || Number(options.leadDays) > 365)
        throw new Error("--lead-days must be between 1 and 365")
      if (options.course.length) {
        const allow = new Set(config.courses.allowlist)
        let discovered: Awaited<ReturnType<typeof listCourses>> = []
        if (
          (options.course as string[]).some(
            (query) => !allow.has(query) || !/^[1-9]\d*$/.test(query),
          )
        ) {
          try {
            discovered = await listCourses(config, true)
          } catch (error) {
            if (!isCanvasDiscoveryUnavailable(error)) throw error
            const context = await inspectWorkspace(config.vault.path)
            if (
              context.notices.some((notice) =>
                notice.startsWith("Canvas course mappings are unavailable or unsafe"),
              )
            )
              throw new Error(
                "Course discovery and local mappings are unavailable; use an exact allowlisted numeric ID after inspecting mappings",
              )
            discovered = context.courses.flatMap((course) =>
              course.canvasId && allow.has(course.canvasId)
                ? [{ id: course.canvasId, code: course.code, name: course.title }]
                : [],
            )
          }
        }
        const selected: string[] = []
        for (const query of options.course as string[]) {
          if (allow.has(query) && /^[1-9]\d*$/.test(query)) {
            selected.push(query)
            continue
          }
          const exact = discovered.filter(
            (course) =>
              course.id.toLocaleLowerCase() === query.toLocaleLowerCase() ||
              course.code.toLocaleLowerCase() === query.toLocaleLowerCase(),
          )
          const matches = exact.length
            ? exact
            : discovered.filter(
                (course) => course.name.toLocaleLowerCase() === query.toLocaleLowerCase(),
              )
          if (matches.length !== 1)
            throw new Error(
              matches.length > 1
                ? `Course selector is ambiguous: ${query}`
                : `No discovered course matches: ${query}`,
            )
          const id = matches[0]?.id
          if (!id || !allow.has(id))
            throw new Error(`Course ${query} is not in the configured sync allowlist`)
          selected.push(id)
        }
        selectedConfig = { ...config, courses: { allowlist: [...new Set(selected)] } }
      }
      let result: Awaited<ReturnType<typeof syncCourses>>
      try {
        result = await syncCourses(selectedConfig, {
          preserveSchool: Boolean(options.preserveSchool),
          reminderDays: Number(options.leadDays),
          notifyDueSoon: options.notifyDueSoon,
        })
      } catch (error) {
        if (!(error instanceof CanvasSyncPartialError)) throw error
        process.exitCode = 1
        render(
          {
            ...error.report,
            refreshMode: "full",
            fullRequested: Boolean(options.full),
            status: "partial-failure",
          },
          options.json,
          `Partial sync: ${error.report.courses} course(s) synced; ${error.report.failedCourses} failed.\n${error.report.courseReports?.map((course) => `${course.courseId}\t${course.code ?? "unknown code"}\t${course.status}${course.httpStatus ? `\tHTTP ${course.httpStatus}` : ""}`).join("\n")}\nRetry the failed course explicitly; due-soon alerts/auth resolution and reading-copy refresh were not performed.`,
        )
        return
      }
      if (result.courses) {
        try {
          await writeAuthAlert(program.opts().config, config, "selected-sync-succeeded")
        } catch {
          result.notices.push(
            "Sync succeeded but its private auth alert could not be resolved; inspect the alert/state without overwriting it.",
          )
        }
      }
      render(
        { ...result, refreshMode: "full", fullRequested: Boolean(options.full) },
        options.json,
        `Synced ${result.courses} course(s); wrote ${result.written.length} file(s).${result.dueSoon?.status === "saved" ? `\nDue-soon alert: ${result.dueSoon.receipt.alertFile}; assignments=${result.dueSoon.receipt.assignments}; desktop=${result.dueSoon.notification}.` : ""}${result.notices.length ? `\n${result.notices.join("\n")}` : ""}`,
      )
    })

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

  const courses = program.commands.find((candidate) => candidate.name() === "courses")
  if (!courses) throw new Error("Courses command was not registered")
  courses
    .command("list")
    .description("list discovered active Canvas courses")
    .option("--all", "include inactive courses")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const config = await configWithEnv(program.opts().config)
      const rows = options.all ? await listCourses(config, true) : await listActiveCourses(config)
      render(
        rows,
        options.json || courses.opts().json,
        rows.length
          ? rows.map((c) => `${c.id}\t${c.code}\t${c.name}`).join("\n")
          : "No readable courses.",
      )
    })

  program
    .command("doctor")
    .description("check local readiness without contacting Canvas")
    .option("--json", "emit JSON")
    .option("--sync-only", "check only sync prerequisites")
    .option("--offline", "report local readiness when Canvas access is not configured")
    .action(async (options) => {
      const configPath = program.opts().config as string
      await loadAdjacentEnv(configPath)
      let config: ToolkitConfig | undefined
      try {
        config = await loadConfig(configPath)
      } catch {
        /* summarized by doctorChecks */
      }
      if (options.offline && options.syncOnly)
        throw new Error("Choose --offline or --sync-only, not both")
      const result = await doctorChecks(configPath, config, {
        syncOnly: options.syncOnly,
        offline: options.offline,
      })
      render(
        result,
        options.json,
        result.checks.map((c) => `${c.status.toUpperCase()} ${c.name}: ${c.message}`).join("\n"),
      )
      if (!result.ok) process.exitCode = 1
    })

  const auth = program.command("auth").description("provision, check, and renew Canvas credentials")
  auth
    .command("login")
    .description(
      "save a locally provisioned token in private adjacent .env and record confirmed expiry",
    )
    .requiredOption("--expires-at <iso>", "confirmed token expiry from Canvas")
    .option("--account <name>", "local account label (not a credential)", "local")
    .option("--replace", "explicitly replace a previously saved token")
    .option("--json", "emit credential-free JSON")
    .action(async (options) => {
      const path = program.opts().config
      const config = await configWithEnv(path)
      const result = await loginAuth(path, config, {
        expiresAt: options.expiresAt,
        account: options.account,
        replace: options.replace,
      })
      render(
        result,
        options.json,
        `Canvas token stored in private adjacent .env; confirmed expiry recorded: ${result.expiresAt}. Run auth verify to check API authorization.`,
      )
    })
  auth
    .command("import-school-keychain")
    .description(
      "opt in to import one named School macOS Keychain token into private dotenv storage",
    )
    .requiredOption("--account <name>", "exact account used by School auth login")
    .requiredOption("--expires-at <iso>", "confirmed future token expiry from Canvas")
    .option("--replace", "explicitly replace a previously saved dotenv token")
    .option("--json", "emit credential-free import metadata")
    .action(async (options) => {
      const path = program.opts().config
      const config = await loadConfig(path)
      const result = await importSchoolKeychainAuth(path, config, options)
      render(
        result,
        options.json,
        `Selected School token imported into private adjacent .env; Keychain unchanged.\n${result.nextSteps}`,
      )
    })
  auth
    .command("renew")
    .description("show manual Canvas token renewal steps; no network or automatic token minting")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const config = await loadConfig(program.opts().config)
      const result = renewalInstructions(config)
      render(
        result,
        options.json,
        [result.settingsUrl, ...result.steps.map((step, index) => `${index + 1}. ${step}`)].join(
          "\n",
        ),
      )
    })
  auth
    .command("verify")
    .description("verify configured credentials with a read-only request")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const config = await configWithEnv(program.opts().config)
      const result = await verifyAuth(config)
      let alert: Awaited<ReturnType<typeof writeAuthAlert>> | { status: "not-updated" }
      try {
        alert = await writeAuthAlert(program.opts().config, config, "api-verified")
      } catch {
        alert = { status: "not-updated" }
      }
      render(
        { ...result, alert },
        options.json,
        `Canvas authentication succeeded.${alert.status === "not-updated" ? " Private auth alert was preserved but could not be resolved; inspect it separately." : ""}`,
      )
    })

  auth
    .command("status")
    .description("report local token presence and recorded expiry; not API authorization")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const config = await configWithEnv(program.opts().config)
      const result = await authStatus(program.opts().config, config)
      render(
        result,
        options.json,
        `Configured Canvas token environment variable ${config.canvas.tokenEnv} is ${result.available ? "available locally" : "not set"}.\nRecorded renewal state: ${result.renewal}.${"expiresAt" in result ? ` Expiry: ${result.expiresAt}.` : ""} This does not verify API authorization.`,
      )
    })

  program
    .command("onboard")
    .description("select active courses, or select and sync one concluded pilot")
    .argument("[id]", "exact concluded Canvas course ID with --pilot")
    .option("--pilot", "select and sync one explicitly chosen concluded course, preserving files")
    .option(
      "--preserve-school",
      "with --pilot, use a separate persistent Canvas Agent writable course namespace",
    )
    .option(
      "--course <id>",
      "active course ID (repeatable), or one concluded ID with --pilot",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--all-active", "explicitly select every active discovered course")
    .option("--json", "emit JSON")
    .action(async (id, options) => {
      if (options.preserveSchool && !options.pilot)
        throw new Error(
          "Onboarding --preserve-school requires --pilot; for active courses select them, then sync --preserve-school",
        )
      if (id && (!options.pilot || options.course.length))
        throw new Error(
          "Positional onboarding needs --pilot and no --course; otherwise use --course IDs",
        )
      const configPath = program.opts().config as string
      const config = await configWithEnv(configPath)
      const result = await selectOnboardingCourses(configPath, config, {
        ids: id ? [id] : options.course,
        allActive: options.allActive,
        pilot: options.pilot,
      })
      const pilotSync = options.pilot
        ? await syncCourses(
            { ...config, courses: { allowlist: result.selected } },
            {
              ...(result.pilotEligibility?.basis === "assignment-date-span-and-own-feedback"
                ? { unresolvedPilot: result.courses[0] }
                : {}),
              preserveSchool: Boolean(options.preserveSchool),
            },
          )
        : undefined
      render(
        { ...result, ...(pilotSync ? { sync: pilotSync } : {}) },
        options.json,
        `Selected ${result.selected.length} course(s):\n${result.courses.map((c) => `${c.id}\t${c.code}\t${c.name}`).join("\n")}${result.warning ? `\n${result.warning}` : ""}`,
      )
    })

  const addSchedule = (
    name: "homework" | "timeline",
    periodOption: "days" | "weeks",
    fallback: number,
  ) => {
    const schedule = program
      .command(name)
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
              .filter(
                (source) =>
                  /^assignments?(?:\.md)?$/i.test(source.type) && source.canvasId === options.draft,
              )
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
    .command("reconcile-index")
    .description("diagnose explicitly selected School index paths read-only")
    .requiredOption("--school-index <path>", "absolute School SQLite index outside the vault")
    .requiredOption("--course <ids...>", "explicit numeric Canvas course IDs")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const config = await configWithEnv(program.opts().config)
      const result = await reconcileSchoolIndex({
        vault: config.vault.path,
        index: options.schoolIndex,
        courseIds: options.course,
        canvasOrigin: config.canvas.baseUrl,
      })
      render(
        result,
        options.json,
        `${result.findings.length} indexed path issue(s); ${result.proposedRelinks} unique relocation candidate(s). Read-only: review JSON; no relinks applied.`,
      )
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

  const configCommand = program.command("config").description("inspect configuration safely")
  configCommand
    .command("validate")
    .description("validate the selected config file")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const configPath = program.opts().config as string
      const config = await loadConfig(configPath)
      const result = {
        ok: true,
        config: resolve(configPath),
        vault: config.vault.path,
        canvasUrl: config.canvas.baseUrl,
        tokenEnv: config.canvas.tokenEnv,
        courses: config.courses.allowlist,
      }
      render(
        result,
        options.json,
        `Configuration is valid: ${result.config}\nToken environment variable: ${result.tokenEnv}`,
      )
    })
  configCommand
    .command("show")
    .description("show config fields without environment values")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const configPath = program.opts().config as string
      const config = await loadConfig(configPath)
      const result = {
        config: resolve(configPath),
        version: config.version,
        canvas: { baseUrl: config.canvas.baseUrl, tokenEnv: config.canvas.tokenEnv },
        vault: config.vault.path,
        courses: config.courses.allowlist,
      }
      render(
        result,
        options.json,
        `Config: ${result.config}\nCanvas URL: ${result.canvas.baseUrl}\nToken environment variable: ${result.canvas.tokenEnv}\nVault: ${result.vault}\nAllowlist: ${result.courses.join(", ") || "(empty)"}`,
      )
    })

  registerToolCommands(program)
  registerDogfoodCommand(program)
  registerStudentCommands(program)
  registerMigrationCommand(program)
  registerPreservationCommand(program)
  registerReadingCopyCommands(program)
  registerVaultHistory(program)
  registerObsidianCommand(program)
  return program
}

export async function runCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const jsonRequested = args.includes("--json")
  const program = makeProgram()
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
) {
  await runCli()
}
