import { spawnSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-build-test-"))
  roots.push(root)
  await mkdir(join(root, "scripts"))
  await mkdir(join(root, "node_modules/typescript/bin"), { recursive: true })
  await copyFile(resolve("scripts/build.mjs"), join(root, "scripts/build.mjs"))
  await writeFile(
    join(root, "node_modules/typescript/bin/tsc"),
    'const fs=require("node:fs");fs.mkdirSync("dist",{recursive:true});fs.writeFileSync("dist/cli.js","synthetic build");',
  )
  return root
}
function build(root: string) {
  return spawnSync(process.execPath, [join(root, "scripts/build.mjs")], {
    cwd: root,
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 30_000,
  })
}
it("clears stale generated modules without touching source files", async () => {
  const root = await fixture()
  await mkdir(join(root, "dist"))
  await writeFile(join(root, "dist/removed-module.js"), "old generated code")
  await writeFile(join(root, "keep-source.txt"), "preserved source")
  const result = build(root)
  expect(result.status, result.stderr).toBe(0)
  expect(await readFile(join(root, "dist/cli.js"), "utf8")).toBe("synthetic build")
  await expect(readFile(join(root, "dist/removed-module.js"))).rejects.toMatchObject({
    code: "ENOENT",
  })
  expect(await readFile(join(root, "keep-source.txt"), "utf8")).toBe("preserved source")
})
it("refuses a linked output directory without changing its target", async () => {
  const root = await fixture()
  const outside = await mkdtemp(join(tmpdir(), "canvas-build-outside-"))
  roots.push(outside)
  await writeFile(join(outside, "keep.txt"), "preserved outside")
  await symlink(outside, join(root, "dist"), "dir")
  const result = build(root)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("checkout-local directory")
  expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("preserved outside")
})
