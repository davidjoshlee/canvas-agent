import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { createConfig } from "../../src/config/index.js"
import { extractText, ingestFile } from "../../src/documents/content.js"
import { captureSimulation, replaySimulation } from "../../src/evaluation/captures.js"
import { completeTask } from "../../src/tasks/completion.js"
import { createAssignmentTask, createPrepTask } from "../../src/tasks/store.js"
import { inspectWorkspace } from "../../src/vault/workspace.js"

async function archive(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [path, value] of Object.entries(files)) zip.file(path, value)
  return zip.generateAsync({ type: "uint8array" })
}

it("routes explicit local ingestion into the preserved namespace and retains older originals, sidecars and tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvas-ingest-preserved-"))
  const vault = join(root, "vault")
  try {
    await mkdir(join(vault, "ACCT312"), { recursive: true })
    const input = join(root, "reading.docx")
    const bytes = Buffer.from(
      await archive({
        "word/document.xml":
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic marginal analysis distinguishes assumptions from evidence.</w:t></w:r></w:p></w:body></w:document>',
      }),
    )
    await writeFile(input, bytes)
    const options = { week: "2026-10-12", asOf: "2026-10-05" }
    const old = await ingestFile(vault, "ACCT312", input, undefined, options)
    if (!old.text) throw new Error("Older sidecar missing")
    const oldSidecar = await readFile(old.text)
    const oldTask = await createPrepTask(vault, "ACCT312", options.week)
    const taskPath = join(vault, "_meta/tasks", oldTask.id, "task.json")
    const taskBytes = await readFile(taskPath)
    await writeFile(
      join(vault, "_meta/canvas-courses.json"),
      JSON.stringify({
        version: 1,
        courses: [{ id: "1", root: "ACCT312", name: "Synthetic", syncNamespace: "Canvas Agent" }],
      }),
    )
    await writeFile(
      join(vault, "_meta/canvas-sync-state.json"),
      JSON.stringify({ version: 1, files: {} }),
    )
    const outside = join(root, "outside")
    await mkdir(outside)
    const alias = join(vault, "ACCT312/Canvas Agent")
    await symlink(outside, alias)
    await expect(ingestFile(vault, "ACCT312", input, undefined, options)).rejects.toThrow(
      /symbolic links/i,
    )
    await rm(alias)
    const current = await ingestFile(vault, "ACCT312", input, undefined, options)
    expect(current.original).toContain("ACCT312/Canvas Agent/Canvas/Files/")
    expect(current.original).not.toBe(old.original)
    if (!current.text) throw new Error("Namespaced sidecar missing")
    expect(await readFile(current.original)).toEqual(bytes)
    expect(await readFile(current.text, "utf8")).toContain(
      'original_path: "ACCT312/Canvas Agent/Canvas/Files/',
    )
    const config = join(root, "config.json")
    await createConfig(config, { vault, baseUrl: "https://canvas.example.test" })
    const executed = spawnSync(
      process.execPath,
      [
        resolve("dist/cli.js"),
        "ingest",
        input,
        "--course",
        "ACCT312",
        "--week",
        options.week,
        "--as-of",
        options.asOf,
        "--config",
        config,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    )
    expect(executed.status, executed.stderr).toBe(0)
    expect(JSON.parse(executed.stdout).text).toBe(current.text)
    const fresh = await createPrepTask(vault, "ACCT312", options.week)
    expect(
      fresh.sources.some(
        (source) =>
          source.path === current.text?.replace(`${vault}/`, "") &&
          source.originalPath?.startsWith("ACCT312/Canvas Agent/"),
      ),
    ).toBe(true)
    expect(fresh.destination).toContain("ACCT312/Canvas Agent/")
    expect(await readFile(old.original)).toEqual(bytes)
    expect(await readFile(old.text)).toEqual(oldSidecar)
    expect(await readFile(taskPath)).toEqual(taskBytes)
    expect(await readFile(input)).toEqual(bytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("refuses damaged preservation mappings and known credential filenames before source-file access", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvas-ingest-preflight-"))
  const vault = join(root, "vault")
  try {
    await mkdir(join(vault, "ACCT312"), { recursive: true })
    for (const name of [
      ".env",
      ".env.local",
      "credentials.json",
      "tokens.txt",
      "school.config.json",
      "canvas-agent.config.json",
    ])
      await expect(ingestFile(vault, "ACCT312", join(root, "nonexistent", name))).rejects.toThrow(
        /Credential\/config files/,
      )
    await mkdir(join(vault, "_meta"))
    const broken = "{INVALID_SYNTHETIC_MAPPING"
    await writeFile(join(vault, "_meta/canvas-courses.json"), broken)
    await expect(
      ingestFile(vault, "ACCT312", join(root, "nonexistent", "reading.txt")),
    ).rejects.toThrow(/mappings are unsafe/)
    expect(await readFile(join(vault, "_meta/canvas-courses.json"), "utf8")).toBe(broken)
    const config = join(root, "custom-settings.json")
    await createConfig(config, { vault, baseUrl: "https://canvas.example.test" })
    const configBytes = await readFile(config)
    for (const source of [config, `${config}.auth.json`]) {
      const result = spawnSync(
        process.execPath,
        [
          resolve("dist/cli.js"),
          "ingest",
          source,
          "--course",
          "ACCT312",
          "--config",
          config,
          "--json",
        ],
        { cwd: root, encoding: "utf8" },
      )
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("Selected CLI config/auth files")
      expect(result.stdout).not.toContain("tokenEnv")
    }
    expect(await readFile(config)).toEqual(configBytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("carries ingested HTML numbered requirements into a source-bound assignment without rewriting an older sidecar", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvas-rich-html-task-"))
  const vault = join(root, "vault")
  try {
    await mkdir(join(vault, "CS101/Assignments"), { recursive: true })
    const prompt = "CS101/Assignments/prompt.md"
    await writeFile(
      join(vault, prompt),
      "---\ntype: assignment\ncanvas_id: '50'\n---\nComplete the attached requirements.",
    )
    const input = join(root, "requirements.html")
    const bytes = Buffer.from(
      "<h1>Case preparation</h1><p>Required:</p><ol><li>Explain the framework.</li><li>Compare the evidence.</li></ol>",
    )
    await writeFile(input, bytes)
    const ingested = await ingestFile(vault, "CS101", input)
    if (!ingested.text) throw new Error("Expected structured extraction")
    const text = await readFile(ingested.text, "utf8")
    const path = ingested.text.replace(`${vault}/`, "")
    const task = await createAssignmentTask(vault, "CS101", prompt, "outline", undefined, [path])
    expect(task.deliverable).toMatchObject({
      sourcePath: path,
      items: [{ text: "Explain the framework." }, { text: "Compare the evidence." }],
    })
    const candidate = join(root, "candidate.md")
    await writeFile(
      candidate,
      [
        `Task: ${task.id}`,
        ...task.requirements.map(
          (heading) =>
            `## ${heading}\nSynthetic structural response cites the selected source. \`${path}\``,
        ),
      ].join("\n\n"),
    )
    await expect(completeTask(vault, task.id, candidate)).rejects.toThrow(/subheading/)
    expect(await readFile(input)).toEqual(bytes)
    expect(await readFile(ingested.original)).toEqual(bytes)
    // An existing student-edited or older extraction is retained on retry.
    const retained = `${text}\nStudent-owned annotation.\n`
    await writeFile(ingested.text, retained)
    expect((await ingestFile(vault, "CS101", input)).text).toBe(ingested.text)
    expect(await readFile(ingested.text, "utf8")).toBe(retained)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

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
  it("retains Word tab-separated requirements and rejects XML declarations before parsing", async () => {
    const xml =
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Required:</w:t></w:r></w:p><w:p><w:r><w:t>1.</w:t><w:tab/><w:t>Explain evidence.</w:t></w:r></w:p><w:p><w:r><w:t>2.</w:t><w:tab/><w:t>State uncertainty.</w:t></w:r></w:p></w:body></w:document>'
    const bytes = await archive({ "word/document.xml": xml })
    expect((await extractText({ bytes, filename: "questions.docx" })).text).toBe(
      "Required:\n\n1.\tExplain evidence.\n\n2.\tState uncertainty.",
    )
    const blocked = await extractText({
      bytes: await archive({
        "word/document.xml": `<!DOCTYPE document SYSTEM "file:///PRIVATE_XML_TARGET">${xml}`,
      }),
      filename: "unsafe.docx",
    })
    expect(blocked.text).toBeNull()
    expect(blocked.notice).toContain("unsupported declarations")
    expect(JSON.stringify(blocked)).not.toContain("PRIVATE_XML_TARGET")
    const root = await mkdtemp(join(tmpdir(), "canvas-word-reachability-"))
    try {
      const file = join(root, "input.docx")
      await writeFile(file, bytes)
      const code = `import {createRequire} from "node:module"; import {readFile} from "node:fs/promises"; const {extractText}=await import(${JSON.stringify(pathToFileURL(resolve("dist/documents/content.js")).href)}); await extractText({bytes:await readFile(process.argv[1]),filename:"input.docx"}); const require=createRequire(import.meta.url); const paths=Object.keys(require.cache); if(paths.some(path=>path.includes("/argparse/")||path.includes("/sprintf-js/"))) throw new Error("CLI formatter unexpectedly loaded"); console.log("formatter-unloaded");`
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", code, file], {
        cwd: root,
        encoding: "utf8",
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe("formatter-unloaded")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it("preserves rich HTML requirements, links and code indentation without active content or unsafe targets", async () => {
    const html =
      '<h1>Preparation</h1><p>Required:</p><ol><li>Explain the framework.<ul><li>Separate assumptions.</li></ul></li><li>Compare evidence.</li></ol><p><a href="https://example.test/reading">Reading</a> <strong>Evidence</strong></p><pre><code>  preserve spacing\nnext line</code></pre><script>ACTIVE_SECRET_SENTINEL</script><iframe>FRAME_SENTINEL</iframe><a href="java&#115;cript:alert(1)">Unsafe target label</a>'
    const result = await extractText({ bytes: Buffer.from(html), filename: "reading.html" })
    expect(result.text).toContain("Preparation\n===========")
    expect(result.text).toMatch(/1\.\s+Explain the framework/)
    expect(result.text).toMatch(/2\.\s+Compare evidence/)
    expect(result.text).toContain("[Reading](https://example.test/reading)")
    expect(result.text).toContain("**Evidence**")
    expect(result.text).toContain("    preserve spacing")
    expect(result.text).not.toMatch(/ACTIVE_SECRET_SENTINEL|FRAME_SENTINEL|javascript:/)
    expect(result.text).toContain("Unsafe target label")
    await expect(
      extractText({ bytes: Buffer.from("<p>".repeat(100_001)), filename: "dense.html" }),
    ).resolves.toMatchObject({ text: null, notice: expect.stringContaining("bounded extraction") })
  })
  it("retains workbook tab names by relationship rather than filename order and labels missing mappings", async () => {
    const files = {
      "xl/workbook.xml":
        '<workbook><sheets><sheet name="Results &amp; checks" sheetId="7" r:id="rB"/><sheet name="Assumptions" sheetId="3" r:id="rA"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rB" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
      "xl/worksheets/sheet1.xml": "<row><c><v>10</v></c></row>",
      "xl/worksheets/sheet2.xml": "<row><c><v>42</v></c></row>",
    }
    const bytes = await archive(files)
    expect((await extractText({ bytes, filename: "named.xlsx" })).text).toBe(
      "## Results & checks\n42\n\n## Assumptions\n10",
    )
    const { "xl/_rels/workbook.xml.rels": _rels, ...missing } = files
    const unbound = await extractText({ bytes: await archive(missing), filename: "unbound.xlsx" })
    expect(unbound.text).toBe(
      "## Workbook tabs without worksheet mapping\n- Results & checks\n- Assumptions\n\n## Sheet 1\n10\n\n## Sheet 2\n42",
    )
    expect(unbound.notice).toBeUndefined()
    expect(
      (
        await extractText({
          bytes: await archive({ "xl/workbook.xml": files["xl/workbook.xml"] }),
          filename: "empty.xlsx",
        })
      ).text,
    ).toBeNull()
    for (const relations of [
      '<Relationship Id="rB" Type="x/worksheet" Target="https://example.test/private?token=DO_NOT_ECHO" TargetMode="External"/>',
      '<Relationship Id="rB" Type="x/worksheet" Target="../../private.xml"/>',
      '<Relationship Id="rB" Type="x/worksheet" Target="worksheets/missing.xml"/>',
      '<Relationship Id="rB" Type="x/worksheet" Target="worksheets/sheet2.xml/>',
      '<Relationship Id="rB" Type="x/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rB" Type="x/worksheet" Target="worksheets/sheet1.xml"/>',
    ]) {
      const result = await extractText({
        bytes: await archive({
          ...files,
          "xl/_rels/workbook.xml.rels": `<Relationships>${relations}</Relationships>`,
        }),
        filename: "unsafe.xlsx",
      })
      expect(result.text).toBeNull()
      expect(result.notice).toMatch(/workbook/i)
      expect(JSON.stringify(result)).not.toContain("DO_NOT_ECHO")
    }
  })
  it("recognizes Office MIME types without filename extensions and reports legacy containers without inventing text", async () => {
    const fixtures = [
      {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        files: {
          "word/document.xml":
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic Word evidence</w:t></w:r></w:p></w:body></w:document>',
        },
        expected: "Synthetic Word evidence",
      },
      {
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        files: { "ppt/slides/slide1.xml": "<a:t>Synthetic slide evidence</a:t>" },
        expected: "Synthetic slide evidence",
      },
      {
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        files: {
          "xl/worksheets/sheet1.xml":
            '<row><c t="inlineStr"><is><t>Synthetic cell</t></is></c></row>',
        },
        expected: "Synthetic cell",
      },
    ]
    for (const fixture of fixtures) {
      const bytes = await archive(fixture.files)
      const result = await extractText({
        bytes,
        filename: "download",
        contentType: `${fixture.contentType}; charset=binary`,
      })
      expect(result.text).toContain(fixture.expected)
      expect(result.notice).toBeUndefined()
    }
    const bytes = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2])
    await expect(extractText({ bytes, filename: "legacy.xls" })).resolves.toMatchObject({
      text: null,
      notice: expect.stringContaining("convert to .xlsx"),
    })
    await expect(
      extractText({ bytes, filename: "download", contentType: "application/vnd.ms-excel" }),
    ).resolves.toMatchObject({ text: null, notice: expect.stringContaining("Legacy .xls") })
    await expect(extractText({ bytes, filename: "encrypted.xlsx" })).resolves.toMatchObject({
      text: null,
      notice: expect.stringContaining("encrypted binary Office"),
    })
  })
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
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Docx example</w:t></w:r></w:p></w:body></w:document>',
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

  it("keeps explicit ingestion availability separate from teaching dates and preserves versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "canvas-ingest-availability-"))
    try {
      await mkdir(join(root, "ACCT312"), { recursive: true })
      const input = join(root, "reading.txt")
      await writeFile(input, "Synthetic reading available before its teaching week.")
      const first = await ingestFile(root, "ACCT312", input, undefined, {
        week: "2026-10-12",
        asOf: "2026-10-05",
      })
      const later = await ingestFile(root, "ACCT312", input, undefined, {
        week: "2026-10-12",
        asOf: "2026-10-10",
      })
      expect(first.original).toBe(later.original)
      expect(first.text).not.toBe(later.text)
      if (!first.text || !later.text) throw new Error("Expected both extraction sidecars")
      const before = await readFile(first.text, "utf8")
      const config = join(root, "config.json")
      await createConfig(config, { vault: root, baseUrl: "https://canvas.example.test" })
      const executed = spawnSync(
        process.execPath,
        [
          resolve("dist/cli.js"),
          "ingest",
          input,
          "--course",
          "ACCT312",
          "--week",
          "2026-10-12",
          "--as-of",
          "2026-10-05",
          "--config",
          config,
          "--json",
        ],
        { encoding: "utf8" },
      )
      expect(executed.status, executed.stderr).toBe(0)
      expect(JSON.parse(executed.stdout)).toMatchObject({ text: first.text })
      await expect(
        ingestFile(root, "ACCT312", input, undefined, {
          week: "2026-10-12",
          asOf: "2026-10-05",
        }),
      ).resolves.toMatchObject({ text: first.text })
      expect(await readFile(first.text, "utf8")).toBe(before)
      const workspace = await inspectWorkspace(root)
      for (const path of [first.text, later.text])
        expect(
          workspace.courses[0]?.sources.find(
            (source) => source.path === path.replace(`${root}/`, ""),
          )?.dates,
        ).toEqual(["2026-10-12"])
      for (const asOf of ["2026-02-30", "tomorrow", "2026-10-05T00:00:00Z"])
        await expect(ingestFile(root, "ACCT312", input, undefined, { asOf })).rejects.toThrow(
          /real availability date/,
        )
      const snapshot = await captureSimulation(root, "ACCT312", "2026-10-09")
      const replay = await replaySimulation(root, snapshot.id)
      expect(replay.sources.map((source) => source.path)).toContain(
        first.text.replace(`${root}/`, ""),
      )
      expect(replay.sources.map((source) => source.path)).not.toContain(
        later.text.replace(`${root}/`, ""),
      )
      expect(await readFile(input, "utf8")).toBe(
        "Synthetic reading available before its teaching week.",
      )
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
