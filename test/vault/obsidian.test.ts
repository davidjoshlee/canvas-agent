import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  obsidianLaunchCommand,
  planObsidianVault,
  prepareObsidianVault,
} from "../../src/vault/obsidian.js"

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-obsidian-test-"))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe("non-mutating Obsidian setup", () => {
  it("previews file types without reading bodies and creates one exclusive guide while preserving originals/settings", async () => {
    const root = await fixture()
    await mkdir(join(root, "MBA101"))
    await mkdir(join(root, ".obsidian"))
    await mkdir(join(root, "_meta"))
    await writeFile(join(root, "MBA101/00 Home.md"), "DO NOT READ BODY")
    await writeFile(join(root, "MBA101/case.pdf"), "unchanged original")
    await writeFile(join(root, ".obsidian/app.json"), '{"setting":"preserve"}')
    await writeFile(join(root, "_meta/private.json"), "PRIVATE BODY")
    const before = await readdir(root)
    const plan = await planObsidianVault(root)
    expect(await readdir(root)).toEqual(before)
    expect(plan.fileTypes).toEqual({ ".md": 1, ".pdf": 1 })
    expect(plan.courseHomes).toEqual(["MBA101/00 Home.md"])
    expect(JSON.stringify(plan)).not.toContain("DO NOT READ BODY")
    const first = await prepareObsidianVault(root),
      second = await prepareObsidianVault(root)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    const guide = await readFile(first.plan.guidePath, "utf8")
    expect(guide).toContain("MBA101/00%20Home.md")
    expect(guide).not.toContain("PRIVATE BODY")
    expect(await readFile(join(root, "MBA101/case.pdf"), "utf8")).toBe("unchanged original")
    expect(await readFile(join(root, ".obsidian/app.json"), "utf8")).toBe('{"setting":"preserve"}')
    await writeFile(first.plan.guidePath, "User-edited guide")
    expect((await prepareObsidianVault(root)).created).toBe(false)
    expect(await readFile(first.plan.guidePath, "utf8")).toBe("User-edited guide")
  })
  it("blocks private files, configured in-vault paths, invalid guide/settings paths and symlinks", async () => {
    const root = await fixture()
    await writeFile(join(root, ".env"), "DO NOT READ")
    await writeFile(join(root, "school.sqlite"), "DO NOT READ")
    const plan = await planObsidianVault(root, [join(root, "custom-config.json")])
    expect(plan.blockers).toHaveLength(3)
    await expect(prepareObsidianVault(root)).rejects.toThrow(/blocked/)
    const other = await fixture()
    await symlink(root, join(other, "linked"))
    expect((await planObsidianVault(other)).blockers[0]).toContain("symbolic link")
    await mkdir(join(other, "00 Canvas Agent Getting Started.md"))
    await writeFile(join(other, ".obsidian"), "not a directory")
    expect((await planObsidianVault(other)).blockers).toHaveLength(3)
  })
  it("encodes a path-only open URI and never allows URI actions or callbacks to become launch arguments", async () => {
    const root = await fixture(),
      plan = await planObsidianVault(root),
      uri = plan.uri
    expect(new URL(uri).searchParams.get("path")).toBe(plan.guidePath)
    expect(obsidianLaunchCommand(uri, "darwin")).toEqual({ command: "open", args: [uri] })
    expect(obsidianLaunchCommand(uri, "linux")).toEqual({ command: "xdg-open", args: [uri] })
    expect(() => obsidianLaunchCommand(uri, "win32")).toThrow(/manually/)
    for (const value of [
      "https://evil.example",
      "obsidian://new?path=/tmp/x",
      `${uri}&x-success=evil`,
      "obsidian://open?path=relative",
      "obsidian://open/extra?path=/tmp/x",
    ])
      expect(() => obsidianLaunchCommand(value)).toThrow()
  })
})
