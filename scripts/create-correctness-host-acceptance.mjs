import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

// Intentionally flawed synthetic draft, not actual coursework. Do not print
// its task/review IDs or expected findings to the fresh host.
const checkout = resolve(import.meta.dirname, "..")
const frozen = process.argv.includes("--frozen")
const root = await mkdtemp(
  join(tmpdir(), frozen ? "canvas-host-correctness-frozen-" : "canvas-host-correctness-"),
)
const vault = join(root, "vault"),
  config = join(root, "config.json")
await mkdir(join(root, "home"))
const env = { PATH: process.env.PATH, HOME: join(root, "home"), TMPDIR: root }
function cli(args) {
  const result = spawnSync(
    process.execPath,
    [join(checkout, "dist/cli.js"), ...args, "--config", config, "--json"],
    { cwd: root, env, encoding: "utf8", timeout: 30_000 },
  )
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
cli(["init", "--vault", vault, "--canvas-url", "https://canvas.example.invalid"])
const prompt = "ECON903/Assignments/launch.md"
const reading = "ECON903/Materials/pilot.md"
const inputs = {
  [prompt]:
    "---\ntype: assignment\ncanvas_id: '9031'\n---\n# Invented pilot memo\nPrepare a local launch recommendation using the supplied pilot unit economics, comparison limitations and missing evidence. No submission is requested.\n",
  [reading]:
    '# Invented pilot data\nUnit price is 4, unit variable cost is 2, and observed pilot volume is 3 units. The observed revenue and costs exclude fixed launch costs. The pilot has no control group and does not establish scalability or a causal effect. Fixed launch costs and results outside the pilot were not supplied. The only quoted conclusion is: "This pilot is descriptive, not causal."\n',
  "ECON903/Guidance/course-guidance.md":
    "# Synthetic fixture permission\nAI drafting and separate correctness review are explicitly permitted for these invented documents in this engineering test only. This does not grant permission in any real class. Use only supplied evidence, label missing inputs and do not submit.\n",
}
for (const [path, body] of Object.entries(inputs)) {
  await mkdir(dirname(join(vault, path)), { recursive: true })
  const sourceBody = frozen
    ? body.startsWith("---\n")
      ? body.replace("---\n", "---\navailable_at: 2026-10-12\n")
      : `---\navailable_at: 2026-10-12\n---\n${body}`
    : body
  await writeFile(join(vault, path), sourceBody, { flag: "wx" })
}
const capture = frozen ? cli(["simulate", "capture", "ECON903", "--as-of", "2026-10-14"]) : null
const draft = cli(
  frozen
    ? [
        "simulate",
        "task",
        "create",
        capture.id,
        "--kind",
        "assignment",
        "--source",
        prompt,
        "--mode",
        "draft",
        "--context",
        reading,
      ]
    : ["assignment", "ECON903", "--source", prompt, "--mode", "draft", "--context", reading],
)
const shown = frozen
  ? cli(["simulate", "task", "show", draft.id]).task
  : cli(["task", "show", draft.id])
for (const [operation, values] of [
  ["multiply", "4,3"],
  ["multiply", "2,3"],
  ["subtract", "12,6"],
])
  cli([
    ...(frozen ? ["simulate", "task", "calculate", draft.id] : ["calculate", "--task", draft.id]),
    "--operation",
    operation,
    "--values",
    values,
    "--source",
    reading,
  ])
const flawed =
  'Pilot revenue is 12 and variable cost is 6, so contribution is 8. The source concludes "This pilot proves scalability." I recommend immediate full rollout; there are no missing inputs or design limitations.'
const candidate = join(root, "synthetic-draft.md")
await writeFile(
  candidate,
  [
    `Task: ${draft.id}`,
    ...shown.requirements.map(
      (heading) =>
        `## ${heading}\n\n${heading === "Sources" ? `\`${prompt}\`\n\`${reading}\`` : `${flawed} \`${reading}\``}`,
    ),
    ...(shown.deliverable?.items ?? []).map((item) => `### ${item.text}\n${flawed} \`${reading}\``),
  ].join("\n\n"),
)
cli(
  frozen
    ? ["simulate", "task", "complete", draft.id, "--file", candidate]
    : ["task", "complete", draft.id, "--file", candidate],
)
if (frozen) await rename(join(vault, "ECON903"), join(root, "removed-live-course"))
const baseline = []
async function inventory(folder, relative = "") {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(relative, entry.name)
    if (entry.isDirectory()) await inventory(join(folder, entry.name), path)
    else
      baseline.push({
        path,
        hash: createHash("sha256")
          .update(await readFile(join(vault, path)))
          .digest("hex"),
      })
  }
}
await inventory(vault)
await writeFile(join(root, "baseline.json"), JSON.stringify(baseline, null, 2), {
  flag: "wx",
  mode: 0o600,
})
await writeFile(
  join(root, "acceptance-fixture.json"),
  JSON.stringify({ version: 1, synthetic: true, course: "ECON903" }),
  { flag: "wx", mode: 0o600 },
)
console.log(
  JSON.stringify({ root, config, course: "ECON903", ...(frozen ? { frozen: true } : {}) }, null, 2),
)
