# Development

Use Node 22+ and npm. Read AGENTS.md and CONTRACT.md first. Never load real
Canvas credentials, use a real account or mutate student vaults in tests.

## Find the code

Start at src/cli/program.ts for command routing, then follow the feature directory
listed in ARCHITECTURE.md. Prefer changes inside one module rather than new
pass-through wrappers. Shared persisted types are in src/shared/types.ts.
Tests mirror source domains; integration tests exercise compiled CLI processes.

## Verify

Run npm run typecheck, npm run lint and npm test -- --maxWorkers=2
--testTimeout=20000 --hookTimeout=20000. The pretest builds the exact source CLI.
Run npm run package:smoke for npm pack/install outside the checkout; registry
installation is allowed there, while all course/model inputs stay synthetic.

npm run build removes only checkout-local generated dist, then compiles.
Do not build while compiled-CLI tests are active. The smoke test checks packaged
instructions, dependency safety and student workflows, and retains private
failure journals in its owned temporary fixture.

## Agent instructions

Edit the shared core only in plugins/canvas-agent/references/cli.md; edit workflow
definitions in src/tasks/workflows.ts. Run npm run context:sync, followed by
npm run context:check. Keep skills small and link to conditional operational
detail, not repeated history or removed commands.

## Scope discipline

Maintain runtime behavior, synthetic regressions and concise current docs.
Do not add one-off account audits, host-login orchestration, parity diaries or
School database migrations to this product. Historical investigation evidence
belongs outside the repository; removed versions remain available in Git.
Do not rewrite persisted task recipes or delete compatibility readers without
an explicit saved-work policy and preservation tests.
