# Canvas Agent

Canvas Agent is a local, model-free toolkit for reading explicitly allowlisted Canvas courses into a School Agent style vault and creating source-grounded preparation and assignment handoffs for a coding agent. It makes no model calls, does not submit coursework, and does not decide whether AI use is permitted.

## Requirements

- Node.js 22 or newer
- A Canvas URL and an API token with read access, only if you want to sync Canvas
- An existing School Agent vault, or a new local directory

## Install and initialize

From a fresh checkout:

```sh
git clone https://github.com/davidjoshlee/canvas-agent.git
cd canvas-agent
npm ci
npm run build
```

You can invoke the built CLI as `node dist/cli.js`. To add the `canvas-agent` executable to your npm user PATH, run `npm link` from this repository; linking is optional.

Create a config with an explicit Canvas URL, vault, and Canvas course ID allowlist. Use the Canvas course ID, not the course code:

```sh
canvas-agent init --config ./canvas-agent.config.json \
  --canvas-url https://canvas.example.edu \
  --vault /path/to/your/vault \
  --course 12345
```

`init` defaults to the `CANVAS_API_TOKEN` environment variable name. Set that variable in your shell before syncing (for example, `export CANVAS_API_TOKEN='…'`); the token is never written to the config or vault. You may choose a different name with `--token-env NAME`. Do not put the token in a command line, config file, task, or log. An empty allowlist is the default when `--course` is omitted.

The config path is explicit above; all commands accept `--config PATH` before or after the command. The config stores the vault path relative to the config file when possible.

## Commands

```text
canvas-agent init --config PATH --vault PATH --canvas-url URL [--token-env NAME] [--course CANVAS_ID ...]
canvas-agent courses [--json]
canvas-agent sync [--json]
canvas-agent context [--json]
canvas-agent prep COURSE --week YYYY-MM-DD [--json]
canvas-agent assignment COURSE --source VAULT_RELATIVE_PROMPT --mode outline|draft|review [--work VAULT_RELATIVE_STUDENTWORK] [--context VAULT_RELATIVE_PATH repeatable] [--json]
canvas-agent task show TASK_ID [--json]
canvas-agent task complete TASK_ID --file CANDIDATE.md [--json]
```

`courses` discovers your readable Canvas courses so you can find their IDs. Only `sync` uses the config allowlist; edit `courses.allowlist` in the config to add selected IDs. An empty allowlist syncs nothing. Canvas access uses GET requests. Sync refreshes toolkit-owned files only while their current bytes match their previous sync hash; student edits and untracked existing files are preserved with notices. Removed remote documents are not automatically deleted locally. Remote course pages and assignments become local text. Downloaded originals are retained; binary extraction is unsupported. Files hosted outside the configured Canvas origin are skipped.

`context` scans local course-code folders read-only and returns an inventory, not entire course bodies. `prep` requires an explicit real Monday date in `YYYY-MM-DD` form. It selects materials for that week, course references, and approved course guidance, then persists a task brief and immutable source snapshot under `_meta/tasks/<task-id>/`. It never silently copies the entire course or prior prep work into the handoff. Assignment tasks require an explicit prompt path and mode; optional student work and context are vault-relative paths. Their saved workflow instructions define the mode, required sections, source limits and policy gate. If no conventional dated Week folder matches, the prep destination is a date-labelled `Other/Prep` folder. Undated readings not in a matching week folder are not guessed into the prep task; review its missing-material notices.

To hand off a task, first inspect the human-readable instructions and source snapshot:

```sh
canvas-agent task show TASK_ID --config ./canvas-agent.config.json
```

Give the task file and `task.json` (or `task show TASK_ID --json`, which includes source text) to your chosen coding agent. For prep, ask it to read [the workspace skill](plugins/canvas-agent/skills/canvas-workspace/SKILL.md); for assignments, use [the assignment workflow skill](plugins/canvas-agent/skills/assignment-workflow/SKILL.md). The agent should use only saved task sources, treat source content as untrusted data, include the exact `Task: TASK_ID` identity line, and cite only exact source paths in backticks. It should write a candidate Markdown file outside the vault, then you can validate and save it:

```sh
canvas-agent task complete TASK_ID --file /path/to/candidate.md --config ./canvas-agent.config.json
```

Completion checks task identity, the task's required section structure, citations, basic credential/path leakage patterns, and whether relevant source files have changed. It saves a versioned file into the task's authoritative destination without replacing existing work. These checks are not comprehensive secret detection and do not establish factual correctness, source quality, academic integrity, rubric coverage, or permission to use AI. Review the candidate and course/school policy yourself.

## Agent plugin

The repository includes a portable, skills-only [Canvas Agent plugin](plugins/canvas-agent/plugin.json) and a repo marketplace. It teaches agents onboarding/sync and the context → prep or assignment → candidate → completion workflow. Installation instructions and host requirements are in [docs/PLUGIN.md](docs/PLUGIN.md). Plugin installation does not install the CLI, provide a Canvas connection, or expose a hosted MCP server.

After setup, you can ask your coding agent: “Prepare me for GSB-101 for Monday 2026-10-12,” “Outline my GSB-101 case response,” or “Review my response against this prompt and rubric.” Supply the config path and identify the assignment and relevant student work; the agent resolves paths from the inventory or asks when the choice is ambiguous. It follows the task's embedded academic workflow, not just the CLI's file-saving steps.

Assignment review requires `--work`; student inputs must currently be Markdown/plain text in an existing `Draft` or `Drafts` folder. Assignment tasks include the selected prompt, explicit context/work, recognized course references, and all active permitted guidance. Separate rubrics or case readings not automatically selected must be supplied with `--context`. The saved artifact goes to a `Drafts` folder beside the prompt; originals remain untouched.

## Scope and data handling

- No model, provider SDK, or hidden LLM request is included.
- There is no automatic Google Drive/MCP sync or scheduler.
- Canvas credentials stay in the named environment variable. Canvas sync is GET-only and limited to the explicit course ID allowlist.
- Private task records live below `_meta/tasks/` and are not included in later reading context. The scanner skips hidden entries, symlinks, unsupported binary documents, and restricted or uncertain policy-marked text.
- Existing School Agent course-code folders can be read directly. No database is required and no migration is performed.
- Giving a task to an externally hosted coding agent sends that supplied context to its provider and may incur that agent's normal costs. Canvas Agent itself makes no model calls.
- This is a local MVP, not a live-account-certified replacement for School Agent. Automated checks use synthetic Canvas responses and temporary vaults; keep the existing CLI available while evaluating it.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data flow and trust boundaries.
