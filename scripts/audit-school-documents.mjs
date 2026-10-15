import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"
import { portableModuleBody, renderPortableDocument } from "../src/portable-document.ts"
import { inspectWorkspace } from "../src/workspace.ts"

// Maintainer-only source audit, with explicit School checkout and synthetic files.
const school = process.argv[2]
if (!school || !isAbsolute(school)) throw new Error("Supply an absolute School checkout")
const parserPath = join(school, "src/store/vault-document.ts")
const selectorPath = join(school, "src/engines/retrieve-selection.ts")
const loaderPath = join(school, "src/engines/retrieve-modules.ts")
const { parseVaultDocument } = await import(pathToFileURL(parserPath).href)
const { selectModulesForAssignment } = await import(pathToFileURL(selectorPath).href)
const { loadCourseModules } = await import(pathToFileURL(loaderPath).href)
const root = await mkdtemp(join(tmpdir(), "canvas-portable-school-"))
const course = join(root, "CS101")
const examples = [
  ["00 Home.md", "course", "1", "# Synthetic course\nCourse reference.", undefined],
  ["Resources/Syllabus.md", "syllabus", "1", "# Syllabus\nSynthetic syllabus.", undefined],
  [
    "Canvas/Assignments/Task-50.md",
    "assignment",
    "50",
    "# Task\nExplain the synthetic framework.",
    "22",
  ],
  ["Canvas/Pages/Reading-77.md", "page", "77", "# Reading\nSynthetic explanatory reading.", "22"],
  [
    "Resources/Files/Case.pdf.extracted.md",
    "file",
    "88",
    "# Case\nSynthetic extracted case text.",
    "11",
  ],
  [
    "Canvas/Modules/01-Theory-11.md",
    "module",
    "11",
    portableModuleBody("Theory", [{ type: "File", title: "Case", canvasId: "88" }]),
    undefined,
  ],
  [
    "Canvas/Modules/02-Task-22.md",
    "module",
    "22",
    portableModuleBody("Session 2", [
      { type: "Assignment", title: "Task", canvasId: "50" },
      { type: "Page", title: "Reading-77", pageUrl: "reading" },
    ]),
    undefined,
  ],
  [
    "Canvas/Discussions/Discussion-99.md",
    "discussion",
    "99",
    "# Discussion\nSynthetic discussion body.",
    "22",
  ],
  [
    "Canvas/Announcements/Announcement-100.md",
    "announcement",
    "100",
    "# Announcement\nSynthetic announcement body.",
    undefined,
  ],
]
try {
  const results = []
  for (const [path, kind, id, body, moduleCanvasId] of examples) {
    const document = renderPortableDocument({
      canvasId: id,
      canvasUrl: `https://canvas.example.test/courses/1/items/${id}`,
      kind,
      title: `Synthetic ${kind}`,
      body,
      dates: { unlock_at: "2026-10-06T12:00:00Z" },
      source: "sync",
      status: "final",
      aiPolicy: "allowed",
      redistribution: "restricted",
      ...(moduleCanvasId ? { moduleCanvasId } : {}),
    })
    const parsed = parseVaultDocument(document.markdown, path)
    assert.equal(parsed.frontmatter.canvas_id, id)
    assert.equal(parsed.frontmatter.redistribution, "restricted")
    assert.equal(parsed.frontmatter.ai_policy, "allowed")
    assert.equal(
      createHash("sha256").update(parsed.content).digest("hex"),
      parsed.frontmatter.content_hash,
    )
    await mkdir(join(course, path, ".."), { recursive: true })
    await writeFile(join(course, path), document.markdown)
    results.push({ kind, path, acceptedBySchoolParser: true })
  }
  const modules = await loadCourseModules(course)
  assert.deepEqual(
    modules.map((m) => [m.canvasId, m.position]),
    [
      ["11", 1],
      ["22", 2],
    ],
  )
  const selection = await selectModulesForAssignment(course, { canvasId: "50", title: "Task" })
  assert.equal(selection.mode, "module")
  assert.deepEqual(selection.moduleCanvasIds, ["22", "11"])
  for (const path of [
    "Canvas/Assignments/Task-50.md",
    "Canvas/Pages/Reading-77.md",
    "Resources/Files/Case.pdf.extracted.md",
  ])
    assert(selection.paths.includes(path), `Missing selected portable source ${path}`)
  // Canvas must still honor the explicit restriction, not launder it through shape.
  const workspace = await inspectWorkspace(root)
  assert(workspace.courses[0].sources.length === 0)
  assert(workspace.courses[0].excluded.some((item) => /Restricted/.test(item.reason)))
  console.log(
    JSON.stringify(
      {
        status: "pass",
        documents: results,
        moduleSelection: { ids: selection.moduleCanvasIds, paths: selection.paths },
        policyPreserved: true,
        currentSyncUsesPortableSerializer: false,
        sharedWritersVerified: false,
        limitations:
          "Explicit synthetic eligibility/restriction and position-prefixed module filenames. Page title/filename resolution was supplied explicitly. Private context persistence, current sync integration, existing-path migration and shared ownership remain unfinished; parser/selector success is not writer compatibility or instructor permission.",
        sourceHashes: await Promise.all(
          [parserPath, selectorPath, loaderPath].map(async (path) => ({
            path,
            sha256: createHash("sha256")
              .update(await readFile(path))
              .digest("hex"),
          })),
        ),
      },
      null,
      2,
    ),
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
