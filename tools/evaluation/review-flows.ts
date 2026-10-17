import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { expiryStatus, renewalInstructions } from "../../src/auth/credentials.js"
import { assertNoSymlinks } from "../../src/shared/fs-safety.js"
import { approveTask, reviseTask } from "../../src/tasks/artifacts/lifecycle.js"
import { readTask } from "../../src/tasks/artifacts/records.js"
import { createAssignmentTask } from "../../src/tasks/authoring/creation.js"
import { inspectWorkspace, selectCourse } from "../../src/vault/workspace.js"
import {
  type CoreDogfoodInput,
  dogfoodTaskOutcome,
  dogfoodOutcome as outcome,
} from "./core-flows.js"
import type { DogfoodFlow, DogfoodJournal, DogfoodResult } from "./dogfood.js"

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
export interface ReviewDogfoodInput extends CoreDogfoodInput {
  revisionFeedback?: string
  editedWork?: string
  discussionMessage?: string
  approveTaskIds?: string[]
}
const phasePrior = (prior: DogfoodResult | undefined, phase: string): DogfoodResult | undefined =>
  prior
    ? {
        ...prior,
        data: {
          outputHash: prior.data[`${phase}OutputHash`] ?? "",
          humanVerdict: prior.data[`${phase}Verdict`] ?? "",
        },
      }
    : undefined
async function bounded(path: string) {
  await assertNoSymlinks(path)
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size > 10_000) throw new Error("Unsafe dogfood review evidence")
  return readFile(path)
}
export function buildReviewDogfoodFlows(input: ReviewDogfoodInput): DogfoodFlow[] {
  z.array(z.string().uuid())
    .max(100)
    .parse(input.approveTaskIds ?? [])
  const vault = input.config.vault.path
  const feedback =
    input.revisionFeedback ??
    "Dogfood revision: tighten the explanation while preserving supplied student evidence."
  const message = input.discussionMessage ?? "What is the trickiest requirement of this assignment?"
  async function coedit(prior: DogfoodResult | undefined, journal: DogfoodJournal) {
    if (!journal.target.assignment)
      return outcome("co-edit", "skipped", "Prep-only run; no draft selected")
    const draft = journal.flows.find((flow) => flow.name === "draft")
    if (
      !draft?.data.taskId ||
      (await dogfoodTaskOutcome(input, journal, draft.data.taskId, "draft", draft)).status !==
        "pass"
    )
      throw new Error("Co-edit requires the reviewed completed draft")
    const revisionId =
      prior?.data.revisionTaskId ??
      (await reviseTask(vault, draft.data.taskId, feedback, input.editedWork)).id
    const revision = await readTask(vault, revisionId)
    if (
      revision.parentTaskId !== draft.data.taskId ||
      revision.feedback !== feedback ||
      (input.editedWork && !revision.assignment?.context.includes(input.editedWork))
    )
      throw new Error("Revision recipe differs from explicit dogfood inputs")
    const reviewed = await dogfoodTaskOutcome(
      input,
      journal,
      revisionId,
      "co-edit",
      phasePrior(prior, "revision"),
    )
    const data: Record<string, string> = {
      ...(prior?.data ?? {}),
      revisionTaskId: revisionId,
      revisionOutputHash: reviewed.data.outputHash ?? "",
      revisionVerdict: reviewed.data.humanVerdict ?? "",
    }
    if (reviewed.status !== "pass") return { ...reviewed, data: { ...data, ...reviewed.data } }
    const discussionId =
      prior?.data.discussionTaskId ??
      (
        await createAssignmentTask(
          vault,
          revision.course.code,
          revision.assignment?.source ?? "",
          "discuss",
          reviewed.data.output,
          [],
          undefined,
          message,
        )
      ).id
    const discussion = await readTask(vault, discussionId)
    if (
      discussion.discussion?.message !== message.trim().replaceAll("\r\n", "\n") ||
      discussion.assignment?.work !== reviewed.data.output
    )
      throw new Error("Discussion recipe differs from the selected revision/inquiry")
    const discussed = await dogfoodTaskOutcome(
      input,
      journal,
      discussionId,
      "co-edit",
      phasePrior(prior, "discussion"),
      "discuss",
    )
    return {
      ...discussed,
      data: {
        ...data,
        ...discussed.data,
        discussionTaskId: discussionId,
        discussionOutputHash: discussed.data.outputHash ?? "",
        discussionVerdict: discussed.data.humanVerdict ?? "",
      },
    }
  }
  async function approval(prior: DogfoodResult | undefined, journal: DogfoodJournal) {
    if (!journal.target.assignment)
      return outcome("approve", "skipped", "Prep-only run; no draft to approve")
    const edit = journal.flows.find((flow) => flow.name === "co-edit")
    if (!edit?.data.revisionTaskId || (await coedit(edit, journal)).status !== "pass")
      throw new Error("Approval requires validated co-edit evidence")
    const id = edit.data.revisionTaskId,
      receipt = join(vault, "_meta/tasks", id, "approval.json")
    await assertNoSymlinks(receipt, true)
    const exists = await lstat(receipt).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return undefined
    })
    if (prior?.data.output && !exists) throw new Error("Saved approval receipt is missing")
    if (!exists && !input.approveTaskIds?.includes(id))
      return outcome(
        "approve",
        "pending-human",
        "Explicit student direction is required for local approval",
        { taskId: id },
        "Approve this exact revised task only on student direction, then resume.",
      )
    if (exists) await bounded(receipt)
    const approved = await approveTask(vault, id)
    if (!exists) input.onStudentWrite?.()
    const data = { taskId: id, output: approved.output, outputHash: approved.task.outputHash ?? "" }
    if (
      prior?.status === "pass" &&
      (prior.data.output !== data.output || prior.data.outputHash !== data.outputHash)
    )
      throw new Error("Approval evidence changed")
    return outcome("approve", "pass", "Validated local Final copy; never submitted to Canvas", data)
  }
  async function alert(journal: DogfoodJournal) {
    const expiresAt = new Date(Date.parse(journal.startedAt) - 86_400_000).toISOString()
    const status = expiryStatus(expiresAt, new Date(journal.startedAt))
    if (status.renewal !== "expired") throw new Error("Synthetic expiry did not report expired")
    const directory = join(vault, "_meta/dogfood-auth")
    await assertNoSymlinks(directory, true)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, `${journal.id}.json`)
    const content = JSON.stringify({
      version: 1,
      runId: journal.id,
      synthetic: true,
      expiresAt,
      status,
      renewal: renewalInstructions(input.config),
      notification: "local record only; no OS notifier tested",
    })
    await assertNoSymlinks(path, true)
    try {
      await writeFile(path, content, { flag: "wx", mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    if (!(await bounded(path)).equals(Buffer.from(content)))
      throw new Error("Synthetic auth alert changed")
    return outcome(
      "token-renewal alert",
      "pass",
      "Synthetic expiry and local renewal instructions tested; real auth untouched, no OS notification",
      { path: `_meta/dogfood-auth/${journal.id}.json`, hash: hash(content) },
    )
  }
  async function gaps(journal: DogfoodJournal) {
    const course = selectCourse(await inspectWorkspace(vault), journal.target.course)
    const available = new Set(course.sources.map((source) => source.path))
    const gapData = {
      excluded: course.excluded.length,
      empty: course.sources.filter((source) => !source.text.trim()).length,
      missingLinks: course.sources
        .flatMap((source) => source.relatedPaths ?? [])
        .filter((path) => !available.has(path)).length,
    }
    return outcome(
      "gaps re-check",
      "pass",
      "Current local source-gap inventory checked; counts are not proof of complete Canvas coverage",
      Object.fromEntries(
        Object.entries({
          ...gapData,
          fingerprint: hash(JSON.stringify({ excluded: course.excluded, gapData })),
        }).map(([key, value]) => [key, String(value)]),
      ),
    )
  }
  // Preserve the ten-slot journal format without reopening historical billing exports.
  async function cost() {
    return outcome(
      "cost report",
      "skipped",
      "Usage and billing belong to the selected coding host",
      { owner: "host" },
    )
  }
  return [
    {
      name: "co-edit",
      async validate(result, journal) {
        if (
          journal.target.assignment &&
          (!result.data.revisionTaskId || !result.data.discussionTaskId)
        )
          return false
        return (await coedit(result, journal)).status === result.status
      },
      run: coedit,
    },
    {
      name: "approve",
      async validate(result, journal) {
        if (journal.target.assignment && (!result.data.taskId || !result.data.output)) return false
        return (await approval(result, journal)).status === result.status
      },
      run: approval,
    },
    {
      name: "token-renewal alert",
      async validate(result, journal) {
        return (
          hash(await bounded(join(vault, "_meta/dogfood-auth", `${journal.id}.json`))) ===
          result.data.hash
        )
      },
      async run(_prior, journal) {
        return alert(journal)
      },
    },
    {
      name: "gaps re-check",
      async validate(result, journal) {
        return (await gaps(journal)).data.fingerprint === result.data.fingerprint
      },
      async run(_prior, journal) {
        return gaps(journal)
      },
    },
    {
      name: "cost report",
      async validate(result) {
        const checked = await cost()
        return (
          checked.status === result.status &&
          JSON.stringify(checked.data) === JSON.stringify(result.data)
        )
      },
      run: cost,
    },
  ]
}
