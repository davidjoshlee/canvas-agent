import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { completeTask } from "../src/completion.js"
import {
  importLegacyAssignment,
  inspectLegacyPrepContext,
  inspectLegacyRun,
  legacyTaskLink,
} from "../src/legacy.js"
import { approveTask } from "../src/lifecycle.js"
import { readTask } from "../src/tasks.js"
import { inspectTask } from "../src/tools.js"

const roots: string[] = [],
  runId = "d354a530-d5ce-4f57-895e-9a01fe0a1f27"
const promptPath = "MBA101/Assignments/Undated - Case analysis/00 Prompt.md"
const workPath = "MBA101/Assignments/Undated - Case analysis/Drafts/Old draft.md"
const provenance = () => ({
  course: {
    code: "F26-MBA-101-01",
    canvas_id: "99",
    canvas_url: "https://canvas.example.edu/courses/99",
  },
  assignment: {
    canvas_id: "22",
    title: "Case analysis",
    slug: "case-analysis",
    canvas_url: "https://canvas.example.edu/courses/99/assignments/22",
    due_at: null,
    group_category_id: null,
  },
  ai_policy: "allowed",
  model_ids: { draft: "old-model", discuss: "old-review-model" },
  source_files: ["Resources/Syllabus.md", "missing.md", "OTHER102/case.md", "../secret"],
  timestamp: "2026-10-01T00:00:00Z",
  version: 1,
  run_id: runId,
})
function draft(
  record: unknown = provenance(),
  metadata = "ai_policy: allowed\nredistribution: allowed",
) {
  return `---\n${metadata}\n---\n<!-- school-agent-provenance\n${JSON.stringify(record)}\n-->\n\nLegacy student work with personal input.\n`
}
async function put(root: string, path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), text)
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-legacy-test-"))
  roots.push(root)
  await put(
    root,
    "MBA101/00 Home.md",
    "---\ncanvas_url: https://canvas.example.edu/courses/99\n---\n# F26-MBA-101-01 - Management\n\n**Course:** F26-MBA-101-01",
  )
  await put(
    root,
    "MBA101/Resources/Syllabus.md",
    "AI draft and review assistance are expressly permitted in this synthetic test course.",
  )
  await put(
    root,
    promptPath,
    "---\ncanvas_id: '22'\ntype: assignments\n---\nAnalyze the case using the supplied evidence.",
  )
  await put(root, workPath, draft())
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("explicit School Agent assignment migration", () => {
  it("inspects prep-log references without claiming historical course or model-run bindings", async () => {
    const root = await fixture(),
      record = {
        runId,
        function: "prepBrief",
        provider: "old-provider",
        model: "old-model",
        sources: [
          { path: "Resources/Syllabus.md", tier: "full-text" },
          { path: "OTHER102/case.md", tier: "summary" },
        ],
        selectionMode: "module",
        selectedModuleCanvasIds: ["100"],
        selectedModuleTitles: ["Synthetic class"],
      }
    const log = JSON.stringify(record)
    await put(root, "_meta/model-context-log.jsonl", `unrelated broken line\n${log}\n${log}\n`)
    const result = await inspectLegacyPrepContext(root, "99", runId)
    expect(result).toMatchObject({
      kind: "legacy-prep-context",
      courseBindingVerified: false,
      historicalSourcesVerified: false,
      modelRunBindingVerified: false,
      selectionMode: "module",
    })
    expect(result.declaredSources).toEqual([
      { path: "MBA101/Resources/Syllabus.md", status: "available-current", tier: "full-text" },
      { status: "outside-course-scope", tier: "summary" },
    ])
    expect(JSON.stringify(result)).not.toContain("old-model")
    expect(await readFile(join(root, "_meta/model-context-log.jsonl"), "utf8")).toBe(
      `unrelated broken line\n${log}\n${log}\n`,
    )
  })
  it("rejects conflicting and unsupported prep records instead of reconstructing guessed context", async () => {
    const root = await fixture(),
      record = {
        runId,
        function: "prepBrief",
        sources: [{ path: "missing.md", tier: "full-text" }],
      }
    await put(
      root,
      "_meta/model-context-log.jsonl",
      `${JSON.stringify(record)}\n${JSON.stringify({ ...record, sources: [] })}\n`,
    )
    await expect(inspectLegacyPrepContext(root, "99", runId)).rejects.toThrow(/conflicting/)
    await put(
      root,
      "_meta/model-context-log.jsonl",
      JSON.stringify({ ...record, function: "assignmentDraft" }),
    )
    await expect(inspectLegacyPrepContext(root, "99", runId)).rejects.toThrow(
      /not a supported prep/,
    )
    await put(
      root,
      "_meta/model-context-log.jsonl",
      JSON.stringify({
        ...record,
        sources: [{ path: "missing.md", tier: "full-text", body: "DO NOT EXPOSE" }],
      }),
    )
    await expect(inspectLegacyPrepContext(root, "99", runId)).rejects.toThrow(
      /not a supported prep/,
    )
    await expect(inspectLegacyPrepContext(root, "99", "../outside")).rejects.toThrow(/UUID/)
  })
  it("inspects historical references without exposing work bodies, reading other courses, or claiming historical hashes", async () => {
    const root = await fixture(),
      before = await readFile(join(root, workPath))
    const result = await inspectLegacyRun(root, "99", runId)
    expect(result).toMatchObject({
      kind: "legacy-assignment",
      status: "historical-unverified",
      work: { path: workPath },
      historicalSourcesVerified: false,
    })
    expect(result.declaredSources).toEqual([
      { path: "MBA101/Resources/Syllabus.md", status: "available-current" },
      { path: "MBA101/missing.md", status: "unavailable" },
      { status: "outside-course-scope" },
      { status: "unsafe-reference" },
    ])
    expect(JSON.stringify(result)).not.toContain("personal input")
    expect(await readFile(join(root, workPath))).toEqual(before)
    await expect(readdir(join(root, "_meta"))).rejects.toMatchObject({ code: "ENOENT" })
  })
  it("creates fresh pending tasks, links captured work, and permits local approval only after a new draft completes", async () => {
    const root = await fixture(),
      original = await readFile(join(root, workPath))
    const { task } = await importLegacyAssignment(root, {
      course: "MBA101",
      runId,
      source: promptPath,
      mode: "draft",
    })
    expect(task.id).not.toBe(runId)
    expect(task.status).toBe("pending")
    expect(task.assignment?.work).toBe(workPath)
    expect(task.parentTaskId).toBeUndefined()
    expect(await readTask(root, task.id)).toMatchObject({ status: "pending" })
    expect((await inspectTask(root, task.id)).legacy).toMatchObject({
      legacyRunId: runId,
      historicalSourcesVerified: false,
    })
    expect(task.sources.map((source) => source.path)).not.toContain("MBA101/missing.md")
    await expect(approveTask(root, runId)).rejects.toThrow()
    await expect(approveTask(root, task.id)).rejects.toThrow(/completed/i)
    const candidate = join(root, "candidate.md")
    await writeFile(
      candidate,
      [
        `Task: ${task.id}`,
        ...task.requirements.map(
          (heading) =>
            `## ${heading}\nA newly authored synthetic response based on supplied evidence. \`${promptPath}\``,
        ),
      ].join("\n\n"),
    )
    await completeTask(root, task.id, candidate)
    const approved = await approveTask(root, task.id)
    expect(await readFile(join(root, approved.output), "utf8")).toContain("newly authored")
    expect(await readFile(join(root, workPath))).toEqual(original)
  })
  it("blocks restricted work, prohibited provenance, course mismatch, wrong run, wrong prompt and cross-course context", async () => {
    const root = await fixture()
    const input = {
      course: "MBA101",
      runId,
      source: promptPath,
      work: workPath,
      mode: "review" as const,
    }
    await put(root, workPath, draft(provenance(), "ai_policy: allowed\nredistribution: restricted"))
    await expect(importLegacyAssignment(root, input)).rejects.toThrow(/restricted/)
    await put(root, workPath, draft({ ...provenance(), ai_policy: "prohibited" }))
    await expect(importLegacyAssignment(root, input)).rejects.toThrow(/AI-prohibited/)
    await put(
      root,
      workPath,
      draft({ ...provenance(), course: { ...provenance().course, canvas_id: "100" } }),
    )
    await expect(importLegacyAssignment(root, input)).rejects.toThrow(/course identity/)
    await put(root, workPath, draft())
    await expect(
      importLegacyAssignment(root, { ...input, runId: "aacb3364-3a08-48cf-990b-44dbbf6b5687" }),
    ).rejects.toThrow(/run ID does not match/)
    await expect(
      importLegacyAssignment(root, { ...input, source: "MBA101/Resources/Syllabus.md" }),
    ).rejects.toThrow(/prompt does not match/)
    await expect(
      importLegacyAssignment(root, { ...input, context: ["OTHER102/case.md"] }),
    ).rejects.toThrow()
    await expect(readdir(join(root, "_meta/tasks"))).rejects.toMatchObject({ code: "ENOENT" })
  })
  it("selects the highest legacy version but requires explicit selection for ties", async () => {
    const root = await fixture(),
      second = workPath.replace("Old draft", "Human revision")
    await put(root, second, draft({ ...provenance(), version: 2 }))
    expect((await inspectLegacyRun(root, "MBA101", runId)).work.path).toBe(second)
    await put(root, workPath, draft({ ...provenance(), version: 2 }))
    await expect(inspectLegacyRun(root, "MBA101", runId)).rejects.toThrow(/ambiguous/)
    expect((await inspectLegacyRun(root, "MBA101", runId, second)).work.path).toBe(second)
  })
  it("rejects malformed/duplicate provenance, credential filenames and symlinked work", async () => {
    const root = await fixture()
    await put(root, workPath, `${draft()}\n${draft()}`)
    await expect(inspectLegacyRun(root, "MBA101", runId, workPath)).rejects.toThrow(/exactly one/)
    await put(root, workPath, "<!-- school-agent-provenance\n{broken\n-->")
    await expect(inspectLegacyRun(root, "MBA101", runId, workPath)).rejects.toThrow(/invalid JSON/)
    const credential = workPath.replace("Old draft.md", "credentials.txt")
    await put(root, credential, draft())
    await expect(inspectLegacyRun(root, "MBA101", runId, credential)).rejects.toThrow(
      /Student work must be readable/,
    )
    const linked = workPath.replace("Old draft.md", "linked.md")
    await symlink(join(root, credential), join(root, linked))
    await expect(inspectLegacyRun(root, "MBA101", runId, linked)).rejects.toThrow()
  })
  it("rejects a spoofed legacy link and reports current-source changes without inventing a historical audit", async () => {
    const root = await fixture()
    const { task } = await importLegacyAssignment(root, {
      course: "99",
      runId,
      source: promptPath,
      work: workPath,
      mode: "review",
    })
    await put(
      root,
      promptPath,
      "---\ncanvas_id: '22'\ntype: assignments\n---\nChanged current prompt.",
    )
    expect((await inspectTask(root, task.id)).snapshots.current).toBe(false)
    const path = join(root, "_meta/tasks", task.id, "legacy.json")
    const stored = JSON.parse(await readFile(path, "utf8"))
    await writeFile(
      path,
      JSON.stringify({ ...stored, legacyRunId: "aacb3364-3a08-48cf-990b-44dbbf6b5687" }),
    )
    await expect(legacyTaskLink(root, task.id)).rejects.toThrow(/captured provenance/)
  })
})
