import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { comparisonM1Bundle } from "../src/m1.js"
import { captureSimulation } from "../src/simulation.js"
import { calculateSimulationBatch } from "../src/simulation-calculations.js"
import {
  compareSimulationEvaluations,
  readSimulationComparison,
} from "../src/simulation-comparison.js"
import {
  completeSimulationTask,
  createSimulationTask,
  readSimulationTask,
} from "../src/simulation-tasks.js"
import { createSimulationWorkbook } from "../src/simulation-workbooks.js"

const roots: string[] = []
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "canvas-sim-compare-"))
  roots.push(base)
  const root = join(base, "vault")
  await mkdir(join(root, "CS101/Week 01 - Oct 5"), { recursive: true })
  await writeFile(
    join(root, "CS101/Week 01 - Oct 5/reading.md"),
    "---\navailable_at: 2026-10-05\n---\nSynthetic course reading.\n",
  )
  const snapshot = await captureSimulation(root, "CS101", "2026-10-09")
  const task = await createSimulationTask(root, snapshot.id, { kind: "prep", week: "2026-10-05" })
  const record = await readSimulationTask(root, task.id)
  const candidate = join(root, "candidate.md")
  await writeFile(
    candidate,
    [
      `Task: ${task.id}`,
      ...record.task.requirements.map(
        (heading) =>
          `## ${heading}\n\n${heading === "Sources" ? `\`${record.task.sources[0]?.path}\`` : "Synthetic literal mention: strategic reasoning. No academic grade is implied."}`,
      ),
      "## Correctness check\nVerified: synthetic source claim only.\n",
    ].join("\n\n"),
  )
  const complete = () => completeSimulationTask(root, task.id, candidate)
  return { root, snapshot, task, candidate, complete }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe("fixed snapshot evaluation comparison", () => {
  it("captures private workbook companions through comparison/M1 and rejects later additions", async () => {
    const { root, task, complete } = await fixture()
    const input = join(root, "sheets.json")
    await writeFile(
      input,
      JSON.stringify({ sheets: [{ name: "Pricing", rows: [["PRIVATE_CELL_LABEL", 500]] }] }),
    )
    const book = await createSimulationWorkbook(root, task.id, input)
    await complete()
    const comparison = await compareSimulationEvaluations(root, "CS101", [task.id])
    expect(comparison.workbookCompanions).toBe(1)
    const saved = await readSimulationComparison(root, "CS101", comparison.id)
    expect(saved.artifacts[0]?.workbooks?.records[0]?.hash).toBe(book.hash)
    expect(saved.comparison).not.toContain("PRIVATE_CELL_LABEL")
    const gate = await comparisonM1Bundle(root, "CS101", comparison.id)
    expect(gate).toMatchObject({
      workbookEvidenceCaptured: true,
      workbookCompanions: 1,
      verdict: "pending-human",
    })
    const gates = await readdir(join(root, "_meta/gates/m1"))
    await createSimulationWorkbook(root, task.id, input)
    await expect(comparisonM1Bundle(root, "CS101", comparison.id)).rejects.toThrow(
      /workbook evidence changed/,
    )
    expect(await readdir(join(root, "_meta/gates/m1"))).toEqual(gates)
  })
  it("binds an empty workbook inventory and refuses modified workbook bytes before M1", async () => {
    const { root, task, complete } = await fixture()
    await complete()
    const empty = await compareSimulationEvaluations(root, "CS101", [task.id])
    const input = join(root, "sheets.json")
    await writeFile(input, JSON.stringify({ sheets: [{ name: "Data", rows: [[1, 2]] }] }))
    const book = await createSimulationWorkbook(root, task.id, input)
    await expect(comparisonM1Bundle(root, "CS101", empty.id)).rejects.toThrow(
      /workbook evidence changed/,
    )
    const current = await compareSimulationEvaluations(root, "CS101", [task.id])
    await writeFile(join(root, book.output), "Changed workbook.")
    await expect(comparisonM1Bundle(root, "CS101", current.id)).rejects.toThrow(/bytes changed/)
    await expect(readdir(join(root, "_meta/gates/m1"))).rejects.toThrow()
  })
  it("keeps legacy workbook evidence unknown without rewriting the comparison", async () => {
    const { root, task, complete } = await fixture()
    await complete()
    const comparison = await compareSimulationEvaluations(root, "CS101", [task.id])
    const directory = join(root, "_meta/simulation-comparisons", comparison.id)
    const old = JSON.parse(await readFile(join(directory, "evidence.json"), "utf8"))
    delete old.workbookEvidenceVersion
    for (const artifact of old.artifacts) delete artifact.workbooks
    const text = (await readFile(join(directory, "comparison.md"), "utf8")).replace(
      /^### Workbook companions[\s\S]*?(?=^## |$(?![\s\S]))/gm,
      "",
    )
    old.comparisonHash = createHash("sha256").update(text).digest("hex")
    const bytes = JSON.stringify(old)
    await writeFile(join(directory, "comparison.md"), text)
    await writeFile(join(directory, "evidence.json"), bytes)
    await writeFile(
      join(directory, "integrity.json"),
      JSON.stringify({
        version: 1,
        id: comparison.id,
        evidenceHash: createHash("sha256").update(bytes).digest("hex"),
      }),
    )
    const gate = await comparisonM1Bundle(root, "CS101", comparison.id)
    expect(gate).toMatchObject({ workbookEvidenceCaptured: false, workbookCompanions: null })
    expect(await readFile(join(root, gate.path), "utf8")).toContain(
      "older comparison did not capture workbook",
    )
    expect(await readFile(join(directory, "evidence.json"), "utf8")).toBe(bytes)
  })
  it("runs compiled comparison and M1 commands without exposing source bodies or auto-passing", async () => {
    const { root, task, complete } = await fixture()
    await calculateSimulationBatch(root, task.id, [
      { operation: "sum", values: [1800, -300, -1000] },
    ])
    const completed = await complete()
    const original = await readFile(join(root, completed.output), "utf8")
    const config = join(root, "..", "config.json")
    const cli = (args: string[]) =>
      spawnSync(process.execPath, [resolve("dist/cli.js"), ...args, "--config", config], {
        encoding: "utf8",
      })
    expect(
      cli(["init", "--vault", root, "--canvas-url", "https://canvas.example.test"]).status,
    ).toBe(0)
    const sheets = join(root, "private-sheets.json")
    await writeFile(
      sheets,
      JSON.stringify({ sheets: [{ name: "Pricing", rows: [["PRIVATE_WORKBOOK_CELL", 500]] }] }),
    )
    expect(cli(["simulate", "task", "workbook", task.id, "--file", sheets, "--json"]).status).toBe(
      0,
    )
    const compared = cli(["simulate", "compare", "--course", "CS101", "--task", task.id, "--json"])
    expect(compared.status, compared.stderr).toBe(0)
    const metadata = JSON.parse(compared.stdout)
    expect(metadata).toMatchObject({
      artifacts: 1,
      verdict: "pending-human",
      historicalVerified: false,
      calculationRecords: 1,
      workbookCompanions: 1,
    })
    expect(compared.stdout).not.toContain("Synthetic literal mention")
    const gated = cli(["gate", "m1", "--course", "CS101", "--comparison", metadata.id, "--json"])
    expect(gated.status, gated.stderr).toBe(0)
    const gate = JSON.parse(gated.stdout)
    expect(gate).toMatchObject({
      comparisonId: metadata.id,
      artifacts: 1,
      verdict: "pending-human",
      calculationEvidenceCaptured: true,
      calculationRecords: 1,
      workbookEvidenceCaptured: true,
      workbookCompanions: 1,
    })
    expect(await readFile(join(root, gate.path), "utf8")).toContain(
      "STOP until the student explicitly records the verdict",
    )
    const gateEvidence = JSON.parse(
      await readFile(join(root, gate.path, "..", "evidence.json"), "utf8"),
    )
    expect(gateEvidence.artifacts[0].calculations.records[0].results[0].result).toBe(500)
    expect(await readFile(join(root, gate.path), "utf8")).toContain('"result": 500')
    expect(compared.stdout + gated.stdout).not.toContain('"input"')
    expect(compared.stdout + gated.stdout).not.toContain("PRIVATE_WORKBOOK_CELL")
    expect(await readFile(join(root, completed.output), "utf8")).toBe(original)
    for (const options of [
      [],
      ["--run", "legacy", "--comparison", metadata.id],
      ["--comparison", "../outside"],
    ]) {
      expect(cli(["gate", "m1", "--course", "CS101", ...options, "--json"]).status).toBe(1)
    }
    expect(
      cli(["simulate", "compare", "--course", "CS101", "--task", "../outside", "--json"]).status,
    ).toBe(1)
  })
  it("binds even an empty arithmetic inventory and rejects later appended records until a fresh comparison", async () => {
    const { root, task, complete } = await fixture()
    await complete()
    const first = await compareSimulationEvaluations(root, "CS101", [task.id])
    const original = await readFile(join(root, first.comparison))
    const saved = await readSimulationComparison(root, "CS101", first.id)
    expect(saved.calculationEvidenceVersion).toBe(1)
    expect(saved.artifacts[0]?.calculations?.records).toEqual([])
    await calculateSimulationBatch(root, task.id, [{ operation: "multiply", values: [2, 3] }])
    await expect(comparisonM1Bundle(root, "CS101", first.id)).rejects.toThrow(
      /arithmetic evidence changed/,
    )
    await expect(readdir(join(root, "_meta/gates/m1"))).rejects.toThrow()
    const second = await compareSimulationEvaluations(root, "CS101", [task.id])
    expect(second.calculationRecords).toBe(1)
    expect((await comparisonM1Bundle(root, "CS101", second.id)).verdict).toBe("pending-human")
    expect(await readFile(join(root, first.comparison))).toEqual(original)
  })
  it("rejects modified or missing arithmetic records before creating an M1 gate", async () => {
    const { root, task, complete } = await fixture()
    const calculation = await calculateSimulationBatch(root, task.id, [
      { operation: "sum", values: [1, 2] },
    ])
    const completed = await complete()
    const output = await readFile(join(root, completed.output))
    const comparison = await compareSimulationEvaluations(root, "CS101", [task.id])
    const path = join(
      root,
      "_meta/simulations/tasks",
      task.id,
      "calculations",
      `${calculation.id}.json`,
    )
    const bytes = await readFile(path, "utf8")
    const changed = JSON.parse(bytes)
    changed.results[0].result = 999
    await writeFile(path, JSON.stringify(changed))
    await expect(comparisonM1Bundle(root, "CS101", comparison.id)).rejects.toThrow(/arithmetic/)
    await writeFile(path, bytes)
    expect(
      (await readSimulationComparison(root, "CS101", comparison.id)).artifacts[0]?.calculations
        ?.records,
    ).toHaveLength(1)
    await unlink(path) // Synthetic missing-evidence fixture, not student data.
    await expect(comparisonM1Bundle(root, "CS101", comparison.id)).rejects.toThrow(
      /arithmetic evidence changed/,
    )
    await expect(readdir(join(root, "_meta/gates/m1"))).rejects.toThrow()
    expect(await readFile(join(root, completed.output))).toEqual(output)
  })
  it("keeps older comparison arithmetic explicitly uncaptured instead of inventing a zero or retrofitting logs", async () => {
    const { root, task, complete } = await fixture()
    await complete()
    const comparison = await compareSimulationEvaluations(root, "CS101", [task.id])
    const directory = join(root, "_meta/simulation-comparisons", comparison.id)
    const old = JSON.parse(await readFile(join(directory, "evidence.json"), "utf8"))
    // Coherent synthetic old-format bundle; no real saved comparison is rewritten.
    delete old.calculationEvidenceVersion
    for (const artifact of old.artifacts) delete artifact.calculations
    const text = (await readFile(join(directory, "comparison.md"), "utf8")).replace(
      /^### Arithmetic records[\s\S]*?(?=^## |$(?![\s\S]))/gm,
      "",
    )
    old.comparisonHash = createHash("sha256").update(text).digest("hex")
    const bytes = JSON.stringify(old)
    await writeFile(join(directory, "comparison.md"), text)
    await writeFile(join(directory, "evidence.json"), bytes)
    await writeFile(
      join(directory, "integrity.json"),
      JSON.stringify({
        version: 1,
        id: comparison.id,
        evidenceHash: createHash("sha256").update(bytes).digest("hex"),
      }),
    )
    await calculateSimulationBatch(root, task.id, [{ operation: "sum", values: [10, 20] }])
    const gate = await comparisonM1Bundle(root, "CS101", comparison.id)
    expect(gate.calculationEvidenceCaptured).toBe(false)
    expect(gate.calculationRecords).toBeNull()
    expect(await readFile(join(root, gate.path), "utf8")).toContain("absence is unknown")
    expect(await readFile(join(directory, "evidence.json"), "utf8")).toBe(bytes)
  })
  it.each(["comparison.md", "scorecard.md", "evidence.json"])(
    "rejects changed saved %s before creating a gate",
    async (file) => {
      const { root, task, complete } = await fixture()
      await complete()
      const result = await compareSimulationEvaluations(root, "CS101", [task.id])
      expect((await readSimulationComparison(root, "CS101", result.id)).artifacts).toHaveLength(1)
      const path = join(root, "_meta/simulation-comparisons", result.id, file)
      await writeFile(path, `${await readFile(path, "utf8")}\nChanged.`)
      await expect(comparisonM1Bundle(root, "CS101", result.id)).rejects.toThrow(
        /changed|hash mismatch/,
      )
      await expect(readdir(join(root, "_meta/gates/m1"))).rejects.toThrow()
    },
  )
  it("rechecks parent output rather than trusting the packaged comparison", async () => {
    const { root, task, complete } = await fixture()
    const completed = await complete()
    const result = await compareSimulationEvaluations(root, "CS101", [task.id])
    await writeFile(join(root, completed.output), "Changed parent output.")
    await expect(comparisonM1Bundle(root, "CS101", result.id)).rejects.toThrow(
      /changed after completion/,
    )
    await expect(readdir(join(root, "_meta/gates/m1"))).rejects.toThrow()
  })
  it("derives visibility from the frozen snapshot even if a modified evidence checksum is supplied", async () => {
    const { root, task, complete } = await fixture()
    await complete()
    const result = await compareSimulationEvaluations(root, "CS101", [task.id])
    const directory = join(root, "_meta/simulation-comparisons", result.id)
    const evidence = JSON.parse(await readFile(join(directory, "evidence.json"), "utf8"))
    evidence.visibility[0].unknownAvailabilityExcluded += 1
    const raw = JSON.stringify(evidence)
    await writeFile(join(directory, "evidence.json"), raw)
    await writeFile(
      join(directory, "integrity.json"),
      JSON.stringify({
        version: 1,
        id: result.id,
        evidenceHash: createHash("sha256").update(raw).digest("hex"),
      }),
    )
    await expect(comparisonM1Bundle(root, "CS101", result.id)).rejects.toThrow(
      /visibility evidence differs/,
    )
    await expect(readdir(join(root, "_meta/gates/m1"))).rejects.toThrow()
  })
  it("refuses completed outputs from a different explicit course", async () => {
    const { root, task, complete } = await fixture()
    await complete()
    await mkdir(join(root, "OTHER101"))
    await writeFile(join(root, "OTHER101/notes.md"), "Other synthetic course context.")
    await expect(compareSimulationEvaluations(root, "OTHER101", [task.id])).rejects.toThrow(
      /explicit course/,
    )
    await expect(readdir(join(root, "_meta/simulation-comparisons"))).rejects.toThrow()
  })
  it("packages validated outputs, explicit review-only rubric evidence and unscored anchored scorecards", async () => {
    const { root, task, complete } = await fixture()
    const completed = await complete()
    const original = await readFile(join(root, completed.output), "utf8")
    await mkdir(join(root, "CS101/Assignments"))
    const reference = "CS101/Assignments/Feedback.md"
    await writeFile(
      join(root, reference),
      '---\ntype: feedback\n---\nRubric assessment:\n```json\n{"strategic_reasoning":{"points":2},"evidence_quality":{"points":1}}\n```\n',
    )
    const result = await compareSimulationEvaluations(root, "CS101", [task.id], [reference])
    expect(result).toMatchObject({
      artifacts: 1,
      references: 1,
      verdict: "pending-human",
      historicalVerified: false,
    })
    const comparison = await readFile(join(root, result.comparison), "utf8")
    expect(comparison).toContain("strategic_reasoning")
    expect(comparison).toContain("coverage/grade: UNSCORED")
    expect(comparison).toContain("historical visibility/file versions remain UNVERIFIED")
    const scorecard = await readFile(join(root, result.scorecard), "utf8")
    expect(scorecard).toContain("never auto-score usefulness")
    expect(scorecard).toContain("| ______ | ______ |")
    expect(await readFile(join(root, completed.output), "utf8")).toBe(original)
    const second = await compareSimulationEvaluations(root, "CS101", [task.id])
    expect(second.id).not.toBe(result.id)
    expect(await readFile(join(root, second.comparison), "utf8")).toContain(
      "No rubric criteria supplied",
    )
  })
  it("rejects pending/tampered outputs and duplicate task IDs without writing a comparison", async () => {
    const { root, task, complete } = await fixture()
    await expect(compareSimulationEvaluations(root, "CS101", [task.id])).rejects.toThrow(
      /completed evaluation outputs/,
    )
    await expect(compareSimulationEvaluations(root, "CS101", [task.id, task.id])).rejects.toThrow(
      /distinct completed/,
    )
    const completed = await complete()
    await writeFile(join(root, completed.output), "Tampered output.")
    await expect(compareSimulationEvaluations(root, "CS101", [task.id])).rejects.toThrow(
      /changed after completion/,
    )
    await expect(readdir(join(root, "_meta/simulation-comparisons"))).rejects.toThrow()
  })
  it("rejects missing/restricted references and malformed rubric JSON instead of inventing ground truth", async () => {
    const { root, task, complete } = await fixture()
    await complete()
    await expect(
      compareSimulationEvaluations(root, "CS101", [task.id], ["OTHER101/feedback.md"]),
    ).rejects.toThrow(/eligible source/)
    await mkdir(join(root, "CS101/Assignments"))
    const reference = "CS101/Assignments/Feedback.md"
    await writeFile(
      join(root, reference),
      "---\ntype: feedback\nai_policy: prohibited\n---\nRestricted material.\n",
    )
    await expect(
      compareSimulationEvaluations(root, "CS101", [task.id], [reference]),
    ).rejects.toThrow(/eligible source/)
    await writeFile(
      join(root, reference),
      "---\ntype: feedback\n---\nRubric assessment:\n```json\nnot-json\n```\n",
    )
    await expect(
      compareSimulationEvaluations(root, "CS101", [task.id], [reference]),
    ).rejects.toThrow()
    await expect(readdir(join(root, "_meta/simulation-comparisons"))).rejects.toThrow()
  })
})
