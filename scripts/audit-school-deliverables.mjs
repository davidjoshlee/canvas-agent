import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { detectDeliverable } from "../src/deliverable.ts"

// Maintainer-only source differential. No config, env file, vault or API is read.
const argument = process.argv[2]
if (!argument || !isAbsolute(argument))
  throw new Error("Pass one explicit absolute School Agent checkout path")
const school = resolve(argument)
const sourceHashes = []
for (const name of ["deliverable.ts", "deliverable-enumerate.ts"]) {
  const path = join(school, "src/engines", name)
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000)
    throw new Error("School parser source is not a bounded regular file")
  sourceHashes.push({
    path,
    sha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  })
}
const reference = await import(pathToFileURL(join(school, "src/engines/deliverable.ts")).href)
const source = (text, path = "CS101/assignment.md") => ({ text, path })
const multipart =
  "Required: PART I: Summarize the data. PART II: (a) Build a schedule. (b) State limitations."
const cases = [
  {
    name: "imperative-numbered",
    sources: [source("Required: 1. Calculate contribution. 2. Recommend a test.")],
  },
  {
    name: "numbered-input-facts",
    sources: [source("Transactions: 1. Revenue rose. 2. Costs fell.")],
  },
  { name: "multipart-all", sources: [source(multipart)] },
  { name: "multipart-selected", sources: [source(multipart)], scope: "PART II" },
  { name: "multipart-unavailable", sources: [source(multipart)], scope: "PART III" },
  {
    name: "ordered-html",
    sources: [
      source(
        "<h2>Preparation Questions</h2><ol><li>Explain the baseline.</li><li>What is missing?</li></ol>",
      ),
    ],
  },
  {
    name: "collapsed-pdf",
    sources: [
      source(
        "S   TUDY   G   UIDE Prepare your answers to the following questions: 1. Why test? 2. Why randomize?",
      ),
    ],
  },
  {
    name: "stronger-cue-priority",
    sources: [
      source("Answer the following questions: 1. Why test?", "CS101/page.md"),
      source("Required: 1. Build the schedule."),
    ],
  },
]
for (const test of cases) {
  const expected = reference.detectDeliverable(test.sources, test.scope)
  const actual = detectDeliverable(test.sources, test.scope)
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Parser disagreement in synthetic case ${test.name}`)
}
console.log(
  JSON.stringify(
    {
      status: "pass",
      cases: cases.map((test) => test.name),
      sourceHashes,
      scope:
        "Exact parser results for eight synthetic cases against the explicit current School source",
      taskHandoffIntegrationTested: false,
      liveAccountTested: false,
      academicQualityVerified: false,
    },
    null,
    2,
  ),
)
