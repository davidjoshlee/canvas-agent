# Canvas Agent development

## Helping a student

When the user asks for course preparation rather than repository changes, read `plugins/canvas-agent/skills/canvas-workspace/SKILL.md` and the README. For onboarding or sync, read `plugins/canvas-agent/skills/setup-and-sync/SKILL.md`. Start with `context --json` using the student's explicit config, then create a prep task for an explicitly chosen course and Monday. `task show ID --json` contains the approved snapshots; the coding agent writes a separate candidate and calls `task complete`. Never guess the course, read another student's vault, or submit to Canvas. Setup requires only a Canvas read token for syncing; local task work needs no API key.

## Developing the toolkit

This toolkit does not run a model. Coding agents read persisted tasks, author a candidate, then ask the toolkit to validate and save it. No AI SDK, provider credentials, automated submission, or hidden generation.

Canvas access is GET-only. Only explicitly allowlisted courses sync. Credentials remain in environment variables outside the vault; never log them. Do not access a real Canvas account or student vault during development. Tests use temporary directories and synthetic documents.

Preserve School Agent course-code vault roots and student-owned files. Never overwrite originals, guidance, drafts, or completed outputs. Reject traversal, symlinks, restricted/prohibited context, stale source evidence, ambiguous course selection, and mismatched task identity. Private tasks belong in `_meta/tasks/` and must not be included in a reading copy.

Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. Test the compiled CLI with synthetic fixtures. Do not publish, commit, or touch sibling repositories unless the user requests it.

Parallel work: own only the assigned module/tests. Shared public types are in `src/types.ts`; coordinate interface changes with the parent. See CONTRACT.md.
