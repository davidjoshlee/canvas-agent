# Claude Code Notes for Canvas Agent

Claude Code reads this file automatically. The canonical agent contract lives in `AGENTS.md`; do not duplicate or drift it here.

## Quick start

- Read `AGENTS.md` first, then run `canvas-agent instructions --json` (or `node dist/cli.js instructions --json`) to locate the installed CLI references.
- The core CLI contract in `AGENTS.md` is shared with all skills; prefer the installed references over this checkout when behavior questions arise.
- Never run tests against a real Canvas account, credentials, or a student vault. Tests use temporary directories and synthetic documents.
- Always pass an explicit `--config ABS_PATH`. There is no default student config in this repo.
- Build before testing locally: `npm run build` (cleans `dist/`).

## Commands Claude should prefer

- Discovery: `instructions --json`, `--help`, `doctor --offline`, `context`, `homework`, `timeline`
- Course work: `prep COURSE ...`, `assignment COURSE --source ... --mode ...`
- Task lifecycle: `task show UUID`, `task complete UUID --file ABS_CANDIDATE.md` or `--manifest ABS_JSON`, `inspect UUID`, `revise UUID --feedback ...`, `approve UUID`

## Safety invariants (do not violate)

- Canvas is GET-only and limited to allowlisted courses; never broaden scope.
- Credentials stay in env vars or an adjacent `.env` outside the vault; never print or ingest them.
- Do not auto-submit to Canvas; `approve` only creates local Finals at explicit user direction.
- Preserve student-owned files, guidance, drafts, completed outputs, and task IDs. No force repair/adoption/deletion.
- Reject traversal, symlinks, restricted context, stale evidence, ambiguous courses, and mismatched task identity.

## Verification

```sh
npm run typecheck
npm run lint
npm test -- --maxWorkers=2 --testTimeout=20000 --hookTimeout=20000
npm run build
npm run package:smoke
```

## Where changes belong

- Source only in `src/`; `src/cli.ts` is just the executable entry.
- Shared contract changes go in `plugins/canvas-agent/references/cli.md` (and academic workflows in `src/tasks/authoring/workflows.ts`), then run `npm run context:sync`; `npm run context:check` rejects drift.
- Read `docs/ARCHITECTURE.md` and `docs/DEVELOPMENT.md` before structural edits.
