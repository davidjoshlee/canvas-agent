import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

// Operator-only packaging audit. Inputs are explicit built source checkouts;
// package installation may contact the registry, but all course operations use
// invented files and mocked GET responses. Never load real account/config data.
const school = process.argv[2]
assert(school && isAbsolute(school), "Supply an absolute built public School checkout")
const canvas = resolve(import.meta.dirname, "..")
const sourcePackages = await Promise.all(
  [school, canvas].map(async (path) =>
    JSON.parse(await readFile(join(path, "package.json"), "utf8")),
  ),
)
assert.equal(sourcePackages[0].name, "school-agent")
assert.equal(sourcePackages[1].name, "canvas-agent")
const root = await mkdtemp(join(tmpdir(), "canvas-installed-coexistence-"))
const home = join(root, "home")
const installation = join(root, "installation")
await mkdir(home)
await mkdir(installation)
await writeFile(join(installation, "package.json"), JSON.stringify({ private: true }), {
  flag: "wx",
  mode: 0o600,
})
const npmrc = join(root, "empty.npmrc")
await writeFile(npmrc, "", { flag: "wx", mode: 0o600 })
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: root }
const commands = []
function run(executable, args, cwd, accepted = [0]) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
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
    stdoutHash: createHash("sha256")
      .update(result.stdout ?? "")
      .digest("hex"),
    stderrHash: createHash("sha256")
      .update(result.stderr ?? "")
      .digest("hex"),
  })
  if (result.error) throw result.error
  assert(
    accepted.includes(result.status),
    `Owned packaging/audit command failed (${result.status}): ${result.stderr}`,
  )
  return result
}
const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const npmConfig = [
  "--userconfig",
  npmrc,
  "--cache",
  join(root, "npm-cache"),
  "--registry",
  "https://registry.npmjs.org",
]
console.log(JSON.stringify({ root, phase: "packing", syntheticOnly: true }))
const packed = [school, canvas].map(
  (path) =>
    JSON.parse(
      run(
        npm,
        ["pack", "--ignore-scripts", "--json", "--pack-destination", root, ...npmConfig],
        path,
      ).stdout,
    )[0],
)
console.log(
  JSON.stringify({ root, phase: "installing", versions: packed.map((pack) => pack.version) }),
)
run(
  npm,
  [
    "install",
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    ...packed.map((pack) => join(root, pack.filename)),
    ...npmConfig,
  ],
  installation,
)
const installedSchool = join(installation, "node_modules/school-agent")
const installedCanvas = join(installation, "node_modules/canvas-agent")
const artifacts = []
for (const [source, installed, paths] of [
  [
    school,
    installedSchool,
    [
      "dist/store/vault.js",
      "dist/store/vault-document.js",
      "dist/store/vault-course-root-migration.js",
      "bin/school.js",
    ],
  ],
  [
    canvas,
    installedCanvas,
    [
      "dist/canvas.js",
      "dist/cli.js",
      "dist/school-layout.js",
      "dist/preservation-migration.js",
      "dist/workspace.js",
    ],
  ],
])
  for (const path of paths) {
    const original = await readFile(join(source, path))
    const bytes = await readFile(join(installed, path))
    assert.deepEqual(bytes, original, "Installed artifact differs from explicit built source")
    artifacts.push({
      package: installed === installedSchool ? "school-agent" : "canvas-agent",
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })
  }
const schoolVersion = run(
  process.execPath,
  [join(installedSchool, "bin/school.js"), "--version"],
  root,
).stdout.trim()
const canvasVersion = run(
  process.execPath,
  [join(installedCanvas, "dist/cli.js"), "--version"],
  root,
).stdout.trim()
assert.equal(schoolVersion, sourcePackages[0].version)
assert.equal(canvasVersion, sourcePackages[1].version)
console.log(JSON.stringify({ root, phase: "writer-order-audit", schoolVersion, canvasVersion }))
const result = run(
  process.execPath,
  [join(canvas, "scripts/audit-school-coexistence.mjs"), installedSchool, installedCanvas],
  root,
  [0, 2],
)
const audit = JSON.parse(result.stdout)
assert.equal(audit.installedPackagesTested, true)
const report = {
  root,
  schoolVersion,
  canvasVersion,
  packageArtifacts: artifacts,
  packages: packed.map(({ name, version, shasum, integrity }) => ({
    name,
    version,
    shasum,
    integrity,
  })),
  commands,
  audit,
  publishedReleasesTested: false,
  nativeSqliteDatabaseTested: false,
  scope:
    "Locally packed explicit built sources, installed outside either checkout; mocked sync and actual installed writers/Canvas CLI, no provider generation or real vault",
}
await writeFile(join(root, "audit.json"), JSON.stringify(report, null, 2), {
  flag: "wx",
  mode: 0o600,
})
console.log(
  JSON.stringify({
    root,
    report: join(root, "audit.json"),
    status: audit.status,
    cases: audit.cases,
    installedPackagesTested: true,
  }),
)
process.exitCode = result.status
