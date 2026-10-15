import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { reconcileSchoolIndex } from "../src/index-reconciliation.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-reconcile-"))
  roots.push(root)
  const vault = join(root, "vault"),
    index = join(root, "school.sqlite"),
    course = join(vault, "SYNTH401")
  await mkdir(course, { recursive: true })
  const db = new DatabaseSync(index)
  db.exec(
    "CREATE TABLE migrations(version INTEGER); INSERT INTO migrations VALUES(5); CREATE TABLE courses(canvas_id TEXT, workflow_state TEXT, vault_path TEXT);",
  )
  for (const table of ["modules", "assignments", "announcements", "files"])
    db.exec(
      `CREATE TABLE ${table}(canvas_id TEXT, course_canvas_id TEXT, vault_path TEXT${table === "assignments" ? ", deleted INTEGER" : ""});`,
    )
  db.prepare("INSERT INTO courses VALUES(?, ?, ?)").run("17", "available", course)
  db.prepare("INSERT INTO courses VALUES(?, ?, ?)").run("18", "available", join(vault, "other"))
  db.prepare("INSERT INTO files VALUES(?, ?, ?)").run("501", "17", join(course, "old.md"))
  db.prepare("INSERT INTO files VALUES(?, ?, ?)").run("502", "18", join(vault, "secret.md"))
  db.close()
  await writeFile(
    join(course, "_index.md"),
    "---\ncanvas_id: '17'\ncanvas_url: https://canvas.example.invalid/courses/17\ntype: _index.md\n---\nSynthetic course\n",
  )
  const text =
    "---\ncanvas_id: '501'\ncanvas_url: https://canvas.example.invalid/files/501\ntype: files\nsource: sync\n---\nSynthetic reading\n"
  await writeFile(join(course, "new.md"), text)
  const options = {
    vault,
    index,
    courseIds: ["17"],
    canvasOrigin: "https://canvas.example.invalid",
  }
  return { root, vault, index, course, text, options }
}
describe("read-only School index diagnostics", () => {
  it("finds one relocated source, restricts rows and preserves database/document bytes", async () => {
    const f = await fixture(),
      before = await readFile(f.index)
    const result = await reconcileSchoolIndex(f.options)
    expect(result).toMatchObject({
      dryRun: true,
      changesMade: false,
      proposedRelinks: 1,
      canvasAvailabilityVerified: false,
    })
    expect(result.findings).toEqual([
      expect.objectContaining({
        canvasId: "501",
        status: "unique-relocation",
        candidates: [join(f.course, "new.md")],
      }),
    ])
    expect(await readFile(f.index)).toEqual(before)
    expect(await readFile(join(f.course, "new.md"), "utf8")).toBe(f.text)
  })
  it("does not choose duplicate identities or user-owned copies", async () => {
    const f = await fixture()
    await writeFile(join(f.course, "duplicate.md"), f.text)
    await writeFile(join(f.course, "student.md"), f.text.replace("source: sync", "source: user"))
    const result = await reconcileSchoolIndex(f.options)
    expect(result.proposedRelinks).toBe(0)
    expect(result.findings[0]).toMatchObject({
      status: "ambiguous-relocation",
      candidates: [join(f.course, "duplicate.md"), join(f.course, "new.md")],
    })
  })
  it("reports concluded/deleted and absent roots without claiming Canvas deletion", async () => {
    const f = await fixture(),
      db = new DatabaseSync(f.index)
    db.exec("UPDATE courses SET workflow_state='concluded' WHERE canvas_id='17'")
    db.close()
    expect((await reconcileSchoolIndex(f.options)).findings[0]?.status).toBe("concluded-or-deleted")
    const other = await reconcileSchoolIndex({ ...f.options, courseIds: ["18"] })
    expect(other.findings.every((item) => item.status === "course-root-absent")).toBe(true)
  })
  it("never opens an outside-vault indexed path and detects a different local identity", async () => {
    const f = await fixture(),
      db = new DatabaseSync(f.index)
    db.prepare("UPDATE files SET vault_path=? WHERE canvas_id='501'").run(
      join(f.root, "missing-private.md"),
    )
    db.close()
    expect((await reconcileSchoolIndex(f.options)).findings[0]?.indexedPathScope).toBe(
      "outside-vault",
    )
    await writeFile(join(f.course, "old.md"), f.text.replaceAll("501", "999"))
    const second = new DatabaseSync(f.index)
    second
      .prepare("UPDATE files SET vault_path=? WHERE canvas_id='501'")
      .run(join(f.course, "old.md"))
    second.close()
    expect((await reconcileSchoolIndex(f.options)).findings[0]?.status).toBe("identity-mismatch")
  })
  it("rejects implicit scope, linked indexes/journals and unsupported schemas", async () => {
    const f = await fixture()
    await expect(reconcileSchoolIndex({ ...f.options, courseIds: [] })).rejects.toThrow(/explicit/)
    await expect(reconcileSchoolIndex({ ...f.options, courseIds: ["999"] })).rejects.toThrow(
      /absent/,
    )
    await expect(reconcileSchoolIndex({ ...f.options, index: "school.sqlite" })).rejects.toThrow(
      /absolute/,
    )
    const link = join(f.root, "linked.sqlite")
    await symlink(f.index, link)
    await expect(reconcileSchoolIndex({ ...f.options, index: link })).rejects.toThrow(/links/)
    const db = new DatabaseSync(f.index)
    db.exec("UPDATE migrations SET version=999")
    db.close()
    await expect(reconcileSchoolIndex(f.options)).rejects.toThrow(/schema/)
    await symlink(f.index, `${f.index}-wal`)
    await expect(reconcileSchoolIndex(f.options)).rejects.toThrow(/links/)
  })
  it("rejects linked manifests and ignores other-origin documents", async () => {
    const f = await fixture()
    await writeFile(
      join(f.course, "new.md"),
      f.text.replace("canvas.example.invalid", "other.example.invalid"),
    )
    expect((await reconcileSchoolIndex(f.options)).findings[0]?.status).toBe("missing-local")
    await rm(join(f.course, "_index.md"))
    await symlink(join(f.course, "new.md"), join(f.course, "_index.md"))
    await expect(reconcileSchoolIndex(f.options)).rejects.toThrow(/links/)
  })
  it("runs the compiled CLI across workspaces with explicit configuration and scope", async () => {
    const f = await fixture(),
      config = join(f.root, "canvas.config.json")
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        canvas: { baseUrl: f.options.canvasOrigin, tokenEnv: "SYNTHETIC_TOKEN" },
        vault: { path: f.vault },
        courses: { allowlist: [] },
      }),
    )
    const before = await readFile(f.index)
    const output = execFileSync(
      process.execPath,
      [
        join(process.cwd(), "dist/cli.js"),
        "vault",
        "reconcile-index",
        "--school-index",
        f.index,
        "--course",
        "17",
        "--json",
        "--config",
        config,
      ],
      { cwd: f.root, encoding: "utf8", env: { PATH: process.env.PATH } },
    )
    expect(JSON.parse(output)).toMatchObject({
      courseIds: ["17"],
      proposedRelinks: 1,
      changesMade: false,
    })
    expect(await readFile(f.index)).toEqual(before)
  })
  it("ignores mismatched URL identities and malformed YAML without echoing its content", async () => {
    const f = await fixture()
    await writeFile(join(f.course, "new.md"), f.text.replace("/files/501", "/files/777"))
    await writeFile(
      join(f.course, "malformed.md"),
      "---\nprivate_fixture: [SYNTHETIC_PRIVATE_MARKER\n---\n",
    )
    const result = await reconcileSchoolIndex(f.options)
    expect(result.findings[0]?.status).toBe("missing-local")
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_MARKER")
    expect(result.notices).toContain("Skipped malformed document metadata; no content echoed")
  })
  it("skips null paths and matching identities, but reports deleted missing assignments", async () => {
    const f = await fixture(),
      db = new DatabaseSync(f.index)
    db.prepare("UPDATE files SET vault_path=? WHERE canvas_id='501'").run(join(f.course, "new.md"))
    db.prepare("INSERT INTO modules VALUES(?, ?, ?)").run("201", "17", null)
    db.prepare("INSERT INTO assignments VALUES(?, ?, ?, ?)").run(
      "9",
      "17",
      join(f.course, "deleted.md"),
      1,
    )
    db.close()
    expect((await reconcileSchoolIndex(f.options)).findings).toEqual([
      expect.objectContaining({
        table: "assignments",
        canvasId: "9",
        status: "concluded-or-deleted",
      }),
    ])
  })
  it("refuses oversized source metadata rather than treating an incomplete catalog as complete", async () => {
    const f = await fixture()
    await writeFile(join(f.course, "new.md"), "x".repeat(5_000_001))
    await expect(reconcileSchoolIndex(f.options)).rejects.toThrow(/oversized/)
    expect(await readFile(join(f.course, "new.md"), "utf8")).toHaveLength(5_000_001)
  })
})
