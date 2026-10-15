import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"
import { setCanvasFetchForTests, syncCourses } from "../src/canvas.ts"
import { selectPrepInputs } from "../src/tasks.ts"
import { inspectWorkspace, selectCourse } from "../src/workspace.ts"

// Maintainer-only comparison against an explicitly supplied School checkout.
// Run with tsx's Node import hook. Never load config, providers, auth or a vault.
const school = process.argv[2]
if (!school || !isAbsolute(school)) throw new Error("Supply an absolute School Agent checkout path")
const selectionPath = join(school, "src/engines/retrieve-selection.ts")
const { selectModulesForPeriod, selectModulesForAssignment } = await import(
  pathToFileURL(selectionPath).href
)
const documentPath = join(school, "src/store/vault-document.ts")
const { createVaultFrontmatter, renderVaultDocument, parseVaultDocument } = await import(
  pathToFileURL(documentPath).href
)
const schoolLayoutPath = join(school, "src/store/course-root-migration.ts")
const { assertCourseRootLayoutReady } = await import(pathToFileURL(schoolLayoutPath).href)
const root = await mkdtemp(join(tmpdir(), "canvas-school-selection-audit-"))
const tokenEnv = "CANVAS_SYNTHETIC_AUDIT_TOKEN"
const priorToken = process.env[tokenEnv]
async function document(course, path, id, type, content, dates = {}) {
  await mkdir(join(course, path, ".."), { recursive: true })
  const metadata = createVaultFrontmatter({
    canvasId: id,
    canvasUrl: "https://canvas.example.test/courses/synthetic",
    type,
    content,
    dates,
    source: "sync",
    status: "final",
    aiPolicy: "allowed",
  })
  await writeFile(join(course, path), renderVaultDocument(metadata, content))
}
try {
  const weekCourse = join(root, "CS100")
  const examples = [
    ["0", "year2000", "2000-01-04T12:00:00Z"],
    ["1", "jan2001", "2001-01-04T12:00:00Z"],
    ["2", "feb2001", "2001-02-04T12:00:00Z"],
    ["2026-10-05", "oct2026", "2026-10-06T12:00:00Z"],
  ]
  for (const [index, [, id, date]] of examples.entries())
    await document(
      weekCourse,
      `modules/0${index + 1}-module.md`,
      id,
      "modules",
      `Synthetic dated module ${id}`,
      { unlock_at: date },
    )
  const weeks = []
  for (const [value, expected] of examples) {
    const selected = await selectModulesForPeriod(weekCourse, { kind: "week", value })
    assert.equal(selected.mode, "module")
    assert.deepEqual(selected.moduleCanvasIds, [expected])
    weeks.push({
      value,
      parsedDate: new Date(Date.parse(value)).toISOString(),
      selectedModuleIds: selected.moduleCanvasIds,
    })
  }
  const invalid = await selectModulesForPeriod(weekCourse, { kind: "week", value: "not-a-date" })
  assert.equal(invalid.mode, "keyword-fallback")
  const assignmentCourse = join(root, "CS101")
  const priorityCourse = join(root, "CS102")
  await document(priorityCourse, "modules/01-first.md", "11", "modules", "Session 1", {
    unlock_at: "2026-10-05T08:00:00Z",
    session_at: "2026-10-12",
  })
  await document(priorityCourse, "modules/02-second.md", "22", "modules", "Session 2", {
    session_at: "2026-10-12",
  })
  const selectedIds = (course, version) =>
    selectPrepInputs(course, "2026-10-12", version)
      .sources.filter((source) => source.type === "modules")
      .map((source) => source.canvasId)
  const priorityContext = selectCourse(await inspectWorkspace(root), "CS102")
  const prioritySchool = await selectModulesForPeriod(priorityCourse, {
    kind: "week",
    value: "2026-10-12",
  })
  assert.deepEqual(prioritySchool.moduleCanvasIds, ["22"])
  assert.deepEqual(selectedIds(priorityContext, 2), ["22"])
  assert.deepEqual(selectedIds(priorityContext, 1), ["11", "22"])
  await document(priorityCourse, "assignments/case.md", "50", "assignments", "Case", {
    due_at: "2026-10-12T08:00:00Z",
  })
  await document(
    priorityCourse,
    "modules/01-first.md",
    "11",
    "modules",
    "Session 1\n- Assignment: Case (canvas_id: 50)",
    { unlock_at: "2026-10-05T08:00:00Z", session_at: "2026-10-12" },
  )
  const dueSchool = await selectModulesForPeriod(priorityCourse, {
    kind: "week",
    value: "2026-10-12",
  })
  assert.deepEqual(dueSchool.moduleCanvasIds, ["11", "22"])
  assert.deepEqual(selectedIds(selectCourse(await inspectWorkspace(root), "CS102"), 2), [
    "11",
    "22",
  ])
  await document(
    assignmentCourse,
    "modules/01-theory.md",
    "theory",
    "modules",
    "Synthetic preceding teaching module",
  )
  await document(
    assignmentCourse,
    "modules/02-task.md",
    "task-module",
    "modules",
    "Synthetic task module\n- Assignment: Synthetic task (canvas_id: task)",
  )
  await document(
    assignmentCourse,
    "assignments/synthetic-task.md",
    "task",
    "assignments",
    "Synthetic assignment prompt",
  )
  const assignment = await selectModulesForAssignment(assignmentCourse, {
    canvasId: "task",
    title: "Synthetic task",
  })
  assert.equal(assignment.mode, "module")
  assert.deepEqual(assignment.moduleCanvasIds, ["task-module", "theory"])
  assert(assignment.paths.includes("modules/01-theory.md"))
  assert(assignment.paths.includes("assignments/synthetic-task.md"))
  const schoolInCanvas = await inspectWorkspace(root)
  const legacyCourse = schoolInCanvas.courses.find((course) => course.root === "CS101")
  assert(legacyCourse)
  assert(legacyCourse.sources.some((source) => source.canvasId === "task"))
  assert(legacyCourse.sources.some((source) => source.canvasId === "theory"))
  const nativeVault = join(root, "native-scope")
  process.env[tokenEnv] = "synthetic-audit-token"
  const syntheticCourse = { id: 1, course_code: "CS101", name: "Synthetic course" }
  setCanvasFetchForTests(async (input, init) => {
    assert.equal(init?.method, "GET")
    const url = new URL(String(input))
    assert.equal(url.origin, "https://canvas.example.test")
    let body = []
    if (url.pathname.endsWith("/submissions/self")) body = { assignment_id: 50 }
    if (url.pathname === "/api/v1/courses") body = [syntheticCourse]
    if (url.pathname === "/api/v1/courses/1") body = syntheticCourse
    if (url.pathname.endsWith("/assignments"))
      body = [{ id: 50, name: "Synthetic task", description: "Explain the synthetic framework." }]
    if (url.pathname.endsWith("/modules"))
      body = [{ id: 21, name: "Session 1", position: 1, items: [] }]
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  })
  await syncCourses({
    version: 1,
    canvas: { baseUrl: "https://canvas.example.test", tokenEnv },
    vault: { path: nativeVault },
    courses: { allowlist: ["1"] },
  })
  const native = await inspectWorkspace(nativeVault)
  const nativeSources = native.courses[0]?.sources
  assert(nativeSources?.length)
  const nativeInSchool = []
  for (const source of nativeSources) {
    let accepted = true
    try {
      parseVaultDocument(await readFile(join(nativeVault, source.path), "utf8"), source.path)
    } catch {
      accepted = false
    }
    nativeInSchool.push({ path: source.path, acceptedBySchoolParser: accepted })
  }
  assert(nativeInSchool.some((source) => !source.acceptedBySchoolParser))
  const sourceHash = createHash("sha256")
    .update(await readFile(selectionPath))
    .digest("hex")
  const markerRoot = join(root, "layout-scope")
  await mkdir(join(markerRoot, "SYNTHETIC101"), { recursive: true })
  await mkdir(join(markerRoot, "_meta"))
  const layoutMarkers = []
  for (const [marker, expected] of [
    [null, true],
    [{ layout_version: 2, course_root_version: 2 }, true],
    [{ layout_version: 2, course_root_version: 1 }, false],
    [{ layout_version: 1 }, false],
    [{ layout_version: 999 }, false],
  ]) {
    if (marker) await writeFile(join(markerRoot, "_meta/layout.json"), JSON.stringify(marker))
    let allowed = true
    try {
      await assertCourseRootLayoutReady(markerRoot)
    } catch {
      allowed = false
    }
    assert.equal(allowed, expected)
    layoutMarkers.push({ marker, schoolSourceAllowsWrites: allowed })
  }
  console.log(
    JSON.stringify(
      {
        status: "pass",
        node: process.version,
        schoolSelectionSourceHash: sourceHash,
        weeks,
        invalidWeekMode: invalid.mode,
        assignmentModules: assignment.moduleCanvasIds,
        prepDatePriority: {
          school: prioritySchool.moduleCanvasIds,
          canvasV2: selectedIds(priorityContext, 2),
          legacyFlat: selectedIds(priorityContext, 1),
          assignmentDeadlineOverride: dueSchool.moduleCanvasIds,
        },
        layoutMarkers,
        documentCompatibility: {
          schoolDocumentsReadByCanvas: true,
          nativeCanvasDocuments: nativeInSchool,
          sharedWritersVerified: false,
          limitation:
            "School's strict frontmatter parser rejects native Canvas records. Do not alternate writers or advance a global layout marker based on this audit.",
          schoolDocumentSourceHash: createHash("sha256")
            .update(await readFile(documentPath))
            .digest("hex"),
        },
        schoolLayoutSourceHash: createHash("sha256")
          .update(await readFile(schoolLayoutPath))
          .digest("hex"),
        scope:
          "Actual current School selection/layout/document functions and mocked GET-only Canvas sync on synthetic temporary documents only; no config file, credential storage, model, live Canvas or student vault. Not proof of past run behavior or shared writer safety.",
      },
      null,
      2,
    ),
  )
} finally {
  setCanvasFetchForTests()
  if (priorToken === undefined) delete process.env[tokenEnv]
  else process.env[tokenEnv] = priorToken
  await rm(root, { recursive: true, force: true })
}
