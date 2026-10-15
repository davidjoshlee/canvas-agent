import { spawnSync } from "node:child_process"
import { lstat, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const output = join(root, "dist")
const info = await lstat(output).catch((error) => {
  if (error.code !== "ENOENT") throw error
  return null
})
if (info && (!info.isDirectory() || info.isSymbolicLink()))
  throw new Error("Build output must be a regular checkout-local directory")
// Remove only generated output so deleted modules cannot leak into the package.
await rm(output, { recursive: true, force: true })
const result = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc")], {
  cwd: root,
  stdio: "inherit",
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
