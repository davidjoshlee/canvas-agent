import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import JSZip from "jszip"
import { afterEach, describe, expect, it } from "vitest"
import { captureSimulation } from "../../src/simulation/captures.js"
import {
  completeSimulationTask,
  createSimulationTask,
  inspectSimulationTask,
  readSimulationTask,
} from "../../src/simulation/tasks.js"
import {
  createSimulationWorkbook,
  readSimulationWorkbooks,
} from "../../src/simulation/workbooks.js"
import { draftWorkbookBytes } from "../../src/tasks/draft-workbook.js"
import {
  compareSimulationEvaluations,
  readSimulationComparison,
} from "../../tools/evaluation/comparison.js"
import { comparisonM1Bundle } from "../../tools/evaluation/m1.js"
import { evaluationCliArgs } from "../helpers/evaluation-cli.js"

const roots: string[] = []
const tables =
  "### Cash schedule\n| Label | Value |\n| --- | --- |\n| PRIVATE_AUTO_CELL | $1,200 |\n| Literal formula | =1+2 |\n\n## Computations\n- Change — (50)\n"
async function fixture(extra = tables) {
  const base = await mkdtemp(join(tmpdir(), "canvas-auto-frozen-"))
  roots.push(base)
  const vault = join(base, "vault")
  const source = "CS101/Assignments/prompt.md"
  await mkdir(join(vault, "CS101/Assignments"), { recursive: true })
  const original =
    "---\ntype: assignment\navailable_at: 2026-10-05\n---\nExplain the synthetic pricing framework."
  await writeFile(join(vault, source), original)
  const capture = await captureSimulation(vault, "CS101", "2026-10-09")
  const task = await createSimulationTask(vault, capture.id, {
    kind: "assignment",
    source,
    mode: "draft",
  })
  const recipe = await readSimulationTask(vault, task.id)
  const text = [
    `Task: ${task.id}`,
    ...recipe.task.requirements.map(
      (heading) =>
        `## ${heading}\n${heading === "Sources" ? `\`${source}\`` : "Synthetic mechanical-validator evidence only; not coursework."}`,
    ),
    extra,
  ].join("\n\n")
  const candidate = join(base, "candidate.md")
  await writeFile(candidate, text)
  const directory = join(vault, "_meta/simulations/tasks", task.id)
  return { base, vault, source, original, task, recipe, candidate, text, directory }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("automatic fixed-evaluation workbooks", () => {
  it("reserves automatic capacity before completion and applies the combined 20-companion limit", async () => {
    const f = await fixture()
    const input = join(f.base, "manual.json")
    await writeFile(input, JSON.stringify({ sheets: [{ name: "Manual", rows: [[500]] }] }))
    const first = await createSimulationWorkbook(f.vault, f.task.id, input)
    const original = join(f.directory, "workbooks", first.id)
    const saved = JSON.parse(await readFile(join(original, "record.json"), "utf8"))
    // Synthetic persisted manual bundles; no live material or actual user records.
    for (let i = 1; i < 19; i++) {
      const id = randomUUID(),
        destination = join(f.directory, "workbooks", id)
      await mkdir(destination)
      await writeFile(join(destination, "input.json"), await readFile(join(original, "input.json")))
      await writeFile(
        join(destination, "workbook.xlsx"),
        await readFile(join(original, "workbook.xlsx")),
      )
      await writeFile(
        join(destination, "record.json"),
        JSON.stringify({
          ...saved,
          id,
          output: `${f.recipe.task.destination}/workbooks/${id}/workbook.xlsx`,
        }),
      )
    }
    expect((await readSimulationWorkbooks(f.vault, f.task.id)).records).toHaveLength(19)
    await expect(createSimulationWorkbook(f.vault, f.task.id, input)).rejects.toThrow(
      /count or byte limit/,
    )
    await completeSimulationTask(f.vault, f.task.id, f.candidate)
    expect((await readSimulationWorkbooks(f.vault, f.task.id)).records).toHaveLength(20)
    await expect(createSimulationWorkbook(f.vault, f.task.id, input)).rejects.toThrow(
      /count or byte limit/,
    )
    expect(await completeSimulationTask(f.vault, f.task.id, f.candidate)).toMatchObject({
      workbookVersion: 1,
    })
  }, 15_000)

  it("binds a private automatic companion through completion, inventory, comparison and M1", async () => {
    const f = await fixture()
    const recipeBytes = await readFile(join(f.directory, "record.json"))
    expect(f.recipe.workbookVersion).toBe(1)
    expect(f.recipe.task.workbookVersion).toBe(1)
    const completed = await completeSimulationTask(f.vault, f.task.id, f.candidate)
    expect(completed.workbookVersion).toBe(1)
    expect(completed.workbook?.sheets).toEqual(["Cash schedule", "Computations"])
    expect(completed.workbook?.output).toBe(`${f.recipe.task.destination}/output.xlsx`)
    const bytes = await readFile(join(f.vault, completed.workbook?.output ?? "missing"))
    const zip = await JSZip.loadAsync(bytes)
    const xml = await zip.file("xl/worksheets/sheet1.xml")?.async("string")
    expect(xml).toContain("<v>1200</v>")
    expect(xml).toContain("=1+2")
    expect(xml).not.toContain("<f>")
    await writeFile(join(f.vault, f.source), "Changed live prompt; do not substitute.")
    expect(await completeSimulationTask(f.vault, f.task.id, f.candidate)).toEqual(completed)
    expect((await inspectSimulationTask(f.vault, f.task.id)).state).toBe("completed-pending-human")
    const input = join(f.base, "explicit.json")
    await writeFile(
      input,
      JSON.stringify({ sheets: [{ name: "Manual", rows: [["PRIVATE_MANUAL_CELL", 500]] }] }),
    )
    await createSimulationWorkbook(f.vault, f.task.id, input)
    const inventory = await readSimulationWorkbooks(f.vault, f.task.id)
    expect(inventory.records).toHaveLength(2)
    expect(inventory.records.find((r) => r.automatic)?.automatic?.candidateHash).toBe(
      completed.outputHash,
    )
    expect(inventory.records.find((r) => r.automatic)?.hash).toBe(completed.workbook?.hash)
    const compared = await compareSimulationEvaluations(f.vault, "CS101", [f.task.id])
    expect(compared.workbookCompanions).toBe(2)
    const saved = await readSimulationComparison(f.vault, "CS101", compared.id)
    expect(saved.artifacts[0]?.workbooks?.records).toEqual(inventory.records)
    expect(saved.comparison).not.toContain("PRIVATE_MANUAL_CELL")
    expect(await comparisonM1Bundle(f.vault, "CS101", compared.id)).toMatchObject({
      workbookCompanions: 2,
      workbookEvidenceCaptured: true,
      verdict: "pending-human",
    })
    expect(await readFile(join(f.directory, "record.json"))).toEqual(recipeBytes)
    expect(await readFile(join(f.directory, "output.xlsx"))).toEqual(bytes)
    expect(await readFile(join(f.vault, f.source), "utf8")).toBe(
      "Changed live prompt; do not substitute.",
    )
  })

  it("rejects modified, missing or rebound automatic evidence before any new gate or repair", async () => {
    const f = await fixture()
    const completed = await completeSimulationTask(f.vault, f.task.id, f.candidate)
    const comparison = await compareSimulationEvaluations(f.vault, "CS101", [f.task.id])
    const path = join(f.directory, "output.xlsx")
    const original = await readFile(path)
    await writeFile(path, "tampered workbook")
    await expect(completeSimulationTask(f.vault, f.task.id, f.candidate)).rejects.toThrow(
      /workbook.*modified/i,
    )
    await expect(readSimulationWorkbooks(f.vault, f.task.id)).rejects.toThrow(/workbook.*modified/i)
    await expect(comparisonM1Bundle(f.vault, "CS101", comparison.id)).rejects.toThrow(
      /workbook.*modified/i,
    )
    await expect(readdir(join(f.vault, "_meta/gates/m1"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(path, "utf8")).toBe("tampered workbook")
    await unlink(path)
    await expect(completeSimulationTask(f.vault, f.task.id, f.candidate)).rejects.toThrow()
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
    await writeFile(path, original)
    const metadata = join(f.directory, "completion.json")
    const bound = JSON.parse(await readFile(metadata, "utf8"))
    bound.workbook.inputHash = "0".repeat(64)
    await writeFile(metadata, JSON.stringify(bound))
    await expect(inspectSimulationTask(f.vault, f.task.id)).rejects.toThrow(/binding changed/)
    await writeFile(metadata, JSON.stringify(completed))
    expect((await inspectSimulationTask(f.vault, f.task.id)).state).toBe("completed-pending-human")
    const recipePath = join(f.directory, "record.json")
    const recipeBytes = await readFile(recipePath, "utf8")
    const changed = JSON.parse(recipeBytes)
    changed.task.createdAt = "2026-10-11T12:00:00.000Z"
    await writeFile(recipePath, JSON.stringify(changed))
    // Even a structurally coherent recipe edit cannot rebind the old receipt.
    expect((await readSimulationTask(f.vault, f.task.id)).task.createdAt).toBe(
      changed.task.createdAt,
    )
    await expect(inspectSimulationTask(f.vault, f.task.id)).rejects.toThrow(/recipe mismatch/)
    await expect(completeSimulationTask(f.vault, f.task.id, f.candidate)).rejects.toThrow(
      /recipe mismatch/,
    )
    await writeFile(recipePath, recipeBytes)
    expect((await inspectSimulationTask(f.vault, f.task.id)).state).toBe("completed-pending-human")
  })

  it("recovers interrupted matching pairs, refuses unowned locks/symlinks and preserves originals", async () => {
    const f = await fixture()
    const lock = join(f.directory, "completion.lock")
    await mkdir(lock)
    await expect(completeSimulationTask(f.vault, f.task.id, f.candidate)).rejects.toThrow()
    expect(await readdir(lock)).toEqual([])
    await expect(readFile(join(f.directory, "output.md"))).rejects.toMatchObject({ code: "ENOENT" })
    await rm(lock, { recursive: true })
    const workbookLock = join(f.directory, "workbooks.lock")
    await mkdir(workbookLock)
    await expect(completeSimulationTask(f.vault, f.task.id, f.candidate)).rejects.toThrow()
    expect(await readdir(workbookLock)).toEqual([])
    await expect(readdir(lock)).rejects.toMatchObject({ code: "ENOENT" })
    await rm(workbookLock, { recursive: true })
    const outside = join(f.base, "student-owned.xlsx")
    await writeFile(outside, "student-owned workbook")
    await symlink(outside, join(f.directory, "output.xlsx"))
    await expect(completeSimulationTask(f.vault, f.task.id, f.candidate)).rejects.toThrow(
      /symlink|symbolic link/i,
    )
    await expect(readFile(join(f.directory, "output.md"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(outside, "utf8")).toBe("student-owned workbook")
    await unlink(join(f.directory, "output.xlsx"))
    // Synthetic crash after saving the Markdown half but before its companion/receipt.
    await writeFile(join(f.directory, "output.md"), f.text)
    const completed = await completeSimulationTask(f.vault, f.task.id, f.candidate)
    expect(await readFile(join(f.directory, "output.md"), "utf8")).toBe(f.text)
    expect(await readFile(join(f.directory, "output.xlsx"))).toEqual(
      await draftWorkbookBytes(f.text),
    )
    expect(await completeSimulationTask(f.vault, f.task.id, f.candidate)).toEqual(completed)
    expect(await readFile(join(f.vault, f.source), "utf8")).toBe(f.original)
  })

  it("leaves no-table drafts workbook-free and refuses excess tables before writing outputs", async () => {
    const empty = await fixture("")
    const completed = await completeSimulationTask(empty.vault, empty.task.id, empty.candidate)
    expect(completed.workbookVersion).toBe(1)
    expect(completed.workbook).toBeUndefined()
    expect((await readSimulationWorkbooks(empty.vault, empty.task.id)).records).toEqual([])
    await expect(readFile(join(empty.directory, "output.xlsx"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await writeFile(join(empty.directory, "output.xlsx"), "unowned file")
    await expect(inspectSimulationTask(empty.vault, empty.task.id)).rejects.toThrow(
      /Unexpected automatic/,
    )
    expect(await readFile(join(empty.directory, "output.xlsx"), "utf8")).toBe("unowned file")
    const excess = await fixture(
      Array.from({ length: 21 }, () => "### Table\n| X | Y |\n| --- | --- |\n| A | 1 |").join(
        "\n\n",
      ),
    )
    await expect(
      completeSimulationTask(excess.vault, excess.task.id, excess.candidate),
    ).rejects.toThrow(/20 sheets/)
    await expect(readFile(join(excess.directory, "output.md"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(readFile(join(excess.directory, "completion.json"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("keeps coherent older evaluations unchanged instead of retrofitting automatic workbooks", async () => {
    const f = await fixture()
    const path = join(f.directory, "record.json")
    const older = JSON.parse(await readFile(path, "utf8"))
    delete older.workbookVersion
    delete older.task.workbookVersion
    const bytes = JSON.stringify(older)
    await writeFile(path, bytes)
    const handoff = (await readFile(join(f.directory, "TASK.md"), "utf8"))
      .split("\n")
      .filter((line) => !line.startsWith("Completion will automatically save"))
      .join("\n")
    await writeFile(join(f.directory, "TASK.md"), handoff)
    expect((await readSimulationTask(f.vault, f.task.id)).workbookVersion).toBeUndefined()
    const completion = await completeSimulationTask(f.vault, f.task.id, f.candidate)
    expect(completion.workbookVersion).toBeUndefined()
    expect(completion.workbook).toBeUndefined()
    expect((await inspectSimulationTask(f.vault, f.task.id)).state).toBe("completed-pending-human")
    await expect(readFile(join(f.directory, "output.xlsx"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect(await readFile(path, "utf8")).toBe(bytes)
    expect(await readFile(join(f.directory, "TASK.md"), "utf8")).toBe(handoff)
  })

  it("runs the complete/show/workbooks flow with development compare/M1 without printing cell bodies", async () => {
    const f = await fixture()
    const config = join(f.base, "config.json")
    const cli = (args: string[]) => {
      const result = spawnSync(
        process.execPath,
        evaluationCliArgs([...args, "--config", config, "--json"]),
        { encoding: "utf8" },
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout + result.stderr).not.toContain("PRIVATE_AUTO_CELL")
      return JSON.parse(result.stdout)
    }
    cli(["init", "--vault", f.vault, "--canvas-url", "https://canvas.example.test"])
    const completed = cli(["simulate", "task", "complete", f.task.id, "--file", f.candidate])
    expect(completed.workbookVersion).toBe(1)
    // Across separate CLI processes and DOS ZIP timestamp boundaries.
    await new Promise((resolve) => setTimeout(resolve, 2200))
    expect(cli(["simulate", "task", "complete", f.task.id, "--file", f.candidate])).toEqual(
      completed,
    )
    const shown = cli(["simulate", "task", "show", f.task.id])
    expect(shown.completion.workbook.hash).toBe(completed.workbook.hash)
    const inventory = cli(["simulate", "task", "workbooks", f.task.id])
    expect(inventory.records).toHaveLength(1)
    expect(inventory.records[0].automatic.candidateHash).toBe(completed.outputHash)
    const compared = cli(["simulate", "compare", "--course", "CS101", "--task", f.task.id])
    expect(compared.workbookCompanions).toBe(1)
    expect(cli(["gate", "m1", "--course", "CS101", "--comparison", compared.id])).toMatchObject({
      workbookEvidenceCaptured: true,
      workbookCompanions: 1,
      verdict: "pending-human",
    })
  }, 15_000)
})
