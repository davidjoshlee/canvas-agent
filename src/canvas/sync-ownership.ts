import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { assertNoSymlinks } from "../shared/fs-safety.js"
import { assertNoPreservationMigration } from "../vault/write-guard.js"

type Obj = Record<string, unknown>

export function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export type SyncState = { version: 1; origin?: string; files: Record<string, string> }
export class CanvasOriginMismatch extends Error {}

export async function guardCanvasOrigin(
  vault: string,
  origin: string,
  reserve = false,
): Promise<void> {
  const path = join(vault, "_meta", "canvas-origin.json")
  await assertNoSymlinks(path, true)
  let bytes: string
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > 4096)
      throw new CanvasOriginMismatch(
        "Canvas origin reservation is unsafe; inspect it or choose a separate vault.",
      )
    bytes = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    if (!reserve) return
    await safeMkdir(vault, dirname(path))
    await assertNoSymlinks(path, true)
    try {
      await writeFile(path, JSON.stringify({ version: 1, origin }), { flag: "wx", mode: 0o600 })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      return guardCanvasOrigin(vault, origin)
    }
  }
  let value: unknown
  try {
    value = JSON.parse(bytes)
  } catch {
    /* Generic error below never echoes private state. */
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "origin,version" ||
    (value as Obj).version !== 1 ||
    (value as Obj).origin !== origin
  )
    throw new CanvasOriginMismatch(
      "Canvas server differs from the vault's origin reservation or its binding is invalid; choose a separate vault. No existing coursework or feedback was changed.",
    )
}

export type Managed = {
  vault: string
  subjectHash: string
  state: SyncState
  trusted: boolean
  stateHash?: string
  written: string[]
  notices: string[]
}

export function relativeVault(vault: string, path: string): string {
  const value = relative(vault, path).split(sep).join("/")
  if (!value || value === ".." || value.startsWith("../") || isAbsolute(value))
    throw new Error("Canvas output path escapes the vault")
  return value
}

export async function safeMkdir(_vault: string, path: string): Promise<void> {
  await assertNoSymlinks(path, true)
  await mkdir(path, { recursive: true })
  await assertNoSymlinks(path)
}

export async function managedWrite(
  manager: Managed,
  path: string,
  bytes: Buffer | string,
  privateMode = false,
): Promise<boolean> {
  await assertNoPreservationMigration(manager.vault)
  const key = relativeVault(manager.vault, path)
  await assertNoSymlinks(path, true)
  await safeMkdir(manager.vault, dirname(path))
  let current: Buffer | undefined
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Canvas output is not a regular file: ${key}`)
    if (privateMode && info.mode & 0o077)
      throw new Error("Own feedback output is not private; it was preserved")
    current = await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (current && sha(current) === sha(bytes)) return false
  if (current && (!manager.trusted || manager.state.files[key] !== sha(current))) {
    manager.notices.push(
      `Preserved changed or untracked file ${key}; Canvas updates were not applied.`,
    )
    return false
  }
  await assertNoSymlinks(path, true)
  if (!current) {
    try {
      await writeFile(path, bytes, { flag: "wx", ...(privateMode ? { mode: 0o600 } : {}) })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        manager.notices.push(`Preserved concurrently created file ${key}.`)
        return false
      }
      throw error
    }
  } else {
    const tempPath = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(tempPath, bytes, { flag: "wx", ...(privateMode ? { mode: 0o600 } : {}) })
      await assertNoSymlinks(path)
      if (sha(await readFile(path)) !== manager.state.files[key]) {
        manager.notices.push(`Preserved concurrently edited file ${key}.`)
        return false
      }
      await rename(tempPath, path)
    } finally {
      try {
        await unlink(tempPath)
      } catch {
        /* renamed or absent */
      }
    }
  }
  manager.state.files[key] = sha(bytes)
  manager.written.push(path)
  return true
}

export async function loadSyncState(
  vault: string,
  notices: string[],
  origin: string,
): Promise<{ state: SyncState; trusted: boolean; stateHash?: string }> {
  const path = join(vault, "_meta", "canvas-sync-state.json")
  await assertNoSymlinks(path, true)
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Sync state is not a regular file")
    const raw = await readFile(path, "utf8"),
      parsed = JSON.parse(raw)
    if (
      parsed.version !== 1 ||
      !parsed.files ||
      typeof parsed.files !== "object" ||
      Array.isArray(parsed.files)
    )
      throw new Error("Sync state has an unsupported format")
    if (parsed.origin !== undefined) {
      let canonicalOrigin: string | undefined
      try {
        canonicalOrigin = new URL(parsed.origin).origin
      } catch {
        // An invalid saved binding must not fall through to an untrusted fresh state.
      }
      if (typeof parsed.origin !== "string" || canonicalOrigin !== parsed.origin)
        throw new CanvasOriginMismatch(
          "Canvas sync origin binding is invalid; existing vault was preserved. Inspect it or choose a separate vault.",
        )
      if (parsed.origin !== origin)
        throw new CanvasOriginMismatch(
          "Canvas server differs from this vault's sync binding; choose a separate vault. No existing coursework or feedback was changed.",
        )
    } else if (Object.keys(parsed.files).length)
      notices.push(
        "Legacy sync state has no verified server binding. This first configured-origin binding protects future syncs only; historical feedback/account ownership remains unverified.",
      )
    return {
      state: { version: 1, origin, files: parsed.files },
      trusted: true,
      stateHash: sha(raw),
    }
  } catch (error) {
    if (error instanceof CanvasOriginMismatch) throw error
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      notices.push("Canvas sync state could not be trusted; existing files will be preserved.")
    return {
      state: { version: 1, origin, files: {} },
      trusted: (error as NodeJS.ErrnoException).code === "ENOENT",
    }
  }
}

export async function saveSyncState(manager: Managed): Promise<void> {
  if (!manager.trusted) return
  try {
    await assertNoPreservationMigration(manager.vault)
  } catch {
    manager.notices.push(
      "Preservation migration lock prevented ownership-state refresh; partial files were retained for review",
    )
    return
  }
  const path = join(manager.vault, "_meta", "canvas-sync-state.json")
  await safeMkdir(manager.vault, dirname(path))
  await assertNoSymlinks(path, true)
  const bytes = `${JSON.stringify(manager.state, null, 2)}\n`
  try {
    const current = await readFile(path)
    if (!manager.stateHash || sha(current) !== manager.stateHash) {
      manager.notices.push(
        "Preserved changed Canvas sync state; concurrent or manual changes were not overwritten.",
      )
      return
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || manager.stateHash) {
      manager.notices.push(
        "Preserved changed Canvas sync state; concurrent or manual changes were not overwritten.",
      )
      return
    }
  }
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, bytes, { flag: "wx" })
  try {
    await assertNoSymlinks(path, true)
    try {
      const current = await readFile(path)
      if (!manager.stateHash || sha(current) !== manager.stateHash) {
        manager.notices.push(
          "Preserved changed Canvas sync state; concurrent or manual changes were not overwritten.",
        )
        return
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || manager.stateHash) {
        manager.notices.push(
          "Preserved changed Canvas sync state; concurrent or manual changes were not overwritten.",
        )
        return
      }
    }
    await rename(tempPath, path)
    manager.stateHash = sha(bytes)
  } finally {
    try {
      await unlink(tempPath)
    } catch {
      /* renamed or absent */
    }
  }
}
