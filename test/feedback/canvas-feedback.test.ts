import { spawnSync } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { syncCourses as syncCanvasCourses } from "../../src/canvas/sync.js"
import { captureSimulation } from "../../src/evaluation/captures.js"
import { createSimulationTask, readSimulationTask } from "../../src/evaluation/tasks.js"
import {
  feedbackDirectory,
  feedbackHash,
  feedbackSnapshot,
  learningHistoryInstruction,
  nextFeedbackSnapshot,
  normalizeOwnFeedback,
  readCoursePlaybook,
  readOwnFeedback,
} from "../../src/feedback/history.js"
import { completeTask, readVerifiedCompletedOutput } from "../../src/tasks/completion.js"
import { createAssignmentTask, createPrepTask, readTask } from "../../src/tasks/store.js"
import { inspectTask, reviewGate } from "../../src/tasks/tools.js"
import { createReadingCopy, planReadingCopy } from "../../src/vault/reading-copy.js"
import { inspectWorkspace } from "../../src/vault/workspace.js"
import { type CanvasFetch, createCanvasTestTransport } from "../helpers/canvas-client.js"

const roots: string[] = []
const canvasTransport = createCanvasTestTransport()
const syncCourses = (...args: Parameters<typeof syncCanvasCourses>) =>
  syncCanvasCourses(args[0], args[1], canvasTransport.client(args[0]))
function useCanvasFetch(fetch?: CanvasFetch): void {
  canvasTransport.use(fetch ? { fetch } : {})
}
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "canvas-feedback-"))
  roots.push(base)
  const vault = join(base, "vault")
  process.env.CANVAS_FEEDBACK_FIXTURE_TOKEN = "synthetic-token"
  let response: unknown = {
    assignment_id: 50,
    score: 83.5,
    grade: "B",
    graded_at: "2026-10-12T08:00:00Z",
    body: "PRIVATE_SUBMITTED_WORK",
    attachments: [{ url: "PRIVATE_ATTACHMENT" }],
    submission_history: [{ body: "PRIVATE_HISTORY" }],
    user_id: 99,
    submission_comments: [
      {
        comment: "PRIVATE_FEEDBACK_COMMENT: ground your conclusion.",
        author_id: 99,
        author_name: "PRIVATE_AUTHOR_NAME",
        created_at: "2026-10-12T08:00:00Z",
      },
    ],
    rubric_assessment: {
      evidence: { points: 8, comments: "PRIVATE_RUBRIC_COMMENT", rating_id: "ignored" },
    },
  }
  let feedbackStatus: number | undefined
  let feedbackBody: Response | undefined
  const originalResponse = structuredClone(response)
  const calls: string[] = []
  useCanvasFetch(async (input, init) => {
    expect(init?.method).toBe("GET")
    const url = new URL(String(input)),
      path = url.pathname
    calls.push(path)
    if (path === "/api/v1/users/self") return json({ id: 99, name: "Synthetic student" })
    const course = { id: 1, course_code: "CS101", name: "Synthetic feedback course" }
    if (path === "/api/v1/courses") return json([course])
    if (path === "/api/v1/courses/1") return json(course)
    if (path.endsWith("/assignments"))
      return json([{ id: 50, name: "Case", description: "Synthetic assignment requirements." }])
    if (path.endsWith("/submissions/self")) {
      expect(path).toBe("/api/v1/courses/1/assignments/50/submissions/self")
      expect(url.searchParams.getAll("include[]")).toEqual([
        "rubric_assessment",
        "submission_comments",
      ])
      return feedbackStatus
        ? new Response("PRIVATE_ERROR_BODY", { status: feedbackStatus })
        : (feedbackBody ?? json(response))
    }
    if (/\/(quizzes|files|pages|modules|discussion_topics)$/.test(path)) return json([])
    throw new Error(`Unexpected synthetic GET ${path}`)
  })
  const config = {
    version: 1 as const,
    canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "CANVAS_FEEDBACK_FIXTURE_TOKEN" },
    vault: { path: vault },
    courses: { allowlist: ["1"] },
  }
  return {
    base,
    vault,
    config,
    calls,
    originalResponse,
    setBody: (body: Response) => {
      feedbackBody = body
    },
    setResponse: (value: unknown) => {
      response = value
    },
    setStatus: (status: number) => {
      feedbackStatus = status
    },
  }
}
afterEach(async () => {
  vi.useRealTimers()
  canvasTransport.reset()
  delete process.env.CANVAS_FEEDBACK_FIXTURE_TOKEN
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("private own-feedback parity", () => {
  it("reads exact assignment scope beyond the whole-course inventory cap without touching unrelated caches", async () => {
    const f = await fixture()
    await syncCourses(f.config)
    const directory = join(f.vault, "_meta/canvas-feedback/1")
    await Promise.all(
      Array.from({ length: 1000 }, (_, index) =>
        mkdir(join(directory, String(index + 1000)), { mode: 0o700 }),
      ),
    )
    await symlink(join(f.base, "absent-private-cache"), join(directory, "60"))
    const scoped = await readCoursePlaybook(f.vault, "CS101", ["50", "50"])
    expect(scoped.history.records).toHaveLength(1)
    expect(scoped.history.records[0]?.assignmentId).toBe("50")
    await expect(readCoursePlaybook(f.vault, "CS101")).rejects.toThrow(/inventory exceeds bounds/)
    await expect(readCoursePlaybook(f.vault, "CS101", ["60"])).rejects.toThrow(/symbolic links/i)
    await expect(readCoursePlaybook(f.vault, "CS101", ["999"])).rejects.toThrow(/no known cache/)
    await expect(readCoursePlaybook(f.vault, "CS101", ["../50"])).rejects.toThrow()
    await expect(
      readCoursePlaybook(
        f.vault,
        "CS101",
        Array.from({ length: 501 }, (_, i) => String(i + 1)),
      ),
    ).rejects.toThrow(/selected assignment scope exceeds bounds/)
    const config = join(f.base, "config.json")
    await writeFile(config, JSON.stringify(f.config))
    const result = spawnSync(
      process.execPath,
      [
        resolve("dist/cli.js"),
        "playbook",
        "CS101",
        "--assignment",
        "50",
        "--config",
        config,
        "--json",
      ],
      { encoding: "utf8" },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).history.records).toHaveLength(1)
  })
  it("journals A-B-A observations without duplicate unchanged events and carries them into private task context", async () => {
    const f = await fixture()
    await syncCourses(f.config)
    const first = await readOwnFeedback(f.vault, "CS101", "50")
    await syncCourses(f.config)
    expect((await readOwnFeedback(f.vault, "CS101", "50")).observations).toHaveLength(1)
    f.setResponse({ assignment_id: 50, score: 90 })
    await syncCourses(f.config)
    f.setResponse(f.originalResponse)
    await syncCourses(f.config)
    const current = await readOwnFeedback(f.vault, "CS101", "50")
    expect(current.observations?.map((event) => event.sequence)).toEqual([1, 2, 3])
    expect(current.observations?.map((event) => event.kind)).toEqual([
      "baseline-observed",
      "changed-value",
      "changed-value",
    ])
    expect(current.observations?.[0]?.dataHash).toBe(first.dataHash)
    expect(current.observations?.[2]?.dataHash).toBe(first.dataHash)
    const book = await readCoursePlaybook(f.vault, "CS101")
    expect(book.history.records).toHaveLength(2)
    expect(book.history.observations).toHaveLength(3)
    const task = await createAssignmentTask(
      f.vault,
      "CS101",
      "CS101/Canvas/Assignments/Case-50.md",
      "outline",
    )
    expect(task.learningHistory?.observations).toEqual(book.history.observations)
    expect((await readTask(f.vault, task.id)).learningHistory?.hash).toBe(
      task.learningHistory?.hash,
    )
    const old = feedbackSnapshot(normalizeOwnFeedback(f.originalResponse, "1", "50"))
    const bytes = JSON.stringify(old)
    const next = nextFeedbackSnapshot(
      normalizeOwnFeedback({ assignment_id: 50, score: 90 }, "1", "50"),
      old,
    )
    expect(next.observations).toHaveLength(1)
    expect(next.observations?.[0]?.kind).toBe("baseline-observed")
    expect(JSON.stringify(old)).toBe(bytes)
  })
  it("rejects changed observation sequences/tails and missing older archives without rewriting the current pointer", async () => {
    const f = await fixture()
    await syncCourses(f.config)
    const first = await readOwnFeedback(f.vault, "CS101", "50")
    f.setResponse({ assignment_id: 50, score: 90 })
    await syncCourses(f.config)
    const directory = feedbackDirectory(f.vault, "1", "50"),
      path = join(directory, "current.json")
    const bytes = await readFile(path),
      original = JSON.parse(bytes.toString())
    for (const mutation of ["sequence", "tail"]) {
      const value = structuredClone(original)
      if (mutation === "sequence") value.observations[1].sequence = 99
      else value.observations[1].dataHash = first.dataHash
      await writeFile(path, JSON.stringify(value))
      await expect(readOwnFeedback(f.vault, "CS101", "50")).rejects.toThrow(
        /Invalid feedback snapshot/,
      )
    }
    await writeFile(path, bytes)
    await writeFile(
      join(directory, `${first.dataHash}.json`),
      '{"private":"changed older archive"}',
    )
    await expect(readOwnFeedback(f.vault, "CS101", "50")).rejects.toThrow(/archival binding/)
    await expect(syncCourses(f.config)).rejects.toThrow(/archival binding/)
    expect(await readFile(path)).toEqual(bytes)
  })
  it("accumulates retained values with unknown historical times, honors explicit scope and exposes a private compiled playbook", async () => {
    const f = await fixture()
    await syncCourses(f.config)
    f.setResponse({
      assignment_id: 50,
      score: 90,
      submission_comments: [{ comment: "PRIVATE_NEW_LESSON" }],
    })
    await syncCourses(f.config)
    const directory = feedbackDirectory(f.vault, "1", "60")
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const other = normalizeOwnFeedback({ assignment_id: 60, score: 1 }, "1", "60"),
      hash = feedbackHash(other)
    await writeFile(join(directory, `${hash}.json`), JSON.stringify(other), { mode: 0o600 })
    await writeFile(join(directory, "current.json"), JSON.stringify(feedbackSnapshot(other)), {
      mode: 0o600,
    })
    const all = await readCoursePlaybook(f.vault, "CS101")
    expect(all.history.records).toHaveLength(3)
    expect(
      all.history.records.filter(
        (record) => record.assignmentId === "50" && !record.currentAtCapture,
      )[0]?.checkedAt,
    ).toBeNull()
    const scoped = await readCoursePlaybook(f.vault, "CS101", ["50"])
    expect(scoped.history.records).toHaveLength(2)
    expect(scoped.history.records.every((record) => record.assignmentId === "50")).toBe(true)
    await expect(readCoursePlaybook(f.vault, "CS101", ["99"])).rejects.toThrow(/no known cache/)
    await writeFile(join(directory, "current.json"), "PRIVATE_OTHER_CACHE_INVALID")
    expect((await readCoursePlaybook(f.vault, "CS101", ["50"])).history.records).toHaveLength(2)
    const config = join(f.base, "config.json")
    await writeFile(config, JSON.stringify(f.config))
    const result = spawnSync(
      process.execPath,
      [
        resolve("dist/cli.js"),
        "playbook",
        "CS101",
        "--assignment",
        "50",
        "--config",
        config,
        "--json",
      ],
      { encoding: "utf8" },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).history.records).toHaveLength(2)
  })
  it("captures private learning context in new tasks, freezes it and never enriches fixed replays or old tasks", async () => {
    const f = await fixture()
    await syncCourses(f.config)
    await mkdir(join(f.vault, "CS101/Week 1 - Oct 5"), { recursive: true })
    await writeFile(
      join(f.vault, "CS101/Week 1 - Oct 5/reading.md"),
      '---\navailable_at: "2026-10-05"\n---\nSubstantive synthetic framework reading, not personal feedback.',
    )
    const prep = await createPrepTask(f.vault, "CS101", "2026-10-05")
    const assignment = await createAssignmentTask(
      f.vault,
      "CS101",
      "CS101/Canvas/Assignments/Case-50.md",
      "outline",
    )
    for (const task of [prep, assignment]) {
      expect(task.learningHistory?.records[0]?.data.comments[0]?.text).toContain(
        "PRIVATE_FEEDBACK_COMMENT",
      )
      expect(task.workflow?.instructions).toContain(learningHistoryInstruction)
      expect(task.sources.some((source) => source.text.includes("PRIVATE_FEEDBACK"))).toBe(false)
      expect((await readTask(f.vault, task.id)).learningHistory).toEqual(task.learningHistory)
    }
    const capture = await captureSimulation(f.vault, "CS101", "2026-10-05")
    const frozen = await createSimulationTask(f.vault, capture.id, {
      kind: "prep",
      week: "2026-10-05",
    })
    expect((await readSimulationTask(f.vault, frozen.id)).task.learningHistory).toBeUndefined()
    f.setResponse({
      assignment_id: 50,
      score: 95,
      submission_comments: [{ comment: "PRIVATE_NEW_LESSON" }],
    })
    await syncCourses(f.config)
    expect((await readTask(f.vault, assignment.id)).learningHistory?.hash).toBe(
      assignment.learningHistory?.hash,
    )
    const candidate = join(f.base, "candidate.md")
    await writeFile(
      candidate,
      [
        `Task: ${assignment.id}`,
        ...assignment.requirements.map(
          (heading) =>
            `## ${heading}\n${heading === "Sources" ? "`CS101/Canvas/Assignments/Case-50.md`" : "Synthetic structural fixture only."}`,
        ),
      ].join("\n\n"),
    )
    await completeTask(f.vault, assignment.id, candidate)
    const inspection = await inspectTask(f.vault, assignment.id)
    expect(inspection.learningHistory?.archiveBindingsVerified).toBe(true)
    expect(JSON.stringify(inspection)).not.toContain("PRIVATE_FEEDBACK_COMMENT")
    const old = structuredClone(prep)
    delete old.learningHistory
    if (old.workflow)
      old.workflow.instructions = old.workflow.instructions.filter(
        (instruction) => instruction !== learningHistoryInstruction,
      )
    const path = join(f.vault, "_meta/tasks", old.id, "task.json")
    await writeFile(path, JSON.stringify(old))
    const bytes = await readFile(path)
    expect((await readTask(f.vault, old.id)).learningHistory).toBeUndefined()
    expect(await readFile(path)).toEqual(bytes)
    const archive = join(
      feedbackDirectory(f.vault, "1", "50"),
      `${assignment.learningHistory?.records[0]?.dataHash}.json`,
    )
    await writeFile(archive, '{"private":"tampered"}')
    await expect(readVerifiedCompletedOutput(f.vault, assignment.id)).rejects.toThrow(
      /archival binding/,
    )
    await expect(inspectTask(f.vault, assignment.id)).rejects.toThrow(/archival binding/)
    await expect(reviewGate(f.config, assignment.id)).rejects.toThrow(/archival binding/)
    await expect(createPrepTask(f.vault, "CS101", "2026-10-05")).rejects.toThrow(/archival binding/)
  })
  it("cancels a stalled private response at the body deadline without saving partial feedback", async () => {
    const f = await fixture()
    let entered: (() => void) | undefined
    const reading = new Promise<void>((resolve) => {
      entered = resolve
    })
    let first = true
    const cancelled = vi.fn()
    f.setBody(
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (first) {
                first = false
                controller.enqueue(
                  new TextEncoder().encode('{"assignment_id":50,"PRIVATE_PARTIAL":'),
                )
                entered?.()
              }
            },
            cancel: cancelled,
          },
          { highWaterMark: 0 },
        ),
      ),
    )
    vi.useFakeTimers()
    const pending = syncCourses(f.config)
    const rejected = expect(pending).rejects.toThrow(/body timed out/)
    await reading
    await vi.advanceTimersByTimeAsync(10_001)
    await rejected
    expect(cancelled).toHaveBeenCalled()
    await expect(readdir(feedbackDirectory(f.vault, "1", "50"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
  it("syncs minimal self feedback, keeps private permissions and excludes work/history/identities and reading copies", async () => {
    const f = await fixture()
    const synced = await syncCourses(f.config)
    expect(JSON.stringify(synced)).not.toContain("PRIVATE_FEEDBACK")
    const result = await readOwnFeedback(f.vault, "CS101", "50")
    expect(result.status).toBe("feedback-recorded")
    expect(result.feedback.score).toBe(83.5)
    expect(result.feedback.comments[0]?.text).toContain("PRIVATE_FEEDBACK_COMMENT")
    expect(result.feedback.rubric[0]?.comments).toBe("PRIVATE_RUBRIC_COMMENT")
    const directory = feedbackDirectory(f.vault, "1", "50")
    expect((await stat(directory)).mode & 0o077).toBe(0)
    for (const file of await readdir(directory)) {
      expect((await stat(join(directory, file))).mode & 0o077).toBe(0)
      expect(await readFile(join(directory, file), "utf8")).not.toMatch(
        /PRIVATE_SUBMITTED_WORK|PRIVATE_ATTACHMENT|PRIVATE_HISTORY|PRIVATE_AUTHOR_NAME|user_id|author_id/,
      )
    }
    expect(JSON.stringify(await inspectWorkspace(f.vault))).not.toContain("PRIVATE_FEEDBACK")
    const destination = join(f.base, "phone")
    expect(JSON.stringify((await planReadingCopy(f.vault, destination)).files)).not.toContain(
      "canvas-feedback",
    )
    await createReadingCopy(f.vault, destination)
    await expect(readOwnFeedback(f.vault, "OTHER101", "50")).rejects.toThrow()
    await expect(readOwnFeedback(f.vault, "CS101", "../50")).rejects.toThrow()
  })

  it("retains older versions, follows a reverted current value, and preserves manually edited cache files", async () => {
    const f = await fixture()
    await syncCourses(f.config)
    const first = await readOwnFeedback(f.vault, "CS101", "50")
    const firstArchive = join(feedbackDirectory(f.vault, "1", "50"), `${first.dataHash}.json`)
    const before = await readFile(firstArchive)
    f.setResponse({ assignment_id: 50, score: 90, grade: "A" })
    await syncCourses(f.config)
    expect((await readOwnFeedback(f.vault, "CS101", "50")).feedback.score).toBe(90)
    expect(await readFile(firstArchive)).toEqual(before)
    f.setResponse(f.originalResponse)
    await syncCourses(f.config)
    expect((await readOwnFeedback(f.vault, "CS101", "50")).dataHash).toBe(first.dataHash)
    f.setResponse({ assignment_id: 50 })
    await syncCourses(f.config)
    expect((await readOwnFeedback(f.vault, "CS101", "50")).status).toBe("no-feedback-recorded")
    const current = join(feedbackDirectory(f.vault, "1", "50"), "current.json")
    const edited = "PRIVATE_USER_EDIT"
    await writeFile(current, edited)
    await expect(syncCourses(f.config)).rejects.toThrow(/invalid JSON/)
    expect(await readFile(current, "utf8")).toBe(edited)
    await expect(readOwnFeedback(f.vault, "CS101", "50")).rejects.toThrow(/invalid JSON/)
  })

  it("rejects mismatched/private malformed responses without body echo, and separates permission gaps from auth loss", async () => {
    const f = await fixture()
    f.setResponse({ assignment_id: 99, score: "PRIVATE_BAD_SCORE" })
    await expect(syncCourses(f.config)).rejects.toThrow(/identity or payload/)
    f.setStatus(403)
    const partial = await syncCourses(f.config)
    expect(partial.notices.some((notice) => /Own feedback unavailable/.test(notice))).toBe(true)
    expect(JSON.stringify(partial)).not.toContain("PRIVATE_ERROR_BODY")
    f.setStatus(401)
    await expect(syncCourses(f.config)).rejects.toThrow(/HTTP 401/)
    expect(() =>
      normalizeOwnFeedback(
        { assignment_id: 50, submission_comments: Array(101).fill({ comment: "private" }) },
        "1",
        "50",
      ),
    ).toThrow(/payload/)
  })

  it("rejects changed archives, exposed permissions and symlinks without replacing saved evidence", async () => {
    const f = await fixture()
    await syncCourses(f.config)
    const result = await readOwnFeedback(f.vault, "CS101", "50")
    const directory = feedbackDirectory(f.vault, "1", "50"),
      archive = join(directory, `${result.dataHash}.json`),
      current = join(directory, "current.json")
    const bytes = await readFile(archive)
    await writeFile(archive, '{"private":"changed"}')
    await expect(readOwnFeedback(f.vault, "CS101", "50")).rejects.toThrow(/archival binding/)
    const pointer = await readFile(current)
    await expect(syncCourses(f.config)).rejects.toThrow(/archival binding/)
    expect(await readFile(current)).toEqual(pointer)
    await writeFile(archive, bytes)
    await chmod(current, 0o644)
    await expect(readOwnFeedback(f.vault, "CS101", "50")).rejects.toThrow(/private regular file/)
    await chmod(current, 0o600)
    await rm(current)
    await symlink(archive, current)
    await expect(readOwnFeedback(f.vault, "CS101", "50")).rejects.toThrow(/Symbolic links/)
  })

  it("reads explicit private feedback through the compiled CLI and rejects malformed cache without echoing it", async () => {
    const f = await fixture()
    await syncCourses(f.config)
    const config = join(f.base, "config.json")
    await writeFile(config, JSON.stringify(f.config))
    const cli = () =>
      spawnSync(
        process.execPath,
        [
          resolve("dist/cli.js"),
          "feedback",
          "CS101",
          "--assignment",
          "50",
          "--config",
          config,
          "--json",
        ],
        { encoding: "utf8" },
      )
    const valid = cli()
    expect(valid.status, valid.stderr).toBe(0)
    expect(JSON.parse(valid.stdout).feedback.score).toBe(83.5)
    await writeFile(
      join(feedbackDirectory(f.vault, "1", "50"), "current.json"),
      '{"PRIVATE_MALFORMED_BODY":',
    )
    const invalid = cli()
    expect(invalid.status).not.toBe(0)
    expect(invalid.stderr + invalid.stdout).not.toContain("PRIVATE_MALFORMED_BODY")
  })
})
