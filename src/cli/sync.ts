import type { Command } from "commander"
import { type CanvasClientFactory, createCanvasClient } from "../canvas/client.js"
import {
  CanvasSyncPartialError,
  isCanvasDiscoveryUnavailable,
  listCourses,
  syncCourses,
} from "../canvas/sync.js"
import { selectOnboardingCourses } from "../config/onboarding.js"
import type { ToolkitConfig } from "../shared/types.js"
import { vaultMutation } from "../vault/command-effects.js"
import { inspectWorkspace } from "../vault/workspace.js"
import { configWithEnv, render } from "./output.js"

export function registerSyncCommands(
  program: Command,
  canvasClient: CanvasClientFactory = createCanvasClient,
): void {
  registerSyncCommand(program, canvasClient)
  registerOnboardingCommand(program, canvasClient)
}

async function selectSyncCourses(
  config: ToolkitConfig,
  queries: string[],
  canvasClient: CanvasClientFactory,
): Promise<ToolkitConfig> {
  let selectedConfig = config
  if (queries.length) {
    const allow = new Set(config.courses.allowlist)
    let discovered: Awaited<ReturnType<typeof listCourses>> = []
    if ((queries as string[]).some((query) => !allow.has(query) || !/^[1-9]\d*$/.test(query))) {
      try {
        discovered = await listCourses(config, true, canvasClient(config))
      } catch (error) {
        if (!isCanvasDiscoveryUnavailable(error)) throw error
        const context = await inspectWorkspace(config.vault.path)
        if (
          context.diagnostics.some(
            (diagnostic) => diagnostic.code === "workspace.course_mappings_unavailable",
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
    for (const query of queries as string[]) {
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
  return selectedConfig
}

function registerSyncCommand(program: Command, canvasClient: CanvasClientFactory): void {
  program
    .command("sync")
    .hook("preAction", vaultMutation())
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
    .action(async (options) => {
      const config = await configWithEnv(program.opts().config)
      const selectedConfig = await selectSyncCourses(config, options.course, canvasClient)
      let result: Awaited<ReturnType<typeof syncCourses>>
      try {
        result = await syncCourses(
          selectedConfig,
          {
            preserveSchool: Boolean(options.preserveSchool),
          },
          canvasClient(selectedConfig),
        )
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
          `Partial sync: ${error.report.courses} course(s) synced; ${error.report.failedCourses} failed.\n${error.report.courseReports?.map((course) => `${course.courseId}\t${course.code ?? "unknown code"}\t${course.status}${course.httpStatus ? `\tHTTP ${course.httpStatus}` : ""}`).join("\n")}\nRetry the failed course explicitly; reading-copy refresh was not performed.`,
        )
        return
      }
      render(
        { ...result, refreshMode: "full", fullRequested: Boolean(options.full) },
        options.json,
        `Synced ${result.courses} course(s); wrote ${result.written.length} file(s).${result.notices.length ? `\n${result.notices.join("\n")}` : ""}`,
      )
    })
}

function registerOnboardingCommand(program: Command, canvasClient: CanvasClientFactory): void {
  program
    .command("onboard")
    .hook(
      "preAction",
      vaultMutation((options) => Boolean(options.pilot)),
    )
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
      const result = await selectOnboardingCourses(
        configPath,
        config,
        {
          ids: id ? [id] : options.course,
          allActive: options.allActive,
          pilot: options.pilot,
        },
        canvasClient(config),
      )
      const pilotSync = options.pilot
        ? await syncCourses(
            { ...config, courses: { allowlist: result.selected } },
            {
              ...(result.pilotEligibility?.basis === "assignment-date-span-and-own-feedback"
                ? { unresolvedPilot: result.courses[0] }
                : {}),
              preserveSchool: Boolean(options.preserveSchool),
            },
            canvasClient({ ...config, courses: { allowlist: result.selected } }),
          )
        : undefined
      render(
        { ...result, ...(pilotSync ? { sync: pilotSync } : {}) },
        options.json,
        `Selected ${result.selected.length} course(s):\n${result.courses.map((c) => `${c.id}\t${c.code}\t${c.name}`).join("\n")}${result.warning ? `\n${result.warning}` : ""}`,
      )
    })
}
