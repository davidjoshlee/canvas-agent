import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { type FileHandle, lstat, mkdtemp, open, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertNoSymlinks } from "./fs-safety.js"

/** SQLite may create sidecars on read-only opens. Query a private checked copy instead. */
export async function withSchoolIndexSnapshot<T>(
  source: string,
  inspect: (copy: string) => T | Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "canvas-school-index-snapshot-"))
  const target = join(root, "index.sqlite")
  const fingerprints = new Map<string, string | null>()
  async function copyOrHash(path: string, destination?: string): Promise<string | null> {
    await assertNoSymlinks(path, true)
    let input: FileHandle
    try {
      input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
    let output: FileHandle | undefined
    try {
      const before = await input.stat()
      if (!before.isFile() || before.size > 512 * 1024 * 1024)
        throw new Error("School index snapshot source is unsafe or oversized")
      if (destination) output = await open(destination, "wx", 0o600)
      const digest = createHash("sha256"),
        buffer = Buffer.alloc(64 * 1024)
      let count = 0
      while (true) {
        const read = await input.read(
          buffer,
          0,
          Math.min(buffer.length, 512 * 1024 * 1024 + 1 - count),
          count,
        )
        if (!read.bytesRead) break
        count += read.bytesRead
        if (count > before.size) throw new Error("School index changed during snapshot")
        digest.update(buffer.subarray(0, read.bytesRead))
        if (output) {
          let written = 0
          while (written < read.bytesRead) {
            const part = await output.write(buffer, written, read.bytesRead - written)
            if (!part.bytesWritten) throw new Error("School index snapshot write failed")
            written += part.bytesWritten
          }
        }
      }
      const after = await input.stat(),
        pathAfter = await lstat(path)
      if (
        count !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        pathAfter.isSymbolicLink() ||
        pathAfter.ino !== before.ino ||
        pathAfter.dev !== before.dev
      )
        throw new Error("School index changed during snapshot")
      return digest.digest("hex")
    } finally {
      await output?.close()
      await input.close()
    }
  }
  try {
    for (const suffix of ["", "-wal"]) {
      const hash = await copyOrHash(source + suffix, target + suffix)
      if (!suffix && hash === null) throw new Error("School index is missing")
      fingerprints.set(suffix, hash)
    }
    // Hot rollback journals require recovery. Never recover or modify the original.
    const journal = await lstat(`${source}-journal`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return null
    })
    if (journal && (journal.isSymbolicLink() || !journal.isFile() || journal.size > 0))
      throw new Error("School rollback journal requires inspection before diagnostics")
    for (const [suffix, expected] of fingerprints) {
      if ((await copyOrHash(source + suffix)) !== expected)
        throw new Error("School index changed during snapshot; retry after the writer settles")
    }
    return await inspect(target)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
