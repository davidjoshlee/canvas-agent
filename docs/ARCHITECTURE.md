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
          or assignment COURSE --source PROMPT --mode outline|draft|review|discuss
            └─ _meta/tasks/<UUID>/task.json + TASK.md (workflow + source snapshots)
            └─ human-selected coding agent → candidate Markdown (outside vault)
                 └─ task complete → structural/provenance validation
                      └─ versioned file in the course/week Prep or assignment Drafts destination
                           └─ revise → fresh draft task; approve → versioned local Finals
```

The coding agent is chosen and invoked by the user. Canvas Agent does not select a model or transmit the task. If a user gives task material to an external hosted model, that model may incur costs and receive the supplied course content; the user must review the provider's terms and data handling before sharing it.

Optional local history is a separate preservation module: `vault-history.ts`
owns bounded byte inventories, private external bare-Git binding, isolated child
processes, snapshots and non-overwriting exports. `vault-history-cli.ts` places
the capture seam around known mutating command actions, including retained
partial writes after failure, without changing their primary outcome or JSON
stdout. Nothing is enabled implicitly, existing vault Git is never adopted, and
no history bytes go to a remote. The private control record points outside the
vault; the history store must not be used as a phone reading copy or shared folder.

## Modules

- `config.ts` validates a versioned JSON config, resolves vault paths relative to the config, and refuses to replace an existing config. The config contains a token environment-variable name, never a token value.
- `canvas.ts` discovers readable courses; sync is allowlisted and GET-only. API pagination stays on the configured origin. Downloads may follow validated public HTTPS redirects without sending bearer credentials off-origin. Existing configured-origin bindings are checked before requests; nonempty sync verifies a bounded self profile and reserves a private server-scoped API-subject hash before course writes. The course manifest records IDs, codes, names and actual folder roots. Hash-owned files refresh only while ownership bytes match; edits and untracked files are preserved. Multi-course failures are isolated except authentication/global safety failures, and partial runs retain ownership evidence.
- `workspace.ts` reads course-code directories without requiring a database. It omits hidden and private metadata, does not follow symlinks, and records unsupported/binary or restricted material as exclusions without exposing its text.
- `workflows.ts` defines finished prep and mode-specific assignment outcomes. Its versioned instructions and required headings are embedded in task records and mechanically copied into the plugin skills and repository instructions.
- `tasks.ts` chooses week-specific prep material or an explicitly identified assignment prompt, work and context, alongside recognized course references and permitted guidance. It writes a human brief and a JSON snapshot with original-byte SHA-256 hashes. The JSON is the persisted source boundary for the later handoff. Existing student work is included only when explicitly selected.
- `completion.ts` validates task identity, authoritative workflow, required headings, exact source citations, unchanged relevant inputs, and safe paths before saving a versioned candidate. The destination comes from the selected course/week or assignment prompt, not a candidate-selected path.
- `cli.ts` is the user-facing command entry point. Human output is readable; `--json` emits machine-readable stdout, while errors go to stderr.
- `content.ts` extracts bounded basic document text and stores originals plus hash-linked sidecars. `module-context.ts` expands approved module relationships, rejecting oversized graphs rather than silently truncating context.
- `requirements.ts` resolves course-defined headings, prompt requirements and detected questions. New workflow v3 asks the host for the permitted finished deliverable, executed quantitative checks and source-based self-review. Saved v1/v2 recipes remain unchanged. New group-scope and student-edit-diff recipes are explicit separate bindings, not retroactive instructions. Completion checks question-heading and substantive answer-body presence, not semantic correctness or compliance with the host instructions.
- `onboarding.ts`, `health.ts` and `upcoming.ts` provide explicit course selection, local diagnostics and upcoming/overdue/undated views. Doctor checks cached sync ownership read-only, never today's API subject. Requester-effective assignment dates stay distinct from visible alternatives; null dates remain undated. Adjacent private `.env` is optional; process environment takes precedence.
- `lifecycle.ts` verifies completed assignment outputs before creating revision tasks or versioned Finals copies. `tools.ts` supplies bounded arithmetic, values-only workbooks, provenance comparison and human review bundles without model calls or code execution.

## Trust and limits

Course files and Canvas content are untrusted reference material, not instructions to the coding agent. `TASK.md` says to use only the snapshot, treat source content as untrusted, and cite exact source paths. Guidance with a policy value that is not explicitly permissive is excluded from the handoff. `complete` verifies structure and provenance constraints; it does not assess whether the response is correct, complete, permitted by school policy, or suitable to submit.

Downloaded Canvas files retain their original bytes. Selectable PDF text and basic DOCX/PPTX/XLSX content are extracted locally into hash-linked sidecars; original hashes remain part of the task's evidence checks. Scans need OCR elsewhere and complex formatting may be lost. HTML links recover unlisted Canvas files; safe CDN downloads never receive Canvas bearer tokens. Unsafe hosts produce notices. The toolkit has no automatic Drive/MCP integration, unattended schedule, historical reconstruction, built-in content generation or submission endpoint. Assignment work is handed to the user's chosen coding agent, not generated inside the toolkit.

`student-cli.ts` registers local calendar, feedback, reminder and guidance commands. Calendar overrides never edit Canvas. Reminders and auth alerts save private owned notices; desktop delivery is explicit opt-in, not an unattended schedule. Guidance proposals remain inactive until human activation. Private own-feedback/playbook archives can inform new ordinary tasks as untrusted learning context, never course permission or current grading verification. First origin/subject binding cannot certify older unbound caches.

`simulation.ts` freezes current source versions and labeled availability evidence; structural fallback rules and earlier derived views are versioned, not proof of historical access. Frozen tasks, window orchestration, calculations, values-only XLSX companions and comparison/M1 bundles validate saved recipes and bytes without borrowing newer live content. Human quality/permission gates remain pending. Arithmetic checks do not establish grounded inputs, and workbook extraction is not calculation or spreadsheet grading. Host usage exports are supplied data, not verified provider billing.

Reading existing School course-code roots does not require a rewrite; the scanner preserves student-owned files. For separate-product testing, `sync --preserve-school` persists a per-course `Canvas Agent` writable namespace. Fresh ordinary task destination recipe v1 puts generated outputs there even when reading School sources; older task destinations remain unchanged. Actual School source-writer audits pass selected synthetic flows in both orders with original/navigation/layout/task/output bytes preserved. Existing Canvas-owned root Home artifacts stop activation for reviewed migration or a separate test vault. This is path isolation, not document interchange: native Canvas documents still fail School's strict parser, and `portable-document.ts` remains a staged experiment rather than the active sync writer. Explicit migration is an archive-backed transaction, not authorization to advance whole-vault School markers. Private tasks stay in root `_meta/tasks/`, outside reading-copy exports. Cloud publication and installed-host/live-account acceptance remain separate gates. See PARITY.md and ACCEPTANCE.md for evidence and limits.
