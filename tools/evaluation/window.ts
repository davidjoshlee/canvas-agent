import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, readFile, rename, rmdir, unlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"
import { assertNoSymlinks } from "../../src/shared/fs-safety.js"
import type { SourceRecord } from "../../src/shared/types.js"
import { deriveSimulationCapture, replaySimulation } from "../../src/simulation/captures.js"
import {
  createSimulationTask,
  inspectSimulationTask,
  readSimulationTask,
} from "../../src/simulation/tasks.js"
import { isAssignmentSource, isTeachingModuleSource } from "../../src/vault/source-kind.js"
import { compareSimulationEvaluations } from "./comparison.js"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const sha = (value: string) => createHash("sha256").update(value).digest("hex")
const outcomeSchema = z
  .object({
    kind: z.enum(["prep", "assignment"]),
    source: z.string().optional(),
    id: z.string().uuid().optional(),
    recipeHash: digest.optional(),
    failure: z.literal("handoff-creation-failed").optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.kind === "assignment") !== Boolean(value.source) ||
      Boolean(value.id) !== Boolean(value.recipeHash) ||
      Boolean(value.id) === Boolean(value.failure)
    )
      ctx.addIssue({
        code: "custom",
        message: "Window outcome must be a bound handoff or recorded failure",
      })
  })
const recordSchema = z
  .object({
    version: z.literal(1),
    planningVersion: z.literal(1).optional(),
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    original: z.object({ id: z.string().uuid(), hash: digest }).strict(),
    course: z.object({ code: z.string(), title: z.string(), root: z.string() }).strict(),
    range: z.string(),
    module: z.object({ path: z.string(), hash: digest }).strict().optional(),
    phase: z.enum(["building", "planned"]),
    weeks: z
      .array(
        z
          .object({
            week: z.string(),
            cutoff: z.string().optional(),
            snapshot: z.object({ id: z.string().uuid(), hash: digest }).strict(),
            phase: z.enum(["building", "planned"]),
            moduleAvailable: z.boolean().nullable(),
            tasks: z.array(outcomeSchema).max(250),
          })
          .strict(),
      )
      .max(52),
    hash: digest,
  })
  .strict()
type Record = z.infer<typeof recordSchema>
type Outcome = z.infer<typeof outcomeSchema>
type PlanningOptions = { afterCheckpoint?: () => Promise<void> }

export function simulationWindowDates(range: string): string[] {
  const parts = range.split("..")
  if (parts.length !== 2) throw new Error("Window requires inclusive YYYY-MM-DD..YYYY-MM-DD dates")
  const valid = (value: string) => {
    const date = new Date(`${value}T00:00:00.000Z`)
    return (
      /^\d{4}-\d\d-\d\d$/.test(value) &&
      Number.isFinite(date.valueOf()) &&
      date.toISOString().slice(0, 10) === value
    )
  }
  const start = parts[0] ?? "",
    end = parts[1] ?? ""
  if (!valid(start) || !valid(end) || start > end)
    throw new Error("Window endpoints must be ordered real calendar dates")
  const result: string[] = []
  for (
    const date = new Date(`${start}T00:00:00.000Z`);
    date.toISOString().slice(0, 10) <= end;
    date.setUTCDate(date.getUTCDate() + 7)
  ) {
    if (result.length >= 52) throw new Error("Window exceeds 52 weekly cutoffs")
    result.push(date.toISOString().slice(0, 10))
  }
  return result
}
function teachingWeek(cutoff: string): string {
  const date = new Date(`${cutoff}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  return date.toISOString().slice(0, 10)
}
const assignment = isAssignmentSource
function moduleSource(sources: SourceRecord[], query?: string) {
  if (query === undefined) return undefined
  const candidates = sources.filter(isTeachingModuleSource)
  const exact = candidates.filter((s) => s.path === query)
  const matches = exact.length ? exact : candidates.filter((s) => s.canvasId === query)
  if (matches.length !== 1)
    throw new Error("Module is missing or ambiguous in the original capture; select its exact path")
  return matches[0]
}
function assignmentSources(sources: SourceRecord[], root: string, modulePath?: string) {
  const all = sources.filter(assignment)
  if (!modulePath) return all
  const module = sources.find((s) => s.path === modulePath)
  if (!module) return []
  if (
    module.relatedPaths !== undefined &&
    (!Array.isArray(module.relatedPaths) ||
      !module.relatedPaths.every((path) => typeof path === "string"))
  )
    throw new Error("Captured module relationships are malformed")
  const related = new Set(
    (module.relatedPaths ?? []).map((path) =>
      path.startsWith(`${root}/`) ? path : `${root}/${path}`,
    ),
  )
  return all.filter(
    (s) =>
      related.has(s.path) ||
      (s.moduleCanvasId !== undefined &&
        s.moduleCanvasId === (module.moduleCanvasId ?? module.canvasId)),
  )
}
function directory(vault: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new Error("Window ID must be a UUID")
  return join(resolve(vault), "_meta/simulation-windows", id)
}
async function archiveJournal(
  path: string,
  previous: string,
  text: string,
  guard?: () => Promise<void>,
) {
  const history = join(dirname(path), "history")
  await assertNoSymlinks(history, true)
  await guard?.()
  await mkdir(history, { recursive: true, mode: 0o700 })
  const entries = await readdir(history)
  const hasArchive = entries.includes(`${previous}.json`)
  if (
    entries.length > 500 ||
    (!hasArchive && entries.length === 500) ||
    entries.some((name) => !/^[a-f0-9]{64}\.json$/.test(name))
  )
    throw new Error("Window history is invalid or exceeds 500 checkpoints")
  let totalBytes = hasArchive ? 0 : Buffer.byteLength(text)
  for (const name of entries) {
    const file = join(history, name)
    await assertNoSymlinks(file)
    const stat = await lstat(file)
    if (!stat.isFile() || stat.size > 4_000_000) throw new Error("Unsafe window history")
    totalBytes += stat.size
  }
  if (totalBytes > 100_000_000) throw new Error("Window history exceeds 100 MB")
  const archive = join(history, `${previous}.json`)
  await assertNoSymlinks(archive, true)
  await guard?.()
  try {
    const handle = await open(archive, "wx", 0o600)
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    if ((await readFile(archive, "utf8")) !== text)
      throw new Error("Window history checkpoint changed")
  }
}
async function acquirePlanningLock(path: string) {
  await assertNoSymlinks(path, true)
  await mkdir(path, { mode: 0o700 })
  const owner = await lstat(path)
  const verify = async () => {
    await assertNoSymlinks(path)
    const current = await lstat(path)
    if (!current.isDirectory() || current.dev !== owner.dev || current.ino !== owner.ino)
      throw new Error("Window lock ownership changed; preserve and inspect it")
  }
  return {
    verify,
    release: async () => {
      await verify()
      await rmdir(path)
    },
  }
}
async function save(path: string, record: Record, previous?: string, guard?: () => Promise<void>) {
  await guard?.()
  await assertNoSymlinks(path, true)
  const normalized = recordSchema.parse(record)
  const { hash: _old, ...base } = normalized
  normalized.hash = sha(JSON.stringify(base))
  record.hash = normalized.hash
  const data = JSON.stringify(normalized)
  if (Buffer.byteLength(data) > 4_000_000) throw new Error("Window journal exceeds 4 MB")
  if (previous === undefined) {
    const handle = await open(path, "wx", 0o600)
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
  } else {
    const temporary = `${path}.tmp-${randomUUID()}`
    try {
      const handle = await open(temporary, "wx", 0o600)
      try {
        await handle.writeFile(data)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await assertNoSymlinks(path)
      const oldText = await readFile(path, "utf8")
      if (sha(oldText) !== previous)
        throw new Error("Window journal changed concurrently; preserve it and inspect")
      await guard?.()
      if (record.planningVersion === 1) await archiveJournal(path, previous, oldText, guard)
      await guard?.()
      if (sha(await readFile(path, "utf8")) !== previous)
        throw new Error("Window journal changed concurrently; preserve it and inspect")
      await rename(temporary, path)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }
  return sha(data)
}

/** Create pending host tasks, not generated briefs/drafts or historical truth. */
export async function createSimulationWindow(
  vault: string,
  originalId: string,
  courseCode: string,
  range: string,
  moduleQuery?: string,
  options: PlanningOptions = {},
) {
  const dates = simulationWindowDates(range)
  const original = await replaySimulation(vault, originalId)
  if (original.derivedFrom) throw new Error("Window needs one original capture, not a derived view")
  if (original.course.code.toLowerCase() !== courseCode.toLowerCase())
    throw new Error("Window course must match the original capture's explicit course code")
  if (Date.parse(`${dates.at(-1)}T23:59:59.999Z`) > Date.parse(original.asOf))
    throw new Error("Window end exceeds the original capture cutoff")
  const selectedModule = moduleSource(original.sources, moduleQuery)
  const candidates = assignmentSources(original.sources, original.course.root, selectedModule?.path)
  if (dates.length * (candidates.length + 1) > 250)
    throw new Error("Window may exceed 250 handoffs; narrow its range or module")
  const id = randomUUID()
  const path = directory(vault, id)
  await assertNoSymlinks(path, true)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await assertNoSymlinks(dirname(path))
  await mkdir(path, { mode: 0o700 })
  await assertNoSymlinks(path)
  const file = join(path, "plan.json")
  const record: Record = {
    version: 1,
    planningVersion: 1,
    id,
    createdAt: new Date().toISOString(),
    original: { id: original.id, hash: original.snapshotHash },
    course: original.course,
    range,
    phase: "building",
    weeks: [],
    hash: "0".repeat(64),
    ...(selectedModule ? { module: { path: selectedModule.path, hash: selectedModule.hash } } : {}),
  }
  const lock = join(path, "lock")
  const ownership = await acquirePlanningLock(lock)
  try {
    const journalHash = await save(file, record, undefined, ownership.verify)
    await options.afterCheckpoint?.()
    return await continuePlanning(vault, record, file, journalHash, options, ownership.verify)
  } catch {
    const error = new Error(
      `Window planning or validation failed for ${id}; preserve and inspect its journal/lock before explicit resume`,
    )
    Object.assign(error, { windowId: id })
    throw error
  } finally {
    await ownership.release()
  }
}

async function continuePlanning(
  vault: string,
  record: Record,
  file: string,
  journalHash: string,
  options: PlanningOptions,
  guard: () => Promise<void>,
) {
  const original = await replaySimulation(vault, record.original.id)
  if (
    original.snapshotHash !== record.original.hash ||
    original.derivedFrom ||
    JSON.stringify(original.course) !== JSON.stringify(record.course)
  )
    throw new Error("Window original capture changed")
  const dates = simulationWindowDates(record.range)
  const selectedModule = moduleSource(original.sources, record.module?.path)
  if (record.module && selectedModule?.hash !== record.module.hash)
    throw new Error("Window module binding changed")
  const candidates = assignmentSources(original.sources, record.course.root, record.module?.path)
  if (dates.length * (candidates.length + 1) > 250)
    throw new Error("Window may exceed 250 handoffs")
  for (const [index, cutoff] of dates.entries()) {
    await guard()
    const week = teachingWeek(cutoff)
    let row = record.weeks[index]
    if (row?.phase === "planned") continue
    if (!row) {
      const snapshot = await deriveSimulationCapture(vault, original.id, cutoff)
      const frozen = await replaySimulation(vault, snapshot.id)
      if (frozen.derivedFrom?.hash !== record.original.hash)
        throw new Error("Window original capture changed")
      row = {
        week,
        cutoff,
        snapshot: { id: snapshot.id, hash: snapshot.hash },
        phase: "building",
        tasks: [],
        moduleAvailable: selectedModule
          ? frozen.sources.some((s) => s.path === selectedModule.path)
          : null,
      }
      record.weeks.push(row)
      journalHash = await save(file, record, journalHash, guard)
      await options.afterCheckpoint?.()
    }
    const replay = await replaySimulation(vault, row.snapshot.id)
    if (
      replay.snapshotHash !== row.snapshot.hash ||
      replay.derivedFrom?.id !== record.original.id ||
      replay.derivedFrom.hash !== record.original.hash ||
      replay.asOf !== `${cutoff}T23:59:59.999Z`
    )
      throw new Error("Window cutoff capture binding changed")
    const inputs = [
      { kind: "prep" as const },
      ...assignmentSources(replay.sources, record.course.root, selectedModule?.path).map((s) => ({
        kind: "assignment" as const,
        source: s.path,
      })),
    ]
    for (const input of inputs.slice(row.tasks.length)) {
      await guard()
      let outcome: Outcome
      try {
        const task = await createSimulationTask(
          vault,
          row.snapshot.id,
          input.kind === "prep"
            ? { kind: "prep", week }
            : { kind: "assignment", source: input.source, mode: "draft" },
        )
        const recipe = await readSimulationTask(vault, task.id)
        outcome = { ...input, id: task.id, recipeHash: sha(JSON.stringify(recipe)) }
      } catch {
        // Keep failures explicit and do not echo private source/config bodies.
        outcome = { ...input, failure: "handoff-creation-failed" }
      }
      row.tasks.push(outcome)
      journalHash = await save(file, record, journalHash, guard)
      await options.afterCheckpoint?.()
    }
    row.phase = "planned"
    journalHash = await save(file, record, journalHash, guard)
    await options.afterCheckpoint?.()
  }
  record.phase = "planned"
  await save(file, record, journalHash, guard)
  await options.afterCheckpoint?.()
  return await inspectSimulationWindow(vault, record.id, record.course.code)
}

/** Explicitly finish a versioned partial plan; never retry recorded failures or replace saved tasks. */
export async function resumeSimulationWindow(
  vault: string,
  id: string,
  courseCode: string,
  options: PlanningOptions = {},
) {
  const initial = await readWindowRecord(vault, id)
  if (initial.course.code.toLowerCase() !== courseCode.toLowerCase())
    throw new Error("Window course mismatch")
  if (initial.phase === "planned") return inspectSimulationWindow(vault, id, courseCode)
  if (initial.planningVersion !== 1)
    throw new Error(
      "Legacy incomplete windows have untracked writer ownership; preserve them and create a new explicitly scoped window",
    )
  const lock = join(directory(vault, id), "lock")
  const ownership = await acquirePlanningLock(lock)
  try {
    const record = await readWindowRecord(vault, id)
    if (record.phase === "planned") return inspectSimulationWindow(vault, id, courseCode)
    if (record.planningVersion !== 1)
      throw new Error("Window planning ownership changed; preserve and inspect")
    await inspectSimulationWindow(vault, id, courseCode)
    if (
      record.weeks.some(
        (row, index) => row.phase === "building" && index !== record.weeks.length - 1,
      )
    )
      throw new Error("Window partial rows are not a resumable prefix")
    const file = join(directory(vault, id), "plan.json")
    const current = await readFile(file, "utf8")
    if (JSON.stringify(await readWindowRecord(vault, id)) !== JSON.stringify(record))
      throw new Error("Window journal changed concurrently")
    return await continuePlanning(vault, record, file, sha(current), options, ownership.verify)
  } finally {
    await ownership.release()
  }
}

async function readWindowRecord(vault: string, id: string, budget?: { remaining: number }) {
  const path = join(directory(vault, id), "plan.json")
  await assertNoSymlinks(path)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let text: string
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 4_000_000)
      throw new Error("Window journal exceeds regular-file bounds")
    if (budget) {
      budget.remaining -= stat.size
      if (budget.remaining < 0) throw new Error("Window inventory exceeds 100 MB")
    }
    const buffer = Buffer.alloc(4_000_001)
    let length = 0
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    const bytes = buffer.subarray(0, length)
    if (budget && bytes.length > stat.size) {
      budget.remaining -= bytes.length - stat.size
      if (budget.remaining < 0) throw new Error("Window inventory exceeds 100 MB")
    }
    if (bytes.length > 4_000_000 || !Buffer.from(bytes.toString("utf8")).equals(bytes))
      throw new Error("Invalid window journal text")
    text = bytes.toString("utf8")
  } finally {
    await handle.close()
  }
  let record: Record
  try {
    record = recordSchema.parse(JSON.parse(text))
  } catch {
    throw new Error("Invalid window journal; inspect privately")
  }
  const { hash, ...base } = record
  if (record.id !== id || sha(JSON.stringify(base)) !== hash)
    throw new Error("Window identity, course or hash mismatch")
  return record
}

/** Saved journal discovery only; inspect the selected plan before using its handoffs. */
export async function listSimulationWindows(vault: string, query: string) {
  const course = query.trim()
  if (!course) throw new Error("Choose an explicit captured course code")
  const path = join(resolve(vault), "_meta/simulation-windows")
  await assertNoSymlinks(path, true)
  const entries = await readdir(path, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  })
  if (entries.length > 5000) throw new Error("Window inventory exceeds 5000 entries")
  const budget = { remaining: 100_000_000 }
  const windows: Array<{
    id: string
    createdAt: string
    originalCaptureId: string
    range: string
    phase: Record["phase"]
    recordedCutoffs: number
    recordedHandoffs: number
  }> = []
  let unreadableRecords = 0
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!z.string().uuid().safeParse(entry.name).success) continue
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe window entry")
      const record = await readWindowRecord(vault, entry.name, budget)
      const dates = simulationWindowDates(record.range)
      const handoffs = record.weeks.flatMap((week) => week.tasks)
      const ids = handoffs.flatMap((task) => (task.id ? [task.id] : []))
      if (
        record.weeks.length > dates.length ||
        (record.phase === "planned" && record.weeks.length !== dates.length) ||
        handoffs.length > 250 ||
        new Set(ids).size !== ids.length ||
        record.weeks.some(
          (week, index) =>
            (week.cutoff ?? week.week) !== dates[index] ||
            week.week !== teachingWeek(week.cutoff ?? week.week) ||
            (record.phase === "planned" && week.phase !== "planned"),
        )
      )
        throw new Error("Invalid saved window inventory")
      if (record.course.code.toLowerCase() !== course.toLowerCase()) continue
      windows.push({
        id: record.id,
        createdAt: record.createdAt,
        originalCaptureId: record.original.id,
        range: record.range,
        phase: record.phase,
        recordedCutoffs: record.weeks.length,
        recordedHandoffs: handoffs.length,
      })
    } catch {
      if (budget.remaining < 0) throw new Error("Window inventory exceeds 100 MB")
      unreadableRecords++
    }
  }
  windows.sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id),
  )
  return {
    course,
    windows,
    unreadableRecords,
    inventoryComplete: unreadableRecords === 0,
    limitation:
      "Validated saved journal metadata only. Captures, task recipes, outputs, completion, permission and live workers are not verified; inspect the selected window before continuing. No current course folders are read or records repaired. Unreadable records have unknown course scope and may hide windows.",
  }
}

export async function inspectSimulationWindow(vault: string, id: string, courseCode: string) {
  const record = await readWindowRecord(vault, id)
  if (record.course.code.toLowerCase() !== courseCode.toLowerCase())
    throw new Error("Window identity, course or hash mismatch")
  const original = await replaySimulation(vault, record.original.id)
  if (
    original.derivedFrom ||
    original.snapshotHash !== record.original.hash ||
    JSON.stringify(original.course) !== JSON.stringify(record.course)
  )
    throw new Error("Window original capture changed")
  const dates = simulationWindowDates(record.range)
  if (
    Date.parse(`${dates.at(-1)}T23:59:59.999Z`) > Date.parse(original.asOf) ||
    record.weeks.length > dates.length ||
    (record.phase === "planned" && record.weeks.length !== dates.length)
  )
    throw new Error("Window period inventory is incomplete or out of range")
  if (record.module) {
    const module = moduleSource(original.sources, record.module.path)
    if (module?.hash !== record.module.hash) throw new Error("Window module binding changed")
  }
  const ids = new Set<string>()
  let pending = 0,
    completed = 0,
    unavailable = 0
  const weeks = []
  for (const [index, row] of record.weeks.entries()) {
    const replay = await replaySimulation(vault, row.snapshot.id)
    if (
      (row.cutoff ?? row.week) !== dates[index] ||
      row.week !== teachingWeek(row.cutoff ?? row.week) ||
      replay.snapshotHash !== row.snapshot.hash ||
      replay.derivedFrom?.id !== original.id ||
      replay.derivedFrom.hash !== original.snapshotHash ||
      replay.asOf !== `${row.cutoff ?? row.week}T23:59:59.999Z`
    )
      throw new Error("Window cutoff capture binding changed")
    const available = record.module
      ? replay.sources.some((s) => s.path === record.module?.path)
      : null
    const expected = [
      { kind: "prep", source: undefined },
      ...assignmentSources(replay.sources, record.course.root, record.module?.path).map((s) => ({
        kind: "assignment",
        source: s.path,
      })),
    ]
    if (
      row.moduleAvailable !== available ||
      row.tasks.length > expected.length ||
      (row.phase === "planned" && row.tasks.length !== expected.length) ||
      (record.phase === "planned" && row.phase !== "planned")
    )
      throw new Error("Window handoff inventory changed or is incomplete")
    const tasks = []
    for (const [taskIndex, task] of row.tasks.entries()) {
      if (task.kind !== expected[taskIndex]?.kind || task.source !== expected[taskIndex]?.source)
        throw new Error("Window task selection changed")
      if (!task.id) {
        unavailable++
        tasks.push({ ...task, state: "recorded-creation-failure" })
        continue
      }
      if (ids.has(task.id)) throw new Error("Window contains duplicate task identities")
      ids.add(task.id)
      const recipe = await readSimulationTask(vault, task.id)
      if (
        sha(JSON.stringify(recipe)) !== task.recipeHash ||
        recipe.simulationId !== row.snapshot.id ||
        recipe.options.kind !== task.kind ||
        (task.kind === "prep"
          ? recipe.options.week !== row.week
          : recipe.options.source !== task.source || recipe.options.mode !== "draft")
      )
        throw new Error("Window task recipe binding changed")
      const inspected = await inspectSimulationTask(vault, task.id)
      if (inspected.state === "pending-host") pending++
      else completed++
      tasks.push({ ...task, state: inspected.state })
    }
    weeks.push({ ...row, tasks })
  }
  if (ids.size + unavailable > 250) throw new Error("Window exceeds handoff bounds")
  return {
    id,
    course: record.course,
    range: record.range,
    original: record.original,
    module: record.module ?? null,
    phase: record.phase,
    weeks,
    counts: { pending, completed, unavailable },
    state:
      record.phase !== "planned"
        ? "incomplete-plan"
        : unavailable
          ? "partial-plan"
          : pending
            ? "pending-host"
            : completed
              ? "completed-pending-human"
              : "empty-plan",
    verdict: "pending-human" as const,
    limitation:
      "Weekly pending host handoffs from one current capture, not reconstructed historical visibility or academic grading. Recorded failures remain unverified; incomplete journals are not live jobs and are not automatically resumed or adopted.",
  }
}

export async function compareSimulationWindow(
  vault: string,
  id: string,
  courseCode: string,
  week?: string,
  references: string[] = [],
  feedbackAssignments: string[] = [],
) {
  const plan = await inspectSimulationWindow(vault, id, courseCode)
  if (plan.phase !== "planned")
    throw new Error("Window planning is incomplete; inspect before comparison")
  const weeks =
    week === undefined
      ? plan.weeks
      : plan.weeks.filter((row) => row.week === week || row.cutoff === week)
  if (!weeks.length) throw new Error("Requested week is not in this window")
  const tasks = weeks.flatMap((row) => row.tasks)
  if (tasks.some((task) => task.failure || task.state !== "completed-pending-human"))
    throw new Error(
      "Selected window handoffs are failed or pending; complete and review them first",
    )
  const ids = tasks.flatMap((task) => task.id ?? [])
  if (!ids.length || ids.length > 100)
    throw new Error("Comparison requires 1–100 completed handoffs; select a narrower week")
  return compareSimulationEvaluations(vault, courseCode, ids, references, feedbackAssignments)
}
