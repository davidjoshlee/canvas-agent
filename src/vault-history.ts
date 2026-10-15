import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { assertNoSymlinks } from "./fs-safety.js"

const control = "_meta/canvas-vault-history.json"
const ref = "refs/heads/canvas-history"
const config =
  "[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = true\n\tlogallrefupdates = false\n"
const State = z
  .object({ version: z.literal(1), vault: z.string(), directory: z.string(), enabled: z.boolean() })
  .strict()
const objectId = /^[a-f0-9]{40}$/
const fileLimit = 50 * 1024 * 1024
const totalLimit = 64 * 1024 * 1024
const within = (parent: string, child: string) => {
  const path = relative(parent, child)
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
}

async function canonicalTarget(path: string): Promise<string> {
  const target = resolve(path)
  await assertNoSymlinks(target, true)
  try {
    return await realpath(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return join(await canonicalTarget(dirname(target)), basename(target))
  }
}

async function boundedFile(path: string, limit: number) {
  await assertNoSymlinks(path)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > limit)
      throw new Error("Local history file exceeds bounds or is not regular")
    const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1))
    let length = 0
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    const after = await file.stat()
    if (
      length !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new Error("Local history source changed while reading")
    return { bytes: bytes.subarray(0, length), mode: stat.mode & 0o111 ? "100755" : "100644" }
  } finally {
    await file.close()
  }
}

async function rootOf(vault: string) {
  await assertNoSymlinks(vault)
  if (!(await lstat(vault)).isDirectory())
    throw new Error("History requires an existing vault directory")
  return realpath(vault)
}

async function stateAt(vault: string) {
  const root = await rootOf(vault)
  const path = join(root, control)
  let bytes: Buffer
  try {
    bytes = (await boundedFile(path, 16 * 1024)).bytes
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error("Invalid local history state")
  }
  const parsed = State.safeParse(value)
  if (!parsed.success) throw new Error("Invalid local history state")
  const state = parsed.data
  if (
    state.vault !== root ||
    !isAbsolute(state.directory) ||
    resolve(state.directory) !== state.directory ||
    (await canonicalTarget(state.directory)) !== state.directory ||
    within(root, state.directory) ||
    within(state.directory, root)
  )
    throw new Error("Local history store scope does not match the vault")
  return state
}

/** Detect only an existing explicit opt-in; don't add noise to unconfigured failures. */
export async function hasVaultHistory(vault: string) {
  try {
    const root = await rootOf(vault)
    await assertNoSymlinks(dirname(join(root, control)), true)
    await lstat(join(root, control))
    return true
  } catch {
    return false
  }
}

function git(directory: string, args: string[], input?: Buffer, limit = fileLimit + 1024) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
  }
  return new Promise<Buffer>((accept, reject) => {
    const child = execFile(
      "git",
      [
        "--no-replace-objects",
        `--git-dir=${directory}`,
        "-c",
        `core.hooksPath=${join(directory, "disabled-hooks")}`,
        "-c",
        "gc.auto=0",
        "-c",
        "commit.gpgSign=false",
        ...args,
      ],
      { env, encoding: "buffer", maxBuffer: limit, timeout: 20_000, killSignal: "SIGKILL" },
      (error, stdout) =>
        error
          ? reject(new Error(`Local history Git operation failed: ${args[0]}`))
          : accept(stdout),
    )
    child.stdin?.on("error", () => {})
    child.stdin?.end(input)
  })
}

async function verifyStore(state: z.infer<typeof State>) {
  await assertNoSymlinks(state.directory)
  const directoryStat = await lstat(state.directory)
  if (!directoryStat.isDirectory() || (process.platform !== "win32" && directoryStat.mode & 0o077))
    throw new Error("Local history store must be a private directory")
  let entries = 0
  async function walk(path: string, prefix = "") {
    await assertNoSymlinks(path)
    for (const item of await readdir(path, { withFileTypes: true })) {
      if (++entries > 40_000) throw new Error("Local history store inventory exceeds bounds")
      const name = prefix ? `${prefix}/${item.name}` : item.name
      if (item.isDirectory()) {
        if (
          !/^(?:objects(?:\/(?:[a-f0-9]{2}|info|pack))?|refs(?:\/(?:heads|tags))?|branches|hooks|info)$/.test(
            name,
          )
        )
          throw new Error("Unexpected local history directory")
        await walk(join(path, item.name), name)
      } else if (
        !item.isFile() ||
        !/^(?:HEAD|config|description|canvas-history\.json|canvas-history\.lock|refs\/heads\/canvas-history|objects\/[a-f0-9]{2}\/[a-f0-9]{38}|objects\/pack\/pack-[a-f0-9]{40}\.(?:pack|idx))$/.test(
          name,
        )
      )
        throw new Error("Unsafe or unexpected local history store entry")
    }
  }
  await walk(state.directory)
  if (
    (await boundedFile(join(state.directory, "config"), 4096)).bytes.toString() !== config ||
    (await boundedFile(join(state.directory, "HEAD"), 256)).bytes.toString() !== `ref: ${ref}\n` ||
    (
      await boundedFile(join(state.directory, "canvas-history.json"), 16 * 1024)
    ).bytes.toString() !== `${JSON.stringify({ version: 1, vault: state.vault })}\n`
  )
    throw new Error("Local history ownership or Git configuration changed")
}

async function locked<T>(state: z.infer<typeof State>, action: () => Promise<T>) {
  await verifyStore(state)
  const path = join(state.directory, "canvas-history.lock")
  const file = await open(path, "wx", 0o600).catch(() => {
    throw new Error("Local history is locked; inspect rather than removing a lock automatically")
  })
  try {
    return await action()
  } finally {
    await file.close()
    await unlink(path)
  }
}

function safePath(path: string) {
  if (
    !path ||
    path.length > 4096 ||
    path.includes("\\") ||
    [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Unsafe local history relative path")
  return path
}

async function inventory(root: string) {
  const files: { path: string; bytes: Buffer; mode: string; oid: string }[] = []
  let total = 0,
    entries = 0
  async function walk(directory: string, prefix = "", depth = 0) {
    await assertNoSymlinks(directory)
    if (depth > 64) throw new Error("Local history inventory exceeds depth bounds")
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (++entries > 10_000) throw new Error("Local history inventory exceeds entry bounds")
      const path = safePath(prefix ? `${prefix}/${item.name}` : item.name)
      if (item.name === ".git" || path === control) continue
      if (
        /^(?:\.env(?:\..*)?|\.(?:npmrc|netrc)|auth\.json|id_(?:rsa|ed25519)|(?:school|canvas-agent)\.(?:config|auth)\.json|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key))$/i.test(
          item.name,
        )
      )
        throw new Error(
          "Local history refuses credential-like filenames; keep credentials outside the vault",
        )
      if (item.isDirectory()) await walk(join(directory, item.name), path, depth + 1)
      else {
        const file = await boundedFile(join(directory, item.name), fileLimit)
        total += file.bytes.length
        if (total > totalLimit)
          throw new Error("Local history inventory exceeds the 64 MB aggregate bound")
        if (
          /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~-]{16,}|(?:api[_-]?key|access[_-]?token|client[_-]?secret|canvas[_-]?token|password)\s*[:=]\s*\S+)/i.test(
            file.bytes.toString("latin1"),
          )
        )
          throw new Error("Local history refuses credential-like content; no snapshot was saved")
        const oid = createHash("sha1")
          .update(`blob ${file.bytes.length}\0`)
          .update(file.bytes)
          .digest("hex")
        files.push({ path, ...file, oid })
      }
    }
  }
  await walk(root)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

async function head(state: z.infer<typeof State>) {
  try {
    const bytes = (await boundedFile(join(state.directory, ref), 64)).bytes.toString()
    if (!/^[a-f0-9]{40}\n$/.test(bytes)) throw new Error("Invalid local history reference")
    return bytes.trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function tree(state: z.infer<typeof State>, id: string) {
  if (!objectId.test(id)) throw new Error("History requires an exact 40-character commit ID")
  const raw = await git(
    state.directory,
    ["ls-tree", "-rz", "--full-tree", id],
    undefined,
    4 * 1024 * 1024,
  )
  const files = raw
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line)
      if (!match) throw new Error("Unsupported local history tree entry")
      return { path: safePath(match[3] ?? ""), mode: match[1] ?? "", oid: match[2] ?? "" }
    })
  if (files.length > 10_000) throw new Error("Local history tree exceeds bounds")
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function quotedPath(path: string) {
  return `"${[...Buffer.from(path)].map((byte) => (byte >= 32 && byte < 127 && byte !== 34 && byte !== 92 ? String.fromCharCode(byte) : `\\${byte.toString(8).padStart(3, "0")}`)).join("")}"`
}

async function snapshot(state: z.infer<typeof State>) {
  const files = await inventory(state.vault)
  const previous = await head(state)
  const shape = files.map(({ path, mode, oid }) => ({ path, mode, oid }))
  if (previous && JSON.stringify(await tree(state, previous)) === JSON.stringify(shape))
    return { enabled: true, changed: false, commit: previous, files: files.length }
  const repeated = await inventory(state.vault)
  if (
    JSON.stringify(repeated.map(({ path, mode, oid }) => ({ path, mode, oid }))) !==
    JSON.stringify(shape)
  )
    throw new Error("Vault changed during history capture; retry without modifying saved history")
  const message = "canvas-agent: local vault snapshot\n"
  const parts: Buffer[] = [
    Buffer.from(
      `feature done\ncommit ${ref}\ncommitter canvas-agent <canvas-agent@local> ${Math.floor(Date.now() / 1000)} +0000\ndata ${Buffer.byteLength(message)}\n${message}${previous ? `from ${previous}\n` : ""}deleteall\n`,
    ),
  ]
  for (const file of files)
    parts.push(
      Buffer.from(`M ${file.mode} inline ${quotedPath(file.path)}\ndata ${file.bytes.length}\n`),
      file.bytes,
      Buffer.from("\n"),
    )
  parts.push(Buffer.from("\ndone\n"))
  await git(state.directory, ["fast-import", "--quiet"], Buffer.concat(parts), 64 * 1024)
  const commit = await head(state)
  if (!commit || JSON.stringify(await tree(state, commit)) !== JSON.stringify(shape))
    throw new Error("Local history snapshot verification failed; preserve the store for inspection")
  return { enabled: true, changed: true, commit, files: files.length }
}

export async function enableVaultHistory(vault: string, directory: string) {
  const root = await rootOf(vault)
  if (!isAbsolute(directory)) throw new Error("History directory must be explicit and absolute")
  const target = await canonicalTarget(directory)
  if (within(root, target) || within(target, root))
    throw new Error("History store and vault must be disjoint")
  const prior = await stateAt(root)
  if (prior) {
    if (prior.directory !== target)
      throw new Error("History is already bound to another store; never adopt a replacement")
    return locked(prior, async () => {
      await saveState({ ...prior, enabled: true })
      return snapshot({ ...prior, enabled: true })
    })
  }
  await assertNoSymlinks(target, true)
  await mkdir(dirname(target), { recursive: true })
  await mkdir(target, { mode: 0o700 })
  const state = { version: 1 as const, vault: root, directory: target, enabled: true }
  await writeFile(
    join(target, "canvas-history.json"),
    `${JSON.stringify({ version: 1, vault: root })}\n`,
    { flag: "wx", mode: 0o600 },
  )
  await git(target, [
    "init",
    "--bare",
    "--template=",
    "--object-format=sha1",
    "--initial-branch=canvas-history",
    target,
  ])
  await writeFile(join(target, "config"), config, { mode: 0o600 })
  await mkdir(dirname(join(root, control)), { recursive: true, mode: 0o700 })
  await assertNoSymlinks(join(root, control), true)
  await writeFile(join(root, control), `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 })
  return locked(state, () => snapshot(state))
}

export async function snapshotVaultHistory(vault: string) {
  const state = await stateAt(vault)
  if (!state?.enabled) return { enabled: false, changed: false }
  return locked(state, () => snapshot(state))
}

export interface VaultHistoryStatus {
  status: "disabled" | "ready" | "empty" | "locked" | "unavailable" | "unsafe"
  configured: boolean | null
  enabled: boolean | null
  message: string
  latestCommit?: string
  files?: number
  writesPerformed: false
  fullHistoryIntegrityVerified: false
  workingTreeCurrentnessVerified: false
}

/** Inspect only history metadata/object headers. Never lock, repair, snapshot or read vault bodies. */
export async function inspectVaultHistory(vault: string): Promise<VaultHistoryStatus> {
  const result = (
    status: VaultHistoryStatus["status"],
    configured: boolean | null,
    enabled: boolean | null,
    message: string,
    extra: { latestCommit?: string; files?: number } = {},
  ): VaultHistoryStatus => ({
    status,
    configured,
    enabled,
    message,
    ...extra,
    writesPerformed: false,
    fullHistoryIntegrityVerified: false,
    workingTreeCurrentnessVerified: false,
  })
  let state: Awaited<ReturnType<typeof stateAt>>
  try {
    state = await stateAt(vault)
  } catch {
    return result(
      "unsafe",
      null,
      null,
      "Local history state or vault scope is unsafe/unavailable; inspect without editing ownership or deleting files",
    )
  }
  if (!state)
    return result(
      "disabled",
      false,
      false,
      "Optional local history is not configured; no automatic backup is claimed and Git is not required",
    )
  if (!state.enabled)
    return result(
      "disabled",
      true,
      false,
      "Local history capture is disabled; retained history is not checked and no current backup is claimed",
    )
  const lockedNow = async () => {
    await assertNoSymlinks(state.directory)
    try {
      await lstat(join(state.directory, "canvas-history.lock"))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
  }
  const lockedResult = () =>
    result(
      "locked",
      true,
      true,
      "Local history has a lock; metadata readiness is unknown. This does not prove a live process; inspect the owner without automatically removing the lock",
    )
  try {
    if (await lockedNow()) return lockedResult()
    await verifyStore(state)
  } catch {
    return result(
      "unsafe",
      true,
      true,
      "Configured local history store is missing, unsafe or changed; preserve it and inspect ownership/configuration without repair",
    )
  }
  try {
    await git(state.directory, ["--version"], undefined, 1024)
  } catch {
    return result(
      "unavailable",
      true,
      true,
      "Git could not run for configured local history; install/repair Git before expecting automatic snapshots",
    )
  }
  try {
    const current = await head(state)
    if (!current)
      return result(
        "empty",
        true,
        true,
        "Local history is enabled but has no saved snapshot; run vault history snapshot and check its result",
      )
    if (
      (await git(state.directory, ["cat-file", "-t", current], undefined, 64)).toString() !==
      "commit\n"
    )
      throw new Error("Invalid history commit")
    const files = await tree(state, current)
    if (files.length) {
      const output = await git(
        state.directory,
        ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
        Buffer.from(`${files.map((file) => file.oid).join("\n")}\n`),
        1024 * 1024,
      )
      const rows = output.toString().trim().split("\n")
      let total = 0
      if (rows.length !== files.length) throw new Error("Missing history objects")
      for (let i = 0; i < rows.length; i++) {
        const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(rows[i] ?? "")
        const size = Number(match?.[2])
        if (!match || match[1] !== files[i]?.oid || !Number.isSafeInteger(size) || size > fileLimit)
          throw new Error("Invalid history object headers")
        total += size
      }
      if (total > totalLimit) throw new Error("History object inventory exceeds bounds")
    }
    if (await lockedNow()) return lockedResult()
    if ((await head(state)) !== current)
      return result(
        "locked",
        true,
        true,
        "Local history changed during inspection; retry after the writer finishes, without editing saved history",
      )
    return result(
      "ready",
      true,
      true,
      "History store, latest tree and blob headers are readable; this does not verify full historical integrity or that current vault edits are saved",
      { latestCommit: current, files: files.length },
    )
  } catch {
    return result(
      "unsafe",
      true,
      true,
      "Latest local history commit/tree/object metadata is unreadable or invalid; preserve the store and inspect before relying on recovery",
    )
  }
}

export async function listVaultHistory(vault: string) {
  const state = await stateAt(vault)
  if (!state) return { enabled: false, configured: false, commits: [] }
  return locked(state, async () => {
    const current = await head(state)
    const lines = current
      ? (
          await git(
            state.directory,
            ["log", "--max-count=100", "--format=%H %P %ct", current],
            undefined,
            64 * 1024,
          )
        )
          .toString()
          .trim()
          .split("\n")
      : []
    const commits = lines.map((line) => {
      const fields = line.split(" ").filter(Boolean)
      const id = fields[0] ?? "",
        seconds = fields.at(-1) ?? ""
      if (
        !objectId.test(id) ||
        !/^\d+$/.test(seconds) ||
        fields.slice(1, -1).some((parent) => !objectId.test(parent))
      )
        throw new Error("Invalid local history commit metadata")
      return {
        id,
        parents: fields.slice(1, -1),
        createdAt: new Date(Number(seconds) * 1000).toISOString(),
      }
    })
    return {
      enabled: state.enabled,
      configured: true,
      directory: state.directory,
      commits,
      limit: 100,
      complete: commits.length < 100,
    }
  })
}

export async function showVaultHistory(vault: string, commit: string) {
  const state = await stateAt(vault)
  if (!state) throw new Error("Local history is not configured")
  return locked(state, async () => {
    const current = await head(state)
    if (!current || !objectId.test(commit))
      throw new Error("History requires an exact saved commit ID")
    await git(state.directory, ["merge-base", "--is-ancestor", commit, current])
    return { commit, files: await tree(state, commit), contentsIncluded: false }
  })
}

export async function exportVaultHistory(
  vault: string,
  commit: string,
  path: string,
  destination: string,
) {
  const state = await stateAt(vault)
  if (!state) throw new Error("Local history is not configured")
  safePath(path)
  const target = await canonicalTarget(destination)
  if (!isAbsolute(destination) || within(state.vault, target) || within(state.directory, target))
    throw new Error("History export must be a new absolute file outside vault and store")
  return locked(state, async () => {
    const current = await head(state)
    if (!current || !objectId.test(commit))
      throw new Error("History requires an exact saved commit ID")
    await git(state.directory, ["merge-base", "--is-ancestor", commit, current])
    const entry = (await tree(state, commit)).find((file) => file.path === path)
    if (!entry) throw new Error("Requested file is absent from that history snapshot")
    const bytes = await git(
      state.directory,
      ["cat-file", "blob", entry.oid],
      undefined,
      fileLimit + 1,
    )
    if (bytes.length > fileLimit) throw new Error("History export exceeds file bounds")
    if (
      createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== entry.oid
    )
      throw new Error("History blob integrity failed")
    await assertNoSymlinks(target, true)
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 })
    return {
      commit,
      path,
      destination: target,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      restoredIntoVault: false,
    }
  })
}

export async function disableVaultHistory(vault: string) {
  const state = await stateAt(vault)
  if (!state) return { enabled: false, configured: false }
  return locked(state, async () => {
    await saveState({ ...state, enabled: false })
    return { enabled: false, configured: true, historyPreserved: true }
  })
}

async function saveState(state: z.infer<typeof State>) {
  const path = join(state.vault, control),
    temporary = `${path}.${randomUUID()}.tmp`
  await assertNoSymlinks(path)
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 })
  await rename(temporary, path)
}
