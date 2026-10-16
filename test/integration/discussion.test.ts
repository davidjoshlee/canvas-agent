import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { TaskRecord } from "../../src/shared/types.js"
import { completeTask } from "../../src/tasks/artifacts/completion.js"
import { approveTask, reviseTask } from "../../src/tasks/artifacts/lifecycle.js"
import { createAssignmentTask, readTask } from "../../src/tasks/store.js"

const roots: string[] = [],
  prompt = "MBA101/Assignments/Case/prompt.md",
  existing = "MBA101/Assignments/Case/Drafts/01 Assignment Draft.md"
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-discussion-test-"))
  roots.push(root)
  await mkdir(dirname(join(root, existing)), { recursive: true })
  await writeFile(
    join(root, prompt),
    "# Assignment\nDiscuss strategic alternatives.\n## Questions\n1. Which strategic choice is strongest?\n2. How would you implement it?",
  )
  await writeFile(join(root, existing), "Preserved student draft")
  await writeFile(
    join(root, "MBA101/AGENTS.md"),
    "AI discussion assistance is explicitly permitted for this synthetic course.",
  )
  return root
}
async function discussion(
  root: string,
  message = "How should I interpret `missing.pdf` in the prompt?",
) {
  return createAssignmentTask(root, "MBA101", prompt, "discuss", existing, [], undefined, message)
}
async function candidate(
  root: string,
  task: TaskRecord,
  question = task.discussion?.message ?? "",
  cite = prompt,
) {
  const path = join(root, "candidate.md")
  await writeFile(
    path,
    `Task: ${task.id}\n\n## Student question\n${question
      .split("\n")
      .map((line) => `> ${line}`)
      .join(
        "\n",
      )}\n\n## Discussion\nThe supplied prompt asks for strategic alternatives, but the referenced reading is not provided; clarify the missing reading before using its evidence. \`${cite}\`\n\n## Open questions\nThe supplied materials do not include that reading.\n\n## Sources\n- \`${prompt}\`\n`,
  )
  return path
}
afterEach(async () => {
  delete process.env.DISCUSSION_TEST_SECRET
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe("source-bound assignment discussion", () => {
  it("preserves the inquiry, saves separate notes without advancing drafts, and cannot approve/revise a discussion as a draft", async () => {
    const root = await fixture(),
      task = await discussion(root)
    expect(task.questions).toEqual([])
    expect(task.workflow?.instructions.join(" ")).toContain(
      "Do not write or replace a graded draft",
    )
    expect(await readTask(root, task.id)).toMatchObject({
      assignment: { mode: "discuss" },
      discussion: task.discussion,
    })
    const completed = await completeTask(root, task.id, await candidate(root, task))
    expect(completed.output).toContain("01 Assignment Discussion.md")
    expect(await readFile(join(root, existing), "utf8")).toBe("Preserved student draft")
    expect(
      (await readdir(dirname(join(root, existing)))).filter((name) =>
        /Assignment Draft/.test(name),
      ),
    ).toEqual(["01 Assignment Draft.md"])
    await expect(approveTask(root, task.id)).rejects.toThrow(/draft can be approved/)
    await expect(reviseTask(root, task.id, "Rewrite it")).rejects.toThrow(/draft or outline/)
    const next = await discussion(root, "What should I clarify next?")
    expect((await completeTask(root, next.id, await candidate(root, next))).output).toContain(
      "01 Assignment Discussion.v2.md",
    )
  })
  it("rejects changed inquiries and out-of-scope response citations while allowing literal inquiry references", async () => {
    const root = await fixture(),
      task = await discussion(root, "How should I scope this?\n## A literal inquiry heading")
    await expect(
      completeTask(root, task.id, await candidate(root, task, "Changed question")),
    ).rejects.toThrow(/exact blockquoted/)
    await expect(
      completeTask(
        root,
        task.id,
        await candidate(root, task, task.discussion?.message, "OTHER102/reading.md"),
      ),
    ).rejects.toThrow(/not an exact task source/)
    await expect(completeTask(root, task.id, await candidate(root, task))).resolves.toMatchObject({
      task: { status: "completed" },
    })
  })
  it("rejects absent/oversized inquiries, credential input and discussion metadata on other modes before persisting tasks", async () => {
    const root = await fixture()
    for (const message of [undefined, " ", "x".repeat(12_001), "CANVAS_TOKEN=secret-value"])
      await expect(
        createAssignmentTask(root, "MBA101", prompt, "discuss", undefined, [], undefined, message),
      ).rejects.toThrow()
    process.env.DISCUSSION_TEST_SECRET = "known-secret-value"
    await expect(discussion(root, "Question including known-secret-value")).rejects.toThrow(
      /known local credential/,
    )
    await expect(
      createAssignmentTask(
        root,
        "MBA101",
        prompt,
        "draft",
        undefined,
        [],
        undefined,
        "Discuss this",
      ),
    ).rejects.toThrow(/only in discussion/)
    await expect(readdir(join(root, "_meta/tasks"))).rejects.toMatchObject({ code: "ENOENT" })
  })
  it("retains stale-source guards for completed discussions", async () => {
    const root = await fixture(),
      task = await discussion(root)
    await writeFile(join(root, prompt), "Changed assignment requirements.")
    await expect(completeTask(root, task.id, await candidate(root, task))).rejects.toThrow(/stale/)
  })
})
