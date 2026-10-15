import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readFile, rmdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { createDogfood, readDogfood } from "./dogfood.js"
import { assertNoSymlinks } from "./fs-safety.js"
import { relatedSources } from "./module-context.js"
import { hasPrepMaterial, selectPrepInputs } from "./tasks.js"
import type { CourseContext, SourceRecord } from "./types.js"
import { inspectWorkspace, selectCourse } from "./workspace.js"

const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const sessionSchema = z
  .object({
    number: z.number().int().positive(),
    identity: z.string().min(1),
    title: z.string().min(1),
    selector: z.string().min(1),
    assignment: z.string().nullable(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
const manifestSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    course: z.string().min(1),
    root: z.string().min(1),
    createdAt: z.string().datetime(),
    sessions: z
      .array(sessionSchema.extend({ runId: z.string().uuid() }).strict())
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((record, ctx) => {
    for (const key of ["runId", "identity", "number"] as const)
      if (new Set(record.sessions.map((session) => session[key])).size !== record.sessions.length)
        ctx.addIssue({ code: "custom", message: "Sweep contains duplicate session/run identities" })
    if (
      record.sessions.some(
        (session, index) =>
          index > 0 && session.number <= (record.sessions[index - 1]?.number ?? 0),
      )
    )
      ctx.addIssue({ code: "custom", message: "Sweep sessions must be in numerical order" })
  })
function sessionNumber(source: SourceRecord) {
  if (
    !source.moduleCanvasId &&
    !/module|session|milestone/i.test(source.type) &&
    !/(?:^|\/)(?:modules?|sessions?|milestones?)(?:\/|$)/i.test(source.path)
  )
    return undefined
  const match = source.title.match(/\bsession\s+(\d+)\b/i)
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("Teaching session number is invalid")
  return value
}
/** Resolve the first N unique numbered teaching modules, without guessed dates. */
export function resolveDogfoodSessions(course: CourseContext, count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 100)
    throw new Error("Session count must be an integer from 1 to 100")
  const groups = new Map<string, { number: number; sources: SourceRecord[] }>()
  for (const source of course.sources) {
    const number = sessionNumber(source)
    if (number === undefined) continue
    const identity = source.moduleCanvasId ?? source.canvasId ?? source.path
    const group = groups.get(identity)
    if (group && group.number !== number)
      throw new Error("Owning module has conflicting session numbers")
    if (group) group.sources.push(source)
    else groups.set(identity, { number, sources: [source] })
  }
  const numbered = [...groups.entries()].sort(([, left], [, right]) => left.number - right.number)
  if (new Set(numbered.map(([, group]) => group.number)).size !== numbered.length)
    throw new Error("Teaching session number is ambiguous across modules")
  if (numbered.length < count) throw new Error("Fewer readable teaching sessions than requested")
  return numbered.slice(0, count).map(([identity, group]) => {
    const available = new Set(course.sources.map((source) => source.path))
    if (
      group.sources.some((source) =>
        (source.relatedPaths ?? []).some(
          (path) =>
            !available.has(path.startsWith(`${course.root}/`) ? path : `${course.root}/${path}`),
        ),
      )
    )
      throw new Error(
        "Teaching session has unavailable linked material; repair the selected scope first",
      )
    const representative =
      group.sources.find((source) => source.canvasId === identity) ?? group.sources[0]
    if (!representative) throw new Error("Teaching session has no readable module")
    const selector =
      representative.moduleCanvasId ?? representative.canvasId ?? representative.title
    const selected = selectPrepInputs(course, { kind: "session", value: selector }).sources
    if (!hasPrepMaterial(course, selected))
      throw new Error("Teaching session has no substantive preparation material")
    const linked = relatedSources(course, group.sources).filter((source) =>
      /^assignments?(?:\.md)?$/i.test(source.type),
    )
    if (linked.length > 1)
      throw new Error(
        "Teaching session links multiple assignments; choose an explicit single-session run",
      )
    return sessionSchema.parse({
      number: group.number,
      identity,
      title: representative.title,
      selector,
      assignment: linked[0]?.path ?? null,
      fingerprint: hash(
        JSON.stringify(
          selected.map(({ path, hash, originalHash }) => ({ path, hash, originalHash })),
        ),
      ),
    })
  })
}
function directory(vault: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new Error("Dogfood sweep ID must be a UUID")
  return join(resolve(vault), "_meta/dogfood-sweeps", id)
}
type InitializationOptions = { afterRunCreated?: (index: number) => Promise<void> }
export async function createDogfoodSweep(
  vault: string,
  query: string,
  count: number,
  options: InitializationOptions = {},
) {
  const course = selectCourse(await inspectWorkspace(vault), query)
  const sessions = resolveDogfoodSessions(course, count),
    id = randomUUID(),
    path = directory(vault, id)
  await assertNoSymlinks(path, true)
  await mkdir(path, { recursive: true, mode: 0o700 })
  const manifest = manifestSchema.parse({
    version: 1,
    id,
    course: course.code,
    root: course.root,
    createdAt: new Date().toISOString(),
    sessions: sessions.map((session) => ({ ...session, runId: randomUUID() })),
  })
  const payload = JSON.stringify(manifest)
  await assertNoSymlinks(path)
  await writeFile(join(path, "manifest.json"), JSON.stringify({ payload, hash: hash(payload) }), {
    flag: "wx",
    mode: 0o600,
  })
  try {
    await initializeDogfoodSweep(vault, query, id, options)
  } catch {
    const error = new Error(
      `Sweep ${id} initialization incomplete; resume this exact sweep after inspecting its private manifest/lock`,
    )
    Object.assign(error, { sweepId: id })
    throw error
  }
  return manifest
}
async function readSweepManifest(vault: string, id: string, budget?: { remaining: number }) {
  const path = join(directory(vault, id), "manifest.json")
  await assertNoSymlinks(path)
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size > 1_000_000) throw new Error("Unsafe dogfood sweep manifest")
  if (budget) {
    budget.remaining -= stat.size
    if (budget.remaining < 0) throw new Error("Dogfood sweep inventory exceeds 100 MB")
  }
  const bytes = await readFile(path)
  if (bytes.includes(0) || !Buffer.from(bytes.toString()).equals(bytes))
    throw new Error("Unsafe sweep text")
  const envelope = z
    .object({ payload: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .parse(JSON.parse(bytes.toString()))
  if (hash(envelope.payload) !== envelope.hash)
    throw new Error("Dogfood sweep manifest hash mismatch")
  const manifest = manifestSchema.parse(JSON.parse(envelope.payload))
  if (manifest.id !== id) throw new Error("Dogfood sweep course/identity mismatch")
  return manifest
}
async function loadSweep(vault: string, query: string, id: string) {
  const course = selectCourse(await inspectWorkspace(vault), query)
  const manifest = await readSweepManifest(vault, id)
  if (manifest.course !== course.code || manifest.root !== course.root)
    throw new Error("Dogfood sweep course/identity mismatch")
  return { manifest, course }
}

/** Saved selection metadata only; do not initialize children or revalidate live evidence. */
export async function listDogfoodSweeps(vault: string, query: string) {
  const course = selectCourse(await inspectWorkspace(vault), query)
  const path = join(resolve(vault), "_meta/dogfood-sweeps")
  await assertNoSymlinks(path, true)
  const entries = await readdir(path, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  })
  if (entries.length > 5000) throw new Error("Dogfood sweep inventory exceeds 5000 entries")
  const budget = { remaining: 100_000_000 }
  const sweeps: Array<{ id: string; createdAt: string; sessionCount: number; runIds: string[] }> =
    []
  let unreadableRecords = 0
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!z.string().uuid().safeParse(entry.name).success) continue
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe sweep entry")
      const manifest = await readSweepManifest(vault, entry.name, budget)
      if (manifest.course !== course.code || manifest.root !== course.root) continue
      sweeps.push({
        id: manifest.id,
        createdAt: manifest.createdAt,
        sessionCount: manifest.sessions.length,
        runIds: manifest.sessions.map((session) => session.runId),
      })
    } catch {
      if (budget.remaining < 0) throw new Error("Dogfood sweep inventory exceeds 100 MB")
      unreadableRecords++
    }
  }
  sweeps.sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id),
  )
  return {
    course: course.code,
    sweeps,
    unreadableRecords,
    inventoryComplete: unreadableRecords === 0,
    limitation:
      "Validated saved manifest metadata only. Child checkpoints, current sources, outputs, permission, completion and live workers are not verified. Unreadable records have unknown course scope and may hide sweeps; inspect without rewriting history.",
  }
}
const missingRun = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ||
  (error instanceof Error && error.message === "Dogfood journal has no checkpoint")
export async function validateDogfoodSweepSelection(vault: string, query: string, id: string) {
  const { manifest, course } = await loadSweep(vault, query, id)
  const current = resolveDogfoodSessions(course, manifest.sessions.length)
  const scope = (session: z.infer<typeof sessionSchema>) => {
    const { fingerprint: _fingerprint, ...identity } = session
    return identity
  }
  if (
    JSON.stringify(current.map(scope)) !==
    JSON.stringify(manifest.sessions.map(({ runId: _runId, ...session }) => scope(session)))
  )
    throw new Error("Sweep teaching-session scope changed; start a fresh sweep")
}
function verifyTarget(
  run: Awaited<ReturnType<typeof readDogfood>>,
  course: string,
  session: z.infer<typeof sessionSchema>,
) {
  if (
    run.target.course !== course ||
    run.target.period.kind !== "session" ||
    run.target.period.value !== session.selector ||
    run.target.assignment !== session.assignment
  )
    throw new Error("Sweep session run does not match its manifest target")
}
/** Initialize only the run IDs already reserved by the immutable manifest. */
export async function initializeDogfoodSweep(
  vault: string,
  query: string,
  id: string,
  options: InitializationOptions = {},
) {
  const { manifest, course } = await loadSweep(vault, query, id)
  const current = resolveDogfoodSessions(course, manifest.sessions.length)
  const recorded = manifest.sessions.map(({ runId: _runId, ...session }) => session)
  if (JSON.stringify(current) !== JSON.stringify(recorded))
    throw new Error("Sweep selection changed before initialization; start a fresh sweep")
  const lock = join(directory(vault, id), "lock")
  await assertNoSymlinks(lock, true)
  await mkdir(lock, { mode: 0o700 })
  try {
    for (let index = 0; index < manifest.sessions.length; index++) {
      const session = manifest.sessions[index]
      if (!session) throw new Error("Missing sweep session")
      let run: Awaited<ReturnType<typeof readDogfood>>
      try {
        run = await readDogfood(vault, session.runId)
      } catch (error) {
        if (!missingRun(error)) throw error
        run = await createDogfood(
          vault,
          {
            course: course.code,
            period: { kind: "session", value: session.selector },
            assignment: session.assignment,
          },
          session.runId,
        )
        await options.afterRunCreated?.(index)
      }
      verifyTarget(run, course.code, session)
    }
    return manifest
  } finally {
    await rmdir(lock)
  }
}
export async function inspectDogfoodSweep(vault: string, query: string, id: string) {
  const { manifest, course } = await loadSweep(vault, query, id)
  const entries = []
  for (const session of manifest.sessions) {
    let run: Awaited<ReturnType<typeof readDogfood>>
    try {
      run = await readDogfood(vault, session.runId)
    } catch (error) {
      entries.push({
        ...session,
        state: missingRun(error) ? "not-initialized" : "invalid",
        flowsRecorded: 0,
        recordedComplete: false,
      })
      continue
    }
    verifyTarget(run, course.code, session)
    const last = run.flows.at(-1)
    entries.push({
      ...session,
      state: last?.status ?? "not-started",
      activeTaskId: last?.data.taskId ?? null,
      nextSteps: last?.nextSteps ?? "",
      flowsRecorded: run.flows.length,
      recordedComplete:
        run.flows.length === 10 &&
        run.flows.every((flow) => ["pass", "skipped"].includes(flow.status)),
    })
  }
  return {
    id,
    course: course.code,
    sessions: entries,
    evidenceRevalidated: false,
    limitation:
      "Saved run states only; resume each exact run to revalidate evidence. No academic quality or live sync is established by this index.",
  }
}
