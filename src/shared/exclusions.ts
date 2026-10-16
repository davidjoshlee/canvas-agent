import type { ExcludedSource } from "./types.js"

/** Stable machine-readable reasons for sources omitted from live workspace context. */
export const sourceExclusionCodes = [
  "source.retired_canvas_owned",
  "source.restricted_policy_metadata",
  "source.credential_like",
  "source.proposed_guidance",
  "source.unsupported_file_type",
  "source.restricted_compatible_policy",
  "source.invalid_extraction_provenance",
  "source.credential_like_original",
  "source.stale_extraction",
  "source.restricted_original_metadata",
  "source.unsafe_extraction_original",
  "source.invalid_assignment_dates",
  "source.file_not_regular_or_too_large",
  "source.read_failed",
  "source.binary_content",
  "source.invalid_utf8",
  "source.malformed_frontmatter",
  "source.availability_unknown",
  "source.availability_invalid",
  "source.availability_future",
] as const

export type SourceExclusionCode = (typeof sourceExclusionCodes)[number]

/** Strip live classification metadata before binding exclusions into saved task snapshots. */
export function savedExclusions(
  excluded: readonly ExcludedSource[],
): Array<Pick<ExcludedSource, "path" | "reason">> {
  return excluded.map(({ path, reason }) => ({ path, reason }))
}

const knownCodes = new Set<string>(sourceExclusionCodes)

export function isSourceExclusionCode(value: unknown): value is SourceExclusionCode {
  return typeof value === "string" && knownCodes.has(value)
}

/** Compatibility adapter for pre-code saved exclusions. New producers must assign a code. */
export function legacySourceExclusionCode(reason: string): SourceExclusionCode | undefined {
  const rules: Array<[RegExp, SourceExclusionCode]> = [
    [/Retired unchanged Canvas-owned source/i, "source.retired_canvas_owned"],
    [/Restricted compatible policy declaration/i, "source.restricted_compatible_policy"],
    [/Restricted policy metadata/i, "source.restricted_policy_metadata"],
    [/Credential-like original/i, "source.credential_like_original"],
    [/Credential-like/i, "source.credential_like"],
    [/Proposed guidance/i, "source.proposed_guidance"],
    [/Unsupported or binary file type/i, "source.unsupported_file_type"],
    [/Extraction sidecar has invalid original provenance/i, "source.invalid_extraction_provenance"],
    [/Extraction sidecar is stale/i, "source.stale_extraction"],
    [
      /Original document has malformed or restricted policy metadata/i,
      "source.restricted_original_metadata",
    ],
    [/Extraction original is missing or unsafe/i, "source.unsafe_extraction_original"],
    [/Invalid assignment date evidence/i, "source.invalid_assignment_dates"],
    [/Not a regular text file or exceeds 5 MB/i, "source.file_not_regular_or_too_large"],
    [/Could not read file/i, "source.read_failed"],
    [/Binary content/i, "source.binary_content"],
    [/Invalid UTF-8/i, "source.invalid_utf8"],
    [/Malformed frontmatter/i, "source.malformed_frontmatter"],
    [/Unknown availability evidence; excluded from as-of snapshot/i, "source.availability_unknown"],
    [/Invalid availability signal; excluded from as-of snapshot/i, "source.availability_invalid"],
    [
      /Contains a future availability signal; excluded from (?:derived )?as-of snapshot/i,
      "source.availability_future",
    ],
  ]
  return rules.find(([pattern]) => pattern.test(reason))?.[1]
}

export function isRestrictedGuidanceExclusion(entry: ExcludedSource): boolean {
  if (entry.reasonCode !== undefined) {
    // Unknown future codes fail closed for guidance: they may represent a restriction.
    return (
      !isSourceExclusionCode(entry.reasonCode) ||
      entry.reasonCode === "source.restricted_policy_metadata" ||
      entry.reasonCode === "source.restricted_compatible_policy" ||
      entry.reasonCode === "source.restricted_original_metadata"
    )
  }
  const legacyCode = legacySourceExclusionCode(entry.reason)
  return (
    legacyCode === undefined ||
    legacyCode === "source.restricted_policy_metadata" ||
    legacyCode === "source.restricted_compatible_policy" ||
    legacyCode === "source.restricted_original_metadata"
  )
}
