import { join } from "node:path"
import { loadAdjacentEnv, loadConfig } from "../config/index.js"
import type { TaskRecord, ToolkitConfig } from "../shared/types.js"

export function summary(task: TaskRecord) {
  return {
    id: task.id,
    kind: task.kind,
    parserVersion: task.parserVersion,
    ...(task.deliverable ? { deliverable: task.deliverable } : {}),
    ...(task.deliverableScopeVersion
      ? { deliverableScopeVersion: task.deliverableScopeVersion }
      : {}),
    ...(task.deliverableParserVersion
      ? { deliverableParserVersion: task.deliverableParserVersion }
      : {}),
    ...(task.guidanceSelectionVersion
      ? { guidanceSelectionVersion: task.guidanceSelectionVersion }
      : {}),
    ...(task.assignmentStructureVersion
      ? { assignmentStructureVersion: task.assignmentStructureVersion }
      : {}),
    status: task.status,
    course: task.course,
    week: task.week,
    period: task.period,
    assignment: task.assignment,
    parentTaskId: task.parentTaskId,
    feedback: task.feedback,
    ...(task.learningHistory
      ? {
          learningHistory: {
            hash: task.learningHistory.hash,
            records: task.learningHistory.records.length,
            legacyPlaybooks: task.learningHistory.legacyPlaybooks?.length ?? 0,
          },
        }
      : {}),
    discussion: task.discussion,
    destination: task.destination,
    requirements: task.requirements,
    workflow: task.workflow,
    sources: task.sources.map((s) => s.path),
    guidance: task.guidance.map((s) => s.path),
    excluded: task.excluded,
    notices: task.notices,
    ...(task.output ? { output: task.output } : {}),
    ...(task.workbookVersion
      ? { workbookVersion: task.workbookVersion, workbook: task.workbook ?? null }
      : {}),
  }
}

export function taskMarkdownPath(config: ToolkitConfig, id: string): string {
  return join(config.vault.path, "_meta", "tasks", id, "TASK.md")
}

export function taskCreationHandoff(config: ToolkitConfig, task: TaskRecord) {
  return {
    ...summary(task),
    taskFile: taskMarkdownPath(config, task.id),
    workingDirectory: join(config.vault.path, "_meta", "tasks", task.id, "work"),
  }
}

export function render(value: unknown, json: boolean, human: string): void {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  else process.stdout.write(`${human}\n`)
}

export async function configWithEnv(configPath: string): Promise<ToolkitConfig> {
  await loadAdjacentEnv(configPath)
  return loadConfig(configPath)
}
