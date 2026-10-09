#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { lstat, mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Command, Option } from "commander"
import { listActiveCourses, listCourses, syncCourses, verifyAuth } from "./canvas.js"
import { completeTask } from "./completion.js"
import { createConfig, loadAdjacentEnv, loadConfig, setupConfig } from "./config.js"
import { ingestFile } from "./content.js"
import { assertNoSymlinks } from "./fs-safety.js"
import { doctorChecks, inspectVaultHealth } from "./health.js"
import { approveTask, reviseTask } from "./lifecycle.js"
import { selectOnboardingCourses } from "./onboarding.js"
import { registerStudentCommands } from "./student-cli.js"
import { createAssignmentTask, createPrepTask, readTask } from "./tasks.js"
import { registerToolCommands } from "./tool-cli.js"
import type { TaskRecord, ToolkitConfig, WorkspaceContext } from "./types.js"
import { readUpcoming } from "./upcoming.js"
import { inspectWorkspace, selectCourse } from "./workspace.js"

const DEFAULT_CONFIG = "./canvas-agent.config.json"

function summary(task: TaskRecord) {
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    course: task.course,
    week: task.week,
    period: task.period,
    assignment: task.assignment,
    parentTaskId: task.parentTaskId,
    feedback: task.feedback,
    destination: task.destination,
    requirements: task.requirements,
    workflow: task.workflow,
    sources: task.sources.map((s) => s.path),
    guidance: task.guidance.map((s) => s.path),
    excluded: task.excluded,
    notices: task.notices,
    ...(task.output ? { output: task.output } : {}),
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
    .description("Model-free Canvas workspace and task handoffs")
    .showHelpAfterError(false)
  program.addOption(new Option("--config <path>", "configuration file").default(DEFAULT_CONFIG))

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
    .option("--vault <path>", "vault directory", join(homedir(), "school-vault"))
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
      "--course <id-or-code>",
      "sync one or more allowlisted courses only (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--json", "emit JSON")
    .action(async (options) => {
      const config = await configWithEnv(program.opts().config)
      let selectedConfig = config
      if (options.course.length) {
        const discovered = await listCourses(config)
        const allow = new Set(config.courses.allowlist)
        const selected: string[] = []
        for (const query of options.course as string[]) {
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
      const result = await syncCourses(selectedConfig)
      render(
        result,
        options.json,
        `Synced ${result.courses} course(s); wrote ${result.written.length} file(s).${result.notices.length ? `\n${result.notices.join("\n")}` : ""}`,
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
    .description("create an assignment outline, draft, or review task")
    .argument("<course>", "course code or title")
    .requiredOption("--source <path>", "approved vault-relative assignment prompt")
    .requiredOption("--mode <mode>", "outline, draft, or review")
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
      const query = String(assignmentQuery).trim().toLocaleLowerCase()
      const assignments = course.sources.filter(
        (source) => source.type.toLocaleLowerCase() === "assignment",
      )
      const matches = assignments.filter((source) =>
        [source.path, source.title, source.canvasId].some(
          (value) => value?.toLocaleLowerCase() === query,
        ),
      )
      if (matches.length !== 1) {
        const optionsText = assignments.map(
          (source) => `${source.title} (${source.canvasId ?? source.path})`,
        )
        throw new Error(
          matches.length > 1
            ? `Assignment selector is ambiguous: ${assignmentQuery}`
            : `No assignment prompt matches ${assignmentQuery}${optionsText.length ? `. Available: ${optionsText.join("; ")}` : ""}`,
        )
      }
      const prompt = matches[0]
      if (!prompt) throw new Error(`No assignment prompt matches ${assignmentQuery}`)
      const taskRecord = await createAssignmentTask(
        config.vault.path,
        course.code,
        prompt.path,
        "draft",
        options.work,
        options.context,
      )
      const taskFile = taskMarkdownPath(config, taskRecord.id)
      render(
        { ...summary(taskRecord), taskFile },
        options.json,
        `Created draft task ${taskRecord.id} for ${course.code}: ${prompt.title}.\nRead: ${taskFile}`,
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
        { task: summary(result.task), output: result.output },
        options.json,
        `Approved local draft ${id}.\nCopied to: ${result.output}`,
      )
    })

  const task = program.command("task").description("show or complete persisted academic tasks")
  task
    .command("show")
    .description("show a task brief")
    .argument("<id>", "task UUID")
    .option("--json", "emit the full task including approved source snapshots")
    .action(async (id, options) => {
      const config = await configWithEnv(program.opts().config)
      const record = await readTask(config.vault.path, id)
      const file = taskMarkdownPath(config, id)
      const stat = await lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("Task brief is not a regular file")
      if (options.json) render({ ...record, taskFile: file }, true, "")
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
        `Completed task ${id}.\nSaved: ${result.output}`,
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
      const rows = options.all ? await listCourses(config) : await listActiveCourses(config)
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

  const auth = program.command("auth").description("check Canvas credentials")
  auth
    .command("verify")
    .description("verify configured credentials with a read-only request")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const config = await configWithEnv(program.opts().config)
      const result = await verifyAuth(config)
      render(result, options.json, "Canvas authentication succeeded.")
    })

  auth
    .command("status")
    .description("report local configured token variable presence")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const config = await configWithEnv(program.opts().config)
      const available = Boolean(process.env[config.canvas.tokenEnv])
      const result = { configured: true, tokenEnv: config.canvas.tokenEnv, available }
      render(
        result,
        options.json,
        available
          ? `Configured Canvas token environment variable ${config.canvas.tokenEnv} is available locally.`
          : `Configured Canvas token environment variable ${config.canvas.tokenEnv} is not set.`,
      )
    })

  program
    .command("onboard")
    .description("choose active courses for the sync allowlist")
    .option(
      "--course <id>",
      "active course ID (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--all-active", "explicitly select every active discovered course")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const configPath = program.opts().config as string
      const config = await configWithEnv(configPath)
      const result = await selectOnboardingCourses(configPath, config, {
        ids: options.course,
        allActive: options.allActive,
      })
      render(
        result,
        options.json,
        `Selected ${result.selected.length} course(s):\n${result.courses.map((c) => `${c.id}\t${c.code}\t${c.name}`).join("\n")}${result.warning ? `\n${result.warning}` : ""}`,
      )
    })

  const addSchedule = (
    name: "homework" | "timeline",
    periodOption: "days" | "weeks",
    fallback: number,
  ) => {
    program
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
        const rawCount = String(options[periodOption])
        if (!/^\d+$/.test(rawCount))
          throw new Error(`--${periodOption} must be an integer between 0 and 365`)
        const count = Number(rawCount)
        if (!Number.isSafeInteger(count) || count > 365)
          throw new Error(`--${periodOption} must be between 0 and 365`)
        if (
          options.course &&
          !context.courses.some(
            (course) => course.code.toLocaleLowerCase() === options.course.toLocaleLowerCase(),
          )
        )
          throw new Error(`Unknown course selector: ${options.course}`)
        const result = await readUpcoming(config.vault.path, context, {
          days: periodOption === "weeks" ? count * 7 : count,
          course: options.course,
          includeAnnouncements: name === "timeline",
        })
        const lines = [
          `Upcoming (${result.items.length})`,
          ...result.items.map(
            (item) => `${item.dueAt}\t${item.course}\t${item.title}\t${item.path}`,
          ),
          `Overdue (${result.overdue.length})`,
          ...result.overdue.map(
            (item) => `${item.dueAt}\t${item.course}\t${item.title}\t${item.path}`,
          ),
          `Undated (${result.undated.length})`,
          ...result.undated.map((item) => `${item.course}\t${item.title}\t${item.path}`),
        ]
        render(result, options.json, lines.join("\n"))
      })
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
    .option("--module <id>", "associate extracted text with an existing course module")
    .option("--json", "emit JSON")
    .action(async (file, options) => {
      const config = await configWithEnv(program.opts().config)
      const result = await ingestFile(config.vault.path, options.course, file, options.title, {
        week: options.week,
        module: options.module,
      })
      render(
        result,
        options.json,
        `Copied file: ${result.original}${result.text ? `\nExtracted text: ${result.text}` : ""}${result.notices.length ? `\n${result.notices.join("\n")}` : ""}`,
      )
    })

  program
    .command("vault")
    .description("inspect local vault")
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
  registerStudentCommands(program)
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
    process.stderr.write(
      `${jsonRequested ? `${JSON.stringify({ error: message })}\n` : `Error: ${message}\n`}`,
    )
    process.exitCode = 1
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
) {
  await runCli()
}
