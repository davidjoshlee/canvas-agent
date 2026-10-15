import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { z } from "zod"
import { readOwnedAlert, saveOwnedAlert } from "./reminders.js"
import type { ToolkitConfig } from "./types.js"

const AuthAlert = z
  .object({
    version: z.literal(1),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    origin: z.string().url(),
    checkedAt: z.string().datetime(),
    reason: z.enum(["http-401", "recorded-expiry", "api-verified", "selected-sync-succeeded"]),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.reason === "recorded-expiry") !== (value.expiresAt !== undefined) ||
      (value.expiresAt && Date.parse(value.expiresAt) > Date.parse(value.checkedAt))
    )
      context.addIssue({ code: "custom", message: "Expiry warning binding is invalid" })
  })
type AlertRecord = z.infer<typeof AuthAlert>
function identity(configPath: string, config: ToolkitConfig) {
  const url = new URL(config.canvas.baseUrl)
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Auth alert origin is unsafe")
  const origin = url.origin
  const scope = createHash("sha256")
    .update(JSON.stringify([resolve(configPath), origin, config.canvas.tokenEnv]))
    .digest("hex")
  return { scope, origin, namespace: `auth-alerts/${scope}` }
}
function renderAuthAlert(record: AlertRecord) {
  const heading =
    record.reason === "http-401"
      ? "Canvas returned HTTP 401"
      : record.reason === "recorded-expiry"
        ? "Recorded expiry warning (local hint only)"
        : "Authentication alert resolved"
  const detail =
    record.reason === "http-401"
      ? "Canvas rejected the credential used by this configuration. Re-authentication is required for that observation."
      : record.reason === "recorded-expiry"
        ? `Local metadata records expiry at ${record.expiresAt}. This is not API verification; a valid current profile response takes precedence.`
        : record.reason === "api-verified"
          ? "The current bounded Canvas profile response was verified."
          : "A selected-course sync succeeded. This is resource-access evidence, not a new profile/identity check or proof of complete coverage."
  return [
    `# ${heading}`,
    "",
    `Observed: ${record.checkedAt}`,
    `Configured Canvas origin: ${record.origin}`,
    "",
    detail,
    "",
    "Renew locally with canvas-agent auth renew, provision the token outside the vault, then run auth login and auth verify with your explicit config. Never paste tokens into chat or upload this private alert.",
    "",
    "This is a config/origin-scoped observation, not verified user identity, current authorization, course permission or historical reconstruction.",
  ].join("\n")
}
export async function readAuthAlert(configPath: string, config: ToolkitConfig) {
  const binding = identity(configPath, config)
  const saved = await readOwnedAlert(config.vault.path, binding.namespace)
  if (!saved) return { status: "no-record" as const }
  const parsed = AuthAlert.safeParse(saved.record)
  if (
    !parsed.success ||
    parsed.data.scope !== binding.scope ||
    parsed.data.origin !== binding.origin ||
    renderAuthAlert(parsed.data) !== saved.text
  )
    throw new Error("Auth alert scope/report binding changed; inspect privately")
  return {
    status:
      parsed.data.reason === "http-401"
        ? ("reauthentication-required" as const)
        : parsed.data.reason === "recorded-expiry"
          ? ("local-expiry-warning" as const)
          : ("resolved" as const),
    reason: parsed.data.reason,
    checkedAt: parsed.data.checkedAt,
    ...(parsed.data.expiresAt ? { expiresAt: parsed.data.expiresAt } : {}),
    alertFile: `_meta/${binding.namespace}/ALERT.md`,
    reportHash: saved.reportHash,
    currentAuthorizationVerified: false as const,
  }
}
export async function writeAuthAlert(
  configPath: string,
  config: ToolkitConfig,
  reason: AlertRecord["reason"],
  options: { expiresAt?: string; now?: Date } = {},
) {
  const binding = identity(configPath, config)
  const existing = await readAuthAlert(configPath, config)
  if (reason === "api-verified" || reason === "selected-sync-succeeded") {
    if (existing.status === "no-record") return existing
  }
  const record = AuthAlert.safeParse({
    version: 1,
    scope: binding.scope,
    origin: binding.origin,
    checkedAt: (options.now ?? new Date()).toISOString(),
    reason,
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
  })
  if (!record.success) throw new Error("Auth alert observation is invalid")
  await saveOwnedAlert(
    config.vault.path,
    binding.namespace,
    record.data,
    renderAuthAlert(record.data),
  )
  return readAuthAlert(configPath, config)
}
