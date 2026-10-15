import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { assertNoSymlinks } from "./fs-safety.js"
import type { ToolkitConfig } from "./types.js"

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const metadata = z
  .object({
    version: z.literal(1),
    courses: z
      .array(
        z
          .object({
            id: z.string().regex(/^[1-9]\d*$/),
            root: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/),
            syncNamespace: z.literal("Canvas Agent").optional(),
          })
          .passthrough(),
      )
      .max(1000),
  })
  .passthrough()
const ownership = z
  .object({
    version: z.literal(1),
    origin: z.string().optional(),
    files: z.record(z.string(), digest),
  })
  .passthrough()
const planSchema = z
  .object({
    version: z.literal(1),
    courseId: z.string().regex(/^[1-9]\d*$/),
    root: z.string(),
    ready: z.boolean(),
    alreadyEnabled: z.boolean(),
    mappingHash: digest,
    stateHash: digest,
    homeHash: digest.nullable(),
    conflicts: z.array(z.string()),
  })
  .strict()
export type PreservationPlan = z.infer<typeof planSchema>
let hook: ((phase: "after-home-move" | "after-map-write") => Promise<void>) | undefined
export function setPreservationHookForTests(value?: typeof hook) {
  hook = value
}
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
async function bounded(path: string, limit: number): Promise<{ bytes: Buffer; mode: number }> {
  await assertNoSymlinks(path)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > limit)
      throw new Error("Preservation evidence is not a bounded regular file")
    const bytes = await file.readFile()
    if (bytes.length > limit) throw new Error("Preservation evidence exceeded its bounded read")
    return { bytes, mode: stat.mode & 0o777 }
  } finally {
    await file.close()
  }
}
function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new Error("Preservation metadata is invalid; no payload was echoed")
  }
}
async function evidence(config: ToolkitConfig, courseId: string) {
  if (!/^[1-9]\d{0,39}$/.test(courseId) || !config.courses.allowlist.includes(courseId))
    throw new Error("Preservation migration requires one explicitly allowlisted numeric course ID")
  const vault = resolve(config.vault.path)
  await assertNoSymlinks(vault)
  const mappingPath = join(vault, "_meta/canvas-courses.json"),
    statePath = join(vault, "_meta/canvas-sync-state.json")
  const map = await bounded(mappingPath, 10_000_000),
    state = await bounded(statePath, 10_000_000)
  const parsedMap = metadata.safeParse(parseJson(map.bytes)),
    parsedState = ownership.safeParse(parseJson(state.bytes))
  if (!parsedMap.success || !parsedState.success)
    throw new Error("Preservation mappings/ownership are unsupported; no payload was echoed")
  if (
    parsedState.data.origin !== undefined &&
    parsedState.data.origin !== new URL(config.canvas.baseUrl).origin
  )
    throw new Error(
      "Configured Canvas origin differs from stored ownership; no migration permitted",
    )
  const matches = parsedMap.data.courses.filter((course) => course.id === courseId)
  const course = matches[0]
  if (
    matches.length !== 1 ||
    !course ||
    parsedMap.data.courses.filter((item) => item.root.toLowerCase() === course.root.toLowerCase())
      .length !== 1
  )
    throw new Error("Preservation course identity/root is ambiguous")
  const homeKey = `${course.root}/00 Home.md`,
    homePath = join(vault, homeKey)
  const ownedHash = parsedState.data.files[homeKey]
  const conflicts: string[] = []
  let home: Awaited<ReturnType<typeof bounded>> | undefined
  if (ownedHash) {
    try {
      home = await bounded(homePath, 5_000_000)
    } catch {
      conflicts.push("Owned root Home is missing, unsafe or oversized; inspect without moving it")
    }
    if (home && sha(home.bytes) !== ownedHash)
      conflicts.push(
        "Root Home was edited after Canvas ownership was recorded; preserve it for manual review",
      )
  } else if (course.syncNamespace !== "Canvas Agent")
    conflicts.push("No hash-owned root Canvas Home to archive; use sync --preserve-school instead")
  const alreadyEnabled = course.syncNamespace === "Canvas Agent" && !ownedHash
  const plan: PreservationPlan = {
    version: 1,
    courseId,
    root: course.root,
    ready: conflicts.length === 0,
    alreadyEnabled,
    mappingHash: sha(map.bytes),
    stateHash: sha(state.bytes),
    homeHash: home ? sha(home.bytes) : null,
    conflicts,
  }
  return {
    vault,
    course,
    mappingPath,
    statePath,
    map,
    state,
    parsedMap: parsedMap.data,
    parsedState: parsedState.data,
    homeKey,
    homePath,
    home,
    plan,
  }
}
export async function planPreservationMigration(
  config: ToolkitConfig,
  courseId: string,
): Promise<PreservationPlan> {
  return (await evidence(config, courseId)).plan
}
async function replaceOwned(path: string, expected: string, bytes: Buffer | string, mode: number) {
  const current = await bounded(path, 10_000_000)
  if (sha(current.bytes) !== expected)
    throw new Error("Preservation metadata changed concurrently; stop and inspect")
  const temp = `${path}.${randomUUID()}.tmp`
  let created = false
  try {
    await writeFile(temp, bytes, { flag: "wx", mode })
    created = true
    if (sha((await bounded(path, 10_000_000)).bytes) !== expected)
      throw new Error("Preservation metadata changed concurrently; stop and inspect")
    await rename(temp, path)
  } finally {
    if (created) await unlink(temp).catch(() => undefined)
  }
}
/** Explicit application archives only a still-hash-owned generated Home. Never
 * rewrites School artifacts, private task histories, sources or global markers. */
export async function applyPreservationMigration(config: ToolkitConfig, input: PreservationPlan) {
  const parsed = planSchema.safeParse(input)
  if (!parsed.success) throw new Error("Unsupported preservation plan")
  const fresh = await evidence(config, parsed.data.courseId)
  if (JSON.stringify(parsed.data) !== JSON.stringify(fresh.plan) || !fresh.plan.ready)
    throw new Error("Preservation plan is stale or conflicted; preview again before applying")
  if (fresh.plan.alreadyEnabled)
    return { changed: false, namespace: "Canvas Agent", historicalArchiveVerified: false }
  if (!fresh.home || !fresh.plan.homeHash) throw new Error("No owned navigation bytes to preserve")
  const nonce = randomUUID(),
    lockPath = preservationLock(fresh.vault)
  await assertNoSymlinks(lockPath, true)
  await writeFile(lockPath, nonce, { flag: "wx", mode: 0o600 })
  const archiveRel = `_meta/canvas-preservation/${nonce}`,
    archive = join(fresh.vault, archiveRel)
  let archiveCreated = false
  let moved = false,
    mapWritten = false,
    stateWritten = false
  let newMapHash = "",
    newStateHash = ""
  try {
    if (
      JSON.stringify((await evidence(config, fresh.plan.courseId)).plan) !==
      JSON.stringify(fresh.plan)
    )
      throw new Error("Preservation evidence changed while acquiring the lock")
    await assertNoSymlinks(archive, true)
    await mkdir(join(fresh.vault, "_meta/canvas-preservation"), { recursive: true, mode: 0o700 })
    await mkdir(archive, { mode: 0o700 })
    archiveCreated = true
    await writeFile(join(archive, "Home.original.md"), fresh.home.bytes, {
      flag: "wx",
      mode: 0o600,
    })
    await writeFile(join(archive, "mapping.original.json"), fresh.map.bytes, {
      flag: "wx",
      mode: 0o600,
    })
    await writeFile(join(archive, "state.original.json"), fresh.state.bytes, {
      flag: "wx",
      mode: 0o600,
    })
    await writeFile(join(archive, "plan.json"), JSON.stringify(fresh.plan), {
      flag: "wx",
      mode: 0o600,
    })
    if (sha((await bounded(fresh.homePath, 5_000_000)).bytes) !== fresh.plan.homeHash)
      throw new Error("Root navigation changed before archiving")
    await rename(fresh.homePath, join(archive, "Home.moved.md"))
    moved = true
    await chmod(join(archive, "Home.moved.md"), 0o600)
    if (
      sha((await bounded(join(archive, "Home.moved.md"), 5_000_000)).bytes) !== fresh.plan.homeHash
    )
      throw new Error("Concurrent navigation bytes were retained; inspect recovery before retrying")
    await hook?.("after-home-move")
    const map = {
      ...fresh.parsedMap,
      courses: fresh.parsedMap.courses.map((course) =>
        course.id === fresh.course.id ? { ...course, syncNamespace: "Canvas Agent" } : course,
      ),
    }
    const mapBytes = `${JSON.stringify(map, null, 2)}\n`
    newMapHash = sha(mapBytes)
    await replaceOwned(fresh.mappingPath, fresh.plan.mappingHash, mapBytes, fresh.map.mode)
    mapWritten = true
    await hook?.("after-map-write")
    const files = { ...fresh.parsedState.files }
    delete files[fresh.homeKey]
    files[`${archiveRel}/Home.original.md`] = fresh.plan.homeHash
    files["_meta/canvas-courses.json"] = newMapHash
    const stateBytes = `${JSON.stringify({ ...fresh.parsedState, files }, null, 2)}\n`
    newStateHash = sha(stateBytes)
    await replaceOwned(fresh.statePath, fresh.plan.stateHash, stateBytes, fresh.state.mode)
    stateWritten = true
    try {
      await lstat(fresh.homePath)
      throw new Error("A concurrent root Home appeared; preserve it and inspect recovery")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await writeFile(
      join(archive, "receipt.json"),
      JSON.stringify({
        version: 1,
        status: "completed",
        courseId: fresh.course.id,
        root: fresh.course.root,
        originalHome: fresh.homeKey,
        archivedHome: `${archiveRel}/Home.original.md`,
        homeHash: fresh.plan.homeHash,
        mappingHash: newMapHash,
        stateHash: newStateHash,
        oldTaskDestinationsRewritten: false,
        schoolLayoutChanged: false,
      }),
      { flag: "wx", mode: 0o600 },
    )
    return {
      changed: true,
      namespace: "Canvas Agent",
      archive: archiveRel,
      archivedHome: `${archiveRel}/Home.original.md`,
      homeHash: fresh.plan.homeHash,
      oldTasksMayNeedFreshSources: true,
    }
  } catch {
    if (!archiveCreated)
      throw new Error(
        "Preservation migration stopped before archiving; no navigation was moved. Inspect storage and preview again",
      )
    let recovery = false
    if (stateWritten)
      await replaceOwned(fresh.statePath, newStateHash, fresh.state.bytes, fresh.state.mode).catch(
        () => {
          recovery = true
        },
      )
    if (mapWritten)
      await replaceOwned(fresh.mappingPath, newMapHash, fresh.map.bytes, fresh.map.mode).catch(
        () => {
          recovery = true
        },
      )
    if (moved) {
      // Exclusive restoration never replaces a School/student Home created during the move.
      const restored = join(archive, "Home.restore.tmp")
      try {
        const movedBytes = await bounded(join(archive, "Home.moved.md"), 5_000_000)
        await writeFile(restored, movedBytes.bytes, { flag: "wx", mode: fresh.home.mode })
        await assertNoSymlinks(fresh.homePath, true)
        await link(restored, fresh.homePath)
      } catch {
        recovery = true
      } finally {
        await unlink(restored).catch(() => undefined)
      }
    }
    throw new Error(
      `Preservation migration stopped; originals/metadata backups were retained at ${archiveRel}.${recovery ? " Concurrent state was preserved; manual recovery is required." : " Owned changes were rolled back; preview again before retrying."}`,
    )
  } finally {
    await assertNoSymlinks(lockPath, true)
    if ((await readFile(lockPath, "utf8").catch(() => "")) === nonce) await unlink(lockPath)
  }
}
