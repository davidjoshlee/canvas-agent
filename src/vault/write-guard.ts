import { lstat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { assertNoSymlinks } from "../shared/fs-safety.js"

// Read-only guard for operations interrupted by older CLI versions. Never repair a held lock.
export const preservationLock = (vault: string) =>
  join(resolve(vault), "_meta/canvas-preserve-school.lock")
export async function assertNoPreservationMigration(vault: string): Promise<void> {
  const path = preservationLock(vault)
  await assertNoSymlinks(path, true)
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  throw new Error("A preservation migration lock is held; stop sync and inspect before retrying")
}
