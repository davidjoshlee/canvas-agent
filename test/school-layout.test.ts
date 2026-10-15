import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { inspectSchoolLayout } from "../src/school-layout.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-school-marker-"))
  roots.push(root)
  return root
}

it("distinguishes public School's empty-vault initialization from nonempty missing-marker refusal", async () => {
  const root = await fixture()
  expect(await inspectSchoolLayout(root)).toMatchObject({
    status: "missing",
    schoolWrites: "unverified",
  })
  await mkdir(join(root, "_meta"))
  await mkdir(join(root, ".obsidian"))
  await writeFile(join(root, "README.md"), "Synthetic vault notes")
  expect(await inspectSchoolLayout(root)).toMatchObject({
    status: "missing",
    schoolWrites: "unverified",
  })
  await mkdir(join(root, "CS101"))
  expect(await inspectSchoolLayout(root)).toMatchObject({
    status: "missing",
    supported: true,
    schoolWrites: "blocked-by-marker",
    hash: null,
  })
  expect((await inspectSchoolLayout(root)).note).toContain("Public School 0.1.1 refuses writes")
  await expect(readFile(join(root, "_meta/layout.json"))).rejects.toMatchObject({ code: "ENOENT" })
})

it("does not treat a current marker as format or shared-writer certification", async () => {
  const root = await fixture()
  await mkdir(join(root, "_meta"))
  const path = join(root, "_meta/layout.json")
  const bytes = '{"layout_version":2,"course_root_version":2,"private_setting":"synthetic"}\n'
  await writeFile(path, bytes)
  const state = await inspectSchoolLayout(root)
  expect(state).toMatchObject({ status: "current", schoolWrites: "unverified" })
  expect(JSON.stringify(state)).not.toContain("private_setting")
  expect(await readFile(path, "utf8")).toBe(bytes)
})
