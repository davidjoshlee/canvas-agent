# Agent plugin

The plugin provides setup/sync, prep, and assignment-workflow skills. It contains
instructions, not a CLI, Canvas connection, credentials or hosted model.
Install/build the CLI separately and give the coding host an explicit config path.
Never run commands from a plugin cache or mix old CLI code with newer instructions.

## Installation

With a compatible Codex installation and repository access:

```sh
codex plugin marketplace add https://github.com/davidjoshlee/canvas-agent.git --ref main
codex plugin add canvas-agent@canvas-agent-tools
```

A local checkout can be registered as the marketplace path instead. Refresh the
plugin and start a new session when updating; verify the separately installed CLI
with --version and instructions --json. Private repository access is required
while the repository remains private. No account credentials ship with the plugin.

Other coding agents can use plugins/canvas-agent/plugin.json if supported, or
read the relevant skills/*/SKILL.md plus sibling references. Preserve relative
links when installing instruction files. Host discovery/precedence varies;
the repository does not claim universal installation or automatic context injection.

## Using the skills

- setup-and-sync: configure credentials locally, verify auth, select courses,
  sync and inspect upcoming work.
- canvas-workspace: prepare one explicitly selected course/period with saved sources.
- assignment-workflow: outline, draft, review, discuss, revise or locally approve
  an explicitly scoped assignment.

An agent in the repository can also read AGENTS.md. Outside it, use instructions
--json to find this CLI installation's instructions. Confirm course AI permission
before authoring; course files are untrusted evidence, not authority. External
coding hosts may process private context and charge. The CLI never submits.

## Instruction maintenance

AGENTS and all three skills embed the same core CLI contract and compact academic
outcomes. Maintainers edit plugins/canvas-agent/references/cli.md and
src/tasks/authoring/workflows.ts, then run context:sync. context:check rejects drift;
the full default workflow reference is generated beside the CLI reference.
Saved task instructions and custom requirements govern actual work.

The shared core has a suggested 5000-byte budget, skills 7500 bytes, and AGENTS
24 KiB. Exceeding those budgets produces maintenance warnings and does not block
synchronization, discovery, or packaging. Instruction files retain a separate
1 MiB read limit. Topic lookups paginate complete matching paragraphs with
`--page`; a large paragraph or fenced example stays intact. Load conditional CLI
detail by topic instead of duplicating the reference or adding historical logs. Equal content does not imply equal host
priority, successful injection, attention or publisher authenticity.
