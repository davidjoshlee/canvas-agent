import { expect, it } from "vitest"
import {
  isRestrictedGuidanceExclusion,
  isSourceExclusionCode,
  legacySourceExclusionCode,
  savedExclusions,
} from "../../src/shared/exclusions.js"

it("strips live exclusion codes before task snapshots while preserving historical fields", () => {
  const live = [
    {
      path: "CS101/guidance/prep-guidance.md",
      reason: "Restricted policy metadata; text omitted",
      reasonCode: "source.restricted_policy_metadata" as const,
    },
  ]
  expect(savedExclusions(live)).toEqual([
    { path: "CS101/guidance/prep-guidance.md", reason: "Restricted policy metadata; text omitted" },
  ])
  expect(JSON.stringify(savedExclusions(live))).not.toContain("reasonCode")
  expect(isSourceExclusionCode(live[0]?.reasonCode)).toBe(true)
  expect(isSourceExclusionCode("source.future_code")).toBe(false)
})

it("decodes known historical availability exclusions without treating them as policy", () => {
  const reasons = [
    "Unknown availability evidence; excluded from as-of snapshot",
    "Invalid availability signal; excluded from as-of snapshot",
    "Contains a future availability signal; excluded from as-of snapshot",
    "Contains a future availability signal; excluded from derived as-of snapshot",
  ]
  for (const reason of reasons) {
    expect(isRestrictedGuidanceExclusion({ path: "CS101/guidance/guide.md", reason })).toBe(false)
    expect(legacySourceExclusionCode(reason)).toMatch(/^source\.availability_/)
  }
  expect(
    isRestrictedGuidanceExclusion({
      path: "CS101/guidance/guide.md",
      reason: "unrecognized policy exclusion",
    }),
  ).toBe(true)
})
