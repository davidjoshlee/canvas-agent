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

Setup creates a new config and adjacent private `.env` template, never overwriting either. The vault defaults to `~/school-vault` if omitted. Enter the Canvas token locally in that `.env` or the configured shell environment variable (`CANVAS_API_TOKEN` by default). Never paste it into chat, command arguments, the vault or Git. Shell variables take precedence. Existing users can keep `init`; all paths in config resolve relative to its location.

```sh
canvas-agent auth status --config /absolute/path/private/canvas-agent.config.json
canvas-agent auth verify --config /absolute/path/private/canvas-agent.config.json
canvas-agent courses list --config /absolute/path/private/canvas-agent.config.json --json
canvas-agent onboard --course 12345 --config /absolute/path/private/canvas-agent.config.json
canvas-agent sync --config /absolute/path/private/canvas-agent.config.json
canvas-agent vault health --config /absolute/path/private/canvas-agent.config.json
```

Select course IDs explicitly. `courses list` filters active courses; `--all` shows all readable courses. `onboard --course ID` is repeatable; `--all-active` is opt-in. Empty allowlists sync nothing. `sync --course ID_OR_CODE` narrows an existing allowlist, never expands it. Auth status checks token presence; only auth verify checks the server. Doctor is local; `--offline` permits missing credentials, while `--sync-only` checks sync prerequisites. `config validate` and `config show` help diagnose configuration without printing credentials.

## Student workflow

Every command supports `--config PATH`; use it explicitly when operating from another directory. `--json` gives machine-readable stdout; errors go to stderr and return nonzero.

```text
homework [--days 14] [--course COURSE]
upcoming [--days 14] [--course COURSE]
calendar override VAULT_ASSIGNMENT_PATH --due ISO
calendar check --file /absolute/path/calendar.ics
calendar export --file /absolute/path/new-calendar.ics [--days N] [--course COURSE]
guidance propose COURSE
guidance save UUID --file /absolute/path/proposal.md
timeline [--weeks 4] [--course COURSE]
context
prep COURSE [--week current|YYYY-MM-DD | --session TITLE_OR_ID_OR_DATE]
assignment COURSE --source VAULT_RELATIVE_PROMPT --mode outline|draft|review
  [--work VAULT_RELATIVE_STUDENTWORK] [--context VAULT_RELATIVE_PATH repeatable]
draft ASSIGNMENT_TITLE_OR_ID_OR_PATH --course COURSE [--work PATH] [--context PATH repeatable]
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
workbook UUID --file /absolute/path/sheets.json
gate review UUID
ingest /absolute/path/document --course COURSE [--title TITLE] [--week YYYY-MM-DD] [--module CANVAS_MODULE_ID]
```

Upcoming-work commands use local synced data; sync first for fresh remote information. Homework lists upcoming/overdue assignments and undated work; timeline also includes announcements. Prep defaults to the current UTC Monday, accepts an explicit real Monday or uniquely identified session, and reports the resolved period. It follows module links to readings and fails if the period has no readable material rather than producing a syllabus-only brief. It includes recognized course references and active permitted guidance, not the entire vault or prior prep work.

Task generation creates a private handoff under `_meta/tasks/<UUID>/`: TASK.md, approved source snapshots and hashes, course/period identity, destination, workflow instructions, detected questions and required headings. It does **not** generate the academic content. The agent reads `task show UUID --json`, confirms course AI-use permission, and writes a separate candidate using only approved sources.

Prep defaults to Overview, Reading synthesis, Key concepts, Preparation questions, Discussion points, Sources. A course guidance section named `## Brief structure` can declare different headings using bullets or Markdown subheadings; Sources is appended if omitted. The task is authoritative: use its headings, not a hardcoded template. Answer detected questions under exact question subheadings; synthesize readings, frameworks and supplied cases rather than returning reading pointers.

Assignment tasks require a prompt and mode; review also requires explicit work, currently Markdown/plain text in a Draft/Drafts folder. Related material is followed when linked, but missing separate rubrics/readings must be explicitly supplied using `--context`. Never invent student experiences or evidence. The agent plugin contains the mode-specific workflow.

A candidate needs `Task: UUID`, required headings, and exact approved source paths in backticks. Completion checks structure, detected question-answer presence, citations, safe paths and unchanged relevant evidence/guidance, then saves a versioned artifact in the authoritative Prep or Drafts folder. Identical retries are idempotent. These checks do not prove factual correctness, answer depth, rubric coverage, academic integrity, AI permission or comprehensive secret detection.

Revision creates a fresh task with validated prior work and feedback. Approval copies a completed draft to a versioned Finals folder only when the student requests it; it never uploads to Canvas. Inspect/compare expose provenance, and gate review creates a human review bundle, not an academic score. Calculate logs bounded arithmetic; an optional source link records context, not proof of numeric grounding. Workbook accepts values-only JSON `{ "sheets": [{ "name": "Sheet", "rows": [["Label", 1]] }] }` without executing formulas or macros.

## Files and safety

Original files remain on your computer. Sync recovers Canvas files linked from syllabus, page and assignment HTML and follows safe CDN redirects without sending Canvas credentials externally. Requests have bounded retries and timeouts. Basic PDF selectable text and DOCX/PPTX/XLSX content are extracted into hash-linked Markdown sidecars. Ingest retains original bytes; select a prep Monday with `--week` or an existing Canvas module ID with `--module`. Scanned PDFs need OCR elsewhere; complex tables/layout may be lost. Extraction and skipped-host notices matter: successful sync does not prove source completeness.

Guidance proposals are source-bound handoffs for your chosen agent; saving creates a versioned proposed file, never active guidance. Review and activate separately. Private calendar overrides apply to local upcoming/homework/timeline views, not Canvas. ICS check reports conflicts and unsupported timezones; export creates a new file, not OS reminders. Calculations include population standard deviation and NPV (first cash flow at time zero, decimal rate), plus bounded JSON batches. Simulation captures current source versions with explicit availability metadata and replays that fixed private snapshot; it cannot reconstruct historical contents or permissions and does not run a model or grade work.

Canvas HTTP is GET-only and sync is allowlisted. Hash ownership preserves student edits, untracked files, guidance and existing outputs. Remote deletions are not automatically deleted locally. The scanner excludes symlinks, private metadata, credential-like files and restricted/uncertain policy-marked content. Existing School Agent course-code roots can be read without a database or migration; no live student vault is rewritten by development work.

Private tasks and simulation replays contain source bodies. Giving them to a hosted agent shares that context with its provider and may incur normal agent costs. Do not publish private records or put them in a reading copy. Model routing/billing belongs to the chosen agent. Drive sync, hosted MCP, unattended scheduling and automatic submission are not included.

Version 0.4 is verified with synthetic responses and temporary vaults, not certified against a live student account. Keep School Agent available while evaluating. See [workflow parity and remaining limits](docs/PARITY.md), [architecture](docs/ARCHITECTURE.md), [plugin installation and instruction parity](docs/PLUGIN.md), and [the shared CLI contract](plugins/canvas-agent/references/cli.md).
