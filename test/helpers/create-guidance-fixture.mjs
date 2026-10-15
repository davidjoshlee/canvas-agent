import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

// Invented source inputs only, no candidate answer or user-owned data. A fresh
// host gets the printed config/course, not the saved UUID or baseline contents.
const checkout = resolve(import.meta.dirname, "../..")
const { feedbackDirectory, feedbackHash, feedbackSnapshot, normalizeOwnFeedback } = await import(
  pathToFileURL(join(checkout, "dist/feedback/history.js")).href
)
const root = await mkdtemp(join(tmpdir(), "canvas-host-guidance-"))
const vault = join(root, "vault")
const config = join(root, "config.json")
const home = join(root, "home")
await mkdir(home)
const env = Object.fromEntries(
  ["PATH", "SystemRoot", "COMSPEC", "PATHEXT"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
)
env.HOME = home
env.TMPDIR = root
function cli(args) {
  const result = spawnSync(
    process.execPath,
    [join(checkout, "dist/cli.js"), ...args, "--config", config, "--json"],
    { cwd: root, env, encoding: "utf8", timeout: 30_000, maxBuffer: 5_000_000 },
  )
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
cli(["init", "--vault", vault, "--canvas-url", "https://canvas.example.invalid"])
const inputs = {
  "ECON902/Syllabus.md":
    "# Synthetic evidence and decisions syllabus\nThis invented class prepares students to distinguish observations from assumptions, compare alternatives and discuss what evidence would change a decision. Weekly prep synthesizes readings and discussion questions. Graded memos make a supported recommendation and state uncertainty; their submission format is not the weekly prep format. AI assistance for prep and local guidance proposals is explicitly permitted in this synthetic fixture only. Never submit or infer real-course permission.\n",
  "ECON902/Guidance/prep-guidance.md":
    "# Existing synthetic guide\nPreserve the existing weekly prep format unless the sources justify a change. Distinguish comparison-group evidence from causal claims. AI prep and local guidance assistance are explicitly permitted for this invented fixture only.\n## Brief structure\nOverview, Reading synthesis, Key concepts, Preparation questions, Discussion points, Sources\n",
  "ECON902/Assignments/memo-50.md":
    "---\ntype: assignment\ncanvas_id: '50'\nposted_at: 2026-10-10T00:00:00Z\n---\n# Synthetic decision memo\nFor the graded memo, use Facts, Issue, Analysis and Recommendation. Compare alternatives and label assumptions. This is a submission format, not weekly prep structure.\n",
  "ECON902/Assignments/memo-60.md":
    "---\ntype: assignment\ncanvas_id: '60'\nposted_at: 2026-10-12T00:00:00Z\n---\n# Synthetic evidence memo\nSeparate observations from assumptions, distinguish association from causation and state limitations of the proposed comparison group. Identify evidence that would change the recommendation.\n",
}
for (const [path, text] of Object.entries(inputs)) {
  await mkdir(dirname(join(vault, path)), { recursive: true })
  await writeFile(join(vault, path), text, { flag: "wx" })
}
await mkdir(join(vault, "_meta"), { recursive: true, mode: 0o700 })
await writeFile(
  join(vault, "_meta/canvas-courses.json"),
  JSON.stringify({
    version: 1,
    courses: [{ root: "ECON902", code: "ECON902", id: "902", name: "Synthetic evidence course" }],
  }),
  { flag: "wx", mode: 0o600 },
)
const feedback = [
  [
    "50",
    "2026-10-11T00:00:00Z",
    "Old cached value: OLDER_VALUE_SENTINEL. Do not select this superseded value.",
  ],
  [
    "50",
    "2026-10-12T00:00:00Z",
    "Current cached lesson: make the assumptions behind your comparison explicit; distinguish observations from scenario assumptions.",
  ],
  [
    "60",
    "2026-10-13T00:00:00Z",
    "Current cached lesson: a comparison group is not enough on its own for a causal claim. State the design assumptions and the main limitation.",
  ],
]
for (const [id, checkedAt, comment] of feedback) {
  const data = normalizeOwnFeedback(
    { assignment_id: Number(id), submission_comments: [{ comment }] },
    "902",
    id,
  )
  const directory = feedbackDirectory(vault, "902", id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, `${feedbackHash(data)}.json`), JSON.stringify(data), {
    flag: "wx",
    mode: 0o600,
  })
  await writeFile(
    join(directory, "current.json"),
    JSON.stringify({ ...feedbackSnapshot(data), checkedAt }),
    { mode: 0o600 },
  )
}
const proposal = cli(["guidance", "propose", "ECON902"])
const baseline = []
async function inventory(folder, relative = "") {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(relative, entry.name)
    if (entry.isDirectory()) await inventory(join(folder, entry.name), path)
    else {
      assert(entry.isFile())
      baseline.push({
        path,
        hash: createHash("sha256")
          .update(await readFile(join(folder, entry.name)))
          .digest("hex"),
      })
    }
  }
}
await inventory(vault)
await writeFile(
  join(root, "baseline.json"),
  JSON.stringify({ mode: "guidance-proposal", proposalId: proposal.id, files: baseline }, null, 2),
  { flag: "wx", mode: 0o600 },
)
console.log(
  JSON.stringify(
    {
      mode: "guidance-proposal",
      root,
      config,
      vault,
      course: "ECON902",
      checkout,
      baselineFiles: baseline.length,
    },
    null,
    2,
  ),
)
