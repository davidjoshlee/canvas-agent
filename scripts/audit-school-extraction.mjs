import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"
import JSZip from "jszip"
import { extractText } from "../src/content.ts"

// Source-only differential with synthetic bytes. Never load config, credentials,
// a student vault, an index or an account; no extraction content is printed.
const school = process.argv[2]
if (!school || !isAbsolute(school)) throw new Error("Supply an absolute School source checkout")
const source = join(school, "src/content/extract.ts")
const stat = await lstat(source)
if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000)
  throw new Error("School extractor source is not a bounded regular file")
const reference = await import(pathToFileURL(source).href)
const archive = async (entries) => {
  const zip = new JSZip()
  for (const [path, body] of Object.entries(entries)) zip.file(path, body)
  return zip.generateAsync({ type: "uint8array" })
}
const slides = await archive({
  "ppt/slides/slide2.xml": "<a:t>Second evidence</a:t>",
  "ppt/slides/slide1.xml": "<a:t>First evidence</a:t>",
})
const cells = await archive({
  "xl/worksheets/sheet1.xml":
    '<row><c t="inlineStr"><is><t>Evidence</t></is></c><c><v>42</v></c></row>',
})
const namedCells = await archive({
  "xl/workbook.xml":
    '<workbook><sheets><sheet name="Assumptions" sheetId="1" r:id="r1"/><sheet name="Results &amp; checks" sheetId="2" r:id="r2"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels":
    '<Relationships><Relationship Id="r1" Type="x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Type="x/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
  "xl/worksheets/sheet1.xml": "<row><c><v>10</v></c></row>",
  "xl/worksheets/sheet2.xml": "<row><c><v>42</v></c></row>",
})
const word = await archive({
  "word/document.xml":
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>1.</w:t><w:tab/><w:t>Explain the evidence.</w:t></w:r></w:p><w:p><w:r><w:t>2.</w:t><w:tab/><w:t>State uncertainty.</w:t></w:r></w:p></w:body></w:document>',
})
const cases = [
  { name: "docx-tabs", bytes: word, filename: "reading.docx", contentType: null },
  {
    name: "html-structure",
    bytes: Buffer.from(
      '<h1>Preparation</h1><p>Required:</p><ol><li>Explain the framework.</li><li>Compare evidence.</li></ol><p><strong>Facts</strong> <a href="https://example.test/reading">Reading</a></p>',
    ),
    filename: "reading.html",
    contentType: "text/html",
  },
  {
    name: "html-code-nesting",
    bytes: Buffer.from(
      "<ul><li>Evidence<ul><li>Uncertainty</li></ul></li></ul><pre><code>  preserve indentation\nnext line</code></pre>",
    ),
    filename: "download",
    contentType: "text/html",
  },
  { name: "pptx-extension", bytes: slides, filename: "slides.pptx", contentType: null },
  {
    name: "pptx-mime",
    bytes: slides,
    filename: "download",
    contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
  { name: "xlsx-extension", bytes: cells, filename: "data.xlsx", contentType: null },
  { name: "xlsx-named-extension", bytes: namedCells, filename: "named.xlsx", contentType: null },
  {
    name: "xlsx-named-mime",
    bytes: namedCells,
    filename: "download",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  {
    name: "xlsx-mime",
    bytes: cells,
    filename: "download",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  {
    name: "legacy-xls",
    bytes: Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0]),
    filename: "data.xls",
    contentType: null,
  },
  { name: "raw-unknown", bytes: Uint8Array.from([1, 2]), filename: "data.bin", contentType: null },
]
for (const input of cases) {
  const before = createHash("sha256").update(input.bytes).digest("hex")
  const expected = await reference.extractText(input)
  const actual = await extractText(input)
  if (actual.text !== expected.text)
    throw new Error(`${input.name}: extraction differs (contents withheld)`)
  assert.equal(
    Boolean(actual.notice),
    expected.degraded,
    `${input.name}: degradation status differs`,
  )
  assert.equal(createHash("sha256").update(input.bytes).digest("hex"), before)
}
console.log(
  JSON.stringify(
    {
      status: "pass",
      cases: cases.map((entry) => entry.name),
      sourceHash: createHash("sha256")
        .update(await readFile(source))
        .digest("hex"),
      scope:
        "Exact text and degradation presence for eleven synthetic extraction cases; named-tab cases use aligned metadata/file order, no source bodies printed",
      docxDifferentialTested: true,
      namedSheetDifferentialTested: true,
      basicRichHtmlDifferentialTested: true,
      reorderedMappingAgainstSchoolTested: false,
      liveAccountTested: false,
      academicQualityVerified: false,
    },
    null,
    2,
  ),
)
