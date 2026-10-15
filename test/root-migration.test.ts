import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"

const fail = vi.hoisted(() => ({ destination: "" }))
vi.mock("node:fs/promises", async () => {
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[1]) === fail.destination) throw new Error("Injected directory rename failure")
      return fs.rename(...args)
    },
  }
})

import { createHash } from "node:crypto"
import { applyRootMigration, planRootMigration } from "../src/root-migration.js"
import { inspectWorkspace } from "../src/workspace.js"

const roots: string[] = []
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "canvas-root-index-"))
  roots.push(base)
  const root = join(base, "🎓 vault"),
    index = join(base, "school.sqlite")
  await mkdir(root)
  const db = new DatabaseSync(index)
  db.exec(
    "CREATE TABLE migrations(version INTEGER PRIMARY KEY); INSERT INTO migrations VALUES(5); CREATE TABLE courses(canvas_id TEXT PRIMARY KEY, name TEXT, course_code TEXT, vault_path TEXT);",
  )
  for (const table of ["modules", "assignments", "announcements", "files"])
    db.exec(
      `CREATE TABLE ${table}(canvas_id TEXT PRIMARY KEY, course_canvas_id TEXT, vault_path TEXT, preserved TEXT);`,
    )
  db.close()
  return { root, index }
}
async function course(root: string, index: string, id: string, source: string, code: string) {
  const folder = join(root, source)
  await mkdir(folder)
  await writeFile(join(folder, "_index.md"), `---\ncanvas_id: '${id}'\n---\n# Synthetic course\n`)
  await writeFile(join(folder, "student.md"), "Preserved student-owned synthetic notes.\n")
  const db = new DatabaseSync(index)
  db.prepare("INSERT INTO courses VALUES(?, ?, ?, ?)").run(id, "Synthetic course", code, folder)
  for (const table of ["modules", "assignments", "announcements", "files"])
    db.prepare(`INSERT INTO ${table} VALUES(?, ?, ?, ?)`).run(
      id,
      id,
      join(folder, `${table}.md`),
      "Unchanged payload",
    )
  db.close()
}
function paths(index: string) {
  const db = new DatabaseSync(index, { readOnly: true })
  try {
    return Object.fromEntries(
      ["courses", "modules", "assignments", "announcements", "files"].map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY canvas_id`).all(),
      ]),
    )
  } finally {
    db.close()
  }
}
afterEach(async () => {
  vi.restoreAllMocks()
  fail.destination = ""
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe("School root/index migration phase", () => {
  it("reports and preserves legacy School markers and detects marker changes before apply", async () => {
    const { root, index } = await fixture()
    await course(root, index, "1", "legacy-root", "F26-ACCT-340-01")
    await mkdir(join(root, "_meta"))
    const marker = join(root, "_meta/layout.json")
    const bytes = '{"layout_version":2,"course_root_version":1,"student_setting":"preserve"}\n'
    await writeFile(marker, bytes)
    const plan = await planRootMigration(root, index, ["1"])
    expect(plan.schoolLayout).toMatchObject({
      status: "legacy",
      supported: true,
      schoolWrites: "blocked-by-marker",
    })
    await writeFile(marker, '{"layout_version":2,"course_root_version":2}\n')
    await expect(applyRootMigration(plan)).rejects.toThrow(/stale/)
    await writeFile(marker, bytes)
    await applyRootMigration(await planRootMigration(root, index, ["1"]))
    expect(await readFile(marker, "utf8")).toBe(bytes)
    const current = await planRootMigration(root, index, ["1"])
    expect(current.schoolLayout.schoolWrites).toBe("blocked-by-marker")
  })
  it.each(['{"layout_version":999}', '{"layout_version":2,"course_root_version":3}', "not JSON"])(
    "refuses unsafe/unsupported marker %s without overwriting it",
    async (bytes) => {
      const { root, index } = await fixture()
      await course(root, index, "1", "legacy-root", "F26-ACCT-340-01")
      await mkdir(join(root, "_meta"))
      const marker = join(root, "_meta/layout.json")
      await writeFile(marker, bytes)
      const plan = await planRootMigration(root, index, ["1"])
      expect(plan.ready).toBe(false)
      expect(plan.schoolLayout.supported).toBe(false)
      await expect(applyRootMigration(plan)).rejects.toThrow(/conflicts/)
      expect(await readFile(marker, "utf8")).toBe(bytes)
    },
  )
  it("does not claim shared-writer compatibility for current markers", async () => {
    const { root, index } = await fixture()
    await course(root, index, "1", "legacy-root", "F26-ACCT-340-01")
    await mkdir(join(root, "_meta"))
    await writeFile(join(root, "_meta/layout.json"), '{"layout_version":2,"course_root_version":2}')
    const plan = await planRootMigration(root, index, ["1"])
    expect(plan.schoolLayout).toMatchObject({
      status: "current",
      supported: true,
      schoolWrites: "unverified",
    })
    expect(plan.schoolLayout.note).toContain("remains unverified")
  })
  it("blocks opted-in migration for incoming links without modifying unselected documents or the index", async () => {
    const { root, index } = await fixture()
    await course(root, index, "1", "legacy-root", "F26-ACCT-340-01")
    await course(root, index, "2", "OTHER101", "OTHER101")
    const path = join(root, "OTHER101/incoming.md"),
      html = join(root, "OTHER101/incoming.html")
    await writeFile(path, "[Reading](../legacy-root/student.md)\n[[legacy-root/student|Notes]]\n")
    await writeFile(html, '<a href="../legacy-root/student.md">Reading</a>')
    const metadata = join(root, "OTHER101/metadata.md")
    const metadataBody =
      "---\nrelated_paths: [legacy-root/student.md]\n---\nUnselected structured-reference body."
    await writeFile(metadata, metadataBody)
    const original = await readFile(path),
      htmlOriginal = await readFile(html),
      before = paths(index)
    expect((await planRootMigration(root, index, ["1"])).ready).toBe(true)
    const checked = await planRootMigration(root, index, ["1"], { checkIncoming: true })
    expect(checked.ready).toBe(false)
    expect(checked.incomingDocuments).toBeGreaterThan(0)
    expect(checked.conflicts.join("\n")).toContain("unselected course 2")
    expect(checked.conflicts.join("\n")).toContain("incoming.html")
    expect(checked.conflicts.join("\n")).toContain("metadata.md")
    await expect(applyRootMigration(checked)).rejects.toThrow(/conflicts/)
    expect(await readFile(path)).toEqual(original)
    expect(await readFile(html)).toEqual(htmlOriginal)
    expect(await readFile(metadata, "utf8")).toBe(metadataBody)
    expect(paths(index)).toEqual(before)
  })
  it("fingerprints opted-in incoming scope, ignores literal history and refuses stale or unsafe scans", async () => {
    const { root, index } = await fixture()
    await course(root, index, "1", "legacy-root", "F26-ACCT-340-01")
    await course(root, index, "2", "OTHER101", "OTHER101")
    const path = join(root, "OTHER101/history.md")
    await writeFile(
      path,
      "<!-- [Historical](../legacy-root/student.md) -->\n`[[legacy-root/student]]`\n```md\n[Example](../legacy-root/student.md)\n```\n",
    )
    const plan = await planRootMigration(root, index, ["1"], { checkIncoming: true })
    expect(plan.ready).toBe(true)
    expect(plan.incomingDigest).toMatch(/^[a-f0-9]{64}$/)
    await writeFile(path, "[New live link](../legacy-root/student.md)")
    await expect(applyRootMigration(plan)).rejects.toThrow(/stale/)
    await writeFile(path, "Unrelated text.")
    const outside = join(root, "..", "outside.md")
    await writeFile(outside, "Outside private text.")
    await symlink(outside, join(root, "OTHER101/unsafe.md"))
    const unsafe = await planRootMigration(root, index, ["1"], { checkIncoming: true })
    expect(unsafe.ready).toBe(false)
    expect(unsafe.conflicts.join("\n")).toContain("could not verify")
    expect(unsafe.conflicts.join("\n")).not.toContain("Outside private text")
  })
  it.each(["legacy-root", "ACCT340"])(
    "combines layout and indexed-root migration for %s",
    async (source) => {
      const { root, index } = await fixture()
      await course(root, index, "1", source, "F26-ACCT-340-01")
      for (const folder of ["modules", "files", "assignments"])
        await mkdir(join(root, source, folder))
      const binary = Buffer.from([1, 2, 255]),
        hash = createHash("sha256").update(binary).digest("hex")
      await writeFile(join(root, source, "files/reading.bin"), binary)
      await writeFile(
        join(root, source, "files/reading.bin.md"),
        `---\ntype: files\nmodule_canvas_id: '1'\noriginal_path: '${source}/files/reading.bin'\noriginal_hash: ${hash}\n---\nSynthetic reading evidence.\n`,
      )
      await writeFile(
        join(root, source, "modules/Lesson.md"),
        "---\ntype: modules\ncanvas_id: '1'\ndates:\n  session_at: '2026-10-13'\n---\nCompare the assigned reading.\n[Reading](../files/reading.bin.md)\n",
      )
      await writeFile(
        join(root, source, "assignments/Case.md"),
        "---\ntype: assignments\ncanvas_id: '1'\ndates:\n  due_at: '2026-10-14'\n---\nSynthetic assignment prompt.\n",
      )
      const db = new DatabaseSync(index)
      for (const [table, path] of [
        ["modules", "modules/Lesson.md"],
        ["files", "files/reading.bin"],
        ["assignments", "assignments/Case.md"],
      ])
        db.prepare(`UPDATE ${table} SET vault_path = ? WHERE canvas_id = '1'`).run(
          join(root, source, path ?? ""),
        )
      db.close()
      const plan = await planRootMigration(root, index, ["1"], { layout: true })
      expect(plan.conflicts).toEqual([])
      const result = await applyRootMigration(plan)
      const values = paths(index)
      expect(values.modules?.[0]?.vault_path).toBe(
        join(root, "ACCT340/Week 01 - Oct 12/Other/Lesson.md"),
      )
      expect(values.files?.[0]?.vault_path).toBe(
        join(root, "ACCT340/Week 01 - Oct 12/Materials/reading.bin"),
      )
      expect(values.assignments?.[0]?.vault_path).toBe(
        join(root, "ACCT340/Assignments/2026-10-14 - Case/00 Prompt.md"),
      )
      expect(await readFile(join(root, "ACCT340/Week 01 - Oct 12/Materials/reading.bin"))).toEqual(
        binary,
      )
      const context = await inspectWorkspace(root)
      expect(
        context.courses
          .find((item) => item.canvasId === "1")
          ?.sources.find((item) => item.path.endsWith("reading.bin.md")),
      ).toMatchObject({
        originalPath: "ACCT340/Week 01 - Oct 12/Materials/reading.bin",
        originalHash: hash,
      })
      expect(
        await readFile(join(root, "ACCT340/Week 01 - Oct 12/Other/Lesson.md"), "utf8"),
      ).toContain("[Reading](../Materials/reading.bin.md)")
      expect(
        await readFile(
          join(result.archive, "reference-originals", source, "assignments/Case.md"),
          "utf8",
        ),
      ).toContain("Synthetic assignment prompt")
    },
  )
  it("restores original layout, root, mappings and index after a combined commit failure", async () => {
    const { root, index } = await fixture()
    await course(root, index, "1", "legacy-root", "F26-ACCT-340-01")
    await mkdir(join(root, "legacy-root/assignments"))
    const original = "---\ntype: assignments\ncanvas_id: '1'\n---\nSynthetic original prompt.\n"
    await writeFile(join(root, "legacy-root/assignments/Case.md"), original)
    const before = paths(index),
      plan = await planRootMigration(root, index, ["1"], { layout: true })
    const exec = DatabaseSync.prototype.exec
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === "COMMIT") throw new Error("Injected combined commit failure")
      return exec.call(this, sql)
    })
    await expect(applyRootMigration(plan)).rejects.toThrow(/Injected combined commit failure/)
    expect(paths(index)).toEqual(before)
    expect(await readFile(join(root, "legacy-root/assignments/Case.md"), "utf8")).toBe(original)
    expect(await readdir(join(root, "legacy-root"))).toContain("assignments")
    await expect(
      readFile(join(root, "legacy-root/Assignments/Undated - Case/00 Prompt.md")),
    ).rejects.toThrow()
    await expect(readdir(join(root, "ACCT340"))).rejects.toThrow()
    await expect(readFile(join(root, "_meta/canvas-courses.json"))).rejects.toThrow()
  })
  it("rejects stale Canvas mapping previews and destinations already claimed by another mapped course", async () => {
    const { root, index } = await fixture()
    await course(root, index, "1", "old-one", "F26-ACCT-340-01")
    await mkdir(join(root, "_meta"))
    const path = join(root, "_meta/canvas-courses.json")
    await writeFile(
      path,
      JSON.stringify({ version: 1, courses: [{ id: "1", root: "old-one", name: "Accounting" }] }),
    )
    const plan = await planRootMigration(root, index, ["1"])
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        courses: [{ id: "1", root: "old-one", name: "Renamed locally" }],
      }),
    )
    await expect(applyRootMigration(plan)).rejects.toThrow(/stale/)
    await writeFile(
      path,
      JSON.stringify({ version: 1, courses: [{ id: "2", root: "ACCT340", name: "Other course" }] }),
    )
    expect((await planRootMigration(root, index, ["1"])).conflicts.join("\n")).toMatch(
      /destination belongs to another course/,
    )
    await expect(readdir(join(root, "ACCT340"))).rejects.toThrow()
  })
  it("integrates original-file bindings and Canvas mapping with indexed root changes", async () => {
    const { root, index } = await fixture()
    await course(root, index, "1", "old-one", "F26-ACCT-340-01")
    await course(root, index, "2", "untouched", "F26-OB-581-01")
    await mkdir(join(root, "old-one/Resources"))
    const binary = Buffer.from([1, 2, 255]),
      hash = createHash("sha256").update(binary).digest("hex")
    await writeFile(join(root, "old-one/Resources/reading.pdf"), binary)
    await writeFile(
      join(root, "old-one/Resources/reading.pdf.md"),
      `---\noriginal_path: old-one/Resources/reading.pdf\noriginal_hash: ${hash}\n---\nSynthetic extracted evidence.\n`,
    )
    await mkdir(join(root, "_meta"))
    const oldMapping = {
      version: 1,
      courses: [
        { id: "1", root: "old-one", name: "Accounting" },
        { id: "2", root: "untouched", name: "Negotiations" },
      ],
    }
    await writeFile(join(root, "_meta/canvas-courses.json"), JSON.stringify(oldMapping))
    const plan = await planRootMigration(root, index, ["1"])
    expect(plan.conflicts).toEqual([])
    expect(plan.files.some((file) => file.destinationHash)).toBe(true)
    const result = await applyRootMigration(plan)
    const context = await inspectWorkspace(root)
    expect(context.courses.find((item) => item.canvasId === "1")?.root).toBe("ACCT340")
    expect(
      context.courses
        .find((item) => item.canvasId === "1")
        ?.sources.find((source) => source.path.endsWith("reading.pdf.md")),
    ).toMatchObject({ originalPath: "ACCT340/Resources/reading.pdf", originalHash: hash })
    expect(context.courses.find((item) => item.canvasId === "2")?.root).toBe("untouched")
    expect(
      JSON.parse(await readFile(join(result.archive, "canvas-courses.original.json"), "utf8")),
    ).toEqual(oldMapping)
    expect(
      await readFile(
        join(result.archive, "reference-originals/old-one/Resources/reading.pdf.md"),
        "utf8",
      ),
    ).toContain("original_path: old-one/")
  })
  it("rolls back reference rewrites, mappings, roots and indexed paths if SQLite commit fails", async () => {
    const { root, index } = await fixture()
    await course(root, index, "1", "old-one", "F26-ACCT-340-01")
    const binary = Buffer.from([1, 2, 255]),
      hash = createHash("sha256").update(binary).digest("hex")
    await writeFile(join(root, "old-one/reading.bin"), binary)
    const sidecar = `---\noriginal_path: old-one/reading.bin\noriginal_hash: ${hash}\n---\nSynthetic extracted evidence.\n`
    await writeFile(join(root, "old-one/reading.bin.md"), sidecar)
    const before = paths(index),
      plan = await planRootMigration(root, index, ["1"])
    const exec = DatabaseSync.prototype.exec
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === "COMMIT") throw new Error("Injected commit failure")
      return exec.call(this, sql)
    })
    await expect(applyRootMigration(plan)).rejects.toThrow(/Injected commit failure/)
    expect(paths(index)).toEqual(before)
    expect(await readFile(join(root, "old-one/reading.bin.md"), "utf8")).toBe(sidecar)
    await expect(readFile(join(root, "_meta/canvas-courses.json"))).rejects.toThrow()
    await expect(readdir(join(root, "ACCT340"))).rejects.toThrow()
  })
  it("previews read-only and atomically rebases all five path tables without touching unselected roots or payloads", async () => {
    const { root, index } = await fixture()
    await course(root, index, "1", "old-acct", "F26-ACCT-340-01")
    await course(root, index, "2", "untouched", "F26-OB-581-01")
    const before = paths(index),
      plan = await planRootMigration(root, index, ["1"])
    expect(plan.ready).toBe(true)
    expect(plan.moves).toHaveLength(1)
    expect(plan.moves[0]?.destination).toBe(join(root, "ACCT340"))
    expect(paths(index)).toEqual(before)
    await expect(readdir(join(root, "_meta"))).rejects.toThrow()
    const result = await applyRootMigration(plan)
    expect(result.moved).toBe(1)
    expect(await readFile(join(root, "ACCT340/student.md"), "utf8")).toBe(
      "Preserved student-owned synthetic notes.\n",
    )
    const after = paths(index)
    for (const table of Object.keys(after)) {
      expect(after[table]?.[0]?.vault_path).toBe(
        table === "courses" ? join(root, "ACCT340") : join(root, "ACCT340", `${table}.md`),
      )
      expect(after[table]?.[1]).toEqual(before[table]?.[1])
      if (table !== "courses") expect(after[table]?.[0]?.preserved).toBe("Unchanged payload")
    }
    expect(paths(join(result.archive, "school-index.sqlite"))).toEqual(before)
    await expect(readFile(join(root, "_meta/layout.json"))).rejects.toThrow()
    expect((await planRootMigration(root, index, ["1"])).moves).toEqual([])
  })
  it("rejects identity mismatches, destination collisions and index paths owned by a different course", async () => {
    const { root, index } = await fixture()
    await course(root, index, "1", "old-one", "F26-ACCT-340-01")
    await course(root, index, "2", "old-two", "F26-ACCT-340-02")
    expect((await planRootMigration(root, index, ["1", "2"])).conflicts).toContain(
      "Multiple courses target ACCT340",
    )
    await writeFile(join(root, "old-one/_index.md"), "---\ncanvas_id: '999'\n---\n")
    expect((await planRootMigration(root, index, ["1"])).ready).toBe(false)
    await writeFile(join(root, "old-one/_index.md"), "---\ncanvas_id: '1'\n---\n")
    const db = new DatabaseSync(index)
    db.prepare("UPDATE files SET course_canvas_id = '2' WHERE canvas_id = '1'").run()
    db.close()
    expect((await planRootMigration(root, index, ["1"])).conflicts.join("\n")).toMatch(
      /owned by another course/,
    )
  })
  it("rejects stale plans, forged destinations, unsafe index paths and symlinks", async () => {
    const { root, index } = await fixture()
    await course(root, index, "1", "old-one", "F26-ACCT-340-01")
    const plan = await planRootMigration(root, index, ["1"]),
      move = plan.moves[0]
    if (!move) throw new Error("Fixture move missing")
    await expect(
      applyRootMigration({ ...plan, moves: [{ ...move, destination: join(root, "WRONG") }] }),
    ).rejects.toThrow(/stale/)
    const db = new DatabaseSync(index)
    db.prepare("UPDATE courses SET name = 'Changed' WHERE canvas_id = '1'").run()
    db.close()
    await expect(applyRootMigration(plan)).rejects.toThrow(/stale/)
    await expect(planRootMigration(root, join(root, "inside.sqlite"), ["1"])).rejects.toThrow(
      /outside the vault/,
    )
    const linked = join(root, "..", "link.sqlite")
    await symlink(index, linked)
    await expect(planRootMigration(root, linked, ["1"])).rejects.toThrow(/Symbolic links/)
  })
  it("rejects nested symlinks, changed file inventories and active migration locks", async () => {
    const { root, index } = await fixture()
    await course(root, index, "1", "old-one", "F26-ACCT-340-01")
    const plan = await planRootMigration(root, index, ["1"])
    await writeFile(join(root, "old-one/new-note.md"), "Added after preview.")
    await expect(applyRootMigration(plan)).rejects.toThrow(/stale/)
    const fresh = await planRootMigration(root, index, ["1"])
    await mkdir(join(root, "_meta/vault-migration.lock"), { recursive: true })
    await expect(applyRootMigration(fresh)).rejects.toThrow(/locked/)
    expect(await readdir(join(root, "_meta/vault-migration.lock"))).toEqual([])
    await symlink(join(root, "old-one/student.md"), join(root, "old-one/link.md"))
    await expect(planRootMigration(root, index, ["1"])).rejects.toThrow(/symbolic link/)
  })
  it("rolls back renamed directories and the SQLite transaction after an ordinary interruption", async () => {
    const { root, index } = await fixture()
    await course(root, index, "1", "old-one", "F26-ACCT-340-01")
    await course(root, index, "2", "old-two", "F26-OB-581-01")
    const before = paths(index),
      plan = await planRootMigration(root, index, ["1", "2"])
    fail.destination = join(root, "OB581")
    await expect(applyRootMigration(plan)).rejects.toThrow(/interrupted/)
    expect(paths(index)).toEqual(before)
    expect(await readFile(join(root, "old-one/student.md"), "utf8")).toContain("Preserved")
    expect(await readFile(join(root, "old-two/student.md"), "utf8")).toContain("Preserved")
    await expect(readdir(join(root, "ACCT340"))).rejects.toThrow()
    await expect(readdir(join(root, "_meta/vault-migration.lock"))).rejects.toThrow()
  })
  it("rejects unknown index versions and SQL triggers before making migration writes", async () => {
    const { root, index } = await fixture()
    await course(root, index, "1", "old-one", "F26-ACCT-340-01")
    const db = new DatabaseSync(index)
    db.exec("INSERT INTO migrations VALUES(6)")
    await expect(planRootMigration(root, index, ["1"])).rejects.toThrow(/schema version/)
    db.exec(
      "DELETE FROM migrations WHERE version = 6; CREATE TRIGGER dangerous AFTER UPDATE ON courses BEGIN DELETE FROM files; END;",
    )
    db.close()
    await expect(planRootMigration(root, index, ["1"])).rejects.toThrow(/unsupported triggers/)
    await expect(readdir(join(root, "_meta"))).rejects.toThrow()
  })
})
