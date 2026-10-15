import { createHash } from "node:crypto"
import type { SourceRecord } from "./types.js"

export interface RevisionEdits {
  version: 1
  work: string
  beforeHash: string
  afterHash: string
  diff: string
}

/** Exact textual evidence only, not authorship, semantic intent or approval. */
export function revisionLineDiff(before: string, after: string): string {
  if (Buffer.byteLength(before) > 5_000_000 || Buffer.byteLength(after) > 5_000_000)
    throw new Error("Revision edit inputs exceed the bounded text limit")
  if (before === after) return "(no textual changes)"
  for (const text of [before, after]) {
    let lines = 1
    for (let i = 0; i < text.length; i++)
      if (text[i] === "\n" && ++lines > 50_000)
        throw new Error("Revision edit inputs exceed the bounded line limit")
  }
  const left = before.split("\n"),
    right = after.split("\n")
  // Never allocate an unbounded quadratic matrix. The replacement fallback still
  // reports all bytes; it simply makes no claim to a minimal edit script.
  if ((left.length + 1) * (right.length + 1) > 1_000_000)
    return [
      "(whole-text replacement; minimal diff omitted for size)",
      ...left.map((line) => `-${line}`),
      ...right.map((line) => `+${line}`),
    ].join("\n")
  const width = right.length + 1
  const cells = new Uint32Array((left.length + 1) * width)
  const at = (i: number, j: number) => cells[i * width + j] ?? 0
  for (let i = left.length - 1; i >= 0; i--)
    for (let j = right.length - 1; j >= 0; j--)
      cells[i * width + j] =
        left[i] === right[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
  const edits: string[] = []
  let i = 0,
    j = 0
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      i++
      j++
      continue
    }
    if (j < right.length && (i === left.length || at(i, j + 1) >= at(i + 1, j)))
      edits.push(`+${right[j++]}`)
    else edits.push(`-${left[i++]}`)
  }
  return edits.join("\n")
}

export function captureRevisionEdits(
  sources: SourceRecord[],
  prior: string,
  work: string,
): RevisionEdits {
  const before = sources.find((source) => source.path === prior)
  const after = sources.find((source) => source.path === work)
  const sha = (text: string) => createHash("sha256").update(text).digest("hex")
  if (
    !before ||
    !after ||
    before.type !== "student-work" ||
    after.type !== "student-work" ||
    before.hash !== sha(before.text) ||
    after.hash !== sha(after.text)
  )
    throw new Error("Revision edit evidence requires exact selected student-work snapshots")
  return {
    version: 1,
    work,
    beforeHash: before.hash,
    afterHash: after.hash,
    diff: revisionLineDiff(before.text, after.text),
  }
}
