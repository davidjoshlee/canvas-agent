import JSZip from "jszip"

// Invented extraction fixtures, using the same minimal XML/PDF shapes as the
// existing extraction differential and content regressions. Not production docs.
async function archive(entries) {
  const zip = new JSZip()
  for (const [path, body] of Object.entries(entries)) zip.file(path, body)
  return zip.generateAsync({ type: "nodebuffer" })
}
function pdf(stream) {
  const objects = [
    "<</Type /Catalog /Pages 2 0 R>>",
    "<</Type /Pages /Kids [3 0 R] /Count 1>>",
    "<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <</Font <</F1 4 0 R>>>> /Contents 5 0 R>>",
    "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ]
  let document = "%PDF-1.4\n"
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document))
    document += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(document)
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1))
    document += `${String(offset).padStart(10, "0")} 00000 n \n`
  return Buffer.from(
    `${document}trailer\n<</Size ${objects.length + 1} /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`,
  )
}
export async function localFormatFixtures() {
  const evidence = "Synthetic evidence separates observations from assumptions."
  return [
    {
      name: "reading.pdf",
      bytes: pdf(`BT /F1 12 Tf 72 720 Td (${evidence}) Tj ET`),
      supported: true,
    },
    {
      name: "reading.docx",
      bytes: await archive({
        "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${evidence}</w:t></w:r></w:p></w:body></w:document>`,
      }),
      supported: true,
    },
    {
      name: "reading.pptx",
      bytes: await archive({
        "ppt/slides/slide1.xml": `<a:t>${evidence}</a:t>`,
        "ppt/slides/slide2.xml": "<a:t>Synthetic uncertainty remains.</a:t>",
      }),
      supported: true,
    },
    {
      name: "reading.xlsx",
      bytes: await archive({
        "xl/workbook.xml":
          '<workbook><sheets><sheet name="Assumptions" sheetId="1" r:id="r1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels":
          '<Relationships><Relationship Id="r1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml": `<row><c t="inlineStr"><is><t>${evidence}</t></is></c><c><v>42</v></c></row>`,
      }),
      supported: true,
    },
    {
      name: "reading.html",
      bytes: Buffer.from(`<h1>Synthetic reading</h1><p>${evidence}</p>`),
      supported: true,
    },
    { name: "reading.txt", bytes: Buffer.from(evidence), supported: true },
    { name: "reading.md", bytes: Buffer.from(`# Synthetic reading\n${evidence}`), supported: true },
    { name: "legacy.xls", bytes: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), supported: false },
    { name: "unknown.bin", bytes: Buffer.from([1, 2, 3]), supported: false },
    { name: "scanned.pdf", bytes: pdf(""), supported: false },
  ]
}
