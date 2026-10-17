import { createHash } from "node:crypto"
import { lstat, mkdir, realpath } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"
import {
  assertNoSymlinks,
  publishExclusiveFile,
  readBoundedFile,
  replaceFileAtomically,
  vaultPath,
} from "../../shared/fs-safety.js"
import type { TaskRecord } from "../../shared/types.js"
import {
  type BundleRecord,
  bundleFileLocations,
  bundleRecordPath,
  bundleSnapshotPath,
  readVerifiedBundle,
  type TaskBundleManifest,
  TaskBundleManifestSchema,
} from "./bundle-store.js"
import { checkArtifactPrivacy, checkCandidate, completeTask } from "./completion.js"
import { claimCompletionIntent } from "./completion-intent.js"
import { readTask, TaskRecordSchema } from "./records.js"

export type { TaskBundleManifest }
export { TaskBundleManifestSchema }

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex")
const MAX_FILE = 50 * 1024 * 1024
const MAX_TOTAL = 200 * 1024 * 1024
async function readVerified(vault: string, id: string, task?: TaskRecord) {
  task ??= await readTask(vault, id)
  return readVerifiedBundle(vault, id, task)
}

export async function inspectTaskBundle(vault: string, id: string) {
  const task = await readTask(vault, id)
  const r = await readVerified(vault, id, task)
  if (!r) return undefined
  return {
    taskId: id,
    path: bundleRecordPath(id),
    hash: r.hash,
    manifestHash: r.manifestHash,
    primary: r.primary,
    files: await bundleFileLocations(vault, id, r),
    executions: r.executions ?? [],
    checks: r.checks ?? [],
    integrity: "verified" as const,
    reportedBy: "coding-harness" as const,
  }
}

export async function verifyTaskBundle(vault: string, id: string) {
  return readVerified(vault, id)
}

async function captureManifest(vault: string, id: string, manifestPath: string) {
  const task = await readTask(vault, id)
  const absManifest = resolve(manifestPath)
  await assertNoSymlinks(absManifest)
  await assertInsideOwnWorkOrExternal(vault, id, absManifest)
  const manifestBytes = await readBoundedFile(absManifest, 2_000_000)
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"))
  } catch {
    throw new Error("Bundle manifest must be JSON")
  }
  const manifest = TaskBundleManifestSchema.parse(parsed)
  if (manifest.taskId !== id)
    throw new Error("Bundle manifest taskId does not match requested task")
  checkArtifactPrivacy(JSON.stringify(manifest), task)
  const contents: Array<{ meta: TaskBundleManifest["files"][number]; bytes: Buffer }> = []
  let total = 0
  const inputs = [
    { path: manifest.primary, role: "deliverable" as const, purpose: "Primary Markdown response" },
    ...manifest.files,
  ]
  for (const meta of inputs) {
    const abs = resolve(dirname(absManifest), ...meta.path.split("/"))
    const relPath = relative(dirname(absManifest), abs)
    if (relPath.startsWith("..") || resolve(abs) !== abs)
      throw new Error("Bundle file escapes manifest directory")
    await assertNoSymlinks(abs)
    await assertInsideOwnWorkOrExternal(vault, id, abs)
    const st = await lstat(abs)
    if (!st.isFile() || st.size > MAX_FILE)
      throw new Error(`Bundle file is not a bounded regular file: ${meta.path}`)
    const bytes = await readBoundedFile(abs, MAX_FILE)
    total += bytes.length
    if (total > MAX_TOTAL) throw new Error("Bundle exceeds the 200 MB total size limit")
    const text = bytes.toString("utf8")
    const isText = !bytes.includes(0) && Buffer.from(text, "utf8").equals(bytes)
    if (meta.path === manifest.primary && (!isText || !meta.path.toLowerCase().endsWith(".md")))
      throw new Error("Primary response must be UTF-8 Markdown")
    if (isCredentialPath(meta.path)) throw new Error("Bundle cannot include credential files")
    if (isText) checkArtifactPrivacy(text, task)
    else if (
      /(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~-]{16,})/i.test(
        bytes.toString("latin1"),
      )
    )
      throw new Error("Bundle appears to contain credentials")
    if (
      [...task.sources, ...task.guidance].some(
        (s) => s.hash === sha(bytes) || s.originalHash === sha(bytes),
      )
    )
      throw new Error("Bundle cannot adopt a captured course source as an artifact")
    contents.push({ meta, bytes })
  }
  const primary = contents.find((f) => f.meta.path === manifest.primary)
  if (!primary) throw new Error("Primary Markdown response is missing")
  checkCandidate(primary.bytes.toString("utf8"), id, task)
  const snapshot = { manifest, manifestBytes, contents, manifestHash: sha(manifestBytes), hash: "" }
  snapshot.hash = sha(
    JSON.stringify({
      manifest: snapshot.manifestHash,
      files: contents.map((x) => [x.meta.path, sha(x.bytes)]),
    }),
  )
  return { task, snapshot }
}

function isCredentialPath(path: string) {
  return path
    .split("/")
    .some(
      (part) =>
        /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(
          part,
        ) || /\.(?:pem|key|p12|pfx)$/i.test(part),
    )
}

async function assertInsideOwnWorkOrExternal(vault: string, id: string, path: string) {
  const root = await realpath(resolve(vault))
  const actualPath = await realpath(path)
  const fromVault = relative(root, actualPath)
  if (fromVault.startsWith(`..${sep}`) || fromVault === "..") return
  if (fromVault === "")
    throw new Error(
      "Bundle manifests and files inside the vault must be in this task's working directory",
    )
  const work = resolve(root, `_meta/tasks/${id}/work`)
  const actualWork = await realpath(work)
  const fromWork = relative(actualWork, actualPath)
  if (fromWork === ".." || fromWork.startsWith(`..${sep}`))
    throw new Error(
      "Bundle manifests and files inside the vault must be in this task's working directory",
    )
}

/** Complete a task with a private, content-addressed execution bundle. Commands/checks are declarations only. */
export async function completeTaskBundle(vault: string, id: string, manifestPath: string) {
  const { task, snapshot } = await captureManifest(vault, id, manifestPath)
  const base = `_meta/tasks/${id}/bundle`
  if (task.status === "completed") {
    const existing = await readVerified(vault, id, task)
    if (!existing || existing.hash !== snapshot.hash)
      throw new Error("A different bundle is already completed for this task")
    const result = await completeTask(
      vault,
      id,
      await vaultPath(vault, bundleSnapshotPath(id, snapshot.manifest.primary)),
      task.bundleHash,
    )
    return { ...result, bundle: await inspectTaskBundle(vault, id) }
  }
  if (task.bundleHash) {
    const existing = await readVerified(vault, id, task)
    if (!existing || existing.hash !== snapshot.hash)
      throw new Error("A different bundle is reserved for this task")
    const primary = await vaultPath(vault, bundleSnapshotPath(id, snapshot.manifest.primary))
    const result = await completeTask(vault, id, primary, task.bundleHash)
    return { ...result, bundle: await inspectTaskBundle(vault, id) }
  }
  const record: BundleRecord = {
    version: 1,
    taskId: id,
    hash: snapshot.hash,
    manifestHash: snapshot.manifestHash,
    primary: snapshot.manifest.primary,
    files: snapshot.contents.map((f) => ({
      path: f.meta.path,
      role: f.meta.role,
      purpose: f.meta.purpose,
      hash: sha(f.bytes),
      size: f.bytes.length,
    })),
    executions: snapshot.manifest.executions,
    checks: snapshot.manifest.checks,
  }
  const reservationHash = sha(JSON.stringify(record))
  await claimCompletionIntent(vault, id, { version: 1, kind: "bundle", hash: reservationHash })
  const dir = await vaultPath(vault, base, true)
  try {
    await vaultPath(vault, `_meta/tasks/${id}/completion.transaction.json`)
    throw new Error("A file completion is already in progress for this task")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const reservationPath = await vaultPath(vault, `${base}/reservation.json`, true)
  const reservation = JSON.stringify({ version: 1, taskId: id, hash: snapshot.hash })
  await publishOrVerify(reservationPath, Buffer.from(reservation))
  const manifestDest = await vaultPath(vault, `${base}/manifest.json`, true)
  await publishOrVerify(manifestDest, snapshot.manifestBytes)
  for (const f of snapshot.contents) {
    const dest = await vaultPath(vault, bundleSnapshotPath(id, f.meta.path), true)
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
    await publishOrVerify(dest, f.bytes)
  }
  const recBytes = `${JSON.stringify(record, null, 2)}\n`
  const recordDest = await vaultPath(vault, bundleRecordPath(id), true)
  await publishOrVerify(recordDest, Buffer.from(recBytes))
  const taskPath = await vaultPath(vault, `_meta/tasks/${id}/task.json`)
  const latestTask = await readTask(vault, id)
  if (latestTask.status !== "pending" || latestTask.bundleHash)
    throw new Error("Task changed while bundle completion was staged")
  const updated = TaskRecordSchema.parse({
    ...latestTask,
    bundleHash: reservationHash,
  }) as TaskRecord
  await replaceFileAtomically(taskPath, `${JSON.stringify(updated, null, 2)}\n`)
  const result = await completeTask(
    vault,
    id,
    await vaultPath(vault, bundleSnapshotPath(id, snapshot.manifest.primary)),
    reservationHash,
  )
  return { ...result, bundle: await inspectTaskBundle(vault, id) }
}

async function publishOrVerify(path: string, bytes: Buffer) {
  try {
    await publishExclusiveFile(path, bytes)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
    if (!(await readBoundedFile(path, MAX_FILE)).equals(bytes))
      throw new Error("A different bundle snapshot already occupies this path")
  }
}
