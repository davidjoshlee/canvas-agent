import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"
import JSZip from "jszip"
import { draftWorkbookBytes, workbookFromDraft } from "../src/draft-workbook.ts"

// Explicit checkout, synthetic strings only. No account, config, vault or providers.
const school = process.argv[2]
if (!school || !isAbsolute(school)) throw new Error("Supply an absolute School checkout")
const extraction = join(school, "src/store/xlsx-extract.ts")
const writer = join(school, "src/store/xlsx.ts")
const { sheetsFromDraft } = await import(pathToFileURL(extraction).href)
const { sanitizeSheetNames, buildXlsx } = await import(pathToFileURL(writer).href)
const examples = [
  "No tables here.",
  "| Amount ($) | Ref |\n| --- | --- |\n| $1,200 | A |\n| (50) | B |",
  "### Cash [schedule]\n| Debit | Credit |\n| --- | --- |\n| 100 | 20 |\n\n### Cash [schedule]\n| Debit | Credit |\n| --- | --- |\n| 3 | 4 |",
  "## Computations\n- Profit — 1,150\n- Margin — 20%\n## Sources\nOther — 99",
  "### Values\n| A | B |\n| --- | --- |\n| =1+2 | |\n| NaN | 1.25 |\n\n## Computations\n- Total — $1,200",
  "| Cash ($M) | Debit | Credit |\n| :--- | ---: | :---: |\n| Balance | 50 | (30) |",
]
function cellValues(xml) {
  return [...xml.matchAll(/<c\b[^>]*r="([^"]+)"[^>]*>([\s\S]*?)<\/c>/g)].map((m) => {
    const numeric = m[2].match(/<v>([\s\S]*?)<\/v>/)?.[1]
    const text = m[2].match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/)?.[1]
    return [m[1], numeric === undefined ? "text" : "number", numeric ?? text ?? ""]
  })
}
for (const text of examples) {
  const original = sheetsFromDraft(text)
  const input = workbookFromDraft(text)
  if (!original.length) {
    assert.equal(input, null)
    continue
  }
  assert.deepEqual(
    input.sheets.map((s) => s.name),
    sanitizeSheetNames(original.map((s) => s.name)),
  )
  const a = await JSZip.loadAsync(await buildXlsx(original))
  const b = await JSZip.loadAsync(await draftWorkbookBytes(text))
  for (let i = 1; i <= original.length; i++) {
    const path = `xl/worksheets/sheet${i}.xml`
    assert.deepEqual(
      cellValues(await b.file(path).async("string")),
      cellValues(await a.file(path).async("string")),
    )
  }
}
console.log(
  JSON.stringify(
    {
      cases: examples.length,
      status: "passed",
      scope: "synthetic extraction and XLSX cell/name parity, not live academic outputs",
      sourceHashes: await Promise.all(
        [extraction, writer].map(async (path) => ({
          path,
          sha256: createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        })),
      ),
    },
    null,
    2,
  ),
)
