# Canvas Agent

**Canvas Agent gives your coding agent a persistent, local workspace for Canvas.**

Sync the courses you choose. Keep readings, assignments and course context in a
vault on your machine. Then ask your agent to prepare for class or work through
an assignment using saved sources that are still there next time.

```text
Canvas → your local course vault → saved task → your coding agent → reviewed file
```

Canvas Agent is the bridge and the memory; your coding agent does the writing.
The CLI has no model and never submits work to Canvas.

## What it does

- Keeps an up-to-date local copy of explicitly selected Canvas courses.
- Surfaces upcoming work and course context between sessions.
- Saves source-backed prep and assignment tasks for an agent to pick up later.
- Checks and versions the files your agent returns, so drafts stay yours.

Use it when you want an agent to remember the course material and assignment
context you have already gathered, instead of starting each session from scratch.

## Get started

Requires Node.js 22+ and npm.

```sh
npm ci
npm run build
node dist/cli.js --help
```

Set up a private config and vault, then connect and sync one course:

```sh
node dist/cli.js setup --canvas-url https://canvas.example.edu --config /absolute/private/config.json
node dist/cli.js auth verify --config /absolute/private/config.json
node dist/cli.js courses list --config /absolute/private/config.json
node dist/cli.js onboard --course 123 --config /absolute/private/config.json
node dist/cli.js sync --course 123 --config /absolute/private/config.json
```

Keep your Canvas token in the configured environment variable or a private
adjacent `.env` file. Keep the config outside the vault. The default vault is
`~/canvas-vault`; existing configs keep their current paths. Choose courses
explicitly and review sync notices and source coverage.

## Pick up where you left off

```sh
canvas-agent homework --course 123 --config /absolute/private/config.json
canvas-agent prep 123 --week 2026-10-12 --config /absolute/private/config.json
canvas-agent assignment 123 --source /vault/path/prompt.md --mode outline --config /absolute/private/config.json
canvas-agent task show TASK_ID --config /absolute/private/config.json
```

The task records its sources and instructions. Your coding agent reads it, writes
a candidate file, then the CLI checks and saves that file as a local version.
For assignments, choose `outline`, `draft`, `review` or `discuss`; each has a
different job. Prep produces a reading synthesis and answers to posted questions.
Use `canvas-agent --help` for command options. Commands also work as
`node /absolute/checkout/dist/cli.js`; always pass `--config` explicitly.

## Built for a clear handoff

- **Scoped:** Canvas access is GET-only and limited to courses you allowlist.
- **Persistent:** sources, tasks and drafts live in your vault across sessions.
- **Reviewable:** your agent's work is saved locally in versions; nothing is
  submitted to Canvas.
- **Model-free:** use the coding agent you choose. No provider or model
  credentials are included.

Course files are evidence, not instructions. Confirm your course's AI-use rules
before sharing material with an external coding agent. Validation checks the
saved artifact's structure and evidence; it is not a grade or proof of academic
correctness. Report missing sources and unsupported formats rather than filling
gaps by guessing.

## Using an agent

In this repository, an agent can read [AGENTS.md](AGENTS.md). For other supported
hosts, install the [portable plugin](docs/PLUGIN.md), or use
`canvas-agent instructions --json` to locate the instructions installed beside
the CLI. The [CLI reference](plugins/canvas-agent/references/cli.md) covers
commands; the [workflow reference](plugins/canvas-agent/references/workflows.md)
explains the task outcomes.

## For contributors

Start with the [architecture](docs/ARCHITECTURE.md) and
[development guide](docs/DEVELOPMENT.md). Tests use synthetic courses and
temporary vaults; do not use a real Canvas account, credentials or student vault
in development.

```sh
npm run typecheck
npm run lint
npm test -- --maxWorkers=2 --testTimeout=20000 --hookTimeout=20000
npm run package:smoke
```
