import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { withHomeworkDraftStatus } from "../../src/student/homework-status.js"
import { collectUpcoming } from "../../src/student/upcoming.js"
import { completeTask } from "../../src/tasks/artifacts/completion.js"
import { createAssignmentTask } from "../../src/tasks/store.js"
import { inspectWorkspace } from "../../src/vault/workspace.js"

const roots: string[] = []
async function fixture(titles: string[]) {
  const root = await mkdtemp(join(tmpdir(), "canvas-homework-status-"))
  roots.push(root)
  await mkdir(join(root, "CS101/Assignments"), { recursive: true })
  const paths = titles.map((_, index) => `CS101/Assignments/prompt-${index}.md`)
  for (const [index, title] of titles.entries())
    await writeFile(
      join(root, `CS101/Assignments/prompt-${index}.md`),
      `---\ntype: assignment\ncanvas_id: "${index + 1}"\ntitle: ${JSON.stringify(title)}\n---\n\n# ${title}\n\nSynthetic framework requirements, no graded student work.`,
    )
  const status = async () => {
    const context = await inspectWorkspace(root)
    return withHomeworkDraftStatus(root, context, collectUpcoming(context))
  }
  return { root, paths, status }
}
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

it("associates completed draft versions by exact prompt even when prompts share a Drafts folder, without claiming content verification", async () => {
  const f = await fixture(["First case", "Second case"])
  const originals = await Promise.all(f.paths.map((path) => readFile(join(f.root, path))))
  for (const path of f.paths) {
    const task = await createAssignmentTask(f.root, "CS101", path, "draft")
    const candidate = join(f.root, "candidate.md")
    await writeFile(
      candidate,
      [
        `Task: ${task.id}`,
        ...task.requirements.map(
          (heading) =>
            `## ${heading}\n\n${heading === "Sources" ? `\`${path}\`` : "Synthetic structural fixture only."}`,
        ),
      ].join("\n\n"),
    )
    await completeTask(f.root, task.id, candidate)
    await rm(candidate)
  }
  const result = await f.status()
  expect(result.undated.map((row) => row.draftVersion)).toEqual([1, 2])
  expect(
    result.undated.every(
      (row) => row.draftBinding === "task-metadata" && row.draftContentsVerified === false,
    ),
  ).toBe(true)
  const path = result.undated[0]?.draftPaths[0]
  if (!path) throw new Error("Synthetic draft path missing")
  await writeFile(join(f.root, path), "PRIVATE_CHANGED_DRAFT_BODY")
  expect((await f.status()).undated[0]?.draftVersion).toBe(1)
  expect(JSON.stringify(await f.status())).not.toContain("PRIVATE_CHANGED_DRAFT_BODY")
  expect(await Promise.all(f.paths.map((path) => readFile(join(f.root, path))))).toEqual(originals)
})

it("reports School-style legacy base/highest versions, excluding review/final/other-course and malformed filenames", async () => {
  const f = await fixture(["Résumé case"])
  await mkdir(join(f.root, "CS101/Drafts"))
  await mkdir(join(f.root, "OTHER101/Drafts"), { recursive: true })
  for (const path of [
    "CS101/Drafts/resume-case.md",
    "CS101/Drafts/resume-case.v4.md",
    "CS101/Drafts/resume-case.v03.md",
    "CS101/Drafts/resume-case.review.md",
    "OTHER101/Drafts/resume-case.v9.md",
  ])
    await writeFile(join(f.root, path), "PRIVATE_LEGACY_DRAFT_BODY")
  const result = await f.status()
  expect(result.undated[0]).toMatchObject({
    draftVersion: 4,
    draftBinding: "legacy-filename",
    draftContentsVerified: false,
    draftPaths: ["CS101/Drafts/resume-case.md", "CS101/Drafts/resume-case.v4.md"],
  })
  expect(JSON.stringify(result)).not.toContain("PRIVATE_LEGACY_DRAFT_BODY")
})

it("reports preserved-namespace drafts from their saved destinations without losing older drafts or crossing prompts", async () => {
  const f = await fixture(["First case", "Second case"])
  const originals = await Promise.all(f.paths.map((path) => readFile(join(f.root, path))))
  const complete = async (source: string) => {
    const task = await createAssignmentTask(f.root, "CS101", source, "draft")
    const file = join(f.root, "candidate.md")
    await writeFile(
      file,
      [
        `Task: ${task.id}`,
        ...task.requirements.map(
          (heading) =>
            `## ${heading}\nSynthetic structural response cites its exact prompt, not an academic verdict. \`${source}\``,
        ),
      ].join("\n\n"),
    )
    return { task, completed: await completeTask(f.root, task.id, file) }
  }
  const first = f.paths[0],
    second = f.paths[1]
  if (!first || !second) throw new Error("Synthetic prompt missing")
  const old = await complete(first)
  const oldRecord = await readFile(join(f.root, "_meta/tasks", old.task.id, "task.json"))
  const oldOutput = await readFile(join(f.root, old.completed.output))
  await writeFile(
    join(f.root, "_meta/canvas-courses.json"),
    JSON.stringify({
      version: 1,
      courses: [{ id: "9", root: "CS101", name: "Synthetic", syncNamespace: "Canvas Agent" }],
    }),
  )
  await writeFile(
    join(f.root, "_meta/canvas-sync-state.json"),
    JSON.stringify({ version: 1, files: {} }),
  )
  const currentFirst = await complete(first)
  const currentSecond = await complete(second)
  expect(currentFirst.task.destination).toBe("CS101/Canvas Agent/Generated/Assignments/Drafts")
  const rows = (await f.status()).undated
  expect(rows.find((row) => row.path === first)).toMatchObject({
    draftBinding: "task-metadata",
    draftVersion: 1,
    draftContentsVerified: false,
    draftPaths: [old.completed.output, currentFirst.completed.output].sort(),
  })
  expect(rows.find((row) => row.path === second)).toMatchObject({
    draftBinding: "task-metadata",
    draftVersion: 2,
    draftContentsVerified: false,
    draftPaths: [currentSecond.completed.output],
  })
  const configRoot = await mkdtemp(join(tmpdir(), "canvas-homework-config-"))
  roots.push(configRoot)
  const config = join(configRoot, "config.json")
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "CANVAS_SYNTHETIC_UNUSED" },
      vault: { path: f.root },
      courses: { allowlist: [] },
    }),
  )
  const result = spawnSync(
    process.execPath,
    [resolve("dist/cli.js"), "homework", "--course", "CS101", "--config", config, "--json"],
    { cwd: configRoot, encoding: "utf8" },
  )
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).undated).toEqual(rows)
  await writeFile(join(f.root, currentSecond.completed.output), "PRIVATE_CHANGED_NAMESPACED_DRAFT")
  expect((await f.status()).undated.find((row) => row.path === second)?.draftVersion).toBe(2)
  expect(JSON.stringify(await f.status())).not.toContain("PRIVATE_CHANGED_NAMESPACED_DRAFT")
  expect(await readFile(join(f.root, "_meta/tasks", old.task.id, "task.json"))).toEqual(oldRecord)
  expect(await readFile(join(f.root, old.completed.output))).toEqual(oldOutput)
  expect(await Promise.all(f.paths.map((path) => readFile(join(f.root, path))))).toEqual(originals)
})

it("does not assign colliding legacy filenames to either prompt or count a symlink as a draft", async () => {
  const f = await fixture(["Résumé case", "Resume case"])
  await mkdir(join(f.root, "CS101/Drafts"))
  await writeFile(join(f.root, "CS101/Drafts/resume-case.md"), "Synthetic ambiguous legacy draft")
  expect(
    (await f.status()).undated.every(
      (row) => row.draftVersion === null && row.draftBinding === "ambiguous-legacy-filename",
    ),
  ).toBe(true)
  await rm(join(f.root, "CS101/Drafts/resume-case.md"))
  const prompt = f.paths[0]
  if (!prompt) throw new Error("Synthetic prompt path missing")
  await symlink(join(f.root, prompt), join(f.root, "CS101/Drafts/resume-case.v8.md"))
  expect(
    (await f.status()).undated.every(
      (row) => row.draftVersion === null && row.draftBinding === "not-found",
    ),
  ).toBe(true)
})

it("exposes preserved same-Canvas-identity drafts separately from the refreshed prompt without crossing courses or claiming current work", async () => {
  const f = await fixture(["First case", "Other assignment"])
  const source = f.paths[0]
  if (!source) throw new Error("Synthetic prompt missing")
  const task = await createAssignmentTask(f.root, "CS101", source, "draft")
  const file = join(f.root, "candidate.md")
  await writeFile(
    file,
    [
      `Task: ${task.id}`,
      ...task.requirements.map(
        (heading) =>
          `## ${heading}\nSynthetic historical-source response with an exact citation. \`${source}\``,
      ),
    ].join("\n\n"),
  )
  const completed = await completeTask(f.root, task.id, file)
  const oldRecord = await readFile(join(f.root, "_meta/tasks", task.id, "task.json"))
  const oldPrompt = await readFile(join(f.root, source))
  const oldOutput = await readFile(join(f.root, completed.output))
  const active = "CS101/Canvas Agent/Canvas/Assignments/refreshed.md"
  await mkdir(join(f.root, "CS101/Canvas Agent/Canvas/Assignments"), { recursive: true })
  await writeFile(
    join(f.root, active),
    "---\ntype: assignment\ncanvas_id: '1'\n---\n# Renamed current prompt\nDifferent current source requirements.",
  )
  await writeFile(
    join(f.root, "_meta/canvas-courses.json"),
    JSON.stringify({
      version: 1,
      courses: [{ id: "9", root: "CS101", name: "Synthetic", syncNamespace: "Canvas Agent" }],
    }),
  )
  await writeFile(
    join(f.root, "_meta/canvas-sync-state.json"),
    JSON.stringify({ version: 1, files: {} }),
  )
  await mkdir(join(f.root, "OTHER101/Assignments"), { recursive: true })
  await writeFile(
    join(f.root, "OTHER101/Assignments/prompt.md"),
    "---\ntype: assignment\ncanvas_id: '1'\n---\n# Other course",
  )
  const result = await f.status()
  expect(result.undated.find((row) => row.path === active)).toMatchObject({
    draftVersion: null,
    draftBinding: "not-found",
    draftPaths: [],
    draftContentsVerified: false,
    relatedDrafts: [
      {
        taskId: task.id,
        path: completed.output,
        promptPath: source,
        version: 1,
        binding: "same-canvas-id-different-prompt",
        draftContentsVerified: false,
      },
    ],
  })
  expect(
    result.undated
      .filter((row) => row.canvasId !== "1" || row.course !== "CS101")
      .every((row) => row.relatedDrafts.length === 0),
  ).toBe(true)
  expect(result.limitation).toContain("different prompt path")
  const configRoot = await mkdtemp(join(tmpdir(), "canvas-related-homework-"))
  roots.push(configRoot)
  const config = join(configRoot, "config.json")
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "CANVAS_SYNTHETIC_UNUSED" },
      vault: { path: f.root },
      courses: { allowlist: [] },
    }),
  )
  const args = [resolve("dist/cli.js"), "homework", "--course", "CS101", "--config", config]
  const text = spawnSync(process.execPath, args, { cwd: configRoot, encoding: "utf8" })
  expect(text.status, text.stderr).toBe(0)
  expect(text.stdout).toContain("related: 1 saved draft(s), different prompt snapshot")
  expect(text.stdout).toContain("not current-prompt completion")
  const json = spawnSync(process.execPath, [...args, "--json"], {
    cwd: configRoot,
    encoding: "utf8",
  })
  expect(json.status, json.stderr).toBe(0)
  expect(
    JSON.parse(json.stdout).undated.find((row: { path: string }) => row.path === active)
      .relatedDrafts[0].taskId,
  ).toBe(task.id)
  expect(await readFile(join(f.root, "_meta/tasks", task.id, "task.json"))).toEqual(oldRecord)
  expect(await readFile(join(f.root, source))).toEqual(oldPrompt)
  expect(await readFile(join(f.root, completed.output))).toEqual(oldOutput)
  // An unknown captured identity must not be guessed from the title/filename.
  await writeFile(
    join(f.root, active),
    "---\ntype: assignment\n---\n# First case\nUnknown current identity.",
  )
  expect((await f.status()).undated.find((row) => row.path === active)?.relatedDrafts).toEqual([])
})

it("reports unreadable task records without echoing them or claiming a complete inventory", async () => {
  const f = await fixture(["Case"])
  const directory = join(f.root, "_meta/tasks/11111111-1111-4111-8111-111111111111")
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "task.json"), "PRIVATE_BAD_TASK_RECORD")
  const result = await f.status()
  expect(result.unreadableTaskRecords).toBe(1)
  expect(result.limitation).toContain("may hide other drafts")
  expect(JSON.stringify(result)).not.toContain("PRIVATE_BAD_TASK_RECORD")
})
