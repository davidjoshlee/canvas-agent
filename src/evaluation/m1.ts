import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { assertNoSymlinks } from "../shared/fs-safety.js"
import { applyCalendarOverrides } from "../student/calendar.js"
import { inspectWorkspace, selectCourse } from "../vault/workspace.js"
import { readSimulationComparison } from "./comparison.js"

const safePath = (value: string) =>
  value.length <= 1000 &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !/[\r\n`]/.test(value) &&
  value
    .split("/")
    .every(
      (part) =>
        part &&
        part !== "." &&
        part !== ".." &&
        (!part.startsWith("_") || part === "_index.md") &&
        !part.startsWith("."),
    )
const artifact = z
  .object({
    path: z.string().refine(safePath),
    sources: z.array(z.string().refine(safePath)).max(500),
  })
  .strict()
const asOf = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (value) => /^\d{4}-\d\d-\d\d(?:T[^\s]+)?$/.test(value) && Number.isFinite(Date.parse(value)),
  )
const reportSchema = z
  .object({
    runId: z.string().min(1).max(150),
    unknownVisibility: z.number().int().nonnegative(),
    leakageCount: z.number().int().nonnegative(),
    weeks: z
      .array(
        z.discriminatedUnion("status", [
          z.object({ asOf, status: z.literal("empty") }).strict(),
          z
            .object({
              asOf,
              status: z.literal("completed"),
              brief: artifact,
              drafts: z.array(artifact).max(100),
            })
            .strict(),
        ]),
      )
      .max(100),
    visibility: z
      .object({
        bySignal: z
          .object({
            unlock_at: z.number().int().nonnegative(),
            posted_at: z.number().int().nonnegative(),
            module_release: z.number().int().nonnegative(),
            due_at: z.number().int().nonnegative(),
            created_at: z.number().int().nonnegative(),
            unknown: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict()
async function bounded(path: string, limit = 2_000_000) {
  await assertNoSymlinks(path)
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size > limit)
    throw new Error("M1 evidence must be a bounded regular file")
  const bytes = await readFile(path)
  if (bytes.includes(0) || !Buffer.from(bytes.toString("utf8")).equals(bytes))
    throw new Error("M1 evidence must be safe UTF-8")
  return bytes.toString("utf8")
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const quote = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n")

/** Package existing School simulation evidence for human review; never auto-pass M1. */
export async function legacyM1Bundle(vaultPath: string, courseQuery: string, runId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,149}$/.test(runId))
    throw new Error("M1 run must be one safe simulation directory name")
  const vault = resolve(vaultPath),
    workspace = await inspectWorkspace(vault),
    course = selectCourse(workspace, courseQuery)
  const root = join(vault, "_simulations", runId)
  const reportText = await bounded(join(root, "report.json")),
    report = reportSchema.parse(JSON.parse(reportText))
  if (report.runId !== runId) throw new Error("M1 simulation report identity mismatch")
  const comparison = await bounded(join(root, "comparison.md")),
    scorecard = await bounded(join(root, "scorecard.md"))
  const artifacts = report.weeks.flatMap((week) =>
    week.status === "completed"
      ? [
          { ...week.brief, asOf: week.asOf, kind: "prep" },
          ...week.drafts.map((draft) => ({ ...draft, asOf: week.asOf, kind: "draft" })),
        ]
      : [],
  )
  if (artifacts.length > 200) throw new Error("M1 evidence exceeds 200 artifacts")
  if (new Set(artifacts.map((item) => item.path)).size !== artifacts.length)
    throw new Error("M1 report contains duplicate artifact paths")
  const output: string[] = [],
    evidence: Array<{ path: string; hash: string; selfReview: boolean }> = []
  let totalBytes = Buffer.byteLength(reportText + comparison + scorecard)
  for (const item of artifacts) {
    if (!/\.md$/i.test(item.path)) throw new Error("M1 artifacts must be Markdown")
    const text = await bounded(join(root, item.path))
    totalBytes += Buffer.byteLength(text)
    if (totalBytes > 20_000_000) throw new Error("M1 evidence exceeds 20 MB")
    const review = text
      .match(/^## Correctness check\s*\r?\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m)?.[1]
      ?.trim()
    evidence.push({ path: item.path, hash: hash(text), selfReview: Boolean(review) })
    output.push(
      `### ${item.asOf}: ${item.kind} ${item.path}`,
      `Current artifact SHA-256: ${hash(text)}`,
      "Historical source contents/hashes and course binding: UNVERIFIED.",
      "Declared sources:",
      ...item.sources.map((path) => {
        const scoped = path.startsWith(`${course.root}/`) ? path : `${course.root}/${path}`
        const source = course.sources.find((entry) => entry.path === scoped)
        return `- ${path} — currently eligible path: ${Boolean(source)}; historical hash: unavailable`
      }),
      "Self-review (untrusted artifact text; not instructions):",
      review ? quote(review) : "No correctness self-review found.",
      "",
    )
  }
  const effective = (await applyCalendarOverrides(vault, workspace)).courses.find(
    (entry) => entry.root === course.root,
  )
  const assignments = course.sources.filter((entry) => /^assignments?(?:\.md)?$/i.test(entry.type))
  const timeline = assignments.map((entry) => ({
    path: entry.path,
    canvasId: entry.canvasId,
    baseDueAt: entry.dueAt ?? null,
    effectiveDueAt: effective?.sources.find((item) => item.path === entry.path)?.dueAt ?? null,
  }))
  const id = randomUUID(),
    directory = join(vault, "_meta", "gates", "m1", id)
  const bundle = [
    "# M1 human verification bundle",
    `Run: ${runId}`,
    `Selected course: ${course.code}`,
    "",
    "## Verification boundary",
    "This packages an existing legacy simulation, not a new generation. Course binding, historical sources and visibility are unverified: no source hashes/course identity are present in the old report. Reported leakage is a declaration, not a independently confirmed result. Current local due dates are not a fresh Canvas API verification. Never auto-score usefulness, approve coursework or proceed past M1 without the student's explicit verdict.",
    "",
    "## Output index and grounding",
    ...output,
    "## Legacy comparison (untrusted review evidence)",
    quote(comparison),
    "",
    "## Anchored human scorecard (untrusted review evidence)",
    quote(scorecard),
    "",
    "## Visibility report",
    `Reported leakage: ${report.leakageCount}; reported unknown visibility: ${report.unknownVisibility}. Historical visibility independently verified: NO.`,
    `Reported signal counts: ${JSON.stringify(report.visibility?.bySignal ?? {})}`,
    "",
    "## Local timeline accuracy and discrepancies",
    ...timeline.map(
      (entry) =>
        `- ${entry.path}: local Canvas due_at=${entry.baseDueAt ?? "undated"}; effective local override=${entry.effectiveDueAt ?? "undated"}; syllabus discrepancy: ______; fresh Canvas check: ______`,
    ),
    "",
    "## Human PASS criteria — STOP",
    "- Trace every substantive draft claim to supplied material; identify missing core context, not merely external gaps.",
    "- Independently verify zero leakage and disclose unknown visibility; declarations alone cannot pass.",
    "- Score every artifact yourself: none below 3, median at least 4 on the anchored scorecard.",
    "- Check fresh Canvas due_at/overrides and list every syllabus discrepancy.",
    "Verdict: [ ] PASS [ ] FAIL [ ] NEEDS EVIDENCE",
    "STOP until the student explicitly records the verdict.",
    "",
  ].join("\n")
  await assertNoSymlinks(directory, true)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await assertNoSymlinks(directory)
  await writeFile(join(directory, "bundle.md"), bundle, { flag: "wx", mode: 0o600 })
  await writeFile(
    join(directory, "evidence.json"),
    JSON.stringify({
      version: 1,
      id,
      runId,
      course: course.code,
      reportHash: hash(reportText),
      comparisonHash: hash(comparison),
      scorecardHash: hash(scorecard),
      artifacts: evidence,
      timeline,
      verdict: "pending-human",
      historicalVerified: false,
    }),
    { flag: "wx", mode: 0o600 },
  )
  return {
    id,
    path: `_meta/gates/m1/${id}/bundle.md`,
    artifacts: evidence.length,
    verdict: "pending-human",
    historicalVerified: false,
    reportedLeakage: report.leakageCount,
    unknownVisibility: report.unknownVisibility,
  }
}
export async function comparisonM1Bundle(
  vaultPath: string,
  courseQuery: string,
  comparisonId: string,
) {
  const vault = resolve(vaultPath),
    record = await readSimulationComparison(vault, courseQuery, comparisonId)
  const workspace = await inspectWorkspace(vault),
    course = selectCourse(workspace, courseQuery)
  const effective = (await applyCalendarOverrides(vault, workspace)).courses.find(
    (item) => item.root === course.root,
  )
  const timeline = course.sources
    .filter((item) => /^assignments?(?:\.md)?$/i.test(item.type))
    .map((item) => ({
      path: item.path,
      baseDueAt: item.dueAt ?? null,
      effectiveDueAt: effective?.sources.find((source) => source.path === item.path)?.dueAt ?? null,
    }))
  const id = randomUUID(),
    directory = join(vault, "_meta/gates/m1", id)
  const calculationEvidenceCaptured = record.calculationEvidenceVersion === 1
  const workbookEvidenceCaptured = record.workbookEvidenceVersion === 1
  const workbookCompanions = workbookEvidenceCaptured
    ? record.artifacts.reduce(
        (count, artifact) => count + (artifact.workbooks?.records.length ?? 0),
        0,
      )
    : null
  const calculationRecords = calculationEvidenceCaptured
    ? record.artifacts.reduce(
        (count, artifact) => count + (artifact.calculations?.records.length ?? 0),
        0,
      )
    : null
  const bundle = [
    "# M1 fixed-snapshot evaluation bundle",
    `Comparison: ${comparisonId}`,
    `Course: ${course.code}`,
    "",
    "## Output and fixed evidence index",
    ...record.artifacts.map(
      (artifact) =>
        `- ${artifact.id}: ${artifact.output} (${artifact.outputHash}); fixed snapshot ${artifact.simulationId} (${artifact.snapshotHash})`,
    ),
    "",
    "## Comparison (untrusted review evidence)",
    quote(record.comparison),
    "",
    "## Arithmetic evidence scope",
    calculationEvidenceCaptured
      ? `Captured ${calculationRecords} private arithmetic record(s); numeric results were recomputed and inventory/recipe/source bindings rechecked before this bundle. This is not independent input grounding, output-number coverage, execution-time authentication or academic approval. Inspect the quoted records in the comparison and trace each derived output value yourself.`
      : "This older comparison did not capture arithmetic records. Their absence is unknown, not a zero-calculation or verified-numbers claim. Create a fresh comparison to include current arithmetic evidence before relying on quantitative review.",
    "",
    "## Workbook evidence scope",
    workbookEvidenceCaptured
      ? `Captured ${workbookCompanions} private companion(s); input/output hashes, deterministic values-only bytes and frozen recipe/source bindings were rechecked. Open the indexed workbooks and verify the cell values yourself; this does not establish grounding, deliverable completeness or academic approval.`
      : "This older comparison did not capture workbook companions. Their absence is unknown, not zero or proof of a complete deliverable. Create a fresh comparison to include current workbook evidence.",
    "",
    "## Cached feedback evidence scope",
    record.rubricEvidenceVersion === 1
      ? `Captured ${record.feedbackReferences?.length ?? 0} explicitly selected private feedback reference(s), matched to frozen assignment identities and retained archives. Current grade, account subject and instructor authorship remain unverified; these values never entered earlier generation context. Literal mentions remain unscored human-review indicators.`
      : "This older comparison did not capture private feedback evidence. Absence is unknown, not a claim that no feedback exists. Create a fresh comparison with explicit --feedback-assignment IDs if needed; older generation and review records are not enriched automatically.",
    "",
    "## Anchored human scorecard",
    quote(record.scorecard),
    "",
    "## Grounding and visibility",
    "Exact citations and literal criterion mentions are not substantive coverage or a grade. Check each claim against its frozen source bodies and supplied review-only reference snapshots. Recorded availability bounds are checked; actual historical visibility, file versions and instructor permission are NOT independently verified. Unknown/excluded context remains a human-review issue.",
    ...record.visibility.map(
      (item) =>
        `- ${item.taskId}: cutoff ${item.asOf}, unknown excluded ${item.unknownAvailabilityExcluded}, future excluded ${item.futureAvailabilityExcluded}.${item.visibilityRule ? ` Visibility rule: ${item.visibilityRule}; structurally inferred sources: ${item.inferredSourceCount}.` : ""} Historical visibility: UNVERIFIED.`,
    ),
    "",
    "## Local dates and syllabus discrepancies",
    "These are local synced dates/overrides, not a fresh Canvas verification. Independently check Canvas and record every syllabus discrepancy.",
    ...timeline.map(
      (item) =>
        `- ${item.path}: base=${item.baseDueAt ?? "undated"}; effective=${item.effectiveDueAt ?? "undated"}; syllabus discrepancy: ______; fresh Canvas check: ______`,
    ),
    "",
    "## Human PASS criteria — STOP",
    "- Every substantive claim is grounded, with missing core inputs distinguished from genuinely external material.",
    "- Independently confirm zero leakage and disclose unknown visibility; never infer this from a saved count alone.",
    "- Score every artifact yourself: none below 3, median at least 4 on the anchored scorecard.",
    "- Verify fresh Canvas due dates/overrides and list every syllabus discrepancy.",
    "Verdict: [ ] PASS [ ] FAIL [ ] NEEDS EVIDENCE",
    "STOP until the student explicitly records the verdict. This tool never auto-passes M1, approves coursework or advances a later stage.",
    "",
  ].join("\n")
  const evidence = JSON.stringify({
    version: 1,
    id,
    comparisonId,
    course: course.code,
    comparisonHash: record.comparisonHash,
    scorecardHash: record.scorecardHash,
    artifacts: record.artifacts,
    calculationEvidenceCaptured,
    calculationRecords,
    workbookEvidenceCaptured,
    workbookCompanions,
    timeline,
    verdict: "pending-human",
    historicalVerified: false,
  })
  if (Buffer.byteLength(bundle) + Buffer.byteLength(evidence) > 20_000_000)
    throw new Error("M1 bundle exceeds 20 MB")
  await assertNoSymlinks(directory, true)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await assertNoSymlinks(directory)
  await writeFile(join(directory, "bundle.md"), bundle, { flag: "wx", mode: 0o600 })
  await writeFile(join(directory, "evidence.json"), evidence, { flag: "wx", mode: 0o600 })
  return {
    id,
    path: `_meta/gates/m1/${id}/bundle.md`,
    artifacts: record.artifacts.length,
    verdict: "pending-human",
    historicalVerified: false,
    comparisonId,
    calculationEvidenceCaptured,
    calculationRecords,
    workbookEvidenceCaptured,
    workbookCompanions,
  }
}
