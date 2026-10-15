import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { readImportedPlaybooks } from "../../src/feedback/imported-snapshots.js"

const roots: string[] = []
const sha = (text: string) => createHash("sha256").update(text).digest("hex")
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const vault = await mkdtemp(join(tmpdir(), "canvas-saved-snapshot-"))
  roots.push(vault)
  const course = { code: "SYNTH101", root: "synth101", canvasId: "17" }
  const body = {
    version: 1,
    course: course.code,
    root: course.root,
    courseId: course.canvasId,
    origin: "https://canvas.example.invalid",
    source: "synth101/_meta/course-playbook.md",
    sourceHash: sha("synthetic original"),
    text: "Previously saved synthetic learning context.",
    importedAt: "2026-10-01T00:00:00.000Z",
    historicalAuthorshipVerified: false,
    historicalDatesVerified: false,
  }
  const record = { ...body, hash: sha(JSON.stringify(body)) }
  const directory = join(vault, "_meta/canvas-playbooks/17", sha(course.root))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${record.sourceHash}.json`)
  await writeFile(path, JSON.stringify(record), { flag: "wx", mode: 0o600 })
  return { vault, course, record, path }
}
it("reads an existing captured snapshot without rewriting it or its original", async () => {
  const { vault, course, record, path } = await fixture()
  const before = await readFile(path)
  expect(await readImportedPlaybooks(vault, course)).toEqual([record])
  expect(await readFile(path)).toEqual(before)
})
it("rejects changed captured bytes instead of silently dropping historical context", async () => {
  const { vault, course, record, path } = await fixture()
  await writeFile(path, JSON.stringify({ ...record, text: "Unbound changed context" }))
  await expect(readImportedPlaybooks(vault, course)).rejects.toThrow("binding")
})
it("refuses exposed private snapshot files without changing them", async () => {
  const { vault, course, path } = await fixture()
  const before = await readFile(path)
  await chmod(path, 0o644)
  await expect(readImportedPlaybooks(vault, course)).rejects.toThrow("permitted regular file")
  expect(await readFile(path)).toEqual(before)
})
