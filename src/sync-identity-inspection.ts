import { constants } from "node:fs"
import { type FileHandle, open } from "node:fs/promises"
import { join } from "node:path"
import { assertNoSymlinks } from "./fs-safety.js"

type BindingState = "absent" | "unbound" | "matched" | "mismatched" | "invalid"
export interface SyncIdentityInspection {
  origin: BindingState
  account: "absent" | "reserved" | "mismatched" | "invalid"
  currentAccountVerified: false
  historicalCacheOwnershipVerified: false
}
async function readRecord(
  path: string,
  max: number,
  privateMode = false,
): Promise<Record<string, unknown> | undefined> {
  await assertNoSymlinks(path, true)
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > max || (privateMode && stat.mode & 0o077))
      throw new Error("Unsafe binding")
    const buffer = Buffer.alloc(Math.min(stat.size + 1, max + 1))
    const { bytesRead } = await handle.read(buffer)
    if (bytesRead > max) throw new Error("Oversized binding")
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)),
    )
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid binding")
    return value as Record<string, unknown>
  } finally {
    await handle.close()
  }
}
function validOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    const url = new URL(value)
    return ["http:", "https:"].includes(url.protocol) && url.origin === value
  } catch {
    return false
  }
}

/** Local fixed-path diagnostics only. No profile, token, feedback or coursework bodies. */
export async function inspectSyncIdentity(
  vault: string,
  configuredOrigin: string,
): Promise<SyncIdentityInspection> {
  const result: SyncIdentityInspection = {
    origin: "absent",
    account: "absent",
    currentAccountVerified: false,
    historicalCacheOwnershipVerified: false,
  }
  try {
    const reservation = await readRecord(join(vault, "_meta/canvas-origin.json"), 4096)
    const state = await readRecord(join(vault, "_meta/canvas-sync-state.json"), 10_000_000)
    if (
      reservation &&
      (reservation.version !== 1 ||
        Object.keys(reservation).sort().join(",") !== "origin,version" ||
        !validOrigin(reservation.origin))
    )
      throw new Error("Invalid origin reservation")
    if (
      state &&
      (state.version !== 1 ||
        !state.files ||
        typeof state.files !== "object" ||
        Array.isArray(state.files) ||
        (state.origin !== undefined && !validOrigin(state.origin)))
    )
      throw new Error("Invalid ownership state")
    const origins = [reservation?.origin, state?.origin].filter(
      (value): value is string => typeof value === "string",
    )
    result.origin = origins.some((value) => value !== configuredOrigin)
      ? "mismatched"
      : origins.length
        ? "matched"
        : state
          ? "unbound"
          : "absent"
  } catch {
    result.origin = "invalid"
  }
  try {
    const subject = await readRecord(join(vault, "_meta/canvas-subject.json"), 4096, true)
    if (subject) {
      if (
        subject.version !== 1 ||
        Object.keys(subject).sort().join(",") !== "origin,subjectHash,version" ||
        !validOrigin(subject.origin) ||
        typeof subject.subjectHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(subject.subjectHash)
      )
        throw new Error("Invalid subject reservation")
      result.account = subject.origin === configuredOrigin ? "reserved" : "mismatched"
    }
  } catch {
    result.account = "invalid"
  }
  return result
}
