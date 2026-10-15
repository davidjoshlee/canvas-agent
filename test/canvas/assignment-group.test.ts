import { describe, expect, it } from "vitest"
import {
  assignmentGroupCategory,
  groupCategoryFromPrompt,
} from "../../src/canvas/assignment-group.js"

describe("assignment group identity", () => {
  it("distinguishes absence from a bounded category identity", () => {
    expect(assignmentGroupCategory(null)).toBeUndefined()
    expect(assignmentGroupCategory(undefined)).toBeUndefined()
    expect(assignmentGroupCategory(7)).toBe("7")
    expect(assignmentGroupCategory("123")).toBe("123")
    expect(groupCategoryFromPrompt("Individual assignment")).toBeUndefined()
    expect(groupCategoryFromPrompt("Group category: 7\nGroup category: 7\n")).toBe("7")
  })
  it("rejects malformed and conflicting identities without echoing payloads", () => {
    for (const value of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, {}, "PRIVATE_BAD_ID", "07"])
      expect(() => assignmentGroupCategory(value)).toThrow(/unsupported; no payload was echoed/)
    expect(() => groupCategoryFromPrompt("Group category: \n")).toThrow(/unsupported/)
    expect(() => groupCategoryFromPrompt("Group category: 7\nGroup category: 8")).toThrow(
      /ambiguous/,
    )
  })
})
