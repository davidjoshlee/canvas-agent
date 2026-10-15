import { access, lstat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { assertNoSymlinks } from "./fs-safety.js"
import { inspectSyncIdentity } from "./sync-identity-inspection.js"
import type { ToolkitConfig, WorkspaceContext } from "./types.js"
import { inspectVaultHistory } from "./vault-history.js"
import { inspectWorkspace } from "./workspace.js"

export type HealthStatus = "ok" | "warning" | "error"
export interface HealthCheck {
  name: string
  status: HealthStatus
  message: string
}

async function historyCheck(vault: string): Promise<HealthCheck> {
  const history = await inspectVaultHistory(vault)
  return {
    name: "vault-history",
    status: ["unsafe", "unavailable"].includes(history.status)
      ? "error"
      : ["locked", "empty"].includes(history.status)
        ? "warning"
        : "ok",
    message: history.message,
  }
}

export async function doctorChecks(
  configPath: string,
  config?: ToolkitConfig,
  options: { syncOnly?: boolean; offline?: boolean } = {},
): Promise<{ ok: boolean; checks: HealthCheck[] }> {
  const checks: HealthCheck[] = []
  if (options.syncOnly && !config) {
    return {
      ok: false,
      checks: [
        { name: "config", status: "error", message: `Config could not be loaded: ${configPath}` },
      ],
    }
  }
  const nodeMajor = Number(process.versions.node.split(".")[0])
  checks.push({
    name: "node",
    status: nodeMajor >= 22 ? "ok" : "error",
    message:
      nodeMajor >= 22 ? `Node.js ${process.versions.node}` : "Node.js 22 or newer is required",
  })
  if (!config) {
    checks.push({
      name: "config",
      status: "error",
      message: `Config could not be loaded: ${configPath}`,
    })
  } else {
    checks.push({ name: "config", status: "ok", message: "Configuration is valid" })
    try {
      await assertNoSymlinks(config.vault.path)
      const stat = await lstat(config.vault.path)
      const safe = stat.isDirectory() && !stat.isSymbolicLink()
      checks.push({
        name: "vault",
        status: safe ? "ok" : "error",
        message: safe ? "Vault directory is available" : "Vault path is not a regular directory",
      })
    } catch {
      checks.push({
        name: "vault",
        status: "error",
        message: "Vault directory is missing or unreadable",
      })
    }
    const tokenAvailable = Boolean(process.env[config.canvas.tokenEnv])
    if (!options.syncOnly) checks.push(await historyCheck(config.vault.path))
    checks.push({
      name: "token-env",
      status: tokenAvailable ? "ok" : options.syncOnly ? "error" : "warning",
      message: tokenAvailable
        ? `Environment variable ${config.canvas.tokenEnv} is set`
        : options.offline
          ? `Environment variable ${config.canvas.tokenEnv} is not set; offline commands remain available`
          : `Environment variable ${config.canvas.tokenEnv} is not set`,
    })
    checks.push({
      name: "allowlist",
      status: config.courses.allowlist.length ? "ok" : "warning",
      message: config.courses.allowlist.length
        ? `${config.courses.allowlist.length} course ID(s) selected`
        : "No courses are selected for sync",
    })
    const identity = await inspectSyncIdentity(
      config.vault.path,
      new URL(config.canvas.baseUrl).origin,
    )
    checks.push({
      name: "vault-sync-origin",
      status:
        identity.origin === "invalid" || identity.origin === "mismatched"
          ? "error"
          : identity.origin === "matched"
            ? "ok"
            : "warning",
      message:
        identity.origin === "matched"
          ? "Stored sync server matches the configured origin; this is not account authentication"
          : identity.origin === "mismatched"
            ? "Configured Canvas server conflicts with stored vault ownership; use a separate vault"
            : identity.origin === "invalid"
              ? "Stored sync server binding is unsafe, malformed or unreadable; inspect it without deleting ownership metadata"
              : "No bound sync server evidence; a first binding cannot authenticate historical cached feedback",
    })
    checks.push({
      name: "vault-sync-account",
      status:
        identity.account === "invalid" || identity.account === "mismatched" ? "error" : "warning",
      message:
        identity.account === "reserved"
          ? "A private API-subject reservation exists; today's account is not verified offline. Sync verifies it before course access"
          : identity.account === "mismatched"
            ? "Stored account reservation belongs to a different Canvas server; use a separate vault"
            : identity.account === "invalid"
              ? "Stored account binding is unsafe, exposed, malformed or unreadable; stop and inspect it"
              : "No account reservation exists; first binding does not certify historical cache ownership",
    })
  }
  const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/cli.js")
  let compiled = false
  try {
    await access(cliPath)
    compiled = true
  } catch {
    // Source-mode development is still useful; report compiled distribution readiness.
  }
  checks.push({
    name: "compiled-cli",
    status: compiled ? "ok" : "warning",
    message: compiled
      ? "Compiled CLI is present"
      : "Compiled CLI is not present; run npm run build",
  })
  return { ok: checks.every((check) => check.status !== "error"), checks }
}

export async function inspectVaultHealth(
  vault: string,
  allowlist: string[] = [],
): Promise<{ ok: boolean; checks: HealthCheck[] }> {
  const checks: HealthCheck[] = []
  let context: WorkspaceContext
  try {
    context = await inspectWorkspace(vault)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Vault could not be inspected"
    return { ok: false, checks: [{ name: "workspace", status: "error", message }] }
  }
  checks.push({
    name: "workspace",
    status: "ok",
    message: `${context.courses.length} course folder(s) scanned read-only`,
  })
  checks.push(await historyCheck(vault))
  const presentIds = new Set(
    context.courses.flatMap((course) => (course.canvasId ? [course.canvasId] : [])),
  )
  for (const id of allowlist)
    if (!presentIds.has(id))
      checks.push({
        name: "missing-course",
        status: "warning",
        message: `Allowlisted course ${id} has no mapped local folder`,
      })
  for (const notice of context.notices.filter(
    (item) => !/_meta|private metadata directory/i.test(item),
  )) {
    const link = /symbolic link/i.test(notice)
    checks.push({
      name: link ? "symlink" : "workspace-notice",
      status: "warning",
      message: notice,
    })
  }
  for (const course of context.courses) {
    const weeks = new Map<string, string[]>()
    for (const period of course.periods ?? []) {
      const rawKey = period.match(/Week (\d+)/i)?.[1]
      const key = rawKey === undefined ? undefined : String(Number(rawKey))
      if (key && Number.isSafeInteger(Number(key)))
        weeks.set(key, [...(weeks.get(key) ?? []), period])
    }
    for (const matches of weeks.values())
      if (matches.length > 1)
        checks.push({
          name: "duplicate-week",
          status: "warning",
          message: `${course.code} has multiple folders for week ${String(Number(matches[0]?.match(/Week (\d+)/i)?.[1]))}`,
        })
    const known = new Set(course.sources.map((source) => source.path))
    for (const source of course.sources) {
      for (const relation of source.relatedPaths ?? []) {
        const normalized = relation.startsWith(`${course.root}/`)
          ? relation
          : `${course.root}/${relation}`
        if (!known.has(normalized))
          checks.push({
            name: "missing-relation",
            status: "warning",
            message: `${source.path} references a missing source: ${relation}`,
          })
      }
    }
    for (const excluded of course.excluded)
      if (/symbolic link/i.test(excluded.reason))
        checks.push({
          name: "symlink",
          status: "warning",
          message: `Skipped linked source: ${excluded.path}`,
        })
      else if (
        /extraction sidecar is stale|extraction original is missing or unsafe/i.test(
          excluded.reason,
        )
      )
        checks.push({
          name: "stale-extraction",
          status: "warning",
          message: `Extraction needs refreshing: ${excluded.path}`,
        })
  }
  const errors = checks.some((check) => check.status === "error")
  return { ok: !errors, checks }
}
