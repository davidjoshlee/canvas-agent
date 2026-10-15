import { posix } from "node:path"

function attributes(raw: string): Record<string, string> {
  const values: Record<string, string> = {}
  const rest = raw.replace(
    /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
    (_match, key: string, double: string | undefined, single: string | undefined) => {
      if (Object.hasOwn(values, key)) throw new Error("Duplicate workbook metadata attribute")
      const value = double ?? single ?? ""
      if (value.length > 2000 || [...value].some((char) => char.charCodeAt(0) < 32))
        throw new Error("Invalid workbook metadata attribute")
      if (value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, "").includes("&"))
        throw new Error("Unsupported workbook XML entity")
      values[key] = value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity) => {
        const named: Record<string, string> = {
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&apos;": "'",
        }
        if (named[entity]) return named[entity] ?? ""
        const number = entity.slice(2, -1)
        const point = number.startsWith("x") ? Number.parseInt(number.slice(1), 16) : Number(number)
        if (
          !Number.isInteger(point) ||
          point < 32 ||
          point > 0x10ffff ||
          (point >= 0xd800 && point <= 0xdfff)
        )
          throw new Error("Invalid workbook XML character")
        return String.fromCodePoint(point)
      })
      return ""
    },
  )
  if (rest.trim()) throw new Error("Unsupported workbook metadata attributes")
  return values
}
function tags(xml: string, tag: string): Record<string, string>[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unsupported workbook XML declarations")
  const clean = xml.replace(/<!--[\s\S]*?-->/g, "")
  if (/<!--|-->/.test(clean)) throw new Error("Malformed workbook XML comment")
  const matches = [
    ...clean.matchAll(new RegExp(`<${tag}\\b((?:"[^"]*"|'[^']*'|[^'"<>])*?)\\s*/?>`, "g")),
  ]
  if ([...clean.matchAll(new RegExp(`<${tag}\\b`, "g"))].length !== matches.length)
    throw new Error("Malformed workbook sheet metadata")
  if (matches.length > 5000) throw new Error("Workbook sheet metadata exceeds bounds")
  return matches.map((match) => attributes(match[1] ?? ""))
}

/** Bounded names/context only. Relationship IDs, not filename order, bind tab names.
 * https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/how-to-retrieve-the-values-of-cells-in-a-spreadsheet
 * Missing relationships retain names as unbound metadata, never guessed labels.
 */
export function worksheetContext(
  workbook: string,
  relationships: string,
  paths: string[],
): { sheets: Array<{ path: string; name?: string }>; unboundNames: string[] } {
  if (
    Buffer.byteLength(workbook) + Buffer.byteLength(relationships) > 20 * 1024 * 1024 ||
    paths.length > 5000
  )
    throw new Error("Workbook sheet context exceeds bounds")
  const inventory = new Set(paths)
  const sheets = tags(workbook, "sheet")
  const relations = new Map<string, Record<string, string>>()
  for (const relation of tags(relationships, "Relationship")) {
    const id = relation.Id
    if (!id || relations.has(id)) throw new Error("Workbook relationship identity is ambiguous")
    relations.set(id, relation)
  }
  const named: Array<{ path: string; name?: string }> = []
  const used = new Set<string>()
  const ids = new Set<string>()
  const names = new Set<string>()
  const unboundNames: string[] = []
  for (const sheet of sheets) {
    const name = sheet.name
    if (!name?.trim() || name.length > 200 || names.has(name))
      throw new Error("Workbook tab name is invalid or ambiguous")
    names.add(name)
    const id = sheet["r:id"]
    if (id && ids.has(id)) throw new Error("Workbook sheet identity is ambiguous")
    if (id) ids.add(id)
    const relation = id ? relations.get(id) : undefined
    if (!relation?.Type?.endsWith("/worksheet")) {
      unboundNames.push(name)
      continue
    }
    const target = relation.Target
    if (
      (relation.TargetMode !== undefined && relation.TargetMode !== "Internal") ||
      !target ||
      /[\\?#%:]/.test(target)
    )
      throw new Error("Workbook worksheet relationship target is unsafe")
    const path = posix.normalize(target.startsWith("/") ? target.slice(1) : `xl/${target}`)
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(path) || !inventory.has(path) || used.has(path))
      throw new Error("Workbook worksheet relationship is missing or ambiguous")
    used.add(path)
    named.push({ path, name })
  }
  return {
    sheets: [...named, ...paths.filter((path) => !used.has(path)).map((path) => ({ path }))],
    unboundNames,
  }
}
