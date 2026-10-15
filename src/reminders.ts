import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { assertNoSymlinks } from "./fs-safety.js"
import type { WorkspaceContext } from "./types.js"
import { readUpcoming } from "./upcoming.js"

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const label = (value: string) =>
  Array.from(value.slice(0, 1000))
    .map((character) => {
      const code = character.codePointAt(0) ?? 0
      return code < 32 || code === 127 || code === 8232 || code === 8233 ? " " : character
    })
    .join("")
export async function planDueSoon(
  vault: string,
  context: WorkspaceContext,
  options: { days?: number; now?: Date } = {},
) {
  if (resolve(vault) !== resolve(context.vault))
    throw new Error("Reminder context belongs to a different vault")
  const days = options.days ?? 7,
    now = options.now ?? new Date()
  if (!Number.isInteger(days) || days < 1 || days > 365 || !Number.isFinite(now.getTime()))
    throw new Error("Due-soon reminders need a valid time and 1 to 365 days")
  const upcoming = await readUpcoming(vault, context, { days, now })
  const items = upcoming.items.map(({ course, title, path, canvasId, dueAt }) => ({
    course,
    title: label(title),
    path,
    ...(canvasId ? { canvasId } : {}),
    dueAt,
  }))
  if (items.length > 1000) throw new Error("Due-soon reminder inventory exceeds 1000 assignments")
  return {
    version: 1 as const,
    checkedAt: now.toISOString(),
    days,
    toInclusive: new Date(now.getTime() + days * 86_400_000).toISOString(),
    items,
    scope: context.courses.map((course) => ({
      course: course.code,
      ...(course.canvasId ? { canvasId: course.canvasId } : {}),
    })),
    sourceCoverageVerified: false as const,
    submissionStatusVerified: false as const,
    limitation:
      "Cached local deadlines, including private overrides. Missing sync coverage, completed submissions and current Canvas changes are not verified; nothing is submitted.",
  }
}
export function renderDueSoon(plan: Awaited<ReturnType<typeof planDueSoon>>) {
  return [
    "# Due-soon reminders",
    "",
    `Local cache checked: ${plan.checkedAt}`,
    `Window (inclusive): ${plan.checkedAt} — ${plan.toInclusive}`,
    `Scope: ${plan.scope.length ? plan.scope.map((course) => label(course.course)).join(", ") : "no selected eligible courses"} (not the full Canvas account)`,
    "",
    ...(plan.items.length
      ? plan.items.map((item) => `- ${item.dueAt} — ${item.course}: ${item.title}`)
      : ["No active due-soon reminders in this scope."]),
    "",
    plan.limitation,
  ].join("\n")
}

/** Explicit opt-in only; desktop delivery failure never destroys the durable alert. */
export async function notifyDueSoon(
  plan: Awaited<ReturnType<typeof planDueSoon>>,
  execute: typeof execFileAsync = execFileAsync,
  platform: string = process.platform,
) {
  if (!plan.items.length) return "nothing-due" as const
  const message =
    plan.items
      .slice(0, 5)
      .map((item) => `${item.course}: ${item.title} due ${item.dueAt}`)
      .map((value) => label(value).slice(0, 160))
      .join("; ") +
    (plan.items.length > 5
      ? `; ${plan.items.length - 5} more — see the private due-soon alert.`
      : "")
  return notifyDesktopAlert("Canvas Agent: due soon", message, execute, platform)
}
export async function notifyDesktopAlert(
  title: string,
  message: string,
  execute: typeof execFileAsync = execFileAsync,
  platform: string = process.platform,
) {
  if (platform !== "darwin") return "unsupported-platform" as const
  const literal = (value: string) =>
    `"${label(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
  try {
    await execute(
      "/usr/bin/osascript",
      ["-e", `display notification ${literal(message)} with title ${literal(title)}`],
      { timeout: 2000, maxBuffer: 4096 },
    )
    return "sent" as const
  } catch {
    return "failed" as const
  }
}
const execFileAsync = promisify(execFile)

async function privateRead(path: string) {
  await assertNoSymlinks(path)
  const info = await lstat(path)
  if (!info.isFile() || info.mode & 0o077 || info.size > 1_000_000)
    throw new Error("Reminder state must be a private bounded regular file")
  return readFile(path)
}
async function exclusive(path: string, bytes: Buffer) {
  const file = await open(path, "wx", 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
}

/** Owned private current alert + retained versions. Never adopt edited student files or held locks. */
export async function saveDueSoon(vault: string, plan: Awaited<ReturnType<typeof planDueSoon>>) {
  return {
    ...(await saveOwnedAlert(vault, "due-soon", plan, renderDueSoon(plan))),
    assignments: plan.items.length,
  }
}
function alertDirectory(vault: string, namespace: string) {
  if (!/^(?:due-soon|auth-alerts\/[a-f0-9]{64})$/.test(namespace))
    throw new Error("Unsupported private alert namespace")
  return join(resolve(vault), "_meta", namespace)
}
export async function readOwnedAlert(vault: string, namespace: string) {
  const directory = alertDirectory(vault, namespace)
  await assertNoSymlinks(directory, true)
  const directoryInfo = await lstat(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  })
  if (!directoryInfo) return undefined
  if (!directoryInfo.isDirectory() || directoryInfo.mode & 0o077)
    throw new Error("Private alert directory is exposed or unsafe")
  let raw: Buffer
  try {
    raw = await privateRead(join(directory, "current.json"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  let state: unknown
  try {
    state = JSON.parse(raw.toString("utf8"))
  } catch {
    throw new Error("Private alert ownership state is invalid")
  }
  if (!state || typeof state !== "object" || Array.isArray(state))
    throw new Error("Private alert ownership state is invalid")
  const value = state as Record<string, unknown>
  if (
    Object.keys(value).sort().join(",") !== "alertHash,reportHash,version" ||
    value.version !== 1 ||
    typeof value.alertHash !== "string" ||
    typeof value.reportHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.alertHash) ||
    !/^[a-f0-9]{64}$/.test(value.reportHash)
  )
    throw new Error("Private alert ownership state is invalid")
  const report = await privateRead(join(directory, `${value.reportHash}.json`)),
    text = await privateRead(join(directory, "ALERT.md"))
  if (sha(report) !== value.reportHash || sha(text) !== value.alertHash)
    throw new Error("Private alert/archive changed; existing files were preserved")
  let record: unknown
  try {
    record = JSON.parse(report.toString("utf8"))
  } catch {
    throw new Error("Private alert report is invalid")
  }
  return { record, text: text.toString("utf8"), reportHash: value.reportHash }
}
export async function saveOwnedAlert(
  vault: string,
  namespace: string,
  record: unknown,
  content: string,
) {
  const directory = alertDirectory(vault, namespace)
  await assertNoSymlinks(directory, true)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await assertNoSymlinks(directory)
  if ((await lstat(directory)).mode & 0o077) throw new Error("Reminder directory must be private")
  const lock = join(directory, "refresh.lock"),
    owner = Buffer.from(randomUUID())
  await exclusive(lock, owner)
  const current = join(directory, "current.json"),
    alert = join(directory, "ALERT.md")
  try {
    let original: Buffer | undefined
    try {
      original = await privateRead(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (original) {
      let previous: unknown
      try {
        previous = JSON.parse(original.toString("utf8"))
      } catch {
        throw new Error("Reminder ownership state is invalid; existing files were preserved")
      }
      if (!previous || typeof previous !== "object" || Array.isArray(previous))
        throw new Error("Reminder ownership state is invalid")
      const state = previous as Record<string, unknown>
      if (
        Object.keys(state).sort().join(",") !== "alertHash,reportHash,version" ||
        state.version !== 1 ||
        typeof state.alertHash !== "string" ||
        typeof state.reportHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(state.alertHash) ||
        !/^[a-f0-9]{64}$/.test(state.reportHash)
      )
        throw new Error("Reminder ownership state is invalid")
      const archive = await privateRead(join(directory, `${state.reportHash}.json`))
      if (sha(archive) !== state.reportHash || sha(await privateRead(alert)) !== state.alertHash)
        throw new Error("Reminder alert/archive changed; existing files were preserved")
    } else {
      await assertNoSymlinks(alert, true)
      try {
        await lstat(alert)
        throw new Error("Unowned reminder alert exists; it was preserved")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    const data = Buffer.from(JSON.stringify(record)),
      text = Buffer.from(content)
    if (data.length > 1_000_000 || text.length > 1_000_000)
      throw new Error("Reminder report exceeds bounds")
    const reportHash = sha(data),
      archive = join(directory, `${reportHash}.json`)
    await assertNoSymlinks(archive, true)
    try {
      await exclusive(archive, data)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (!(await privateRead(archive)).equals(data))
        throw new Error("Existing reminder report differs; it was preserved")
    }
    const staging = join(directory, `${owner.toString()}.tmp`)
    await exclusive(staging, text)
    try {
      await assertNoSymlinks(alert, true)
      if (original && !(await privateRead(current)).equals(original))
        throw new Error("Reminder state changed during refresh")
      if (original) {
        const expected = JSON.parse(original.toString()) as { alertHash: string }
        if (sha(await privateRead(alert)) !== expected.alertHash)
          throw new Error("Reminder alert changed during refresh")
        await rename(staging, alert)
      } else {
        await exclusive(alert, text)
        await unlink(staging)
      }
    } finally {
      await unlink(staging).catch(() => undefined)
    }
    const state = Buffer.from(JSON.stringify({ version: 1, alertHash: sha(text), reportHash }))
    const stateTemp = join(directory, `${owner.toString()}.state.tmp`)
    await exclusive(stateTemp, state)
    try {
      await assertNoSymlinks(current, true)
      if (original) {
        if (!(await privateRead(current)).equals(original))
          throw new Error("Reminder state changed during refresh")
        await rename(stateTemp, current)
      } else {
        await exclusive(current, state)
        await unlink(stateTemp)
      }
    } finally {
      await unlink(stateTemp).catch(() => undefined)
    }
    return {
      alertFile: `_meta/${namespace}/ALERT.md`,
      reportFile: `_meta/${namespace}/${reportHash}.json`,
      reportHash,
    }
  } finally {
    try {
      if ((await privateRead(lock)).equals(owner)) await unlink(lock)
    } catch {
      /* preserve replaced/changed locks */
    }
  }
}
