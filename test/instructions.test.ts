import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { discoverInstructions } from "../src/instructions.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "canvas-instructions-"))
  roots.push(root)
  const original = await discoverInstructions()
  for (const file of original.files) {
    const path = join(root, file.relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, await readFile(file.path))
  }
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "canvas-agent", version: original.packageVersion }),
  )
  return { root, original }
}

it("reports exact instruction paths/hashes and equal core content without claiming injection or authenticity", async () => {
  const { root } = await fixture()
  const result = await discoverInstructions(root)
  expect(result.files.map((file) => file.id)).toEqual([
    "agents",
    "cli",
    "workflows",
    "prep",
    "assignment",
    "setup",
  ])
  expect(result).toMatchObject({
    sharedCoreConsistent: true,
    contextInjectionVerified: false,
    instructionAuthenticityVerified: false,
  })
  for (const file of result.files) {
    const bytes = await readFile(file.path)
    expect(file.path).toBe(join(root, file.relativePath))
    expect(file.bytes).toBe(bytes.length)
    expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
  }
  expect(JSON.stringify(result)).not.toContain("Canvas is GET-only")
})

it("returns literal case-insensitive topic paragraphs with exact source lines and intact fences", async () => {
  const { root } = await fixture()
  const path = join(root, "plugins/canvas-agent/references/cli.md")
  await writeFile(
    path,
    `${await readFile(path, "utf8")}\n## Synthetic lookup\n\nLiteral [needle].\n\n\`\`\`text\nLOOKUP_SENTINEL\n\n# not a heading\n\`\`\`\n`,
  )
  const result = await discoverInstructions(root, "lookup_sentinel")
  expect(result.lookup).toMatchObject({
    topic: "lookup_sentinel",
    matchMode: "literal-case-insensitive",
    completeReference: false,
    fileId: "cli",
    excerpts: [
      { heading: "Synthetic lookup", text: "```text\nLOOKUP_SENTINEL\n\n# not a heading\n```" },
    ],
  })
  const lines = (await readFile(path, "utf8")).split("\n")
  for (const part of result.lookup?.excerpts ?? [])
    expect(lines.slice(part.startLine - 1, part.endLine).join("\n")).toBe(part.text)
  const literal = await discoverInstructions(root, "[needle]")
  expect(literal.lookup?.excerpts).toHaveLength(1)
  expect((await discoverInstructions(root)).lookup).toBeUndefined()
})

it("refuses invalid, missing and excessive topic results without echoing private queries", async () => {
  const { root } = await fixture()
  for (const topic of ["", "x", "x".repeat(121), "secret\n", "secret\u0000"])
    await expect(discoverInstructions(root, topic)).rejects.toThrow("printable characters")
  await expect(discoverInstructions(root, "PRIVATE_UNKNOWN_QUERY")).rejects.toThrow(
    "No installed CLI guidance matches that literal topic",
  )
  const path = join(root, "plugins/canvas-agent/references/cli.md")
  await writeFile(path, `${await readFile(path, "utf8")}\n\nBROAD_SENTINEL ${"a".repeat(66_000)}\n`)
  await expect(discoverInstructions(root, "BROAD_SENTINEL")).rejects.toThrow("too broad")
})

it.each(["different", "duplicate", "missing"])(
  "refuses a %s shared core without changing any document",
  async (mode) => {
    const { root } = await fixture()
    const path = join(root, "AGENTS.md")
    const original = await readFile(path, "utf8")
    const changed =
      mode === "different"
        ? original.replace("## Core CLI contract", "## A different contract")
        : mode === "duplicate"
          ? `${original}\n<!-- canvas-agent-cli:start -->`
          : original.replace("<!-- canvas-agent-cli:end -->", "")
    await writeFile(path, changed)
    await expect(discoverInstructions(root)).rejects.toThrow(/instruction core/)
    expect(await readFile(path, "utf8")).toBe(changed)
  },
)

it("refuses linked, missing, oversized and invalid instruction artifacts without echoing content", async () => {
  const { root } = await fixture()
  const path = join(root, "AGENTS.md")
  const original = await readFile(path)
  await rm(path)
  await expect(discoverInstructions(root)).rejects.toThrow("unavailable or unsafe: agents")
  const target = join(root, "synthetic-target.md")
  await writeFile(target, original)
  await symlink(target, path)
  await expect(discoverInstructions(root)).rejects.toThrow("unavailable or unsafe: agents")
  await rm(path)
  await writeFile(path, "")
  await truncate(path, 24 * 1024 + 1)
  await expect(discoverInstructions(root)).rejects.toThrow("unavailable or unsafe: agents")
  await writeFile(path, Buffer.from([0xff]))
  await expect(discoverInstructions(root)).rejects.toThrow("unavailable or unsafe: agents")
  await writeFile(path, original)
  await writeFile(join(root, "package.json"), "PRIVATE_METADATA_SENTINEL")
  await expect(discoverInstructions(root)).rejects.toThrow("metadata is unavailable or invalid")
})

it("runs the compiled config-free command outside checkout without reading malformed config or dotenv", async () => {
  const { root } = await fixture()
  const config = join(root, "invalid-config.json")
  await writeFile(config, "PRIVATE_CONFIG_SENTINEL")
  await writeFile(join(root, ".env"), "CANVAS_INSTRUCTION_SECRET=PRIVATE_CREDENTIAL_SENTINEL\n")
  const result = spawnSync(
    process.execPath,
    [resolve("dist/cli.js"), "instructions", "--config", config, "--json"],
    {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root },
      encoding: "utf8",
      timeout: 30_000,
    },
  )
  expect(result.status, result.stderr).toBe(0)
  const index = JSON.parse(result.stdout)
  expect(index.files.find((file: { id: string }) => file.id === "assignment").path).toBe(
    resolve("plugins/canvas-agent/skills/assignment-workflow/SKILL.md"),
  )
  expect(result.stdout + result.stderr).not.toMatch(
    /PRIVATE_CONFIG_SENTINEL|PRIVATE_CREDENTIAL_SENTINEL/,
  )
  expect(await readFile(config, "utf8")).toBe("PRIVATE_CONFIG_SENTINEL")
  expect(await readFile(join(root, ".env"), "utf8")).toContain("PRIVATE_CREDENTIAL_SENTINEL")
  const lookup = spawnSync(
    process.execPath,
    [resolve("dist/cli.js"), "instructions", "--topic", "calculate", "--config", config, "--json"],
    { cwd: root, env: { PATH: process.env.PATH, HOME: root }, encoding: "utf8", timeout: 30_000 },
  )
  expect(lookup.status, lookup.stderr).toBe(0)
  expect(JSON.parse(lookup.stdout).lookup.excerpts.length).toBeGreaterThan(0)
  expect(lookup.stdout + lookup.stderr).not.toMatch(
    /PRIVATE_CONFIG_SENTINEL|PRIVATE_CREDENTIAL_SENTINEL/,
  )
})
