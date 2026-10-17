import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { completeTask } from "../../src/tasks/artifacts/completion.js"
import {
  listCorrectnessReviews,
  prepareCorrectnessReview,
  saveCorrectnessReview,
  showCorrectnessReview,
} from "../../src/tasks/review/correctness-review.js"
import { createAssignmentTask } from "../../src/tasks/store.js"
import { calculateTask } from "../helpers/legacy-execution.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(withCalculations = true) {
  const root = await mkdtemp(join(tmpdir(), "canvas-correctness-"))
  roots.push(root)
  const vault = join(root, "vault"),
    prompt = "CS101/Assignments/Case/prompt.md"
  await mkdir(join(vault, "CS101/Assignments/Case"), { recursive: true })
  await writeFile(
    join(vault, prompt),
    "---\ntype: assignment\n---\nSynthetic source figures: cost 2, units 3. Explain the framework.",
  )
  const config = {
    version: 1 as const,
    canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "UNSET_CORRECTNESS_TOKEN" },
    vault: { path: vault },
    courses: { allowlist: [] },
  }
  const configPath = join(root, "config.json")
  await writeFile(configPath, JSON.stringify(config))
  const task = await createAssignmentTask(vault, "CS101", prompt, "draft")
  if (withCalculations)
    await calculateTask(config, {
      taskId: task.id,
      operation: "multiply",
      values: "2,3",
      source: prompt,
    })
  const candidate = join(root, "draft.md")
  await writeFile(
    candidate,
    [
      `Task: ${task.id}`,
      ...task.requirements.map(
        (heading) =>
          `## ${heading}\n${heading === "Sources" ? `\`${prompt}\`` : "Synthetic structural evidence; derived cost is 6."}`,
      ),
    ].join("\n\n"),
  )
  const completed = await completeTask(vault, task.id, candidate)
  const cli = (args: string[]) =>
    spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), ...args, "--config", configPath, "--json"],
      { cwd: root, env: { PATH: process.env.PATH, HOME: root }, encoding: "utf8", timeout: 30_000 },
    )
  return { root, vault, prompt, config, task: completed.task, cli }
}
function note(id: string, prompt: string) {
  return `Review: ${id}\n\n## Verified\n- The recorded multiply operation uses supplied cost 2 and units 3 and recomputes result 6; source attribution still requires review. \`${prompt}\`\n\n## Needs verification\n- No independent academic judgment or course-specific permission was verified in this synthetic engineering fixture. \`${prompt}\`\n`
}

it("hands a separate pass the original draft, sources and recomputed logs; compiled discovery/save preserves originals and retry bytes", async () => {
  const f = await fixture()
  const paths = [
    join(f.vault, f.prompt),
    join(f.vault, "_meta/tasks", f.task.id, "task.json"),
    join(f.vault, f.task.output ?? "missing-output"),
    join(f.vault, "_meta/tasks", f.task.id, "calculations.jsonl"),
  ]
  const originals = await Promise.all(paths.map((path) => readFile(path)))
  const prepared = f.cli(["correctness", "prepare", f.task.id])
  expect(prepared.status, prepared.stderr).toBe(0)
  const review = JSON.parse(prepared.stdout)
  expect(review).toMatchObject({
    status: "pending",
    academicCorrectnessVerified: false,
    independentReviewerVerified: false,
  })
  const handoff = await readFile(review.handoffPath, "utf8")
  expect(handoff).toContain('"operation": "multiply"')
  expect(handoff).toContain('"result": 6')
  expect(handoff).toContain("derived cost is 6")
  expect(handoff).toContain("Synthetic source figures")
  expect(handoff).toContain("Perform a separate correctness-review pass")
  expect((await stat(review.handoffPath)).mode & 0o777).toBe(0o600)
  expect((await prepareCorrectnessReview(f.vault, f.task.id)).id).toBe(review.id)
  const listed = f.cli(["correctness", "list", "--course", "CS101"])
  expect(listed.status, listed.stderr).toBe(0)
  expect(JSON.parse(listed.stdout).reviews).toEqual([
    { id: review.id, taskId: f.task.id, createdAt: review.createdAt },
  ])
  expect((await listCorrectnessReviews(f.vault, "OTHER")).reviews).toEqual([])
  const candidate = join(f.root, "review-note.md")
  await writeFile(candidate, note(review.id, f.prompt))
  const saved = f.cli(["correctness", "save", review.id, "--file", candidate])
  expect(saved.status, saved.stderr).toBe(0)
  const shown = await showCorrectnessReview(f.vault, review.id)
  expect(shown.status).toBe("completed")
  const before = await readFile(shown.reviewPath ?? "missing-review")
  expect((await saveCorrectnessReview(f.vault, review.id, candidate)).reviewHash).toBe(
    shown.reviewHash,
  )
  expect(await readFile(shown.reviewPath ?? "missing-review")).toEqual(before)
  await writeFile(candidate, `${note(review.id, f.prompt)}\nDifferent claim.\n`)
  await expect(saveCorrectnessReview(f.vault, review.id, candidate)).rejects.toThrow(
    /different content/,
  )
  expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(originals)
})

it("makes an empty calculation log explicit and refuses stale, corrupted or substituted evidence without overwriting it", async () => {
  const f = await fixture(false)
  const review = await prepareCorrectnessReview(f.vault, f.task.id)
  expect(await readFile(review.handoffPath, "utf8")).toContain(
    "## Historical recorded calculations\n[]",
  )
  const handoff = await readFile(review.handoffPath)
  await writeFile(join(f.vault, f.prompt), "Changed source")
  await expect(showCorrectnessReview(f.vault, review.id)).rejects.toThrow()
  expect(await readFile(review.handoffPath)).toEqual(handoff)
})

it("rejects corrupted calculation results, unsafe links, credentials and non-substantive review notes", async () => {
  const f = await fixture()
  const log = join(f.vault, "_meta/tasks", f.task.id, "calculations.jsonl")
  const original = await readFile(log, "utf8")
  await writeFile(log, original.replace('"result":6', '"result":7'))
  await expect(prepareCorrectnessReview(f.vault, f.task.id)).rejects.toThrow(/arithmetic/)
  await writeFile(log, original)
  const review = await prepareCorrectnessReview(f.vault, f.task.id)
  const candidate = join(f.root, "note.md")
  await writeFile(
    candidate,
    `Review: ${review.id}\n\n## Verified\n- fine\n\n## Needs verification\n- none\n\`${f.prompt}\``,
  )
  await expect(saveCorrectnessReview(f.vault, review.id, candidate)).rejects.toThrow(/substantive/)
  await writeFile(
    candidate,
    `${note(review.id, f.prompt)}\npassword=synthetic-canary-not-a-real-secret\n`,
  )
  await expect(saveCorrectnessReview(f.vault, review.id, candidate)).rejects.toThrow(/credentials/)
  const linked = join(f.root, "linked.md")
  await symlink(candidate, linked)
  await expect(saveCorrectnessReview(f.vault, review.id, linked)).rejects.toThrow()
  expect((await showCorrectnessReview(f.vault, review.id)).status).toBe("pending")
})

it("does not downgrade a completed review to pending when its note disappears", async () => {
  const f = await fixture()
  const review = await prepareCorrectnessReview(f.vault, f.task.id)
  const candidate = join(f.root, "note.md")
  await writeFile(candidate, note(review.id, f.prompt))
  const completed = await saveCorrectnessReview(f.vault, review.id, candidate)
  await rm(completed.reviewPath ?? "missing-review")
  await expect(showCorrectnessReview(f.vault, review.id)).rejects.toThrow()
  await expect(saveCorrectnessReview(f.vault, review.id, candidate)).rejects.toThrow()
})

it("finishes an interrupted matching note save but preserves a differing partial artifact", async () => {
  const f = await fixture()
  const review = await prepareCorrectnessReview(f.vault, f.task.id)
  const candidate = join(f.root, "review.md")
  const body = note(review.id, f.prompt)
  await writeFile(candidate, body)
  const savedPath = join(f.vault, "_meta/correctness-reviews", review.id, "review.md")
  await writeFile(savedPath, "Partial student-owned note; inspect rather than overwrite.")
  await expect(saveCorrectnessReview(f.vault, review.id, candidate)).rejects.toThrow(/differs/)
  expect(await readFile(savedPath, "utf8")).toBe(
    "Partial student-owned note; inspect rather than overwrite.",
  )
  // Fixture models an interrupted matching write before receipt installation,
  // not an actual process kill or automatic repair of the preceding partial file.
  await writeFile(savedPath, body)
  const before = await readFile(savedPath)
  expect((await saveCorrectnessReview(f.vault, review.id, candidate)).status).toBe("completed")
  expect(await readFile(savedPath)).toEqual(before)
})

it("bounds completed draft reads before assembling a review handoff", async () => {
  const f = await fixture()
  const path = join(f.vault, f.task.output ?? "missing-output")
  await truncate(path, 5 * 1024 * 1024 + 1)
  await expect(prepareCorrectnessReview(f.vault, f.task.id)).rejects.toThrow(/bound/)
  expect((await listCorrectnessReviews(f.vault, "CS101")).reviews).toEqual([])
})

it("allows citations to the validated draft under review but not another draft path", async () => {
  const f = await fixture()
  const review = await prepareCorrectnessReview(f.vault, f.task.id)
  const candidate = join(f.root, "review.md")
  await writeFile(
    candidate,
    `${note(review.id, f.prompt)}\nThe draft claim being reviewed appears in \`${f.task.output}\`.\n`,
  )
  expect((await saveCorrectnessReview(f.vault, review.id, candidate)).status).toBe("completed")
  const other = await fixture()
  const otherReview = await prepareCorrectnessReview(other.vault, other.task.id)
  const otherCandidate = join(other.root, "review.md")
  await writeFile(
    otherCandidate,
    `${note(otherReview.id, other.prompt)}\nClaim appears in \`CS101/Assignments/other-draft.md\`.\n`,
  )
  await expect(saveCorrectnessReview(other.vault, otherReview.id, otherCandidate)).rejects.toThrow(
    /exact task source/,
  )
})

it("replays the retained forward-host note against the original synthetic sources and preserves the six-file baseline", async () => {
  const created = spawnSync(
    process.execPath,
    [resolve("test/helpers/create-correctness-fixture.mjs")],
    { encoding: "utf8", timeout: 30_000 },
  )
  expect(created.status, created.stderr).toBe(0)
  const fixture = JSON.parse(created.stdout)
  expect(fixture.root.startsWith(join(tmpdir(), "canvas-host-correctness-"))).toBe(true)
  roots.push(fixture.root)
  const vault = join(fixture.root, "vault")
  const cli = (args: string[]) =>
    spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), ...args, "--config", fixture.config, "--json"],
      {
        cwd: fixture.root,
        env: { PATH: process.env.PATH, HOME: join(fixture.root, "home") },
        encoding: "utf8",
        timeout: 30_000,
      },
    )
  const listed = cli(["task", "list", "--course", "ECON903", "--status", "completed"])
  expect(listed.status, listed.stderr).toBe(0)
  const tasks = JSON.parse(listed.stdout).tasks
  expect(tasks).toHaveLength(1)
  const review = await prepareCorrectnessReview(vault, tasks[0].id)
  const noteText = (
    await readFile(resolve("test/fixtures/host-correctness/review.md"), "utf8")
  ).replace("{{REVIEW_ID}}", review.id)
  const candidate = join(fixture.root, "replayed-review.md")
  await writeFile(candidate, noteText)
  const saved = await saveCorrectnessReview(vault, review.id, candidate)
  expect(saved.status).toBe("completed")
  expect(await readFile(saved.reviewPath ?? "missing-review", "utf8")).toBe(noteText)
  expect((await saveCorrectnessReview(vault, review.id, candidate)).reviewHash).toBe(
    saved.reviewHash,
  )
  const baseline = JSON.parse(await readFile(join(fixture.root, "baseline.json"), "utf8"))
  expect(baseline).toHaveLength(6)
  const { createHash } = await import("node:crypto")
  for (const entry of baseline)
    expect(
      createHash("sha256")
        .update(await readFile(join(vault, entry.path)))
        .digest("hex"),
    ).toBe(entry.hash)
})
