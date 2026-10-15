import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { localFormatFixtures } from "./fixtures/local-formats.mjs"

const school = await realpath(process.argv[2] ?? "")
assert(
  /^canvas-installed-coexistence-[A-Za-z0-9]+\/installation\/node_modules\/school-agent$/.test(
    relative(await realpath(tmpdir()), school)
      .split(sep)
      .join("/"),
  ),
  "Supply only an owned installed School audit package",
)
const checkout = resolve(import.meta.dirname, "..")
const root = await mkdtemp(join(tmpdir(), "canvas-installed-formats-"))
const home = join(root, "home"),
  installation = join(root, "installation"),
  vault = join(root, "vault"),
  inputs = join(root, "inputs")
for (const path of [home, installation, inputs]) await mkdir(path)
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: root }
const hash = (value) => createHash("sha256").update(value).digest("hex")
const commands = []
function run(executable, args, accepted = [0], extraEnv = {}, cwd = root) {
  const result = spawnSync(executable, args, {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 10_000_000,
  })
  commands.push({
    executable,
    args,
    cwd,
    status: result.status,
    signal: result.signal,
    stdoutHash: hash(result.stdout ?? ""),
    stderrHash: hash(result.stderr ?? ""),
  })
  writeFileSync(join(root, "commands.json"), JSON.stringify(commands, null, 2), { mode: 0o600 })
  if (result.error) throw result.error
  assert(
    accepted.includes(result.status),
    `Synthetic installed format audit failed (${result.status}): ${result.stderr}`,
  )
  return result
}
async function inventory(path, prefix = "") {
  const found = new Map()
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name),
      key = join(prefix, entry.name)
    if (entry.isDirectory())
      for (const [name, digest] of await inventory(child, key)) found.set(name, digest)
    else {
      assert(entry.isFile())
      found.set(key, hash(await readFile(child)))
    }
  }
  return found
}
function preserved(before, after, except = []) {
  for (const [path, digest] of before)
    if (!except.includes(path))
      assert.equal(after.get(path), digest, `Prior synthetic file changed: ${path}`)
}
console.log(JSON.stringify({ root, phase: "installing-current-canvas", syntheticOnly: true }))
const npmrc = join(root, "empty.npmrc")
await writeFile(npmrc, "", { flag: "wx", mode: 0o600 })
const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const npmArgs = [
  "--userconfig",
  npmrc,
  "--cache",
  join(root, "npm-cache"),
  "--registry",
  "https://registry.npmjs.org",
]
const pack = JSON.parse(
  run(
    npm,
    ["pack", "--ignore-scripts", "--json", "--pack-destination", root, ...npmArgs],
    [0],
    {},
    checkout,
  ).stdout,
)[0]
await writeFile(join(installation, "package.json"), JSON.stringify({ private: true }), {
  flag: "wx",
  mode: 0o600,
})
run(
  npm,
  [
    "install",
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    join(root, pack.filename),
    ...npmArgs,
  ],
  [0],
  {},
  installation,
)
const canvas = join(installation, "node_modules/canvas-agent")
const { VaultWriter, parseVaultDocument } = await import(
  pathToFileURL(join(school, "dist/store/vault.js")).href
)
const { readVaultText } = await import(
  pathToFileURL(join(school, "dist/engines/retrieve-files.js")).href
)
const course = {
  code: "SYNTH501",
  canvasId: "17",
  canvasUrl: "https://canvas.example.test/courses/17",
  aiPolicy: "allowed",
}
const writer = new VaultWriter({ root: vault, gitInit: false })
await writer.write({
  course,
  kind: "modules",
  canvasId: "201",
  canvasUrl: `${course.canvasUrl}/modules/201`,
  title: "Evidence",
  source: "sync",
  status: "final",
  content: "Synthetic evidence session.",
  period: { kind: "week", number: 1, date: "2026-10-12" },
  dates: { unlock_at: "2026-10-12T00:00:00Z" },
})
await writer.writeCourseManifest({ course, restrictedFileHandling: "exclude" })
const canvasConfig = join(root, "canvas.config.json"),
  schoolConfig = join(root, "school.config.json")
await writeFile(
  canvasConfig,
  JSON.stringify({
    version: 1,
    canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "AUDIT_FORMAT_TOKEN" },
    vault: { path: vault },
    courses: { allowlist: ["17"] },
  }),
  { flag: "wx", mode: 0o600 },
)
await writeFile(
  schoolConfig,
  JSON.stringify({
    canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "AUDIT_FORMAT_TOKEN" },
    vault: { path: vault, gitInit: false },
    index: { path: join(root, "school.sqlite") },
    courses: { mode: "list", allowlist: ["17"], pilotCourseId: null },
  }),
  { flag: "wx", mode: 0o600 },
)
const { syncCourses, setCanvasFetchForTests } = await import(
  pathToFileURL(join(canvas, "dist/canvas.js")).href
)
const previous = process.env.AUDIT_FORMAT_TOKEN
try {
  process.env.AUDIT_FORMAT_TOKEN = "synthetic-token"
  setCanvasFetchForTests(async (input, init) => {
    assert.equal(init.method, "GET")
    const path = new URL(String(input)).pathname
    if (path === "/api/v1/users/self")
      return new Response(JSON.stringify({ id: 99, name: "Synthetic student" }))
    if (path === "/api/v1/courses")
      return new Response(
        JSON.stringify([{ id: 17, name: "Synthetic course", course_code: course.code }]),
      )
    if (path === "/api/v1/courses/17")
      return new Response(
        JSON.stringify({ id: 17, name: "Synthetic course", course_code: course.code }),
      )
    return new Response("[]")
  })
  const before = await inventory(vault)
  await syncCourses(JSON.parse(await readFile(canvasConfig, "utf8")), { preserveSchool: true })
  preserved(before, await inventory(vault))
} finally {
  setCanvasFetchForTests(undefined)
  if (previous === undefined) delete process.env.AUDIT_FORMAT_TOKEN
  else process.env.AUDIT_FORMAT_TOKEN = previous
}
const preload = join(root, "deny-network.mjs")
await writeFile(
  preload,
  `globalThis.fetch=async()=>{throw new Error('Network denied in synthetic format audit')};`,
  { flag: "wx", mode: 0o600 },
)
function cli(product, args, accepted = [0]) {
  const ownConfig = product === "school" ? schoolConfig : canvasConfig
  const bin = product === "school" ? join(school, "bin/school.js") : join(canvas, "dist/cli.js")
  return run(process.execPath, ["--import", preload, bin, "--config", ownConfig, ...args], accepted)
}
const results = []
for (const fixture of await localFormatFixtures()) {
  const input = join(inputs, fixture.name)
  await writeFile(input, fixture.bytes, { flag: "wx", mode: 0o600 })
  const initial = await inventory(vault)
  const schoolArgs = [
    "ingest",
    input,
    "--course",
    "17",
    "--title",
    `School ${fixture.name}`,
    "--as-of",
    "2026-10-12",
    "--module",
    "201",
  ]
  const schoolResult = cli("school", schoolArgs, fixture.supported ? [0] : [1])
  preserved(initial, await inventory(vault), [join(course.code, "_index.md")])
  let schoolPath
  if (fixture.supported) {
    schoolPath = schoolResult.stdout.trim().split("\n").at(-1)
    assert(
      parseVaultDocument(await readFile(schoolPath, "utf8"), schoolPath).content.includes(
        "Synthetic evidence",
      ),
    )
    const prior = await inventory(vault)
    cli("school", schoolArgs)
    preserved(prior, await inventory(vault))
  } else assert.deepEqual(await inventory(vault), initial)
  const beforeCanvas = await inventory(vault)
  const canvasArgs = [
    "ingest",
    input,
    "--course",
    course.code,
    "--title",
    `Canvas ${fixture.name}`,
    "--as-of",
    "2026-10-12",
    "--module",
    "201",
    "--json",
  ]
  const canvasResult = JSON.parse(cli("canvas", canvasArgs).stdout)
  assert(canvasResult.original.includes(`${sep}Canvas Agent${sep}`))
  assert.equal(hash(await readFile(canvasResult.original)), hash(fixture.bytes))
  preserved(beforeCanvas, await inventory(vault))
  assert.equal(Boolean(canvasResult.text), fixture.supported)
  let schoolAcceptsCanvasText = null
  let schoolReaderAcceptsCanvasText = null
  if (fixture.supported) {
    assert((await readFile(canvasResult.text, "utf8")).includes("Synthetic evidence"))
    try {
      parseVaultDocument(await readFile(canvasResult.text, "utf8"), canvasResult.text)
      schoolAcceptsCanvasText = true
    } catch (error) {
      assert.equal(error.name, "VaultDocumentError")
      schoolAcceptsCanvasText = false
    }
    assert((await readVaultText(schoolPath)).content.includes("Synthetic evidence"))
    try {
      const loaded = await readVaultText(canvasResult.text)
      schoolReaderAcceptsCanvasText = loaded !== null
    } catch (error) {
      assert.equal(error.name, "VaultDocumentError")
      schoolReaderAcceptsCanvasText = false
    }
  }
  const beforeRetry = await inventory(vault)
  const retry = JSON.parse(cli("canvas", canvasArgs).stdout)
  assert.equal(retry.original, canvasResult.original)
  assert.equal(retry.text, canvasResult.text)
  if (fixture.supported) assert(retry.notices.includes("Preserved existing extraction sidecar"))
  preserved(beforeRetry, await inventory(vault))
  assert.equal(hash(await readFile(input)), hash(fixture.bytes))
  const context = JSON.parse(cli("canvas", ["context", "--json"]).stdout)
  const local = context.courses.find((item) => item.code === course.code)
  assert(local)
  if (fixture.supported) {
    for (const path of [schoolPath, canvasResult.text])
      assert(
        local.sources.some((source) => source.path === relative(vault, path).split(sep).join("/")),
        `Installed Canvas did not inventory ${basename(path)}`,
      )
  }
  let compatibleSchoolReaderAcceptsText = null
  if (fixture.supported) {
    const beforeCompatibility = await inventory(vault)
    const compatibleArgs = [
      ...canvasArgs,
      "--school-compatible",
      "--ai-policy",
      "allowed",
      "--redistribution",
      "allowed",
    ]
    const compatibleResult = JSON.parse(cli("canvas", compatibleArgs).stdout)
    assert.equal(compatibleResult.original, canvasResult.original)
    assert.notEqual(compatibleResult.text, canvasResult.text)
    preserved(beforeCompatibility, await inventory(vault))
    const raw = await readFile(compatibleResult.text, "utf8")
    const parsed = parseVaultDocument(raw, compatibleResult.text)
    assert.equal(parsed.frontmatter.content_hash, hash(parsed.content))
    assert.equal(parsed.frontmatter.source, "user")
    assert.equal(parsed.frontmatter.ai_policy, "allowed")
    const loaded = await readVaultText(compatibleResult.text)
    assert(loaded.content.includes("Synthetic evidence"))
    const companion = JSON.parse(await readFile(`${compatibleResult.text}.ingest.json`, "utf8"))
    assert.equal(companion.hash, hash(raw))
    assert.equal(companion.originalHash, hash(fixture.bytes))
    const compatibleContext = JSON.parse(cli("canvas", ["context", "--json"]).stdout)
    assert(
      compatibleContext.courses
        .find((item) => item.code === course.code)
        .sources.some(
          (source) =>
            source.path === relative(vault, compatibleResult.text).split(sep).join("/") &&
            source.originalHash === hash(fixture.bytes),
        ),
    )
    compatibleSchoolReaderAcceptsText = true
    const beforeCompatibleRetry = await inventory(vault)
    assert.equal(JSON.parse(cli("canvas", compatibleArgs).stdout).text, compatibleResult.text)
    preserved(beforeCompatibleRetry, await inventory(vault))
  }
  results.push({
    name: fixture.name,
    supported: fixture.supported,
    schoolIngestExit: schoolResult.status,
    canvasOriginalPreserved: true,
    previousVaultBytesPreserved: true,
    retriesPreserved: true,
    canvasReadsSchoolText: fixture.supported,
    schoolAcceptsCanvasText,
    schoolReaderAcceptsCanvasText,
    compatibleSchoolReaderAcceptsText,
  })
}
const report = {
  root,
  status: results.some(
    (result) => result.supported && result.compatibleSchoolReaderAcceptsText !== true,
  )
    ? "partial"
    : "pass",
  scope: "Explicit declared-policy compatibility mode, not automatic conversion of legacy sidecars",
  results,
  commands,
  installedCanvasVersion: JSON.parse(await readFile(join(canvas, "package.json"), "utf8")).version,
  installedSchoolVersion: JSON.parse(await readFile(join(school, "package.json"), "utf8")).version,
  syncMocked: true,
  realProviderTested: false,
  realCanvasTested: false,
  academicQualityVerified: false,
  publishedReleasesTested: false,
  installedArtifactHashes: await Promise.all(
    [
      ...[
        "bin/school.js",
        "dist/canvas/ingest-cli.js",
        "dist/content/extract.js",
        "dist/store/vault.js",
        "dist/engines/retrieve-files.js",
      ].map((path) => [school, "school", path]),
      ...["dist/cli.js", "dist/content.js", "dist/workspace.js"].map((path) => [
        canvas,
        "canvas",
        path,
      ]),
    ].map(async ([directory, product, path]) => ({
      product,
      path,
      hash: hash(await readFile(join(directory, path))),
    })),
  ),
}
await writeFile(join(root, "audit.json"), JSON.stringify(report, null, 2), {
  flag: "wx",
  mode: 0o600,
})
console.log(JSON.stringify({ ...report, commands: commands.length }, null, 2))
if (report.status !== "pass") process.exitCode = 2
