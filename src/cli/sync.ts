import type { Command } from "commander"
import { writeAuthAlert } from "../auth/alerts.js"
import {
  CanvasSyncPartialError,
  isCanvasDiscoveryUnavailable,
  listCourses,
  syncCourses,
} from "../canvas/sync.js"
import { selectOnboardingCourses } from "../config/onboarding.js"
import { inspectWorkspace } from "../vault/workspace.js"
import { configWithEnv, render } from "./output.js"

export function registerSyncCommands(program: Command): void {
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
}
