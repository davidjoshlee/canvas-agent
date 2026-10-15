import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"
import { captureSimulation, replaySimulation } from "../src/simulation.ts"

// Maintainer-only audit: actual School pure visibility functions and synthetic
// Canvas files. No School config, providers, credentials or student vault reads.
const school = process.argv[2]
if (!school || !isAbsolute(school)) throw new Error("Supply an absolute School Agent checkout path")
const sourcePath = join(school, "src/engines/simulate-visibility.ts")
const { computeVisibility, courseSetupCutoff } = await import(pathToFileURL(sourcePath).href)
const moduleDates = new Map([
  ["11", { unlock_at: "2026-10-05T08:00:00Z", session_at: "2026-10-12T08:00:00Z" }],
  ["22", { session_at: "2026-10-12T08:00:00Z" }],
])
const setupCutoff = courseSetupCutoff(moduleDates, ["2026-10-09T08:00:00Z"])
const cases = [
  ["explicit-unlock", { unlock_at: "2026-10-05T08:00:00Z" }, undefined, true, true, "unlock_at"],
  ["explicit-posted", { posted_at: "2026-10-05T08:00:00Z" }, undefined, true, true, "posted_at"],
  ["future-unlock", { unlock_at: "2026-10-12T08:00:00Z" }, undefined, false, false, "unlock_at"],
  ["module-unlock", {}, "11", true, true, "module_release"],
  ["module-session-lead", {}, "22", true, true, "module_release"],
  ["due-only", { due_at: "2026-10-09T08:00:00Z" }, undefined, true, true, "due_at"],
  ["bulk-creation", { created_at: "2026-09-01T08:00:00Z" }, undefined, false, false, "unknown"],
  ["late-creation", { created_at: "2026-10-06T08:00:00Z" }, undefined, true, true, "created_at"],
  ["unknown", {}, undefined, false, false, "unknown"],
]
const root = await mkdtemp(join(tmpdir(), "canvas-school-visibility-audit-"))
try {
  await mkdir(join(root, "CS101"))
  for (const [id, dates] of moduleDates)
    await writeFile(
      join(root, "CS101", `module-${id}.md`),
      `---\ntype: modules\ncanvas_id: "${id}"\ndates: ${JSON.stringify(dates)}\n---\nSynthetic module dates.`,
    )
  await writeFile(
    join(root, "CS101", "assignment-floor.md"),
    '---\ntype: assignments\ndates: {due_at: "2026-10-09T08:00:00Z"}\n---\nSynthetic course setup floor.',
  )
  for (const [name, dates, module] of cases) {
    await writeFile(
      join(root, "CS101", `${name}.md`),
      [
        "---",
        "type: files",
        `dates: ${JSON.stringify(dates)}`,
        ...(module ? [`module_canvas_id: ${JSON.stringify(module)}`] : []),
        "---",
        `Synthetic visibility material ${name}.`,
      ].join("\n"),
    )
  }
  const capture = await captureSimulation(root, "CS101", "2026-10-09")
  const replay = await replaySimulation(root, capture.id)
  const included = new Set(replay.sources.map((source) => source.path))
  const results = cases.map(([name, dates, module, schoolExpected, canvasExpected, signal]) => {
    const visibility = computeVisibility(dates, module, moduleDates, setupCutoff)
    const schoolIncluded = visibility.visibleAt !== null && visibility.visibleAt <= "2026-10-09"
    const canvasIncluded = included.has(`CS101/${name}.md`)
    assert.equal(visibility.signal, signal)
    assert.equal(schoolIncluded, schoolExpected)
    assert.equal(canvasIncluded, canvasExpected)
    return {
      name,
      schoolIncluded,
      canvasIncluded,
      schoolSignal: visibility.signal,
      equal: schoolIncluded === canvasIncluded,
    }
  })
  console.log(
    JSON.stringify(
      {
        status: "synthetic-visibility-cases-pass",
        scope: "synthetic visibility only; no historical access or academic quality verified",
        source: {
          path: sourcePath,
          sha256: createHash("sha256")
            .update(await readFile(sourcePath))
            .digest("hex"),
        },
        setupCutoff,
        differences: results.filter((result) => !result.equal).length,
        cases: results,
      },
      null,
      2,
    ),
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
