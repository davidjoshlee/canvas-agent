import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { link, lstat, open, realpath, rename, unlink } from "node:fs/promises"
import { isAbsolute, join, parse, resolve } from "node:path"

/** Reject links in every existing ancestor, not just the final entry. */
export async function assertNoSymlinks(path: string, allowMissing = false): Promise<void> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        // macOS exposes OS-managed /var and /tmp as aliases to /private.
        // Permit only those exact targets, never a user-controlled vault link.
        const systemAlias =
          process.platform === "darwin" &&
          ["/var", "/tmp"].includes(current) &&
          (await realpath(current)) === `/private${current}`
        if (!systemAlias) throw new Error("Symbolic links are not allowed in workspace paths")
      }
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
  }
}

/** Validate normalized vault-relative syntax without filesystem access. */
export function vaultRelativePath(path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\") ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Unsafe vault-relative path")
  return path
}

/** Resolve a validated vault path and reject linked ancestors. */
export async function vaultPath(root: string, path: string, allowMissing = false): Promise<string> {
  vaultRelativePath(path)
  const base = resolve(root)
  await assertNoSymlinks(base)
  const stat = await lstat(base)
  if (!stat.isDirectory()) throw new Error("Workspace must be a real directory")
  const target = join(base, ...path.split("/"))
  await assertNoSymlinks(target, allowMissing)
  return target
}

/** Read a regular file through one handle, enforcing the bound before and after reading. */
export async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid file size limit")
  await assertNoSymlinks(path)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error("File is not regular or exceeds bounds")
    const bytes = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1))
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await handle.stat()
    if (
      offset !== stat.size ||
      offset > maxBytes ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new Error("File changed or exceeds bounds")
    return bytes.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

async function stagedFile(path: string, bytes: string | Uint8Array): Promise<string> {
  await assertNoSymlinks(path, true)
  const temporary = `${path}.tmp-${randomUUID()}`
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error) {
    await handle.close()
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  await handle.close()
  return temporary
}

/** Publish synced file bytes without replacing an existing destination (EEXIST is authoritative). */
export async function publishExclusiveFile(
  path: string,
  bytes: string | Uint8Array,
): Promise<void> {
  const temporary = await stagedFile(path, bytes)
  try {
    await assertNoSymlinks(path, true)
    await link(temporary, path)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

/** Replace owned metadata only; callers retain ownership and transaction policy. */
export async function replaceFileAtomically(
  path: string,
  bytes: string | Uint8Array,
): Promise<void> {
  await assertNoSymlinks(path)
  const temporary = await stagedFile(path, bytes)
  try {
    await assertNoSymlinks(path)
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}
