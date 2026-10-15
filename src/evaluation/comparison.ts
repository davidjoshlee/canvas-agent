import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { assertNoSymlinks } from "../shared/fs-safety.js"
import { verifySourceSnapshot } from "../tasks/store.js"
import { inspectWorkspace, selectCourse } from "../vault/workspace.js"
import { readSimulationCalculations, SimulationCalculationEvidenceSchema } from "./calculations.js"
import { replaySimulation } from "./captures.js"
import {
  captureReviewFeedback,
  feedbackCriterionRows,
  ReviewFeedbackSchema,
  reviewFeedbackPath,
  verifyReviewFeedback,
} from "./feedback.js"
import { inspectSimulationTask } from "./tasks.js"
import { readSimulationWorkbooks, SimulationWorkbookEvidenceSchema } from "./workbooks.js"

const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const literal = (value: string) => value.replace(/[\r\n`|]/g, " ")
const quote = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n")
const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, " ")
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
function rubricCriteria(text: string): string[] {
  const match = text.match(/Rubric assessment:\s*```json\s*([\s\S]*?)\s*```/)
  if (!match) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1] ?? "")
  } catch {
    throw new Error("Comparison rubric JSON is invalid; no reference body was echoed")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Comparison rubric assessment must be a JSON object")
  const keys = Object.keys(parsed)
  if (keys.length > 200 || keys.some((key) => key.length > 500 || !key.trim()))
    throw new Error("Comparison rubric criteria exceed safe limits")
  return keys.sort()
}
const evidenceSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    course: z.string().min(1).max(200),
    calculationEvidenceVersion: z.literal(1).optional(),
    workbookEvidenceVersion: z.literal(1).optional(),
    rubricEvidenceVersion: z.literal(1).optional(),
    feedbackReferences: z.array(ReviewFeedbackSchema).max(20).optional(),
    artifacts: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            kind: z.enum(["prep", "assignment"]),
            mode: z.enum(["outline", "draft", "review", "discuss"]).nullable(),
            period: z
              .object({
                kind: z.enum(["week", "session"]),
                value: z.string(),
                root: z.string().optional(),
              })
              .strict()
              .nullable(),
            simulationId: z.string().uuid(),
            output: z.string(),
            outputHash: digestSchema,
            snapshotHash: digestSchema,
            sources: z
              .array(
                z
                  .object({
                    path: z.string(),
                    hash: digestSchema,
                    exactCitationPresent: z.boolean(),
                  })
                  .strict(),
              )
              .max(5000),
            rubric: z
              .array(
                z
                  .object({
                    reference: z.string(),
                    criterion: z.string().max(500),
                    literalMention: z.boolean(),
                    humanCoverage: z.literal("unscored"),
                  })
                  .strict(),
              )
              .max(4000),
            correctnessSelfReviewPresent: z.boolean(),
            calculations: SimulationCalculationEvidenceSchema.optional(),
            workbooks: SimulationWorkbookEvidenceSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    visibility: z
      .array(
        z
          .object({
            taskId: z.string().uuid(),
            asOf: z.string(),
            capturedAt: z.string(),
            availabilitySignalsWithinCutoff: z.literal(true),
            visibilityRule: z
              .literal("explicit-release-with-school-structural-fallback-v1")
              .optional(),
            inferredSourceCount: z.number().int().nonnegative().optional(),
            historicalVisibilityVerified: z.literal(false),
            unknownAvailabilityExcluded: z.number().int().nonnegative(),
            futureAvailabilityExcluded: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    references: z
      .array(
        z
          .object({
            path: z.string(),
            hash: digestSchema,
            text: z.string().max(5_000_000),
            criteria: z.array(z.string().max(500)).max(200),
            use: z.literal("review-only"),
          })
          .strict(),
      )
      .max(20),
    comparisonHash: digestSchema,
    scorecardHash: digestSchema,
    verdict: z.literal("pending-human"),
    historicalVerified: z.literal(false),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (
      (record.feedbackReferences !== undefined) !== (record.rubricEvidenceVersion === 1) ||
      new Set(record.feedbackReferences?.map((entry) => entry.assignmentId) ?? []).size !==
        (record.feedbackReferences?.length ?? 0)
    )
      ctx.addIssue({
        code: "custom",
        message: "Feedback evidence must match its capture version/scope",
      })
    if (
      record.artifacts.some(
        (artifact) => Boolean(artifact.workbooks) !== (record.workbookEvidenceVersion === 1),
      )
    )
      ctx.addIssue({ code: "custom", message: "Workbook evidence must match its capture version" })
    if (
      record.artifacts.some(
        (artifact) => Boolean(artifact.calculations) !== (record.calculationEvidenceVersion === 1),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Arithmetic evidence must match the comparison's capture version",
      })
  })
async function privateText(path: string) {
  await assertNoSymlinks(path)
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size > 20_000_000 || stat.mode & 0o077)
    throw new Error("Comparison evidence must be a bounded regular file")
  const bytes = await readFile(path)
  if (bytes.includes(0) || !Buffer.from(bytes.toString()).equals(bytes))
    throw new Error("Comparison evidence must be safe UTF-8")
  return bytes.toString()
}

/** Review-only comparison: never use later feedback as generation context or auto-grade quality. */
export async function compareSimulationEvaluations(
  vaultPath: string,
  courseQuery: string,
  ids: string[],
  referencePaths: string[] = [],
  feedbackAssignments: string[] = [],
) {
  if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length)
    throw new Error("Comparison needs 1–100 distinct completed evaluation task IDs")
  if (referencePaths.length > 20 || new Set(referencePaths).size !== referencePaths.length)
    throw new Error("Comparison needs at most 20 distinct explicit reference paths")
  const vault = resolve(vaultPath),
    course = selectCourse(await inspectWorkspace(vault), courseQuery)
  let bytes = 0
  const feedbackReferences = await captureReviewFeedback(vault, course, feedbackAssignments)
  bytes += Buffer.byteLength(JSON.stringify(feedbackReferences))
  const references = []
  for (const path of referencePaths) {
    const source = course.sources.find((entry) => entry.path === path)
    if (!source)
      throw new Error("Comparison reference is not an eligible source in the explicit course")
    const verified = await verifySourceSnapshot(vault, source)
    bytes += Buffer.byteLength(verified.text)
    if (bytes > 20_000_000) throw new Error("Comparison evidence exceeds 20 MB")
    const criteria = rubricCriteria(verified.text)
    references.push({
      path: verified.path,
      hash: verified.hash,
      text: verified.text,
      criteria,
      use: "review-only",
    })
  }
  const sections: string[] = [],
    artifacts = [],
    visibility = []
  const matchedFeedback = new Set<string>()
  for (const id of ids) {
    const record = await inspectSimulationTask(vault, id)
    if (record.state !== "completed-pending-human" || !record.completion)
      throw new Error("Comparison requires completed evaluation outputs")
    if (record.task.course.root !== course.root || record.task.course.code !== course.code)
      throw new Error("Comparison tasks must belong to the explicit course")
    const path = join(vault, record.completion.output)
    await assertNoSymlinks(path)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size > 5_000_000)
      throw new Error("Comparison output is not a bounded regular file")
    const output = await readFile(path, "utf8")
    if (hash(output) !== record.completion.outputHash)
      throw new Error("Comparison output changed during inspection")
    bytes += Buffer.byteLength(output)
    if (bytes > 20_000_000) throw new Error("Comparison evidence exceeds 20 MB")
    const snapshot = await replaySimulation(vault, record.simulationId)
    const calculations = await readSimulationCalculations(vault, id)
    const workbooks = await readSimulationWorkbooks(vault, id)
    bytes += calculations.totalBytes
    if (bytes > 20_000_000) throw new Error("Comparison evidence exceeds 20 MB")
    const sourceRows = [...record.task.sources, ...record.task.guidance].map((source) => ({
      path: source.path,
      hash: source.hash,
      exactCitationPresent: output.includes(`\`${source.path}\``),
    }))
    const assignmentId = record.task.sources.find(
      (source) => source.path === record.task.assignment?.source,
    )?.canvasId
    if (
      assignmentId &&
      feedbackReferences.some((reference) => reference.assignmentId === assignmentId)
    )
      matchedFeedback.add(assignmentId)
    const rubric = [
      ...references.flatMap((reference) =>
        reference.criteria.map((criterion) => ({ reference: reference.path, criterion })),
      ),
      ...feedbackCriterionRows(feedbackReferences, assignmentId),
    ].map((entry) => ({
      ...entry,
      literalMention: normalized(output).includes(
        normalized(entry.criterion.replace(/[-_]+/g, " ")),
      ),
      humanCoverage: "unscored" as const,
    }))
    if (rubric.length > 4000)
      throw new Error(
        "Comparison rubric inventory exceeds 4000 indicators; narrow explicit references",
      )
    const correctness = output
      .match(/^## Correctness check\s*\r?\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m)?.[1]
      ?.trim()
    artifacts.push({
      id,
      kind: record.task.kind,
      mode: record.task.assignment?.mode ?? null,
      period: record.task.period ?? null,
      simulationId: record.simulationId,
      output: record.completion.output,
      outputHash: record.completion.outputHash,
      snapshotHash: record.snapshotHash,
      sources: sourceRows,
      rubric,
      correctnessSelfReviewPresent: Boolean(correctness),
      calculations,
      workbooks,
    })
    visibility.push({
      taskId: id,
      asOf: snapshot.asOf,
      capturedAt: snapshot.capturedAt,
      availabilitySignalsWithinCutoff: true,
      ...(snapshot.visibilityRule === "explicit-release-with-school-structural-fallback-v1"
        ? {
            visibilityRule: snapshot.visibilityRule,
            inferredSourceCount: snapshot.sources.filter((source) =>
              source.availabilitySignals.some((signal) => signal.field.startsWith("school.")),
            ).length,
          }
        : {}),
      historicalVisibilityVerified: false,
      unknownAvailabilityExcluded: snapshot.excluded.filter((entry) =>
        /Unknown availability|Invalid availability/.test(entry.reason),
      ).length,
      futureAvailabilityExcluded: snapshot.excluded.filter((entry) =>
        /future availability/.test(entry.reason),
      ).length,
    })
    sections.push(
      `## ${literal(id)}: ${record.task.kind}${record.task.assignment ? ` ${record.task.assignment.mode}` : ""}`,
      `Output: ${record.completion.output} (${record.completion.outputHash})`,
      `Fixed snapshot: ${record.simulationId} (${record.snapshotHash})`,
      "",
      "### Source citation inventory — not substantive coverage",
      ...sourceRows.map(
        (source) =>
          `- ${literal(source.path)} — exact citation present: ${source.exactCitationPresent}; source SHA-256 ${source.hash}; claim support: HUMAN REVIEW REQUIRED`,
      ),
      "",
      "### Rubric criteria from explicit review-only references",
      ...(rubric.length
        ? rubric.map(
            (entry) =>
              `- ${literal(entry.criterion)} (${literal(entry.reference)}) — literal mention: ${entry.literalMention}; coverage/grade: UNSCORED`,
          )
        : ["No rubric criteria supplied; do not invent ground truth or assume full credit."]),
      "",
      "### Correctness self-review (untrusted output text)",
      correctness
        ? quote(correctness)
        : "No correctness self-review found; grounding needs human inspection.",
      "",
      "### Arithmetic records — recomputed, not independently source-grounded",
      `Records: ${calculations.records.length}; inventory SHA-256: ${calculations.recordsHash}; recipe SHA-256: ${calculations.recipeHash}`,
      "These supplied inputs and results are review evidence, not proof of input grounding, historical execution time, answer coverage or academic correctness. Check inputs against the frozen materials and results against the actual output. Source links are context only.",
      ...(calculations.records.length
        ? calculations.records.flatMap((entry) => [
            `Record ${entry.id}; recorded at ${entry.at} (not independently authenticated):`,
            quote(JSON.stringify(entry.results, null, 2)),
          ])
        : [
            "No arithmetic records were captured. This is not evidence that the output has no derived values or that its numbers are verified.",
          ]),
      "",
      "### Workbook companions — validated values-only bytes, not academic correctness",
      `Companions: ${workbooks.records.length}; inventory SHA-256: ${workbooks.recordsHash}`,
      ...workbooks.records.map(
        (entry) =>
          `- ${literal(entry.output)} (${entry.hash}); normalized input SHA-256 ${entry.inputHash}; sheets ${entry.sheets.map(literal).join(", ")}. ${entry.automatic ? `Automatically extracted from saved candidate ${entry.automatic.candidateHash}, not a calculation.` : "Explicit values-only input, not a grounding check."} Open the private workbook and independently verify each value against frozen materials and calculations.`,
      ),
      "An empty captured inventory is not proof that no spreadsheet deliverable was required. Cell contents remain in private workbook and candidate/input evidence; this index does not establish grounding, completeness or historical execution. Automatic companion recipe timestamps are not execution-time evidence.",
      "",
    )
  }
  if (matchedFeedback.size !== feedbackReferences.length)
    throw new Error("Selected feedback does not match a captured evaluation assignment identity")
  const id = randomUUID(),
    directory = join(vault, "_meta/simulation-comparisons", id)
  const comparison = [
    "# Ground-truth review comparison",
    `Selected course: ${literal(course.code)}`,
    "",
    "Review source/rubric coverage, not similarity to a final submission. Exact citations and literal criterion mentions are mechanical indicators, not claim support, academic quality, grades or policy permission. References are review-only and never inserted into the earlier generation snapshots.",
    "",
    ...sections,
    "## Visibility bounds",
    ...visibility.map(
      (entry) =>
        `- ${entry.taskId}: recorded availability signals are within ${entry.asOf}; unknown excluded=${entry.unknownAvailabilityExcluded}; future excluded=${entry.futureAvailabilityExcluded}; actual historical visibility/file versions remain UNVERIFIED.`,
    ),
    "",
    "## Review-only reference inventory",
    ...references.map(
      (entry) => `- ${literal(entry.path)} (${entry.hash}); criteria=${entry.criteria.length}`,
    ),
    "",
    "## Explicit cached feedback — review only, not generation or verified ground truth",
    "These selected self-submission cache values are private untrusted observations. Current grade, author identity and account subject are not independently verified; checkedAt is not a new live fetch. Only exact captured assignment identities receive these rubric indicators. Never copy this private feedback into coursework or use it to rewrite earlier generation context.",
    ...feedbackReferences.flatMap((record) => [
      `Assignment ${record.assignmentId}; checked ${record.checkedAt}; archive ${reviewFeedbackPath(record)}; SHA-256 ${record.dataHash}`,
      quote(JSON.stringify(record.data, null, 2)),
    ]),
    "",
    "Human verdict: PENDING. Do not auto-pass M1 or approve coursework.",
    "",
  ].join("\n")
  const scorecard = [
    "# Anchored human scorecard",
    "",
    "A human chooses one rating per artifact; never auto-score usefulness.",
    "- 1 — unusable without a full rewrite.",
    "- 2 — useful fragments; substantial restructuring required.",
    "- 3 — workable direction; material edits needed.",
    "- 4 — useful starting point; light edits needed.",
    "- 5 — ready to use with trivial changes.",
    "",
    "| Artifact | Anchored 1–5 | Grounding / missing-context notes |",
    "| --- | --- | --- |",
    ...artifacts.map(
      (entry) =>
        `| ${entry.id}: ${entry.kind}${entry.mode ? ` ${entry.mode}` : ""} | ______ | ______ |`,
    ),
    "",
    "M1 threshold: no artifact below 3 and median at least 4; independently check grounding, zero leakage, visibility uncertainty and Canvas/syllabus discrepancies. Scores and verdict remain pending until explicit human review.",
    "",
  ].join("\n")
  const evidence = JSON.stringify({
    version: 1,
    id,
    course: course.code,
    calculationEvidenceVersion: 1,
    workbookEvidenceVersion: 1,
    rubricEvidenceVersion: 1,
    feedbackReferences,
    artifacts,
    visibility,
    references,
    comparisonHash: hash(comparison),
    scorecardHash: hash(scorecard),
    verdict: "pending-human",
    historicalVerified: false,
  })
  if (
    Buffer.byteLength(comparison) + Buffer.byteLength(scorecard) + Buffer.byteLength(evidence) >
    20_000_000
  )
    throw new Error("Comparison bundle exceeds 20 MB")
  await assertNoSymlinks(directory, true)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await assertNoSymlinks(directory)
  await writeFile(join(directory, "comparison.md"), comparison, { flag: "wx", mode: 0o600 })
  await writeFile(join(directory, "scorecard.md"), scorecard, { flag: "wx", mode: 0o600 })
  await writeFile(join(directory, "evidence.json"), evidence, { flag: "wx", mode: 0o600 })
  await writeFile(
    join(directory, "integrity.json"),
    JSON.stringify({ version: 1, id, evidenceHash: hash(evidence) }),
    { flag: "wx", mode: 0o600 },
  )
  return {
    id,
    comparison: `_meta/simulation-comparisons/${id}/comparison.md`,
    scorecard: `_meta/simulation-comparisons/${id}/scorecard.md`,
    artifacts: artifacts.length,
    references: references.length,
    feedbackReferences: feedbackReferences.length,
    workbookCompanions: artifacts.reduce(
      (count, artifact) => count + artifact.workbooks.records.length,
      0,
    ),
    calculationRecords: artifacts.reduce(
      (count, artifact) => count + artifact.calculations.records.length,
      0,
    ),
    verdict: "pending-human",
    historicalVerified: false,
  }
}
export async function readSimulationComparison(vaultPath: string, courseQuery: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new Error("Comparison ID must be a UUID")
  const vault = resolve(vaultPath),
    course = selectCourse(await inspectWorkspace(vault), courseQuery),
    directory = join(vault, "_meta/simulation-comparisons", id)
  const raw = await privateText(join(directory, "evidence.json"))
  const integrity = z
    .object({ version: z.literal(1), id: z.string().uuid(), evidenceHash: digestSchema })
    .strict()
    .parse(JSON.parse(await privateText(join(directory, "integrity.json"))))
  if (integrity.id !== id || integrity.evidenceHash !== hash(raw))
    throw new Error("Comparison evidence hash mismatch")
  const record = evidenceSchema.parse(JSON.parse(raw))
  if (record.rubricEvidenceVersion === 1) {
    await verifyReviewFeedback(vault, course, record.feedbackReferences ?? [])
    if (
      record.references.some(
        (reference) =>
          hash(reference.text) !== reference.hash ||
          JSON.stringify(rubricCriteria(reference.text)) !== JSON.stringify(reference.criteria),
      )
    )
      throw new Error("Comparison reference snapshot hash changed")
  }
  if (
    record.id !== id ||
    record.course !== course.code ||
    new Set(record.artifacts.map((item) => item.id)).size !== record.artifacts.length
  )
    throw new Error("Comparison identity/course mismatch")
  const comparison = await privateText(join(directory, "comparison.md")),
    scorecard = await privateText(join(directory, "scorecard.md"))
  if (hash(comparison) !== record.comparisonHash || hash(scorecard) !== record.scorecardHash)
    throw new Error("Comparison or scorecard changed after packaging")
  const matchedReviewFeedback = new Set<string>()
  for (const artifact of record.artifacts) {
    const current = await inspectSimulationTask(vault, artifact.id)
    if (
      current.state !== "completed-pending-human" ||
      !current.completion ||
      current.task.course.root !== course.root ||
      current.task.course.code !== course.code ||
      current.completion.output !== artifact.output ||
      current.completion.outputHash !== artifact.outputHash ||
      current.snapshotHash !== artifact.snapshotHash ||
      current.simulationId !== artifact.simulationId
    )
      throw new Error("Comparison artifact binding changed")
    const output = await privateText(join(vault, current.completion.output))
    if (record.rubricEvidenceVersion === 1) {
      const assignmentId = current.task.sources.find(
        (source) => source.path === current.task.assignment?.source,
      )?.canvasId
      if (
        assignmentId &&
        record.feedbackReferences?.some((entry) => entry.assignmentId === assignmentId)
      )
        matchedReviewFeedback.add(assignmentId)
      const expected = [
        ...record.references.flatMap((reference) =>
          reference.criteria.map((criterion) => ({ reference: reference.path, criterion })),
        ),
        ...feedbackCriterionRows(record.feedbackReferences ?? [], assignmentId),
      ].map((entry) => ({
        ...entry,
        literalMention: normalized(output).includes(
          normalized(entry.criterion.replace(/[-_]+/g, " ")),
        ),
        humanCoverage: "unscored" as const,
      }))
      if (JSON.stringify(expected) !== JSON.stringify(artifact.rubric))
        throw new Error("Comparison rubric indicators differ from captured review evidence")
    }
    const sources = [...current.task.sources, ...current.task.guidance].map((source) => ({
      path: source.path,
      hash: source.hash,
      exactCitationPresent: output.includes(`\`${source.path}\``),
    }))
    if (
      hash(output) !== artifact.outputHash ||
      artifact.kind !== current.task.kind ||
      artifact.mode !== (current.task.assignment?.mode ?? null) ||
      JSON.stringify(artifact.period) !== JSON.stringify(current.task.period ?? null) ||
      JSON.stringify(artifact.sources) !== JSON.stringify(sources)
    )
      throw new Error("Comparison source/recipe evidence differs from the validated artifact")
    const snapshot = await replaySimulation(vault, current.simulationId)
    if (record.calculationEvidenceVersion === 1) {
      const calculations = await readSimulationCalculations(vault, artifact.id)
      if (JSON.stringify(artifact.calculations) !== JSON.stringify(calculations))
        throw new Error(
          "Comparison arithmetic evidence changed; create a fresh comparison after review",
        )
    }
    if (record.workbookEvidenceVersion === 1) {
      const workbooks = await readSimulationWorkbooks(vault, artifact.id)
      if (JSON.stringify(artifact.workbooks) !== JSON.stringify(workbooks))
        throw new Error(
          "Comparison workbook evidence changed; create a fresh comparison after review",
        )
    }
    const visibility = record.visibility.find((item) => item.taskId === artifact.id)
    if (
      !visibility ||
      visibility.asOf !== snapshot.asOf ||
      visibility.capturedAt !== snapshot.capturedAt ||
      visibility.visibilityRule !==
        (snapshot.visibilityRule === "explicit-release-with-school-structural-fallback-v1"
          ? snapshot.visibilityRule
          : undefined) ||
      visibility.inferredSourceCount !==
        (snapshot.visibilityRule === "explicit-release-with-school-structural-fallback-v1"
          ? snapshot.sources.filter((source) =>
              source.availabilitySignals.some((signal) => signal.field.startsWith("school.")),
            ).length
          : undefined) ||
      visibility.unknownAvailabilityExcluded !==
        snapshot.excluded.filter((entry) =>
          /Unknown availability|Invalid availability/.test(entry.reason),
        ).length ||
      visibility.futureAvailabilityExcluded !==
        snapshot.excluded.filter((entry) => /future availability/.test(entry.reason)).length
    )
      throw new Error("Comparison visibility evidence differs from the frozen snapshot")
  }
  if (
    record.visibility.length !== record.artifacts.length ||
    new Set(record.visibility.map((item) => item.taskId)).size !== record.artifacts.length
  )
    throw new Error("Comparison visibility inventory does not match its artifacts")
  if (
    record.rubricEvidenceVersion === 1 &&
    matchedReviewFeedback.size !== record.feedbackReferences?.length
  )
    throw new Error("Comparison feedback inventory does not match captured assignment identities")
  return { ...record, comparison, scorecard }
}
