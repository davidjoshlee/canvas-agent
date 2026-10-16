import JSZip from "jszip"

const MAX_WORKBOOK = 5 * 1024 * 1024
const MAX_CELLS = 50_000
const MAX_SHEETS = 20

function xml(value: string): string {
  if (
    [...value].some((char) => {
      const code = char.codePointAt(0) ?? 0
      return (
        (code < 0x20 && ![0x09, 0x0a, 0x0d].includes(code)) ||
        (code >= 0xd800 && code <= 0xdfff) ||
        code === 0xfffe ||
        code === 0xffff
      )
    })
  )
    throw new Error("Workbook text contains characters that XML cannot represent")
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function columnName(index: number): string {
  let number = index + 1
  let value = ""
  while (number) {
    const remainder = (number - 1) % 26
    value = String.fromCharCode(65 + remainder) + value
    number = Math.floor((number - 1) / 26)
  }
  return value
}

export interface WorkbookInput {
  sheets: Array<{ name: string; rows: Array<Array<string | number | boolean | null>> }>
}

export function parseWorkbookInput(raw: unknown): WorkbookInput {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => key !== "sheets")
  )
    throw new Error("Workbook JSON must contain only a sheets array")
  const sheets = (raw as { sheets?: unknown }).sheets
  if (!Array.isArray(sheets) || sheets.length < 1 || sheets.length > MAX_SHEETS)
    throw new Error("Workbook must contain 1 to 20 sheets")
  const names = new Set<string>()
  let cellCount = 0
  let textBytes = 0
  let rowCount = 0
  const normalized = sheets.map((sheet) => {
    if (
      !sheet ||
      typeof sheet !== "object" ||
      Array.isArray(sheet) ||
      Object.keys(sheet).some((key) => !["name", "rows"].includes(key))
    )
      throw new Error("Each sheet must contain only a name and rows")
    const { name, rows } = sheet as { name?: unknown; rows?: unknown }
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 31 ||
      /[[\]:*?/\\]/.test(name) ||
      /^'|'$/.test(name)
    )
      throw new Error("Sheet names must be valid Excel names up to 31 characters")
    if (names.has(name.toLowerCase())) throw new Error("Sheet names must be unique ignoring case")
    names.add(name.toLowerCase())
    if (!Array.isArray(rows)) throw new Error("Sheet rows must be an array")
    rowCount += rows.length
    if (rowCount > 50_000) throw new Error("Workbook exceeds the 50,000 row limit")
    const cleanRows = rows.map((row) => {
      if (!Array.isArray(row)) throw new Error("Each workbook row must be an array")
      if (row.length > 16_384) throw new Error("Workbook exceeds Excel's 16,384 column limit")
      return row.map((cell) => {
        cellCount++
        if (cellCount > MAX_CELLS) throw new Error("Workbook exceeds the 50,000 cell limit")
        if (
          !(
            cell === null ||
            typeof cell === "string" ||
            typeof cell === "boolean" ||
            typeof cell === "number"
          )
        )
          throw new Error("Workbook cells must be text, finite numbers, booleans, or null")
        if (typeof cell === "number" && !Number.isFinite(cell))
          throw new Error("Workbook numbers must be finite")
        if (typeof cell === "string") {
          textBytes += Buffer.byteLength(cell)
          if (textBytes > 1_000_000) throw new Error("Workbook text exceeds the safe output limit")
          xml(cell)
        }
        return cell
      })
    })
    return { name, rows: cleanRows }
  })
  return { sheets: normalized }
}

export async function createWorkbook(input: WorkbookInput): Promise<Buffer> {
  return renderWorkbook(input)
}

async function renderWorkbook(
  input: WorkbookInput,
  legacyDirectoryDates?: Map<string, Date>,
): Promise<Buffer> {
  input = parseWorkbookInput(input)
  const zip = new JSZip()
  const addFile = (name: string, text: string) =>
    zip.file(name, text, { date: new Date("2000-01-01T00:00:00.000Z") })
  const overrides = input.sheets
    .map(
      (_, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("")
  addFile(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}</Types>`,
  )
  addFile(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  )
  const sheetXml = input.sheets
    .map(
      (sheet, index) =>
        `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("")
  addFile(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetXml}</sheets></workbook>`,
  )
  const rels = input.sheets
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join("")
  addFile(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
  )
  input.sheets.forEach((sheet, sheetIndex) => {
    const rows = sheet.rows
      .map((row, rowIndex) => {
        const cells = row
          .map((cell, columnIndex) => {
            const ref = `${columnName(columnIndex)}${rowIndex + 1}`
            if (cell === null) return `<c r="${ref}"/>`
            if (typeof cell === "boolean") return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`
            if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(cell)}</t></is></c>`
          })
          .join("")
        return `<row r="${rowIndex + 1}">${cells}</row>`
      })
      .join("")
    addFile(
      `xl/worksheets/sheet${sheetIndex + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    )
  })
  // JSZip implicitly creates parent directory entries. Their dates must also
  // be fixed, otherwise identical outputs differ across two-second ZIP ticks.
  zip.forEach((name, entry) => {
    if (entry.dir)
      entry.date = legacyDirectoryDates?.get(name) ?? new Date("2000-01-01T00:00:00.000Z")
  })
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  })
  if (bytes.byteLength > MAX_WORKBOOK) throw new Error("Workbook output exceeds the 5 MB limit")
  return bytes
}

/** Preserve earlier hash-bound bundles whose implicit directories used wall time.
 * Only those four directory timestamps may vary; the full reproduced ZIP must match.
 */
export async function matchesLegacyWorkbook(input: WorkbookInput, bytes: Buffer): Promise<boolean> {
  if (bytes.length > MAX_WORKBOOK) return false
  if (bytes.equals(await createWorkbook(input))) return true
  const zip = await JSZip.loadAsync(bytes)
  if (Object.keys(zip.files).length > input.sheets.length + 9) return false
  const dates = new Map<string, Date>()
  for (const name of ["_rels/", "xl/", "xl/_rels/", "xl/worksheets/"]) {
    const entry = zip.files[name]
    if (!entry?.dir || !Number.isFinite(entry.date.valueOf())) return false
    dates.set(name, entry.date)
  }
  return bytes.equals(await renderWorkbook(input, dates))
}
