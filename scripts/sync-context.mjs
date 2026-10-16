import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveRequirements } from "../src/tasks/authoring/requirements.js"
import { entrypointOutcomes, workflowForRequirements } from "../src/tasks/authoring/workflows.js"

const start = "<!-- canvas-agent-cli:start -->"
const end = "<!-- canvas-agent-cli:end -->"
const source = "plugins/canvas-agent/references/cli.md"

import {
  INSTRUCTION_CORE_BUDGET_BYTES as CONTEXT_CORE_BUDGET_BYTES,
  INSTRUCTION_ENTRY_BUDGET_BYTES as CONTEXT_ENTRY_BUDGET_BYTES,
  INSTRUCTION_SKILL_BUDGET_BYTES as CONTEXT_SKILL_BUDGET_BYTES,
  INSTRUCTION_FILE_MAX_BYTES,
  instructionSizeWarning,
} from "../src/cli/instruction-policy.ts"
import { readBoundedFile } from "../src/shared/fs-safety.ts"

export { CONTEXT_CORE_BUDGET_BYTES, CONTEXT_ENTRY_BUDGET_BYTES, CONTEXT_SKILL_BUDGET_BYTES }
export const WORKFLOW_REFERENCE = "plugins/canvas-agent/references/workflows.md"
const targets = [
  "AGENTS.md",
  "plugins/canvas-agent/skills/canvas-workspace/SKILL.md",
  "plugins/canvas-agent/skills/assignment-workflow/SKILL.md",
  "plugins/canvas-agent/skills/setup-and-sync/SKILL.md",
]
const workflowTargets = {
  "AGENTS.md": ["prep", "outline", "draft", "review", "discuss"],
  "plugins/canvas-agent/skills/canvas-workspace/SKILL.md": ["prep"],
  "plugins/canvas-agent/skills/assignment-workflow/SKILL.md": [
    "outline",
    "draft",
    "review",
    "discuss",
  ],
}

function block(text, file, open = start, close = end) {
  const first = text.indexOf(open)
  const last = text.indexOf(close)
  if (
    first < 0 ||
    last < first ||
    text.indexOf(open, first + open.length) !== -1 ||
    text.indexOf(close, last + close.length) !== -1
  ) {
    throw new Error(`Expected exactly one ordered contract block (${open}) in ${file}`)
  }
  return { first, after: last + close.length, value: text.slice(first, last + close.length) }
}

function renderWorkflowBlock(mode, full) {
  const kind = mode === "prep" ? "prep" : "assignment"
  const assignmentMode = mode === "prep" ? undefined : mode
  const requirements = resolveRequirements(kind, assignmentMode, [], [])
  const workflow = workflowForRequirements(kind, assignmentMode, requirements.sections, [], [])
  return [
    `<!-- canvas-agent-workflow:${mode}:start -->`,
    `### ${mode === "prep" ? "Prep" : `Assignment ${mode}`} outcome`,
    "",
    `Required sections: ${workflow.requiredSections.map((heading) => `\`${heading}\``).join(", ")}.`,
    "",
    ...(full ? workflow.instructions : [entrypointOutcomes[mode]]).map(
      (instruction) => `- ${instruction}`,
    ),
    `<!-- canvas-agent-workflow:${mode}:end -->`,
  ].join("\n")
}

export function workflowBlock(mode) {
  return renderWorkflowBlock(mode, false)
}

export function workflowReference() {
  return [
    "# Full default academic workflows",
    "",
    "Read the applicable mode when no saved task is available. Validated task.workflow.instructions and task.requirements govern the actual task, including custom headings and older versions. Shared entrypoints embed compact outcomes, not replacement task recipes.",
    "",
    ...["prep", "outline", "draft", "review", "discuss"].map((mode) =>
      renderWorkflowBlock(mode, true),
    ),
    "",
  ].join("\n")
}

// Resolve and validate all blocks before writing anything; preserve all workflow-specific text.
export async function syncContext(
  root,
  write = false,
  warn = (message) => console.error(`Warning: ${message}`),
) {
  const readText = async (file) =>
    new TextDecoder("utf-8", { fatal: true }).decode(
      await readBoundedFile(resolve(root, file), INSTRUCTION_FILE_MAX_BYTES),
    )
  const canonical = block(await readText(source), source).value
  const warnings = []
  const coreWarning = instructionSizeWarning(
    "Shared CLI core",
    Buffer.byteLength(canonical),
    CONTEXT_CORE_BUDGET_BYTES,
  )
  if (coreWarning) warnings.push(coreWarning)
  const documents = await Promise.all(
    targets.map(async (file) => {
      const text = await readText(file)
      const replacements = [{ section: block(text, file), value: canonical }]
      for (const mode of workflowTargets[file] ?? []) {
        replacements.push({
          section: block(
            text,
            file,
            `<!-- canvas-agent-workflow:${mode}:start -->`,
            `<!-- canvas-agent-workflow:${mode}:end -->`,
          ),
          value: workflowBlock(mode),
        })
      }
      let updated = text
      for (const { section, value } of replacements.sort(
        (a, b) => b.section.first - a.section.first,
      )) {
        updated = updated.slice(0, section.first) + value + updated.slice(section.after)
      }
      const limit = file === "AGENTS.md" ? CONTEXT_ENTRY_BUDGET_BYTES : CONTEXT_SKILL_BUDGET_BYTES
      if (Buffer.byteLength(updated) > INSTRUCTION_FILE_MAX_BYTES)
        throw new Error(`Generated instruction exceeds file safety limit: ${file}`)
      return {
        file,
        text,
        updated,
        warning: instructionSizeWarning(file, Buffer.byteLength(updated), limit),
      }
    }),
  )
  const fullText = await readText(WORKFLOW_REFERENCE)
  documents.push({ file: WORKFLOW_REFERENCE, text: fullText, updated: workflowReference() })
  for (const document of documents) if (document.warning) warnings.push(document.warning)
  for (const warning of warnings) warn(warning)
  const changed = documents.filter(({ text, updated }) => text !== updated)
  if (!write && changed.length) {
    throw new Error(
      `CLI context drift: ${changed.map(({ file }) => file).join(", ")} (CLI or academic workflow). Run npm run context:sync.`,
    )
  }
  for (const { file, updated } of changed) {
    await writeFile(resolve(root, file), updated)
  }
  return changed.map(({ file }) => file)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 1 || !["--check", "--write"].includes(args[0])) {
    console.error("Usage: node scripts/sync-context.mjs --check|--write")
    process.exitCode = 1
  } else {
    try {
      const changed = await syncContext(
        fileURLToPath(new URL("../", import.meta.url)),
        args[0] === "--write",
      )
      console.log(
        changed.length
          ? `Updated CLI context in ${changed.join(", ")}`
          : "CLI context is synchronized",
      )
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}
