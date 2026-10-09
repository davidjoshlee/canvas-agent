import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  applyCalendarOverrides,
  compareCalendar,
  exportCalendar,
  readCalendarFile,
  setCalendarOverride,
} from "../src/calendar.js"
import { proposeGuidance, saveGuidanceProposal } from "../src/guidance.js"
import type { WorkspaceContext } from "../src/types.js"
import { collectUpcoming, readUpcoming } from "../src/upcoming.js"

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

function context(vault: string): WorkspaceContext {
  return {
    version: 1,
    vault,
    pendingTasks: [],
    notices: [],
    courses: [
      {
        code: "FIN-101",
        title: "Finance",
        root: "FIN-101",
        canvasId: "course-1",
        excluded: [],
        guidance: ["FIN-101/Guidance/active.md"],
        existingWork: [],
        sources: [
          {
            path: "FIN-101/Syllabus.md",
            title: "Syllabus",
            hash: "a".repeat(64),
            text: "Course syllabus",
            type: "syllabus",
            dates: [],
          },
          {
            path: "FIN-101/Assignments/Case.md",
            title: "Case Memo",
            hash: "b".repeat(64),
            text: "---\ncanvas_id: assignment-7\n---\nDue: 2026-10-20T17:00:00Z",
            type: "assignment",
            dates: [],
            canvasId: "assignment-7",
            dueAt: "2026-10-20T17:00:00Z",
          },
        ],
      },
    ],
  }
}

describe("student date and guidance parity", () => {
  it("saves guidance candidates as new proposal versions while preserving active guidance", async () => {
    const vault = await temporaryDirectory("student-guidance-")
    const course = join(vault, "FIN-101")
    await mkdir(join(course, "Guidance"), { recursive: true })
    await writeFile(join(course, "Syllabus.md"), "# Syllabus\nAI policy unclear.\n")
    await writeFile(join(course, "Guidance", "active.md"), "Active original\n")
    const ctx = context(vault)
    const selectedCourse = ctx.courses[0]
    if (!selectedCourse) throw new Error("Test course missing")
    const proposal = await proposeGuidance(vault, ctx, selectedCourse)
    const task = await readFile(proposal.task, "utf8")
    const proposalRecord = JSON.parse(
      await readFile(
        join(vault, "_meta", "guidance-proposals", proposal.id, "proposal.json"),
        "utf8",
      ),
    ) as {
      sources: Array<{ path: string; hash: string; text: string }>
      guidance: Array<{ path: string; hash: string; text: string }>
    }
    expect(task).toContain("Do not treat silence as permission")
    expect(await readFile(proposal.instructions, "utf8")).toContain("Syllabus.md")
    expect(proposalRecord.sources[0]).toMatchObject({
      path: "FIN-101/Syllabus.md",
      text: "# Syllabus\nAI policy unclear.",
    })
    expect(proposalRecord.sources[0]?.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(proposalRecord.guidance[0]).toMatchObject({
      path: "FIN-101/Guidance/active.md",
      text: "Active original\n",
    })
    const candidate = join(vault, "candidate.md")
    await writeFile(candidate, "# Proposed guidance\n\n## Brief structure\nOverview\n")
    const first = await saveGuidanceProposal(vault, proposal.id, candidate)
    const second = await saveGuidanceProposal(vault, proposal.id, candidate)
    expect(first).toMatch(/prep-guidance\.proposed\.v1\.md$/)
    expect(second).toMatch(/prep-guidance\.proposed\.v2\.md$/)
    expect(await readFile(join(course, "Guidance", "active.md"), "utf8")).toBe("Active original\n")

    const staleSyllabus = await proposeGuidance(vault, ctx, selectedCourse)
    await writeFile(join(course, "Syllabus.md"), "# Updated syllabus\n")
    await expect(saveGuidanceProposal(vault, staleSyllabus.id, candidate)).rejects.toThrow(
      /changed since this proposal/i,
    )
    expect(await readFile(join(course, "Guidance", "active.md"), "utf8")).toBe("Active original\n")
    expect(
      await readFile(join(course, "Guidance", "prep-guidance.proposed.v2.md"), "utf8"),
    ).toContain("# Proposed guidance")

    const staleGuidance = await proposeGuidance(vault, ctx, selectedCourse)
    await writeFile(join(course, "Guidance", "active.md"), "Human updated active guidance\n")
    await expect(saveGuidanceProposal(vault, staleGuidance.id, candidate)).rejects.toThrow(
      /changed since this proposal/i,
    )
    expect(await readFile(join(course, "Guidance", "active.md"), "utf8")).toBe(
      "Human updated active guidance\n",
    )
  })

  it("requires a readable syllabus before creating a guidance proposal", async () => {
    const vault = await temporaryDirectory("student-guidance-no-syllabus-")
    const course = join(vault, "FIN-101")
    await mkdir(course, { recursive: true })
    const ctx = context(vault)
    const selectedCourse = ctx.courses[0]
    if (!selectedCourse) throw new Error("Test course missing")
    await expect(proposeGuidance(vault, ctx, selectedCourse)).rejects.toThrow(
      /No readable syllabus/i,
    )
  })

  it("keeps calendar overrides private, bounded to assignment paths, and independent", async () => {
    const vault = await temporaryDirectory("student-calendar-")
    await mkdir(join(vault, "FIN-101", "Assignments"), { recursive: true })
    const path = "FIN-101/Assignments/Case.md"
    await writeFile(join(vault, path), "assignment file")
    const ctx = context(vault)
    await setCalendarOverride(vault, ctx, path, "2026-10-22T17:00:00Z")
    await setCalendarOverride(vault, ctx, path, "2026-10-23T17:00:00Z")
    const file = join(vault, "_meta", "calendar-overrides.json")
    const entries = JSON.parse(await readFile(file, "utf8")) as Array<{
      path: string
      dueAt: string
    }>
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ path, dueAt: "2026-10-23T17:00:00Z" })
    const adjusted = await applyCalendarOverrides(vault, ctx)
    await expect(
      readUpcoming(vault, ctx, { now: new Date("2026-10-01T00:00:00Z"), days: 60 }),
    ).resolves.toMatchObject({ items: [{ dueAt: "2026-10-23T17:00:00Z" }] })
    expect(
      collectUpcoming(adjusted, { now: new Date("2026-10-01T00:00:00Z"), days: 60 }).items[0]
        ?.dueAt,
    ).toBe("2026-10-23T17:00:00Z")
    await expect(setCalendarOverride(vault, ctx, "../outside.md", "2026-10-24")).rejects.toThrow(
      /relative|unsafe/i,
    )
    await expect(setCalendarOverride(vault, ctx, path, "2026-02-30")).rejects.toThrow(/ISO/)
    expect(
      JSON.stringify(
        await import("../src/workspace.js").then(({ inspectWorkspace }) => inspectWorkspace(vault)),
      ),
    ).not.toContain("calendar-overrides")
  })

  it("reports calendar ambiguity and exports without replacing an existing file", async () => {
    const vault = await temporaryDirectory("student-ics-")
    const ctx = context(vault)
    const selectedCourse = ctx.courses[0]
    const assignment = selectedCourse?.sources[1]
    if (!selectedCourse || !assignment) throw new Error("Test assignment missing")
    const duplicated = {
      ...ctx,
      courses: [
        {
          ...selectedCourse,
          sources: [
            ...selectedCourse.sources,
            {
              ...assignment,
              path: "FIN-101/Assignments/Case-copy.md",
              canvasId: "assignment-8",
            },
          ],
        },
      ],
    }
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:one",
      "SUMMARY:Case Memo",
      "DTSTART:20261020T170000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n")
    expect(
      compareCalendar(duplicated, ics).filter((notice) => notice.kind === "ambiguous"),
    ).toHaveLength(2)
    const authoritative = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:assignment-assignment-7@canvas-agent.local",
      "X-CANVAS-ASSIGNMENT-ID:assignment-7",
      "SUMMARY:Renamed",
      "DTSTART;TZID=America/Los_Angeles:20261020T170000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n")
    expect(compareCalendar(ctx, authoritative)).toMatchObject([
      {
        kind: "mismatch",
        canvasId: "assignment-7",
        detail: "Floating or TZID calendar dates are not compared; use a UTC event.",
      },
    ])
    expect(
      compareCalendar(ctx, "BEGIN:VCALENDAR\r\nEND:VCALENDAR").some((notice) =>
        notice.detail?.includes("no matching calendar event"),
      ),
    ).toBe(true)
    const target = join(vault, "calendar.ics")
    const due = collectUpcoming(ctx, { now: new Date("2026-10-01T00:00:00Z"), days: 60 }).items
    await exportCalendar(target, due)
    const contents = await readFile(target, "utf8")
    expect(contents).toContain("X-CANVAS-ASSIGNMENT-ID:assignment-7")
    expect(contents).toContain("DUE:20261020T170000Z")
    await expect(exportCalendar(target, due)).rejects.toThrow()
    expect(await readFile(target, "utf8")).toBe(contents)
    const pathOnly = [
      {
        kind: "assignment",
        course: "FIN-101",
        title: "Manual assignment",
        path: "FIN-101/Assignments/manual.md",
        dueAt: "2026-10-21T12:00:00Z",
        overdue: false,
      },
    ]
    const noIdTarget = join(vault, "manual.ics")
    await exportCalendar(noIdTarget, pathOnly)
    expect(await readFile(noIdTarget, "utf8")).toContain("UID:path-")
  })

  it("rejects symlink assignment paths and symlink ICS input destinations", async () => {
    const vault = await temporaryDirectory("student-symlink-")
    await mkdir(join(vault, "FIN-101", "Assignments"), { recursive: true })
    const outside = join(vault, "outside.md")
    await writeFile(outside, "private")
    await symlink(outside, join(vault, "FIN-101", "Assignments", "Case.md"))
    await expect(
      setCalendarOverride(vault, context(vault), "FIN-101/Assignments/Case.md", "2026-10-22"),
    ).rejects.toThrow()
    const linked = join(vault, "linked.ics")
    await symlink(outside, linked)
    await expect(exportCalendar(linked, [])).rejects.toThrow()
    await expect(readCalendarFile(linked)).rejects.toThrow()
    expect((await lstat(linked)).isSymbolicLink()).toBe(true)
  })
})
