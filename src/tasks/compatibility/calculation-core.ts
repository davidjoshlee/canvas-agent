const _isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const CALCULATION_OPERATIONS = [
  "sum",
  "mean",
  "median",
  "min",
  "max",
  "stddev",
  "npv",
  "add",
  "subtract",
  "multiply",
  "divide",
  "power",
] as const
/** Pure bounded arithmetic shared by ordinary and fixed-evidence tasks. */
export function calculateValues(operation: string, values: number[], rate?: number): number {
  if (!values.length || values.length > 1000 || values.some((value) => !Number.isFinite(value)))
    throw new Error("Values must contain 1 to 1,000 finite numbers")
  if (operation !== "npv" && rate !== undefined) throw new Error("Rate is supported only for NPV")
  let result: number
  switch (operation) {
    case "sum":
      result = values.reduce((total, value) => total + value, 0)
      break
    case "mean":
      result = values.reduce((total, value) => total + value, 0) / values.length
      break
    case "median": {
      const sorted = [...values].sort((a, b) => a - b)
      const middle = Math.floor(sorted.length / 2)
      const middleValue = sorted[middle]
      const lowerMiddleValue = sorted[middle - 1]
      if (middleValue === undefined) throw new Error("Median requires at least one value")
      result =
        sorted.length % 2 ? middleValue : ((lowerMiddleValue ?? middleValue) + middleValue) / 2
      break
    }
    case "min":
      result = Math.min(...values)
      break
    case "max":
      result = Math.max(...values)
      break
    case "stddev": {
      const mean = values.reduce((total, value) => total + value, 0) / values.length
      result = Math.sqrt(
        values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length,
      )
      break
    }
    case "npv": {
      if (rate === undefined || !Number.isFinite(rate) || rate <= -1 || rate > 100)
        throw new Error("NPV rate must be finite and greater than -1 and at most 100")
      result = values.reduce(
        (total, cashflow, period) => total + cashflow / (1 + rate) ** period,
        0,
      )
      break
    }
    case "add":
    case "subtract":
    case "multiply":
    case "divide":
    case "power": {
      if (values.length !== 2) throw new Error(`${operation} requires exactly two values`)
      const [a, b] = values as [number, number]
      if (operation === "add") result = a + b
      else if (operation === "subtract") result = a - b
      else if (operation === "multiply") result = a * b
      else if (operation === "divide") {
        if (b === 0) throw new Error("Division by zero is not allowed")
        result = a / b
      } else result = a ** b
      break
    }
    default:
      throw new Error(
        `Unsupported operation. Supported operations: ${CALCULATION_OPERATIONS.join(", ")}`,
      )
  }
  if (!Number.isFinite(result)) throw new Error("Operation result is not finite")
  return result
}
