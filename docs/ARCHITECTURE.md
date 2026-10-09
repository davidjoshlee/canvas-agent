# Architecture

Canvas Agent is a local TypeScript CLI with a deliberately small, model-free workflow. The modules have no provider integration and do not run I/O merely by being imported.

## Data flow

```text
Canvas (GET, configured origin, explicit ID allowlist)
  └─ sync → vault course folders (refresh hash-owned files; preserve edits)

Existing/new vault
  └─ context → read-only inventory of safe course text and exclusions
       └─ homework / timeline → upcoming local work
       └─ prep COURSE [--week MONDAY | --session VALUE]
          or assignment COURSE --source PROMPT --mode outline|draft|review
            └─ _meta/tasks/<UUID>/task.json + TASK.md (workflow + source snapshots)
            └─ human-selected coding agent → candidate Markdown (outside vault)
                 └─ task complete → structural/provenance validation
                      └─ versioned file in the course/week Prep or assignment Drafts destination
                           └─ revise → fresh draft task; approve → versioned local Finals
```

The coding agent is chosen and invoked by the user. Canvas Agent does not select a model or transmit the task. If a user gives task material to an external hosted model, that model may incur costs and receive the supplied course content; the user must review the provider's terms and data handling before sharing it.

## Modules

- `config.ts` validates a versioned JSON config, resolves vault paths relative to the config, and refuses to replace an existing config. The config contains a token environment-variable name, never a token value.
- `canvas.ts` discovers readable courses; only sync is allowlisted. HTTP is GET-only; pagination and file downloads must stay on the configured Canvas origin. Generated files refresh only when prior ownership hashes still match; untracked files and edits are preserved. The course manifest records Canvas IDs, codes, names, and actual folder roots. The private sync state records ownership hashes, not credentials.
- `workspace.ts` reads course-code directories without requiring a database. It omits hidden and private metadata, does not follow symlinks, and records unsupported/binary or restricted material as exclusions without exposing its text.
- `workflows.ts` defines finished prep and mode-specific assignment outcomes. Its versioned instructions and required headings are embedded in task records and mechanically copied into the plugin skills and repository instructions.
- `tasks.ts` chooses week-specific prep material or an explicitly identified assignment prompt, work and context, alongside recognized course references and permitted guidance. It writes a human brief and a JSON snapshot with original-byte SHA-256 hashes. The JSON is the persisted source boundary for the later handoff. Existing student work is included only when explicitly selected.
- `completion.ts` validates task identity, authoritative workflow, required headings, exact source citations, unchanged relevant inputs, and safe paths before saving a versioned candidate. The destination comes from the selected course/week or assignment prompt, not a candidate-selected path.
- `cli.ts` is the user-facing command entry point. Human output is readable; `--json` emits machine-readable stdout, while errors go to stderr.
- `content.ts` extracts bounded basic document text and stores originals plus hash-linked sidecars. `module-context.ts` expands approved module relationships, rejecting oversized graphs rather than silently truncating context.
- `requirements.ts` resolves course-defined brief headings and detected questions. `workflows.ts` retains v1 for existing tasks; newly created v2 tasks embed resolved requirements. Completion checks question-heading and answer-body presence, not semantic correctness.
- `onboarding.ts`, `health.ts` and `upcoming.ts` provide explicit course selection, local setup/auth diagnostics and upcoming/overdue views. Adjacent private `.env` is optional; process environment takes precedence.
- `lifecycle.ts` verifies completed assignment outputs before creating revision tasks or versioned Finals copies. `tools.ts` supplies bounded arithmetic, values-only workbooks, provenance comparison and human review bundles without model calls or code execution.

## Trust and limits

Course files and Canvas content are untrusted reference material, not instructions to the coding agent. `TASK.md` says to use only the snapshot, treat source content as untrusted, and cite exact source paths. Guidance with a policy value that is not explicitly permissive is excluded from the handoff. `complete` verifies structure and provenance constraints; it does not assess whether the response is correct, complete, permitted by school policy, or suitable to submit.

Downloaded Canvas files retain their original bytes. Selectable PDF text and basic DOCX/PPTX/XLSX content are extracted locally into hash-linked sidecars; original hashes remain part of the task's evidence checks. Scans need OCR elsewhere and complex formatting may be lost. HTML links recover unlisted Canvas files; safe CDN downloads never receive Canvas bearer tokens. Unsafe hosts produce notices. The toolkit has no automatic Drive/MCP integration, unattended schedule, historical reconstruction, built-in content generation or submission endpoint. Assignment work is handed to the user's chosen coding agent, not generated inside the toolkit.

`student-cli.ts` registers local calendar and guidance conveniences. `calendar.ts` stores private date overrides, reconciles supported ICS events and exports new files; it never edits Canvas or configures OS reminders. `guidance.ts` creates a source-bound proposal task and saves only versioned proposed guidance. Human activation is separate. `simulation.ts` stores fixed private current-version source captures filtered by explicit availability metadata; replay exposes a host-agent handoff, not a reconstructed past vault or automatic evaluation. Calculator batches use bounded declarative operations, not arbitrary scripts.

No migration is needed for a School Agent vault. The scanner reads existing course-code roots and leaves student-owned files alone. Private tasks stay in root `_meta/tasks/`, outside course reading material.
