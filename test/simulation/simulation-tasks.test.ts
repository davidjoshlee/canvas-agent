import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { captureSimulation } from "../../src/simulation/captures.js"
import {
  completeSimulationTask,
  createSimulationTask,
  inspectSimulationTask,
  readSimulationTask,
} from "../../src/simulation/tasks.js"
import { resolveRequirements } from "../../src/tasks/authoring/requirements.js"
import { workflowForRequirements } from "../../src/tasks/authoring/workflows.js"
import { compareSimulationEvaluations } from "../../tools/evaluation/comparison.js"
import { comparisonM1Bundle } from "../../tools/evaluation/m1.js"
import { evaluationCliArgs } from "../helpers/evaluation-cli.js"

const roots: string[] = []
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "canvas-sim-task-"))
  roots.push(base)
  const root = join(base, "vault")
  await mkdir(join(root, "CS101/Week 01 - Oct 5/Materials"), { recursive: true })
  const reading = join(root, "CS101/Week 01 - Oct 5/Materials/reading.md")
  await writeFile(
    reading,
    "---\navailable_at: 2026-10-05\n---\nSynthetic reading: competition changes pricing.\n",
  )
  await mkdir(join(root, "CS101/Assignments"))
  const source = "CS101/Assignments/prompt.md"
  await writeFile(
    join(root, source),
    "---\ntype: assignments\navailable_at: 2026-10-05\n---\nDescribe the provided framework.\n",
  )
  const snapshot = await captureSimulation(root, "CS101", "2026-10-09")
  return { root, reading, source, snapshot }
}
async function moduleFixture() {
  const base = await fixture()
  await mkdir(join(base.root, "CS101/modules"))
  const theory = "CS101/modules/01-theory.md",
    owner = "CS101/modules/02-task.md"
  const theoryReading = "CS101/modules/theory-reading.md",
    future = "CS101/modules/03-future.md"
  for (const [path, type, id, links, body] of [
    [theory, "modules", "100", [theoryReading], "Synthetic preceding teaching module"],
    [owner, "modules", "200", [base.source], "Synthetic assignment-owning teaching module"],
    [theoryReading, "file", "500", [], "Synthetic frozen theory reading evidence"],
    [future, "modules", "300", [], "Following module must not be selected"],
  ] as const)
    await writeFile(
      join(base.root, path),
      `---\navailable_at: 2026-10-05\ntype: ${type}\ncanvas_id: '${id}'\nrelated_paths: ${JSON.stringify(links)}\n---\n${body}\n`,
    )
  const snapshot = await captureSimulation(base.root, "CS101", "2026-10-09")
  return { ...base, snapshot, theory, owner, theoryReading, future }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe("fixed snapshot generation handoffs", () => {
  it("uses frozen group scope rather than newer prompt metadata and rejects altered recipes", async () => {
    const { root, source } = await fixture()
    await writeFile(
      join(root, source),
      "---\ntype: assignments\navailable_at: 2026-10-05\n---\nGroup category: 7\nDescribe the framework.\n",
    )
    const snapshot = await captureSimulation(root, "CS101", "2026-10-09")
    await writeFile(join(root, source), "Group category: 8\nNewer prompt")
    const task = await createSimulationTask(root, snapshot.id, {
      kind: "assignment",
      source,
      mode: "draft",
    })
    const saved = await readSimulationTask(root, task.id)
    expect(saved.groupScopeVersion).toBe(1)
    expect(saved.task.assignment?.groupCategoryId).toBe("7")
    expect(saved.task.workflow?.instructions.join(" ")).toContain(
      "student's explicitly identified contribution",
    )
    await expect(readSimulationTask(root, task.id)).resolves.toEqual(saved)
    const path = join(root, "_meta/simulations/tasks", task.id, "record.json")
    const changed = JSON.parse(await readFile(path, "utf8"))
    changed.task.assignment.groupCategoryId = "8"
    await writeFile(path, JSON.stringify(changed))
    await expect(readSimulationTask(root, task.id)).rejects.toThrow()
    changed.task.assignment.groupCategoryId = "7"
    delete changed.groupScopeVersion
    await writeFile(path, JSON.stringify(changed))
    await expect(readSimulationTask(root, task.id)).rejects.toThrow()
  })
  it("retains a saved v2 evaluation workflow and permits completion without upgrading its recipe", async () => {
    const { root, source, snapshot } = await moduleFixture()
    const created = await createSimulationTask(root, snapshot.id, {
      kind: "assignment",
      source,
      mode: "draft",
    })
    const path = join(root, "_meta/simulations/tasks", created.id, "record.json")
    const old = JSON.parse(await readFile(path, "utf8"))
    expect(old.workflowVersion).toBe(3)
    const newInstructions: string[] = old.task.workflow.instructions
    delete old.workflowVersion
    delete old.guidanceSelectionVersion
    delete old.assignmentStructureVersion
    delete old.task.assignmentStructureVersion
    delete old.task.guidanceSelectionVersion
    delete old.deliverableVersion
    delete old.deliverableParserVersion
    delete old.task.deliverableParserVersion
    delete old.deliverableScopeVersion
    delete old.task.deliverableScopeVersion
    delete old.task.deliverable
    delete old.workbookVersion
    delete old.task.workbookVersion
    delete old.groupScopeVersion
    delete old.task.groupScopeVersion
    const requirements = resolveRequirements(
      old.task.kind,
      old.task.assignment.mode,
      old.task.sources,
      old.task.guidance,
    )
    old.task.workflow = workflowForRequirements(
      old.task.kind,
      old.task.assignment.mode,
      requirements.sections,
      requirements.questions,
      requirements.guidanceInstructions,
      2,
    )
    const handoffPath = join(root, "_meta/simulations/tasks", created.id, "TASK.md")
    const removed = new Set(
      newInstructions.filter(
        (instruction) => !old.task.workflow.instructions.includes(instruction),
      ),
    )
    const handoff = (await readFile(handoffPath, "utf8"))
      .split("\n")
      .filter(
        (line) => !removed.has(line) && !line.startsWith("Completion will automatically save"),
      )
      .join("\n")
    await writeFile(handoffPath, handoff)
    const bytes = JSON.stringify(old)
    await writeFile(path, bytes)
    const read = await readSimulationTask(root, created.id)
    expect(read.task.workflow?.version).toBe(2)
    expect(read.workflowVersion).toBeUndefined()
    expect(await readFile(path, "utf8")).toBe(bytes)
    expect(await readFile(handoffPath, "utf8")).toBe(handoff)
    const candidate = join(root, "..", "old-evaluation.md")
    await writeFile(
      candidate,
      [
        `Task: ${created.id}`,
        ...read.task.requirements.map(
          (heading) =>
            `## ${heading}\n\n${heading === "Sources" ? read.task.sources.map((item) => `\`${item.path}\``).join("\n") : "Synthetic legacy recipe acceptance only."}`,
        ),
      ].join("\n\n"),
    )
    await expect(completeSimulationTask(root, created.id, candidate)).resolves.toMatchObject({
      verdict: "pending-human",
    })
    expect(await readFile(path, "utf8")).toBe(bytes)
    expect(await readFile(handoffPath, "utf8")).toBe(handoff)
  })
  it("runs captured custom prep guidance through completion and development comparison/M1 while preserving the frozen policy", async () => {
    const { root } = await fixture()
    const guide = "CS101/_meta/guidance/prep.md"
    await mkdir(join(root, "CS101/_meta/guidance"), { recursive: true })
    await writeFile(
      join(root, guide),
      "---\navailable_at: 2026-10-05\n---\n## Brief structure\n- Custom overview\n- Evidence gaps\n## Guidance\n- Distinguish frozen evidence from uncertainty.\n",
    )
    const snapshot = await captureSimulation(root, "CS101", "2026-10-09")
    expect(snapshot.guidanceCount).toBe(1)
    const config = join(root, "..", "guidance-config.json")
    const cli = (args: string[]) =>
      spawnSync(process.execPath, evaluationCliArgs([...args, "--config", config, "--json"]), {
        encoding: "utf8",
      })
    const command = (args: string[]) => {
      const result = cli(args)
      expect(result.status, result.stderr).toBe(0)
      return JSON.parse(result.stdout)
    }
    command(["init", "--vault", root, "--canvas-url", "https://canvas.example.test"])
    const created = command([
      "simulate",
      "task",
      "create",
      snapshot.id,
      "--kind",
      "prep",
      "--week",
      "2026-10-05",
    ])
    const shown = command(["simulate", "task", "show", created.id])
    expect(shown.task.requirements).toEqual(["Custom overview", "Evidence gaps", "Sources"])
    expect(shown.task.workflow.instructions.join("\n")).toContain("Distinguish frozen evidence")
    expect(shown.task.guidance[0].path).toBe(guide)
    await writeFile(
      join(root, guide),
      "Changed active guidance after capture; do not import into evaluation.",
    )
    expect(command(["simulate", "task", "show", created.id]).task.guidance).toEqual(
      shown.task.guidance,
    )
    const file = join(root, "..", "guided-candidate.md")
    await writeFile(
      file,
      [
        `Task: ${created.id}`,
        ...shown.task.requirements.map(
          (heading: string) =>
            `## ${heading}\n\n${heading === "Sources" ? [...shown.task.sources, ...shown.task.guidance].map((item: { path: string }) => `\`${item.path}\``).join("\n") : "Synthetic structural fixture, not academic coursework."}`,
        ),
      ].join("\n\n"),
    )
    expect(command(["simulate", "task", "complete", created.id, "--file", file]).verdict).toBe(
      "pending-human",
    )
    const comparison = command(["simulate", "compare", "--course", "CS101", "--task", created.id])
    const evidence = JSON.parse(
      await readFile(
        join(root, "_meta/simulation-comparisons", comparison.id, "evidence.json"),
        "utf8",
      ),
    )
    expect(
      evidence.artifacts[0].sources.some((item: { path: string }) => item.path === guide),
    ).toBe(true)
    expect(
      command(["gate", "m1", "--course", "CS101", "--comparison", comparison.id]).verdict,
    ).toBe("pending-human")
    expect(await readFile(join(root, guide), "utf8")).toContain("Changed active guidance")
  })
  it("uses versioned owning/preceding module context from frozen evidence, never the live vault", async () => {
    const { root, source, snapshot, theory, owner, theoryReading, future } = await moduleFixture()
    const handoff = await createSimulationTask(root, snapshot.id, {
      kind: "assignment",
      source,
      mode: "outline",
    })
    const record = await readSimulationTask(root, handoff.id)
    expect(record.selectionVersion).toBe(2)
    expect(record.task.sources.map((item) => item.path)).toEqual([
      source,
      theory,
      owner,
      theoryReading,
    ])
    expect(record.task.sources.some((item) => item.path === future)).toBe(false)
    const config = join(root, "..", "module-config.json")
    const cli = (args: string[]) =>
      spawnSync(process.execPath, evaluationCliArgs([...args, "--config", config, "--json"]), {
        encoding: "utf8",
      })
    expect(
      cli(["init", "--vault", root, "--canvas-url", "https://canvas.example.test"]).status,
    ).toBe(0)
    const shown = cli(["simulate", "task", "show", handoff.id])
    expect(shown.status, shown.stderr).toBe(0)
    expect(JSON.parse(shown.stdout).selectionVersion).toBe(2)
    await writeFile(join(root, theory), "Changed live module, no longer linked.")
    await writeFile(join(root, theoryReading), "Changed live theory reading.")
    expect(await readSimulationTask(root, handoff.id)).toEqual(record)
    const next = await createSimulationTask(root, snapshot.id, {
      kind: "assignment",
      source,
      mode: "draft",
    })
    expect(
      (await readSimulationTask(root, next.id)).task.sources.find(
        (item) => item.path === theoryReading,
      )?.text,
    ).toContain("frozen theory")
    const candidate = join(root, "..", "module-candidate.md")
    await writeFile(
      candidate,
      [
        `Task: ${handoff.id}`,
        ...record.task.requirements.map(
          (heading) =>
            `## ${heading}\n\n${heading === "Sources" ? record.task.sources.map((item) => `\`${item.path}\``).join("\n") : "Synthetic structural evaluation fixture only."}`,
        ),
      ].join("\n\n"),
    )
    const completed = cli(["simulate", "task", "complete", handoff.id, "--file", candidate])
    expect(completed.status, completed.stderr).toBe(0)
    const compared = cli(["simulate", "compare", "--course", "CS101", "--task", handoff.id])
    expect(compared.status, compared.stderr).toBe(0)
    const comparison = JSON.parse(compared.stdout)
    const gated = cli(["gate", "m1", "--course", "CS101", "--comparison", comparison.id])
    expect(gated.status, gated.stderr).toBe(0)
    expect(JSON.parse(gated.stdout).verdict).toBe("pending-human")
  })
  it("preserves coherent unversioned evaluation recipes without rewriting or adding current selection", async () => {
    const { root, source, snapshot } = await moduleFixture()
    const handoff = await createSimulationTask(root, snapshot.id, {
      kind: "assignment",
      source,
      mode: "outline",
    })
    const path = join(root, "_meta/simulations/tasks", handoff.id, "record.json")
    // Synthetic old-format fixture: the former selector used outgoing prompt
    // relationships only. This is not an edit to any real saved student run.
    const old = JSON.parse(await readFile(path, "utf8"))
    delete old.selectionVersion
    delete old.guidanceSelectionVersion
    delete old.assignmentStructureVersion
    delete old.task.assignmentStructureVersion
    delete old.task.guidanceSelectionVersion
    delete old.deliverableVersion
    delete old.deliverableParserVersion
    delete old.task.deliverableParserVersion
    delete old.deliverableScopeVersion
    delete old.task.deliverableScopeVersion
    delete old.task.deliverable
    delete old.workflowVersion
    delete old.groupScopeVersion
    delete old.task.groupScopeVersion
    old.task.sources = old.task.sources.filter((item: { path: string }) => item.path === source)
    old.task.assignment.context = []
    const requirements = resolveRequirements(
      old.task.kind,
      old.task.assignment.mode,
      old.task.sources,
      old.task.guidance,
    )
    old.task.workflow = workflowForRequirements(
      old.task.kind,
      old.task.assignment.mode,
      requirements.sections,
      requirements.questions,
      requirements.guidanceInstructions,
      2,
    )
    old.task.notices = old.task.notices.filter(
      (notice: string) => !notice.startsWith("Selection recipe v2"),
    )
    const bytes = JSON.stringify(old)
    await writeFile(path, bytes)
    const read = await readSimulationTask(root, handoff.id)
    expect(read.selectionVersion).toBeUndefined()
    expect(read.task.sources.map((item) => item.path)).toEqual([source])
    expect(await readFile(path, "utf8")).toBe(bytes)
  })
  it("rejects downgraded/unsupported recipes and resolves frozen predecessor ambiguity only from captured context", async () => {
    const { root, source, snapshot, theory } = await moduleFixture()
    const handoff = await createSimulationTask(root, snapshot.id, {
      kind: "assignment",
      source,
      mode: "draft",
    })
    const path = join(root, "_meta/simulations/tasks", handoff.id, "record.json")
    const changed = JSON.parse(await readFile(path, "utf8"))
    expect(changed.workflowVersion).toBe(3)
    delete changed.workflowVersion
    await writeFile(path, JSON.stringify(changed))
    await expect(readSimulationTask(root, handoff.id)).rejects.toThrow(
      /authoritative snapshot|group scope/,
    )
    changed.workflowVersion = 3
    delete changed.selectionVersion
    await writeFile(path, JSON.stringify(changed))
    await expect(readSimulationTask(root, handoff.id)).rejects.toThrow(
      /authoritative snapshot|Frozen scoped guidance/,
    )
    changed.selectionVersion = 99
    await writeFile(path, JSON.stringify(changed))
    await expect(readSimulationTask(root, handoff.id)).rejects.toThrow()
    changed.selectionVersion = 2
    changed.workflowVersion = 99
    await writeFile(path, JSON.stringify(changed))
    await expect(readSimulationTask(root, handoff.id)).rejects.toThrow()
    const alternate = "CS101/modules/01-other.md"
    await writeFile(
      join(root, alternate),
      "---\navailable_at: 2026-10-05\ntype: modules\ncanvas_id: '999'\n---\nCompeting predecessor module.",
    )
    const ambiguous = await captureSimulation(root, "CS101", "2026-10-09")
    await expect(
      createSimulationTask(root, ambiguous.id, { kind: "assignment", source, mode: "draft" }),
    ).rejects.toThrow(/ambiguous/)
    const scoped = await createSimulationTask(root, ambiguous.id, {
      kind: "assignment",
      source,
      mode: "draft",
      context: [theory],
    })
    expect(
      (await readSimulationTask(root, scoped.id)).task.sources.some(
        (item) => item.path === alternate,
      ),
    ).toBe(false)
  })
  it.each(["review", "discuss"] as const)(
    "runs frozen %s with explicitly captured work through completion and M1",
    async (mode) => {
      const { root, source } = await fixture()
      const work = "CS101/Assignments/Drafts/student.md"
      await mkdir(join(root, "CS101/Assignments/Drafts"))
      const original =
        "---\navailable_at: 2026-10-05\n---\nSynthetic student work before capture.\n"
      await writeFile(join(root, work), original)
      const config = join(root, "..", "config.json")
      const cli = (args: string[]) =>
        spawnSync(process.execPath, evaluationCliArgs([...args, "--config", config, "--json"]), {
          encoding: "utf8",
        })
      expect(
        cli(["init", "--vault", root, "--canvas-url", "https://canvas.example.test"]).status,
      ).toBe(0)
      const command = (args: string[]) => {
        const result = cli(args)
        expect(result.status, result.stderr).toBe(0)
        return JSON.parse(result.stdout)
      }
      const capture = command([
        "simulate",
        "capture",
        "CS101",
        "--as-of",
        "2026-10-09",
        "--work",
        work,
      ])
      const message = "Which requirement needs more evidence?"
      const handoff = command([
        "simulate",
        "task",
        "create",
        capture.id,
        "--kind",
        "assignment",
        "--source",
        source,
        "--mode",
        mode,
        "--work",
        work,
        ...(mode === "discuss" ? ["--message", message] : []),
      ])
      await writeFile(join(root, work), "Changed live student work after capture.\n")
      const shown = command(["simulate", "task", "show", handoff.id])
      expect(shown.task.assignment).toMatchObject({ mode, work })
      expect(
        shown.task.sources.find((entry: { path: string }) => entry.path === work).text,
      ).toContain("before capture")
      if (mode === "discuss") expect(shown.task.discussion.message).toBe(message)
      const candidate = join(root, "..", "candidate.md")
      const content = [
        `Task: ${handoff.id}`,
        ...shown.task.requirements.map(
          (heading: string) =>
            `## ${heading}\n\n${
              heading === "Student question"
                ? `> ${message}`
                : heading === "Sources"
                  ? `\`${source}\`\n\`${work}\``
                  : "Synthetic structural test only."
            }`,
        ),
      ].join("\n\n")
      await writeFile(candidate, content)
      if (mode === "discuss") {
        await writeFile(candidate, content.replace(`> ${message}`, "> Different inquiry"))
        expect(cli(["simulate", "task", "complete", handoff.id, "--file", candidate]).status).toBe(
          1,
        )
        await writeFile(candidate, content)
      }
      const completed = command(["simulate", "task", "complete", handoff.id, "--file", candidate])
      expect(completed.verdict).toBe("pending-human")
      const compared = await compareSimulationEvaluations(root, "CS101", [handoff.id])
      expect((await comparisonM1Bundle(root, "CS101", compared.id)).verdict).toBe("pending-human")
      expect(await readFile(join(root, work), "utf8")).toBe(
        "Changed live student work after capture.\n",
      )
      const prep = await createSimulationTask(root, capture.id, {
        kind: "prep",
        week: "2026-10-05",
      })
      expect(
        (await readSimulationTask(root, prep.id)).task.sources.some(
          (entry) => entry.type === "student-work",
        ),
      ).toBe(false)
    },
  )
  it("requires frozen work, rejects invalid inquiries and applies capture availability and policy limits", async () => {
    const { root, source, snapshot } = await fixture()
    const work = "CS101/Assignments/Drafts/student.md"
    await mkdir(join(root, "CS101/Assignments/Drafts"))
    await writeFile(join(root, work), "---\navailable_at: 2026-10-05\n---\nSynthetic work.")
    await expect(
      createSimulationTask(root, snapshot.id, { kind: "assignment", source, mode: "review" }),
    ).rejects.toThrow(/requires --work/)
    await expect(
      createSimulationTask(root, snapshot.id, { kind: "assignment", source, mode: "review", work }),
    ).rejects.toThrow(/approved fixed snapshot/)
    for (const message of [undefined, "", "password=synthetic-secret", "x".repeat(12_001)]) {
      await expect(
        createSimulationTask(root, snapshot.id, {
          kind: "assignment",
          source,
          mode: "discuss",
          message,
        }),
      ).rejects.toThrow()
    }
    await expect(
      createSimulationTask(root, snapshot.id, {
        kind: "assignment",
        source,
        mode: "draft",
        message: "Not discussion",
      }),
    ).rejects.toThrow(/only in discussion/)
    for (const metadata of ["", "---\navailable_at: 2026-10-10\n---\n"]) {
      await writeFile(join(root, work), `${metadata}Synthetic work.`)
      const capture = await captureSimulation(root, "CS101", "2026-10-09", [work])
      await expect(
        createSimulationTask(root, capture.id, {
          kind: "assignment",
          source,
          mode: "review",
          work,
        }),
      ).rejects.toThrow(/approved fixed snapshot/)
    }
    await writeFile(
      join(root, work),
      "---\navailable_at: 2026-10-05\nai_policy: prohibited\n---\nRestricted work.",
    )
    await expect(captureSimulation(root, "CS101", "2026-10-09", [work])).rejects.toThrow(
      /restricted/,
    )
    await expect(captureSimulation(root, "CS101", "2026-10-09", [source])).rejects.toThrow(
      /existing-work folder/,
    )
    await expect(captureSimulation(root, "CS101", "2026-10-09", [work, work])).rejects.toThrow(
      /distinct/,
    )
  })
  it("runs capture-to-completion through the compiled CLI without substituting edited live sources", async () => {
    const { root, reading } = await fixture()
    const config = join(root, "..", "config.json")
    const cli = (args: string[]) =>
      spawnSync(process.execPath, evaluationCliArgs(args), { encoding: "utf8" })
    expect(
      cli([
        "init",
        "--config",
        config,
        "--vault",
        root,
        "--canvas-url",
        "https://canvas.example.test",
      ]).status,
    ).toBe(0)
    const command = (args: string[]) => {
      const result = cli([...args, "--config", config, "--json"])
      expect(result.status, result.stderr).toBe(0)
      return JSON.parse(result.stdout)
    }
    const capture = command(["simulate", "capture", "CS101", "--as-of", "2026-10-09"])
    const handoff = command([
      "simulate",
      "task",
      "create",
      capture.id,
      "--kind",
      "prep",
      "--week",
      "2026-10-05",
    ])
    await writeFile(reading, "Edited live vault content, not evaluation evidence.\n")
    const shown = command(["simulate", "task", "show", handoff.id])
    expect(shown.state).toBe("pending-host")
    expect(shown.task.sources[0].text).toContain("competition changes pricing")
    const candidate = join(root, "..", "candidate.md")
    await writeFile(
      candidate,
      [
        `Task: ${handoff.id}`,
        ...shown.task.requirements.map(
          (section: string) =>
            `## ${section}\n\n${section === "Sources" ? `\`${shown.task.sources[0].path}\`` : "Synthetic structural verification only."}`,
        ),
      ].join("\n\n"),
    )
    const completed = command(["simulate", "task", "complete", handoff.id, "--file", candidate])
    expect(completed.verdict).toBe("pending-human")
    expect(command(["simulate", "task", "show", handoff.id]).state).toBe("completed-pending-human")
    expect(command(["simulate", "task", "complete", handoff.id, "--file", candidate])).toEqual(
      completed,
    )
    await writeFile(join(root, completed.output), "Tampered evaluation output.")
    const tampered = cli(["simulate", "task", "show", handoff.id, "--config", config, "--json"])
    expect(tampered.status).toBe(1)
    expect(tampered.stderr).toContain("changed after completion")
    expect(await readFile(reading, "utf8")).toBe(
      "Edited live vault content, not evaluation evidence.\n",
    )
  })
  it.each(["prep", "outline", "draft"] as const)(
    "persists %s instructions and completes privately from the fixed source version",
    async (mode) => {
      const { root, reading, source, snapshot } = await fixture()
      const handoff = await createSimulationTask(
        root,
        snapshot.id,
        mode === "prep"
          ? { kind: "prep", week: "2026-10-05" }
          : {
              kind: "assignment",
              source,
              mode,
              context: ["CS101/Week 01 - Oct 5/Materials/reading.md"],
            },
      )
      const before = await readSimulationTask(root, handoff.id)
      expect(
        before.task.sources.some((entry) => entry.text.includes("competition changes pricing")),
      ).toBe(true)
      expect(await readFile(join(root, handoff.taskFile), "utf8")).toContain(`Task: ${handoff.id}`)
      await writeFile(reading, "Changed live reading after capture.\n")
      expect((await readSimulationTask(root, handoff.id)).task.sources).toEqual(before.task.sources)
      const candidate = join(root, "candidate.md")
      await writeFile(
        candidate,
        [
          `Task: ${handoff.id}`,
          ...before.task.requirements.map(
            (heading) =>
              `## ${heading}\n\n${heading === "Sources" ? `\`${before.task.sources[0]?.path}\`` : "Synthetic mechanical-validator evidence only, not coursework."}`,
          ),
        ].join("\n\n"),
      )
      const completed = await completeSimulationTask(root, handoff.id, candidate)
      expect(completed).toMatchObject({
        verdict: "pending-human",
        historicalVerified: false,
        snapshotHash: snapshot.hash,
      })
      expect(completed.output).toMatch(/^_meta\/simulations\/tasks\//)
      expect(await completeSimulationTask(root, handoff.id, candidate)).toEqual(completed)
      expect((await inspectSimulationTask(root, handoff.id)).state).toBe("completed-pending-human")
      await writeFile(
        candidate,
        (await readFile(candidate, "utf8")).replace(
          "Synthetic mechanical-validator",
          "Different synthetic mechanical-validator",
        ),
      )
      await expect(completeSimulationTask(root, handoff.id, candidate)).rejects.toThrow(
        /different simulation output already exists/,
      )
      expect(await readFile(reading, "utf8")).toBe("Changed live reading after capture.\n")
    },
  )
  it("refuses uncaptured context, wrong candidate identity/citations, changed outputs and altered recipes", async () => {
    const { root, source, snapshot } = await fixture()
    await expect(
      createSimulationTask(root, snapshot.id, {
        kind: "assignment",
        source,
        mode: "draft",
        context: ["OTHER101/reading.md"],
      }),
    ).rejects.toThrow(/not in the approved fixed snapshot/)
    const handoff = await createSimulationTask(root, snapshot.id, {
      kind: "prep",
      week: "2026-10-05",
    })
    const record = await readSimulationTask(root, handoff.id),
      candidate = join(root, "candidate.md")
    const body = record.task.requirements
      .map(
        (heading) =>
          `## ${heading}\n\n${heading === "Sources" ? "`OTHER101/reading.md`" : "Synthetic content."}`,
      )
      .join("\n\n")
    await writeFile(candidate, `Task: ${handoff.id}\n\n${body}`)
    await expect(completeSimulationTask(root, handoff.id, candidate)).rejects.toThrow(
      /not an exact task source/,
    )
    await writeFile(candidate, `Task: wrong\n\n${body}`)
    await expect(completeSimulationTask(root, handoff.id, candidate)).rejects.toThrow(/exact Task/)
    const path = join(root, "_meta/simulations/tasks", handoff.id, "record.json")
    const altered = JSON.parse(await readFile(path, "utf8"))
    altered.task.notices = []
    await writeFile(path, JSON.stringify(altered))
    await expect(readSimulationTask(root, handoff.id)).rejects.toThrow(/authoritative snapshot/)
  })
  it("rejects period ambiguity and unavailable prompt material", async () => {
    const { root, snapshot } = await fixture()
    await expect(createSimulationTask(root, snapshot.id, { kind: "prep" })).rejects.toThrow(
      /exactly one explicit/,
    )
    await expect(
      createSimulationTask(root, snapshot.id, {
        kind: "prep",
        week: "2026-10-05",
        session: "Session 1",
      }),
    ).rejects.toThrow(/exactly one explicit/)
    await expect(
      createSimulationTask(root, snapshot.id, {
        kind: "assignment",
        source: "CS101/Assignments/missing.md",
        mode: "outline",
      }),
    ).rejects.toThrow(/not in the approved fixed snapshot/)
  })
})
