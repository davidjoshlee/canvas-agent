import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { assertNoSymlinks } from "./fs-safety.js"
import type { ToolkitConfig } from "./types.js"

type Obj = Record<string, unknown>
const fetcher = (input: string | URL, init?: RequestInit) => fetch(input, init)
let request = fetcher
export function setCanvasFetchForTests(fn?: typeof fetcher): void {
  request = fn ?? fetcher
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
async function get(config: ToolkitConfig, url: URL): Promise<Response> {
  const root = base(config)
  if (url.origin !== root.origin || url.protocol !== root.protocol || url.username || url.password)
    throw new Error("Canvas pagination or download URL is outside the safe configured origin")
  const authToken = token(config)
  let response: Response
  try {
    response = await request(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${authToken}`, Accept: "application/json" },
      redirect: "error",
    })
  } catch {
    throw new Error("Canvas GET request failed before receiving a response")
  }
  if (!response.ok) throw new Error(`Canvas GET failed with HTTP ${response.status}`)
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
function assetUrl(config: ToolkitConfig, value: unknown): URL | undefined {
  if (typeof value !== "string" || !value) return
  const root = base(config)
  const url = new URL(value, root)
  if (url.origin !== root.origin || url.protocol !== root.protocol || url.username || url.password)
    return
  return url
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
  if (courseInfo.syllabus_body)
    await managedWrite(
      manager,
      join(courseRoot, "Resources", "Syllabus.md"),
      markdown("Syllabus", courseInfo, textOf(courseInfo.syllabus_body)),
    )
  const simple = async (
    endpoint: string,
    folder: string,
    getTitle: (v: Obj) => string,
    getText: (v: Obj) => string,
  ) => {
    const values = await list(config, apiUrl(root, `${prefix}/${endpoint}?per_page=100`))
    for (const value of values) {
      let source = value
      if (endpoint === "pages" && typeof value.body !== "string" && typeof value.url === "string") {
        source = (await (
          await get(config, apiUrl(root, `${prefix}/pages/${encodeURIComponent(value.url)}`))
        ).json()) as Obj
      }
      const title = getTitle(source),
        path = join(
          courseRoot,
          "Canvas",
          folder,
          `${safeSegment(title)}-${safeSegment(String(source.id ?? "item"))}.md`,
        )
      const fields: Record<string, unknown> = {}
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
  const modules = await list(config, apiUrl(root, `${prefix}/modules?include[]=items&per_page=100`))
  for (let value of modules) {
    if (!Array.isArray(value.items) && value.id != null)
      value = {
        ...value,
        items: await list(
          config,
          apiUrl(
            root,
            `${prefix}/modules/${encodeURIComponent(String(value.id))}/items?per_page=100`,
          ),
        ),
      }
    const title = String(value.name ?? `Module ${value.id}`)
    const items = Array.isArray(value.items)
      ? value.items
          .map(
            (i: Obj) =>
              `- ${String(i.title ?? i.type ?? "Item")}${i.html_url ? ` (${i.html_url})` : ""}`,
          )
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
      markdown(
        title,
        value,
        items,
        Object.fromEntries(
          ["unlock_at", "start_at", "end_at", "created_at", "updated_at"]
            .filter((k) => value[k])
            .map((k) => [k, value[k]]),
        ),
      ),
    )
  }
  const files = await list(config, apiUrl(root, `${prefix}/files?per_page=100`))
  for (const file of files) {
    const filename = String(file.filename ?? file.display_name ?? `file-${file.id}`)
    const id = safeSegment(String(file.id ?? "file"))
    const target = join(courseRoot, "Canvas", "Files", `${id}-${safeSegment(filename)}`)
    if (file.locked || file.hidden || !file.url) {
      manager.notices.push(`Skipped inaccessible Canvas file ${filename} in ${course.code}.`)
      continue
    }
    const url = assetUrl(config, file.url)
    if (!url) {
      manager.notices.push(`Skipped external or unsafe Canvas file ${filename} in ${course.code}.`)
      continue
    }
    try {
      const response = await get(config, url)
      if (
        response.headers.get("content-length") &&
        Number(response.headers.get("content-length")) > 50 * 1024 * 1024
      ) {
        manager.notices.push(`Skipped Canvas file over 50 MB: ${filename}.`)
        continue
      }
      const bytes = await readBounded(response, 50 * 1024 * 1024)
      if (!bytes) {
        manager.notices.push(`Skipped Canvas file over 50 MB: ${filename}.`)
        continue
      }
      await managedWrite(manager, target, bytes)
    } catch {
      manager.notices.push(`Could not download Canvas file ${filename} in ${course.code}.`)
    }
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
