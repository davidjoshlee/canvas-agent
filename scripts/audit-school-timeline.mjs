import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"
import { planDueSoon, renderDueSoon } from "../src/reminders.ts"
import { readTimeline } from "../src/timeline.ts"

// Pure fake-index/source audit: no database, account, real vault, notifier or model.
const school = process.argv[2]
if (!school || !isAbsolute(school)) throw new Error("Supply an absolute School Agent checkout path")
const path = join(school, "src/engines/timeline.ts")
const { buildTimeline, writeDueSoonReminders } = await import(pathToFileURL(path).href)
const vault = await mkdtemp(join(tmpdir(), "canvas-school-timeline-audit-"))
const item = (id, kind, at, courseCode = "CS101") => ({
  kind,
  canvasId: id,
  courseCode,
  title: `Synthetic ${id}`,
  ...(kind === "assignment" ? { dueAt: at } : { postedAt: at }),
})
const context = (rows) => ({
  version: 1,
  vault,
  pendingTasks: [],
  notices: [],
  courses: [...new Set(rows.map((row) => row.courseCode))].map((code) => ({
    code,
    root: code,
    title: code,
    existingWork: [],
    excluded: [],
    guidance: [],
    sources: rows
      .filter((row) => row.courseCode === code)
      .map((row) => ({
        path: `${code}/${row.kind}/${row.canvasId}.md`,
        title: row.title,
        canvasId: row.canvasId,
        hash: "synthetic",
        text: "Synthetic source",
        type: row.kind,
        dates: [],
        dueAt: row.dueAt ?? undefined,
        postedAt: row.postedAt ?? undefined,
      })),
  })),
})
const project = (timeline) => ({
  dated: timeline.dated.map((day) => ({
    week: day.week,
    date: day.date,
    items: day.items.map((entry) => ({
      kind: entry.kind,
      canvasId: entry.canvasId,
      course: entry.courseCode ?? entry.course,
      title: entry.title,
      at: entry.at,
      actionRequired: entry.actionRequired,
    })),
  })),
  undated: timeline.undated
    .map((entry) => ({
      kind: entry.kind,
      canvasId: entry.canvasId,
      course: entry.courseCode ?? entry.course,
      actionRequired: entry.actionRequired,
    }))
    .sort((a, b) => `${a.course}:${a.canvasId}`.localeCompare(`${b.course}:${b.canvasId}`)),
})
try {
  const cases = [
    {
      name: "UTC day start and exclusive horizon",
      now: "2026-10-13T18:00:00Z",
      rows: [
        item("1", "assignment", "2026-10-13T08:00:00Z"),
        item("2", "announcement", "2026-10-13T09:00:00Z"),
        item("3", "assignment", "2026-10-20T00:00:00Z"),
        item("4", "assignment", "2026-10-19T23:59:59Z"),
        item("5", "assignment", "2026-10-12T23:59:59Z"),
      ],
    },
    {
      name: "undated assignment and announcement",
      now: "2026-10-13T18:00:00Z",
      rows: [item("1", "assignment", null), item("2", "announcement", null)],
    },
    {
      name: "course scope",
      now: "2026-10-13T18:00:00Z",
      course: "CS101",
      rows: [
        item("1", "assignment", "2026-10-14T08:00:00Z"),
        item("2", "assignment", "2026-10-14T08:00:00Z", "OTHER101"),
      ],
    },
    {
      name: "ISO year rollover",
      now: "2020-12-31T18:00:00Z",
      rows: [
        item("1", "assignment", "2021-01-01T08:00:00Z"),
        item("2", "announcement", "2021-01-04T09:00:00Z"),
      ],
    },
  ]
  for (const example of cases) {
    const now = new Date(example.now),
      index = { timelineEntries: () => example.rows }
    const original = buildTimeline({ index, weeks: 1, now, course: example.course })
    const current = await readTimeline(vault, context(example.rows), {
      weeks: 1,
      now,
      course: example.course,
    })
    assert.deepEqual(project(current), project(original))
  }
  const rows = [item("1", "assignment", "2021-01-01T00:30:00+02:00")],
    now = new Date("2020-12-31T18:00:00Z")
  const original = buildTimeline({ index: { timelineEntries: () => rows }, weeks: 1, now })
  const current = await readTimeline(vault, context(rows), { weeks: 1, now })
  assert.equal(original.dated[0].date, "2021-01-01")
  assert.equal(current.dated[0].date, "2020-12-31")
  const reminderRows = [
    item("1", "assignment", "2026-10-13T18:00:00Z"),
    item("2", "assignment", "2026-10-20T18:00:00Z"),
    item("3", "assignment", "2026-10-20T18:00:00.001Z"),
    item("4", "assignment", "2026-10-13T17:59:59Z"),
    item("5", "announcement", "2026-10-14T18:00:00Z"),
  ]
  for (const entries of [[], reminderRows]) {
    let content = "",
      notifications = 0
    const now = new Date("2026-10-13T18:00:00Z")
    await writeDueSoonReminders({
      index: { timelineEntries: () => entries },
      leadDays: 7,
      now,
      canvasUrl: "https://canvas.example.test",
      vault: {
        writeMetadata: async (value) => {
          content = value.content
        },
      },
      notify: async () => {
        notifications++
      },
    })
    const plan = await planDueSoon(vault, context(entries), { days: 7, now })
    assert.deepEqual(
      renderDueSoon(plan)
        .split("\n")
        .filter((line) => line.startsWith("- ")),
      content.split("\n").filter((line) => line.startsWith("- ")),
    )
    assert.equal(notifications, plan.items.length ? 1 : 0)
  }
  const reminderPath = join(school, "src/engines/timeline-reminders.ts")
  console.log(
    JSON.stringify(
      {
        status: "shared-synthetic-timeline-cases-pass",
        source: {
          path,
          sha256: createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        },
        sharedCases: cases.map((example) => example.name),
        reminderCases: 2,
        reminderSource: {
          path: reminderPath,
          sha256: createHash("sha256")
            .update(await readFile(reminderPath))
            .digest("hex"),
        },
        deliberateDifferences: [
          "Offset timestamp grouping uses actual UTC day",
          "Canvas retains earlier overdue assignments separately",
          "Undated ties sort by local path",
        ],
        scope:
          "pure date/grouping/attention behavior only; no live source coverage, notifications or submission verification",
      },
      null,
      2,
    ),
  )
} finally {
  await rm(vault, { recursive: true, force: true })
}
