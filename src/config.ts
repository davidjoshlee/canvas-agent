import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
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

function requireRelative(from: string, to: string): string {
  const rel = relative(from, to)
  return isAbsolute(rel) ? to : rel || "."
}
