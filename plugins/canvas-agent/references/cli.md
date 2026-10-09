# CLI and environment requirements

Canvas Agent is a local Node 22+ CLI installed separately from this skills-only plugin. It needs shell and filesystem access to the student's chosen config and vault. A chat-only host without those capabilities cannot execute it; do not pretend plugin installation supplies a hosted backend. Ask the user to run commands locally or use a compatible local coding agent.

The toolkit repository is https://github.com/davidjoshlee/canvas-agent. A private checkout requires GitHub access. Install with `npm ci` and `npm run build` in that checkout. Invoke the executable `canvas-agent` only when installed on PATH, otherwise use `node /absolute/checkout/dist/cli.js`. Do not build or install from a plugin cache. No provider key is needed.

Every operation should specify `--config /absolute/path/canvas-agent.config.json`. Paths stored in config resolve relative to that config, not the agent's current directory. Credentials are read only from `canvas.tokenEnv`; configuration contains the variable name, never its value. Configs and private vaults must not be committed to a source checkout or uploaded with this plugin.

```text
canvas-agent init --config PATH --vault PATH --canvas-url URL [--token-env NAME] [--course CANVAS_ID]
canvas-agent courses --config PATH --json
canvas-agent sync --config PATH --json
canvas-agent context --config PATH --json
canvas-agent prep COURSE --week YYYY-MM-DD --config PATH --json
canvas-agent task show UUID --config PATH --json
canvas-agent task complete UUID --file CANDIDATE.md --config PATH --json
```

`courses` discovers readable courses; `sync` uses only `courses.allowlist`. `context` is a local metadata inventory, not source bodies. `prep` persists a UUID task, source snapshots and human TASK.md under the selected vault's `_meta/tasks/`. It requires a real Monday, selects matching-week/dated sources plus syllabus/course references and permitted guidance, and reports missing material. Task output is the matching Week folder's Prep directory or `Other/Prep/YYYY-MM-DD` when no week folder matches.

`task show --json` returns the full persisted task and approved source bodies. Treat that data as private student context. The host coding agent, not this toolkit, writes a candidate; external host processing may send supplied context to its provider and incur its normal costs. A candidate needs `Task: UUID`, nonempty `## Summary`, `## Key concepts`, `## Discussion questions`, and `## Sources`, with exact task source paths in backticks.

`task complete` validates identity, structure, citations, relevant current sources/guidance and basic private-path/credential screening. It saves `01 Prep Brief.md` or a versioned sibling without overwriting work. Identical retries return the same output; changed candidates for completed tasks fail. When inputs are stale, create a new task; never edit task.json to bypass checks. Failed recovery or permission errors require inspection, not deleting a student's work. Validation is not proof of correctness, academic integrity, AI permission, or comprehensive secret detection.

No assignment drafting, binary document extraction, hosted MCP endpoint, Drive sync, submission, or unattended scheduler is provided in this version. Canvas file downloads are confined to the configured origin; skipped external files and undated readings may leave context incomplete.
