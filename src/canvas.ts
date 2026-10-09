import { createHash, randomUUID } from "node:crypto"
import { lookup } from "node:dns/promises"
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { BlockList, isIP } from "node:net"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { extractText } from "./content.js"
import { assertNoSymlinks } from "./fs-safety.js"
import type { ToolkitConfig } from "./types.js"

type Obj = Record<string, unknown>
const fetcher = (input: string | URL, init?: RequestInit) => fetch(input, init)
let request = fetcher
let sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms))
type AddressResolver = (hostname: string) => Promise<string[]>
const systemResolve: AddressResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((result) => result.address)
let resolveAddresses = systemResolve
export function setCanvasDnsForTests(resolver?: AddressResolver): void {
  resolveAddresses = resolver ?? systemResolve
}
export function setCanvasFetchForTests(
  fn?: typeof fetcher,
  sleepForTests?: (ms: number) => Promise<void>,
): void {
  request = fn ?? fetcher
  sleep =
    sleepForTests ?? ((ms) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)))
}
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

function base(config: ToolkitConfig): URL {
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
function token(config: ToolkitConfig): string {
  const value = process.env[config.canvas.tokenEnv]
  if (!value)
    throw new Error(`Canvas token environment variable ${config.canvas.tokenEnv} is not set`)
  return value
}
function apiUrl(root: URL, path: string): URL {
  return new URL(`/api/v1/${path.replace(/^\//, "")}`, root)
}
class CanvasHttpError extends Error {
  constructor(readonly status: number) {
    super(`Canvas GET failed with HTTP ${status}`)
  }
}
function unavailable(error: unknown): error is CanvasHttpError {
  return error instanceof CanvasHttpError && [403, 404].includes(error.status)
}
function requireValidAuth(error: unknown): void {
  if (error instanceof CanvasHttpError && error.status === 401) throw error
}
async function get(config: ToolkitConfig, url: URL): Promise<Response> {
  const root = base(config)
  if (url.origin !== root.origin || url.protocol !== root.protocol || url.username || url.password)
    throw new Error("Canvas pagination or download URL is outside the safe configured origin")
  const authToken = token(config)
  let response: Response
  try {
    response = await requestWithRetry(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${authToken}`, Accept: "application/json" },
      redirect: "error",
    })
  } catch {
    throw new Error("Canvas GET request failed before receiving a response")
  }
  if (!response.ok) throw new CanvasHttpError(response.status)
  return response
}
function paginationLink(header: string | null, root: URL): URL | undefined {
  if (!header) return
  for (const part of header.split(/,(?=\s*<)/)) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?([^";]+)"?/)
    if (match?.[1] && match[2]?.split(/\s+/).includes("next")) {
      const next = new URL(match[1], root)
      if (
        next.origin !== root.origin ||
        next.protocol !== root.protocol ||
        next.username ||
        next.password ||
        !next.pathname.startsWith("/api/v1/")
      )
        throw new Error("Canvas pagination link is not a safe same-origin API URL")
      return next
    }
  }
}
async function list(config: ToolkitConfig, url: URL): Promise<Obj[]> {
  const items: Obj[] = []
  const seen = new Set<string>()
  let current: URL | undefined = url
  while (current) {
    if (seen.has(current.href)) throw new Error("Canvas pagination loop detected")
    seen.add(current.href)
    const response = await get(config, current)
    const value: unknown = await response.json()
    if (!Array.isArray(value)) throw new Error("Canvas returned an unexpected list response")
    items.push(...(value as Obj[]))
    const next = paginationLink(response.headers.get("link"), base(config))
    if (!next) break
    current = next
  }
  return items
}
export async function listCourses(
  config: ToolkitConfig,
): Promise<Array<{ id: string; code: string; name: string }>> {
  const root = base(config)
  const rows = await list(config, apiUrl(root, "courses?per_page=100&include[]=term"))
  return [
    ...new Map(
      rows.map((c) => [
        String(c.id),
        {
          id: String(c.id),
          code: String(c.course_code ?? c.id),
          name: String(c.name ?? c.course_code ?? c.id),
        },
      ]),
    ).values(),
  ]
}

/** Validate the configured token without returning identity or profile data. */
export async function verifyAuth(config: ToolkitConfig): Promise<{ ok: true }> {
  await get(config, apiUrl(base(config), "users/self"))
  return { ok: true }
}

/** Return only active courses for onboarding; listCourses remains the discovery API. */
export async function listActiveCourses(
  config: ToolkitConfig,
): Promise<Array<{ id: string; code: string; name: string }>> {
  const rows = await list(
    config,
    apiUrl(base(config), "users/self/courses?enrollment_state=active&per_page=100&include[]=term"),
  )
  return [
    ...new Map(
      rows
        .filter((c) => c.workflow_state == null || c.workflow_state === "available")
        .map((c) => [
          String(c.id),
          {
            id: String(c.id),
            code: String(c.course_code ?? c.id),
            name: String(c.name ?? c.course_code ?? c.id),
          },
        ]),
    ).values(),
  ]
}

const safeSegment = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "untitled"
function canonicalRoot(code: string): string {
  const termCode = code.match(/^[A-Z]\d{2}-([A-Z]{2,12})-(\d{2,4}[A-Z]?)$/i)
  if (termCode) return `${termCode[1]}${termCode[2]}`.toUpperCase()
  const conventional = code.match(/^([A-Z]{2,12})[-_ ]?(\d{2,4}[A-Z]?)$/i)
  if (conventional) return `${conventional[1]}${conventional[2]}`.toUpperCase()
  return safeSegment(code).replace(/[-_ ]/g, "").toUpperCase()
}
function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}
type SyncState = { version: 1; files: Record<string, string> }
type Managed = {
  vault: string
  state: SyncState
  trusted: boolean
  stateHash?: string
  written: string[]
  notices: string[]
}
function relativeVault(vault: string, path: string): string {
  const value = relative(vault, path).split(sep).join("/")
  if (!value || value === ".." || value.startsWith("../") || isAbsolute(value))
    throw new Error("Canvas output path escapes the vault")
  return value
}
async function safeMkdir(_vault: string, path: string): Promise<void> {
  await assertNoSymlinks(path, true)
  await mkdir(path, { recursive: true })
  await assertNoSymlinks(path)
}
async function managedWrite(
  manager: Managed,
  path: string,
  bytes: Buffer | string,
): Promise<boolean> {
  const key = relativeVault(manager.vault, path)
  await assertNoSymlinks(path, true)
  await safeMkdir(manager.vault, dirname(path))
  let current: Buffer | undefined
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Canvas output is not a regular file: ${key}`)
    current = await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (current && sha(current) === sha(bytes)) return false
  if (current && (!manager.trusted || manager.state.files[key] !== sha(current))) {
    manager.notices.push(
      `Preserved changed or untracked file ${key}; Canvas updates were not applied.`,
    )
    return false
  }
  await assertNoSymlinks(path, true)
  if (!current) {
    try {
      await writeFile(path, bytes, { flag: "wx" })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        manager.notices.push(`Preserved concurrently created file ${key}.`)
        return false
      }
      throw error
    }
  } else {
    const tempPath = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(tempPath, bytes, { flag: "wx" })
      await assertNoSymlinks(path)
      if (sha(await readFile(path)) !== manager.state.files[key]) {
        manager.notices.push(`Preserved concurrently edited file ${key}.`)
        return false
      }
      await rename(tempPath, path)
    } finally {
      try {
        await unlink(tempPath)
      } catch {
        /* renamed or absent */
      }
    }
  }
  manager.state.files[key] = sha(bytes)
  manager.written.push(path)
  return true
}
async function loadSyncState(
  vault: string,
  notices: string[],
): Promise<{ state: SyncState; trusted: boolean; stateHash?: string }> {
  const path = join(vault, "_meta", "canvas-sync-state.json")
  await assertNoSymlinks(path, true)
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Sync state is not a regular file")
    const raw = await readFile(path, "utf8"),
      parsed = JSON.parse(raw)
    if (
      parsed.version !== 1 ||
      !parsed.files ||
      typeof parsed.files !== "object" ||
      Array.isArray(parsed.files)
    )
      throw new Error("Sync state has an unsupported format")
    return { state: { version: 1, files: parsed.files }, trusted: true, stateHash: sha(raw) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      notices.push("Canvas sync state could not be trusted; existing files will be preserved.")
    return {
      state: { version: 1, files: {} },
      trusted: (error as NodeJS.ErrnoException).code === "ENOENT",
    }
  }
}
async function saveSyncState(manager: Managed): Promise<void> {
  if (!manager.trusted) return
  const path = join(manager.vault, "_meta", "canvas-sync-state.json")
  await safeMkdir(manager.vault, dirname(path))
  await assertNoSymlinks(path, true)
  const bytes = `${JSON.stringify(manager.state, null, 2)}\n`
  try {
    const current = await readFile(path)
    if (!manager.stateHash || sha(current) !== manager.stateHash) {
      manager.notices.push(
        "Preserved changed Canvas sync state; concurrent or manual changes were not overwritten.",
      )
      return
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || manager.stateHash) {
      manager.notices.push(
        "Preserved changed Canvas sync state; concurrent or manual changes were not overwritten.",
      )
      return
    }
  }
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, bytes, { flag: "wx" })
  try {
    await assertNoSymlinks(path, true)
    try {
      const current = await readFile(path)
      if (!manager.stateHash || sha(current) !== manager.stateHash) {
        manager.notices.push(
          "Preserved changed Canvas sync state; concurrent or manual changes were not overwritten.",
        )
        return
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || manager.stateHash) {
        manager.notices.push(
          "Preserved changed Canvas sync state; concurrent or manual changes were not overwritten.",
        )
        return
      }
    }
    await rename(tempPath, path)
    manager.stateHash = sha(bytes)
  } finally {
    try {
      await unlink(tempPath)
    } catch {
      /* renamed or absent */
    }
  }
}
function cleanHtml(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
function textOf(html: unknown): string {
  return cleanHtml(typeof html === "string" ? html : "")
}
function markdown(
  title: string,
  source: Obj,
  body: string,
  fields: Record<string, unknown> = {},
): string {
  const dateFields = Object.fromEntries(
    Object.entries(fields).filter(
      ([key, value]) =>
        [
          "due_at",
          "unlock_at",
          "lock_at",
          "start_at",
          "end_at",
          "created_at",
          "updated_at",
        ].includes(key) &&
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T/.test(value),
    ),
  )
  if (Object.keys(dateFields).length && !fields.dates) fields = { ...fields, dates: dateFields }
  const front = {
    title,
    canvas_id: String(source.id ?? ""),
    canvas_url: typeof source.html_url === "string" ? source.html_url : "",
    ...fields,
  }
  const yaml = Object.entries(front)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n")
  return `---\n${yaml}\n---\n\n# ${title}\n\n${body || "(No text content.)"}\n`
}
function linkedFileIds(html: unknown): string[] {
  if (typeof html !== "string") return []
  const ids = new Set<string>()
  for (const match of html.matchAll(/(?:\/files\/|files%2[fF])([0-9]+)(?=\/|\?|&|#|["'\s]|$)/g))
    if (match[1]) ids.add(match[1])
  return [...ids]
}
const blockedAddressRanges = new BlockList()
for (const subnet of [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
])
  blockedAddressRanges.addSubnet(
    subnet.split("/")[0] ?? "0.0.0.0",
    Number(subnet.split("/")[1]),
    "ipv4",
  )
for (const [subnet, prefix] of [
  ["::", 128],
  ["::", 96],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blockedAddressRanges.addSubnet(subnet, prefix, "ipv6")

function isPublicAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 0) return false
  if (version === 6 && address.toLowerCase().startsWith("::ffff:")) return false
  return !blockedAddressRanges.check(address, version === 4 ? "ipv4" : "ipv6")
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
    if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) return
    return url
  } catch {
    return
  }
}
async function download(config: ToolkitConfig, initial: URL): Promise<Response> {
  const root = base(config)
  let current = initial
  const seen = new Set<string>()
  for (let hop = 0; hop <= 5; hop++) {
    if (seen.has(current.href)) throw new Error("download redirect loop")
    seen.add(current.href)
    const sameOrigin = current.origin === root.origin
    const safe = sameOrigin ? current : await publicHttpsUrl(current)
    if (!safe) throw new Error("unsafe download URL")
    let response: Response
    try {
      response = await requestWithRetry(current, {
        method: "GET",
        headers: sameOrigin
          ? { Authorization: `Bearer ${token(config)}`, Accept: "*/*" }
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
async function syncOne(
  config: ToolkitConfig,
  course: { id: string; code: string; name: string; root: string },
  manager: Managed,
): Promise<void> {
  const vault = manager.vault,
    courseRoot = resolve(vault, course.root)
  if (!courseRoot.startsWith(vault + sep)) throw new Error("Course code resolves outside the vault")
  await safeMkdir(vault, courseRoot)
  const root = base(config),
    prefix = `courses/${encodeURIComponent(course.id)}`
  const courseInfo = (await (
    await get(
      config,
      apiUrl(root, `courses/${encodeURIComponent(course.id)}?include[]=syllabus_body`),
    )
  ).json()) as Obj
  const metadataPath = join(courseRoot, "00 Home.md")
  const metadata = markdown(
    course.name,
    courseInfo,
    [
      `Canvas course ID: ${course.id}`,
      `Course code: ${course.code}`,
      courseInfo.start_at ? `Starts: ${courseInfo.start_at}` : "",
      courseInfo.end_at ? `Ends: ${courseInfo.end_at}` : "",
      courseInfo.time_zone ? `Time zone: ${courseInfo.time_zone}` : "",
      courseInfo.public_description ? textOf(courseInfo.public_description) : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    Object.fromEntries(
      ["start_at", "end_at"].filter((k) => courseInfo[k]).map((k) => [k, courseInfo[k]]),
    ),
  )
  await managedWrite(manager, metadataPath, metadata)
  const syllabusIds = linkedFileIds(courseInfo.syllabus_body)
  if (courseInfo.syllabus_body)
    await managedWrite(
      manager,
      join(courseRoot, "Resources", "Syllabus.md"),
      markdown("Syllabus", courseInfo, textOf(courseInfo.syllabus_body), {
        raw_html_file_ids: syllabusIds,
      }),
    )
  const contentPaths = new Map<string, string>()
  const referencedFileIds = new Set(syllabusIds)
  const sourceReferences: Array<{ path: string; ids: string[] }> = []
  const optionalList = async (endpoint: string, label: string): Promise<Obj[]> => {
    try {
      return await list(config, apiUrl(root, `${prefix}/${endpoint}`))
    } catch (error) {
      if (!unavailable(error)) throw error
      manager.notices.push(
        `Canvas ${label} unavailable for ${course.code} (HTTP ${error.status}); continuing with accessible module-linked content. Coverage may be incomplete.`,
      )
      return []
    }
  }
  const simple = async (
    endpoint: string,
    folder: string,
    getTitle: (v: Obj) => string,
    getText: (v: Obj) => string,
    supplied?: Obj[],
  ) => {
    const values =
      supplied ??
      (endpoint === "pages"
        ? await optionalList("pages?per_page=100", "Pages list")
        : await list(config, apiUrl(root, `${prefix}/${endpoint}?per_page=100`)))
    for (const value of values) {
      let source = value
      if (endpoint === "pages" && typeof value.body !== "string" && typeof value.url === "string") {
        try {
          source = (await (
            await get(config, apiUrl(root, `${prefix}/pages/${encodeURIComponent(value.url)}`))
          ).json()) as Obj
        } catch (error) {
          if (!unavailable(error)) throw error
          manager.notices.push(
            `Canvas page unavailable for ${course.code} (HTTP ${error.status}); coverage may be incomplete.`,
          )
          continue
        }
      }
      const title = getTitle(source),
        identity = endpoint === "pages" ? (source.page_id ?? source.id) : source.id,
        path = join(
          courseRoot,
          "Canvas",
          folder,
          `${safeSegment(title)}-${safeSegment(String(identity ?? "item"))}.md`,
        )
      const fields: Record<string, unknown> = {}
      const rawHtml = endpoint === "pages" ? source.body : source.description
      const fileIds = linkedFileIds(rawHtml)
      for (const fileId of fileIds) referencedFileIds.add(fileId)
      if (fileIds.length) sourceReferences.push({ path, ids: fileIds })
      if (endpoint === "pages") {
        const pageUrl = typeof value.url === "string" ? value.url : source.url
        if (typeof pageUrl === "string")
          contentPaths.set(`pages:url:${pageUrl}`, relativeVault(vault, path))
        if (identity != null)
          contentPaths.set(`pages:${String(identity)}`, relativeVault(vault, path))
      } else if (identity != null)
        contentPaths.set(`${endpoint}:${String(identity)}`, relativeVault(vault, path))
      for (const key of [
        "due_at",
        "unlock_at",
        "lock_at",
        "start_at",
        "end_at",
        "created_at",
        "updated_at",
      ])
        if (source[key]) fields[key] = source[key]
      await managedWrite(manager, path, markdown(title, source, getText(source), fields))
    }
  }
  await simple(
    "assignments",
    "Assignments",
    (v) => String(v.name ?? `Assignment ${v.id}`),
    (v) =>
      [
        v.description && textOf(v.description),
        v.due_at ? `Due: ${v.due_at}` : "",
        v.points_possible != null ? `Points: ${v.points_possible}` : "",
        Array.isArray(v.attachments) && v.attachments.length
          ? `Attachments: ${v.attachments
              .map((attachment: Obj) =>
                String(attachment.display_name ?? attachment.filename ?? "Canvas attachment"),
              )
              .join(", ")}`
          : "",
        Array.isArray(v.rubric) && v.rubric.length
          ? `Rubric:\n${v.rubric
              .map((criterion: Obj) => textOf(criterion.long_description ?? criterion.description))
              .filter(Boolean)
              .join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
  )
  await simple(
    "pages",
    "Pages",
    (v) => String(v.title ?? v.url ?? `Page ${v.id}`),
    (v) => textOf(v.body),
  )
  const modules = await optionalList("modules?include[]=items&per_page=100", "Modules list")
  const modulePages = new Set<string>()
  for (const module of modules) {
    if (!Array.isArray(module.items) && module.id != null)
      module.items = await optionalList(
        `modules/${encodeURIComponent(String(module.id))}/items?per_page=100`,
        "module items",
      )
    for (const item of Array.isArray(module.items) ? (module.items as Obj[]) : []) {
      if (item.type === "File" && item.content_id != null)
        referencedFileIds.add(String(item.content_id))
      if (
        item.type === "Page" &&
        typeof item.page_url === "string" &&
        !contentPaths.has(`pages:url:${item.page_url}`)
      )
        modulePages.add(item.page_url)
    }
  }
  await simple(
    "pages",
    "Pages",
    (v) => String(v.title ?? v.url ?? `Page ${v.id}`),
    (v) => textOf(v.body),
    [...modulePages].map((url) => ({ url })),
  )
  const files = await optionalList("files?per_page=100", "Files list")
  const knownFileIds = new Set(files.map((file) => String(file.id)))
  for (const fileId of referencedFileIds) {
    if (knownFileIds.has(fileId)) continue
    try {
      const response = await get(config, apiUrl(root, `files/${encodeURIComponent(fileId)}`))
      const metadata = (await response.json()) as Obj
      if (String(metadata.id) === fileId) files.push(metadata)
    } catch (error) {
      requireValidAuth(error)
      manager.notices.push(
        `Could not retrieve metadata for linked Canvas file ${fileId} in ${course.code}.`,
      )
    }
  }
  for (const file of files) {
    const filename = String(file.filename ?? file.display_name ?? `file-${file.id}`)
    const id = safeSegment(String(file.id ?? "file"))
    const target = join(courseRoot, "Canvas", "Files", `${id}-${safeSegment(filename)}`)
    if (file.locked || file.hidden || !file.url) {
      manager.notices.push(`Skipped inaccessible Canvas file ${filename} in ${course.code}.`)
      continue
    }
    const url = typeof file.url === "string" ? new URL(file.url, root) : undefined
    if (!url || (url.origin !== root.origin && !(await publicHttpsUrl(url)))) {
      manager.notices.push(`Skipped external or unsafe Canvas file ${filename} in ${course.code}.`)
      continue
    }
    try {
      const response = await download(config, url)
      const bytes = await readBounded(response, 50 * 1024 * 1024)
      if (!bytes) {
        manager.notices.push(`Skipped Canvas file over 50 MB: ${filename}.`)
        continue
      }
      await managedWrite(manager, target, bytes)
      const extracted = await extractText({
        bytes,
        filename,
        contentType: typeof file.content_type === "string" ? file.content_type : null,
      })
      if (extracted.notice)
        manager.notices.push(`Could not extract ${filename}: ${extracted.notice}.`)
      if (extracted.text) {
        const retained = await readFile(target).catch(() => undefined)
        if (retained && sha(retained) === sha(bytes)) {
          const sidecar = `${target}.extracted.md`
          const content = markdown(filename, file, extracted.text, {
            original_path: relativeVault(vault, target),
            original_hash: sha(bytes),
          })
          await managedWrite(manager, sidecar, content)
          if (file.id != null)
            contentPaths.set(`files:${String(file.id)}`, relativeVault(vault, sidecar))
        }
      }
    } catch (error) {
      requireValidAuth(error)
      manager.notices.push(`Could not download Canvas file ${filename} in ${course.code}.`)
    }
  }
  if (syllabusIds.length)
    sourceReferences.push({ path: join(courseRoot, "Resources", "Syllabus.md"), ids: syllabusIds })
  for (const ref of sourceReferences) {
    const paths = ref.ids
      .map((id) => contentPaths.get(`files:${id}`))
      .filter((p): p is string => Boolean(p))
    for (const id of ref.ids)
      if (!contentPaths.has(`files:${id}`))
        manager.notices.push(
          `Linked Canvas file ${id} has no extracted text source in ${course.code}.`,
        )
    if (!paths.length) continue
    const source = await readFile(ref.path, "utf8").catch(() => "")
    if (!source.startsWith("---\n")) continue
    const end = source.indexOf("\n---\n", 4)
    if (end < 0) continue
    const front = source.slice(4, end)
    const updated =
      front.replace(/\nrelated_paths:.*(?=\n|$)/, "") +
      `\nrelated_paths: ${JSON.stringify([...new Set(paths)])}`
    await managedWrite(manager, ref.path, `---\n${updated}\n---${source.slice(end + 4)}`)
  }
  for (const value of modules) {
    const title = String(value.name ?? `Module ${value.id}`)
    const relatedPaths: string[] = []
    const items = Array.isArray(value.items)
      ? value.items
          .map((i: Obj) => {
            const type =
              i.type === "Assignment"
                ? "assignments"
                : i.type === "Page"
                  ? "pages"
                  : i.type === "File"
                    ? "files"
                    : ""
            const related =
              i.type === "Page" && typeof i.page_url === "string"
                ? contentPaths.get(`pages:url:${i.page_url}`)
                : type && i.content_id != null
                  ? contentPaths.get(`${type}:${String(i.content_id)}`)
                  : undefined
            if (related) relatedPaths.push(related)
            return `- ${String(i.title ?? i.type ?? "Item")}${related ? ` (${related})` : i.html_url ? ` (${i.html_url})` : ""}`
          })
          .join("\n")
      : ""
    const path = join(
      courseRoot,
      "Canvas",
      "Modules",
      `${safeSegment(title)}-${safeSegment(String(value.id ?? "item"))}.md`,
    )
    await managedWrite(
      manager,
      path,
      markdown(title, value, items, {
        ...(relatedPaths.length ? { related_paths: [...new Set(relatedPaths)] } : {}),
        ...Object.fromEntries(
          ["unlock_at", "start_at", "end_at", "created_at", "updated_at"]
            .filter((k) => value[k])
            .map((k) => [k, value[k]]),
        ),
      }),
    )
  }
  try {
    const topics = await list(config, apiUrl(root, `${prefix}/discussion_topics?per_page=100`))
    for (const topic of topics) {
      const title = String(topic.title ?? `Discussion ${topic.id}`)
      const path = join(
        courseRoot,
        "Canvas",
        "Discussions",
        `${safeSegment(title)}-${safeSegment(String(topic.id ?? "item"))}.md`,
      )
      await managedWrite(
        manager,
        path,
        markdown(title, topic, textOf(topic.message), {
          ...Object.fromEntries(
            ["due_at", "unlock_at", "lock_at", "posted_at"]
              .filter((key) => topic[key])
              .map((key) => [key, topic[key]]),
          ),
        }),
      )
    }
  } catch (error) {
    requireValidAuth(error)
    manager.notices.push(
      `Canvas discussion topics were unavailable for ${course.code}; continuing without them.`,
    )
  }
  try {
    const announcements = await list(
      config,
      apiUrl(root, `${prefix}/discussion_topics?only_announcements=true&per_page=100`),
    )
    for (const announcement of announcements) {
      const title = String(announcement.title ?? `Announcement ${announcement.id}`)
      const path = join(
        courseRoot,
        "Canvas",
        "Announcements",
        `${safeSegment(title)}-${safeSegment(String(announcement.id ?? "item"))}.md`,
      )
      await managedWrite(
        manager,
        path,
        markdown(title, announcement, textOf(announcement.message), {
          ...Object.fromEntries(
            ["posted_at", "delayed_post_at", "lock_at"]
              .filter((key) => announcement[key])
              .map((key) => [key, announcement[key]]),
          ),
        }),
      )
    }
  } catch (error) {
    requireValidAuth(error)
    manager.notices.push(
      `Canvas announcements were unavailable for ${course.code}; continuing without them.`,
    )
  }
}
async function readBounded(response: Response, maxBytes: number): Promise<Buffer | undefined> {
  if (
    response.headers.get("content-length") &&
    Number(response.headers.get("content-length")) > maxBytes
  )
    return
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maxBytes) {
      await reader.cancel()
      return
    }
    chunks.push(value)
  }
  return Buffer.concat(
    chunks.map((c) => Buffer.from(c)),
    length,
  )
}

export async function syncCourses(
  config: ToolkitConfig,
): Promise<{ courses: number; written: string[]; notices: string[] }> {
  if (!config.courses.allowlist.length)
    return {
      courses: 0,
      written: [],
      notices: ["Canvas course allowlist is empty; nothing was synced."],
    }
  const all = await list(config, apiUrl(base(config), "courses?per_page=100&include[]=term"))
  const allow = new Set(config.courses.allowlist.map(String))
  const courses = all
    .filter((c) => allow.has(String(c.id)))
    .map((c) => ({
      id: String(c.id),
      code: String(c.course_code ?? c.id),
      name: String(c.name ?? c.course_code ?? c.id),
    }))
  const written: string[] = [],
    notices: string[] = []
  const vault = resolve(config.vault.path)
  const manifestPath = join(vault, "_meta", "canvas-courses.json")
  await assertNoSymlinks(vault, true)
  await assertNoSymlinks(manifestPath, true)
  let previous: { version: number; courses: Obj[] } = { version: 1, courses: [] }
  try {
    const info = await lstat(manifestPath)
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Canvas course manifest is not a regular file")
    previous = JSON.parse(await readFile(manifestPath, "utf8")) as {
      version: number
      courses: Obj[]
    }
    if (previous.version !== 1 || !Array.isArray(previous.courses))
      throw new Error("Canvas course manifest has an unsupported format")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      notices.push("Canvas course manifest could not be parsed; preserving it.")
      previous = { version: 1, courses: [] }
    }
  }
  const prior = new Map<string, Obj>(previous.courses.map((c: Obj) => [String(c.id), c]))
  const merged: Obj[] = []
  for (const course of courses) {
    const old = prior.get(course.id)
    let root =
      typeof old?.root === "string" && old.root === safeSegment(old.root)
        ? old.root
        : canonicalRoot(course.code)
    if (!old?.root) {
      const rawRoot = safeSegment(course.code)
      if (
        rawRoot !== root &&
        !rawRoot.startsWith(".") &&
        !rawRoot.startsWith("_") &&
        !rawRoot.includes("/") &&
        !rawRoot.includes("\\")
      ) {
        try {
          const canonicalInfo = await lstat(join(vault, root)).catch(() => null)
          const rawInfo = await lstat(join(vault, rawRoot)).catch(() => null)
          if (!canonicalInfo?.isDirectory() && rawInfo?.isDirectory() && !rawInfo.isSymbolicLink())
            root = rawRoot
        } catch {
          /* path validation below reports unsafe roots */
        }
      }
    }
    merged.push({ ...old, ...course, root })
  }
  const roots = merged.map((c) => String(c.root))
  if (new Set(roots.map((r) => r.toLocaleLowerCase())).size !== roots.length)
    throw new Error("Canvas course-root collision; sync stopped before writing")
  for (const course of merged) {
    if (
      previous.courses.some(
        (old: Obj) =>
          String(old.id) !== String(course.id) &&
          String(old.root ?? canonicalRoot(String(old.code ?? ""))).toLocaleLowerCase() ===
            String(course.root).toLocaleLowerCase(),
      )
    ) {
      throw new Error(
        "Canvas course-root collision with an existing mapping; choose a separate term vault",
      )
    }
  }
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index] ?? ""
    const raw = courses.find((c) => c.id === String(merged[index]?.id))?.code ?? root
    if (
      !root ||
      raw.startsWith(".") ||
      raw.startsWith("_") ||
      root.toLocaleLowerCase() === "_meta" ||
      root.startsWith(".") ||
      root.includes("/") ||
      root.includes("\\") ||
      root === "." ||
      root === ".."
    )
      throw new Error(`Reserved or unsafe Canvas course root: ${root}`)
    if (resolve(vault, root) === vault || !resolve(vault, root).startsWith(vault + sep))
      throw new Error(`Canvas course root escapes the vault: ${root}`)
    await assertNoSymlinks(join(vault, root), true)
  }
  const stateResult = await loadSyncState(vault, notices)
  const manager: Managed = {
    vault,
    state: stateResult.state,
    trusted: stateResult.trusted,
    stateHash: stateResult.stateHash,
    written,
    notices,
  }
  // The course manifest is toolkit-owned metadata. A valid pre-existing manifest is merged by Canvas ID.
  if (previous.courses.length && !manager.state.files[relativeVault(vault, manifestPath)]) {
    try {
      manager.state.files[relativeVault(vault, manifestPath)] = sha(await readFile(manifestPath))
    } catch {
      /* new manifest */
    }
  }
  const manifestCourses = new Map<string, Obj>(previous.courses.map((c: Obj) => [String(c.id), c]))
  for (const course of merged) manifestCourses.set(String(course.id), course)
  const manifest = `${JSON.stringify({ version: 1, courses: [...manifestCourses.values()] }, null, 2)}\n`
  await managedWrite(manager, manifestPath, manifest)
  try {
    for (const course of merged)
      await syncOne(
        config,
        course as { id: string; code: string; name: string; root: string },
        manager,
      )
  } finally {
    // Preserve ownership evidence even if a later endpoint fails mid-sync.
    await saveSyncState(manager)
  }
  if (!courses.length) notices.push("No allowlisted courses were returned by Canvas.")
  return { courses: courses.length, written, notices }
}
