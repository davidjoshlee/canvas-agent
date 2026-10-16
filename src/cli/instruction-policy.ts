/** Resource protection is separate from advisory guidance about instruction length. */
export const INSTRUCTION_FILE_MAX_BYTES = 1024 * 1024
export const INSTRUCTION_CORE_BUDGET_BYTES = 5000
export const INSTRUCTION_ENTRY_BUDGET_BYTES = 24 * 1024
export const INSTRUCTION_SKILL_BUDGET_BYTES = 7500

export function instructionSizeWarning(
  label: string,
  bytes: number,
  budget: number,
): string | undefined {
  if (bytes <= budget) return
  return `${label} is ${bytes} bytes (suggested budget: ${budget}). Consider moving detail to references; this warning does not block instruction use.`
}
