# Canvas Agent

A local, model-free Canvas workspace for your coding agent. The CLI syncs selected courses, organizes context, defines prep/assignment tasks, and validates and saves the agent's work. Your chosen agent reads the material and writes the content. No provider key or model call is built into this toolkit, and it never submits coursework.

## Install and onboard

Requires Node.js 22+, local shell/filesystem access, and repository access while this GitHub repository is private.

While 0.4 is under review, use branch `feat/student-workflow-parity` (`git switch feat/student-workflow-parity` after cloning). The default branch does not receive these changes until they are merged. See the [acceptance checklist](docs/ACCEPTANCE.md) before onboarding a live student.

```sh
git clone https://github.com/davidjoshlee/canvas-agent.git
cd canvas-agent
npm ci
npm run build
```

Invoke `node /absolute/checkout/dist/cli.js`, or optionally run `npm link` to put `canvas-agent` on your npm user PATH. Install the [agent plugin](docs/PLUGIN.md) separately; a plugin supplies instructions, not the executable.

```sh
canvas-agent setup --canvas-url https://canvas.example.edu \
  --config /absolute/path/private/canvas-agent.config.json \
  --vault /absolute/path/private/vault
canvas-agent doctor --offline --config /absolute/path/private/canvas-agent.config.json
```

Setup creates a new config and adjacent private `.env` template, never overwriting either. New setups default to `~/canvas-vault` if omitted, separate from School Agent's default vault. Existing configs keep their saved paths; sharing a vault requires an explicit `--vault` choice and the preservation workflow. Enter the Canvas token locally in that `.env` or the configured shell environment variable (`CANVAS_API_TOKEN` by default). Never paste it into chat, command arguments, the vault or Git. Shell variables take precedence. Existing users can keep `init`; all paths in config resolve relative to its location.

```sh
canvas-agent auth status --config /absolute/path/private/canvas-agent.config.json
canvas-agent auth verify --config /absolute/path/private/canvas-agent.config.json
canvas-agent courses list --config /absolute/path/private/canvas-agent.config.json --json
canvas-agent onboard --course 12345 --config /absolute/path/private/canvas-agent.config.json
canvas-agent sync --config /absolute/path/private/canvas-agent.config.json
canvas-agent vault health --config /absolute/path/private/canvas-agent.config.json
```

Select course IDs explicitly. `courses list` filters active courses; `--all` shows all readable courses. `onboard --course ID` is repeatable; `--all-active` is opt-in. Empty allowlists sync nothing. `sync --course ID_OR_CODE` narrows an existing allowlist, never expands it. Auth status checks token presence; only auth verify checks the server. Doctor is local; `--offline` permits missing credentials, while `--sync-only` checks sync prerequisites. `config validate` and `config show` help diagnose configuration without printing credentials.

For an explicitly chosen concluded pilot, discover it with `courses list --all`,
then run `onboard EXACT_CANVAS_ID --pilot --config /absolute/path/private/canvas-agent.config.json`.
This replaces the allowlist with that single course and syncs it immediately,
preserving student files. It does not accept School's destructive `--fresh` reset,
reconstruct historical materials, or establish AI-use permission. Regular active
onboarding only saves the selection; sync remains a separate command.
If discovery omits the exact pilot ID, the CLI checks that it is not a known
active course, then requires readable assignments spanning at least 14 days and
own graded feedback. This is an eligibility fallback, not historical verification;
review all coverage notices before evaluation. Use its exact allowlisted numeric
ID for narrowed sync when the course remains absent from discovery.

Existing School Agent users: keep School installed, with its config, Keychain
entry, index and expiry file unchanged. Canvas uses its own config and private
adjacent dotenv store. Configure an existing token variable explicitly, provision
a new token locally, or explicitly use `auth import-school-keychain` with one exact
School account and confirmed expiry. That opt-in import reads the named entry;
it does not modify/enumerate Keychain or become Keychain storage. Never put tokens
in chat or command arguments. Run `auth verify` separately; login/import records
storage and expiry, not API validity. `auth renew` prints manual steps.

Coding agents can run `canvas-agent instructions --json` from any folder to find
this CLI installation's AGENTS, skills and full references. It needs no config or
credentials; use the returned paths rather than assuming they exist in the
student workspace. Shared instructions are checked for consistency, not host
injection or publisher authenticity. Saved task requirements still govern work.

For a genuinely new shared vault, initialize School's vault through its supported
workflow before Canvas creates course folders. Public School 0.1.1 refuses writes
to a nonempty course vault with no `_meta/layout.json`; never create or advance
that whole-vault marker manually to bypass the guard. Existing markerless vaults
need explicit School migration/readiness review or a separate Canvas vault.
Then use `sync --preserve-school` before Canvas's
first sync (or `onboard ID --pilot --preserve-school`). Selected courses get a
persistent `Canvas Agent` writable namespace, retained by later unflagged syncs.
New prep/draft/revision/Finals outputs stay there even when reading old School
sources. Existing originals and old task destinations are not moved or rewritten.
An existing Canvas-owned root Home requires reviewed migration or a separate test
vault; activation stops rather than converting it silently. The pinned public
School writer passes selected School-first synthetic preservation tests; Canvas-first
and older Canvas vaults without the marker correctly remain blocked. Neither
case certifies all-format interchange or live/installed-release acceptance.

For an older hash-owned Canvas root Home, preview
`vault preserve-school --course ID --config PATH --json`. Only after reviewing the
plan, add `--apply` to archive that generated navigation and enable separate paths.
Exact navigation and Canvas metadata backups are retained privately; student edits,
School originals and old task records are never silently rewritten. Concurrent
changes stop for recovery, and old tasks may need new source snapshots after the move.

For read-only School index diagnosis, run `vault reconcile-index --school-index
ABSOLUTE_SCHOOL_INDEX --course CANVAS_ID --config PATH --json` (Node 22.16+).
Select numeric IDs explicitly; the School database must be outside the vault.
This reports matching local relocation candidates, duplicates, identity conflicts,
missing validated sources and concluded/deleted index metadata. It never relinks
anything, reads outside-vault indexed documents, contacts Canvas or adopts School
config. It queries a private temporary database/WAL snapshot after checking copied
bytes against the source, avoiding SQLite's original-index sidecar writes. Normal
exit removes the copy; process interruption can retain a private temporary copy.
Snapshot verification is not proof the live index remains current afterward.
Classification relies on local metadata, not authenticated authorship or
proof that a source is unavailable remotely. Malformed/unsafe/oversized evidence
is skipped with a notice or refused, not silently repaired.

Fresh context excludes unchanged old Canvas-owned sources while retaining them
on disk. Edited historical copies remain available for explicit selection;
upcoming work and calendar comparison prefer the active namespaced Canvas identity.
Calendar collisions across courses or between active copies still require review.

## Student workflow

Every command supports `--config PATH`; use it explicitly when operating from another directory. `--json` gives machine-readable stdout; errors go to stderr and return nonzero.

```text
homework [--days 14] [--course COURSE]
upcoming [--days 14] [--course COURSE]
calendar override VAULT_ASSIGNMENT_PATH --due ISO
calendar check --file /absolute/path/calendar.ics
calendar export --file /absolute/path/new-calendar.ics [--days N] [--course COURSE]
guidance propose COURSE
guidance init-assignment COURSE --source VAULT_RELATIVE_PROMPT
guidance save UUID --file /absolute/path/proposal.md
timeline [--weeks 4] [--course COURSE]
context
prep COURSE [--week current|YYYY-MM-DD | --session TITLE_OR_ID_OR_DATE]
assignment COURSE --source VAULT_RELATIVE_PROMPT --mode outline|draft|review|discuss
  [--message QUESTION_FOR_DISCUSS] [--work VAULT_RELATIVE_STUDENTWORK] [--context VAULT_RELATIVE_PATH repeatable]
draft ASSIGNMENT_TITLE_OR_ID_OR_PATH --course COURSE [--discuss QUESTION] [--work PATH] [--context PATH repeatable]
task show UUID
task complete UUID --file /absolute/path/candidate.md
revise UUID --feedback TEXT [--work PATH]
approve UUID
inspect UUID
compare UUID OTHER_UUID
calculate --task UUID --operation sum|mean|median|min|max|stddev|npv|add|subtract|multiply|divide|power --values CSV
  [--rate DECIMAL] [--source TASK_SOURCE_PATH]
calculate --task UUID --file /absolute/path/batch.json
simulate capture COURSE --as-of ISO
simulate replay UUID
simulate task create SIMULATION_UUID --kind prep --week YYYY-MM-DD [or --session SELECTOR]
simulate task create SIMULATION_UUID --kind assignment --source CAPTURED_PROMPT --mode outline|draft|review|discuss
  [--work CAPTURED_STUDENTWORK] [--message QUESTION_FOR_DISCUSS] [--context CAPTURED_PATH repeatable]
simulate task show EVALUATION_TASK_UUID
simulate task complete EVALUATION_TASK_UUID --file /absolute/path/candidate.md
simulate compare --course COURSE --task EVALUATION_TASK_UUID [repeatable] [--reference ELIGIBLE_REVIEW_PATH repeatable]
workbook UUID --file /absolute/path/sheets.json
gate review UUID
gate m1 --comparison COMPARISON_UUID --course COURSE
dogfood --course COURSE [--week YYYY-MM-DD | --session SELECTOR] [--assignment TITLE_OR_ID_OR_PATH] [--offline | --sync]
dogfood show RUN_UUID --course COURSE
dogfood resume RUN_UUID --course COURSE [--offline | --sync] [--verdict TASK_UUID=pass|fail repeatable] [--approve-task TASK_UUID repeatable]
dogfood --course COURSE --sessions COUNT_1_TO_100 [--offline | --sync]
simulate list --course CAPTURED_COURSE_CODE --json
simulate window list --course CAPTURED_COURSE_CODE --json
simulate window resume WINDOW_UUID --course CAPTURED_COURSE_CODE --json
simulate task list --course CAPTURED_COURSE_CODE --json
dogfood sweep list --course COURSE --json
dogfood sweep show SWEEP_UUID --course COURSE
dogfood sweep resume SWEEP_UUID --course COURSE [--offline | --sync]
ingest /absolute/path/document --course COURSE [--title TITLE] [--week YYYY-MM-DD] [--module CANVAS_MODULE_ID]
ingest /absolute/path/document --course COURSE --school-compatible --ai-policy allowed|prohibited --redistribution allowed|restricted
```

Upcoming-work commands use local synced data; sync first for fresh remote information. Homework lists upcoming/overdue assignments and undated work; timeline also includes announcements. Prep defaults to Monday in the CLI host's local calendar week, accepts an explicit real Monday or uniquely identified session, and reports the resolved period. Use an explicit Monday for reproducibility across timezones. It follows module links to readings and fails if the period has no readable material rather than producing a syllabus-only brief. It includes recognized course references and active permitted guidance, not the entire vault or prior prep work.

Task generation creates a private handoff under `_meta/tasks/<UUID>/`: TASK.md, approved source snapshots and hashes, course/period identity, destination, workflow instructions, detected questions and required headings. It does **not** generate the academic content. The agent reads `task show UUID --json`, confirms course AI-use permission, and writes a separate candidate using only approved sources.

Prep defaults to Overview, Reading synthesis, Key concepts, Preparation questions, Discussion points, Sources. A course guidance section named `## Brief structure` can declare different headings using bullets or Markdown subheadings; Sources is appended if omitted. The task is authoritative: use its headings, not a hardcoded template. Answer detected questions under exact question subheadings; synthesize readings, frameworks and supplied cases rather than returning reading pointers.

Assignment tasks require a prompt and mode; review also requires explicit work, currently Markdown/plain text in a Draft/Drafts folder. Related material is followed when linked, but missing separate rubrics/readings must be explicitly supplied using `--context`. Never invent student experiences or evidence. The agent plugin contains the mode-specific workflow.

A candidate needs `Task: UUID`, required headings, and exact approved source paths in backticks. Completion checks structure, detected question-answer presence, citations, safe paths and unchanged relevant evidence/guidance, then saves a versioned artifact in the authoritative Prep or Drafts folder. Identical retries are idempotent. These checks do not prove factual correctness, answer depth, rubric coverage, academic integrity, AI permission or comprehensive secret detection.

Revision creates a fresh task with validated prior work and feedback. Approval copies a completed draft to a versioned Finals folder only when the student requests it; it never uploads to Canvas. Inspect/compare expose provenance, and gate review creates a human review bundle, not an academic score. Calculate logs bounded arithmetic; an optional source link records context, not proof of numeric grounding. Workbook accepts values-only JSON `{ "sheets": [{ "name": "Sheet", "rows": [["Label", 1]] }] }` without executing formulas or macros.

## Files and safety

For School-readable local imports, add `--school-compatible --ai-policy
allowed|prohibited --redistribution allowed|restricted`. These require explicit
student declarations, not defaults inferred from authentication or course metadata.
The mode keeps the same original binary and creates a separate strict School
Markdown artifact plus a hash-bound `.ingest.json` provenance companion. Older
sidecars and saved task recipes stay unchanged. Restrictive original declarations
cannot be relaxed. Missing/stale companions and restrictive variants prevent
fresh Canvas context from using linked raw text or older extractions as a bypass.
Edits are preserved, but a stale companion requires review rather than automatic
metadata repair. Parser compatibility is not proof of permission or correctness;
School does not independently enforce Canvas's provenance-companion checks.

Original files remain on your computer. Sync recovers Canvas files linked from syllabus, page and assignment HTML and follows safe CDN redirects without sending Canvas credentials externally. Requests have bounded retries and timeouts. Basic PDF selectable text and DOCX/PPTX/XLSX content are extracted into hash-linked Markdown sidecars. Ingest retains original bytes; select a prep Monday with `--week` or an existing Canvas module ID with `--module`. Scanned PDFs need OCR elsewhere; complex tables/layout may be lost. Extraction and skipped-host notices matter: successful sync does not prove source completeness.

Guidance proposals are source-bound handoffs for your chosen agent; saving creates a versioned proposed file, never active guidance. Review and activate separately. Private calendar overrides apply to local upcoming/homework/timeline views, not Canvas. ICS check reports conflicts and unsupported timezones; export creates a new file, not OS reminders. Calculations include population standard deviation and NPV (first cash flow at time zero, decimal rate), plus bounded JSON batches. Simulation captures current source versions with explicit availability metadata and replays that fixed private snapshot; it cannot reconstruct historical contents or permissions and does not run a model or grade work.

Canvas HTTP is GET-only and sync is allowlisted. Hash ownership preserves student edits, untracked files, guidance and existing outputs. Remote deletions are not automatically deleted locally. The scanner excludes symlinks, private metadata, credential-like files and restricted/uncertain policy-marked content. Existing School Agent course-code roots can be read without a database or migration; no live student vault is rewritten by development work.

Private tasks and simulation replays contain source bodies. Giving them to a hosted agent shares that context with its provider and may incur normal agent costs. Do not publish private records or put them in a reading copy. Model routing/billing belongs to the chosen agent. Drive sync, hosted MCP, unattended scheduling and automatic submission are not included.

Version 0.4 is verified with synthetic responses and temporary vaults, not certified against a live student account. Keep School Agent available while evaluating. See [workflow parity and remaining limits](docs/PARITY.md), [architecture](docs/ARCHITECTURE.md), [plugin installation and instruction parity](docs/PLUGIN.md), and [the shared CLI contract](plugins/canvas-agent/references/cli.md).

Maintainers can run `npm run package:smoke` to verify an actual tarball install
outside this checkout, with matching bundled agent instructions and synthetic
offline student workflows. It downloads npm dependencies into a temporary project
but does not use Canvas credentials, change a real vault, or install a host plugin.

For phone reading, `vault reading-copy --destination ABSOLUTE_FOLDER` previews a
separate, one-way copy. Add `--apply` for a dated snapshot or `--current --apply`
to enable refreshes after successful CLI writes. Use your explicit `--config` and
confirm the private cloud account before applying. Drive uploads remain the desktop
client's job; no changes flow back from the copy. `vault reading-copy-disable`
stops refreshes without removing copies. An existing School Agent Current mirror
requires explicit `--import-school-state`; see the shared contract before transferring
ownership. This does not import old academic run IDs.

For optional local version history, run `vault history enable --directory
ABS_NEW_PRIVATE_STORE --config PATH --json` with Git installed. The new store
must be outside the vault and should not be shared or cloud-synced: it retains
private sources, saved task context and student work, including deleted bytes.
Mutating CLI commands then snapshot changes automatically, including partial
writes from failed commands. Use `vault history snapshot` after direct editor
changes, `list` / `show EXACT_COMMIT_ID` to inspect versions, and `export
EXACT_COMMIT_ID --path EXACT_RELATIVE_PATH --file ABS_NEW_EXPORT` to recover bytes
to a separate new file for review. Always append your explicit config. Existing
vault `.git`, hooks and remotes remain untouched; no push or destructive checkout
is provided. `disable` preserves history, and enable with the same directory
resumes it. Resource/safety limits and credential heuristics can refuse capture;
a warning is not a successful backup. Read `instructions --topic "vault history"
--json` and command help for limits and recovery rules before enabling.

Use `vault history status --config PATH --json` for read-only backup diagnostics.
Full/offline doctor and vault health report enabled history errors; sync-only
doctor keeps that separate from Canvas prerequisites. Ready means latest saved
metadata/object headers are readable, not that unsaved edits are backed up or
every old object is intact. Empty/locked history needs inspection, not automatic
lock removal; missing Git is only a backup problem when history was enabled.
