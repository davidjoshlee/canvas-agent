import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { inspectWorkspace, selectCourse } from "../src/workspace.js"

const roots: string[] = []
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "canvas-workspace-"))
  roots.push(root)
  return root
}
async function put(root: string, path: string, content: string | Buffer): Promise<void> {
  const file = join(root, path)
  await mkdir(join(file, ".."), { recursive: true })
  await writeFile(file, content)
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("workspace inventory", () => {
  it("reads conventional nested course material, preserves relative paths and hashes original bytes", async () => {
    const root = await fixture()
    const bytes = Buffer.from(
      "---\ntype: assignment\ndates:\n  due_at: 2026-10-12T18:30:00Z\n---\n# Case\nRead this.\n",
    )
    await put(root, "ACCT312/_index.md", "# Financial Accounting\nCourse index.\n")
    await put(root, "ACCT312/Week 03/Assignments/Case.md", bytes)
    await put(root, "ACCT312/Resources/Syllabus.md", "# Syllabus\nCalendar\n")
    await put(root, "ACCT312/Resources/Guidance/prep.md", "# Prep guidance\nUse concise notes.\n")
    await put(
      root,
      "ACCT312/Resources/Guidance/prep-guidance.proposed.md",
      "# Proposed\nDo not use this.",
    )
    await put(root, "AGENTS.md", "# Workspace guidance\nRespect local rules.\n")
    await put(root, "ACCT312/Assignments/Prep/01 Prep Brief.md", "student work")

    const context = await inspectWorkspace(root)
    const course = selectCourse(context, "acct312")
    expect(course.title).toBe("Financial Accounting")
    expect(course.sources.map((source) => source.path)).toEqual([
      "ACCT312/_index.md",
      "ACCT312/Resources/Syllabus.md",
      "ACCT312/Week 03/Assignments/Case.md",
    ])
    expect(course.sources[2]).toMatchObject({
      title: "Case",
      type: "assignment",
      dates: ["2026-10-12"],
      text: "# Case\nRead this.",
      hash: createHash("sha256").update(bytes).digest("hex"),
    })
    expect(course.guidance).toEqual(["ACCT312/Resources/Guidance/prep.md", "AGENTS.md"])
    expect(course.existingWork).toEqual(["ACCT312/Assignments/Prep/01 Prep Brief.md"])
    expect(course.excluded).toContainEqual({
      path: "ACCT312/Resources/Guidance/prep-guidance.proposed.md",
      reason: "Proposed guidance is not active context; text omitted",
    })
    expect(JSON.stringify(context)).not.toContain("student work")
  })

  it("omits text for School Agent restrictions and unknown policy labels", async () => {
    const root = await fixture()
    await put(
      root,
      "STRAMGT353/allowed.md",
      "---\nai_policy: allowed\nredistribution: allowed\n---\nSafe content",
    )
    await put(
      root,
      "STRAMGT353/ai-prohibited.md",
      "---\nai_policy: prohibited\n---\nSECRET PROHIBITED BODY",
    )
    await put(
      root,
      "STRAMGT353/redistribution-restricted.md",
      "---\nredistribution: restricted\n---\nSECRET RESTRICTED BODY",
    )
    await put(root, "STRAMGT353/policy-local.md", "---\npolicy: local_only\n---\nSECRET LOCAL BODY")
    await put(
      root,
      "STRAMGT353/policy-unknown.md",
      "---\nai_policy: maybe\n---\nSECRET UNKNOWN BODY",
    )
    await put(root, "STRAMGT353/reading.pdf", Buffer.from([0x25, 0x50, 0x44, 0x46]))
    await put(
      root,
      "STRAMGT353/reading.pdf.md",
      "---\nredistribution: restricted\n---\nSECRET SIDE-CAR BODY",
    )

    const context = await inspectWorkspace(root)
    const serialized = JSON.stringify(context)
    expect(context.courses[0]?.sources.map((source) => source.path)).toEqual([
      "STRAMGT353/allowed.md",
    ])
    expect(context.courses[0]?.excluded.map((source) => source.path)).toHaveLength(6)
    expect(serialized).not.toMatch(
      /SECRET|PROHIBITED BODY|RESTRICTED BODY|LOCAL BODY|UNKNOWN BODY|SIDE-CAR BODY/,
    )
  })

  it("skips symlinks, private metadata, dotfiles, and notices unsupported binary documents", async () => {
    const root = await fixture()
    await put(root, "FINC320/safe.md", "Readable")
    await put(root, "FINC320/.hidden.md", "hidden secret")
    await put(root, "FINC320/_meta/tasks/private/task.json", "private secret")
    await put(root, "FINC320/scanned.pdf", Buffer.from([0x25, 0x50, 0x44, 0x46, 0]))
    await put(root, "outside.md", "outside")
    await symlink(join(root, "outside.md"), join(root, "FINC320", "linked.md"))
    await symlink(join(root, "outside.md"), join(root, "OTHER999"))

    const context = await inspectWorkspace(root)
    expect(context.courses).toHaveLength(1)
    expect(context.courses[0]?.sources.map((source) => source.path)).toEqual(["FINC320/safe.md"])
    expect(context.courses[0]?.excluded).toContainEqual({
      path: "FINC320/scanned.pdf",
      reason: "Unsupported or binary file type; text not read",
    })
    expect(context.notices).toContain("Skipped symbolic link: FINC320/linked.md")
    expect(context.notices).toContain("Skipped symbolic link: OTHER999")
    expect(JSON.stringify(context)).not.toContain("private secret")
    expect(JSON.stringify(context)).not.toContain("hidden secret")
  })

  it("rejects missing and ambiguous course selection", async () => {
    const root = await fixture()
    await put(root, "ACCT312/a.md", "A")
    await put(root, "ACCT313/b.md", "B")
    const context = await inspectWorkspace(root)
    expect(() => selectCourse(context, "missing")).toThrow(/No course matches/)
    expect(() => selectCourse(context, "ACCT31")).toThrow(/ambiguous/)
    expect(selectCourse(context, "ACCT312").code).toBe("ACCT312")
  })

  it("recognizes dashed course codes and fails closed on malformed or scalar frontmatter", async () => {
    const root = await fixture()
    await put(root, "COURSE-101/ok.md", "---\nai_policy: allowed\n---\nAllowed")
    await put(
      root,
      "COURSE-101/broken.md",
      "---\nai_policy: prohibited\nNo closing delimiter\nSECRET",
    )
    await put(root, "COURSE-101/scalar.md", "---\nrestricted\n---\nSECRET SCALAR")
    const context = await inspectWorkspace(root)
    expect(context.courses).toHaveLength(1)
    expect(context.courses[0]?.code).toBe("COURSE-101")
    expect(context.courses[0]?.sources.map((source) => source.path)).toEqual(["COURSE-101/ok.md"])
    expect(context.courses[0]?.excluded.map(({ path }) => path)).toEqual([
      "COURSE-101/broken.md",
      "COURSE-101/scalar.md",
    ])
    expect(JSON.stringify(context)).not.toContain("SECRET")
  })

  it("lists only valid pending private task records without exposing their contents", async () => {
    const root = await fixture()
    const pendingId = "123e4567-e89b-42d3-a456-426614174000"
    await put(
      root,
      `_meta/tasks/${pendingId}/task.json`,
      JSON.stringify({ status: "pending", sources: [{ text: "PRIVATE SOURCE" }] }),
    )
    await put(root, "_meta/tasks/not-a-uuid/task.json", JSON.stringify({ status: "pending" }))
    await put(
      root,
      "_meta/tasks/123e4567-e89b-42d3-a456-426614174001/task.json",
      JSON.stringify({ status: "completed" }),
    )
    const context = await inspectWorkspace(root)
    expect(context.pendingTasks).toEqual([`_meta/tasks/${pendingId}`])
    expect(JSON.stringify(context)).not.toContain("PRIVATE SOURCE")
  })

  it("does not modify source files during inspection", async () => {
    const root = await fixture()
    const path = join(root, "MGTECON500", "notes.md")
    await put(root, "MGTECON500/notes.md", "# Notes\nText")
    const before = await readFile(path)
    await inspectWorkspace(root)
    expect(await readFile(path)).toEqual(before)
  })

  it("recognizes mapped nonstandard roots without exposing operational metadata or credentials", async () => {
    const root = await fixture()
    await put(root, "F26-ACCT-340/00 Home.md", "# Accounting")
    await put(root, "F26-ACCT-340/credentials.txt", "DO NOT EXPOSE THIS TOKEN")
    await put(root, "F26-ACCT-340/Week 03 - Oct 12/Materials/notes.md", "Class notes")
    await put(
      root,
      "_meta/canvas-courses.json",
      JSON.stringify({
        version: 1,
        courses: [{ id: "99", code: "F26-ACCT-340", root: "F26-ACCT-340", name: "Accounting" }],
      }),
    )
    const context = await inspectWorkspace(root)
    expect(context.courses[0]).toMatchObject({
      root: "F26-ACCT-340",
      title: "Accounting",
      canvasId: "99",
      periods: ["F26-ACCT-340/Week 03 - Oct 12"],
    })
    expect(JSON.stringify(context)).not.toContain("DO NOT EXPOSE")
    expect(context.courses[0]?.excluded).toContainEqual({
      path: "F26-ACCT-340/credentials.txt",
      reason: "Credential-like file; text omitted",
    })
  })
})
