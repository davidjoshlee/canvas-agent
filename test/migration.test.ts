import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const failure = vi.hoisted(() => ({ destination: "", mutateAfterCopy: "" }))
vi.mock("node:fs/promises", async () => {
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  return {
    ...fs,
    copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
      if (String(args[1]) === failure.destination)
        throw new Error("Injected exclusive-copy failure")
      await fs.copyFile(...args)
      if (String(args[1]) === failure.mutateAfterCopy)
        await fs.writeFile(args[0], "Concurrent student edit preserved.\n")
    },
  }
})

import { applyLayoutMigration, planLayoutMigration } from "../src/migration.js"
import { createPrepTask } from "../src/tasks.js"
import { inspectWorkspace } from "../src/workspace.js"

const roots: string[] = []
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-migration-"))
  roots.push(root)
  await mkdir(join(root, "TEST101"))
  return root
}
async function document(
  root: string,
  path: string,
  metadata: string,
  body = "Synthetic source evidence.",
) {
  const full = join(root, "TEST101", path)
  await mkdir(join(full, ".."), { recursive: true })
  await writeFile(full, `---\n${metadata}\n---\n${body}\n`)
}
afterEach(async () => {
  failure.destination = ""
  failure.mutateAfterCopy = ""
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe("recoverable document-layout migration", () => {
  it.each([
    ['<a href="../files/R&copy;D.md">Reading</a>', /Unsupported named HTML entity/],
    ['<a href="../files/R&#0;D.md">Reading</a>', /Invalid numeric HTML entity/],
    [`[Deep](../files/${"(".repeat(33)}file${")".repeat(33)}.md)`, /nesting exceeds/],
    ["[Unclosed](../files/file(v1).md", /(?:Unclosed|Multiline) Markdown/],
  ])("refuses unsupported or malformed link syntax without writes: %s", async (body, reason) => {
    const root = await fixture()
    await document(root, "modules/Lesson.md", "type: modules", body)
    const before = await readFile(join(root, "TEST101/modules/Lesson.md"))
    const plan = await planLayoutMigration(root, ["TEST101"])
    expect(plan.conflicts.join("\n")).toMatch(reason)
    await expect(applyLayoutMigration(plan, ["TEST101"])).rejects.toThrow()
    expect(await readFile(join(root, "TEST101/modules/Lesson.md"))).toEqual(before)
  })
  it("rebases balanced/escaped parentheses and encoded HTML filenames without altering titles or literals", async () => {
    const root = await fixture()
    for (const name of ["Case(v1).md", "Case(final.md", "R&D.md", "O'Reilly.md"])
      await document(root, `files/${name}`, "type: files", "Synthetic assigned reading.")
    const body = [
      '[Balanced](../files/Case(v1).md "Case (first edition)")',
      "[Angle](<../files/Case(v1).md>)",
      "[Escaped](../files/Case\\(final.md)",
      '<a href="../files/R&amp;D.md?x=1&amp;y=2">Reading</a>',
      "<a href='../files/O&#39;Reilly.md'>Publisher</a>",
      '<a href="../files/Case&#40;v1&#41;.md">Case</a>',
      "`[Literal](../files/Case(v1).md)`",
      "<!-- <a href='../files/R&amp;D.md'>History</a> -->",
    ].join("\n")
    await document(
      root,
      "modules/Lesson.md",
      "type: modules\ncanvas_id: '100'\ndates:\n  session_at: '2026-10-13'",
      body,
    )
    const plan = await planLayoutMigration(root, ["TEST101"])
    expect(plan.conflicts).toEqual([])
    const lesson = plan.moves.find((move) => move.source.endsWith("Lesson.md"))
    if (!lesson) throw new Error("Missing synthetic lesson")
    await applyLayoutMigration(plan, ["TEST101"])
    const migrated = await readFile(join(root, lesson.destination), "utf8")
    expect(migrated).toContain(
      '[Balanced](../../Resources/Files/Case%28v1%29.md "Case (first edition)")',
    )
    expect(migrated).toContain("[Angle](<../../Resources/Files/Case%28v1%29.md>)")
    expect(migrated).toContain("[Escaped](../../Resources/Files/Case%28final.md)")
    expect(migrated).toContain('href="../../Resources/Files/R%26D.md?x=1&amp;y=2"')
    expect(migrated).toContain("href='../../Resources/Files/O&#39;Reilly.md'")
    expect(migrated).toContain("`[Literal](../files/Case(v1).md)`")
    expect(migrated).toContain("<!-- <a href='../files/R&amp;D.md'>History</a> -->")
  })
  it.each(["flow-list", "block-list", "scalar"])(
    "rebases %s related_paths without losing YAML comments or source selection",
    async (style) => {
      const root = await fixture()
      await document(
        root,
        "files/Reading Notes.md",
        "type: files",
        "Synthetic assigned theory evidence.",
      )
      const related =
        style === "flow-list"
          ? 'related_paths: ["TEST101/files/Reading Notes.md"] # preserve related comment'
          : style === "block-list"
            ? 'related_paths:\n  - "files/Reading Notes.md" # preserve related comment'
            : 'related_paths: "TEST101/files/Reading Notes.md" # preserve related comment'
      await document(
        root,
        "modules/Lesson.md",
        `type: modules\ncanvas_id: '100'\n${related}\n# preserve unrelated comment\ndates:\n  session_at: '2026-10-13'`,
        "Synthetic substantive teaching overview.",
      )
      const original = await readFile(join(root, "TEST101/modules/Lesson.md"), "utf8")
      const plan = await planLayoutMigration(root, ["TEST101"])
      expect(plan.conflicts).toEqual([])
      const lesson = plan.moves.find((move) => move.source.endsWith("Lesson.md"))
      if (!lesson) throw new Error("Missing synthetic module move")
      expect(lesson.destinationHash).toBeTruthy()
      const result = await applyLayoutMigration(plan, ["TEST101"])
      const rewritten = await readFile(join(root, lesson.destination), "utf8")
      expect(rewritten).toContain("TEST101/Resources/Files/Reading Notes.md")
      expect(rewritten).toContain("# preserve related comment")
      expect(rewritten).toContain("# preserve unrelated comment")
      const workspace = await inspectWorkspace(root)
      expect(
        workspace.courses[0]?.sources.find((source) => source.path === lesson.destination)
          ?.relatedPaths,
      ).toContain("TEST101/Resources/Files/Reading Notes.md")
      expect(
        (await createPrepTask(root, "TEST101", "2026-10-12")).sources.some(
          (source) => source.path === "TEST101/Resources/Files/Reading Notes.md",
        ),
      ).toBe(true)
      expect(await readFile(join(result.archive, "originals", lesson.source), "utf8")).toBe(
        original,
      )
    },
  )
  it("rebases reference definitions, HTML attributes and explicit Obsidian wiki links", async () => {
    const root = await fixture()
    await writeFile(join(root, "TEST101/_index.md"), "Synthetic course navigation.\n")
    await document(root, "files/Reading Notes.md", "type: files", "Synthetic assigned reading.")
    await document(
      root,
      "modules/Lesson.md",
      "type: modules\ncanvas_id: '100'\ndates:\n  session_at: '2026-10-13'",
      [
        '[reading]: <../files/Reading Notes.md#ideas> "Assigned reading"',
        "[Read][reading]",
        '<a class="reading" href="../files/Reading%20Notes.md#ideas">Read</a>',
        "<a href=../files/Reading%20Notes.md?p=1&amp;b=2>Read</a>",
        "[[TEST101/files/Reading Notes#ideas|Assigned reading]]",
        "![[TEST101/files/Reading Notes.md]]",
        "[[TEST101/_index|Course home]]",
        '<a href="https://example.test/?a=1&amp;b=2">External</a>',
        "[External](https://example.test/a(b))",
        "<!-- [[TEST101/files/Reading Notes]] -->",
      ].join("\n"),
    )
    const plan = await planLayoutMigration(root, ["TEST101"])
    expect(plan.conflicts).toEqual([])
    const lesson = plan.moves.find((move) => move.source.endsWith("Lesson.md"))
    if (!lesson) throw new Error("Fixture lesson missing")
    const result = await applyLayoutMigration(plan, ["TEST101"])
    const rewritten = await readFile(join(root, lesson.destination), "utf8")
    expect(rewritten).toContain(
      '[reading]: <../../Resources/Files/Reading%20Notes.md#ideas> "Assigned reading"',
    )
    expect(rewritten).toContain('href="../../Resources/Files/Reading%20Notes.md#ideas"')
    expect(rewritten).toContain('href="../../Resources/Files/Reading%20Notes.md?p=1&amp;b=2"')
    expect(rewritten).toContain("[[TEST101/Resources/Files/Reading Notes#ideas|Assigned reading]]")
    expect(rewritten).toContain("![[TEST101/Resources/Files/Reading Notes.md]]")
    expect(rewritten).toContain("[[TEST101/_index|Course home]]")
    expect(rewritten).toContain('href="https://example.test/?a=1&amp;b=2"')
    expect(rewritten).toContain("[External](https://example.test/a(b))")
    expect(rewritten).toContain("<!-- [[TEST101/files/Reading Notes]] -->")
    expect(digest(await readFile(join(result.archive, "originals", lesson.source)))).toBe(
      lesson.hash,
    )
  })
  it("refuses wiki links whose exact and extensionless targets are ambiguous", async () => {
    const root = await fixture()
    await document(root, "files/Reading", "type: files")
    await document(root, "files/Reading.md", "type: files")
    await document(root, "modules/Link.md", "type: modules", "[[TEST101/files/Reading]]")
    const plan = await planLayoutMigration(root, ["TEST101"])
    expect(plan.ready).toBe(false)
    expect(plan.conflicts.join("\n")).toMatch(/absent or ambiguous/)
    await expect(applyLayoutMigration(plan, ["TEST101"])).rejects.toThrow(/conflicts/)
  })
  it("rebases short wiki links only with explicit selected-course filename choices", async () => {
    const root = await fixture()
    await document(root, "files/Reading Notes.md", "type: files", "Synthetic reading.")
    await document(
      root,
      "guidance/Reading Notes.md",
      "type: guidance",
      "A distinct same-name document.",
    )
    await document(
      root,
      "modules/Lesson.md",
      "type: modules",
      [
        "[[Reading Notes#ideas|Assigned reading]]",
        "![[Reading Notes.md#^block]]",
        "`[[Reading Notes]]`",
        "<!-- [[Reading Notes]] -->",
      ].join("\n"),
    )
    const blocked = await planLayoutMigration(root, ["TEST101"])
    expect(blocked.ready).toBe(false)
    expect(blocked.conflicts.join("\n")).toContain("--wiki-target")
    const wikiTargets = [{ name: "Reading Notes", target: "TEST101/files/Reading Notes.md" }]
    const plan = await planLayoutMigration(root, ["TEST101"], { wikiTargets })
    expect(plan.conflicts).toEqual([])
    const lesson = plan.moves.find((move) => move.source.endsWith("Lesson.md"))
    if (!lesson) throw new Error("Fixture lesson missing")
    const original = await readFile(join(root, lesson.source))
    const changedChoice = structuredClone(plan)
    changedChoice.wikiTargets[0] = {
      name: "Reading Notes",
      target: "TEST101/guidance/Reading Notes.md",
    }
    await expect(applyLayoutMigration(changedChoice, ["TEST101"])).rejects.toThrow(/stale/)
    expect(await readFile(join(root, lesson.source))).toEqual(original)
    const result = await applyLayoutMigration(plan, ["TEST101"])
    const rewritten = await readFile(join(root, lesson.destination), "utf8")
    expect(rewritten).toContain("[[TEST101/Resources/Files/Reading Notes#ideas|Assigned reading]]")
    expect(rewritten).toContain("![[TEST101/Resources/Files/Reading Notes.md#^block]]")
    expect(rewritten).toContain("`[[Reading Notes]]`")
    expect(rewritten).toContain("<!-- [[Reading Notes]] -->")
    expect(await readFile(join(result.archive, "originals", lesson.source))).toEqual(original)
  })
  it("refuses duplicate, unsafe, differently named or out-of-scope wiki choices", async () => {
    const root = await fixture()
    await document(root, "files/Reading.md", "type: files")
    for (const wikiTargets of [
      [{ name: "Reading", target: "OTHER101/files/Reading.md" }],
      [{ name: "Reading", target: "TEST101/_meta/Reading.md" }],
      [{ name: "Reading", target: "TEST101/files/Other.md" }],
      [
        { name: "Reading", target: "TEST101/files/Reading.md" },
        { name: "Reading.md", target: "TEST101/files/Reading.md" },
      ],
    ])
      await expect(planLayoutMigration(root, ["TEST101"], { wikiTargets })).rejects.toThrow(
        /Wiki|wiki/,
      )
  })
  it("rolls back rewritten destinations using output hashes while restoring original source bytes", async () => {
    const root = await fixture()
    await mkdir(join(root, "TEST101/files"))
    const original = Buffer.from([1, 2, 255])
    await writeFile(join(root, "TEST101/files/A.bin"), original)
    await document(
      root,
      "files/A.bin.md",
      `type: files\noriginal_path: TEST101/files/A.bin\noriginal_hash: ${digest(original)}`,
    )
    await document(root, "guidance/Fail.md", "type: guidance")
    const plan = await planLayoutMigration(root, ["TEST101"])
    const fail = plan.moves.find((move) => move.source.endsWith("Fail.md"))
    if (!fail) throw new Error("Fixture failure move missing")
    failure.destination = join(root, fail.destination)
    await expect(applyLayoutMigration(plan, ["TEST101"])).rejects.toThrow(/originals restored/)
    for (const move of plan.moves) {
      expect(digest(await readFile(join(root, move.source)))).toBe(move.hash)
      await expect(readFile(join(root, move.destination))).rejects.toThrow()
    }
  })
  it("rebases extraction originals and local links while preserving archived bytes and historical literals", async () => {
    const root = await fixture()
    await mkdir(join(root, "TEST101/files"))
    const original = Buffer.from([1, 2, 3, 255])
    await writeFile(join(root, "TEST101/files/Reading Notes.pdf"), original)
    const captured =
      '<!-- school-agent provenance: {"sourcePath":"TEST101/files/Reading Notes.pdf"} -->'
    await document(
      root,
      "files/Reading Notes.pdf.md",
      `type: files\noriginal_path: 'TEST101/files/Reading Notes.pdf'\noriginal_hash: ${digest(original)}`,
      `${captured}\n\n[Original](<Reading Notes.pdf#page=2>)\n\n\`[Literal](../not-real.md)\`\n\n\`\`\`text\n[Example](../not-real.md)\n\`\`\`\n\nExtracted synthetic reading.`,
    )
    await document(
      root,
      "modules/Lesson.md",
      "type: modules\ncanvas_id: '100'\ndates:\n  session_at: '2026-10-13'",
      '[Reading](../files/Reading%20Notes.pdf.md "Assigned")\n[External](https://example.test/a)\n[Section](#reading)',
    )
    const plan = await planLayoutMigration(root, ["TEST101"])
    expect(plan.conflicts).toEqual([])
    const sidecar = plan.moves.find((move) => move.source.endsWith(".pdf.md"))
    const lesson = plan.moves.find((move) => move.source.endsWith("Lesson.md"))
    if (!sidecar || !lesson) throw new Error("Fixture reference moves missing")
    expect(sidecar.destinationHash).not.toBe(sidecar.hash)
    expect(lesson.destinationHash).not.toBe(lesson.hash)
    const result = await applyLayoutMigration(plan, ["TEST101"])
    const rewritten = await readFile(join(root, sidecar.destination), "utf8")
    expect(rewritten).toContain('original_path: "TEST101/Resources/Files/Reading Notes.pdf"')
    expect(rewritten).toContain("[Original](<Reading%20Notes.pdf#page=2>)")
    expect(rewritten).toContain(captured)
    expect(rewritten).toContain("[Literal](../not-real.md)")
    expect(rewritten).toContain("[Example](../not-real.md)")
    expect(await readFile(join(root, lesson.destination), "utf8")).toContain(
      '[Reading](../../Resources/Files/Reading%20Notes.pdf.md "Assigned")',
    )
    expect(digest(await readFile(join(root, sidecar.destination)))).toBe(sidecar.destinationHash)
    expect(digest(await readFile(join(result.archive, "originals", sidecar.source)))).toBe(
      sidecar.hash,
    )
    const context = await inspectWorkspace(root)
    expect(
      context.courses[0]?.sources.find((source) => source.path === sidecar.destination),
    ).toMatchObject({
      originalPath: "TEST101/Resources/Files/Reading Notes.pdf",
      originalHash: digest(original),
    })
  })
  it.each([
    "[Reading](../../../outside.md)",
    "[[Reading]]",
    "[read]: ../files/reading.md",
    '<a href="../files/reading.md">Reading</a>',
  ])("blocks unsafe, ambiguous or missing local reference targets: %s", async (body) => {
    const root = await fixture()
    await document(root, "modules/Reference.md", "type: modules", body)
    const plan = await planLayoutMigration(root, ["TEST101"])
    expect(plan.ready).toBe(false)
    await expect(applyLayoutMigration(plan, ["TEST101"])).rejects.toThrow(/conflicts/)
    await expect(readdir(join(root, "_meta"))).rejects.toThrow()
  })
  it("preserves a concurrent source edit instead of archiving or overwriting it", async () => {
    const root = await fixture()
    await document(root, "guidance/Guide.md", "type: guidance")
    const plan = await planLayoutMigration(root, ["TEST101"])
    const move = plan.moves[0]
    if (!move) throw new Error("Fixture move missing")
    failure.mutateAfterCopy = join(root, move.destination)
    await expect(applyLayoutMigration(plan, ["TEST101"])).rejects.toThrow(
      /Destination preserved for review/,
    )
    expect(await readFile(join(root, move.source), "utf8")).toBe(
      "Concurrent student edit preserved.\n",
    )
    expect(digest(await readFile(join(root, move.destination)))).toBe(move.hash)
  })
  it("previews categories without writes and archives byte-identical originals on apply", async () => {
    const root = await fixture()
    await document(
      root,
      "modules/Session.md",
      "type: modules\ncanvas_id: '100'\ndates:\n  session_at: '2026-10-13T12:00:00Z'",
    )
    await document(
      root,
      "assignments/20 - Case.md",
      "type: assignments\ncanvas_id: '20'\ndates:\n  due_at: '2026-10-15T12:00:00Z'",
    )
    await document(root, "drafts/Case.md", "type: drafts\ncanvas_id: '20'")
    await document(root, "final/Case.md", "type: final\ncanvas_id: '20'")
    await document(root, "files/reading.bin.md", "type: files\nmodule_canvas_id: '100'")
    await writeFile(join(root, "TEST101/files/reading.bin"), Buffer.from([0, 1, 2, 255]))
    const plan = await planLayoutMigration(root, ["TEST101"])
    expect(plan.ready).toBe(true)
    expect(plan.moves.map((move) => move.destination)).toEqual(
      expect.arrayContaining([
        "TEST101/Week 01 - Oct 12/Other/Session.md",
        "TEST101/Week 01 - Oct 12/Materials/reading.bin",
        "TEST101/Assignments/2026-10-15 - Case/00 Prompt.md",
        "TEST101/Assignments/2026-10-15 - Case/Drafts/Case.md",
        "TEST101/Assignments/2026-10-15 - Case/Finals/Case.md",
      ]),
    )
    await expect(readdir(join(root, "_meta"))).rejects.toThrow()
    const result = await applyLayoutMigration(plan, ["TEST101"])
    expect(result.moved).toBe(6)
    for (const move of plan.moves) {
      expect(digest(await readFile(join(root, move.destination)))).toBe(move.hash)
      expect(digest(await readFile(join(result.archive, "originals", move.source)))).toBe(move.hash)
      await expect(readFile(join(root, move.source))).rejects.toThrow()
    }
    await expect(readFile(join(root, "_meta/layout.json"))).rejects.toThrow()
    await expect(readdir(join(root, "_meta/vault-migration.lock"))).rejects.toThrow()
    expect((await planLayoutMigration(root, ["TEST101"])).moves).toHaveLength(0)
  })
  it("does not use created_at or invalid calendar dates to invent a week", async () => {
    const root = await fixture()
    await document(
      root,
      "modules/Undated.md",
      "type: modules\ncanvas_id: '1'\ndates:\n  session_at: '2026-02-31'\n  created_at: '2026-10-13T12:00:00Z'",
    )
    const plan = await planLayoutMigration(root, ["TEST101"])
    expect(plan.moves[0]?.destination).toBe("TEST101/Other/Undated.md")
    expect(plan.warnings).toHaveLength(1)
  })
  it("refuses source changes, existing destinations and forged moves before writing", async () => {
    const root = await fixture()
    await document(root, "guidance/Guide.md", "type: guidance")
    const plan = await planLayoutMigration(root, ["TEST101"])
    const move = plan.moves[0]
    if (!move) throw new Error("Fixture move missing")
    await expect(
      applyLayoutMigration({ ...plan, moves: [{ ...move, destination: "../outside" }] }, [
        "TEST101",
      ]),
    ).rejects.toThrow(/stale/)
    await document(root, "guidance/Guide.md", "type: guidance", "Changed source.")
    await expect(applyLayoutMigration(plan, ["TEST101"])).rejects.toThrow(/stale/)
    await document(
      root,
      "Resources/Guidance/Guide.md",
      "type: guidance",
      "Student-owned destination.",
    )
    const conflict = await planLayoutMigration(root, ["TEST101"])
    expect(conflict.ready).toBe(false)
    await expect(applyLayoutMigration(conflict, ["TEST101"])).rejects.toThrow(/conflicts/)
    await expect(readdir(join(root, "_meta"))).rejects.toThrow()
  })
  it("flags colliding output names and references needing a reviewed rebase", async () => {
    const root = await fixture()
    await document(root, "files/one/same.md", "type: files", "[Reading](../../files/read.md)")
    await document(root, "files/two/same.md", "type: files\noriginal_path: TEST101/files/read.pdf")
    const plan = await planLayoutMigration(root, ["TEST101"])
    expect(plan.ready).toBe(false)
    expect(plan.conflicts.join("\n")).toMatch(/Multiple legacy files/)
    expect(plan.conflicts.join("\n")).toMatch(/Reference rebasing blocked/)
    expect(plan.conflicts.join("\n")).toMatch(/Extraction original/)
  })
  it("rejects traversal, symlinks and another operation's lock", async () => {
    const root = await fixture()
    await expect(planLayoutMigration(root, ["../TEST101"])).rejects.toThrow(/safe immediate/)
    await document(root, "guidance/Guide.md", "type: guidance")
    const plan = await planLayoutMigration(root, ["TEST101"])
    await mkdir(join(root, "_meta/vault-migration.lock"), { recursive: true })
    await expect(applyLayoutMigration(plan, ["TEST101"])).rejects.toThrow(/locked/)
    expect(await readdir(join(root, "_meta/vault-migration.lock"))).toEqual([])
    await symlink(join(root, "TEST101/guidance/Guide.md"), join(root, "TEST101/guidance/link.md"))
    await expect(planLayoutMigration(root, ["TEST101"])).rejects.toThrow(/Symbolic links/)
  })
  it("restores originals after an interrupted copy and retains the private recovery journal", async () => {
    const root = await fixture()
    await document(root, "guidance/A.md", "type: guidance")
    await document(root, "guidance/B.md", "type: guidance")
    const plan = await planLayoutMigration(root, ["TEST101"])
    const second = plan.moves[1]
    if (!second) throw new Error("Fixture second move missing")
    failure.destination = join(root, second.destination)
    await expect(applyLayoutMigration(plan, ["TEST101"])).rejects.toThrow(/originals restored/)
    for (const move of plan.moves) {
      expect(digest(await readFile(join(root, move.source)))).toBe(move.hash)
      await expect(readFile(join(root, move.destination))).rejects.toThrow()
    }
    const journals = await readdir(join(root, "_meta/vault-migrations"))
    const journal = journals[0]
    if (!journal) throw new Error("Recovery journal missing")
    const recovery = JSON.parse(
      await readFile(join(root, "_meta/vault-migrations", journal, "interrupted.json"), "utf8"),
    )
    expect(recovery.recovery).toEqual([])
    await expect(readdir(join(root, "_meta/vault-migration.lock"))).rejects.toThrow()
  })
})
