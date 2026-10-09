import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { extractText, ingestFile } from "../src/content.js"
import { createPrepTask } from "../src/tasks.js"
import { inspectWorkspace } from "../src/workspace.js"

async function archive(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [path, value] of Object.entries(files)) zip.file(path, value)
  return zip.generateAsync({ type: "uint8array" })
}

function pdfWithContent(stream: string): Uint8Array {
  const objects = [
    "<</Type /Catalog /Pages 2 0 R>>",
    "<</Type /Pages /Kids [3 0 R] /Count 1>>",
    "<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <</Font <</F1 4 0 R>>>> /Contents 5 0 R>>",
    "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ]
  let document = "%PDF-1.4\n"
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document))
    document += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(document)
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1))
    document += `${String(offset).padStart(10, "0")} 00000 n \n`
  document += `trailer\n<</Size ${objects.length + 1} /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(document)
}

describe("bounded document extraction", () => {
  it("links a locally imported reading to a uniquely selected module session", async () => {
    const root = await mkdtemp(join(tmpdir(), "canvas-ingest-module-"))
    try {
      await mkdir(join(root, "MBA-101", "Modules"), { recursive: true })
      await writeFile(
        join(root, "MBA-101", "Modules", "Session 3.md"),
        "---\ncanvas_id: module-3\ntype: module\n---\nSession index.\n",
      )
      const input = join(root, "reading.txt")
      await writeFile(input, "Synthetic reading describes a centralization tradeoff.")
      const imported = await ingestFile(root, "MBA-101", input, undefined, { module: "module-3" })
      const task = await createPrepTask(root, "MBA-101", undefined, { session: "3" })
      expect(task.sources.map((source) => source.path)).toContain(
        imported.text?.replace(`${root}/`, ""),
      )
      await expect(
        ingestFile(root, "MBA-101", input, undefined, { module: "missing" }),
      ).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it("extracts selectable PDF text and reports a scanned or textless PDF", async () => {
    const selected = await extractText({
      bytes: pdfWithContent("BT /F1 18 Tf 72 720 Td (Synthetic PDF text) Tj ET"),
      filename: "selectable.pdf",
    })
    expect(selected, JSON.stringify(selected)).toMatchObject({ text: "Synthetic PDF text" })
    await expect(
      extractText({ bytes: pdfWithContent("q Q"), filename: "scanned.pdf" }),
    ).resolves.toMatchObject({
      text: null,
      notice: expect.stringContaining("no selectable text"),
    })
  })
  it("extracts DOCX paragraphs, PPTX slide text, and XLSX cell values", async () => {
    const docx = await archive({
      "word/document.xml":
        "<w:document><w:body><w:p><w:r><w:t>Docx example</w:t></w:r></w:p></w:body></w:document>",
    })
    const pptx = await archive({
      "ppt/slides/slide1.xml": "<p:sld><a:t>Slide example</a:t></p:sld>",
    })
    const xlsx = await archive({
      "xl/sharedStrings.xml": "<sst><si><t>Spreadsheet example</t></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row><c t="s"><v>0</v></c></row></sheetData></worksheet>',
    })
    await expect(extractText({ bytes: docx, filename: "lesson.docx" })).resolves.toMatchObject({
      text: "Docx example",
    })
    await expect(extractText({ bytes: pptx, filename: "lesson.pptx" })).resolves.toMatchObject({
      text: "Slide example",
    })
    await expect(extractText({ bytes: xlsx, filename: "lesson.xlsx" })).resolves.toMatchObject({
      text: expect.stringContaining("Spreadsheet example"),
    })
  })

  it("normalizes HTML, skips unsupported files, and reports malformed office archives", async () => {
    await expect(
      extractText({
        bytes: Buffer.from("<p>Hello</p><script>private()</script>"),
        filename: "page.html",
      }),
    ).resolves.toMatchObject({ text: "Hello" })
    await expect(
      extractText({ bytes: Buffer.from([1, 2]), filename: "opaque.bin" }),
    ).resolves.toMatchObject({ text: null })
    await expect(
      extractText({ bytes: Buffer.from("broken"), filename: "broken.docx" }),
    ).resolves.toMatchObject({ text: null, notice: expect.any(String) })
  })

  it("rejects highly compressed XML entries at the uncompressed size bound", async () => {
    const compressedBomb = await archive({
      "word/document.xml": `<w:document>${"x".repeat(11 * 1024 * 1024)}</w:document>`,
    })
    await expect(
      extractText({ bytes: compressedBomb, filename: "oversized.docx" }),
    ).resolves.toMatchObject({
      text: null,
      notice: expect.stringContaining("entry exceeds extraction limit"),
    })
  })

  it("refuses to reuse an altered original at the deterministic ingest path", async () => {
    const root = await mkdtemp(join(tmpdir(), "canvas-ingest-"))
    try {
      await mkdir(join(root, "ACCT312"), { recursive: true })
      const input = join(root, "reading.txt")
      const bytes = Buffer.from("original reading")
      await writeFile(input, bytes)
      const digest = createHash("sha256").update(bytes).digest("hex")
      const original = join(
        root,
        "ACCT312",
        "Canvas",
        "Files",
        `reading-${digest.slice(0, 12)}.txt`,
      )
      await mkdir(join(root, "ACCT312", "Canvas", "Files"), { recursive: true })
      await writeFile(original, "tampered")
      await expect(ingestFile(root, "ACCT312", input)).rejects.toThrow("Existing original")
      await expect(readFile(original, "utf8")).resolves.toBe("tampered")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("dates explicitly ingested readings for the matching prep week and versions periods safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "canvas-ingest-week-"))
    try {
      await mkdir(join(root, "ACCT312"), { recursive: true })
      const input = join(root, "reading.md")
      await writeFile(input, "# Dated reading\nText for a specific session.\n")
      const first = await ingestFile(root, "ACCT312", input, "Dated reading", {
        week: "2026-10-12",
      })
      const second = await ingestFile(root, "ACCT312", input, "Dated reading", {
        week: "2026-10-19",
      })
      expect(first.text).toContain("week-2026-10-12.extracted.md")
      expect(second.text).toContain("week-2026-10-19.extracted.md")
      await expect(
        ingestFile(root, "ACCT312", input, undefined, { week: "2026-10-12" }),
      ).resolves.toMatchObject({ text: first.text })
      await expect(
        ingestFile(root, "ACCT312", input, undefined, { week: "2026-10-18" }),
      ).rejects.toThrow("Monday")
      const context = await inspectWorkspace(root)
      const firstRelative = first.text?.replace(`${root}/`, "")
      expect(
        context.courses[0]?.sources.find((source) => source.path === firstRelative)?.dates,
      ).toEqual(["2026-10-12"])
      const task = await createPrepTask(root, "ACCT312", "2026-10-12")
      expect(task.sources.map((source) => source.path)).toContain(firstRelative)
      expect(task.sources.map((source) => source.path)).not.toContain(
        second.text?.replace(`${root}/`, ""),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
