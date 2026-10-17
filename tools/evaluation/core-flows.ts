import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { z } from "zod"
import { syncCourses } from "../../src/canvas/sync.js"
import { assertNoSymlinks } from "../../src/shared/fs-safety.js"
import type { CourseContext, ToolkitConfig } from "../../src/shared/types.js"
import { readUpcoming } from "../../src/student/upcoming.js"
import { completeTask } from "../../src/tasks/artifacts/completion.js"
import { readTask } from "../../src/tasks/artifacts/records.js"
import { createAssignmentTask, createPrepTask } from "../../src/tasks/authoring/creation.js"
import { selectAssignmentPrompt, verifySourceSnapshot } from "../../src/tasks/authoring/recipes.js"
import { inspectWorkspace, selectCourse } from "../../src/vault/workspace.js"
import type { DogfoodFlow, DogfoodJournal, DogfoodResult } from "./dogfood.js"

const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex")
export const dogfoodCourseFingerprint = (course: CourseContext) =>
  hash(
    JSON.stringify({
      code: course.code,
      root: course.root,
      canvasId: course.canvasId,
      sources: course.sources.map(({ path, hash, originalHash }) => ({ path, hash, originalHash })),
      guidance: course.guidance,
      excluded: course.excluded,
    }),
  )
const fingerprint = dogfoodCourseFingerprint
export interface CoreDogfoodInput {
  config: ToolkitConfig
  offline?: boolean
  syncAuthorized?: boolean
  humanVerdicts?: Record<string, "pass" | "fail">
  onStudentWrite?: () => void
  preSynced?: { fingerprint: string; written: number; notices: number }
}
export const dogfoodOutcome = (
  name: DogfoodResult["name"],
  status: DogfoodResult["status"],
  evidence: string,
  data: Record<string, string> = {},
  nextSteps = "",
): DogfoodResult => ({ name, status, evidence, data, nextSteps })
const outcome = dogfoodOutcome
export async function dogfoodTaskOutcome(
  input: CoreDogfoodInput,
  journal: DogfoodJournal,
  taskId: string,
  name: "prep brief" | "draft" | "co-edit",
  prior?: DogfoodResult,
  expectedMode: "draft" | "discuss" = "draft",
) {
  const vault = input.config.vault.path,
    task = await readTask(vault, taskId)
  const course = selectCourse(await inspectWorkspace(vault), journal.target.course)
  if (
    task.course.code !== course.code ||
    task.course.root !== course.root ||
    (name === "prep brief"
      ? task.kind !== "prep" ||
        task.period?.kind !== journal.target.period.kind ||
        task.period.value !== journal.target.period.value
      : task.kind !== "assignment" ||
        task.assignment?.mode !== expectedMode ||
        !journal.target.assignment ||
        task.assignment.source !== selectAssignmentPrompt(course, journal.target.assignment).path)
  )
    throw new Error("Dogfood task scope differs")
  for (const source of [...task.sources, ...task.guidance])
    await verifySourceSnapshot(vault, source)
  const data = { taskId, taskFile: `_meta/tasks/${taskId}/TASK.md` }
  if (task.status === "pending")
    return outcome(
      name,
      "pending-host",
      "Saved pending generation handoff",
      data,
      `Read task show ${taskId}; confirm course permission, author a separate candidate and use task complete. Then resume this dogfood run.`,
    )
  if (!task.output || !task.outputHash) throw new Error("Completed dogfood task lacks output")
  await completeTask(vault, taskId, join(vault, task.output)) // idempotent validation, not generation
  const verdict =
    input.humanVerdicts?.[taskId] ??
    (prior?.data.outputHash === task.outputHash ? prior.data.humanVerdict : undefined)
  return outcome(
    name,
    verdict === "pass" ? "pass" : verdict === "fail" ? "fail" : "pending-human",
    "Completed output structurally verified; academic quality requires explicit human review",
    {
      ...data,
      output: task.output,
      outputHash: task.outputHash,
      ...(verdict ? { humanVerdict: verdict } : {}),
    },
    verdict
      ? ""
      : "Inspect the completed output, sources and missing-input notices; explicitly record the human verdict before continuing.",
  )
}
const taskOutcome = dogfoodTaskOutcome

/** Real first-half workflows. No implicit Canvas access or academic generation. */
export function buildCoreDogfoodFlows(input: CoreDogfoodInput): DogfoodFlow[] {
  if (input.offline && input.syncAuthorized)
    throw new Error("Choose offline or authorized sync, not both")
  z.record(z.string().uuid(), z.enum(["pass", "fail"])).parse(input.humanVerdicts ?? {})
  const vault = input.config.vault.path
  const courseFor = async (journal: DogfoodJournal) =>
    selectCourse(await inspectWorkspace(vault), journal.target.course)
  return [
    {
      name: "sync",
      async validate(result, journal) {
        if (result.status === "skipped" && !input.offline) return false
        return result.data.fingerprint === fingerprint(await courseFor(journal))
      },
      async run(_prior, journal) {
        const course = await courseFor(journal)
        if (input.preSynced) {
          if (input.preSynced.fingerprint !== fingerprint(course))
            throw new Error("Sweep sync evidence changed")
          return outcome("sync", "pass", "Selected course synced once for this sweep", {
            fingerprint: input.preSynced.fingerprint,
            written: String(input.preSynced.written),
            notices: String(input.preSynced.notices),
          })
        }
        if (input.offline)
          return outcome("sync", "skipped", "Explicit offline run; no live sync performed", {
            fingerprint: fingerprint(course),
          })
        if (!input.syncAuthorized)
          return outcome(
            "sync",
            "pending-host",
            "Live sync requires explicit authorization",
            {},
            "Choose an offline run or explicitly authorize sync of the selected allowlisted course.",
          )
        if (!course.canvasId || !input.config.courses.allowlist.includes(course.canvasId))
          throw new Error("Dogfood sync course is not explicitly allowlisted")
        const report = await syncCourses({
          ...input.config,
          courses: { allowlist: [course.canvasId] },
        })
        if (report.courses !== 1)
          throw new Error("Dogfood sync did not return exactly one selected course")
        if (report.written.length) input.onStudentWrite?.()
        return outcome(
          "sync",
          "pass",
          "Selected-course sync completed; inspect notices for source gaps",
          {
            fingerprint: fingerprint(await courseFor(journal)),
            written: String(report.written.length),
            notices: String(report.notices.length),
          },
        )
      },
    },
    {
      name: "timeline",
      async validate(result, journal) {
        const workspace = await inspectWorkspace(vault),
          course = selectCourse(workspace, journal.target.course)
        return (
          result.data.fingerprint ===
          hash(
            JSON.stringify(
              await readUpcoming(vault, workspace, {
                course: course.code,
                includeAnnouncements: true,
              }),
            ),
          )
        )
      },
      async run(_prior, journal) {
        const workspace = await inspectWorkspace(vault),
          course = selectCourse(workspace, journal.target.course)
        const view = await readUpcoming(vault, workspace, {
          course: course.code,
          includeAnnouncements: true,
        })
        return outcome(
          "timeline",
          "pass",
          "Local upcoming/overdue/undated timeline inspected; not a fresh Canvas view",
          {
            fingerprint: hash(JSON.stringify(view)),
            upcoming: String(view.items.length),
            overdue: String(view.overdue.length),
            undated: String(view.undated.length),
          },
        )
      },
    },
    {
      name: "guidance note",
      async validate(result, journal) {
        const path = join(vault, "_meta/dogfood-notes", `${journal.id}.md`)
        await assertNoSymlinks(path)
        const stat = await lstat(path)
        if (!stat.isFile() || stat.size > 5000) throw new Error("Unsafe dogfood note")
        return result.data.hash === hash(await readFile(path))
      },
      async run(_prior, journal) {
        const course = await courseFor(journal),
          directory = join(vault, "_meta/dogfood-notes")
        await assertNoSymlinks(directory, true)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const path = join(directory, `${journal.id}.md`)
        const content = `# Dogfood operational note\n\nRun: ${journal.id}\nCourse: ${course.code}\nThis is a private workflow roundtrip, not active course guidance, AI-use permission or student work.\n`
        await assertNoSymlinks(path, true)
        try {
          await writeFile(path, content, { flag: "wx", mode: 0o600 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        }
        await assertNoSymlinks(path)
        const stat = await lstat(path)
        if (!stat.isFile() || stat.size > 5000 || (await readFile(path, "utf8")) !== content)
          throw new Error("Dogfood note differs from its owned content")
        return outcome(
          "guidance note",
          "pass",
          "Private operational note preserved; active guidance untouched",
          { path: relative(vault, path), hash: hash(content) },
        )
      },
    },
    {
      name: "prep brief",
      async validate(result, journal) {
        return (
          (await taskOutcome(input, journal, result.data.taskId ?? "", "prep brief", result))
            .status === "pass"
        )
      },
      async run(prior, journal) {
        const taskId =
          prior?.data.taskId ??
          (
            await createPrepTask(
              vault,
              journal.target.course,
              journal.target.period.kind === "week" ? journal.target.period.value : undefined,
              journal.target.period.kind === "session"
                ? { session: journal.target.period.value }
                : {},
            )
          ).id
        return taskOutcome(input, journal, taskId, "prep brief", prior)
      },
    },
    {
      name: "draft",
      async validate(result, journal) {
        if (!journal.target.assignment) return result.status === "skipped"
        return (
          (await taskOutcome(input, journal, result.data.taskId ?? "", "draft", result)).status ===
          "pass"
        )
      },
      async run(prior, journal) {
        if (!journal.target.assignment)
          return outcome("draft", "skipped", "No assignment explicitly selected; prep-only run")
        const course = await courseFor(journal),
          prompt = selectAssignmentPrompt(course, journal.target.assignment)
        const taskId =
          prior?.data.taskId ??
          (
            await createAssignmentTask(vault, {
              courseQuery: course.code,
              sourcePath: prompt.path,
              mode: "draft",
            })
          ).id
        return taskOutcome(input, journal, taskId, "draft", prior)
      },
    },
  ]
}
