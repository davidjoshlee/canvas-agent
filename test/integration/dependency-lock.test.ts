import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

const root = new URL("../../", import.meta.url)
const json = async (name: string) => JSON.parse(await readFile(new URL(name, root), "utf8"))

describe("published Word-reader dependency tree", () => {
  it("keeps the publishable shrinkwrap aligned with the development lock and manifest", async () => {
    const [lock, shrinkwrap, manifest] = await Promise.all([
      json("package-lock.json"),
      json("npm-shrinkwrap.json"),
      json("package.json"),
    ])
    expect(shrinkwrap).toEqual(lock)
    expect(lock.packages[""].dependencies).toEqual(manifest.dependencies)
    expect(lock.packages[""].bundleDependencies).toEqual(manifest.bundleDependencies)
    expect(manifest.bundleDependencies).toEqual(["mammoth"])
    expect(manifest.files).toContain("npm-shrinkwrap.json")
  })

  it("pins and bundles the compatible parser without the vulnerable formatter", async () => {
    const [lock, manifest] = await Promise.all([json("npm-shrinkwrap.json"), json("package.json")])
    expect(manifest.overrides.mammoth.argparse).toBe("2.0.1")
    expect(lock.packages["node_modules/mammoth"].version).toBe("1.12.1")
    expect(lock.packages["node_modules/mammoth"].inBundle).toBe(true)
    expect(lock.packages["node_modules/argparse"].version).toBe("2.0.1")
    expect(lock.packages["node_modules/argparse"].inBundle).toBe(true)
    expect(Object.keys(lock.packages).some((path) => path.endsWith("/sprintf-js"))).toBe(false)
  })
})
