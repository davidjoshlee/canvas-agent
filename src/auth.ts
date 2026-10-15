import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { lstat, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { assertNoSymlinks } from "./fs-safety.js"
import type { ToolkitConfig } from "./types.js"

const Metadata = z
  .object({
    version: z.literal(1),
    baseUrl: z.string(),
    tokenEnv: z.string(),
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    account: z.string().min(1).max(200),
    expiresAt: z.string().datetime({ offset: true }),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict()
const digest = (token: string) => createHash("sha256").update(token).digest("hex")

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path)
  await assertNoSymlinks(absolute, true)
  try {
    return await realpath(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    return join(await canonicalPath(parent), basename(absolute))
  }
}
async function paths(configPath: string, config: ToolkitConfig) {
  const metadata = `${resolve(configPath)}.auth.json`,
    env = join(dirname(resolve(configPath)), ".env")
  const vault = await canonicalPath(config.vault.path)
  for (const path of [metadata, env]) {
    const local = relative(vault, await canonicalPath(path))
    if (local === "" || (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`)))
      throw new Error(
        "Auth storage must be outside the vault; move the config outside the vault first",
      )
  }
  return { metadata, env }
}
async function localText(path: string): Promise<string | undefined> {
  await assertNoSymlinks(path, true)
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return undefined
  })
  if (!info) return undefined
  if (!info.isFile() || info.size > 256 * 1024)
    throw new Error("Auth file is unsafe or exceeds its size limit")
  return readFile(path, "utf8")
}
async function replacePrivate(
  path: string,
  before: string | undefined,
  after: string,
): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  await assertNoSymlinks(path, true)
  await writeFile(temp, after, { flag: "wx", mode: 0o600 })
  try {
    if ((await localText(path)) !== before)
      throw new Error("Auth file changed during update; retry after checking it")
    if (before === undefined) {
      await writeFile(path, after, { flag: "wx", mode: 0o600 })
    } else await rename(temp, path)
  } finally {
    await unlink(temp).catch(() => undefined)
  }
}

/** Store only an explicitly provisioned environment token; never accepts a token argument. */
export async function loginAuth(
  configPath: string,
  config: ToolkitConfig,
  options: {
    account?: string
    expiresAt: string
    replace?: boolean
    now?: Date
  },
) {
  const token = process.env[config.canvas.tokenEnv]
  if (!token)
    throw new Error(
      `Set ${config.canvas.tokenEnv} locally before auth login; never paste a token into chat or command arguments`,
    )
  return storeResolvedToken(configPath, config, options, token)
}

type LoginOptions = { account?: string; expiresAt: string; replace?: boolean; now?: Date }
function validateExpiry(options: LoginOptions) {
  const now = options.now ?? new Date()
  const expiry = z.string().datetime({ offset: true }).safeParse(options.expiresAt)
  if (
    !expiry.success ||
    !Number.isFinite(now.valueOf()) ||
    Date.parse(options.expiresAt) <= now.valueOf()
  )
    throw new Error("Confirmed expiry must be a future ISO timestamp with timezone")
  return now
}

async function storeResolvedToken(
  configPath: string,
  config: ToolkitConfig,
  options: LoginOptions,
  token: string,
) {
  const now = validateExpiry(options)
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(token))
    throw new Error("Token cannot be safely stored as a single dotenv value")
  const record = Metadata.parse({
    version: 1,
    baseUrl: config.canvas.baseUrl,
    tokenEnv: config.canvas.tokenEnv,
    tokenHash: digest(token),
    account: options.account ?? "local",
    expiresAt: options.expiresAt,
    recordedAt: now.toISOString(),
  })
  const { env, metadata } = await paths(configPath, config)
  const before = await localText(env),
    priorMetadata = await localText(metadata)
  const lines = (before ?? "").split(/\r?\n/)
  const pattern = new RegExp(`^\\s*${config.canvas.tokenEnv}=(.*)$`)
  const values = lines
    .map((line) => line.match(pattern)?.[1])
    .filter((value): value is string => value !== undefined)
  if (
    !options.replace &&
    values.some(
      (value) =>
        value !== "" && value !== token && value !== `"${token}"` && value !== `'${token}'`,
    )
  )
    throw new Error(
      "An existing saved token would be replaced; use --replace only when intentionally renewing it",
    )
  const retained = lines.filter((line) => !pattern.test(line))
  while (retained.at(-1) === "") retained.pop()
  await replacePrivate(
    env,
    before,
    [...retained, `${config.canvas.tokenEnv}=${token}`, ""].join("\n"),
  )
  try {
    await replacePrivate(metadata, priorMetadata, `${JSON.stringify(record, null, 2)}\n`)
  } catch {
    throw new Error(
      "Token saved locally, but expiry metadata could not be saved; check the auth metadata file and retry auth login",
    )
  }
  // Do not expose tokenHash: this is a renewal hint, not proof of API authorization.
  return {
    stored: true,
    storage: "private-dotenv",
    account: record.account,
    expiresAt: record.expiresAt,
    verified: false,
  }
}

/** Import one explicitly named School account; never enumerate or modify Keychain. */
export async function importSchoolKeychainAuth(
  configPath: string,
  config: ToolkitConfig,
  options: LoginOptions & { account: string },
  runtime: {
    platform?: NodeJS.Platform
    readToken?: (args: string[]) => Promise<string>
  } = {},
) {
  if ((runtime.platform ?? process.platform) !== "darwin")
    throw new Error(
      "School Keychain import is macOS-only; provision a token locally and use auth login on other systems",
    )
  const account = options.account
  if (
    !account ||
    account.length > 200 ||
    account.startsWith("-") ||
    Array.from(account).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("Keychain import requires one explicit safe School account label")
  validateExpiry(options)
  const storage = await paths(configPath, config)
  await localText(storage.env)
  await localText(storage.metadata)
  const readToken =
    runtime.readToken ??
    (async (args: string[]) => {
      const result = await promisify(execFile)("/usr/bin/security", args, {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 256 * 1024,
      })
      return result.stdout
    })
  let token: string
  try {
    token = (
      await readToken(["find-generic-password", "-s", "school-agent-canvas", "-a", account, "-w"])
    ).trim()
  } catch {
    throw new Error(
      "Could not read the selected School Keychain account; inspect access locally or provision a token manually",
    )
  }
  if (!token || token.length > 256 * 1024)
    throw new Error("The selected Keychain account did not return a bounded Canvas token")
  const stored = await storeResolvedToken(configPath, config, options, token)
  return {
    ...stored,
    importedFrom: "school-keychain",
    keychainModified: false,
    shellOverridesImport: Boolean(
      process.env[config.canvas.tokenEnv] && process.env[config.canvas.tokenEnv] !== token,
    ),
    nextSteps:
      "Run auth verify with the same config. Shell variables take precedence over the imported dotenv token; unset a different local shell token before verifying this import.",
  }
}

export async function authStatus(configPath: string, config: ToolkitConfig, now = new Date()) {
  const token = process.env[config.canvas.tokenEnv],
    available = Boolean(token)
  const base = { configured: true, tokenEnv: config.canvas.tokenEnv, available, verified: false }
  const { metadata } = await paths(configPath, config)
  const raw = await localText(metadata)
  if (!raw) return { ...base, renewal: "unrecorded" }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error("Auth expiry metadata is invalid; record it again using auth login")
  }
  const parsed = Metadata.safeParse(data)
  if (!parsed.success)
    throw new Error("Auth expiry metadata is invalid; record it again using auth login")
  const record = parsed.data
  if (
    record.baseUrl !== config.canvas.baseUrl ||
    record.tokenEnv !== config.canvas.tokenEnv ||
    !token ||
    record.tokenHash !== digest(token)
  )
    return {
      ...base,
      renewal: "token-changed",
      notice: "Recorded expiry does not apply to the currently resolved token",
    }
  return {
    ...base,
    account: record.account,
    expiresAt: record.expiresAt,
    ...expiryStatus(record.expiresAt, now),
  }
}

/** Shared expiry classification, also used on credential-free dogfood fixtures. */
export function expiryStatus(expiresAt: string, now = new Date()) {
  if (!Number.isFinite(Date.parse(expiresAt)) || !Number.isFinite(now.valueOf()))
    throw new Error("Expiry classification requires valid dates")
  const daysRemaining = Math.ceil((Date.parse(expiresAt) - now.valueOf()) / 86_400_000)
  return {
    daysRemaining,
    renewal: daysRemaining <= 0 ? "expired" : daysRemaining <= 7 ? "renewal-warning" : "valid",
  }
}

export function renewalInstructions(config: ToolkitConfig) {
  return {
    settingsUrl: new URL("/profile/settings", config.canvas.baseUrl).toString(),
    steps: [
      "Mint a new access token in Canvas Account → Settings; record its confirmed expiry.",
      `Provision ${config.canvas.tokenEnv} locally, not in chat or command arguments.`,
      "Run canvas-agent auth login --expires-at ISO_TIMESTAMP --replace with your explicit config.",
      "Run canvas-agent auth verify with that same config to confirm API authorization.",
    ],
    automaticRenewal: false,
  }
}
