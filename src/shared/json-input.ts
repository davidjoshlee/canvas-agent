import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { assertNoSymlinks } from "./fs-safety.js"

/** Bounded explicit tool input; never echo malformed text or read a credential file. */
export async function readJsonInput(file: string, label: "Calculation" | "Workbook") {
  if (/^(?:\.env|credentials?|secrets?|passwords?|tokens?)(?:\.|$)/i.test(basename(file)))
    throw new Error(`${label} input must not be a credential file`)
  const path = resolve(file)
  await assertNoSymlinks(path)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const limit = 5 * 1024 * 1024
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > limit)
      throw new Error(`${label} input must be a regular file up to 5 MB`)
    const buffer = Buffer.alloc(limit + 1)
    let size = 0
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    if (size > limit) throw new Error(`${label} input exceeds 5 MB`)
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)),
      ) as unknown
    } catch {
      throw new Error(`${label} input must contain valid UTF-8 JSON; inspect locally`)
    }
  } finally {
    await handle.close()
  }
}
