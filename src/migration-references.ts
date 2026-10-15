import { lstat } from "node:fs/promises"
import { join, posix } from "node:path"
import { isScalar, isSeq, parseDocument, parse as parseYaml } from "yaml"
import { assertNoSymlinks } from "./fs-safety.js"

type Move = { source: string; destination: string; hash: string }
export type WikiTargetHint = { name: string; target: string }
const safe = (path: string) =>
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path
    .split("/")
    .some(
      (part, index, parts) =>
        !part ||
        part === "." ||
        part === ".." ||
        (part.startsWith("_") &&
          !(index === parts.length - 1 && /^_index(?:\.md)?$/i.test(part))) ||
        part.startsWith("."),
    )

/** Explicit student choices, not an inferred global Obsidian name index. */
export function validateWikiTargets(hints: readonly WikiTargetHint[] = []): WikiTargetHint[] {
  if (!Array.isArray(hints) || hints.length > 100)
    throw new Error("Wiki target choices must be a bounded list of at most 100 entries")
  const seen = new Set<string>()
  const unsafeCharacters = (value: string, delimiters: string[]) =>
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127 ||
        delimiters.includes(character),
    )
  return hints
    .map((hint) => {
      if (
        !hint ||
        typeof hint.name !== "string" ||
        typeof hint.target !== "string" ||
        !hint.name ||
        hint.name.length > 200 ||
        unsafeCharacters(hint.name, ["/", "\\", "#", "|", "[", "]", "?"]) ||
        hint.target.length > 2000 ||
        unsafeCharacters(hint.target, ["#", "|", "[", "]", "?"]) ||
        !safe(hint.name) ||
        !safe(hint.target) ||
        ![posix.basename(hint.target), posix.basename(hint.target).replace(/\.md$/i, "")].includes(
          hint.name,
        )
      )
        throw new Error(
          "Wiki target choice requires an exact filename and safe vault-relative path",
        )
      const key = hint.name.replace(/\.md$/i, "").normalize("NFC")
      if (seen.has(key)) throw new Error("Duplicate wiki target names require one explicit choice")
      seen.add(key)
      return { name: hint.name, target: hint.target }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

function decodeAttribute(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: "\u00a0",
    AMP: "&",
    QUOT: '"',
    LT: "<",
    GT: ">",
  }
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z\d]+);/gi, (_whole, entity: string) => {
    if (!entity.startsWith("#")) {
      const decoded = named[entity]
      if (decoded === undefined) throw new Error("Unsupported named HTML entity requires review")
      return decoded
    }
    const code =
      entity[1]?.toLowerCase() === "x"
        ? Number.parseInt(entity.slice(2), 16)
        : Number(entity.slice(1))
    if (
      !Number.isInteger(code) ||
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      throw new Error("Invalid numeric HTML entity")
    return String.fromCodePoint(code)
  })
}
const escapeAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")

/** Rebase current path references only; preserve literal code and historical comments. */
export async function rebaseMigrationReferences(
  bytes: Buffer,
  move: Move,
  moves: readonly Move[],
  root: string,
  options: { affectedOnly?: boolean; wikiTargets?: readonly WikiTargetHint[] } = {},
): Promise<{ bytes: Buffer; changes: number }> {
  if (!/\.(?:md|markdown|txt|html?)$/i.test(move.source)) return { bytes, changes: 0 }
  const text = bytes.toString("utf8")
  if (bytes.includes(0) || !Buffer.from(text).equals(bytes))
    throw new Error("Reference document is not safe UTF-8")
  const mapping = new Map(moves.map((entry) => [entry.source, entry.destination]))
  const wikiTargets = validateWikiTargets(options.wikiTargets)
  let changes = 0,
    body = text,
    header = ""
  const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/)
  if (frontmatter) {
    const meta: unknown = parseYaml(frontmatter[1] ?? "")
    if (!meta || typeof meta !== "object" || Array.isArray(meta))
      throw new Error("Invalid reference metadata")
    header = frontmatter[0]
    body = text.slice(header.length)
    const record = meta as Record<string, unknown>
    if (record.related_paths !== undefined) {
      const doc = parseDocument(frontmatter[1] ?? "")
      const node = doc.get("related_paths", true)
      const values = isSeq(node) ? node.items : [node]
      if (
        !values.length ||
        values.length > 100 ||
        doc.errors.length ||
        values.some(
          (value) =>
            !isScalar(value) ||
            typeof value.value !== "string" ||
            !value.range ||
            value.type === "BLOCK_LITERAL" ||
            value.type === "BLOCK_FOLDED",
        )
      )
        throw new Error(
          "Related paths require a bounded scalar or string list; aliases/block values need review",
        )
      const replacements: Array<{ start: number; end: number; value: string }> = []
      const offset = header.indexOf(frontmatter[1] ?? "")
      for (const value of values) {
        if (!isScalar(value) || typeof value.value !== "string" || !value.range)
          throw new Error("Invalid related path node")
        const path = value.value
        if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(path)) continue
        if (!safe(path)) throw new Error("Related path escapes the vault or private scope")
        const sourceRoot = move.source.split("/")[0] ?? ""
        const original =
          mapping.has(path) || path.startsWith(`${sourceRoot}/`) ? path : `${sourceRoot}/${path}`
        const destination = mapping.get(original) ?? original
        if (options.affectedOnly && destination === original) continue
        const targetPath = join(root, ...original.split("/"))
        await assertNoSymlinks(targetPath)
        if (!(await lstat(targetPath)).isFile())
          throw new Error("Related path target is not a regular file")
        if (destination !== original) {
          replacements.push({
            start: offset + value.range[0],
            end: offset + value.range[1],
            value: JSON.stringify(destination),
          })
          changes++
        }
      }
      for (const replacement of replacements.sort((a, b) => b.start - a.start))
        header =
          header.slice(0, replacement.start) + replacement.value + header.slice(replacement.end)
    }
    if (
      record.original_path !== undefined &&
      (!options.affectedOnly ||
        (typeof record.original_path === "string" &&
          mapping.has(record.original_path) &&
          mapping.get(record.original_path) !== record.original_path))
    ) {
      const path = record.original_path
      if (
        typeof path !== "string" ||
        !safe(path) ||
        !path.startsWith(`${move.source.split("/")[0]}/`)
      )
        throw new Error("Extraction original path is outside the selected course")
      const original = moves.find((entry) => entry.source === path)
      if (!original || record.original_hash !== original.hash)
        throw new Error(
          "Extraction original is missing from the migration or its hash does not match",
        )
      if (!/^original_path:[^\r\n]*$/m.test(header))
        throw new Error("Extraction path needs single-line YAML metadata")
      header = header.replace(
        /^original_path:[^\r\n]*$/m,
        `original_path: ${JSON.stringify(original.destination)}`,
      )
      changes++
    }
  } else if (/^---(?:\s*\r?\n|$)/.test(text)) throw new Error("Malformed reference frontmatter")
  async function target(value: string): Promise<string> {
    if (!value || /^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(value)) return value
    if (value.startsWith("/") || value.includes("\\"))
      throw new Error("Absolute or escaped local link requires review")
    const split = value.search(/[?#]/),
      encoded = split < 0 ? value : value.slice(0, split),
      suffix = split < 0 ? "" : value.slice(split)
    if (!encoded) return value
    let decoded: string
    try {
      decoded = decodeURIComponent(encoded)
    } catch {
      throw new Error("Invalid encoded local link")
    }
    if (decoded.startsWith("/") || decoded.includes("\\"))
      throw new Error("Encoded absolute local link requires review")
    const original = posix.normalize(posix.join(posix.dirname(move.source), decoded))
    if (!safe(original))
      throw new Error("Local link escapes the vault or points into private metadata")
    const destination = mapping.get(original) ?? original
    if (options.affectedOnly && destination === original) return value
    const file = join(root, ...original.split("/"))
    await assertNoSymlinks(file)
    const stat = await lstat(file)
    if (!stat.isFile()) throw new Error("Local link target is not a regular file")
    const relative = posix.relative(posix.dirname(move.destination), destination)
    const rebased =
      relative
        .split("/")
        .map((part) => encodeURIComponent(part).replaceAll("(", "%28").replaceAll(")", "%29"))
        .join("/") + suffix
    if (rebased !== value) changes++
    return rebased
  }
  async function replace(
    value: string,
    expression: RegExp,
    transform: (match: RegExpMatchArray) => Promise<string>,
  ) {
    for (const match of [...value.matchAll(expression)].reverse()) {
      const start = match.index ?? 0
      value =
        value.slice(0, start) + (await transform(match)) + value.slice(start + match[0].length)
    }
    return value
  }
  async function wiki(payload: string) {
    const alias = payload.indexOf("|"),
      name = alias < 0 ? payload : payload.slice(0, alias),
      display = alias < 0 ? "" : payload.slice(alias)
    const anchor = name.indexOf("#"),
      path = anchor < 0 ? name : name.slice(0, anchor),
      suffix = anchor < 0 ? "" : name.slice(anchor)
    if (!path) return `[[${payload}]]`
    if (!safe(path)) throw new Error("Wiki link needs an explicit safe vault-relative path")
    const hint = !path.includes("/")
      ? wikiTargets.find(
          (entry) =>
            entry.name.replace(/\.md$/i, "").normalize("NFC") ===
            path.replace(/\.md$/i, "").normalize("NFC"),
        )
      : undefined
    if (!path.includes("/") && !hint) {
      if (options.affectedOnly) return `[[${payload}]]`
      throw new Error(
        "Short-name wiki link requires an explicit --wiki-target NAME=VAULT_PATH choice",
      )
    }
    const candidates: string[] = []
    for (const candidate of hint ? [hint.target] : [path, `${path}.md`]) {
      const file = join(root, ...candidate.split("/"))
      await assertNoSymlinks(file, true)
      try {
        if ((await lstat(file)).isFile()) candidates.push(candidate)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    if (candidates.length !== 1)
      throw new Error("Wiki link target is absent or ambiguous in the vault")
    const original = candidates[0]
    if (!original) throw new Error("Wiki target resolution failed")
    const file = join(root, ...original.split("/"))
    await assertNoSymlinks(file)
    if (!(await lstat(file)).isFile()) throw new Error("Wiki target is not a regular file")
    let destination = mapping.get(original) ?? original
    if (options.affectedOnly && destination === original) return `[[${payload}]]`
    if (!/\.md$/i.test(path) && /\.md$/i.test(original)) destination = destination.slice(0, -3)
    if (destination !== path) changes++
    return `[[${destination}${suffix}${display}]]`
  }
  // Never rewrite paths in captured run headers, source quotations in code, or examples.
  const parts = body.split(
    /(<!--[\s\S]*?-->|^```[^\r\n]*\r?\n[\s\S]*?^```[^\r\n]*$|^~~~[^\r\n]*\r?\n[\s\S]*?^~~~[^\r\n]*$|`+[^`\r\n]*`+)/gm,
  )
  for (let index = 0; index < parts.length; index += 2) {
    let value = parts[index] ?? ""
    value = await replace(value, /<[A-Za-z][^>\r\n]*>/g, async (tag) =>
      replace(
        tag[0],
        /\b(href|src)\s*=\s*(?:(["'])([^"']+)\2|([^\s"'>]+))/gi,
        async (attribute) => {
          const href = attribute[3] ?? attribute[4] ?? ""
          if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(href)) return attribute[0]
          const decoded = decodeAttribute(href)
          if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(decoded)) return attribute[0]
          const next = await target(decoded)
          return next === decoded
            ? attribute[0]
            : `${attribute[1]}=${attribute[2] ?? '"'}${escapeAttribute(next)}${attribute[2] ?? '"'}`
        },
      ),
    )
    const matches: Array<{ index: number; length: number; payload: string }> = []
    for (const start of value.matchAll(/\]\(/g)) {
      const from = start.index ?? 0
      let depth = 1,
        quote = "",
        angle = false,
        end = from + 2
      for (; end < value.length; end++) {
        const char = value[end] ?? ""
        if (/\r|\n/.test(char)) throw new Error("Multiline Markdown destination requires review")
        if (char === "\\") {
          end++
          continue
        }
        if (quote) {
          if (char === quote) quote = ""
          continue
        }
        if (angle) {
          if (char === ">") angle = false
          continue
        }
        if (char === "<" && end === from + 2) {
          angle = true
          continue
        }
        if ((char === '"' || char === "'") && /\s/.test(value[end - 1] ?? "")) {
          quote = char
          continue
        }
        if (char === "(" && ++depth > 32)
          throw new Error("Markdown destination nesting exceeds limit")
        if (char === ")" && --depth === 0) break
      }
      if (depth !== 0 || quote || angle)
        throw new Error("Unclosed Markdown destination requires review")
      matches.push({ index: from, length: end - from + 1, payload: value.slice(from + 2, end) })
    }
    for (const match of matches.reverse()) {
      const payload = match.payload,
        parsed = payload.match(/^(?:<([^>]+)>|(\S+?))(\s+["'][^\r\n]*["'])?$/)
      if (!parsed) throw new Error("Complex Markdown destination requires manual review")
      const rawHref = parsed[1] ?? parsed[2] ?? ""
      const href = /^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(rawHref)
        ? rawHref
        : rawHref.replace(/\\([()[\]<>\\])/g, "$1")
      const next = await target(href)
      const replacement = `](${parsed[1] ? `<${next}>` : next}${parsed[3] ?? ""})`
      const start = match.index ?? 0
      value = value.slice(0, start) + replacement + value.slice(start + match.length)
    }
    value = await replace(
      value,
      /^([ \t]{0,3}\[[^\]\r\n]+\]:[ \t]*)(?:<([^>\r\n]+)>|(\S+))([^\r\n]*)$/gm,
      async (match) => {
        const href = match[2] ?? match[3] ?? "",
          next = await target(href)
        return `${match[1]}${match[2] ? `<${next}>` : next}${match[4] ?? ""}`
      },
    )
    value = await replace(value, /\[\[([^\]\r\n]+)\]\]/g, async (match) => wiki(match[1] ?? ""))
    parts[index] = value
  }
  return { bytes: Buffer.from(header + parts.join("")), changes }
}
