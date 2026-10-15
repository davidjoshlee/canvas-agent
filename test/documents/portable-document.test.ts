import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import {
  type PortableDocumentInput,
  portableModuleBody,
  readPortableContext,
  renderPortableDocument,
} from "../../src/documents/portable-document.js"

const input: PortableDocumentInput = {
  canvasId: "50",
  canvasUrl: "https://canvas.example.test/courses/1/assignments/50",
  kind: "assignment",
  title: "Synthetic task",
  body: "# Synthetic task\n\nDescribe the synthetic framework.",
  source: "sync",
  status: "final",
  aiPolicy: "allowed",
  redistribution: "restricted",
  dates: { due_at: "2026-10-09T12:00:00Z", unlock_at: null },
  moduleCanvasId: "22",
  relatedPaths: ["CS101/Resources/reading.md"],
}
describe("portable document serializer", () => {
  it("keeps exact source/policy fields in strict YAML and hash-binds additional context separately", () => {
    const document = renderPortableDocument(input)
    const [, yaml = "", body = ""] = document.markdown.split(/---\n/)
    const metadata = parse(yaml)
    expect(metadata.type).toBe("assignments")
    expect(metadata.ai_policy).toBe("allowed")
    expect(metadata.redistribution).toBe("restricted")
    expect(metadata.dates).toEqual(input.dates)
    expect(metadata.module_canvas_id).toBe("22")
    expect(metadata.title).toBeUndefined()
    expect(metadata.related_paths).toBeUndefined()
    expect(metadata.content_hash).toBe(createHash("sha256").update(body).digest("hex"))
    expect(readPortableContext(document.markdown, document.context)).toEqual(document.context)
    expect(() =>
      readPortableContext(`${document.markdown}\nEdited body.`, document.context),
    ).toThrow(/stale/)
    expect(() =>
      readPortableContext(document.markdown, { ...document.context, ai_policy: "allowed" }),
    ).toThrow()
  })

  it("never invents eligibility and refuses credential URLs, unsafe provenance, malformed bounds", () => {
    expect(() =>
      renderPortableDocument({ ...input, aiPolicy: undefined } as unknown as PortableDocumentInput),
    ).toThrow()
    const restricted = renderPortableDocument({
      ...input,
      aiPolicy: "prohibited",
      redistribution: "restricted",
    })
    expect(restricted.markdown).toContain('ai_policy: "prohibited"')
    for (const canvasUrl of [
      "https://user:secret@canvas.example.test",
      "https://canvas.example.test?access_token=secret",
      "javascript:alert(1)",
    ])
      expect(() => renderPortableDocument({ ...input, canvasUrl })).toThrow()
    for (const originalPath of [
      "../other.md",
      "/private.md",
      "CS101/_meta/private.md",
      "CS101/.env",
      "CS101/a\\b",
    ])
      expect(() =>
        renderPortableDocument({ ...input, originalPath, originalHash: "1".repeat(64) }),
      ).toThrow()
    expect(() =>
      renderPortableDocument({ ...input, originalPath: "CS101/files/original.pdf" }),
    ).toThrow(/both/)
    expect(() => renderPortableDocument({ ...input, body: "x".repeat(5 * 1024 * 1024) })).toThrow(
      /5 MB/,
    )
    expect(() => renderPortableDocument({ ...input, body: "unsafe\0text" })).toThrow()
  })

  it("renders module roots as typed single-line items without hiding metadata in content", () => {
    const body = portableModuleBody("Session 2", [
      { type: "Assignment", title: "Synthetic task", canvasId: "50" },
      { type: "Page", title: "Reading", pageUrl: "reading" },
      { type: "File", title: "Case", canvasId: "88" },
    ])
    expect(body).toBe(
      "Session 2\n- Assignment: Synthetic task (canvas_id: 50)\n- Page: Reading (page_url: reading)\n- File: Case (canvas_id: 88)\n",
    )
    const document = renderPortableDocument({ ...input, kind: "module", body, modulePosition: 2 })
    expect(document.context.modulePosition).toBe(2)
    expect(document.markdown).not.toContain("modulePosition")
    expect(() => portableModuleBody("Bad\nTitle", [])).toThrow()
    expect(() =>
      portableModuleBody("Session", [{ type: "File", title: "Case", canvasId: "88)\nInjected" }]),
    ).toThrow()
  })
})
