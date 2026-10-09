import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import JSZip from "jszip"
import { parse as parseYaml } from "yaml"
import { assertNoSymlinks } from "./fs-safety.js"

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
async function zipEntryText(
  file: JSZip.JSZipObject | null,
  maxBytes = MAX_ZIP_ENTRY,
): Promise<string> {
  if (!file) return ""
  return await new Promise<string>((resolveText, reject) => {
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
    stream.on("end", () => resolveText(Buffer.concat(chunks, length).toString("utf8")))
  })
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
  const xml = await zipEntryText(archive.file("word/document.xml"))
  const paragraphs = Array.from(xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g), (paragraph) =>
    Array.from((paragraph[1] ?? "").matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g), (run) =>
      xmlText(run[1] ?? ""),
    ).join(""),
  )
  return paragraphs.filter(Boolean).join("\n")
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
  const out: string[] = []
  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i]
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
    if (rows.length) out.push(`## Sheet ${i + 1}\n${rows.join("\n")}`)
  }
  return out.join("\n\n")
}
function htmlText(html: string): string {
  return clean(
    html
      .replace(/<(script|style|iframe|object|embed|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'"),
  )
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
  try {
    let text: string
    if (extension === ".pdf" || contentType === "application/pdf")
      text = await extractPdf(input.bytes)
    else if (extension === ".docx") text = await extractDocx(input.bytes)
    else if (extension === ".pptx") text = await extractPptx(input.bytes)
    else if (extension === ".xlsx") text = await extractXlsx(input.bytes)
    else if ([".html", ".htm"].includes(extension) || contentType === "text/html")
      text = htmlText(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes))
    else if (
      [".txt", ".md", ".markdown", ".csv", ".tsv"].includes(extension) ||
      contentType.startsWith("text/")
    )
      text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes)
    else return { text: null }
    text = clean(text)
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

/** Explicitly copy and extract a user-selected file into one course's Canvas/Files folder. */
export async function ingestFile(
  vault: string,
  courseQuery: string,
  file: string,
  title?: string,
  options: { week?: string; module?: string } = {},
): Promise<{ original: string; text?: string; notices: string[] }> {
  const week = options.week
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
  const root = resolve(vault)
  await assertNoSymlinks(root)
  const { selectCourse } = await import("./workspace.js")
  const { courses } = await import("./workspace.js").then((m) => m.inspectWorkspace(root))
  const course = selectCourse(
    { version: 1, vault: root, courses, pendingTasks: [], notices: [] },
    courseQuery,
  )
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
  await assertNoSymlinks(source)
  const info = await lstat(source)
  if (!info.isFile() || info.size > MAX_ORIGINAL)
    throw new Error("Input must be a regular file under 50 MB")
  const bytes = await readFile(source)
  const destinationDir = join(root, course.root, "Canvas", "Files")
  const extname = ext(source)
  const name = `${basename(source, extname).replace(/[^\w.-]+/g, "-") || "document"}-${sha(bytes).slice(0, 12)}${extname}`
  const original = join(destinationDir, name)
  await assertNoSymlinks(destinationDir, true)
  await mkdir(destinationDir, { recursive: true })
  await assertNoSymlinks(destinationDir)
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
  const extracted = await extractText({
    bytes,
    filename: basename(name),
    contentType: types[extname],
  })
  const notices = extracted.notice ? [extracted.notice] : []
  let text: string | undefined
  if (extracted.text) {
    const sidecar = `${original}${week ? `.week-${week}` : ""}${options.module ? `.module-${options.module.replace(/[^a-zA-Z0-9_-]/g, "-")}` : ""}.extracted.md`
    const rel = relative(root, original).split(sep).join("/")
    const content = `---\noriginal_path: ${JSON.stringify(rel)}\noriginal_hash: ${sha(bytes)}\n${options.module ? `module_canvas_id: ${JSON.stringify(options.module)}\n` : ""}${week ? `dates:\n  date: ${JSON.stringify(week)}\n` : ""}---\n\n${title ? `# ${title}\n\n` : ""}${extracted.text}\n`
    try {
      await writeFile(sidecar, content, { flag: "wx" })
      text = sidecar
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
        record?.original_path !== rel ||
        record.original_hash !== sha(bytes) ||
        existingDate !== week ||
        record?.module_canvas_id !== options.module
      )
        throw new Error(
          "Existing extraction sidecar has conflicting provenance or period metadata; it was preserved",
        )
      text = sidecar
      notices.push("Preserved existing extraction sidecar")
    }
  }
  return { original, ...(text ? { text } : {}), notices }
}
