import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readFile, rmdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { assertNoSymlinks } from "../../src/shared/fs-safety.js"

/** Expected empty-journal state, distinct from corruption or an unsafe journal. */
export class MissingDogfoodCheckpointError extends Error {
  readonly code = "DOGFOOD_CHECKPOINT_MISSING"
  constructor() {
    super("Dogfood journal has no checkpoint")
    this.name = "MissingDogfoodCheckpointError"
  }
}

export function isUninitializedDogfoodRun(error: unknown): boolean {
  return (
    error instanceof MissingDogfoodCheckpointError ||
    (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
  )
}

export const dogfoodFlowNames = [
  "sync",
  "timeline",
  "guidance note",
  "prep brief",
  "draft",
  "co-edit",
  "approve",
  "token-renewal alert",
  "gaps re-check",
] as const
const legacyDogfoodFlowNames = [...dogfoodFlowNames, "cost report"] as const
const flowNameSchema = z.enum(legacyDogfoodFlowNames)
const targetSchema = z
  .object({
    course: z.string().min(1).max(200),
    period: z
      .object({ kind: z.enum(["week", "session"]), value: z.string().min(1).max(200) })
      .strict(),
    assignment: z.string().min(1).max(1000).nullable(),
  })
  .strict()
const resultSchema = z
  .object({
    name: flowNameSchema,
    status: z.enum(["pass", "fail", "pending-host", "pending-human", "skipped"]),
    evidence: z.string().max(2000),
    nextSteps: z.string().max(4000).default(""),
    data: z.record(z.string().min(1).max(100), z.string().max(2000)).default({}),
  })
  .strict()
const journalSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    id: z.string().uuid(),
    startedAt: z.string().datetime(),
    target: targetSchema,
    flows: z.array(resultSchema).max(10),
  })
  .strict()
  .superRefine((record, ctx) => {
    const names = record.version === 1 ? legacyDogfoodFlowNames : dogfoodFlowNames
    if (record.flows.some((flow, index) => flow.name !== names[index]))
      ctx.addIssue({ code: "custom", message: "Dogfood results must preserve their flow order" })
  })
export type DogfoodTarget = z.infer<typeof targetSchema>
export type DogfoodResult = z.infer<typeof resultSchema>
export type DogfoodJournal = z.infer<typeof journalSchema>
export interface DogfoodFlow {
  name: (typeof legacyDogfoodFlowNames)[number]
  run(prior: DogfoodResult | undefined, journal: DogfoodJournal): Promise<DogfoodResult>
  // Reuse only after fresh inspection of the actual evidence. Returning false
  // forces the flow to run again; a thrown validation error fails closed.
  validate(result: DogfoodResult, journal: DogfoodJournal): Promise<boolean>
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex")
function directory(vault: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new Error("Dogfood run ID must be a UUID")
  return join(resolve(vault), "_meta/dogfood", id)
}
async function readCheckpoint(path: string, budget?: { remaining: number }) {
  await assertNoSymlinks(path)
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size > 1_000_000) throw new Error("Unsafe dogfood checkpoint")
  if (budget) {
    budget.remaining -= stat.size
    if (budget.remaining < 0) throw new Error("Dogfood inventory exceeds 100 MB")
  }
  const bytes = await readFile(path)
  if (bytes.includes(0) || !Buffer.from(bytes.toString()).equals(bytes))
    throw new Error("Unsafe dogfood checkpoint text")
  const envelope = z
    .object({ payload: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .parse(JSON.parse(bytes.toString()))
  if (digest(envelope.payload) !== envelope.hash)
    throw new Error("Dogfood checkpoint hash mismatch")
  return journalSchema.parse(JSON.parse(envelope.payload))
}
async function saveCheckpoint(path: string, journal: DogfoodJournal) {
  const payload = JSON.stringify(journalSchema.parse(journal))
  await assertNoSymlinks(path, true)
  await writeFile(path, JSON.stringify({ payload, hash: digest(payload) }), {
    flag: "wx",
    mode: 0o600,
  })
}
async function checkpoints(path: string) {
  await assertNoSymlinks(path)
  const entries = await readdir(path)
  if (entries.length > 10_001) throw new Error("Dogfood journal exceeds checkpoint limit")
  if (entries.some((entry) => entry !== "lock" && !/^\d{6}\.json$/.test(entry)))
    throw new Error("Unknown entry in dogfood journal")
  const files = entries.filter((entry) => /^\d{6}\.json$/.test(entry)).sort()
  if (files.length > 10_000) throw new Error("Dogfood journal exceeds checkpoint limit")
  if (files.some((file, index) => file !== `${String(index).padStart(6, "0")}.json`))
    throw new Error("Dogfood checkpoint sequence is incomplete")
  return files
}
export async function readDogfood(vault: string, id: string, budget?: { remaining: number }) {
  const path = directory(vault, id),
    files = await checkpoints(path)
  if (!files.length) throw new MissingDogfoodCheckpointError()
  let previous: DogfoodJournal | undefined
  for (const file of files) {
    const current = await readCheckpoint(join(path, file), budget)
    if (
      current.id !== id ||
      (previous &&
        (current.startedAt !== previous.startedAt ||
          JSON.stringify(current.target) !== JSON.stringify(previous.target)))
    )
      throw new Error("Dogfood journal identity/target changed")
    previous = current
  }
  return previous as DogfoodJournal
}

/** Discover saved journals only; reading a checkpoint never establishes a live worker. */
export async function listDogfood(vault: string, course: string) {
  if (!course.trim()) throw new Error("Choose an explicit dogfood course")
  const path = join(resolve(vault), "_meta/dogfood")
  await assertNoSymlinks(path, true)
  const entries = await readdir(path, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  })
  if (entries.length > 5000) throw new Error("Dogfood inventory exceeds 5000 entries")
  const budget = { remaining: 100_000_000 }
  const runs: Array<{
    id: string
    startedAt: string
    period: DogfoodTarget["period"]
    assignment: string | null
    recordedFlows: number
    lastCheckpoint: { name: DogfoodResult["name"]; status: DogfoodResult["status"] } | null
  }> = []
  let unreadableRecords = 0
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!z.string().uuid().safeParse(entry.name).success) continue
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe journal entry")
      const journal = await readDogfood(vault, entry.name, budget)
      if (journal.target.course !== course) continue
      const last = journal.flows.at(-1)
      runs.push({
        id: journal.id,
        startedAt: journal.startedAt,
        period: journal.target.period,
        assignment: journal.target.assignment,
        recordedFlows: journal.flows.length,
        lastCheckpoint: last ? { name: last.name, status: last.status } : null,
      })
    } catch {
      if (budget.remaining < 0)
        throw new Error("Dogfood inventory exceeds 100 MB; narrow the workspace")
      unreadableRecords++
    }
  }
  runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.id.localeCompare(b.id))
  return {
    course,
    runs,
    unreadableRecords,
    inventoryComplete: unreadableRecords === 0,
    limitation:
      "Saved checkpoint metadata only, not a live job, fresh evidence validation or academic verdict. Unreadable records have unknown course scope. Inspect the selected run before explicit resume; locks are not proof of a worker and must not be blindly deleted.",
  }
}
export async function createDogfood(
  vault: string,
  targetInput: DogfoodTarget,
  id: string = randomUUID(),
) {
  const target = targetSchema.parse(targetInput),
    path = directory(vault, id)
  await assertNoSymlinks(path, true)
  await mkdir(path, { recursive: true, mode: 0o700 })
  await assertNoSymlinks(path)
  if ((await readdir(path)).length)
    throw new Error("Dogfood initialization refuses a nonempty run directory")
  const journal: DogfoodJournal = {
    version: 2,
    id,
    startedAt: new Date().toISOString(),
    target,
    flows: [],
  }
  await saveCheckpoint(join(path, "000000.json"), journal)
  return journal
}
export async function runDogfood(
  vault: string,
  id: string,
  targetInput: DogfoodTarget,
  flows: DogfoodFlow[],
) {
  const target = targetSchema.parse(targetInput)
  if (
    flows.length !== dogfoodFlowNames.length ||
    flows.some((flow, index) => flow.name !== dogfoodFlowNames[index])
  )
    throw new Error("Dogfood requires the nine ordered concrete flows")
  const path = directory(vault, id),
    lock = join(path, "lock")
  await assertNoSymlinks(path)
  // Never guess stale-lock ownership or delete a different runner's lock.
  await mkdir(lock, { mode: 0o700 })
  try {
    const journal = await readDogfood(vault, id)
    if (JSON.stringify(journal.target) !== JSON.stringify(target))
      throw new Error("Dogfood target does not match the saved run")
    // Version 1 runs retain their historical tenth checkpoint and ID. New runs
    // use version 2 and omit the permanently skipped host-cost slot.
    const runFlows: DogfoodFlow[] =
      journal.version === 1
        ? [
            ...flows,
            {
              name: "cost report",
              async validate(result) {
                return result.status === "skipped" && result.data.owner === "host"
              },
              async run() {
                return {
                  name: "cost report",
                  status: "skipped",
                  evidence: "Usage and billing belong to the selected coding host",
                  nextSteps: "",
                  data: { owner: "host" },
                }
              },
            },
          ]
        : flows
    let sequence = (await checkpoints(path)).length
    for (let index = 0; index < runFlows.length; index++) {
      const flow = runFlows[index],
        prior = journal.flows[index]
      if (!flow) throw new Error("Dogfood flow is missing")
      let result: DogfoodResult
      try {
        if (
          prior &&
          ["pass", "skipped"].includes(prior.status) &&
          (await flow.validate(prior, journal))
        )
          continue
        result = resultSchema.parse(await flow.run(prior, journal))
        if (result.name !== flow.name) throw new Error("Flow result identity differs")
      } catch {
        // Exceptions may contain tokens or source bodies. Report a bounded
        // generic failure instead of copying arbitrary errors into the journal.
        result = {
          name: flow.name,
          status: "fail",
          evidence: "Flow execution or evidence validation failed",
          nextSteps: "Inspect this flow locally before resuming; later flows were not run.",
          data: prior?.data ?? {},
        }
      }
      journal.flows = [...journal.flows.slice(0, index), result]
      if (sequence >= 10_000) throw new Error("Dogfood checkpoint limit reached; start a new run")
      await saveCheckpoint(join(path, `${String(sequence++).padStart(6, "0")}.json`), journal)
      if (!["pass", "skipped"].includes(result.status)) break
    }
    return journal
  } finally {
    await rmdir(lock)
  }
}
