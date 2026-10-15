import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readCoursePlaybook } from "../src/canvas-feedback.js"
import { completeTask } from "../src/completion.js"
import {
  importLegacyPlaybook,
  inspectLegacyPlaybook,
  readImportedPlaybooks,
} from "../src/legacy-playbook.js"
import { createReadingCopy, planReadingCopy } from "../src/reading-copy.js"
import { createPrepTask, readTask } from "../src/tasks.js"
import { inspectWorkspace, selectCourse } from "../src/workspace.js"

const roots: string[] = []
const base = "https://canvas.example.test"
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-legacy-playbook-"))
  roots.push(root)
  const vault = join(root, "vault")
  await mkdir(join(vault, "CS101/_meta"), { recursive: true })
  await mkdir(join(vault, "_meta"))
  await mkdir(join(vault, "CS101/Week 1 - Oct 5"))
  await writeFile(
    join(vault, "_meta/canvas-courses.json"),
    JSON.stringify({
      version: 1,
      courses: [{ id: "1", code: "CS101", name: "Synthetic course", root: "CS101" }],
    }),
  )
  await writeFile(
    join(vault, "CS101/Week 1 - Oct 5/reading.md"),
    "Substantive synthetic framework evidence for preparation, not actual coursework.",
  )
  const source = join(vault, "CS101/_meta/course-playbook.md")
  const raw =
    "---\ncanvas_id: course-playbook\ncanvas_url: https://canvas.example.test/courses/1\ntype: course-playbook.md\nai_policy: allowed\nredistribution: allowed\n---\n## 2026-10-01 — Case\nScore: 83\nInstructor comment: PRIVATE_LEGACY_LESSON use stronger evidence.\n"
  await writeFile(source, raw)
  return { root, vault, source, raw }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe("explicit legacy playbook migration", () => {
  it("inspects metadata, imports privately/idempotently and preserves originals and unknown historical claims", async () => {
    const f = await fixture()
    const before = await readFile(f.source)
    const metadata = await inspectLegacyPlaybook(f.vault, "CS101", base)
    expect(JSON.stringify(metadata)).not.toContain("PRIVATE_LEGACY_LESSON")
    expect(metadata.historicalDatesVerified).toBe(false)
    const imported = await importLegacyPlaybook(f.vault, "CS101", base)
    expect(imported.reused).toBe(false)
    expect((await importLegacyPlaybook(f.vault, "CS101", base)).reused).toBe(true)
    expect(await readFile(f.source)).toEqual(before)
    const book = await readCoursePlaybook(f.vault, "CS101")
    expect(book.history.records).toHaveLength(0)
    expect(book.history.legacyPlaybooks?.[0]?.text).toContain("PRIVATE_LEGACY_LESSON")
    expect(book.history.legacyPlaybooks?.[0]?.historicalAuthorshipVerified).toBe(false)
    const task = await createPrepTask(f.vault, "CS101", "2026-10-05")
    expect(task.learningHistory?.legacyPlaybooks).toHaveLength(1)
    expect(task.sources.some((source) => source.text.includes("PRIVATE_LEGACY_LESSON"))).toBe(false)
    const candidate = join(f.root, "candidate.md")
    await writeFile(
      candidate,
      [
        `Task: ${task.id}`,
        ...task.requirements.map(
          (heading) =>
            `## ${heading}\n${heading === "Sources" ? `\`${task.sources[0]?.path}\`` : "Synthetic structural fixture only."}`,
        ),
      ].join("\n\n"),
    )
    await completeTask(f.vault, task.id, candidate)
    expect((await readTask(f.vault, task.id)).status).toBe("completed")
    const destination = join(f.root, "phone")
    expect(JSON.stringify((await planReadingCopy(f.vault, destination)).files)).not.toContain(
      "course-playbook",
    )
    await createReadingCopy(f.vault, destination)
  })
  it("refuses restricted/wrong-course/wrong-account sources and symlinks without changing originals", async () => {
    const f = await fixture()
    for (const raw of [
      f.raw.replace("ai_policy: allowed", "ai_policy: prohibited"),
      f.raw.replace("redistribution: allowed", "redistribution: restricted"),
      f.raw.replace("courses/1", "courses/2"),
      f.raw.replace("canvas.example.test", "other.example.test"),
    ]) {
      await writeFile(f.source, raw)
      await expect(importLegacyPlaybook(f.vault, "CS101", base)).rejects.toThrow(
        /policy|chosen account/,
      )
      expect(await readFile(f.source, "utf8")).toBe(raw)
    }
    await rm(f.source)
    const other = join(f.root, "outside.md")
    await writeFile(other, f.raw)
    await symlink(other, f.source)
    await expect(importLegacyPlaybook(f.vault, "CS101", base)).rejects.toThrow(/Symbolic links/)
  })
  it("retains changed-source versions, keeps saved task context fixed and rejects private snapshot tampering", async () => {
    const f = await fixture()
    await importLegacyPlaybook(f.vault, "CS101", base)
    const task = await createPrepTask(f.vault, "CS101", "2026-10-05")
    await writeFile(f.source, f.raw.replace("stronger evidence", "check calculations"))
    await importLegacyPlaybook(f.vault, "CS101", base)
    expect((await readCoursePlaybook(f.vault, "CS101")).history.legacyPlaybooks).toHaveLength(2)
    expect((await readTask(f.vault, task.id)).learningHistory?.legacyPlaybooks).toHaveLength(1)
    const directory = join(
      f.vault,
      "_meta/canvas-playbooks/1",
      createHash("sha256").update("CS101").digest("hex"),
    )
    const files = await readdir(directory)
    const path = join(
      directory,
      files.find((file) =>
        file.startsWith(task.learningHistory?.legacyPlaybooks?.[0]?.sourceHash ?? "missing"),
      ) ?? "missing",
    )
    await chmod(path, 0o644)
    await expect(
      readImportedPlaybooks(f.vault, selectCourse(await inspectWorkspace(f.vault), "CS101")),
    ).rejects.toThrow(/bounded permitted/)
    await chmod(path, 0o600)
    await writeFile(path, '{"PRIVATE_BAD_SNAPSHOT":')
    await expect(readCoursePlaybook(f.vault, "CS101")).rejects.toThrow(/snapshot is invalid/)
  })
  it("runs compiled inspect/import/playbook while metadata-only responses never echo private legacy bodies", async () => {
    const f = await fixture(),
      config = join(f.root, "config.json")
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        canvas: { baseUrl: base, tokenEnv: "SYNTHETIC_UNUSED" },
        vault: { path: f.vault },
        courses: { allowlist: [] },
      }),
    )
    const cli = (args: string[]) =>
      spawnSync(process.execPath, [resolve("dist/cli.js"), ...args, "--config", config, "--json"], {
        encoding: "utf8",
      })
    for (const command of ["playbook-inspect", "playbook-import"]) {
      const result = cli(["legacy", command, "CS101"])
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout + result.stderr).not.toContain("PRIVATE_LEGACY_LESSON")
    }
    const book = cli(["playbook", "CS101"])
    expect(book.status, book.stderr).toBe(0)
    expect(JSON.parse(book.stdout).history.legacyPlaybooks).toHaveLength(1)
  })
})
