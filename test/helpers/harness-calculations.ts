import { readFileSync } from "node:fs"

export type HarnessOperation =
  | "sum"
  | "mean"
  | "add"
  | "subtract"
  | "multiply"
  | "divide"
  | "power"
  | "min"
  | "max"

export interface HarnessCalculationInput {
  operation: HarnessOperation
  values: number[]
  source?: string
}

export interface HarnessCalculation {
  operation: HarnessOperation
  result: number
  source?: { path: string }
}

/** Executes synthetic arithmetic in the coding harness, outside the CLI. */
export function harnessCalculations(operations: HarnessCalculationInput[]): HarnessCalculation[] {
  return operations.map(({ operation, values, source }) => {
    if (!values.length || values.some((value) => !Number.isFinite(value)))
      throw new Error("Harness calculations require finite numeric inputs")
    const [first, second] = values
    const result = {
      sum: () => values.reduce((total, value) => total + value, 0),
      mean: () => values.reduce((total, value) => total + value, 0) / values.length,
      add: () => binary(first, second, (a, b) => a + b),
      subtract: () => binary(first, second, (a, b) => a - b),
      multiply: () => binary(first, second, (a, b) => a * b),
      divide: () => binary(first, second, (a, b) => a / b),
      power: () => binary(first, second, (a, b) => a ** b),
      min: () => Math.min(...values),
      max: () => Math.max(...values),
    }[operation]()
    if (!Number.isFinite(result))
      throw new Error("Harness calculation did not produce a finite result")
    return { operation, result, ...(source ? { source: { path: source } } : {}) }
  })
}

export function harnessCalculationsFromFile(path: string): HarnessCalculation[] {
  const batch = JSON.parse(readFileSync(path, "utf8")) as { operations?: HarnessCalculationInput[] }
  if (!Array.isArray(batch.operations)) throw new Error("Fixture must contain an operations array")
  return harnessCalculations(batch.operations)
}

function binary(
  left: number | undefined,
  right: number | undefined,
  calculate: (left: number, right: number) => number,
): number {
  if (left === undefined || right === undefined)
    throw new Error("Harness binary operations require exactly two values")
  return calculate(left, right)
}
