import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"

it("records actual synthetic CLI arguments/status/output hashes and refuses config/auth escapes before execution", async () => {
  const created = spawnSync(
    process.execPath,
    [resolve("test/helpers/create-correctness-fixture.mjs"), "--frozen"],
    { encoding: "utf8", timeout: 30_000 },
  )
  expect(created.status, created.stderr).toBe(0)
  const fixture = JSON.parse(created.stdout)
  expect(fixture.root.startsWith(join(tmpdir(), "canvas-host-correctness-frozen-"))).toBe(true)
  try {
    const run = (args: string[]) =>
      spawnSync(
        process.execPath,
        [resolve("test/helpers/run-fixture-cli.mjs"), "--root", fixture.root, "--", ...args],
        { encoding: "utf8", timeout: 30_000 },
      )
    const successful = run(["simulate", "task", "list", "--course", "ECON903"])
    expect(successful.status, successful.stderr).toBe(0)
    const failed = run(["simulate", "list"])
    expect(failed.status).toBe(1)
    const log = join(fixture.root, "actual-cli-commands.jsonl")
    const original = await readFile(log, "utf8")
    const rows = original
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.exitCode)).toEqual([0, 1])
    expect(rows[0].argv.slice(1, 6)).toEqual(["simulate", "task", "list", "--course", "ECON903"])
    expect(rows[0].stdoutHash).toBe(createHash("sha256").update(successful.stdout).digest("hex"))
    expect(rows[1].stderrHash).toBe(createHash("sha256").update(failed.stderr).digest("hex"))
    expect(run(["auth", "verify"]).status).not.toBe(0)
    expect(run(["simulate", "list", "--config=/not-an-owned-config"]).status).not.toBe(0)
    expect(run(["correctness", "save", "invalid", "--file=/not-owned.md"]).status).not.toBe(0)
    expect(await readFile(log, "utf8")).toBe(original)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
}, 30_000)
