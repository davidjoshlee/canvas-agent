import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { z } from "zod"
import { assertNoSymlinks } from "./fs-safety.js"
import type { ToolkitConfig } from "./types.js"

const ConfigSchema = z
  .object({
    version: z.literal(1),
    canvas: z.object({
      baseUrl: z.string().url(),
      tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    }),
    vault: z.object({ path: z.string().min(1) }),
    courses: z.object({ allowlist: z.array(z.union([z.string(), z.number()]).transform(String)) }),
  })
  .strict()

function validateBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Canvas URL must be an absolute URL")
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    throw new Error("Canvas URL must use HTTPS (HTTP is allowed only for localhost)")
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Canvas URL cannot contain credentials, query, or fragment")
  return url.toString().replace(/\/$/, "")
}

export async function loadConfig(configPath: string): Promise<ToolkitConfig> {
  // Check every existing path component before opening the file. A symlinked
  // config can otherwise redirect a read outside the selected config folder.
  await assertNoSymlinks(resolve(configPath), true)
  let raw: string
  try {
    raw = await readFile(configPath, "utf8")
  } catch {
    throw new Error(`Cannot read config file: ${configPath}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Config file is not valid JSON")
  }
  const result = ConfigSchema.safeParse(parsed)
  if (!result.success)
    throw new Error(
      `Invalid config: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    )
  const baseUrl = validateBaseUrl(result.data.canvas.baseUrl)
  const configDir = dirname(resolve(configPath))
  return {
    version: 1,
    canvas: { baseUrl, tokenEnv: result.data.canvas.tokenEnv },
    vault: { path: resolve(configDir, result.data.vault.path) },
    courses: { allowlist: [...new Set(result.data.courses.allowlist.map(String))] },
  }
}

export async function createConfig(
  configPath: string,
  input: { vault: string; baseUrl: string; tokenEnv?: string; courses?: string[] },
): Promise<ToolkitConfig> {
  const path = resolve(configPath)
  const tokenEnv = input.tokenEnv ?? "CANVAS_API_TOKEN"
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv))
    throw new Error("Invalid token environment variable name")
  const baseUrl = validateBaseUrl(input.baseUrl)
  const vaultPath = resolve(dirname(path), input.vault)
  const relativeVault = requireRelative(dirname(path), vaultPath)
  const config: ToolkitConfig = {
    version: 1,
    canvas: { baseUrl, tokenEnv },
    vault: { path: vaultPath },
    courses: { allowlist: [...new Set((input.courses ?? []).map(String))] },
  }
  // Resolve the schema before persisting, and refuse to replace any existing config.
  ConfigSchema.parse({ ...config, vault: { path: relativeVault } })
  await assertNoSymlinks(path, true)
  await assertNoSymlinks(vaultPath, true)
  await mkdir(dirname(path), { recursive: true })
  let exists = false
  try {
    await readFile(path)
    exists = true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
  }
  if (exists) throw new Error(`Config already exists: ${path}`)
  await writeFile(
    path,
    `${JSON.stringify({ ...config, vault: { path: relativeVault } }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  )
  return config
}

/** Create the first-run config and a private, intentionally blank adjacent .env template. */
export async function setupConfig(
  configPath: string,
  input: { vault?: string; baseUrl: string; tokenEnv?: string },
): Promise<ToolkitConfig> {
  const path = resolve(configPath)
  const envPath = join(dirname(path), ".env")
  await assertNoSymlinks(path, true)
  await assertNoSymlinks(envPath, true)
  for (const candidate of [path, envPath]) {
    try {
      await lstat(candidate)
      throw new Error(`Setup file already exists: ${candidate}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  const vault = expandHome(input.vault ?? "~/school-vault")
  await mkdir(dirname(path), { recursive: true })
  // Check/create the vault before persisting setup files. If a later exclusive
  // write fails, preserve the files for diagnosis rather than unlinking a config
  // another process or the student may already have edited.
  const vaultPath = resolve(dirname(path), vault)
  await assertNoSymlinks(vaultPath, true)
  await mkdir(vaultPath, { recursive: true })
  await assertNoSymlinks(vaultPath)
  const config = await createConfig(path, {
    vault,
    baseUrl: input.baseUrl,
    tokenEnv: input.tokenEnv,
  })
  await writeFile(envPath, `${config.canvas.tokenEnv}=\n`, { flag: "wx", mode: 0o600 })
  return config
}

function expandHome(path: string): string {
  if (path === "~") return process.env.HOME ?? path
  if (path.startsWith("~/")) return join(process.env.HOME ?? "~", path.slice(2))
  return path
}

/** Load simple KEY=value lines without shell evaluation; process.env always wins, even if empty. */
export async function loadAdjacentEnv(configPath: string): Promise<void> {
  const envPath = join(dirname(resolve(configPath)), ".env")
  await assertNoSymlinks(envPath, true)
  try {
    const stat = await lstat(envPath)
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Adjacent .env must be a regular file")
    if (stat.size > 64 * 1024) throw new Error("Adjacent .env file exceeds the 64 KB limit")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  let raw: string
  try {
    raw = await readFile(envPath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw new Error("Cannot read adjacent .env file")
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    const name = match[1]
    if (!name) continue
    if (Object.hasOwn(process.env, name)) continue
    let value = match[2] ?? ""
    // Support basic quoted values while deliberately rejecting shell semantics.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1)
    process.env[name] = value
  }
}

/** Update only the allowlist using a same-directory atomic replacement. */
export async function saveAllowlist(
  configPath: string,
  allowlist: string[],
): Promise<ToolkitConfig> {
  const config = await loadConfig(configPath)
  const path = resolve(configPath)
  await assertNoSymlinks(path)
  const original = await readFile(path, "utf8")
  const raw = JSON.parse(original) as Record<string, unknown>
  const courses = raw.courses as Record<string, unknown>
  const updated = {
    ...raw,
    courses: { ...courses, allowlist: [...new Set(allowlist.map(String))] },
  }
  ConfigSchema.parse(updated)
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(updated, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  try {
    await assertNoSymlinks(path)
    if ((await readFile(path, "utf8")) !== original)
      throw new Error("Config changed during allowlist update; no changes were written")
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
  return { ...config, courses: { allowlist: updated.courses.allowlist as string[] } }
}

function requireRelative(from: string, to: string): string {
  const rel = relative(from, to)
  return isAbsolute(rel) ? to : rel || "."
}
