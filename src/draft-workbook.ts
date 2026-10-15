import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { assertNoSymlinks } from "./fs-safety.js"
import { createWorkbook, parseWorkbookInput, type WorkbookInput } from "./tools.js"

const generic = new Set(["debit", "credit", "label", "value", "description", "ref", "amount"])

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((v) => v.trim())
}

function value(text: string): string | number {
  const negative = /^\(.*\)$/.test(text)
  const stripped = text
    .replace(/^\(|\)$/g, "")
    .replace(/^\$/, "")
    .replace(/,/g, "")
  if (!/^-?\d+(\.\d+)?$/.test(stripped)) return text
  const number = Number(stripped) * (negative ? -1 : 1)
  return Number.isFinite(number) ? number : text
}

/** Values-only extraction, not a calculation or source-grounding check. */
export function workbookFromDraft(text: string): WorkbookInput | null {
  if (Buffer.byteLength(text) > 5 * 1024 * 1024)
    throw new Error("Draft exceeds the workbook extraction limit")
  const lines = text.split(/\r?\n/)
  // Example tables and commented-out content are not finished deliverables.
  let fence: { char: string; length: number } | undefined
  let comment = false
  const visible = lines.map((line) => {
    let clean = ""
    for (let i = 0; i < line.length; ) {
      if (comment) {
        const end = line.indexOf("-->", i)
        if (end < 0) break
        comment = false
        i = end + 3
      } else {
        const start = line.indexOf("<!--", i)
        if (start < 0) {
          clean += line.slice(i)
          break
        }
        clean += line.slice(i, start)
        comment = true
        i = start + 4
      }
    }
    const match = clean.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (fence) {
      if (
        match &&
        match[1]?.[0] === fence.char &&
        match[1].length >= fence.length &&
        !match[2]?.trim()
      )
        fence = undefined
      return ""
    }
    if (match?.[1]) {
      fence = { char: match[1][0] ?? "`", length: match[1].length }
      return ""
    }
    return clean
  })
  const sheets: WorkbookInput["sheets"] = []
  let heading: string | undefined
  for (let i = 0; i < visible.length; i++) {
    const line = visible[i] ?? ""
    const title = line.trim().match(/^#{1,6}\s+(.+)$/)?.[1]
    if (title) {
      heading = title.trim()
      continue
    }
    const next = visible[i + 1] ?? ""
    if (
      !line.trim().startsWith("|") ||
      !next.trim().startsWith("|") ||
      !cells(next).every((v) => /^:?-+:?$/.test(v))
    )
      continue
    const headers = cells(line)
    const rows = [headers.map(value)]
    i += 2
    while (i < visible.length && visible[i]?.trim().startsWith("|")) {
      rows.push(cells(visible[i] ?? "").map(value))
      i++
    }
    i--
    const distinct = headers.find(
      (v) =>
        v &&
        !generic.has(
          v
            .toLowerCase()
            .replace(/\s*\([^)]*\)\s*/g, " ")
            .trim(),
        ),
    )
    sheets.push({ name: heading ?? distinct ?? `Table ${sheets.length + 1}`, rows })
  }
  const start = visible.findIndex((v) => /^##\s+Computations\s*$/.test(v.trim()))
  if (start >= 0) {
    const rows: Array<Array<string | number>> = [["Label", "Value"]]
    for (let i = start + 1; i < visible.length; i++) {
      const line = (visible[i] ?? "").trim()
      if (/^#{1,6}\s+/.test(line)) break
      const match = line.match(/^-?\s*(.+?)\s+—\s+(.+)$/)
      if (match) rows.push([(match[1] ?? "").trim(), value((match[2] ?? "").trim())])
    }
    if (rows.length > 1) sheets.push({ name: "Computations", rows })
  }
  if (!sheets.length) return null
  const used = new Set<string>()
  for (const sheet of sheets) {
    const base = (
      sheet.name
        .replace(/[[\]:*?/\\]/g, "")
        .trim()
        .replace(/^'+|'+$/g, "") || "Sheet"
    ).slice(0, 31)
    let name = base
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`
      name = base.slice(0, 31 - suffix.length) + suffix
    }
    sheet.name = name
    used.add(name.toLowerCase())
  }
  return parseWorkbookInput({ sheets })
}

export async function draftWorkbookBytes(text: string): Promise<Buffer | null> {
  const input = workbookFromDraft(text)
  return input ? createWorkbook(input) : null
}

export async function verifyWorkbookFile(path: string, expected: Buffer): Promise<void> {
  await assertNoSymlinks(path)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size !== expected.length)
      throw new Error("Workbook is missing or has been modified")
    const bytes = Buffer.alloc(expected.length + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (!bytes.subarray(0, length).equals(expected))
      throw new Error("Workbook is missing or has been modified")
  } finally {
    await handle.close()
  }
}
