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
}
export interface ExcludedSource {
  path: string
  reason: string
}
export interface CourseContext {
  code: string
  title: string
  root: string
  canvasId?: string
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
  id: string
  kind: "prep" | "assignment"
  status: "pending" | "completed"
  createdAt: string
  course: { code: string; title: string; root: string }
  week?: string
  assignment?: {
    source: string
    mode: "outline" | "draft" | "review"
    work?: string
    context: string[]
  }
  workflow?: { version: 1; instructions: string[]; requiredSections: string[] }
  destination: string
  requirements: string[]
  sources: SourceRecord[]
  excluded: ExcludedSource[]
  guidance: SourceRecord[]
  notices: string[]
  completedAt?: string
  output?: string
  outputHash?: string
}
