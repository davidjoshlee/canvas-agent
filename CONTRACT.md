# Runtime contract

## Scope

Canvas Agent is a model-free local CLI. Canvas access is GET-only, configured-origin
bound and limited to explicit course IDs. It does not submit work, call model
providers, enforce academic policy or certify correctness.

## Files and credentials

- Paths, originals, guidance, student edits and completed artifacts are preserved.
- Credentials live in a configured process variable/private adjacent .env, never
  vault documents, task records, command arguments, logs or source fixtures.
- Filesystem operations reject traversal, unsafe links, stale evidence and
  ownership/account conflicts. Held locks require inspection, not automatic repair.
- Sync refreshes only hash-owned files; remote deletion does not delete local work.
- Private metadata stays outside reading-copy exports. Cloud delivery is external.

## Academic tasks

- An explicit course and period/prompt/mode determine the source snapshot.
- Tasks bind source bytes, guidance, requirements, workflow and destination.
- The coding host authors a separate candidate using saved evidence as untrusted
  reference text. Required readings and student contributions cannot be invented.
- Completion validates identity, structure, citations and unchanged bindings;
  it versions the output and never grades, approves or submits automatically.
  Multi-file completion may register a manifest-backed private immutable bundle
  with hashed file metadata and harness-reported executions/checks; those reports
  are not execution or correctness certification. Approval copies only deliverable
  files to a local Finals companion directory.
- Revisions preserve earlier artifacts and explicit edits; approval requires
  student direction and saves a versioned local Final.
- The coding harness owns reasoning, calculations, artifact creation and substantive
  review. New tasks do not execute arithmetic or generate workbooks. Older saved
  calculation records and workbook recipes retain compatibility readers.
- Existing persisted task recipes remain readable and authoritative. Removing
  an import command does not authorize rewriting old records or course files.

## Optional modules

- Guidance proposals remain inactive until explicit human review/activation.
- Feedback records and old captured learning context are untrusted observations,
  never authenticated instructor intent, current grades or course permission.
- Frozen simulation uses saved evidence and separate task IDs. The checkout-only
  evaluation harness supplies dogfood, experiment windows and human review reports;
  it is not shipped in the CLI. Saved records remain readable through their owning
  runtime or development commands. No claim of reconstructing historical access
  or verifying billing.
- Private external Git history is opt-in and local-only. Backup failure must not
  change the primary command outcome or silently repair/delete a held store.
- Reading copies are explicitly one-way. They are not another authoritative vault.

## Product boundaries

School layout migration, SQLite index reconciliation, historical run/playbook
imports and one-off host audit tooling are not maintained CLI features.
Read compatibility for existing saved snapshots and namespaces remains deliberate.
No development or cleanup command may touch a student's real vault or credentials.

## Maintainer checks

Keep domain implementations under src/<feature>, core command registration under
cli, and synthetic tests under matching test/<feature> directories. Optional
feature-owned command registrars may live with their implementation. The executable
entry remains src/cli.ts → dist/cli.js. No domain runs I/O at import time.
Update shared CLI instructions only in plugins/canvas-agent/references/cli.md
and workflows in src/tasks/authoring/workflows.ts, then run context:sync and context:check.
Build from a clean generated dist and verify both source tests and the installed
package. Do not package historical test reports or experiment tooling.
