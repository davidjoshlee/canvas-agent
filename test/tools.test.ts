import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createPrepTask, readTask } from "../src/tasks.js"
import {
  CALCULATION_OPERATIONS,
  calculateTask,
  calculateValues,
  compareTasks,
  createWorkbook,
  inspectTask,
  parseCalculationBatch,
  parseWorkbookInput,
  reviewGate,
  workbookTask,
} from "../src/tools.js"
import type { ToolkitConfig } from "../src/types.js"

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-tools-"))
  roots.push(root)
  const course = join(root, "ACCT312", "Week 42")
  await mkdir(course, { recursive: true })
  await writeFile(
    join(course, "Reading.md"),
    "---\ndates:\n  date: 2026-10-12\n---\n# Reading\nApproved evidence.\n",
  )
  const config: ToolkitConfig = {
    version: 1,
    canvas: { baseUrl: "https://canvas.example", tokenEnv: "UNUSED" },
    vault: { path: root },
    courses: { allowlist: [] },
  }
  return { root, config }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("task tools", () => {
  it("executes every advertised operation and returns supported names on an unsupported operation", () => {
    const expected = {
      sum: 6,
      mean: 3,
      median: 3,
      min: 2,
      max: 4,
      stddev: 1,
      npv: 6,
      add: 6,
      subtract: -2,
      multiply: 8,
      divide: 0.5,
      power: 16,
    }
    for (const operation of CALCULATION_OPERATIONS)
      expect(calculateValues(operation, [2, 4], operation === "npv" ? 0 : undefined)).toBe(
        expected[operation],
      )
    expect(() => calculateValues("product", [2, 4])).toThrow(
      `Supported operations: ${CALCULATION_OPERATIONS.join(", ")}`,
    )
  })
  it("calculates only finite supported operations against current task snapshots", async () => {
    const { root, config } = await fixture()
    const task = await createPrepTask(root, "ACCT312", "2026-10-12")
    await expect(
      calculateTask(config, {
        taskId: task.id,
        operation: "mean",
        values: "2,4,6",
        source: task.sources[0]?.path,
      }),
    ).resolves.toMatchObject({ result: 4, operation: "mean" })
    await expect(
      calculateTask(config, { taskId: task.id, operation: "divide", values: "1,0" }),
    ).rejects.toThrow("Division by zero")
    await expect(
      calculateTask(config, { taskId: task.id, operation: "sum", values: "1,NaN" }),
    ).rejects.toThrow("finite numbers")
    const log = await readFile(join(root, "_meta", "tasks", task.id, "calculations.jsonl"), "utf8")
    expect(log).toContain('"result":4')
    expect(log).not.toContain("NaN")
    await writeFile(join(root, "ACCT312", "Week 42", "Reading.md"), "changed")
    await expect(
      calculateTask(config, { taskId: task.id, operation: "sum", values: "2,3" }),
    ).rejects.toThrow("stale")
  })

  it("supports safe descriptive statistics, NPV, and strict bounded calculation batches", async () => {
    const { root, config } = await fixture()
    const task = await createPrepTask(root, "ACCT312", "2026-10-12")
    await expect(
      calculateTask(config, { taskId: task.id, operation: "median", values: "10,2,4,6" }),
    ).resolves.toMatchObject({ result: 5 })
    await expect(
      calculateTask(config, { taskId: task.id, operation: "stddev", values: "2,4,6" }),
    ).resolves.toMatchObject({ result: Math.sqrt(8 / 3) })
    const npv = await calculateTask(config, {
      taskId: task.id,
      operation: "npv",
      values: "-100,60,60",
      rate: 0.1,
    })
    expect(npv.result).toBeCloseTo(4.132231404958667)
    expect(npv.rate).toBe(0.1)
    await expect(
      calculateTask(config, { taskId: task.id, operation: "npv", values: "1,2" }),
    ).rejects.toThrow("NPV rate")
    expect(parseCalculationBatch({ operations: [{ operation: "min", values: [2, 1] }] })).toEqual([
      { operation: "min", values: [2, 1] },
    ])
    expect(() =>
      parseCalculationBatch({ operations: [{ operation: "sum", values: [1], code: "bad" }] }),
    ).toThrow("Each calculation")
    expect(() =>
      parseCalculationBatch({
        operations: [{ operation: "sum", values: [Number.POSITIVE_INFINITY] }],
      }),
    ).toThrow("finite")
  })

  it("inspects provenance and compares source and completed-output changes", async () => {
    const { root, config } = await fixture()
    const first = await createPrepTask(root, "ACCT312", "2026-10-12")
    const second = await createPrepTask(root, "ACCT312", "2026-10-12")
    expect(await inspectTask(root, first.id)).toMatchObject({
      id: first.id,
      snapshots: { current: true },
    })
    expect((await compareTasks(root, first.id, second.id)).sourceChanges).toEqual([])
    const candidate = join(root, "candidate.md")
    const draft = (id: string, body: string) =>
      `Task: ${id}\n\n${first.requirements.map((heading) => `## ${heading}\n\n${heading === "Sources" ? `- \`${first.sources[0]?.path}\`` : body}`).join("\n")}`
    await writeFile(candidate, draft(first.id, "One version."))
    const { completeTask } = await import("../src/completion.js")
    await completeTask(root, first.id, candidate)
    await writeFile(candidate, draft(second.id, "Another version."))
    await completeTask(root, second.id, candidate)
    const comparison = await compareTasks(root, first.id, second.id)
    expect(comparison.outputDiff.available).toBe(true)
    expect(comparison.outputDiff.added).toBeGreaterThan(0)
    expect(comparison.outputDiff.removed).toBeGreaterThan(0)
    const gate = await reviewGate(config, first.id)
    expect(gate.sections.every((item) => item.present)).toBe(true)
    expect(await readFile(join(root, gate.path), "utf8")).toContain(
      "does not assess factual accuracy",
    )
    const completedFirst = await readTask(root, first.id)
    const savedOutput = join(root, completedFirst.output as string)
    const external = join(root, "outside-output.md")
    await writeFile(external, "same bytes")
    await unlink(savedOutput)
    await symlink(external, savedOutput)
    await expect(compareTasks(root, first.id, first.id)).rejects.toThrow("Symbolic links")
  })

  it("creates bounded values-only workbooks and preserves prior artifacts", async () => {
    const { root, config } = await fixture()
    const task = await createPrepTask(root, "ACCT312", "2026-10-12")
    const parsed = parseWorkbookInput({
      sheets: [
        {
          name: "Data",
          rows: [
            ["Name", "Value"],
            ["A", 3],
            ["=1+1", null],
          ],
        },
      ],
    })
    const bytes = await createWorkbook(parsed)
    expect(bytes.subarray(0, 2).toString()).toBe("PK")
    expect(() => parseWorkbookInput({ sheets: [{ name: "Bad/Name", rows: [] }] })).toThrow(
      "valid Excel names",
    )
    expect(() => parseWorkbookInput({ sheets: [{ name: "x", rows: [[Number.NaN]] }] })).toThrow(
      "finite",
    )
    const input = join(root, "workbook.json")
    await writeFile(input, JSON.stringify({ sheets: [{ name: "Data", rows: [["Value"], [2]] }] }))
    const one = await workbookTask(config, task.id, input)
    const two = await workbookTask(config, task.id, input)
    await writeFile(input, "PRIVATE_INVALID_WORKBOOK_INPUT")
    await expect(workbookTask(config, task.id, input)).rejects.toThrow(
      "Workbook input must contain valid UTF-8 JSON",
    )
    const credential = join(root, ".env")
    await writeFile(credential, "PRIVATE_CREDENTIAL_FIXTURE")
    await expect(workbookTask(config, task.id, credential)).rejects.toThrow(/credential file/)
    expect(await readFile(credential, "utf8")).toBe("PRIVATE_CREDENTIAL_FIXTURE")
    expect(one.path).toMatch(/^ACCT312\/.+\/01 Workbook\.xlsx$/)
    expect(two.path).toContain("01 Workbook.v2.xlsx")
    expect(
      createHash("sha256")
        .update(await readFile(join(root, one.path)))
        .digest("hex"),
    ).toBe(one.hash)
  })

  it("audits extracted originals up to the document ingestion size bound", async () => {
    const { root } = await fixture()
    const original = Buffer.alloc(6 * 1024 * 1024, 0x61)
    const originalPath = "ACCT312/Week 42 - Oct 12/large.pdf"
    await mkdir(join(root, "ACCT312", "Week 42 - Oct 12"), { recursive: true })
    await writeFile(join(root, originalPath), original)
    const originalHash = createHash("sha256").update(original).digest("hex")
    await writeFile(
      join(root, `${originalPath}.extracted.md`),
      `---\noriginal_path: ${originalPath}\noriginal_hash: ${originalHash}\n---\n\nExtracted readable text.\n`,
    )
    const task = await createPrepTask(root, "ACCT312", "2026-10-12")
    expect(task.sources.some((source) => source.originalPath === originalPath)).toBe(true)
    expect((await inspectTask(root, task.id)).snapshots.current).toBe(true)
  })
})
