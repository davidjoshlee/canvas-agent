import { spawnSync } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import ts from "typescript"
import { expect, it } from "vitest"

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = join(directory, entry.name)
        return entry.isDirectory() ? files(path) : [path]
      }),
    )
  ).flat()
}

it("keeps runtime code grouped and scripts limited to maintained verification", async () => {
  const source = await readdir("src", { withFileTypes: true })
  expect(
    source
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort(),
  ).toEqual(["cli.ts", "turndown.d.ts"])
  expect(
    (await readdir("scripts", { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort(),
  ).toEqual(["build.mjs", "package-smoke.mjs", "sync-context.mjs"])
  expect(
    (await files("dist")).filter((path) =>
      /(?:migration|index-reconciliation|school-index|\/legacy\.js|\/evaluation\/)/.test(path),
    ),
  ).toEqual([])
  const manifest = JSON.parse(await readFile("package.json", "utf8"))
  expect(manifest.bin["canvas-agent"]).toBe("dist/cli.js")
  expect(manifest.files).not.toContain("docs/**")
})

it.each([
  ["legacy"],
  ["dogfood"],
  ["reminders"],
  ["auth", "alerts"],
  ["simulate", "window"],
  ["simulate", "compare"],
  ["gate", "m1"],
  ["vault", "migrate"],
  ["vault", "preserve-school"],
  ["vault", "reconcile-index"],
])("does not expose removed commands: %s %s", (...args) => {
  const result = spawnSync(process.execPath, [resolve("dist/cli.js"), ...args], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 30_000,
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("unknown command")
})

/** Use the compiler parser so type-only relationships do not masquerade as runtime cycles. */
async function runtimeImports(): Promise<Map<string, string[]>> {
  const graph = new Map<string, string[]>()
  for (const file of (await files("src")).filter((file) => file.endsWith(".ts"))) {
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest)
    const imports: string[] = []
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
      const specifier = statement.moduleSpecifier
      if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) continue
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause
        if (clause?.isTypeOnly) continue
        if (
          clause &&
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.every((item) => item.isTypeOnly)
        )
          continue
      } else {
        if (statement.isTypeOnly) continue
        if (
          statement.exportClause &&
          ts.isNamedExports(statement.exportClause) &&
          statement.exportClause.elements.every((item) => item.isTypeOnly)
        )
          continue
      }
      imports.push(
        relative(process.cwd(), resolve(dirname(file), specifier.text.replace(/\.js$/, ".ts"))),
      )
    }
    graph.set(file, imports)
  }
  return graph
}

it("keeps the static runtime dependency graph acyclic", async () => {
  const graph = await runtimeImports()
  const visited = new Set<string>()
  const active: string[] = []
  const cycles: string[] = []
  function visit(file: string) {
    const index = active.indexOf(file)
    if (index >= 0) {
      cycles.push([...active.slice(index), file].join(" → "))
      return
    }
    if (visited.has(file)) return
    active.push(file)
    for (const dependency of graph.get(file) ?? []) visit(dependency)
    active.pop()
    visited.add(file)
  }
  for (const file of graph.keys()) visit(file)
  expect(cycles).toEqual([])
})

it("keeps deterministic modules independent of orchestration and persistence", async () => {
  const graph = await runtimeImports()
  for (const [file, dependencies] of graph) {
    if (!file.startsWith("src/cli/") && file !== "src/cli.ts")
      expect(
        dependencies.filter((path) => path.startsWith("src/cli/")),
        file,
      ).toEqual([])
    if (
      [
        "src/tasks/compatibility/workbook.ts",
        "src/tasks/compatibility/calculation-core.ts",
      ].includes(file)
    )
      expect(
        dependencies.filter((path) =>
          /src\/(?:cli|simulation|vault)\/|src\/tasks\/(?:store|tools)\.ts|src\/tasks\/(?:artifacts\/(?:records|completion)|authoring\/creation)\.ts/.test(
            path,
          ),
        ),
        file,
      ).toEqual([])
    if (file === "src/canvas/client.ts")
      expect(
        dependencies.filter((path) =>
          /src\/(?:tasks|simulation|student|vault)\/|src\/canvas\/sync/.test(path),
        ),
        file,
      ).toEqual([])
  }
})

it("keeps development tooling out of all runtime imports", async () => {
  for (const file of (await files("src")).filter((file) => file.endsWith(".ts"))) {
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest)
    function visit(node: ts.Node) {
      if (ts.isStringLiteral(node) && node.text.startsWith(".")) {
        const target = relative(process.cwd(), resolve(dirname(file), node.text))
        expect(target.startsWith("tools/"), `${file}: ${node.text}`).toBe(false)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
})

it.each([["--notify-due-soon"], ["--lead-days", "7"]])(
  "rejects removed sync notification options: %s",
  (...args) => {
    const result = spawnSync(process.execPath, [resolve("dist/cli.js"), "sync", ...args], {
      env: { PATH: process.env.PATH },
      encoding: "utf8",
      timeout: 30_000,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("unknown option")
  },
)

it("does not ship retired notification implementations", async () => {
  const output = new Set(await files("dist"))
  for (const module of ["student/reminders", "auth/alerts", "canvas/sync-workflow"]) {
    expect(output.has(`dist/${module}.js`)).toBe(false)
    expect(output.has(`dist/${module}.d.ts`)).toBe(false)
  }
})
