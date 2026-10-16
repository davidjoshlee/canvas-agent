import { lookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"
import type { ToolkitConfig } from "../shared/types.js"

export type CanvasFetch = (input: string | URL, init?: RequestInit) => Promise<Response>
export type CanvasAddressResolver = (hostname: string) => Promise<string[]>
export type CanvasSleep = (ms: number) => Promise<void>

export interface CanvasClientOptions {
  fetch?: CanvasFetch
  resolveAddresses?: CanvasAddressResolver
  sleep?: CanvasSleep
}

export class CanvasHttpError extends Error {
  constructor(readonly status: number) {
    super(`Canvas GET failed with HTTP ${status}`)
  }
}

export interface CanvasClient {
  get(url: URL): Promise<Response>
  list(url: URL): Promise<Record<string, unknown>[]>
  publicHttpsUrl(value: string | URL): Promise<URL | undefined>
  download(initial: URL): Promise<Response>
}

export type CanvasClientFactory = (config: ToolkitConfig) => CanvasClient

function configuredBase(config: ToolkitConfig): URL {
  const url = new URL(config.canvas.baseUrl)
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Unsafe Canvas base URL")
  return url
}

function authToken(config: ToolkitConfig): string {
  const value = process.env[config.canvas.tokenEnv]
  if (!value)
    throw new Error(`Canvas token environment variable ${config.canvas.tokenEnv} is not set`)
  return value
}

function publicAddress(address: string, blocked: BlockList): boolean {
  const version = isIP(address)
  if (version === 0) return false
  if (version === 6 && address.toLowerCase().startsWith("::ffff:")) return false
  return !blocked.check(address, version === 4 ? "ipv4" : "ipv6")
}

function addressBlockList(): BlockList {
  const blocked = new BlockList()
  for (const subnet of [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.88.99.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "224.0.0.0/4",
    "240.0.0.0/4",
  ])
    blocked.addSubnet(subnet.split("/")[0] ?? "0.0.0.0", Number(subnet.split("/")[1]), "ipv4")
  for (const [subnet, prefix] of [
    ["::", 128],
    ["::", 96],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const)
    blocked.addSubnet(subnet, prefix, "ipv6")
  return blocked
}

export function createCanvasClient(
  config: ToolkitConfig,
  options: CanvasClientOptions = {},
): CanvasClient {
  const root = configuredBase(config)
  const request = options.fetch ?? ((input, init) => fetch(input, init))
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const resolveAddresses =
    options.resolveAddresses ??
    (async (hostname: string) =>
      (await lookup(hostname, { all: true, verbatim: true })).map((result) => result.address))
  const blocked = addressBlockList()

  async function requestWithRetry(url: URL, init: RequestInit): Promise<Response> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await request(url, { ...init, signal: AbortSignal.timeout(15_000) })
        if (response.status !== 429 && response.status < 500) return response
        if (attempt === 2) return response
        const retryAfter = Number(response.headers.get("retry-after"))
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 2000)
            : 100 * 2 ** attempt,
        )
      } catch {
        if (attempt === 2) throw new Error("request failed")
        await sleep(100 * 2 ** attempt)
      }
    }
    throw new Error("request failed")
  }

  async function get(url: URL): Promise<Response> {
    if (
      url.origin !== root.origin ||
      url.protocol !== root.protocol ||
      url.username ||
      url.password
    )
      throw new Error("Canvas pagination or download URL is outside the safe configured origin")
    let response: Response
    const token = authToken(config)
    try {
      response = await requestWithRetry(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "error",
      })
    } catch {
      throw new Error("Canvas GET request failed before receiving a response")
    }
    if (!response.ok) throw new CanvasHttpError(response.status)
    return response
  }

  async function list(url: URL): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = []
    const seen = new Set<string>()
    let current: URL | undefined = url
    while (current) {
      if (seen.has(current.href)) throw new Error("Canvas pagination loop detected")
      seen.add(current.href)
      const response = await get(current)
      let value: unknown
      try {
        value = await response.json()
      } catch {
        throw new Error("Canvas returned an invalid JSON list; no response body was echoed")
      }
      if (!Array.isArray(value)) throw new Error("Canvas returned an unexpected list response")
      items.push(...(value as Record<string, unknown>[]))
      const header = response.headers.get("link")
      let next: URL | undefined
      if (header) {
        for (const part of header.split(/,(?=\s*<)/)) {
          const match = part.match(/<([^>]+)>\s*;\s*rel="?([^";]+)"?/)
          if (match?.[1] && match[2]?.split(/\s+/).includes("next")) {
            next = new URL(match[1], root)
            if (
              next.origin !== root.origin ||
              next.protocol !== root.protocol ||
              next.username ||
              next.password ||
              !next.pathname.startsWith("/api/v1/")
            )
              throw new Error("Canvas pagination link is not a safe same-origin API URL")
            break
          }
        }
      }
      current = next
    }
    return items
  }

  async function publicHttpsUrl(value: string | URL): Promise<URL | undefined> {
    try {
      const url = new URL(value)
      const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        (url.port !== "" && url.port !== "443") ||
        !host ||
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local") ||
        isIP(host) !== 0 ||
        !host.includes(".") ||
        !/^[a-z0-9.-]+$/.test(host) ||
        host.includes("..")
      )
        return
      const addresses = await resolveAddresses(host)
      if (addresses.length === 0 || addresses.some((address) => !publicAddress(address, blocked)))
        return
      return url
    } catch {
      return
    }
  }

  async function download(initial: URL): Promise<Response> {
    let current = initial
    const seen = new Set<string>()
    for (let hop = 0; hop <= 5; hop++) {
      if (seen.has(current.href)) throw new Error("download redirect loop")
      seen.add(current.href)
      const sameOrigin = current.origin === root.origin
      if (sameOrigin && (current.username || current.password))
        throw new Error("unsafe download URL")
      const safe = sameOrigin ? current : await publicHttpsUrl(current)
      if (!safe) throw new Error("unsafe download URL")
      let response: Response
      try {
        response = await requestWithRetry(current, {
          method: "GET",
          headers: sameOrigin
            ? { Authorization: `Bearer ${authToken(config)}`, Accept: "*/*" }
            : { Accept: "*/*" },
          redirect: "manual",
        })
      } catch {
        throw new Error("download request failed")
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location")
        if (!location || hop === 5) throw new Error("download redirect limit exceeded")
        const next = new URL(location, current)
        if (next.origin !== root.origin && !(await publicHttpsUrl(next)))
          throw new Error("unsafe download redirect")
        current = next
        continue
      }
      if (!response.ok)
        throw sameOrigin
          ? new CanvasHttpError(response.status)
          : new Error(`External file download failed with HTTP ${response.status}`)
      return response
    }
    throw new Error("download redirect limit exceeded")
  }

  return { get, list, publicHttpsUrl, download }
}
