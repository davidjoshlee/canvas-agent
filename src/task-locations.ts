import { isAbsolute, join, resolve } from "node:path"
import { z } from "zod"

export type TaskScope = "ordinary" | "frozen"

export function taskInspectionCommand(scope: TaskScope, id: string, configPath: string) {
  if (scope !== "ordinary" && scope !== "frozen") throw new Error("Unknown task inspection scope")
  z.string().uuid().parse(id)
  return [
    ...(scope === "frozen" ? ["simulate"] : []),
    "task",
    "show",
    id,
    "--config",
    resolve(configPath),
    "--json",
  ]
}

/** Additive CLI metadata, never persisted into academic recipes or receipts. */
export function taskLocations(
  configPath: string,
  vault: string,
  id: string,
  scope: TaskScope,
  output?: string,
  workbook?: string,
) {
  z.string().uuid().parse(id)
  const vaultRoot = resolve(vault)
  const absolute = (path?: string) => {
    if (path === undefined) return null
    if (
      !path ||
      Buffer.byteLength(path) > 4096 ||
      isAbsolute(path) ||
      /^[A-Za-z]:/.test(path) ||
      path.includes("\\") ||
      [...path].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Unsafe saved task artifact path")
    return join(vaultRoot, ...path.split("/"))
  }
  const directory = scope === "frozen" ? `_meta/simulations/tasks/${id}` : `_meta/tasks/${id}`
  return {
    scope,
    inspectionCommand: taskInspectionCommand(scope, id, configPath),
    locations: {
      config: resolve(configPath),
      vaultRoot,
      record: absolute(`${directory}/${scope === "frozen" ? "record.json" : "task.json"}`),
      handoff: absolute(`${directory}/TASK.md`),
      output: absolute(output),
      workbook: absolute(workbook),
      pathsExistenceVerified: false,
      note: "Absolute locations derive from the selected config's vault, never the working directory. They are path metadata, not existence, byte-integrity, currentness, permission or approval checks. Read the selected inspection's state/evidence; do not create missing files or replace saved tasks.",
    },
  }
}
