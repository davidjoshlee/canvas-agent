import { mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { Command } from "commander"
import { type CanvasClientFactory, createCanvasClient } from "../canvas/client.js"
import { listActiveCourses, listCourses } from "../canvas/sync.js"
import { createConfig, loadConfig, setupConfig } from "../config/index.js"
import { assertNoSymlinks } from "../shared/fs-safety.js"
import { discoverInstructions } from "./instructions.js"
import { configWithEnv, render } from "./output.js"

export function registerSetupCommands(
  program: Command,
  canvasClient: CanvasClientFactory = createCanvasClient,
): void {
  program
    .command("instructions")
    .description(
      "locate this installation's agent instructions without config, credentials or vault access",
    )
    .option("--topic <text>", "read matching installed CLI paragraphs (literal, case-insensitive)")
    .option("--page <number>", "topic result page (requires --topic)")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const page = options.page === undefined ? undefined : Number(options.page)
      if (options.page !== undefined && !/^[1-9]\d*$/.test(options.page))
        throw new Error("Instruction page must be a positive integer")
      const result = await discoverInstructions(undefined, options.topic, page)
      const human = result.lookup
        ? `${result.lookup.excerpts.map((part) => `${part.heading} (lines ${part.startLine}–${part.endLine})\n${part.text}`).join("\n\n")}\n\nPage ${result.lookup.page} of ${result.lookup.totalPages}.${result.lookup.hasMore ? ` Continue with --page ${result.lookup.nextPage} and the same --topic.` : ""}\n${result.lookup.note}`
        : `Canvas Agent ${result.packageVersion} instructions\n${result.files.map((file) => `${file.id}: ${file.path}`).join("\n")}\n${result.note}`
      render(
        result,
        options.json,
        [human, ...result.warnings.map((warning) => `Warning: ${warning}`)].join("\n"),
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
      const courses = await listCourses(config, false, canvasClient(config))
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

  const courses = program.commands.find((candidate) => candidate.name() === "courses")
  if (!courses) throw new Error("Courses command was not registered")
  courses
    .command("list")
    .description("list discovered active Canvas courses")
    .option("--all", "include inactive courses")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const config = await configWithEnv(program.opts().config)
      const rows = options.all
        ? await listCourses(config, true, canvasClient(config))
        : await listActiveCourses(config, canvasClient(config))
      render(
        rows,
        options.json || courses.opts().json,
        rows.length
          ? rows.map((c) => `${c.id}\t${c.code}\t${c.name}`).join("\n")
          : "No readable courses.",
      )
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
}
