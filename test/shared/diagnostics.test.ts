import { describe, expect, it } from "vitest"
import { diagnostic, diagnosticFromLegacyNotice } from "../../src/shared/diagnostics.js"

describe("legacy notice diagnostics", () => {
  it("assigns stable codes while retaining the exact historical notice", () => {
    const notice =
      "Canvas course mappings are unavailable or unsafe; using conventional course folders only."
    expect(diagnosticFromLegacyNotice(notice)).toEqual({
      code: "workspace.course_mappings_unavailable",
      severity: "error",
      scope: "workspace",
      message: notice,
    })
  })

  it("classifies task scope and preserves unknown messages", () => {
    expect(diagnosticFromLegacyNotice("Skipped symbolic link: Foo", "course")).toMatchObject({
      code: "workspace.symlink_skipped",
      severity: "warning",
      scope: "course",
      message: "Skipped symbolic link: Foo",
    })
    expect(diagnosticFromLegacyNotice("New legacy message")).toMatchObject({
      code: "workspace.notice",
      message: "New legacy message",
    })
  })

  it("keeps control decisions stable when a diagnostic display message changes", () => {
    const earlier = diagnostic("workspace.course_mappings_unavailable", "Old wording")
    const current = diagnostic("workspace.course_mappings_unavailable", "Updated wording")
    const blocksTaskCreation = (items: (typeof current)[]) =>
      items.some((item) => item.code === "workspace.course_mappings_unavailable")
    expect(blocksTaskCreation([earlier])).toBe(true)
    expect(blocksTaskCreation([current])).toBe(true)
  })
})
