import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { draftWorkbookBytes, workbookFromDraft } from "../src/draft-workbook.js"
import { matchesLegacyWorkbook } from "../src/tools.js"

describe("automatic draft workbook extraction", () => {
  it("fixes every ZIP timestamp and narrowly preserves old directory-date renderings", async () => {
    const input = workbookFromDraft("| Label | Value |\n| --- | --- |\n| X | 500 |")
    if (!input) throw new Error("Expected fixture workbook")
    const bytes = await draftWorkbookBytes("| Label | Value |\n| --- | --- |\n| X | 500 |")
    const zip = await JSZip.loadAsync(bytes ?? Buffer.alloc(0))
    zip.forEach((_name, entry) => {
      expect(entry.date.toISOString()).toBe("2000-01-01T00:00:00.000Z")
    })
    zip.forEach((_name, entry) => {
      if (entry.dir) entry.date = new Date("2026-10-12T12:00:00.000Z")
    })
    const legacy = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    })
    expect(legacy).not.toEqual(bytes)
    expect(await matchesLegacyWorkbook(input, legacy)).toBe(true)
    zip.file("xl/worksheets/sheet1.xml", "changed cells", {
      date: new Date("2000-01-01T00:00:00.000Z"),
    })
    const changed = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    })
    expect(await matchesLegacyWorkbook(input, changed)).toBe(false)
  })
  it("names tables by headings, sanitizes/deduplicates and converts accounting values", async () => {
    const text = `### Cash [schedule]
| Ref | Amount ($) |
| --- | ---: |
| A | $1,200 |
| B | (50) |
| Formula | =1+2 |
### Cash [schedule]
| Label | Value |
| --- | --- |
| Empty | |
## Computations
- Profit — 1,150
- Margin — 20%
## Sources
No computations here — 99
`
    expect(workbookFromDraft(text)).toEqual({
      sheets: [
        {
          name: "Cash schedule",
          rows: [
            ["Ref", "Amount ($)"],
            ["A", 1200],
            ["B", -50],
            ["Formula", "=1+2"],
          ],
        },
        {
          name: "Cash schedule (2)",
          rows: [
            ["Label", "Value"],
            ["Empty", ""],
          ],
        },
        {
          name: "Computations",
          rows: [
            ["Label", "Value"],
            ["Profit", 1150],
            ["Margin", "20%"],
          ],
        },
      ],
    })
    const bytes = await draftWorkbookBytes(text)
    expect(bytes).toEqual(await draftWorkbookBytes(text))
    const zip = await JSZip.loadAsync(bytes ?? Buffer.alloc(0))
    const xml = await zip.file("xl/worksheets/sheet1.xml")?.async("string")
    expect(xml).toContain("<v>1200</v>")
    expect(xml).toContain("<v>-50</v>")
    expect(xml).toContain("=1+2")
    expect(xml).not.toContain("<f>")
  })

  it("ignores fenced examples/comments, keeps visible tables and fallback names", () => {
    const text = `<!--
| Secret | Value |
| --- | --- |
| X | 1 |
-->
~~~markdown
## Example
| Label | Value |
| --- | --- |
| X | 2 |
~~~
| Amount ($) | Ref |
| --- | --- |
| 3 | A |
`
    expect(workbookFromDraft(text)?.sheets).toEqual([
      {
        name: "Table 1",
        rows: [
          ["Amount ($)", "Ref"],
          [3, "A"],
        ],
      },
    ])
    expect(workbookFromDraft("No tables or computations.")).toBeNull()
    expect(workbookFromDraft("## Computations\nNo values here.\n")).toBeNull()
  })

  it("fails closed rather than truncating excess tables/cells or unsafe XML", () => {
    expect(() =>
      workbookFromDraft(
        Array.from({ length: 21 }, () => "| X | Y |\n| --- | --- |\n| A | 1 |").join("\n\n"),
      ),
    ).toThrow(/20 sheets/)
    expect(() => workbookFromDraft(`| A | B |\n| --- | --- |\n| \u0000 | 1 |`)).toThrow()
    expect(() => workbookFromDraft("x".repeat(5 * 1024 * 1024 + 1))).toThrow(/extraction limit/)
  })
})
