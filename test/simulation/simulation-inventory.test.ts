import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  captureSimulation,
  deriveSimulationCapture,
  listSimulationCaptures,
} from "../../src/simulation/captures.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-capture-inventory-"))
  roots.push(root)
  const vault = join(root, "vault")
  for (const code of ["CS101", "ECON101"]) {
    await mkdir(join(vault, code, "Week 01 - Oct 5"), { recursive: true })
    await writeFile(
      join(vault, code, "Week 01 - Oct 5/reading.md"),
      `---\navailable_at: 2026-10-05\n---\n${code}_PRIVATE_CAPTURE_BODY: substantive marginal cost evidence.\n`,
    )
  }
  const own = await captureSimulation(vault, "CS101", "2026-10-12")
  const derived = await deriveSimulationCapture(vault, own.id, "2026-10-06")
  const other = await captureSimulation(vault, "ECON101", "2026-10-12")
  return { root, vault, own, derived, other }
}

it("discovers original and derived captures from fresh processes after live course folders are unavailable", async () => {
  const { root, vault, own, derived, other } = await fixture()
  const paths = [own, derived, other].map((capture) => join(vault, capture.path))
  const before = await Promise.all(paths.map((path) => readFile(path)))
  await rename(join(vault, "CS101"), join(root, "retained-CS101"))
  await rename(join(vault, "ECON101"), join(root, "retained-ECON101"))
  const config = join(root, "config.json")
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "UNSET_CAPTURE_INVENTORY_TOKEN" },
      vault: { path: vault },
      courses: { allowlist: [] },
    }),
  )
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "SystemRoot", "COMSPEC", "PATHEXT"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  )
  const cli = (args: string[]) =>
    spawnSync(process.execPath, [resolve("dist/cli.js"), ...args, "--config", config, "--json"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 30_000,
    })
  const result = cli(["simulate", "list", "--course", "cs101"])
  expect(result.status, result.stderr).toBe(0)
  const listed = JSON.parse(result.stdout)
  expect(listed).toMatchObject({ inventoryComplete: true, unreadableRecords: 0 })
  expect(listed.captures.map((capture: { id: string }) => capture.id).sort()).toEqual(
    [own.id, derived.id].sort(),
  )
  expect(
    listed.captures.find((capture: { id: string }) => capture.id === derived.id).derivedFrom,
  ).toEqual({ id: own.id, hash: own.hash })
  expect(result.stdout).not.toContain("PRIVATE_CAPTURE_BODY")
  expect(result.stdout).not.toContain(other.id)
  expect(result.stdout).not.toContain("reading.md")
  expect(result.stdout).not.toContain('"sources"')
  expect(listed.limitation).toContain("No current vault sources are read")
  expect(cli(["simulate", "list"]).status).toBe(1)
  expect(cli(["simulate", "list", "--course", " "]).status).toBe(1)
  expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before)
  expect((await listSimulationCaptures(vault, "UNKNOWN")).captures).toEqual([])
})

it("reports unreadable unknown-scope records without body echo, repair or unsafe file adoption", async () => {
  const { vault, own } = await fixture()
  const directory = join(vault, "_meta/simulations")
  const malformed = join(directory, `${randomUUID()}.json`)
  await writeFile(malformed, "PRIVATE_MALFORMED_CAPTURE_SENTINEL")
  await symlink(malformed, join(directory, `${randomUUID()}.json`))
  const oversized = join(directory, `${randomUUID()}.json`)
  await writeFile(oversized, "")
  await truncate(oversized, 20 * 1024 * 1024 + 1)
  const substituted = join(directory, `${randomUUID()}.json`)
  await writeFile(substituted, await readFile(join(vault, own.path)))
  const listed = await listSimulationCaptures(vault, "CS101")
  expect(listed).toMatchObject({ inventoryComplete: false, unreadableRecords: 4 })
  expect(listed.captures).toHaveLength(2)
  expect(JSON.stringify(listed)).not.toContain("PRIVATE_MALFORMED")
  expect(await readFile(malformed, "utf8")).toBe("PRIVATE_MALFORMED_CAPTURE_SENTINEL")
})

it("refuses broken derived-parent bindings without repairing either frozen record", async () => {
  const { vault, own, derived } = await fixture()
  const parentPath = join(vault, own.path)
  const childPath = join(vault, derived.path)
  const childBefore = await readFile(childPath)
  const record = JSON.parse(await readFile(parentPath, "utf8"))
  record.hash = "0".repeat(64)
  const changed = JSON.stringify(record)
  await writeFile(parentPath, changed)
  const listed = await listSimulationCaptures(vault, "CS101")
  expect(listed).toMatchObject({ captures: [], inventoryComplete: false, unreadableRecords: 2 })
  expect(await readFile(parentPath, "utf8")).toBe(changed)
  expect(await readFile(childPath)).toEqual(childBefore)
})
