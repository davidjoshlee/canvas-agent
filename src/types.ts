import type { LearningHistory } from "./canvas-feedback.js"
export interface ToolkitConfig {
  version: 1
  canvas: { baseUrl: string; tokenEnv: string }
  vault: { path: string }
  courses: { allowlist: string[] }
}

export interface SourceRecord {
  path: string
  title: string
  hash: string
  text: string
  type: string
  dates: string[]
  canvasUrl?: string
  canvasId?: string
  dueAt?: string
  assignmentDates?: import("./assignment-dates.js").AssignmentDates
  postedAt?: string
  relatedPaths?: string[]
  originalPath?: string
  originalHash?: string
  ingestProvenance?: { path: string; hash: string }
  moduleCanvasId?: string
  modulePosition?: number
  moduleDates?: { unlock_at?: string; session_at?: string }
}
export interface ExcludedSource {
  path: string
  reason: string
}
export interface CourseContext {
  syncNamespace?: "Canvas Agent"
  code: string
  title: string
  root: string
  canvasId?: string
  canvasCode?: string
  sources: SourceRecord[]
  excluded: ExcludedSource[]
  guidance: string[]
  existingWork: string[]
  periods?: string[]
}
export interface WorkspaceContext {
  version: 1
  vault: string
  courses: CourseContext[]
  pendingTasks: string[]
  notices: string[]
}
export interface TaskRecord {
  version: 1
  deliverable?: import("./deliverable-evidence.js").DeliverableEvidence
  deliverableScopeVersion?: 1
  deliverableParserVersion?: 2 | 3
  guidanceSelectionVersion?: 1
  assignmentStructureVersion?: 1
  parserVersion?: 1 | 2
  prepSelectionVersion?: 2
  prepStructureVersion?: 1
  answerEvidenceVersion?: 1
  workbookVersion?: 1
  productNamespaceVersion?: 1
  groupScopeVersion?: 1
  id: string
  kind: "prep" | "assignment"
  status: "pending" | "completed"
  createdAt: string
  course: { code: string; title: string; root: string }
  week?: string
  period?: { kind: "week" | "session"; value: string; root?: string }
  parentTaskId?: string
  feedback?: string
  revisionEdits?: import("./revision-edits.js").RevisionEdits
  learningHistory?: LearningHistory
  questions?: string[]
  discussion?: { message: string }
  assignment?: {
    source: string
    mode: "outline" | "draft" | "review" | "discuss"
    work?: string
    context: string[]
    groupCategoryId?: string
  }
  workflow?: { version: 1 | 2 | 3; instructions: string[]; requiredSections: string[] }
  destination: string
  requirements: string[]
  sources: SourceRecord[]
  excluded: ExcludedSource[]
  guidance: SourceRecord[]
  notices: string[]
  completedAt?: string
  output?: string
  outputHash?: string
  workbook?: { path: string; hash: string }
}
