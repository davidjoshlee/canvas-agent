import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir } from "node:fs/promises"
import { join } from "node:path"
import { assertNoSymlinks } from "./fs-safety.js"

export interface SchoolLayoutState {
  status: "missing" | "current" | "legacy" | "unsupported" | "invalid"
  hash: string | null
  layoutVersion: number | null
  courseRootVersion: number | null
  supported: boolean
  schoolWrites: "unverified" | "blocked-by-marker"
  note: string
}
/** Inspect only School's marker, never advance it for a selected-course migration. */
export async function inspectSchoolLayout(root: string): Promise<SchoolLayoutState> {
  const path = join(root, "_meta/layout.json")
  const base = { hash: null, layoutVersion: null, courseRootVersion: null } as const
  try {
    await assertNoSymlinks(path, true)
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return undefined
    })
    if (!stat) {
      const entries = await readdir(root, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
          return []
        },
      )
      if (entries.length > 5000) throw new Error("School layout root inventory exceeds bounds")
      const courseFolders = entries.some(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith("."),
      )
      return {
        ...base,
        status: "missing",
        supported: true,
        schoolWrites: courseFolders ? "blocked-by-marker" : "unverified",
        note: courseFolders
          ? "No School marker in a nonempty course vault. Public School 0.1.1 refuses writes until its explicit whole-vault migration/readiness review; Canvas does not create or advance this marker. A separate Canvas namespace alone does not establish shared-writer compatibility."
          : "No School marker or course folders. School may initialize its global marker on first write to an empty vault; initialize School before Canvas creates shared course folders. Shared-writer safety is not established by this inspection.",
      }
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes: Buffer
    try {
      const current = await file.stat()
      if (!current.isFile() || current.size > 64_000) throw new Error("Unsafe School layout marker")
      bytes = await file.readFile()
    } finally {
      await file.close()
    }
    if (bytes.includes(0) || !Buffer.from(bytes.toString()).equals(bytes))
      throw new Error("Invalid School layout marker text")
    const hash = createHash("sha256").update(bytes).digest("hex")
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString())
    } catch {
      return {
        ...base,
        hash,
        status: "invalid",
        supported: false,
        schoolWrites: "blocked-by-marker",
        note: "Invalid School layout JSON; inspect it without overwriting it.",
      }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {
        ...base,
        hash,
        status: "invalid",
        supported: false,
        schoolWrites: "blocked-by-marker",
        note: "School layout marker must be an object; no migration is authorized for unknown metadata.",
      }
    const value = parsed as Record<string, unknown>
    const layoutVersion = typeof value.layout_version === "number" ? value.layout_version : null
    const courseRootVersion =
      typeof value.course_root_version === "number" ? value.course_root_version : null
    const supported =
      (layoutVersion === 1 || layoutVersion === 2) &&
      (value.course_root_version === undefined ||
        courseRootVersion === 1 ||
        courseRootVersion === 2)
    if (!supported)
      return {
        hash,
        layoutVersion,
        courseRootVersion,
        status: "unsupported",
        supported: false,
        schoolWrites: "blocked-by-marker",
        note: "Unsupported School layout/root version; use a matching tool/version and inspect before migrating.",
      }
    const current = layoutVersion === 2 && courseRootVersion === 2
    return {
      hash,
      layoutVersion,
      courseRootVersion,
      status: current ? "current" : "legacy",
      supported: true,
      schoolWrites: current ? "unverified" : "blocked-by-marker",
      note: current
        ? "Marker versions match current School source, but shared-writer behavior/file layout remains unverified. The marker will be preserved."
        : "Current School source rejects this legacy marker in a nonempty course vault. Selected-course migration preserves it; do not advance a global marker or use both writers without a separate whole-vault compatibility review.",
    }
  } catch {
    return {
      ...base,
      status: "invalid",
      supported: false,
      schoolWrites: "blocked-by-marker",
      note: "School layout marker is unsafe or unreadable; inspect symlinks, type and size before migration. No marker bytes were changed.",
    }
  }
}
