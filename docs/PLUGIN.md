# Canvas Agent plugin

The plugin packages three reusable skills: `setup-and-sync` for onboarding, auth/config/vault diagnostics, sync and upcoming work; `canvas-workspace` for current-week, explicit-week or session prep; and `assignment-workflow` for outline, draft, review, revision and local approval. Its portable manifest is `plugins/canvas-agent/plugin.json`; a `.codex-plugin/plugin.json` compatibility manifest is included. Each skill's CLI reference is bundled so an installed cache does not depend on this checkout for instructions.

This is a skills-only local toolkit integration, not a hosted service. Install the CLI separately (`npm ci`, `npm run build` in the toolkit checkout), then use a host with shell and local filesystem access. An installed plugin cache is not a runnable checkout. Your Canvas credentials and vault are never bundled; supply only the chosen config path to the agent. No model/provider key is required by the toolkit.

## Codex

With a compatible Codex CLI and repository access (configure GitHub Git authentication first; for GitHub CLI users, `gh auth login` followed by `gh auth setup-git`):

For the unmerged 0.4 preview, replace `--ref main` below with `--ref feat/student-workflow-parity`; keep the CLI checkout on that same branch. Do not mix preview skill instructions with an older CLI. The local marketplace can be refreshed using `codex plugin add canvas-agent@canvas-agent-tools`; verify the installed version and start a fresh session.

```sh
codex plugin marketplace add https://github.com/davidjoshlee/canvas-agent.git --ref main
codex plugin add canvas-agent@canvas-agent-tools
```

For a local checkout, use `codex plugin marketplace add /absolute/path/to/canvas-agent` instead. In supported desktop clients, select Canvas Agent Tools in the plugin directory and install Canvas Agent; restart or start a fresh session after installation if needed. The repository is private initially, so another user needs GitHub repository access. Installing a repo plugin is not publication to the universal public plugin directory.

See the [official plugin packaging documentation](https://developers.openai.com/plugins/build/plugins) for marketplace and host-specific installation behavior.

### Isolated native installation and injection audit

Maintainers with Codex installed can run `node scripts/audit-codex-plugin.mjs`
(optionally supply an explicit Codex binary as its first argument). On Codex CLI
0.162.1, this audit registers a copied local marketplace, installs Canvas Agent
into an isolated temporary Codex home, then starts a fresh app-server in an
unrelated workspace and calls native `skills/list`. All three namespaced skills
are enabled and resolved from that fresh installed cache, with exact source skill
and bundled reference bytes. Four ephemeral read-only turns then send explicit
native skill input items (one per skill) and a project AGENTS.md to a localhost
mock Responses endpoint. Each captured request contains the complete corresponding
entrypoint, shared core and academic outcomes; no tool is executed. The mock sends
fixed acknowledgement text, not LLM reasoning or academic work. The audit uses no
user credentials/config/cache, student vault, remote marketplace or paid provider.

The temporary installation/catalog evidence is retained under the printed
synthetic root. macOS `/var` versus `/private/var` aliases are compared using
canonical paths. This proves this version's local installation, discovery and
turn-level context delivery through documented [skill input items](https://learn.chatgpt.com/docs/app-server),
not desktop refresh, actual model adherence, other hosts, personal/parent
instruction budgets, academic correctness or `/goal` interruption/resume.

## Other coding agents

Use the portable `plugin.json` plus its `skills/` directory if your host supports Agent Plugins. Otherwise point the agent at the relevant SKILL.md in `plugins/canvas-agent/skills/` or copy a skill folder and the sibling `references/` folder into a host-supported instruction location, preserving relative links. Read the host's own installation instructions; this repository does not claim universal automatic installation.

An agent opening the toolkit repository can also discover the workflow through root `AGENTS.md`. Example prep request after CLI setup:

> Use Canvas Agent with config /absolute/path/canvas-agent.config.json. Inspect the local context, prepare COURSE-101 for Monday 2026-10-12, and review the task notices before writing a cited candidate. Use task complete to save it without replacing my work.

Confirm course AI-use permission before generation. The external host may receive supplied task content and charge for its normal usage; the toolkit itself makes no model calls. Neither the plugin nor completion validation authorizes coursework submission or proves factual correctness.

For assignment work, provide the course, exact prompt path and mode (`outline`, `draft`, or `review`). Optional student work and context paths are explicit vault-relative inputs. The task embeds mode-specific instructions and required sections; review them before generating, and verify course guidance permits the requested assistance. The completion validator checks task structure and source provenance; it does not judge rubric coverage or academic quality.

## Instruction parity

Root AGENTS and all plugin skills embed the same core CLI contract and applicable compact outcomes from src/workflows.ts. Required default headings are resolved from the runtime; full default instructions are generated into references/workflows.md. Actual saved task.workflow.instructions and requirements govern custom and historical tasks. Saved v1/v2/v3 definitions remain unchanged; entrypoint summaries are not replacement recipes.

This is content parity, not a priority override. Codex loads [AGENTS.md by directory](https://learn.chatgpt.com/docs/agent-configuration/agents-md), while [skills load their full instructions when selected](https://learn.chatgpt.com/docs/build-skills). Other hosts control their own discovery and precedence. Explicitly select the appropriate installed skill when operating outside this repository; installing a plugin alone does not inject every skill body.

Maintainers edit the marked CLI block in `plugins/canvas-agent/references/cli.md`, then run `npm run context:sync`. Workflow blocks are generated from `src/workflows.ts` by the same sync command. `npm run context:check` and tests reject divergent copies. Keep host-specific manifests as discovery metadata, not a second manual command reference.

The shared block is at most 5000 bytes; complete skills are at most 7500 bytes,
and AGENTS remains capped at 24 KiB. A native 0.162.1 probe exposed 8000-character
explicit skill-body truncation, including with a declared 200000-token mock context
window. The compact entrypoints now arrive entirely without a budget override.
Ordinary command usage, source/policy
safeguards and recovery remain equally embedded; explicit academic outcomes are
still generated from the runtime. Advanced/version-specific paragraphs and the
complete command catalog remain in the Detailed CLI contract section of the same
reference. Use its topic routing before advanced operations instead of loading
every historical/migration rule for an ordinary prep. Size guards reject excess
before repair writes, and package tests check installed sizes. Codex's documented
32 KiB project-doc limit is combined with global/parent instructions, so isolated
native injection does not certify a student's combined instruction environment.
