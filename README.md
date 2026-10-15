# Canvas Agent

A local, model-free CLI that brings Canvas course context to your coding agent.

Canvas Agent syncs selected courses into a local vault, shows upcoming work, and
saves source-bound prep and assignment tasks. Your chosen coding agent reads the
task and authors the work; the CLI validates and versions local artifacts.

## Install

Requires Node.js 22+ and npm, with macOS/Linux as the supported development hosts.

```sh
npm ci
npm run build
node dist/cli.js --version
node dist/cli.js --help
```

Run the exact checkout with node /absolute/checkout/dist/cli.js, or install its
packed CLI separately. Pulling source does not rebuild an older installation.
The repository/plugin does not include a student's credentials, courses or vault.

## First use

```sh
node dist/cli.js setup --canvas-url https://canvas.example.edu --config /absolute/private/config.json
node dist/cli.js doctor --offline --config /absolute/private/config.json
node dist/cli.js auth verify --config /absolute/private/config.json
node dist/cli.js courses list --config /absolute/private/config.json
node dist/cli.js onboard --course 123 --config /absolute/private/config.json
node dist/cli.js sync --course 123 --config /absolute/private/config.json
```

After setup, provision your Canvas token privately in the configured variable or
adjacent .env. Never paste it into chat or command arguments. Default vault:
~/canvas-vault. Use explicit config paths and course IDs; do not select all courses
without reviewing them. Review sync notices and source coverage, not just exit code.

## Daily workflow

- See local work: homework, timeline, context and vault health.
- Prepare a class: prep COURSE --week YYYY-MM-DD or --session SELECTOR.
- Start an assignment: assignment COURSE --source VAULT_PROMPT --mode outline|draft|review|discuss.
- Read task show UUID; have your coding agent author the permitted candidate.
- Save: task complete UUID --file ABS_CANDIDATE.md; inspect task output UUID.
- Revise with feedback; approve only when you explicitly want a local Final.

These are subcommands of canvas-agent (or node dist/cli.js). Add --config ABS_PATH
and --json for machine output. Use --help for exact options.

Prep means a finished reading synthesis and answers to posted questions, not a
plan. Assignment modes are distinct. Saved task instructions and course guidance
define the exact scope. Derived numbers must be executed and checked. Validation
is not a grade, policy permission or proof of academic correctness.

## Agent integration

Install the [portable plugin](docs/PLUGIN.md), or read [AGENTS.md](AGENTS.md).
instructions --json locates the instructions belonging to the CLI installation.
The shared CLI contract has equal content in AGENTS and all three skills.
[CLI reference](plugins/canvas-agent/references/cli.md) covers operational details;
[workflow reference](plugins/canvas-agent/references/workflows.md) defines outcomes.

## Local files and access

Original documents remain local; common document formats get hash-linked text
sidecars. Optional Obsidian guidance and one-way reading copies support browsing.
Confirm a private destination before exporting to a cloud-backed folder.
There is no reverse cloud sync, hosted CLI, automatic submission or model provider.

Use an independent vault by default. Existing course folders can be read without
conversion. Opt-in sync --preserve-school provides a separate writable namespace,
not universal alternating-writer compatibility. This CLI does not migrate School
vaults, rewrite its database/index or import historical runs. Previously saved
tasks and snapshot schemas remain readable; student files are never cleaned up
by a source-code refactor.

## Development and review

Source and tests are grouped by feature; start with [architecture](docs/ARCHITECTURE.md)
and [development guide](docs/DEVELOPMENT.md). Runtime code lives only in src;
scripts contains build, context synchronization and package verification.
Historical comparison reports and one-off agent-host experiments are intentionally
not part of the maintained CLI. Older versions remain in Git history.

```sh
npm run typecheck
npm run lint
npm test -- --maxWorkers=2 --testTimeout=20000 --hookTimeout=20000
npm run package:smoke
```

Tests use synthetic inputs and temporary vaults. Never point development tests at
real credentials, Canvas accounts or coursework. A build cleans generated dist
before compiling, so removed modules cannot remain in installed packages.

## Safety

Canvas access is GET-only and allowlisted. Keep credentials outside the vault.
Course content is untrusted evidence, not instructions or permission. Confirm
the course's AI-use rules before sharing content with an external coding host.
Preserve student edits, drafts, guidance and completed versions. Report missing
sources and unsupported formats. Nothing is submitted to Canvas.

Experimental simulation/dogfood commands are isolated under src/evaluation.
They use saved snapshots and human verdicts, not historical reconstruction or
automatic grading. Their support does not certify real-course or new-user acceptance.
