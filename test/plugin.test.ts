import { lstat, readdir, readFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"

const root = resolve("plugins/canvas-agent")

describe("portable agent plugin", () => {
  it("exposes a versioned plugin through a repository-contained marketplace", async () => {
    const manifest = JSON.parse(await readFile(resolve(root, "plugin.json"), "utf8"))
    const packageJson = JSON.parse(await readFile("package.json", "utf8"))
    const fallback = JSON.parse(await readFile(resolve(root, ".codex-plugin/plugin.json"), "utf8"))
    const marketplace = JSON.parse(await readFile(".agents/plugins/marketplace.json", "utf8"))
    expect(manifest.name).toBe("canvas-agent")
    expect(manifest.version).toBe(packageJson.version)
    expect(fallback).toMatchObject({
      name: manifest.name,
      version: manifest.version,
      skills: "./skills/",
    })
    expect(resolve(marketplace.plugins[0].source.path)).toBe(root)
    expect(manifest).not.toHaveProperty("mcpServers")
    expect(manifest).not.toHaveProperty("apps")
  })

  it("bundles all skill references inside the plugin with no dependency on a source checkout", async () => {
    const skills = await readdir(resolve(root, "skills"))
    expect(skills.sort()).toEqual(["assignment-workflow", "canvas-workspace", "setup-and-sync"])
    for (const skill of skills) {
      const file = resolve(root, "skills", skill, "SKILL.md")
      const text = await readFile(file, "utf8")
      const frontmatter = text.match(/^---\n([\s\S]+?)\n---/)
      const metadata = parse(frontmatter?.[1] ?? "")
      expect(metadata.name).toBe(skill)
      expect(metadata.description.length).toBeGreaterThan(20)
      for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
        const target = resolve(dirname(file), match[1] ?? "")
        expect(relative(root, target).startsWith("..")).toBe(false)
        expect((await lstat(target)).isFile()).toBe(true)
      }
    }
  })
})
