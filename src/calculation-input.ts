import { readJsonInput } from "./json-input.js"
import { parseCalculationBatch } from "./tools.js"

/** Explicit bounded JSON input; malformed data and credential files are never echoed. */
export async function readCalculationBatchFile(file: string) {
  return parseCalculationBatch(await readJsonInput(file, "Calculation"))
}
