import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { initializeAssignmentGuidance } from "../src/assignment-guidance.js"
import { createAssignmentTask } from "../src/tasks.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const prompt = "CS101/Assignments/prompt.md"
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-guide-starter-"))
  roots.push(root)
  await mkdir(join(root, "CS101/Assignments"), { recursive: true })
  await writeFile(
    join(root, prompt),
    "---\ntype: assignment\ncanvas_id: '50'\n---\nExplain the supplied evidence.\n",
  )
  return root
}
it("creates one bound starter, captures it in subsequent tasks, and never replaces student edits", async () => {
  const root = await fixture()
  const original = await readFile(join(root, prompt))
  const result = await initializeAssignmentGuidance(root, "CS101", prompt)
  expect(result).toMatchObject({
    created: true,
    assignmentId: "50",
    aiPermissionVerified: false,
    paths: ["CS101/Guidance/assignment-50.md"],
  })
  const file = join(root, result.paths[0] ?? "")
  expect(await readFile(file, "utf8")).toContain("not instructor policy or permission")
  const task = await createAssignmentTask(root, "CS101", prompt, "draft")
  expect(task.guidance.map((source) => source.path)).toContain(result.paths[0])
  await writeFile(file, "Student-owned goals and voice; preserve exactly.\n")
  expect(await initializeAssignmentGuidance(root, "CS101", prompt)).toMatchObject({
    created: false,
    status: "existing",
  })
  expect(await readFile(file, "utf8")).toBe("Student-owned goals and voice; preserve exactly.\n")
  expect(await readFile(join(root, prompt))).toEqual(original)
})
it("retains an existing School-style guide without creating a duplicate", async () => {
  const root = await fixture()
  await mkdir(join(root, "CS101/Resources/Guidance"), { recursive: true })
  const path = "CS101/Resources/Guidance/case-guidance.md"
  const bytes =
    "---\ntype: guidance\ncanvas_id: '50'\ncanvas_url: https://canvas.example.test/courses/1/assignments/50\n---\nStudent preferences already exist.\n"
  await writeFile(join(root, path), bytes)
  expect(await initializeAssignmentGuidance(root, "CS101", prompt)).toMatchObject({
    created: false,
    paths: [path],
  })
  expect(await readFile(join(root, path), "utf8")).toBe(bytes)
  await expect(readFile(join(root, "CS101/Guidance/assignment-50.md"))).rejects.toThrow(/ENOENT/)
})

it("does not shadow an excluded/restricted assignment guide with a new blank starter", async () => {
  const root = await fixture()
  await mkdir(join(root, "CS101/Resources/Guidance"), { recursive: true })
  const path = "CS101/Resources/Guidance/case-guidance.md"
  const bytes =
    "---\ntype: guidance\ncanvas_id: '50'\nai_policy: prohibited\n---\nRestricted synthetic guidance, never use for generation.\n"
  await writeFile(join(root, path), bytes)
  expect(await initializeAssignmentGuidance(root, "CS101", prompt)).toMatchObject({
    created: false,
    paths: [path],
    policyRestrictedPaths: [path],
    aiPermissionVerified: false,
  })
  expect(await readFile(join(root, path), "utf8")).toBe(bytes)
  await expect(readFile(join(root, "CS101/Guidance/assignment-50.md"))).rejects.toThrow(/ENOENT/)
})
it("creates only inside a persistent product namespace and refuses unsafe destinations", async () => {
  const root = await fixture()
  await mkdir(join(root, "_meta"))
  await writeFile(
    join(root, "_meta/canvas-courses.json"),
    JSON.stringify({
      version: 1,
      courses: [{ id: "1", name: "Synthetic", root: "CS101", syncNamespace: "Canvas Agent" }],
    }),
  )
  await writeFile(
    join(root, "_meta/canvas-sync-state.json"),
    JSON.stringify({ version: 1, files: {} }),
  )
  const result = await initializeAssignmentGuidance(root, "CS101", prompt)
  expect(result.paths).toEqual(["CS101/Canvas Agent/Guidance/assignment-50.md"])
  await expect(readFile(join(root, "CS101/Guidance/assignment-50.md"))).rejects.toThrow(/ENOENT/)
  const unsafe = await fixture()
  const outside = join(unsafe, "outside")
  await mkdir(outside)
  await symlink(outside, join(unsafe, "CS101/Guidance"))
  await expect(initializeAssignmentGuidance(unsafe, "CS101", prompt)).rejects.toThrow(
    /Symbolic links/,
  )
})
it("runs the explicit starter command through the compiled CLI outside the checkout and rejects unknown identities", async () => {
  const root = await fixture()
  const config = join(root, "config.json")
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      canvas: { baseUrl: "https://canvas.example.test", tokenEnv: "CANVAS_UNUSED_TOKEN" },
      vault: { path: root },
      courses: { allowlist: [] },
    }),
  )
  const result = spawnSync(
    process.execPath,
    [
      resolve("dist/cli.js"),
      "guidance",
      "init-assignment",
      "CS101",
      "--source",
      prompt,
      "--config",
      config,
      "--json",
    ],
    { cwd: root, encoding: "utf8" },
  )
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ created: true, aiPermissionVerified: false })
  expect(result.stdout).not.toContain("Student preferences")
  await writeFile(join(root, prompt), "Unbound manual assignment; no Canvas identity.")
  await expect(initializeAssignmentGuidance(root, "CS101", prompt)).rejects.toThrow(
    /exact numeric Canvas identity/,
  )
})
