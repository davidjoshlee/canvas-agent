import { execFile } from "node:child_process"
import type { Dirent } from "node:fs"
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import type { Command } from "commander"
import { loadConfig } from "../config/index.js"
import { assertNoSymlinks } from "../shared/fs-safety.js"

const GUIDE = "00 Canvas Agent Getting Started.md"
const within = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
}
export type ObsidianPlan = {
  root: string
  guidePath: string
  uri: string
  fileTypes: Record<string, number>
  courseHomes: string[]
  blockers: string[]
  warnings: string[]
}
async function canonical(path: string): Promise<string> {
  const absolute = resolve(path)
  await assertNoSymlinks(absolute, true)
  try {
    return await realpath(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    return join(await canonical(parent), basename(absolute))
  }
}

/** Filesystem names/metadata only; never read course, credential or app-setting bodies. */
export async function planObsidianVault(
  rootPath: string,
  privatePaths: string[] = [],
): Promise<ObsidianPlan> {
  const root = await canonical(rootPath),
    guidePath = join(root, GUIDE)
  await assertNoSymlinks(root, true)
  const plan: ObsidianPlan = {
    root,
    guidePath,
    uri: `obsidian://open?path=${encodeURIComponent(guidePath)}`,
    fileTypes: {},
    courseHomes: [],
    blockers: [],
    warnings: [],
  }
  for (const path of privatePaths)
    if (within(root, await canonical(path)))
      plan.blockers.push("Configured private files must remain outside the vault")
  let count = 0
  async function visit(directory: string) {
    await assertNoSymlinks(directory, true)
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (directory === root && (error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      if (++count > 20_000) throw new Error("Obsidian readiness inventory exceeds 20000 entries")
      const path = join(directory, entry.name),
        local = relative(root, path).split(sep).join("/")
      if (entry.isSymbolicLink()) {
        plan.blockers.push(`Review symbolic link: ${local}`)
        continue
      }
      if (
        /^(?:\.env(?:\..*)?|(?:school|canvas-agent)\.config\.json|credentials?|secrets?|passwords?|tokens?)(?:\..*)?$|\.auth\.json$|\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/i.test(
          entry.name,
        )
      ) {
        plan.blockers.push(`Private file must stay outside the vault: ${local}`)
        continue
      }
      if (entry.name === GUIDE && !entry.isFile()) {
        plan.blockers.push("Getting-started note is not a regular file")
        continue
      }
      if (entry.name === ".obsidian" && !entry.isDirectory()) {
        plan.blockers.push("Obsidian settings path is not a directory")
        continue
      }
      if (entry.name === ".obsidian")
        plan.warnings.push(
          "Review app settings/plugin storage before syncing; this names-only check cannot inspect embedded credentials",
        )
      if (entry.name.startsWith("_") || entry.name === ".agent-runs") {
        plan.warnings.push(
          `Keep private operational state local and exclude it from any sync: ${local}`,
        )
        continue
      }
      if (entry.name.startsWith(".")) continue
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        const extension = extname(entry.name).toLowerCase() || "(none)"
        plan.fileTypes[extension] = (plan.fileTypes[extension] ?? 0) + 1
        if (extension === ".icloud")
          plan.warnings.push(`Undownloaded placeholder requires review: ${local}`)
        if (entry.name === "00 Home.md" && local.split("/").length === 2)
          plan.courseHomes.push(local)
      }
    }
  }
  await visit(root)
  plan.blockers = [...new Set(plan.blockers)]
  plan.courseHomes.sort()
  return plan
}
function renderGuide(plan: ObsidianPlan) {
  const links = plan.courseHomes
    .map(
      (path) =>
        `- [${dirname(path)
          .replace(/[\r\n]/g, " ")
          .replace(/[[\]\\]/g, "\\$&")}](${path
          .split("/")
          .map((part) =>
            encodeURIComponent(part).replace(
              /[!'()*]/g,
              (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
            ),
          )
          .join("/")})`,
    )
    .join("\n")
  return `# Canvas Agent local vault\n\nThese are your original local files. This guide is created once and never overwritten; course links are a setup-time snapshot. Nothing was moved, converted or uploaded.\n\n## Courses\n\n${links || "Sync explicitly selected courses, then browse their folders."}\n\n## Open locally\n\nIn Obsidian, use Open folder as vault and select this folder. Register it first before using the printed open link; check the selected vault in the app. Read Markdown locally and use normal file-manager apps for unsupported original formats. Keep personal annotations separate from generated briefs. Only one primary computer/agent should write synced course artifacts at a time.\n\n## Privacy and phone reading\n\nKeep credentials, configuration and databases outside the vault. Exclude _meta, .agent-runs and other private operational state with any file-sync provider. This names-only check is not a comprehensive secret or content audit. Review course sharing restrictions before uploading material or sending it to a model.\n\nFor a read-only phone copy, preview vault reading-copy with your explicit config and private destination; apply Current only after confirming the account. The cloud desktop client handles uploads. No phone edits flow back. Obsidian itself does not run Canvas Agent or fetch Canvas updates.\n\nThis command does not configure Obsidian settings/plugins, create an account, enable Sync, buy a plan or schedule jobs. Keep a separate backup and avoid simultaneous file-sync providers on the working vault.\n\n[Official Obsidian URI documentation](https://obsidian.md/help/uri)\n`
}
export async function prepareObsidianVault(root: string, privatePaths: string[] = []) {
  const plan = await planObsidianVault(root, privatePaths)
  if (plan.blockers.length)
    throw new Error(
      "Obsidian preparation blocked; resolve the reported private files or symlinks first",
    )
  await mkdir(plan.root, { recursive: true })
  await assertNoSymlinks(plan.guidePath, true)
  try {
    await writeFile(plan.guidePath, renderGuide(plan), { flag: "wx", mode: 0o600 })
    return { plan, created: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { plan, created: false }
    throw error
  }
}
export function obsidianLaunchCommand(uri: string, platform: NodeJS.Platform = process.platform) {
  const parsed = new URL(uri)
  if (
    parsed.protocol !== "obsidian:" ||
    parsed.hostname !== "open" ||
    parsed.pathname ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hash ||
    [...parsed.searchParams.keys()].join(",") !== "path" ||
    !isAbsolute(parsed.searchParams.get("path") ?? "")
  )
    throw new Error("Expected a path-only Obsidian open URI")
  if (platform === "darwin") return { command: "open", args: [uri] }
  if (platform === "linux") return { command: "xdg-open", args: [uri] }
  throw new Error(
    "Use the printed URI manually; automatic opening is supported only on macOS/Linux",
  )
}
export async function openObsidianVault(uri: string) {
  const launch = obsidianLaunchCommand(uri)
  try {
    await promisify(execFile)(launch.command, launch.args, { timeout: 10_000 })
  } catch {
    throw new Error(
      "Could not launch Obsidian; install/open the app and register the printed folder manually. No originals were changed",
    )
  }
}
export function registerObsidianCommand(program: Command) {
  const vault = program.commands.find((command) => command.name() === "vault")
  if (!vault) throw new Error("Register vault commands before Obsidian support")
  vault
    .command("obsidian")
    .description(
      "preview local readiness or create a preserved getting-started note; no sync/upload",
    )
    .option("--apply", "create the guide only if absent")
    .option("--open", "explicitly request app opening after folder registration")
    .option("--json", "emit readiness metadata without source bodies")
    .action(async (options) => {
      const path = resolve(program.opts().config),
        config = await loadConfig(path)
      const privatePaths = [path, `${path}.auth.json`, join(dirname(path), ".env")]
      const result = options.apply
        ? await prepareObsidianVault(config.vault.path, privatePaths)
        : { plan: await planObsidianVault(config.vault.path, privatePaths), created: false }
      if (options.open) {
        if (result.plan.blockers.length)
          throw new Error("Obsidian opening blocked by readiness checks")
        await assertNoSymlinks(result.plan.guidePath)
        if (!(await lstat(result.plan.guidePath)).isFile())
          throw new Error("Prepare the guide with --apply before --open")
        await openObsidianVault(result.plan.uri)
      }
      process.stdout.write(
        options.json
          ? `${JSON.stringify({ ...result, opened: Boolean(options.open) }, null, 2)}\n`
          : `${JSON.stringify(result.plan, null, 2)}\n${options.apply ? (result.created ? "Created guide" : "Preserved existing guide") : "Preview only"}. No sync or uploads configured.\n`,
      )
      if (result.plan.blockers.length) process.exitCode = 1
    })
}
