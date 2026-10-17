import type { SourceRecord } from "../../shared/types.js"

const STOPWORDS = new Set(
  "a an and are as at be because been being both by can could did do does for from had has have he her here hers him his how i if in into is it its may me might more most my no nor not of on or our ours she should so than that the their theirs them then there these they this those through to too up us very was we were what when where which while who will with would you your yours".split(
    " ",
  ),
)
const MAX_TEXT_BYTES = 20_000_000

function terms(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) ?? []).filter((term) => !STOPWORDS.has(term)),
  )
}

/** A bounded English lexical overlap heuristic. It does not assess meaning or grounding. */
export function prepareAnswerEvidence(sources: SourceRecord[]) {
  const sourceBytes = sources.reduce((total, source) => total + Buffer.byteLength(source.text), 0)
  const pathBytes = sources.reduce((total, source) => total + Buffer.byteLength(source.path), 0)
  if (sources.length > 1000 || sourceBytes > MAX_TEXT_BYTES || pathBytes > 1_000_000)
    throw new Error("Answer evidence sources exceed 1000 paths/1 MB paths/20 MB text")
  const paths = new Set(sources.map((source) => source.path))
  const sourceTerms = new Set<string>()
  for (const source of sources) for (const term of terms(source.text)) sourceTerms.add(term)
  return (question: string, answer: string) => {
    if (sourceBytes + Buffer.byteLength(question) + Buffer.byteLength(answer) > MAX_TEXT_BYTES)
      throw new Error("Answer evidence input exceeds the 20 MB text bound")
    // One pass: citation strings do not inflate counts or cause a path-by-answer scan.
    const strippedAnswer = answer.replace(/`([^`]+)`/g, (full, path: string) =>
      paths.has(path) ? " " : full,
    )
    const questionTerms = terms(question)
    const answerTerms = terms(strippedAnswer)
    const novelTerms = [...answerTerms].filter((term) => !questionTerms.has(term))
    const sourceNovelTerms = novelTerms.filter((term) => sourceTerms.has(term))
    return {
      valid: answerTerms.size >= 5 && novelTerms.length >= 3 && sourceNovelTerms.length >= 2,
      answerTerms: answerTerms.size,
      novelTerms: novelTerms.length,
      sourceNovelTerms: sourceNovelTerms.length,
    }
  }
}
