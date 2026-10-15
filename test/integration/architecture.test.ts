import { spawnSync } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = join(directory, entry.name)
        return entry.isDirectory() ? files(path) : [path]
      }),
    )
  ).flat()
}

it("keeps runtime code grouped and scripts limited to maintained verification", async () => {
  const source = await readdir("src", { withFileTypes: true })
  expect(
    source
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort(),
  ).toEqual(["cli.ts", "turndown.d.ts"])
  expect(
    (await readdir("scripts", { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort(),
  ).toEqual(["build.mjs", "package-smoke.mjs", "sync-context.mjs"])
  expect(
    (await files("dist")).filter((path) =>
      /(?:migration|index-reconciliation|school-index|\/legacy\.js)/.test(path),
    ),
  ).toEqual([])
  const manifest = JSON.parse(await readFile("package.json", "utf8"))
  expect(manifest.bin["canvas-agent"]).toBe("dist/cli.js")
  expect(manifest.files).not.toContain("docs/**")
  expect((await readFile("src/cli.ts", "utf8")).split("\n").length).toBeLessThan(25)
  expect((await readFile("src/cli/program.ts", "utf8")).split("\n").length).toBeLessThan(200)
})

it.each([
  ["legacy"],
  ["vault", "migrate"],
  ["vault", "preserve-school"],
  ["vault", "reconcile-index"],
])("does not expose removed commands: %s %s", (...args) => {
  const result = spawnSync(process.execPath, [resolve("dist/cli.js"), ...args], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 30_000,
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("unknown command")
})
