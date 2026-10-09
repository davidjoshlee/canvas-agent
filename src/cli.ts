#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { lstat, mkdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Command, Option } from "commander"
import { listCourses, syncCourses } from "./canvas.js"
import { completeTask } from "./completion.js"
import { createConfig, loadConfig } from "./config.js"
import { assertNoSymlinks } from "./fs-safety.js"
import { createAssignmentTask, createPrepTask, readTask } from "./tasks.js"
import type { TaskRecord, ToolkitConfig, WorkspaceContext } from "./types.js"
import { inspectWorkspace } from "./workspace.js"

const DEFAULT_CONFIG = "./canvas-agent.config.json"

function summary(task: TaskRecord) {
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    course: task.course,
    week: task.week,
    assignment: task.assignment,
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
        false,
        `Created config: ${value.config}\nVault directory ready: ${value.vault}\nCanvas token will be read from ${value.tokenEnv}.`,
      )
    })

  program
    .command("courses")
    .description("discover readable Canvas courses (sync still requires an allowlist)")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const config = await loadConfig(program.opts().config)
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
    .command("sync")
    .description("sync allowlisted Canvas courses")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const config = await loadConfig(program.opts().config)
      const result = await syncCourses(config)
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
      const config = await loadConfig(program.opts().config)
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
    .description("create a prep task for a course and week")
    .argument("<course>", "course code or title")
    .requiredOption("--week <date>", "Monday in YYYY-MM-DD format")
    .option("--json", "emit JSON")
    .action(async (course, options) => {
      const config = await loadConfig(program.opts().config)
      const task = await createPrepTask(config.vault.path, course, options.week)
      const taskFile = taskMarkdownPath(config, task.id)
      render(
        { ...summary(task), taskFile },
        options.json,
        `Created prep task ${task.id} for ${task.course.code}, week ${task.week}.\nRead: ${taskFile}`,
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
      const config = await loadConfig(program.opts().config)
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

  const task = program.command("task").description("show or complete persisted academic tasks")
  task
    .command("show")
    .description("show a task brief")
    .argument("<id>", "task UUID")
    .option("--json", "emit the full task including approved source snapshots")
    .action(async (id, options) => {
      const config = await loadConfig(program.opts().config)
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
      const config = await loadConfig(program.opts().config)
      const result = await completeTask(config.vault.path, id, options.file)
      render(
        { task: summary(result.task), output: result.output },
        options.json,
        `Completed task ${id}.\nSaved: ${result.output}`,
      )
    })

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
