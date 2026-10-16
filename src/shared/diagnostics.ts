export type DiagnosticSeverity = "info" | "warning" | "error"
export type DiagnosticScope = "workspace" | "course" | "task"

export interface Diagnostic {
  code: string
  severity: DiagnosticSeverity
  scope: DiagnosticScope
  message: string
  path?: string
}

export function diagnostic(
  code: string,
  message: string,
  options: { severity?: DiagnosticSeverity; scope?: DiagnosticScope; path?: string } = {},
): Diagnostic {
  return {
    code,
    severity: options.severity ?? "warning",
    scope: options.scope ?? "workspace",
    message,
    ...(options.path ? { path: options.path } : {}),
  }
}

/** Classify a historical notice without changing its persisted/displayed text. */
export function diagnosticFromLegacyNotice(
  message: string,
  scope: DiagnosticScope = "workspace",
): Diagnostic {
  const rules: Array<[RegExp, string, DiagnosticSeverity]> = [
    [
      /Canvas course mappings are unavailable or unsafe/i,
      "workspace.course_mappings_unavailable",
      "error",
    ],
    [/symbolic link/i, "workspace.symlink_skipped", "warning"],
    [/private metadata/i, "workspace.private_metadata_skipped", "info"],
    [/hidden entry/i, "workspace.hidden_entry_skipped", "info"],
    [/task inventory.*incomplete/i, "workspace.task_inventory_incomplete", "warning"],
    [
      /task inventory.*unavailable|task inventory.*bounds/i,
      "workspace.task_inventory_unavailable",
      "warning",
    ],
    [/restriction|restricted|prohibit|policy/i, "workspace.restriction_present", "warning"],
    [/no readable text/i, "source.text_missing", "warning"],
    [/excluded /i, "source.excluded", "warning"],
    [/could not read directory/i, "workspace.directory_unreadable", "warning"],
    [/imported source.*no matching course module/i, "source.module_unmatched", "warning"],
  ]
  const match = rules.find(([pattern]) => pattern.test(message))
  const code = match?.[1] ?? "workspace.notice"
  const severity = match?.[2] ?? "warning"
  const path =
    code === "workspace.symlink_skipped" ? message.split(":").slice(1).join(":").trim() : undefined
  return diagnostic(code, message, { scope, severity, ...(path ? { path } : {}) })
}
