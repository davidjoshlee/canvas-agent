import { constants } from "node:fs"
import { type FileHandle, mkdir, open } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { assertNoSymlinks } from "../shared/fs-safety.js"
import { readGuidanceSnapshot, verifySourceSnapshot } from "../tasks/store.js"
import { inspectWorkspace, selectCourse } from "../vault/workspace.js"
import { guidanceAssignmentIdentity } from "./selection.js"

/** Explicit, local starter creation only: never generated policy or student work. */
export async function initializeAssignmentGuidance(
  vault: string,
  query: string,
  sourcePath: string,
) {
  const root = resolve(vault)
  const context = await inspectWorkspace(root)
  if (
    context.notices.some((notice) =>
      notice.startsWith("Canvas course mappings are unavailable or unsafe"),
    )
  )
    throw new Error("Course mappings are unsafe; inspect them before creating guidance")
  const course = selectCourse(context, query)
  const prompt = course.sources.find(
    (source) => source.path === sourcePath && /assignment/i.test(source.type),
  )
  if (!prompt?.path.startsWith(`${course.root}/`) || !/^[1-9]\d{0,39}$/.test(prompt.canvasId ?? ""))
    throw new Error("Choose one readable assignment prompt with an exact numeric Canvas identity")
  await verifySourceSnapshot(root, prompt)
  const existing: string[] = []
  const excludedGuides = course.excluded.filter(
    (entry) =>
      /(?:^|\/)guidance\/[^/]+\.(?:md|markdown|txt)$/i.test(entry.path) &&
      !/(?:\.proposed\.|\/proposed-|-proposal\.md$)/i.test(entry.path),
  )
  const inventory = [...new Set([...course.guidance, ...excludedGuides.map((entry) => entry.path)])]
  if (inventory.length > 500)
    throw new Error("Guidance inventory exceeds 500 files; review it before starter creation")
  for (const path of inventory) {
    const identity = await readGuidanceSnapshot(root, path, 1, true)
    if (guidanceAssignmentIdentity(identity) === prompt.canvasId) existing.push(path)
  }
  if (existing.length)
    return {
      status: "existing" as const,
      course: course.code,
      assignmentId: prompt.canvasId,
      paths: existing.sort(),
      created: false,
      policyRestrictedPaths: existing.filter((path) =>
        excludedGuides.some((entry) => entry.path === path),
      ),
      aiPermissionVerified: false,
    }
  const courseRoot = course.syncNamespace ? `${course.root}/Canvas Agent` : course.root
  const relativePath = `${courseRoot}/Guidance/assignment-${prompt.canvasId}.md`
  const path = join(root, relativePath)
  await assertNoSymlinks(path, true)
  await mkdir(dirname(path), { recursive: true })
  await assertNoSymlinks(dirname(path))
  await verifySourceSnapshot(root, prompt)
  const starter = [
    "---",
    "type: guidance",
    `canvas_id: '${prompt.canvasId}'`,
    "---",
    "# Assignment guidance starter",
    "",
    "This is an empty student-preference starter, not instructor policy or permission for AI assistance.",
    "Existing course guidance and the assignment prompt remain authoritative. Confirm the permitted assistance separately.",
    "",
    "## Student preferences",
    "",
    "Add your own goals, constraints and preferred voice here. Unspecified preferences remain unknown; the agent must not invent them.",
    "",
    "## Optional output format",
    "",
    "If you want a custom draft format, replace this explanatory block with a Brief structure heading and an explicit ordered list of section names. Otherwise the default draft headings remain unchanged.",
    "",
  ].join("\n")
  let file: FileHandle
  try {
    file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    // Do not adopt or overwrite a concurrent/untracked replacement as a starter.
    throw new Error("Assignment guidance destination already exists; inspect it before retrying")
  }
  try {
    await file.writeFile(starter, "utf8")
    await file.sync()
  } finally {
    await file.close()
  }
  return {
    status: "created" as const,
    course: course.code,
    assignmentId: prompt.canvasId,
    paths: [relativePath],
    created: true,
    policyRestrictedPaths: [],
    aiPermissionVerified: false,
  }
}
