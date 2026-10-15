import { spawnSync } from "node:child_process"
import { readFile, realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { expect, it } from "vitest"

it("retains a private terminal command journal when the package operator cannot launch npm", async () => {
  const sentinel = "PRIVATE_SYNTHETIC_JOURNAL_ENV"
  const result = spawnSync(process.execPath, [resolve("scripts/package-smoke.mjs")], {
    cwd: resolve("."),
    env: { PATH: "", TMPDIR: tmpdir(), CANVAS_JOURNAL_TEST_SECRET: sentinel },
    encoding: "utf8",
    timeout: 15_000,
    killSignal: "SIGKILL",
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stdout + result.stderr).not.toContain(sentinel)
  const receipt = result.stderr
    .split("\n")
    .filter((line) => line.startsWith('{"status":"failed",'))
    .map((line) => JSON.parse(line))[0] as {
    retainedSyntheticFixture: string
    journal: string
  }
  expect(receipt).toBeDefined()
  const root = receipt.retainedSyntheticFixture
  expect(basename(root)).toMatch(/^canvas-agent-package-[\w-]+$/)
  expect(await realpath(dirname(root))).toBe(await realpath(tmpdir()))
  try {
    expect(receipt.journal).toBe(join(root, "commands.jsonl"))
    const text = await readFile(receipt.journal, "utf8")
    expect(text).not.toContain(sentinel)
    const rows = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ id: 1, event: "started" })
    expect(rows[1]).toMatchObject({
      id: 1,
      event: "finished",
      status: null,
      errorCode: "ENOENT",
    })
    expect(rows[1].elapsedMs).toBeGreaterThanOrEqual(0)
    expect(rows.every((row) => !("env" in row) && !("stdout" in row) && !("stderr" in row))).toBe(
      true,
    )
    if (process.platform !== "win32") expect((await stat(receipt.journal)).mode & 0o777).toBe(0o600)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
