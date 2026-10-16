import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { SourceRecord } from "../../src/shared/types.js"
import { captureRevisionEdits, revisionLineDiff } from "../../src/tasks/evidence/revision-edits.js"

const source = (path: string, text: string): SourceRecord => ({
  path,
  text,
  hash: createHash("sha256").update(text).digest("hex"),
  title: path,
  type: "student-work",
  dates: [],
})
describe("snapshot-bound revision edits", () => {
  it("renders exact additions/deletions, repeated lines and unchanged work deterministically", () => {
    expect(revisionLineDiff("A\nB\nC", "A\nD\nC")).toBe("+D\n-B")
    expect(revisionLineDiff("A\nB\nA", "A\nA")).toBe("-B")
    expect(revisionLineDiff("A", "A\n")).toBe("+")
    expect(revisionLineDiff("A", "A")).toBe("(no textual changes)")
    expect(revisionLineDiff("", "A")).toBe("+A\n-")
  })
  it("labels whole-text replacement rather than allocating a huge matrix", () => {
    const before = Array(1100).fill("A").join("\n")
    const after = Array(1100).fill("B").join("\n")
    const diff = revisionLineDiff(before, after)
    expect(diff).toContain("minimal diff omitted for size")
    expect(diff.split("\n").filter((line) => line === "-A")).toHaveLength(1100)
    expect(diff.split("\n").filter((line) => line === "+B")).toHaveLength(1100)
    expect(() => revisionLineDiff("X".repeat(5_000_001), "A")).toThrow(/bounded/)
    expect(() => revisionLineDiff("\n".repeat(50_000), "A")).toThrow(/line limit/)
  })
  it("requires exact selected work bytes and does not read live paths", () => {
    const before = source("CS101/Drafts/prior.md", "Original")
    const after = source("CS101/Drafts/edits.md", "Changed")
    expect(captureRevisionEdits([before, after], before.path, after.path)).toMatchObject({
      version: 1,
      work: after.path,
      beforeHash: before.hash,
      afterHash: after.hash,
      diff: "+Changed\n-Original",
    })
    expect(() => captureRevisionEdits([before], before.path, after.path)).toThrow(/snapshots/)
    expect(() =>
      captureRevisionEdits([before, { ...after, text: "Replaced" }], before.path, after.path),
    ).toThrow(/snapshots/)
    expect(() =>
      captureRevisionEdits([before, { ...after, type: "assignment" }], before.path, after.path),
    ).toThrow(/student-work/)
  })
})
