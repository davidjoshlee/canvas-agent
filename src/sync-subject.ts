import { createHash, randomUUID } from "node:crypto"
import { link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { assertNoSymlinks } from "./fs-safety.js"

export function canvasSubjectHash(origin: string, value: unknown): string {
  const id =
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : typeof value === "string" && /^[1-9]\d{0,99}$/.test(value)
        ? value
        : undefined
  if (!id) throw new Error("Canvas subject identity is unsupported; no profile fields were echoed")
  return createHash("sha256")
    .update(JSON.stringify([origin, id]))
    .digest("hex")
}

/** Private API-subject reservation; never raw profile, token or account label. */
export async function guardSyncSubject(
  vault: string,
  origin: string,
  subjectHash: string,
  reserve = false,
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(subjectHash)) throw new Error("Invalid sync subject binding")
  const path = join(vault, "_meta", "canvas-subject.json")
  await assertNoSymlinks(path, true)
  let bytes: string
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size > 4096 || stat.mode & 0o077)
      throw new Error(
        "Canvas account binding is unsafe or exposed; inspect it or choose a separate vault",
      )
    bytes = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    if (!reserve) return false
    await assertNoSymlinks(dirname(path), true)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await assertNoSymlinks(dirname(path))
    const temp = `${path}.${randomUUID()}.tmp`
    let created = false
    try {
      await writeFile(temp, JSON.stringify({ version: 1, origin, subjectHash }), {
        flag: "wx",
        mode: 0o600,
      })
      created = true
      await assertNoSymlinks(path, true)
      await link(temp, path)
      return true
    } catch (error) {
      if (!created || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    } finally {
      if (created) await unlink(temp).catch(() => undefined)
    }
    if (!(await guardSyncSubject(vault, origin, subjectHash)))
      throw new Error(
        "Concurrent Canvas account binding disappeared; stop and inspect before retrying",
      )
    return true
  }
  let value: unknown
  try {
    value = JSON.parse(bytes)
  } catch {
    /* Never echo private binding bytes. */
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "origin,subjectHash,version" ||
    (value as Record<string, unknown>).version !== 1 ||
    (value as Record<string, unknown>).origin !== origin ||
    (value as Record<string, unknown>).subjectHash !== subjectHash
  )
    throw new Error(
      "Canvas API account differs from the vault's subject binding or its binding is invalid; use a separate vault. No coursework or feedback was changed",
    )
  return true
}
