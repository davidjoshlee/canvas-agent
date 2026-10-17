import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { harnessCalculations } from "../helpers/harness-calculations.js"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each([
  ["forward", "ordinary"],
  ["forward", "frozen"],
  ["compact", "ordinary"],
  ["compact", "frozen"],
] as const)(
  "replays actual fresh %s %s host output with harness calculations and preserved retry bytes",
  async (family, mode) => {
    const root = await mkdtemp(join(tmpdir(), "canvas-host-forward-replay-"))
    roots.push(root)
    const vault = join(root, "vault"),
      config = join(root, "config.json")
    const env = Object.fromEntries(
      ["PATH", "SystemRoot", "COMSPEC", "PATHEXT"]
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]]),
    )
    const cli = (args: string[]) => {
      const result = spawnSync(
        process.execPath,
        [resolve("dist/cli.js"), ...args, "--config", config, "--json"],
        { cwd: root, env, encoding: "utf8", timeout: 30_000, maxBuffer: 5_000_000 },
      )
      expect(result.status, result.stderr).toBe(0)
      return JSON.parse(result.stdout)
    }
    cli(["init", "--vault", vault, "--canvas-url", "https://canvas.example.invalid"])
    const originals = new Map<string, Buffer>()
    for (const [name, path] of [
      ["prompt.md", "ECON901/Assignments/launch.md"],
      ["case.md", "ECON901/Week 02 - Oct 12/launch-case.md"],
      ["marginal-analysis.md", "ECON901/Week 02 - Oct 12/marginal-analysis.md"],
      ["course-guidance.md", "ECON901/Guidance/course-guidance.md"],
      ["assignment-guidance.md", "ECON901/Guidance/assignment-50.md"],
    ] as const) {
      const bytes = await readFile(resolve("test/fixtures/host-numeric", name))
      const target = join(vault, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
      originals.set(target, bytes)
    }
    const created =
      mode === "ordinary"
        ? cli(["prep", "ECON901", "--week", "2026-10-12"])
        : cli([
            "simulate",
            "task",
            "create",
            cli(["simulate", "capture", "ECON901", "--as-of", "2026-10-13"]).id,
            "--kind",
            "assignment",
            "--source",
            "ECON901/Assignments/launch.md",
            "--mode",
            "draft",
            "--context",
            "ECON901/Week 02 - Oct 12/launch-case.md",
          ])
    const recipePath = join(
      vault,
      mode === "ordinary" ? "_meta/tasks" : "_meta/simulations/tasks",
      created.id,
      mode === "ordinary" ? "task.json" : "record.json",
    )
    const recipeBytes = await readFile(recipePath)
    const before = cli(
      mode === "ordinary" ? ["task", "show", created.id] : ["simulate", "task", "show", created.id],
    )
    const fixtures = `test/fixtures/host-${family}`
    const batch = resolve(fixtures, `${mode}-calculations.json`)
    const candidate = join(root, "candidate.md")
    const text = (await readFile(resolve(fixtures, `${mode}-candidate.md`), "utf8")).replace(
      "{{TASK_ID}}",
      created.id,
    )
    await writeFile(candidate, text)
    const calculations = harnessCalculations(
      mode === "ordinary"
        ? ["calculate", "--file", batch]
        : ["simulate", "task", "calculate", created.id, "--file", batch],
    )
    expect(calculations.length).toBeGreaterThan(0)
    expect(await readFile(recipePath)).toEqual(recipeBytes)
    const args =
      mode === "ordinary"
        ? ["task", "complete", created.id, "--file", candidate]
        : ["simulate", "task", "complete", created.id, "--file", candidate]
    const completed = cli(args)
    const output = join(vault, completed.output)
    expect(await readFile(output, "utf8")).toBe(text)
    const retainedRecipe = await readFile(recipePath)
    expect(cli(args)).toEqual(completed)
    expect(await readFile(recipePath)).toEqual(retainedRecipe)
    expect(await readFile(output, "utf8")).toBe(text)
    if (mode === "ordinary") {
      const current = cli(["task", "show", created.id])
      expect(current.sources).toEqual(before.sources)
      expect(current.guidance).toEqual(before.guidance)
      expect(cli(["inspect", created.id]).snapshots.current).toBe(true)
    } else {
      expect(retainedRecipe).toEqual(recipeBytes)
      expect(cli(["simulate", "task", "show", created.id])).toMatchObject({
        state: "completed-pending-human",
      })
    }
    for (const [path, bytes] of originals) expect(await readFile(path)).toEqual(bytes)
  },
  30000,
)
