import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import { createConfig } from "../../src/config/index.js"
import { ingestFile } from "../../src/documents/content.js"
import { ingestCompatibility } from "../../src/documents/ingest-compatibility.js"
import { createPrepTask } from "../../src/tasks/store.js"
import { inspectWorkspace } from "../../src/vault/workspace.js"

const roots: string[] = []
const policy = {
  canvasOrigin: "https://canvas.example.test",
  aiPolicy: "allowed" as const,
  redistribution: "allowed" as const,
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-ingest-compatible-"))
  roots.push(root)
  const vault = join(root, "vault"),
    input = join(root, "reading.txt")
  await mkdir(join(vault, "SYNTH501"), { recursive: true })
  await mkdir(join(vault, "_meta"))
  await writeFile(
    join(vault, "_meta/canvas-courses.json"),
    JSON.stringify({
      version: 1,
      courses: [{ id: "17", name: "Synthetic course", root: "SYNTH501" }],
    }),
  )
  await writeFile(input, "Synthetic evidence distinguishes observations from assumptions.\n")
  return { root, vault, input }
}
function parsed(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error("Missing metadata")
  return { data: parseYaml(match[1] ?? "") as Record<string, unknown>, body: match[2] ?? "" }
}
it("creates a separate compatible artifact with correct body/original hashes and local identity", async () => {
  const f = await fixture()
  const result = await ingestFile(f.vault, "SYNTH501", f.input, "Reading", {
    compatibility: policy,
    week: "2026-10-12",
    asOf: "2026-10-05",
  })
  const record = parsed(await readFile(result.text ?? "", "utf8"))
  expect(record.data).toMatchObject({
    canvas_url: "https://canvas.example.test/courses/17",
    type: "files",
    source: "user",
    status: "final",
    ai_policy: "allowed",
    redistribution: "allowed",
    dates: { date: "2026-10-12", created_at: "2026-10-05" },
  })
  expect(record.data.canvas_id).toMatch(/^manual-[a-f0-9]{64}$/)
  expect(record.data.content_hash).toBe(createHash("sha256").update(record.body).digest("hex"))
  const companion = JSON.parse(await readFile(`${result.text}.ingest.json`, "utf8"))
  expect(companion).toMatchObject({ version: 1, availableAt: "2026-10-05" })
  expect(companion.hash).toBe(
    createHash("sha256")
      .update(await readFile(result.text ?? ""))
      .digest("hex"),
  )
  expect(companion.originalHash).toBe(
    createHash("sha256")
      .update(await readFile(f.input))
      .digest("hex"),
  )
  const course = (await inspectWorkspace(f.vault)).courses[0]
  expect(
    course?.sources.some(
      (source) =>
        source.path.endsWith(".extracted.md") && source.originalHash === companion.originalHash,
    ),
  ).toBe(true)
})
it("preserves old sidecars, student edits and saved task recipes on compatibility activation and retry", async () => {
  const f = await fixture(),
    options = { week: "2026-10-12", asOf: "2026-10-05" }
  const old = await ingestFile(f.vault, "SYNTH501", f.input, "Reading", options)
  const task = await createPrepTask(f.vault, "SYNTH501", options.week)
  const taskPath = join(f.vault, "_meta/tasks", task.id, "task.json"),
    taskBefore = await readFile(taskPath)
  const oldBefore = await readFile(old.text ?? "")
  const fresh = await ingestFile(f.vault, "SYNTH501", f.input, "Reading", {
    ...options,
    compatibility: policy,
  })
  expect(fresh.original).toBe(old.original)
  expect(fresh.text).not.toBe(old.text)
  const edited = `${await readFile(fresh.text ?? "", "utf8")}\nStudent annotation.\n`
  await writeFile(fresh.text ?? "", edited)
  expect(
    (
      await ingestFile(f.vault, "SYNTH501", f.input, "Reading", {
        ...options,
        compatibility: policy,
      })
    ).text,
  ).toBe(fresh.text)
  expect(await readFile(fresh.text ?? "", "utf8")).toBe(edited)
  expect(await readFile(old.text ?? "")).toEqual(oldBefore)
  expect(await readFile(taskPath)).toEqual(taskBefore)
})
it("retains explicit prohibited/restricted metadata and excludes it from generation context", async () => {
  const f = await fixture()
  const result = await ingestFile(f.vault, "SYNTH501", f.input, undefined, {
    compatibility: { ...policy, aiPolicy: "prohibited", redistribution: "restricted" },
  })
  const record = parsed(await readFile(result.text ?? "", "utf8"))
  expect(record.data).toMatchObject({ ai_policy: "prohibited", redistribution: "restricted" })
  expect(
    (await inspectWorkspace(f.vault)).courses[0]?.sources.some(
      (source) => source.path === result.original.replace(`${f.vault}/`, ""),
    ),
  ).toBe(false)
  expect(
    (await inspectWorkspace(f.vault)).courses[0]?.excluded.some(
      (entry) => entry.path.endsWith(".extracted.md") && /Restricted/.test(entry.reason),
    ),
  ).toBe(true)
})
it("rejects missing declarations, unsafe origins and absent course identity before copying", async () => {
  expect(() =>
    ingestCompatibility({ canvasOrigin: policy.canvasOrigin } as typeof policy, "17"),
  ).toThrow(/explicit/)
  expect(() =>
    ingestCompatibility(
      { ...policy, canvasOrigin: "https://user:private@canvas.example.test" },
      "17",
    ),
  ).toThrow(/explicit/)
  expect(() => ingestCompatibility(policy)).toThrow(/mapped/)
  const f = await fixture()
  await writeFile(
    join(f.vault, "_meta/canvas-courses.json"),
    JSON.stringify({ version: 1, courses: [] }),
  )
  await expect(
    ingestFile(f.vault, "SYNTH501", f.input, undefined, { compatibility: policy }),
  ).rejects.toThrow(/mapped/)
  expect(await readdir(join(f.vault, "SYNTH501"))).toEqual([])
})
it("refuses original policy laundering and malformed original YAML without echoing source data", async () => {
  const f = await fixture()
  for (const header of [
    "ai_policy: prohibited",
    "redistribution: restricted",
    "policy: unknown",
    "private: [SYNTHETIC_PRIVATE_MARKER",
  ]) {
    await writeFile(f.input, `---\n${header}\n---\nSynthetic evidence.\n`)
    try {
      await ingestFile(f.vault, "SYNTH501", f.input, undefined, { compatibility: policy })
      throw new Error("Unexpected success")
    } catch (error) {
      expect(String(error)).toMatch(/policy metadata/)
      expect(String(error)).not.toContain("SYNTHETIC_PRIVATE_MARKER")
    }
  }
  expect(await readdir(join(f.vault, "SYNTH501"))).toEqual([])
})
it("refuses changed compatible identity metadata while preserving the existing artifact", async () => {
  const f = await fixture(),
    options = { compatibility: policy }
  const result = await ingestFile(f.vault, "SYNTH501", f.input, undefined, options)
  const changed = (await readFile(result.text ?? "", "utf8")).replace(
    'source: "user"',
    'source: "sync"',
  )
  await writeFile(result.text ?? "", changed)
  await expect(ingestFile(f.vault, "SYNTH501", f.input, undefined, options)).rejects.toThrow(
    /identity or policy/,
  )
  expect(await readFile(result.text ?? "", "utf8")).toBe(changed)
})
it("does not rewrite an older policy variant when explicit declarations change", async () => {
  const f = await fixture()
  const old = await ingestFile(f.vault, "SYNTH501", f.input, undefined, { compatibility: policy })
  const before = await readFile(old.text ?? "")
  const next = await ingestFile(f.vault, "SYNTH501", f.input, undefined, {
    compatibility: { ...policy, redistribution: "restricted" },
  })
  expect(next.text).not.toBe(old.text)
  expect(next.original).toBe(old.original)
  expect(await readFile(old.text ?? "")).toEqual(before)
  expect((await inspectWorkspace(f.vault)).courses[0]?.sources).toEqual([])
})
it("exposes the explicit mode through compiled CLI and refuses incomplete declarations", async () => {
  const f = await fixture(),
    config = join(f.root, "canvas.config.json")
  await createConfig(config, { vault: f.vault, baseUrl: policy.canvasOrigin })
  const args = [
    resolve("dist/cli.js"),
    "ingest",
    f.input,
    "--course",
    "SYNTH501",
    "--school-compatible",
    "--config",
    config,
    "--json",
  ]
  const failed = spawnSync(process.execPath, args, { cwd: f.root, encoding: "utf8" })
  expect(failed.status).toBe(1)
  expect(failed.stderr).toContain("both explicit")
  expect(await readdir(join(f.vault, "SYNTH501"))).toEqual([])
  const success = spawnSync(
    process.execPath,
    [...args, "--ai-policy", "allowed", "--redistribution", "allowed"],
    { cwd: f.root, encoding: "utf8" },
  )
  expect(success.status, success.stderr).toBe(0)
  expect(JSON.parse(success.stdout).text).toContain(".school-")
})
it("withholds linked originals and older variants when compatible provenance is missing or stale", async () => {
  const f = await fixture()
  await ingestFile(f.vault, "SYNTH501", f.input)
  const fresh = await ingestFile(f.vault, "SYNTH501", f.input, undefined, { compatibility: policy })
  const companion = `${fresh.text}.ingest.json`,
    before = await readFile(companion)
  await writeFile(
    companion,
    before.toString().replace(/"hash":"[a-f0-9]{64}"/, `"hash":"${"0".repeat(64)}"`),
  )
  expect((await inspectWorkspace(f.vault)).courses[0]?.sources).toEqual([])
  await rm(companion)
  expect((await inspectWorkspace(f.vault)).courses[0]?.sources).toEqual([])
  await expect(
    ingestFile(f.vault, "SYNTH501", f.input, undefined, { compatibility: policy }),
  ).rejects.toThrow()
  expect(await readFile(fresh.original)).toEqual(await readFile(f.input))
})
it("refuses changed provenance on retry without replacing metadata or source bytes", async () => {
  const f = await fixture(),
    options = { compatibility: policy }
  const fresh = await ingestFile(f.vault, "SYNTH501", f.input, undefined, options)
  const path = `${fresh.text}.ingest.json`
  const metadata = JSON.parse(await readFile(path, "utf8"))
  metadata.originalHash = "0".repeat(64)
  const changed = JSON.stringify(metadata)
  await writeFile(path, changed)
  await expect(ingestFile(f.vault, "SYNTH501", f.input, undefined, options)).rejects.toThrow(
    /provenance conflicts/,
  )
  expect(await readFile(path, "utf8")).toBe(changed)
})
it("allows a restricted original to be retained with equally strict declarations, never relaxed", async () => {
  const f = await fixture()
  await writeFile(
    f.input,
    "---\nai_policy: prohibited\nredistribution: restricted\n---\nSynthetic restricted evidence.\n",
  )
  const result = await ingestFile(f.vault, "SYNTH501", f.input, undefined, {
    compatibility: { ...policy, aiPolicy: "prohibited", redistribution: "restricted" },
  })
  expect(await readFile(result.original)).toEqual(await readFile(f.input))
  expect(parsed(await readFile(result.text ?? "", "utf8")).data).toMatchObject({
    ai_policy: "prohibited",
    redistribution: "restricted",
  })
  expect((await inspectWorkspace(f.vault)).courses[0]?.sources).toEqual([])
})
