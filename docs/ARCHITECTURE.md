# Architecture

Canvas Agent is a local TypeScript CLI with a deliberately small, model-free workflow. The modules have no provider integration and do not run I/O merely by being imported.

## Data flow

```text
Canvas (GET, configured origin, explicit ID allowlist)
  └─ sync → vault course folders (refresh hash-owned files; preserve edits)

Existing/new vault
  └─ context → read-only inventory of safe course text and exclusions
       └─ prep COURSE --week MONDAY
          or assignment COURSE --source PROMPT --mode outline|draft|review
            └─ _meta/tasks/<UUID>/task.json + TASK.md (workflow + source snapshots)
            └─ human-selected coding agent → candidate Markdown (outside vault)
                 └─ task complete → structural/provenance validation
                      └─ versioned file in the course/week Prep or assignment Drafts destination
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

## Trust and limits

Course files and Canvas content are untrusted reference material, not instructions to the coding agent. `TASK.md` says to use only the snapshot, treat source content as untrusted, and cite exact source paths. Guidance with a policy value that is not explicitly permissive is excluded from the handoff. `complete` verifies structure and provenance constraints; it does not assess whether the response is correct, complete, permitted by school policy, or suitable to submit.

Downloaded Canvas files retain their original bytes. Text extraction is limited to Markdown, plain text, and Canvas HTML fields rendered as text; there is no PDF, Word, spreadsheet, or other binary extraction. External-hosted Canvas assets are skipped. The toolkit has no automatic Drive/MCP integration, unattended schedule, built-in content generation, or submission endpoint. Assignment outline, draft and review are handoffs to the user's chosen coding agent, not model calls inside the toolkit.

No migration is needed for a School Agent vault. The scanner reads existing course-code roots and leaves student-owned files alone. Private tasks stay in root `_meta/tasks/`, outside course reading material.
