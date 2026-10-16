import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  publishExclusiveFile,
  readBoundedFile,
  replaceFileAtomically,
  vaultPath,
} from "../../src/shared/fs-safety.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-safe-files-"))
  roots.push(root)
  return root
}

it("resolves normalized paths while refusing traversal and linked ancestors", async () => {
  const root = await fixture()
  for (const path of ["../outside", "/absolute", "a/../b", "a//b", "a\\b", "C:drive", "a\0b"])
    await expect(vaultPath(root, path, true)).rejects.toThrow("Unsafe")
  expect(await vaultPath(root, "missing/reading.md", true)).toBe(join(root, "missing/reading.md"))
  const outside = await fixture()
  await symlink(outside, join(root, "linked"), "dir")
  await expect(vaultPath(root, "linked/reading.md", true)).rejects.toThrow("Symbolic")
})

it("bounds reads and refuses links and non-files", async () => {
  const root = await fixture()
  const path = join(root, "source.md")
  await writeFile(path, "evidence")
  expect((await readBoundedFile(path, 8)).toString()).toBe("evidence")
  await expect(readBoundedFile(path, 7)).rejects.toThrow("bounds")
  await expect(readBoundedFile(root, 20)).rejects.toThrow()
  await symlink(path, join(root, "link.md"))
  await expect(readBoundedFile(join(root, "link.md"), 20)).rejects.toThrow("Symbolic")
})

it("publishes exactly one competing writer and preserves existing bytes", async () => {
  const root = await fixture()
  const path = join(root, "artifact.md")
  const attempts = await Promise.allSettled([
    publishExclusiveFile(path, "first"),
    publishExclusiveFile(path, "second"),
  ])
  expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  const rejected = attempts.find((result) => result.status === "rejected")
  expect(rejected?.status === "rejected" && rejected.reason.code).toBe("EEXIST")
  const original = await readFile(path)
  await expect(publishExclusiveFile(path, "replacement")).rejects.toMatchObject({ code: "EEXIST" })
  expect(await readFile(path)).toEqual(original)
  expect(await readdir(root)).toEqual(["artifact.md"])
})

it("replaces owned metadata and cleans staging files after a failed publication", async () => {
  const root = await fixture()
  const path = join(root, "record.json")
  await writeFile(path, "old")
  await replaceFileAtomically(path, "new")
  expect(await readFile(path, "utf8")).toBe("new")
  const directory = join(root, "directory")
  await mkdir(directory)
  await expect(replaceFileAtomically(directory, "invalid")).rejects.toThrow()
  expect((await readdir(root)).sort()).toEqual(["directory", "record.json"])
})

it.skipIf(process.platform === "win32")(
  "refuses named pipes without blocking on open",
  async () => {
    const root = await fixture()
    const path = join(root, "pipe")
    execFileSync("mkfifo", [path])
    await expect(readBoundedFile(path, 100)).rejects.toThrow("regular")
  },
)

it("refuses publication and replacement through links without changing their targets", async () => {
  const root = await fixture()
  const target = join(root, "original.md")
  const link = join(root, "linked.md")
  await writeFile(target, "student original")
  await symlink(target, link)
  await expect(publishExclusiveFile(link, "replacement")).rejects.toThrow("Symbolic")
  await expect(replaceFileAtomically(link, "replacement")).rejects.toThrow("Symbolic")
  expect(await readFile(target, "utf8")).toBe("student original")
  expect((await readdir(root)).sort()).toEqual(["linked.md", "original.md"])
})
