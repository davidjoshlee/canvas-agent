import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import JSZip from "jszip"
import mammoth from "mammoth"
import TurndownService from "turndown"
import { parse as parseYaml } from "yaml"
import { assertNoSymlinks } from "../shared/fs-safety.js"
import {
  assertCompatibleOriginalPolicy,
  type IngestCompatibility,
  ingestCompatibility,
  readIngestProvenance,
  renderCompatibleIngestion,
} from "./ingest-compatibility.js"
import { worksheetContext } from "./xlsx-sheet-context.js"

const MAX_ORIGINAL = 50 * 1024 * 1024
const MAX_TEXT = 5 * 1024 * 1024
const MAX_ZIP_ENTRIES = 5000
const MAX_ZIP_ENTRY = 10 * 1024 * 1024
const MAX_ZIP_TOTAL = 40 * 1024 * 1024
const types: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".html": "text/html",
  ".htm": "text/html",
  ".txt": "text/plain",
  ".md": "text/markdown",
}
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const ext = (name: string) => extname(name).toLowerCase()
function xmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}
function clean(text: string): string {
  return text
    .replaceAll(String.fromCharCode(0), "")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
async function zip(bytes: Uint8Array): Promise<JSZip> {
  // CRC checking inflates every member eagerly, bypassing the bounded readers below.
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: false })
  const entries = Object.values(archive.files).filter((f) => !f.dir)
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error("Archive contains too many entries")
  let total = 0
  for (const file of entries) {
    if (
      file.unsafeOriginalName?.startsWith("/") ||
      file.unsafeOriginalName?.split(/[\\/]/).includes("..")
    )
      throw new Error("Archive contains an unsafe path")
    const size =
      (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
    if (size > MAX_ZIP_ENTRY) throw new Error("Archive entry exceeds extraction limit")
    total += size
    if (total > MAX_ZIP_TOTAL) throw new Error("Archive exceeds extraction size limit")
  }
  return archive
}
async function zipEntryBytes(
  file: JSZip.JSZipObject | null,
  maxBytes = MAX_ZIP_ENTRY,
): Promise<Buffer> {
  if (!file) return Buffer.alloc(0)
  return await new Promise<Buffer>((resolveText, reject) => {
    const stream = file.nodeStream()
    const abortable = stream as NodeJS.ReadableStream & { destroy(error?: Error): void }
    const chunks: Buffer[] = []
    let length = 0
    stream.on("data", (chunk: Buffer | Uint8Array) => {
      const value = Buffer.from(chunk)
      length += value.length
      if (length > maxBytes) {
        abortable.destroy(new Error("Archive entry exceeds extraction limit"))
        return
      }
      chunks.push(value)
    })
    stream.on("error", reject)
    stream.on("end", () => resolveText(Buffer.concat(chunks, length)))
  })
}
async function zipEntryText(
  file: JSZip.JSZipObject | null,
  maxBytes = MAX_ZIP_ENTRY,
): Promise<string> {
  return (await zipEntryBytes(file, maxBytes)).toString("utf8")
}
async function extractPdf(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const task = pdfjs.getDocument({
    data: Uint8Array.from(bytes),
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: 0,
  })
  try {
    const doc = await task.promise
    let result = ""
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      const line = content.items
        .flatMap((item) => ("str" in item ? [item.str] : []))
        .join(" ")
        .trim()
      if (line) result += `${line}\n`
      if (result.length > MAX_TEXT) throw new Error("Extracted text exceeds 5 MB")
    }
    if (!result.trim()) throw new Error("PDF has no selectable text (it may be scanned)")
    return result.trim()
  } finally {
    await task.destroy()
  }
}
async function extractPptx(bytes: Uint8Array): Promise<string> {
  const archive = await zip(bytes)
  const slides = Object.values(archive.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const out: string[] = []
  for (const slide of slides) {
    const xml = await zipEntryText(slide)
    out.push(
      Array.from(xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g), (m) =>
        xmlText(m[1] ?? ""),
      ).join(" "),
    )
  }
  return out.join("\n")
}
async function extractDocx(bytes: Uint8Array): Promise<string> {
  const archive = await zip(bytes)
  const bounded = new JSZip()
  let total = 0
  for (const file of Object.values(archive.files).filter((file) => !file.dir)) {
    const content = await zipEntryBytes(file)
    total += content.byteLength
    if (total > MAX_ZIP_TOTAL) throw new Error("Archive exceeds extraction size limit")
    if (/\.(?:xml|rels)$/i.test(file.name)) {
      const xml = new TextDecoder("utf-8", { fatal: true }).decode(content)
      if (/<!DOCTYPE|<!ENTITY/i.test(xml) || (xml.match(/</g)?.length ?? 0) > 100_000)
        throw new Error(
          "Word XML exceeds bounded extraction limits or contains unsupported declarations",
        )
    }
    bounded.file(file.name, content)
  }
  // Parse only validated, bounded member bytes; no filesystem path is supplied.
  const input = await bounded.generateAsync({ type: "nodebuffer", compression: "STORE" })
  try {
    return (await mammoth.extractRawText({ buffer: input })).value.trim()
  } catch {
    throw new Error("Word document could not be parsed; supply a valid DOCX or extracted text")
  }
}
async function extractXlsx(bytes: Uint8Array): Promise<string> {
  const archive = await zip(bytes)
  const sharedXml = await zipEntryText(archive.file("xl/sharedStrings.xml"))
  const shared = Array.from(sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g), (m) =>
    Array.from((m[1] ?? "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g), (t) =>
      xmlText(t[1] ?? ""),
    ).join(""),
  )
  const sheets = Object.values(archive.files)
    .filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const context = worksheetContext(
    await zipEntryText(archive.file("xl/workbook.xml")),
    await zipEntryText(archive.file("xl/_rels/workbook.xml.rels")),
    sheets.map((sheet) => sheet.name),
  )
  const out: string[] = context.unboundNames.length
    ? [
        "## Workbook tabs without worksheet mapping\n" +
          context.unboundNames.map((name) => `- ${name}`).join("\n"),
      ]
    : []
  let readableSheets = 0
  for (let i = 0; i < context.sheets.length; i++) {
    const metadata = context.sheets[i]
    const sheet = metadata ? archive.file(metadata.path) : null
    if (!sheet) continue
    const xml = await zipEntryText(sheet)
    const rows: string[] = []
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const values: string[] = []
      for (const cell of (row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const type = cell[1]?.match(/\bt="([^"]+)"/)?.[1]
        const body = cell[2] ?? ""
        let value = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? ""
        if (type === "s") value = shared[Number.parseInt(value, 10)] ?? ""
        else if (type === "inlineStr")
          value = Array.from(body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g), (m) =>
            xmlText(m[1] ?? ""),
          ).join("")
        if (value) values.push(xmlText(value))
      }
      if (values.length) rows.push(values.join(" | "))
    }
    if (rows.length) {
      readableSheets++
      out.push(`## ${metadata?.name ?? `Sheet ${i + 1}`}\n${rows.join("\n")}`)
    }
  }
  if (!readableSheets) throw new Error("XLSX has no readable cell data")
  return out.join("\n\n")
}
function htmlText(html: string): string {
  if (Buffer.byteLength(html) > MAX_TEXT || (html.match(/</g)?.length ?? 0) > 100_000)
    throw new Error("HTML source exceeds bounded extraction limits")
  const converter = new TurndownService()
  converter.remove(["script", "style", "iframe", "object", "embed", "noscript"])
  converter.addRule("unsafe-targets", {
    filter: (node) => {
      if (!["A", "IMG"].includes(node.nodeName)) return false
      const target = node.getAttribute(node.nodeName === "A" ? "href" : "src")
      if (!target) return false
      try {
        const url = new URL(target, "https://canvas.invalid")
        return (
          !!url.username ||
          !!url.password ||
          !["http:", "https:", "mailto:", "tel:"].includes(url.protocol)
        )
      } catch {
        return true
      }
    },
    replacement: (content, node) =>
      node.nodeName === "A" ? content : (node.getAttribute("alt") ?? ""),
  })
  return converter.turndown(html).trim()
}

/** Extract selectable text from common Canvas document formats. Unsupported/bad files return a notice. */
export async function extractText(input: {
  bytes: Uint8Array
  filename: string
  contentType?: string | null
}): Promise<{ text: string | null; notice?: string }> {
  if (input.bytes.byteLength > MAX_ORIGINAL)
    return { text: null, notice: "Original exceeds the 50 MB limit" }
  const extension = ext(input.filename)
  const contentType = input.contentType?.split(";", 1)[0]?.toLowerCase() ?? ""
  const legacyXls = extension === ".xls" || contentType === "application/vnd.ms-excel"
  const legacyOffice = [0xd0, 0xcf, 0x11, 0xe0].every((byte, index) => input.bytes[index] === byte)
  if (legacyXls || legacyOffice)
    return {
      text: null,
      notice: legacyXls
        ? "Legacy .xls binary files are not supported; convert to .xlsx or supply extracted text. No text was extracted."
        : "Legacy or encrypted binary Office files are not supported; supply an accessible modern Office file or extracted text. No text was extracted.",
    }
  try {
    let text: string
    if (extension === ".pdf" || contentType === "application/pdf")
      text = await extractPdf(input.bytes)
    else if (extension === ".docx" || contentType === types[".docx"])
      text = await extractDocx(input.bytes)
    else if (extension === ".pptx" || contentType === types[".pptx"])
      text = await extractPptx(input.bytes)
    else if (extension === ".xlsx" || contentType === types[".xlsx"])
      text = await extractXlsx(input.bytes)
    else if ([".html", ".htm"].includes(extension) || contentType === "text/html")
      text = htmlText(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes))
    else if (
      [".txt", ".md", ".markdown", ".csv", ".tsv"].includes(extension) ||
      contentType.startsWith("text/")
    )
      text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes)
    else return { text: null }
    // Markdown indentation carries nested-list/code structure in HTML conversion.
    text =
      [".html", ".htm", ".docx"].includes(extension) ||
      contentType === "text/html" ||
      contentType === types[".docx"]
        ? text.replaceAll(String.fromCharCode(0), "").trim()
        : clean(text)
    if (!text)
      return {
        text: null,
        notice:
          extension === ".pdf"
            ? "PDF has no selectable text (it may be scanned)"
            : "Extractor returned no text",
      }
    if (Buffer.byteLength(text) > MAX_TEXT)
      return { text: null, notice: "Extracted text exceeds the 5 MB limit" }
    return { text }
  } catch (error) {
    return {
      text: null,
      notice: error instanceof Error ? error.message.slice(0, 240) : "Document extraction failed",
    }
  }
}

function validateIngestDates(week?: string, asOf?: string): void {
  if (asOf !== undefined) {
    const date = new Date(`${asOf}T00:00:00.000Z`)
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
      !Number.isFinite(date.valueOf()) ||
      date.toISOString().slice(0, 10) !== asOf
    )
      throw new Error("Ingest as-of must be a real availability date in YYYY-MM-DD format")
  }
  if (week !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week))
      throw new Error("Ingest week must be an explicit Monday in YYYY-MM-DD format")
    const date = new Date(`${week}T00:00:00.000Z`)
    if (
      !Number.isFinite(date.valueOf()) ||
      date.toISOString().slice(0, 10) !== week ||
      date.getUTCDay() !== 1
    )
      throw new Error("Ingest week must be a real Monday in YYYY-MM-DD format")
  }
}

async function preserveIngestOriginal(original: string, bytes: Uint8Array): Promise<void> {
  try {
    await writeFile(original, bytes, { flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    // A matching digest in the filename is not proof that an existing vault file
    // is still the original. Never attach a newly extracted sidecar to tampered data.
    await assertNoSymlinks(original)
    const existing = await lstat(original)
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== bytes.byteLength)
      throw new Error("Existing original is not a matching regular file; it was preserved")
    const current = await readFile(original)
    if (sha(current) !== sha(bytes))
      throw new Error("Existing original has changed; it was preserved")
  }
}

interface IngestSidecarEvidence {
  rel: string
  originalHash: string
  week?: string
  asOf?: string
  module?: string
  portable?: ReturnType<typeof renderCompatibleIngestion>
}

async function saveIngestSidecar(
  sidecar: string,
  content: string,
  evidence: IngestSidecarEvidence,
  notices: string[],
): Promise<string> {
  const { rel, originalHash, week, asOf, module, portable } = evidence
  if (portable) {
    const companion = `${sidecar}.ingest.json`
    const present = await lstat(sidecar).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return null
    })
    if (!present) {
      try {
        await writeFile(companion, JSON.stringify(portable.provenance), {
          flag: "wx",
          mode: 0o600,
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
    }
    const { data: saved } = await readIngestProvenance(companion)
    if (JSON.stringify(saved) !== JSON.stringify(portable.provenance))
      throw new Error("Existing compatible provenance conflicts; artifacts were preserved")
  }
  try {
    await writeFile(sidecar, content, { flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    await assertNoSymlinks(sidecar)
    const existingText = await readFile(sidecar, "utf8")
    const frontmatter = existingText.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/)
    let metadata: unknown
    try {
      metadata = frontmatter ? parseYaml(frontmatter[1] ?? "") : null
    } catch {
      metadata = null
    }
    const record =
      metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : null
    const existingDate =
      record?.dates && typeof record.dates === "object" && !Array.isArray(record.dates)
        ? (record.dates as Record<string, unknown>).date
        : undefined
    if (
      (!portable &&
        (record?.original_path !== rel ||
          record.original_hash !== originalHash ||
          record.available_at !== asOf)) ||
      existingDate !== week ||
      record?.module_canvas_id !== module
    )
      throw new Error(
        "Existing extraction sidecar has conflicting provenance or period metadata; it was preserved",
      )
    if (portable) {
      const expected = parseYaml(content.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "") as Record<
        string,
        unknown
      >
      for (const field of [
        "canvas_id",
        "canvas_url",
        "type",
        "source",
        "status",
        "ai_policy",
        "redistribution",
        "content_hash",
      ])
        if (record?.[field] !== expected[field])
          throw new Error(
            "Existing compatible sidecar has conflicting identity or policy metadata; it was preserved",
          )
      if (JSON.stringify(record?.dates) !== JSON.stringify(expected.dates))
        throw new Error("Existing compatible sidecar has conflicting dates; it was preserved")
      if (
        JSON.stringify(Object.keys(record ?? {}).sort()) !==
        JSON.stringify(Object.keys(expected).sort())
      )
        throw new Error("Existing compatible sidecar has unexpected metadata; it was preserved")
      if (sha(existingText) !== portable?.provenance.hash)
        notices.push(
          "Edited compatible sidecar preserved; provenance hash is stale and context requires review",
        )
    }
    notices.push("Preserved existing extraction sidecar")
  }
  return sidecar
}

/** Explicitly copy/extract a selected file inside one course's writable product namespace. */
export async function ingestFile(
  vault: string,
  courseQuery: string,
  file: string,
  title?: string,
  options: {
    week?: string
    module?: string
    asOf?: string
    compatibility?: IngestCompatibility
  } = {},
): Promise<{ original: string; text?: string; notices: string[] }> {
  const week = options.week
  const asOf = options.asOf
  validateIngestDates(week, asOf)
  const root = resolve(vault)
  await assertNoSymlinks(root)
  const { selectCourse } = await import("../vault/workspace.js")
  const context = await import("../vault/workspace.js").then((m) => m.inspectWorkspace(root))
  if (context.diagnostics?.some((item) => item.code === "workspace.course_mappings_unavailable"))
    throw new Error("Course mappings are unsafe; inspect them before ingesting files")
  const course = selectCourse(context, courseQuery)
  const compatibility = options.compatibility
    ? ingestCompatibility(options.compatibility, course.canvasId)
    : undefined
  if (
    options.module &&
    !course.sources.some(
      (item) =>
        item.canvasId === options.module &&
        /module|session|milestone/i.test(`${item.type} ${item.path}`),
    )
  )
    throw new Error("Ingest module must identify an existing module in this course")
  const source = resolve(file)
  if (!isAbsolute(file)) throw new Error("Input file path must be absolute")
  if (
    /^(?:\.env(?:[.-].*)?|(?:credentials?|secrets?|passwords?|tokens?)(?:\.(?:json|ya?ml|txt))?|(?:school|canvas-agent)\.(?:config|auth)\.json)$/i.test(
      basename(source),
    )
  )
    throw new Error("Credential/config files cannot be ingested into an academic vault")
  await assertNoSymlinks(source)
  const info = await lstat(source)
  if (!info.isFile() || info.size > MAX_ORIGINAL)
    throw new Error("Input must be a regular file under 50 MB")
  const bytes = await readFile(source)
  if (compatibility) assertCompatibleOriginalPolicy(bytes, ext(source), compatibility)
  const destinationDir = course.syncNamespace
    ? join(root, course.root, course.syncNamespace, "Canvas", "Files")
    : join(root, course.root, "Canvas", "Files")
  const extname = ext(source)
  const name = `${basename(source, extname).replace(/[^\w.-]+/g, "-") || "document"}-${sha(bytes).slice(0, 12)}${extname}`
  const original = join(destinationDir, name)
  await assertNoSymlinks(destinationDir, true)
  await mkdir(destinationDir, { recursive: true })
  await assertNoSymlinks(destinationDir)
  await preserveIngestOriginal(original, bytes)
  const extracted = await extractText({
    bytes,
    filename: basename(name),
    contentType: types[extname],
  })
  const notices = extracted.notice ? [extracted.notice] : []
  let text: string | undefined
  if (extracted.text) {
    const sidecar = `${original}${week ? `.week-${week}` : ""}${asOf ? `.as-of-${asOf}` : ""}${options.module ? `.module-${options.module.replace(/[^a-zA-Z0-9_-]/g, "-")}` : ""}${compatibility?.suffix ?? ""}.extracted.md`
    const rel = relative(root, original).split(sep).join("/")
    const body = `${title ? `# ${title}\n\n` : ""}${extracted.text}\n`
    const portable = compatibility
      ? renderCompatibleIngestion({
          compatibility,
          originalPath: rel,
          originalHash: sha(bytes),
          body,
          title: title ?? basename(source),
          asOf,
          week,
          module: options.module,
        })
      : undefined
    const content =
      portable?.markdown ??
      `---\noriginal_path: ${JSON.stringify(rel)}\noriginal_hash: ${sha(bytes)}\n${asOf ? `available_at: ${JSON.stringify(asOf)}\n` : ""}${options.module ? `module_canvas_id: ${JSON.stringify(options.module)}\n` : ""}${week ? `dates:\n  date: ${JSON.stringify(week)}\n` : ""}---\n\n${body}`
    text = await saveIngestSidecar(
      sidecar,
      content,
      {
        rel,
        originalHash: sha(bytes),
        week,
        asOf,
        module: options.module,
        portable,
      },
      notices,
    )
  }
  return { original, ...(text ? { text } : {}), notices }
}
