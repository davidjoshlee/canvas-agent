/** Canvas category identity only; never group membership, assigned part or AI permission. */
export function assignmentGroupCategory(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const id =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : ""
  if (!/^[1-9]\d{0,39}$/.test(id))
    throw new Error("Assignment group category identity is unsupported; no payload was echoed")
  return id
}
export function groupCategoryFromPrompt(text: string): string | undefined {
  const matches = [...text.matchAll(/^Group category:[ \t]*(.*)$/gim)].map((match) =>
    assignmentGroupCategory(match[1]?.trim()),
  )
  if (new Set(matches).size > 1)
    throw new Error("Assignment group category is ambiguous; inspect the supplied prompt")
  return matches[0]
}
