# Canvas Agent plugin

The plugin packages three reusable skills: `setup-and-sync` for CLI onboarding, course selection and sync; `canvas-workspace` for source-bound prep candidates and completion; and `assignment-workflow` for explicit outline, draft, and review tasks. Its portable manifest is `plugins/canvas-agent/plugin.json`; a `.codex-plugin/plugin.json` compatibility manifest is included. Each skill's CLI reference is bundled inside the plugin, so an installed cache does not depend on this source checkout for instructions.

This is a skills-only local toolkit integration, not a hosted service. Install the CLI separately (`npm ci`, `npm run build` in the toolkit checkout), then use a host with shell and local filesystem access. An installed plugin cache is not a runnable checkout. Your Canvas credentials and vault are never bundled; supply only the chosen config path to the agent. No model/provider key is required by the toolkit.

## Codex

With a compatible Codex CLI and repository access (configure GitHub Git authentication first; for GitHub CLI users, `gh auth login` followed by `gh auth setup-git`):

```sh
codex plugin marketplace add https://github.com/davidjoshlee/canvas-agent.git --ref main
codex plugin add canvas-agent@canvas-agent-tools
```

For a local checkout, use `codex plugin marketplace add /absolute/path/to/canvas-agent` instead. In supported desktop clients, select Canvas Agent Tools in the plugin directory and install Canvas Agent; restart or start a fresh session after installation if needed. The repository is private initially, so another user needs GitHub repository access. Installing a repo plugin is not publication to the universal public plugin directory.

See the [official plugin packaging documentation](https://developers.openai.com/plugins/build/plugins) for marketplace and host-specific installation behavior.

## Other coding agents

Use the portable `plugin.json` plus its `skills/` directory if your host supports Agent Plugins. Otherwise point the agent at the relevant SKILL.md in `plugins/canvas-agent/skills/` or copy a skill folder and the sibling `references/` folder into a host-supported instruction location, preserving relative links. Read the host's own installation instructions; this repository does not claim universal automatic installation.

An agent opening the toolkit repository can also discover the workflow through root `AGENTS.md`. Example prep request after CLI setup:

> Use Canvas Agent with config /absolute/path/canvas-agent.config.json. Inspect the local context, prepare COURSE-101 for Monday 2026-10-12, and review the task notices before writing a cited candidate. Use task complete to save it without replacing my work.

Confirm course AI-use permission before generation. The external host may receive supplied task content and charge for its normal usage; the toolkit itself makes no model calls. Neither the plugin nor completion validation authorizes coursework submission or proves factual correctness.

For assignment work, provide the course, exact prompt path and mode (`outline`, `draft`, or `review`). Optional student work and context paths are explicit vault-relative inputs. The task embeds mode-specific instructions and required sections; review them before generating, and verify course guidance permits the requested assistance. The completion validator checks task structure and source provenance; it does not judge rubric coverage or academic quality.

## Instruction parity

Root `AGENTS.md` and all plugin skills embed the same core CLI contract: environment, command syntax, student context, handoff flow and safety boundaries. Workflow instructions are embedded from the runtime's `workflowFor` contract so task JSON and plugin entry points use the same mode definitions.

This is content parity, not a priority override. Codex loads [AGENTS.md by directory](https://learn.chatgpt.com/docs/agent-configuration/agents-md), while [skills load their full instructions when selected](https://learn.chatgpt.com/docs/build-skills). Other hosts control their own discovery and precedence. Explicitly select the appropriate installed skill when operating outside this repository; installing a plugin alone does not inject every skill body.

Maintainers edit the marked CLI block in `plugins/canvas-agent/references/cli.md`, then run `npm run context:sync`. Workflow blocks are generated from `src/workflows.ts` by the same sync command. `npm run context:check` and tests reject divergent copies. Keep host-specific manifests as discovery metadata, not a second manual command reference.
