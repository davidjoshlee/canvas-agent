import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { readHostUsage, renderHostUsage } from "../../src/evaluation/host-usage.js"

const roots: string[] = []
const now = new Date("2026-10-11T12:00:00Z")
const row = {
  id: "run-1",
  at: "2026-10-10T12:00:00Z",
  function: "prep",
  model: "host/example-model",
  source: "host-reported",
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: 30,
  costUsd: "0.000000001",
}
async function fixture(rows: unknown[] = [row]) {
  const root = await mkdtemp(join(tmpdir(), "canvas-host-usage-"))
  roots.push(root)
  const file = join(root, "usage.json")
  await writeFile(file, JSON.stringify({ version: 1, host: "Chosen-host", rows }))
  return { root, file }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
it("sums exact supplied costs, groups by function/model/source and preserves export bytes", async () => {
  const { file } = await fixture([
    row,
    { ...row, id: "run-2", costUsd: "0.000000002" },
    { ...row, id: "older", at: "2026-09-01T00:00:00Z" },
  ])
  const before = await readFile(file)
  const result = await readHostUsage(file, { now })
  expect(result.totals.costUsd.total).toBe("0.000000003")
  expect(result.totals.inputTokens.total).toBe(200)
  expect(result.totals.uncachedInputTokens.total).toBe(140)
  expect(result.groups).toHaveLength(1)
  expect(result.excludedRows).toBe(1)
  expect(result.authoritativeBillingVerified).toBe(false)
  expect(await readFile(file)).toEqual(before)
})
it("keeps missing costs/tokens and empty windows unknown rather than inventing zero spend", async () => {
  const { file } = await fixture([
    row,
    {
      ...row,
      id: "unknown",
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    },
  ])
  const result = await readHostUsage(file, { now })
  expect(result.totals.costUsd).toEqual({
    total: null,
    knownSubtotal: "0.000000001",
    missingRows: 1,
  })
  expect(result.totals.inputTokens.total).toBeNull()
  expect(result.totals.uncachedInputTokens).toEqual({
    total: null,
    knownSubtotal: 70,
    missingRows: 1,
  })
  const empty = await readHostUsage(file, { now: new Date("2026-11-11T00:00:00Z") })
  expect(empty.totals.rows).toBe(0)
  expect(empty.totals.costUsd.total).toBeNull()
  expect(renderHostUsage(empty)).toContain("unknown (no rows)")
})
it("renders grouped terminal usage with exact decimals and explicit unknown partial totals", async () => {
  const { file } = await fixture([
    row,
    {
      ...row,
      id: "draft",
      function: "draft",
      source: "estimated",
      cachedInputTokens: null,
      costUsd: null,
    },
  ])
  const report = await readHostUsage(file, { now })
  const rendered = renderHostUsage(report)
  expect(rendered).toContain(
    "function\tmodel\trows\tinput\toutput\tcached\tuncached\tcost_usd\tsource",
  )
  expect(rendered).toContain(
    "prep\thost/example-model\t1\t100\t20\t30\t70\t0.000000001\thost-reported",
  )
  expect(rendered).toContain("draft\thost/example-model\t1\t100\t20\tunknown")
  expect(rendered).toContain("unknown (known 0.000000001; missing 1)")
  expect(rendered).toContain("not complete account spend")
  expect(
    report.groups.find((group) => group.function === "draft")?.uncachedInputTokens.total,
  ).toBeNull()
})
it.each(
  [
    [row, row],
    [{ ...row, cachedInputTokens: 101 }],
    [{ ...row, model: "sk-secret-example" }],
    [{ ...row, costUsd: "-1" }],
    [{ ...row, token: "PRIVATE SECRET" }],
  ].map((rows) => ({ rows })),
)("rejects unsafe or double-counting exports without echoing values", async ({ rows }) => {
  const { file } = await fixture(rows)
  await expect(readHostUsage(file, { now })).rejects.toThrow(/Invalid host usage export/)
})
it("rejects relative/credential/symlink inputs and reports through the compiled CLI", async () => {
  const { root, file } = await fixture([{ ...row, at: new Date().toISOString() }])
  await expect(readHostUsage("relative.json")).rejects.toThrow(/absolute/)
  await expect(readHostUsage(join(root, ".env"))).rejects.toThrow(/non-credential/)
  const linked = join(root, "linked.json")
  await symlink(file, linked)
  await expect(readHostUsage(linked)).rejects.toThrow(/Symbolic links/)
  const config = join(root, "config.json")
  const cli = (args: string[]) =>
    spawnSync(process.execPath, [resolve("dist/cli.js"), ...args, "--config", config, "--json"], {
      encoding: "utf8",
    })
  expect(
    cli(["init", "--vault", join(root, "vault"), "--canvas-url", "https://canvas.example.test"])
      .status,
  ).toBe(0)
  const output = cli(["cost", "--file", file, "--weeks", "4"])
  expect(output.status, output.stderr).toBe(0)
  expect(JSON.parse(output.stdout)).toMatchObject({
    authoritativeBillingVerified: false,
    totals: { rows: 1 },
  })
  const human = spawnSync(
    process.execPath,
    [resolve("dist/cli.js"), "cost", "--file", file, "--config", config],
    { encoding: "utf8" },
  )
  expect(human.status, human.stderr).toBe(0)
  expect(human.stdout).toContain(
    "prep\thost/example-model\t1\t100\t20\t30\t70\t0.000000001\thost-reported",
  )
  expect(human.stdout).toContain("TOTAL\t")
  await writeFile(file, "PRIVATE_SECRET_LITERAL_NOT_JSON")
  const malformed = cli(["cost", "--file", file])
  expect(malformed.status).toBe(1)
  expect(malformed.stderr).not.toContain("PRIVATE_SECRET_LITERAL")
})
