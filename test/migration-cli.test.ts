import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"

const roots: string[] = []
function cli(args: string[]) {
  return spawnSync(process.execPath, [resolve("dist/cli.js"), ...args], { encoding: "utf8" })
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-migration-cli-"))
  roots.push(root)
  const vault = join(root, "vault"),
    config = join(root, "config.json"),
    index = join(root, "school.sqlite")
  expect(
    cli([
      "init",
      "--config",
      config,
      "--vault",
      vault,
      "--canvas-url",
      "https://canvas.example.test",
    ]).status,
  ).toBe(0)
  await mkdir(join(vault, "legacy-root/assignments"), { recursive: true })
  await writeFile(
    join(vault, "legacy-root/_index.md"),
    "---\ncanvas_id: '501'\n---\nSynthetic course identity.\n",
  )
  const prompt =
    "---\ntype: assignments\ncanvas_id: '701'\ndates:\n  due_at: '2027-01-15'\n---\nPRIVATE SYNTHETIC PROMPT BODY.\n"
  await writeFile(join(vault, "legacy-root/assignments/Case.md"), prompt)
  const db = new DatabaseSync(index)
  db.exec(
    "CREATE TABLE migrations(version INTEGER PRIMARY KEY); INSERT INTO migrations VALUES(5); CREATE TABLE courses(canvas_id TEXT PRIMARY KEY,name TEXT,course_code TEXT,vault_path TEXT);",
  )
  db.prepare("INSERT INTO courses VALUES(?,?,?,?)").run(
    "501",
    "Synthetic Accounting",
    "F26-ACCT-340-01",
    join(vault, "legacy-root"),
  )
  for (const table of ["modules", "assignments", "announcements", "files"])
    db.exec(
      `CREATE TABLE ${table}(canvas_id TEXT PRIMARY KEY,course_canvas_id TEXT,vault_path TEXT);`,
    )
  db.prepare("INSERT INTO assignments VALUES(?,?,?)").run(
    "701",
    "501",
    join(vault, "legacy-root/assignments/Case.md"),
  )
  db.close()
  return { root, vault, config, index, prompt }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe("compiled combined migration command", () => {
  it("previews and applies an explicit short wiki target through the combined root/index transaction", async () => {
    const { vault, config, index } = await fixture()
    await mkdir(join(vault, "legacy-root/files"))
    await writeFile(
      join(vault, "legacy-root/files/Reading.md"),
      "---\ntype: files\n---\nSynthetic reading.",
    )
    const source = join(vault, "legacy-root/assignments/Case.md")
    await writeFile(source, `${await readFile(source, "utf8")}\n[[Reading#ideas|Read]]\n`)
    const before = await readFile(source)
    const args = [
      "vault",
      "migrate",
      "--index-path",
      index,
      "--course",
      "501",
      "--config",
      config,
      "--json",
    ]
    expect(cli(args).status).toBe(1)
    const scoped = [...args, "--wiki-target", "Reading=legacy-root/files/Reading.md"]
    const preview = cli(scoped)
    expect(preview.status, preview.stderr).toBe(0)
    expect(JSON.parse(preview.stdout).wikiTargets).toEqual([
      { name: "Reading", target: "legacy-root/files/Reading.md" },
    ])
    expect(await readFile(source)).toEqual(before)
    const applied = cli([...scoped, "--apply"])
    expect(applied.status, applied.stderr).toBe(0)
    const prompt = await readFile(
      join(vault, "ACCT340/Assignments/2027-01-15 - Case/00 Prompt.md"),
      "utf8",
    )
    expect(prompt).toContain("[[ACCT340/Resources/Files/Reading#ideas|Read]]")
    expect(cli([...args, "--wiki-target", "not-a-binding"]).status).toBe(1)
  })
  it("exposes School marker compatibility metadata without advancing the marker or printing unrelated fields", async () => {
    const { vault, config, index } = await fixture()
    await mkdir(join(vault, "_meta"))
    const marker = join(vault, "_meta/layout.json")
    const bytes =
      '{"layout_version":2,"course_root_version":1,"private_extra":"PRIVATE MARKER EXTRA"}\n'
    await writeFile(marker, bytes)
    const args = [
      "vault",
      "migrate",
      "--index-path",
      index,
      "--course",
      "501",
      "--config",
      config,
      "--json",
    ]
    for (const flags of [[], ["--apply"]]) {
      const result = cli([...args, ...flags])
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout).schoolLayout).toMatchObject({
        status: "legacy",
        schoolWrites: "blocked-by-marker",
      })
      expect(result.stdout).not.toContain("PRIVATE MARKER EXTRA")
      expect(await readFile(marker, "utf8")).toBe(bytes)
    }
  })
  it("opts into incoming read scope and blocks apply without changing either course or the index", async () => {
    const { vault, config, index, prompt } = await fixture()
    const folder = join(vault, "OTHER101")
    await mkdir(folder)
    await writeFile(
      join(folder, "_index.md"),
      "---\ncanvas_id: '502'\n---\nUnselected course identity.",
    )
    const path = join(folder, "reading.md")
    const body =
      "PRIVATE UNSELECTED BODY\n[Linked assignment](../legacy-root/assignments/Case.md)\n"
    await writeFile(path, body)
    const db = new DatabaseSync(index)
    db.prepare("INSERT INTO courses VALUES(?,?,?,?)").run(
      "502",
      "Other synthetic course",
      "OTHER101",
      folder,
    )
    db.close()
    const before = createHash("sha256")
      .update(await readFile(index))
      .digest("hex")
    const args = [
      "vault",
      "migrate",
      "--index-path",
      index,
      "--course",
      "501",
      "--config",
      config,
      "--json",
    ]
    const selectedOnly = cli(args)
    expect(selectedOnly.status, selectedOnly.stderr).toBe(0)
    expect(JSON.parse(selectedOnly.stdout).incoming).toMatchObject({
      requested: false,
      scanCompleted: false,
    })
    for (const action of [[], ["--apply"]]) {
      const result = cli([...args, "--check-incoming", ...action])
      expect(result.status, result.stderr).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({
        preview: true,
        ready: false,
        incoming: { requested: true, scanCompleted: true },
      })
      expect(result.stdout).toContain("unselected course 502")
      expect(result.stdout).not.toContain("PRIVATE UNSELECTED BODY")
      expect(result.stdout).not.toContain("PRIVATE SYNTHETIC PROMPT BODY")
    }
    expect(await readFile(path, "utf8")).toBe(body)
    expect(await readFile(join(vault, "legacy-root/assignments/Case.md"), "utf8")).toBe(prompt)
    expect(
      createHash("sha256")
        .update(await readFile(index))
        .digest("hex"),
    ).toBe(before)
    await expect(readdir(join(vault, "_meta/vault-migrations"))).rejects.toThrow()
  })
  it("applies an opted-in conflict-free migration while preserving unselected text and index rows", async () => {
    const { vault, config, index } = await fixture()
    const folder = join(vault, "OTHER101")
    await mkdir(folder)
    const path = join(folder, "reading.md")
    await writeFile(path, "Unselected synthetic text, no incoming links.")
    const db = new DatabaseSync(index)
    db.prepare("INSERT INTO courses VALUES(?,?,?,?)").run(
      "502",
      "Other synthetic course",
      "OTHER101",
      folder,
    )
    db.close()
    const args = [
      "vault",
      "migrate",
      "--index-path",
      index,
      "--course",
      "501",
      "--config",
      config,
      "--json",
      "--check-incoming",
    ]
    const preview = cli(args)
    expect(preview.status, preview.stderr).toBe(0)
    expect(JSON.parse(preview.stdout)).toMatchObject({
      ready: true,
      incoming: { requested: true, scanCompleted: true, documents: 1 },
    })
    const applied = cli([...args, "--apply"])
    expect(applied.status, applied.stderr).toBe(0)
    expect(JSON.parse(applied.stdout)).toMatchObject({
      preview: false,
      incoming: { requested: true, scanCompleted: true },
    })
    expect(await readFile(path, "utf8")).toBe("Unselected synthetic text, no incoming links.")
    const checked = new DatabaseSync(index, { readOnly: true })
    expect(
      checked.prepare("SELECT vault_path FROM courses WHERE canvas_id = '502'").get()?.vault_path,
    ).toBe(folder)
    checked.close()
  })
  it("previews without writes, migrates on explicit apply and routes context to the rebased prompt", async () => {
    const { vault, config, index, prompt } = await fixture()
    const args = [
      "vault",
      "migrate",
      "--index-path",
      index,
      "--course",
      "501",
      "--config",
      config,
      "--json",
    ]
    const before = createHash("sha256")
      .update(await readFile(index))
      .digest("hex")
    const preview = cli(args)
    expect(preview.status, preview.stderr).toBe(0)
    expect(JSON.parse(preview.stdout)).toMatchObject({
      preview: true,
      ready: true,
      courses: ["501"],
    })
    expect(preview.stdout).not.toContain("PRIVATE SYNTHETIC PROMPT BODY")
    expect(
      createHash("sha256")
        .update(await readFile(index))
        .digest("hex"),
    ).toBe(before)
    await expect(readdir(join(vault, "_meta/vault-migrations"))).rejects.toThrow()
    const applied = cli([...args, "--apply"])
    expect(applied.status, applied.stderr).toBe(0)
    expect(JSON.parse(applied.stdout)).toMatchObject({
      preview: false,
      courses: ["501"],
      moved: 1,
      documents: 1,
    })
    const path = join(vault, "ACCT340/Assignments/2027-01-15 - Case/00 Prompt.md")
    expect(await readFile(path, "utf8")).toBe(prompt)
    const db = new DatabaseSync(index, { readOnly: true })
    expect(
      db.prepare("SELECT vault_path FROM assignments WHERE canvas_id = '701'").get()?.vault_path,
    ).toBe(path)
    db.close()
    const context = cli(["context", "--config", config, "--json"])
    expect(context.status).toBe(0)
    expect(JSON.parse(context.stdout).courses[0]).toMatchObject({
      canvasId: "501",
      root: "ACCT340",
    })
    expect(
      JSON.parse(context.stdout).courses[0].sources.map((source: { path: string }) => source.path),
    ).toContain("ACCT340/Assignments/2027-01-15 - Case/00 Prompt.md")
    expect(context.stdout).not.toContain("PRIVATE SYNTHETIC PROMPT BODY")
  })
  it("refuses conflicting apply without changing source documents or indexed paths", async () => {
    const { vault, config, index, prompt } = await fixture()
    await mkdir(join(vault, "ACCT340"))
    const result = cli([
      "vault",
      "migrate",
      "--index-path",
      index,
      "--course",
      "501",
      "--apply",
      "--config",
      config,
      "--json",
    ])
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ preview: true, ready: false })
    expect(await readFile(join(vault, "legacy-root/assignments/Case.md"), "utf8")).toBe(prompt)
    await expect(readdir(join(vault, "_meta/vault-migrations"))).rejects.toThrow()
  })
  it("requires explicit course selection and absolute index location", async () => {
    const { config, index } = await fixture()
    expect(cli(["vault", "migrate", "--index-path", index, "--config", config]).status).toBe(1)
    const relative = cli([
      "vault",
      "migrate",
      "--index-path",
      "school.sqlite",
      "--course",
      "501",
      "--config",
      config,
      "--json",
    ])
    expect(relative.status).toBe(1)
    expect(relative.stderr).toContain("explicit and absolute")
  })
})
