import { describe, expect, it } from "vitest"
import type { SourceRecord, WorkspaceContext } from "../../src/shared/types.js"
import { collectUpcoming } from "../../src/student/upcoming.js"

describe("local work visibility", () => {
  it("retains undated assignments and includes today's announcements only in timeline mode", () => {
    const source = (
      title: string,
      type: string,
      metadata: Partial<SourceRecord>,
    ): SourceRecord => ({
      path: `MBA-101/${type}/${title}.md`,
      title,
      type,
      dates: [],
      text: "",
      hash: "0".repeat(64),
      ...metadata,
    })
    const context: WorkspaceContext = {
      version: 1,
      vault: "/synthetic",
      notices: [],
      pendingTasks: [],
      courses: [
        {
          code: "MBA-101",
          title: "Synthetic course",
          root: "MBA-101",
          excluded: [],
          guidance: [],
          existingWork: [],
          sources: [
            source("Unscheduled", "assignment", {}),
            source("Tomorrow", "assignment", { dueAt: "2026-10-10T10:00:00Z" }),
            source("Today", "announcement", { postedAt: "2026-10-09T08:00:00Z" }),
            source("Yesterday", "announcement", { postedAt: "2026-10-08T08:00:00Z" }),
          ],
        },
      ],
    }
    const options = { now: new Date("2026-10-09T12:00:00Z"), days: 14 }
    const homework = collectUpcoming(context, options)
    expect(homework.items.map((item) => item.title)).toEqual(["Tomorrow"])
    expect(homework.undated.map((item) => item.title)).toEqual(["Unscheduled"])
    const timeline = collectUpcoming(context, { ...options, includeAnnouncements: true })
    expect(timeline.items.map((item) => item.title)).toEqual(["Today", "Tomorrow"])
    expect(timeline.overdue).toEqual([])
  })
})
