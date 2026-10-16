import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { readTaskOutput } from "../../src/cli/task-output.js"
import { captureSimulation } from "../../src/simulation/captures.js"
import { completeSimulationTask, createSimulationTask } from "../../src/simulation/tasks.js"
import { completeTask } from "../../src/tasks/artifacts/completion.js"
import { approveTask, reviseTask } from "../../src/tasks/artifacts/lifecycle.js"
import { taskInspectionCommand, taskLocations } from "../../src/tasks/artifacts/locations.js"
import { createPrepTask } from "../../src/tasks/store.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const id = "d745a51d-74c5-479b-9af3-693098bd6a73"
it("resolves safe paths and command argv from explicit config/vault, not the working directory", () => {
  const result = taskLocations(
    "/tmp/config with spaces.json",
    "/tmp/vault with spaces",
    id,
    "ordinary",
    "CS101/Prep/brief.md",
    "CS101/Prep/brief.xlsx",
  )
  expect(result.locations).toMatchObject({
    config: "/tmp/config with spaces.json",
    vaultRoot: "/tmp/vault with spaces",
    record: `/tmp/vault with spaces/_meta/tasks/${id}/task.json`,
    output: "/tmp/vault with spaces/CS101/Prep/brief.md",
    workbook: "/tmp/vault with spaces/CS101/Prep/brief.xlsx",
    pathsExistenceVerified: false,
  })
  expect(result.inspectionCommand).toEqual([
    "task",
    "show",
    id,
    "--config",
    "/tmp/config with spaces.json",
    "--json",
  ])
  expect(taskInspectionCommand("frozen", id, "/tmp/config.json").slice(0, 4)).toEqual([
    "simulate",
    "task",
    "show",
    id,
  ])
  expect(taskLocations("/tmp/config.json", "/tmp/vault", id, "frozen").locations.output).toBeNull()
})

it.each([
  "../escape.md",
  "/absolute.md",
  "C:/escape.md",
  "a\\escape.md",
  "a//b.md",
  "a/./b.md",
  "a/../b.md",
  "a\u0000b.md",
  "",
])("rejects unsafe artifact path %j", (path) => {
  expect(() => taskLocations("/tmp/config.json", "/tmp/vault", id, "ordinary", path)).toThrow(
    "Unsafe saved task artifact path",
  )
})

it.each(["ordinary", "frozen"] as const)(
  "reports correct %s paths and listing commands across workspace roots without rewriting records",
  async (scope) => {
    const root = await mkdtemp(join(tmpdir(), "canvas-task-locations-"))
    roots.push(root)
    const vault = join(root, "vault elsewhere"),
      workspace = join(root, "new workspace"),
      config = join(root, "config.json")
    await mkdir(workspace)
    const source = "CS101/Week 01 - Oct 12/reading.md"
    await mkdir(join(vault, "CS101/Week 01 - Oct 12"), { recursive: true })
    await writeFile(
      join(vault, source),
      "---\navailable_at: 2026-10-12\n---\nA synthetic framework compares marginal benefits with avoidable costs. This invented engineering case is not real coursework.",
    )
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        canvas: { baseUrl: "https://canvas.example.invalid", tokenEnv: "UNSET_PATH_TEST" },
        vault: { path: vault },
        courses: { allowlist: [] },
      }),
    )
    const frozen = scope === "frozen"
    const created = frozen
      ? await createSimulationTask(
          vault,
          (await captureSimulation(vault, "CS101", "2026-10-14")).id,
          { kind: "prep", week: "2026-10-12" },
        )
      : await createPrepTask(vault, "CS101", "2026-10-12")
    const cli = (args: string[]) => {
      const result = spawnSync(
        process.execPath,
        [resolve("dist/cli.js"), ...args, "--config", config, "--json"],
        {
          cwd: workspace,
          env: { PATH: process.env.PATH, HOME: workspace },
          encoding: "utf8",
          timeout: 30_000,
        },
      )
      expect(result.status, result.stderr).toBe(0)
      return JSON.parse(result.stdout)
    }
    const showArgs = frozen
      ? ["simulate", "task", "show", created.id]
      : ["task", "show", created.id]
    const pending = cli(showArgs)
    await expect(readTaskOutput(config, vault, created.id, scope)).rejects.toThrow(
      /not completed|no completed/,
    )
    expect(pending.scope).toBe(scope)
    expect(pending.locations.output).toBeNull()
    expect(pending.locations.vaultRoot).toBe(vault)
    const record = pending.locations.record
    const pendingBytes = await readFile(record)
    const listed = cli(
      frozen
        ? ["simulate", "task", "list", "--course", "CS101"]
        : ["task", "list", "--course", "CS101"],
    )
    expect(listed.scope).toBe(scope)
    const command = listed.tasks.find(
      (row: { id: string }) => row.id === created.id,
    ).inspectionCommand
    // The returned array already includes explicit config/json, and is directly executable.
    const recovered = spawnSync(process.execPath, [resolve("dist/cli.js"), ...command], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 30_000,
    })
    expect(recovered.status, recovered.stderr).toBe(0)
    expect(JSON.parse(recovered.stdout).locations).toEqual(pending.locations)
    expect(await readFile(record)).toEqual(pendingBytes)
    const task = frozen ? pending.task : pending
    const candidate = join(root, "candidate.md")
    await writeFile(
      candidate,
      [
        `Task: ${created.id}`,
        ...task.requirements.map(
          (heading: string) =>
            `## ${heading}\n\nThis synthetic framework compares avoidable costs and marginal benefits without inventing student experience or empirical observations. \`${source}\``,
        ),
      ].join("\n\n"),
    )
    if (frozen) await completeSimulationTask(vault, created.id, candidate)
    else await completeTask(vault, created.id, candidate)
    const completedBytes = await readFile(record)
    const shown = cli(showArgs)
    expect(shown.locations.output.startsWith(`${vault}/`)).toBe(true)
    expect(await readFile(shown.locations.output)).toEqual(await readFile(candidate))
    expect(shown.locations.record).toBe(record)
    expect(await readFile(record)).toEqual(completedBytes)
    const outputArgs = frozen
      ? ["simulate", "task", "output", created.id]
      : ["task", "output", created.id]
    const returned = cli(outputArgs)
    expect(returned).toMatchObject({
      id: created.id,
      scope,
      outputIntegrityVerified: true,
      sourceCurrentnessVerified: false,
      academicCorrectnessVerified: false,
      permissionVerified: false,
    })
    expect(returned.text).toBe(await readFile(candidate, "utf8"))
    const plain = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), ...outputArgs, "--config", config],
      { cwd: workspace, encoding: "utf8", timeout: 30_000 },
    )
    expect(plain.status, plain.stderr).toBe(0)
    expect(plain.stdout).toBe(returned.text)
    expect(returned.locations.output).toBe(shown.locations.output)
    expect(await readFile(record)).toEqual(completedBytes)
    if (!frozen) {
      await expect(approveTask(vault, created.id)).rejects.toThrow(/assignment|draft/)
      await expect(reviseTask(vault, created.id, "synthetic feedback")).rejects.toThrow(
        /assignment|draft/,
      )
    }
    // Ordinary readers use saved evidence; frozen readers must never substitute live files.
    await writeFile(join(vault, source), "NEWER_LIVE_SOURCE_NOT_IN_SAVED_OUTPUT")
    expect(cli(outputArgs).text).toBe(returned.text)
    const savedBytes = await readFile(shown.locations.output)
    await writeFile(shown.locations.output, "PRIVATE_MODIFIED_OUTPUT_SENTINEL")
    await expect(readTaskOutput(config, vault, created.id, scope)).rejects.toThrow(
      /modified|changed/,
    )
    const failed = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), ...outputArgs, "--config", config, "--json"],
      { cwd: workspace, encoding: "utf8", timeout: 30_000 },
    )
    expect(failed.status).toBe(1)
    expect(failed.stdout + failed.stderr).not.toContain("PRIVATE_MODIFIED_OUTPUT_SENTINEL")
    await rm(shown.locations.output)
    await expect(readTaskOutput(config, vault, created.id, scope)).rejects.toThrow()
    const linked = join(root, "linked-output.md")
    await writeFile(linked, savedBytes)
    await symlink(linked, shown.locations.output)
    await expect(readTaskOutput(config, vault, created.id, scope)).rejects.toThrow(/link/i)
    await rm(shown.locations.output)
    await writeFile(shown.locations.output, "")
    await truncate(shown.locations.output, 5 * 1024 * 1024 + 1)
    await expect(readTaskOutput(config, vault, created.id, scope)).rejects.toThrow(/bound/)
    await writeFile(shown.locations.output, savedBytes)
    expect(cli(outputArgs).text).toBe(returned.text)
    expect(await readFile(record)).toEqual(completedBytes)
    if (!frozen) {
      const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), savedBytes])
      const metadata = JSON.parse(completedBytes.toString())
      metadata.outputHash = createHash("sha256").update(withBom).digest("hex")
      await writeFile(record, JSON.stringify(metadata))
      await writeFile(shown.locations.output, withBom)
      expect(Buffer.from(cli(outputArgs).text)).toEqual(withBom)
      const invalid = Buffer.from([0xff])
      metadata.outputHash = createHash("sha256").update(invalid).digest("hex")
      await writeFile(record, JSON.stringify(metadata))
      await writeFile(shown.locations.output, invalid)
      await expect(readTaskOutput(config, vault, created.id, scope)).rejects.toThrow("safe UTF-8")
      for (const unsafe of [
        "secret=PRIVATE_SYNTHETIC_SECRET",
        "_meta/private/PRIVATE_SYNTHETIC_PATH",
        "/credentials.json",
      ]) {
        metadata.outputHash = createHash("sha256").update(unsafe).digest("hex")
        await writeFile(record, JSON.stringify(metadata))
        await writeFile(shown.locations.output, unsafe)
        await expect(readTaskOutput(config, vault, created.id, scope)).rejects.toThrow(
          /credential|private metadata/,
        )
        const refused = spawnSync(
          process.execPath,
          [resolve("dist/cli.js"), ...outputArgs, "--config", config, "--json"],
          { cwd: workspace, encoding: "utf8", timeout: 30_000 },
        )
        expect(refused.status).toBe(1)
        expect(refused.stdout + refused.stderr).not.toContain("PRIVATE_SYNTHETIC")
      }
      await writeFile(record, completedBytes)
      await writeFile(shown.locations.output, savedBytes)
      expect(cli(outputArgs).text).toBe(returned.text)
    }
  },
  30000,
)
