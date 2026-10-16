import { describe, expect, it } from "vitest"
import {
  calculateValues,
  parseCalculationBatch,
} from "../../src/tasks/calculations/calculation-core.js"
import { createWorkbook, parseWorkbookInput } from "../../src/tasks/calculations/workbook.js"

describe("task tool seams", () => {
  it("keeps arithmetic and batch parsing independent from task storage", () => {
    expect(calculateValues("sum", [2, 3, 5])).toBe(10)
    expect(parseCalculationBatch({ operations: [{ operation: "mean", values: [2, 4] }] })).toEqual([
      { operation: "mean", values: [2, 4] },
    ])
    expect(() =>
      parseCalculationBatch({ operations: [{ operation: "sum", values: [Infinity] }] }),
    ).toThrow()
  })

  it("renders deterministic values-only workbook bytes from validated input", async () => {
    const input = parseWorkbookInput({
      sheets: [
        {
          name: "Results",
          rows: [
            ["Total", 5],
            ["Ready", true],
          ],
        },
      ],
    })
    expect(await createWorkbook(input)).toEqual(await createWorkbook(input))
    expect(() => parseWorkbookInput({ sheets: [{ name: "Bad/Name", rows: [] }] })).toThrow()
  })
})
