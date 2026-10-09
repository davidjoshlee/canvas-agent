import { lstat, realpath } from "node:fs/promises"
import { join, parse, resolve } from "node:path"

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
