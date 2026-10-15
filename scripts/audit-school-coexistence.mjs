import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

// Explicit maintainer checkout; all writer operations use temporary synthetic
// vaults. Never load a School config, index, account, environment file or vault.
const school = process.argv[2]
const installedCanvas = process.argv[3]
if (!school || !isAbsolute(school) || (installedCanvas && !isAbsolute(installedCanvas)))
  throw new Error(
    "Supply an absolute School checkout, or installed School and Canvas package paths",
  )
const installedPackages = Boolean(installedCanvas)
const canvasRoot = installedCanvas ?? resolve(import.meta.dirname, "..")
const canvasModule = (name) =>
  pathToFileURL(
    join(
      canvasRoot,
      installedPackages ? "dist" : "src",
      `${name}.${installedPackages ? "js" : "ts"}`,
    ),
  ).href
const { setCanvasFetchForTests, syncCourses } = await import(canvasModule("canvas"))
const { applyPreservationMigration, planPreservationMigration } = await import(
  canvasModule("preservation-migration")
)
const { inspectSchoolLayout } = await import(canvasModule("school-layout"))
const { inspectWorkspace, selectCourse } = await import(canvasModule("workspace"))
const writerPath = join(school, installedPackages ? "dist/store/vault.js" : "src/store/vault.ts")
const parserPath = join(
  school,
  installedPackages ? "dist/store/vault-document.js" : "src/store/vault-document.ts",
)
const { VaultWriter } = await import(pathToFileURL(writerPath).href)
const { createVaultFrontmatter, renderVaultDocument, parseVaultDocument } = await import(
  pathToFileURL(parserPath).href
)
const root = await mkdtemp(join(tmpdir(), "canvas-school-coexistence-"))
const savedToken = process.env.CANVAS_COEXIST_AUDIT_TOKEN
const json = (value) => new Response(JSON.stringify(value))
const results = []
async function inventory(directory, prefix = "") {
  const rows = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(prefix, entry.name)
    if (entry.isDirectory()) rows.push(...(await inventory(join(directory, entry.name), path)))
    else {
      assert(entry.isFile(), "Synthetic audit contains unexpected non-file entry")
      rows.push([
        path,
        createHash("sha256")
          .update(await readFile(join(directory, entry.name)))
          .digest("hex"),
      ])
    }
  }
  return rows.sort(([left], [right]) => left.localeCompare(right))
}
let canvasProcesses = 0
let schoolProcesses = 0
const childEnv = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "SystemRoot", "COMSPEC", "PATHEXT"]
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
)
function child(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: childEnv,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 5_000_000,
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `Synthetic recovery subprocess failed: ${result.stderr}`)
  return JSON.parse(result.stdout)
}
function canvasCli(configPath, args) {
  canvasProcesses++
  return child([join(canvasRoot, "dist/cli.js"), ...args, "--config", configPath, "--json"])
}
function restartedSchoolWrite(vault, input) {
  schoolProcesses++
  // Inherit only the tsx runtime arguments, not account/config environment.
  // A new writer process must reconstruct its state from this synthetic vault.
  const code = `import {VaultWriter} from ${JSON.stringify(pathToFileURL(writerPath).href)}; const writer=new VaultWriter({root:process.argv[1],gitInit:false}); console.log(JSON.stringify(await writer.write(JSON.parse(process.argv[2]))));`
  return child([
    ...(installedPackages ? [] : process.execArgv),
    "--input-type=module",
    "-e",
    code,
    vault,
    JSON.stringify(input),
  ])
}
try {
  process.env.CANVAS_COEXIST_AUDIT_TOKEN = "synthetic-token"
  setCanvasFetchForTests(async (input, init) => {
    assert.equal(init.method, "GET")
    const path = new URL(String(input)).pathname
    if (path === "/api/v1/users/self") return json({ id: 99, name: "Synthetic student" })
    if (path === "/api/v1/courses")
      return json([{ id: 1, name: "Synthetic course", course_code: "CS101" }])
    if (path === "/api/v1/courses/1")
      return json({ id: 1, name: "Synthetic course", course_code: "CS101" })
    if (path.endsWith("/assignments"))
      return json([
        { id: 50, name: "Case", description: "Explain the supplied synthetic framework." },
      ])
    if (path.endsWith("/submissions/self")) return json({ assignment_id: 50, user_id: 99 })
    return json([])
  })
  for (const order of ["school-first", "canvas-first", "canvas-legacy"]) {
    const vault = join(root, order)
    const writer = new VaultWriter({ root: vault, gitInit: false })
    const course = {
      code: "CS101",
      canvasId: "1",
      canvasUrl: "https://canvas.example.test/courses/1",
      aiPolicy: "allowed",
    }
    const schoolInput = {
      course,
      kind: "assignments",
      title: "School Case",
      canvasId: "50",
      canvasUrl: "https://canvas.example.test/courses/1/assignments/50",
      content: "Synthetic School prompt",
      source: "sync",
      status: "final",
      assignment: { title: "School Case", dueAt: "2026-10-15" },
    }
    let schoolPrompt
    const prepareSchool = async () => {
      schoolPrompt = (await writer.write(schoolInput)).path
      await writer.writeNavigation({
        course,
        path: "00 Home.md",
        content: "# Synthetic School navigation\nSchool remains available.",
      })
    }
    if (order === "school-first") await prepareSchool()
    const config = {
      version: 1,
      canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "CANVAS_COEXIST_AUDIT_TOKEN" },
      vault: { path: vault },
      courses: { allowlist: ["1"] },
    }
    if (order === "canvas-legacy") {
      await syncCourses(config)
      const original = await readFile(join(vault, "CS101/00 Home.md"))
      const migration = await applyPreservationMigration(
        config,
        await planPreservationMigration(config, "1"),
      )
      assert(migration.changed && "archivedHome" in migration)
      assert.deepEqual(await readFile(join(vault, migration.archivedHome)), original)
      await syncCourses(config)
    } else await syncCourses(config, { preserveSchool: true })
    if (order !== "school-first") {
      const beforeSchool = await inventory(vault)
      try {
        await prepareSchool()
      } catch (error) {
        if (
          error?.name !== "CourseRootMigrationError" ||
          !String(error.message).startsWith("Vault layout needs migration.")
        )
          throw error
        assert.deepEqual(
          await inventory(vault),
          beforeSchool,
          "School's readiness refusal changed vault bytes",
        )
        results.push({
          order,
          schoolWriterSurvives: false,
          schoolWriteBlockedBeforeMutation: true,
          originalVaultBytesPreserved: true,
          schoolLayout: await inspectSchoolLayout(vault),
          failureKind: "public-school-layout-readiness",
        })
        continue
      }
    }
    const schoolPaths = [
      schoolPrompt,
      join(vault, "CS101/00 Home.md"),
      join(vault, "CS101/_index.md"),
      join(vault, "_meta/layout.json"),
    ]
    const schoolBytes = await Promise.all(schoolPaths.map((path) => readFile(path)))
    await syncCourses(config) // Persistent namespace: no flag on the next sync.
    for (const [index, path] of schoolPaths.entries())
      assert.deepEqual(await readFile(path), schoolBytes[index])
    parseVaultDocument((await readFile(schoolPrompt)).toString(), schoolPrompt)
    parseVaultDocument((await readFile(schoolPaths[1])).toString(), schoolPaths[1])
    const context = selectCourse(await inspectWorkspace(vault), "CS101")
    const prompt = context.sources.find(
      (source) => source.path.startsWith("CS101/Canvas Agent/") && source.canvasId === "50",
    )
    assert(prompt, "Namespaced Canvas prompt must remain usable")
    const selectedPrompt =
      order === "school-first" ? relative(vault, schoolPrompt).split(sep).join("/") : prompt.path
    const configPath = join(root, `${order}-config.json`)
    await writeFile(configPath, JSON.stringify(config), { flag: "wx", mode: 0o600 })
    const created = canvasCli(configPath, [
      "assignment",
      "CS101",
      "--source",
      selectedPrompt,
      "--mode",
      "draft",
    ])
    const task = canvasCli(configPath, ["task", "show", created.id])
    assert.equal(task.status, "pending")
    const pendingPath = join(vault, "_meta/tasks", task.id, "task.json")
    const pendingBytes = await readFile(pendingPath)
    const briefPath = join(vault, "_meta/tasks", task.id, "TASK.md")
    const briefBytes = await readFile(briefPath)
    const restartedWrite = restartedSchoolWrite(vault, schoolInput)
    assert.equal(restartedWrite.path, schoolPrompt)
    assert.deepEqual(await readFile(pendingPath), pendingBytes)
    assert.deepEqual(await readFile(briefPath), briefBytes)
    assert.deepEqual(canvasCli(configPath, ["task", "show", task.id]), task)
    const candidate = join(root, `${order}-candidate.md`)
    await writeFile(
      candidate,
      [
        `Task: ${task.id}`,
        ...task.requirements.map(
          (heading) =>
            `## ${heading}\n\nSynthetic structural fixture: the supplied framework is discussed without invented experiences or data. This is not an academic quality verdict. \`${selectedPrompt}\``,
        ),
      ].join("\n\n"),
    )
    const completed = canvasCli(configPath, ["task", "complete", task.id, "--file", candidate])
    const approved = canvasCli(configPath, ["approve", task.id])
    assert(completed.output.startsWith("CS101/Canvas Agent/"))
    assert(approved.output.startsWith("CS101/Canvas Agent/"))
    const canvasPaths = [
      join(vault, completed.output),
      join(vault, approved.output),
      join(vault, "_meta/tasks", task.id, "task.json"),
      briefPath,
    ]
    const canvasBytes = await Promise.all(canvasPaths.map((path) => readFile(path)))
    assert.equal(canvasCli(configPath, ["task", "show", task.id]).status, "completed")
    canvasCli(configPath, ["task", "complete", task.id, "--file", candidate])
    canvasCli(configPath, ["approve", task.id])
    for (const [index, path] of canvasPaths.entries())
      assert.deepEqual(await readFile(path), canvasBytes[index])
    restartedSchoolWrite(vault, { ...schoolInput, content: "Updated School-only prompt" })
    for (const [index, path] of canvasPaths.entries())
      assert.deepEqual(await readFile(path), canvasBytes[index])
    // Mark the original School prompt student-owned. Both actual School sync and
    // Canvas sync must retain it; School may save a separate upstream update.
    const studentText = "Student-owned School prompt; preserve my edits."
    const studentBytes = renderVaultDocument(
      createVaultFrontmatter({
        canvasId: "50",
        canvasUrl: schoolInput.canvasUrl,
        type: "assignments",
        content: studentText,
        source: "user",
        status: "approved",
        aiPolicy: "allowed",
        redistribution: "allowed",
      }),
      studentText,
    )
    await writeFile(schoolPrompt, studentBytes)
    await syncCourses(config)
    const schoolUpdate = await writer.write({
      ...schoolInput,
      content: "New School upstream description",
    })
    assert.equal(await readFile(schoolPrompt, "utf8"), studentBytes)
    assert.notEqual(schoolUpdate.path, schoolPrompt)
    for (const [index, path] of canvasPaths.entries())
      assert.deepEqual(await readFile(path), canvasBytes[index])
    assert.equal(canvasCli(configPath, ["task", "show", task.id]).status, "completed")
    results.push({
      order,
      schoolWriterSurvives: true,
      schoolNavigationAndLayoutPreservedByCanvas: true,
      studentEditsPreserved: true,
      canvasTaskDraftAndFinalPreservedBySchool: true,
      persistentCanvasNamespace: true,
      pendingCanvasTaskRecoveredAcrossProcesses: true,
      completedCanvasTaskAndApprovalRetriesUnchanged: true,
      restartedSchoolWriterTested: true,
    })
  }
  console.log(
    JSON.stringify(
      {
        status: results.some((result) => !result.schoolWriterSurvives) ? "partial" : "pass",
        cases: results,
        liveAccountTested: false,
        installedReleasesTested: false,
        installedPackagesTested: installedPackages,
        compiledCanvasCliRecoveryTested: true,
        canvasProcesses,
        schoolProcesses,
        goalControllerInterruptionTested: false,
        ownedLegacyRootHomeMigrationTested: true,
        wholeNativeCorpusMigrated: false,
        academicQualityVerified: false,
        scope: `Two actual ${installedPackages ? "installed package" : "source"} writers with separate writable paths in synthetic shared vaults; not interchangeability of every document or historical ownership certification`,
        [installedPackages ? "installedArtifactHashes" : "sourceHashes"]: await Promise.all(
          [writerPath, parserPath].map(async (path) => ({
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
  // A successfully recorded partial audit is not a passing coexistence gate.
  if (results.some((result) => !result.schoolWriterSurvives)) process.exitCode = 2
} finally {
  setCanvasFetchForTests()
  if (savedToken === undefined) delete process.env.CANVAS_COEXIST_AUDIT_TOKEN
  else process.env.CANVAS_COEXIST_AUDIT_TOKEN = savedToken
  await rm(root, { recursive: true, force: true })
}
