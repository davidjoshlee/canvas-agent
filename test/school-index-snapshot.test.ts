import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it } from "vitest"
import { withSchoolIndexSnapshot } from "../src/school-index-snapshot.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-index-snapshot-test-"))
  roots.push(root)
  const index = join(root, "index.sqlite"),
    db = new DatabaseSync(index)
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES('synthetic')",
  )
  return { root, index, db }
}
async function inventory(root: string) {
  const result: Record<string, Buffer> = {}
  for (const entry of await readdir(root)) result[entry] = await readFile(join(root, entry))
  return result
}
it("queries a closed WAL database without creating original WAL/SHM sidecars", async () => {
  const f = await fixture()
  f.db.close()
  const before = await inventory(f.root)
  let copy = ""
  const result = await withSchoolIndexSnapshot(f.index, (path) => {
    copy = path
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      return db.prepare("SELECT value FROM fixture").get()?.value
    } finally {
      db.close()
    }
  })
  expect(result).toBe("synthetic")
  expect(await inventory(f.root)).toEqual(before)
  await expect(lstat(copy)).rejects.toMatchObject({ code: "ENOENT" })
})
it("includes committed live WAL rows and leaves the original database/WAL/SHM bytes unchanged", async () => {
  const f = await fixture()
  try {
    f.db.exec("INSERT INTO fixture VALUES('committed-wal')")
    const before = await inventory(f.root)
    const count = await withSchoolIndexSnapshot(f.index, (path) => {
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        return db.prepare("SELECT COUNT(*) AS count FROM fixture").get()?.count
      } finally {
        db.close()
      }
    })
    expect(count).toBe(2)
    expect(await inventory(f.root)).toEqual(before)
  } finally {
    f.db.close()
  }
})
it("refuses linked WAL and hot rollback journals without querying or altering them", async () => {
  const f = await fixture()
  f.db.close()
  await symlink(f.index, `${f.index}-wal`)
  let queried = false
  await expect(
    withSchoolIndexSnapshot(f.index, () => {
      queried = true
    }),
  ).rejects.toThrow(/links/)
  expect(queried).toBe(false)
  await rm(`${f.index}-wal`)
  await writeFile(`${f.index}-journal`, "synthetic hot journal")
  const before = await inventory(f.root)
  await expect(
    withSchoolIndexSnapshot(f.index, () => {
      queried = true
    }),
  ).rejects.toThrow(/rollback journal/)
  expect(queried).toBe(false)
  expect(await inventory(f.root)).toEqual(before)
})
