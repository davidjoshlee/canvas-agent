import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createReadingCopy,
  disableReadingMirror,
  planReadingCopy,
  refreshConfiguredReadingMirror,
  refreshReadingMirror,
} from "../../src/vault/reading-copy.js"

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-reading-copy-test-"))
  roots.push(root)
  const vault = join(root, "vault"),
    destination = join(root, "phone")
  await mkdir(join(vault, "MBA101"), { recursive: true })
  return { root, vault, destination }
}
async function put(root: string, path: string, content: string | Buffer) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), content)
}
async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory())
      for (const [name, content] of Object.entries(await tree(join(root, entry.name))))
        result[`${entry.name}/${name}`] = content
    else if (entry.isFile())
      result[entry.name] = (await readFile(join(root, entry.name))).toString("utf8")
  }
  return result
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("private one-way reading copies", () => {
  it("leaves legacy ownership unchanged when import encounters an unowned file or active School Agent lock", async () => {
    const { vault, destination } = await fixture()
    await put(vault, "MBA101/notes.md", "local")
    const state = JSON.stringify({ destination, updatedAt: "2026-10-01T00:00:00Z", files: {} })
    await put(vault, "_meta/reading-mirror.json", state)
    await put(destination, "Current/00 READ ME.txt", "student-owned")
    await expect(
      refreshReadingMirror(vault, destination, { importSchoolState: true }),
    ).rejects.toThrow(/unowned/)
    expect(await readFile(join(vault, "_meta/reading-mirror.json"), "utf8")).toBe(state)
    await expect(readFile(join(vault, "_meta/reading-copy.json"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await unlink(join(destination, "Current/00 READ ME.txt"))
    await mkdir(join(vault, "_meta/reading-mirror.lock"))
    await expect(
      refreshReadingMirror(vault, destination, { importSchoolState: true }),
    ).rejects.toThrow(/School Agent reading mirror is locked/)
    expect(await readFile(join(vault, "_meta/reading-mirror.json"), "utf8")).toBe(state)
    await expect(readFile(join(vault, "_meta/reading-copy.json"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
  it("explicitly imports School Agent ownership, archives its mapping, and preserves edited legacy files", async () => {
    const { vault, destination } = await fixture()
    await put(vault, "MBA101/notes.md", "local current version")
    await put(destination, "Current/MBA101/notes.md.txt", "edited legacy phone copy")
    const path = "MBA101/notes.md.txt"
    const state = JSON.stringify({
      destination,
      updatedAt: "2026-10-01T00:00:00Z",
      files: { [path]: createHash("sha256").update("old local version").digest("hex") },
      mtimes: {},
    })
    await put(vault, "_meta/reading-mirror.json", state)
    await expect(refreshReadingMirror(vault, destination)).rejects.toThrow(/--import-school-state/)
    expect(await readFile(join(vault, "_meta/reading-mirror.json"), "utf8")).toBe(state)
    expect(
      await refreshReadingMirror(vault, destination, { importSchoolState: true }),
    ).toMatchObject({ updated: 2, recovered: 1 })
    await expect(readFile(join(vault, "_meta/reading-mirror.json"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    const archive = (await readdir(join(vault, "_meta"))).find((name) =>
      name.startsWith("reading-mirror.imported-"),
    )
    expect(archive).toBeDefined()
    expect(await readFile(join(vault, "_meta", archive ?? "missing"), "utf8")).toBe(state)
    expect(await readFile(join(destination, "Current", path), "utf8")).toBe("local current version")
    expect(Object.values(await tree(join(destination, "Recovered")))).toContain(
      "edited legacy phone copy",
    )
    expect(await refreshConfiguredReadingMirror(vault)).toMatchObject({ unchanged: 2 })
  })
  it("previews without writes and exports readable courses, drafts, and original formats while filtering private/policy files", async () => {
    const { vault, destination } = await fixture()
    await put(
      vault,
      "MBA101/Week 01 - Oct 5/notes.md",
      "---\nai_policy: allowed\n---\nUseful notes https://example.edu/file?verifier=secret&sig=hidden",
    )
    await put(vault, "MBA101/Drafts/draft.md", "Student draft")
    await put(vault, "MBA101/reading.pdf", Buffer.from("original PDF bytes"))
    for (const path of [
      "MBA101/.env",
      "MBA101/credentials.txt",
      "MBA101/_meta/TASK.md",
      "MBA101/.agent-runs/run.md",
      "MBA101/old/course.md",
      "MBA101/Guidance/prep.proposed.v1.md",
      "MBA101/AGENTS.md",
      "_meta/secret.md",
      "_meta/correctness-reviews/synthetic-review/HANDOFF.md",
      "_meta/correctness-reviews/synthetic-review/review.md",
      "_meta/correctness-reviews/synthetic-review/receipt.json",
      "README.md",
      "random/other.md",
    ])
      await put(vault, path, "DO NOT EXPORT")
    await put(vault, "MBA101/restricted.md", "---\nredistribution: restricted\n---\nDO NOT EXPORT")
    await put(vault, "MBA101/role.pdf", "DO NOT EXPORT")
    await put(vault, "MBA101/role.pdf.md", "---\nai_policy: prohibited\n---\nDO NOT EXPORT")
    await put(vault, "MBA101/malformed.md", "---\n[bad\n---\nDO NOT EXPORT")
    await put(
      vault,
      "MBA101/laundered.md.extracted.md",
      "---\noriginal_path: MBA101/restricted.md\noriginal_hash: invalid\n---\nDO NOT EXPORT",
    )
    const originals = await tree(vault)
    const plan = await planReadingCopy(vault, destination)
    expect(plan.files.map((file) => file.output)).toEqual([
      "MBA101/Drafts/draft.md.txt",
      "MBA101/reading.pdf",
      "MBA101/Week 01 - Oct 5/notes.md.txt",
    ])
    await expect(readdir(destination)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await tree(vault)).toEqual(originals)
    const first = await createReadingCopy(vault, destination),
      second = await createReadingCopy(vault, destination)
    expect(first.path).not.toBe(second.path)
    expect(await readFile(join(first.path, "MBA101/reading.pdf"), "utf8")).toBe(
      "original PDF bytes",
    )
    expect(await readFile(join(first.path, "MBA101/Week 01 - Oct 5/notes.md.txt"), "utf8")).toBe(
      "Useful notes https://example.edu/file?verifier=[redacted]&sig=[redacted]",
    )
    expect(Object.values(await tree(first.path)).join("\n")).not.toContain("DO NOT EXPORT")
    expect(await tree(vault)).toEqual(originals)
  })

  it("rejects destinations inside/above the vault, symlink roots and output collisions", async () => {
    const { root, vault, destination } = await fixture()
    for (const output of [vault, join(vault, "copy"), root])
      await expect(planReadingCopy(vault, output)).rejects.toThrow(/separate/)
    await symlink(vault, join(root, "alias"))
    await expect(planReadingCopy(join(root, "alias"), destination)).rejects.toThrow(/Symbolic/)
    await symlink(join(root, "outside"), destination)
    await expect(planReadingCopy(vault, destination)).rejects.toThrow(/Symbolic/)
    await unlink(destination)
    await put(vault, "MBA101/Note.md", "one")
    await put(vault, "MBA101/note.md.txt", "two")
    await expect(planReadingCopy(vault, destination)).rejects.toThrow(/collide/)
  })

  it("refreshes idempotently, recovers phone edits and removes deleted sources from Current without losing copies", async () => {
    const { vault, destination } = await fixture()
    await put(vault, "MBA101/notes.md", "version one")
    const original = await readFile(join(vault, "MBA101/notes.md"))
    const first = await refreshReadingMirror(vault, destination)
    expect(first.updated).toBe(2)
    expect(await refreshConfiguredReadingMirror(vault)).toMatchObject({ updated: 0, unchanged: 2 })
    const target = join(first.path, "MBA101/notes.md.txt")
    await writeFile(target, "edited phone copy")
    expect(await refreshReadingMirror(vault, destination)).toMatchObject({
      updated: 1,
      recovered: 1,
    })
    expect(await readFile(target, "utf8")).toBe("version one")
    expect(Object.values(await tree(join(destination, "Recovered")))).toContain("edited phone copy")
    expect(await readFile(join(vault, "MBA101/notes.md"))).toEqual(original)
    await put(vault, "MBA101/notes.md", "version two")
    expect(await refreshReadingMirror(vault, destination)).toMatchObject({
      updated: 1,
      recovered: 1,
    })
    await unlink(join(vault, "MBA101/notes.md"))
    expect(await refreshReadingMirror(vault, destination)).toMatchObject({
      updated: 0,
      recovered: 1,
    })
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" })
    expect(Object.values(await tree(join(destination, "Recovered")))).toContain("version two")
  })

  it("refuses unowned collisions before writes and does not reroute an enabled or disabled mirror", async () => {
    const { root, vault, destination } = await fixture()
    await put(vault, "MBA101/notes.md", "local")
    await put(destination, "Current/MBA101/notes.md.txt", "remote student file")
    await expect(refreshReadingMirror(vault, destination)).rejects.toThrow(/unowned/)
    expect(await tree(destination)).toEqual({
      "Current/MBA101/notes.md.txt": "remote student file",
    })
    await unlink(join(destination, "Current/MBA101/notes.md.txt"))
    await refreshReadingMirror(vault, destination)
    await disableReadingMirror(vault)
    expect(await refreshConfiguredReadingMirror(vault)).toBeUndefined()
    await expect(refreshReadingMirror(vault, join(root, "different"))).rejects.toThrow(/reroute/)
    await refreshReadingMirror(vault, destination)
    expect(await refreshConfiguredReadingMirror(vault)).toMatchObject({ unchanged: 2 })
  })

  it("rejects unsafe state and active locks without changing copies or outside files", async () => {
    const { root, vault, destination } = await fixture()
    await put(vault, "MBA101/notes.md", "local")
    await refreshReadingMirror(vault, destination)
    const before = await tree(destination)
    const state = join(vault, "_meta/reading-copy.json")
    await writeFile(
      state,
      JSON.stringify({ version: 1, destination, files: { "../outside": "a".repeat(64) } }),
    )
    await expect(refreshConfiguredReadingMirror(vault)).rejects.toThrow(/Unsafe/)
    expect(await tree(destination)).toEqual(before)
    await unlink(state)
    await mkdir(join(vault, "_meta/reading-copy.lock"))
    await expect(refreshReadingMirror(vault, destination)).rejects.toThrow(/locked/)
    await expect(disableReadingMirror(vault)).rejects.toThrow(/locked/)
    expect(await tree(destination)).toEqual(before)
    expect(await readdir(root)).not.toContain("outside")
  })

  it("excludes newly restricted material from Current and recovers the prior exported version", async () => {
    const { vault, destination } = await fixture()
    await put(vault, "MBA101/notes.md", "previously eligible")
    await refreshReadingMirror(vault, destination)
    await put(vault, "MBA101/notes.md", "---\nredistribution: restricted\n---\nnow restricted")
    expect(await refreshReadingMirror(vault, destination)).toMatchObject({
      recovered: 1,
      skipped: 1,
    })
    expect(Object.values(await tree(join(destination, "Current"))).join("\n")).not.toContain(
      "now restricted",
    )
    expect(Object.values(await tree(join(destination, "Recovered")))).toContain(
      "previously eligible",
    )
  })
})
