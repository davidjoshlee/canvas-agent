import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { z } from "zod"
import { readBoundedFile, vaultPath, vaultRelativePath } from "../../shared/fs-safety.js"
import type { TaskRecord } from "../../shared/types.js"

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex")
const MAX_FILE = 50 * 1024 * 1024
const bundlePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => {
    try {
      vaultRelativePath(value)
      return true
    } catch {
      return false
    }
  }, "Unsafe bundle path")

export const TaskBundleManifestSchema = z
  .object({
    version: z.literal(1),
    taskId: z.string().uuid(),
    primary: bundlePath,
    files: z
      .array(
        z
          .object({
            path: bundlePath,
            role: z.enum(["deliverable", "supporting", "code", "log"]),
            purpose: z.string().min(1).max(4000),
          })
          .strict(),
      )
      .max(500),
    executions: z
      .array(
        z
          .object({
            command: z.string().min(1).max(12000),
            inputFiles: z.array(bundlePath).optional(),
            outputFiles: z.array(bundlePath).optional(),
            exitCode: z.number().int(),
            log: bundlePath.optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    checks: z
      .array(
        z
          .object({
            description: z.string().min(1).max(4000),
            result: z.string().min(1).max(12000),
          })
          .strict(),
      )
      .max(500)
      .optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const paths = [manifest.primary, ...manifest.files.map((file) => file.path)]
    const lower = paths.map((path) => path.toLocaleLowerCase("en-US")).sort()
    for (let i = 0; i < lower.length; i++) {
      if (i > 0 && lower[i] === lower[i - 1])
        ctx.addIssue({
          code: "custom",
          message: "Bundle file paths must be unique, including case-insensitive duplicates",
        })
      if (i < lower.length - 1 && lower[i + 1]?.startsWith(`${lower[i]}/`))
        ctx.addIssue({
          code: "custom",
          message: "Bundle file paths cannot contain file/directory collisions",
        })
    }
    const known = new Set(paths)
    for (const execution of manifest.executions ?? [])
      for (const path of [
        ...(execution.inputFiles ?? []),
        ...(execution.outputFiles ?? []),
        ...(execution.log ? [execution.log] : []),
      ])
        if (!known.has(path))
          ctx.addIssue({
            code: "custom",
            message: `Execution references an unlisted file: ${path}`,
          })
  })
export type TaskBundleManifest = z.infer<typeof TaskBundleManifestSchema>

const BundleRecordSchema = z
  .object({
    version: z.literal(1),
    taskId: z.string().uuid(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    primary: bundlePath,
    files: z
      .array(
        z
          .object({
            path: bundlePath,
            role: z.enum(["deliverable", "supporting", "code", "log"]),
            purpose: z.string().min(1).max(4000),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
            size: z.number().int().nonnegative().max(MAX_FILE),
          })
          .strict(),
      )
      .max(501),
    executions: TaskBundleManifestSchema.shape.executions,
    checks: TaskBundleManifestSchema.shape.checks,
  })
  .strict()
export type BundleRecord = {
  version: 1
  taskId: string
  hash: string
  manifestHash: string
  primary: string
  files: Array<{ path: string; role: string; purpose: string; hash: string; size: number }>
  executions?: Array<{
    command: string
    inputFiles?: string[]
    outputFiles?: string[]
    exitCode: number
    log?: string
  }>
  checks?: Array<{ description: string; result: string }>
}
export const bundleRecordPath = (id: string) => `_meta/tasks/${id}/bundle/record.json`
export const bundleSnapshotPath = (id: string, path: string) =>
  `_meta/tasks/${id}/bundle/files/${path}`

export async function readVerifiedBundle(
  vault: string,
  id: string,
  task: TaskRecord,
): Promise<BundleRecord | undefined> {
  if (!task.bundleHash) {
    try {
      await vaultPath(vault, bundleRecordPath(id))
      throw new Error("Unanchored task bundle record exists")
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
    }
    return undefined
  }
  const raw = await readBoundedFile(await vaultPath(vault, bundleRecordPath(id)), 2_000_000)
  let r: BundleRecord
  try {
    r = BundleRecordSchema.parse(JSON.parse(raw.toString("utf8"))) as BundleRecord
  } catch {
    throw new Error("Task bundle record schema validation failed")
  }
  if (r.version !== 1 || r.taskId !== id || sha(JSON.stringify(r)) !== task.bundleHash)
    throw new Error("Task bundle record integrity check failed")
  const reservation = JSON.parse(
    (
      await readBoundedFile(
        await vaultPath(vault, `_meta/tasks/${id}/bundle/reservation.json`),
        4096,
      )
    ).toString("utf8"),
  ) as { version: number; taskId: string; hash: string }
  if (reservation.version !== 1 || reservation.taskId !== id || reservation.hash !== r.hash)
    throw new Error("Task bundle reservation integrity check failed")
  const manifest = await readBoundedFile(
    await vaultPath(vault, `_meta/tasks/${id}/bundle/manifest.json`),
    2_000_000,
  )
  if (sha(manifest) !== r.manifestHash)
    throw new Error("Task bundle manifest integrity check failed")
  let parsedManifest: TaskBundleManifest
  try {
    parsedManifest = TaskBundleManifestSchema.parse(JSON.parse(manifest.toString("utf8")))
  } catch {
    throw new Error("Task bundle manifest schema validation failed")
  }
  if (parsedManifest.taskId !== id || parsedManifest.primary !== r.primary)
    throw new Error("Task bundle record does not match its manifest identity")
  const expectedFiles = [
    { path: parsedManifest.primary, role: "deliverable", purpose: "Primary Markdown response" },
    ...parsedManifest.files,
  ]
  if (
    JSON.stringify(expectedFiles) !==
    JSON.stringify(r.files.map(({ path, role, purpose }) => ({ path, role, purpose })))
  )
    throw new Error("Task bundle file metadata does not match its manifest")
  if (
    JSON.stringify(parsedManifest.executions ?? []) !== JSON.stringify(r.executions ?? []) ||
    JSON.stringify(parsedManifest.checks ?? []) !== JSON.stringify(r.checks ?? [])
  )
    throw new Error("Task bundle execution/check metadata does not match its manifest")
  for (const f of r.files) {
    const b = await readBoundedFile(
      await vaultPath(vault, bundleSnapshotPath(id, f.path)),
      MAX_FILE,
    )
    if (b.length !== f.size || sha(b) !== f.hash)
      throw new Error(`Task bundle file integrity check failed: ${f.path}`)
  }
  const bundleDigest = sha(
    JSON.stringify({ manifest: r.manifestHash, files: r.files.map((f) => [f.path, f.hash]) }),
  )
  if (bundleDigest !== r.hash) throw new Error("Task bundle content digest failed")
  const primary = r.files.find((file) => file.path === r.primary)
  if (!primary || (task.status === "completed" && task.outputHash !== primary.hash))
    throw new Error("Task bundle primary response does not match completed output")
  return r
}

export async function bundleFileLocations(vault: string, id: string, record: BundleRecord) {
  return Promise.all(
    record.files.map(async (file) => {
      const path = bundleSnapshotPath(id, file.path)
      const absolutePath = await vaultPath(vault, path)
      return { ...file, snapshotPath: path, absolutePath: resolve(absolutePath) }
    }),
  )
}
