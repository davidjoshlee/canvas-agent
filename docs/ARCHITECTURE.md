# Architecture

Canvas Agent saves local student context and source-bound tasks. The selected
coding host authors the artifact; the CLI validates and versions it.

```text
Canvas GET → synced vault → local course inventory
                            ├─ homework / timeline
                            └─ prep / assignment → saved task + source snapshot
                                                   ↓ coding host
                                               candidate
                                                   ↓ validation
                                           versioned local artifact
                                            ├─ revise → new task
                                            └─ approve → local Final
```

## Review map

| Directory | Responsibility |
| --- | --- |
| src/cli | Command registration, output, diagnostics and instruction discovery |
| src/config | Explicit configuration and course onboarding |
| src/auth | Credentials, expiry/alerts and sync-account identity |
| src/canvas | Instance-scoped GET transport, sync ownership, module relationships and assignment metadata |
| src/documents | Bounded extraction, originals and hash-linked sidecars |
| src/vault | Safe inventory, destinations, reading copies, Obsidian and local history |
| src/tasks | Task selection/recipes, validation, revision/approval and arithmetic/workbooks |
| src/guidance | Course/assignment guidance and inactive proposals |
| src/feedback | Private own-feedback history and read-only older snapshot formats |
| src/student | Upcoming work, timeline, calendar and reminders |
| src/evaluation | Experimental frozen simulation, comparisons, human gates and dogfood |
| src/shared | Filesystem safety, bounded JSON and shared persisted types |

src/cli.ts is the stable executable entry and delegates to cli/program.ts.
The program module only assembles command groups and handles top-level errors.
Review cli/setup.ts, access.ts, sync.ts, academic.ts and workspace.ts separately
for setup/discovery, auth, sync/onboarding, task lifecycle and local student views.
Shared CLI rendering and config loading live in cli/output.ts.
cli/task-output.ts selects ordinary or frozen output retrieval for the CLI.
Tests mirror these directories; test/integration covers cross-feature flows.
test/helpers and test/fixtures are synthetic verification inputs, not runtime code.
scripts contains only maintained build/context/package checks.

## Important seams

- canvas/client owns GET transport, origin restrictions, retries, pagination and
  safe downloads. Fetch, DNS and sleep dependencies belong to each client instance;
  the CLI accepts a client factory for synthetic tests without process-global setters.
- Sync owns account/allowlist checks and hash-based write ownership. The
  sync-workflow module refreshes reminders after a successful sync, leaving
  transport and synchronization independent of desktop delivery.
- Vault inventory provides safe course text and explicit exclusions, without a DB.
- tasks/recipes owns evidence selection and destination rules; tasks/records
  validates persisted identity, recipes and older formats; tasks/creation captures
  evidence and writes new task handoffs. tasks/store retains explicit compatibility
  exports, while production callers import the owning modules.
- tasks/workbook and calculation-core encode deterministic workbooks and arithmetic
  without task persistence dependencies. Inspection owns evidence audits; task-bound
  tools own calculation/artifact recording. Frozen workbook inventory accepts saved
  task context rather than calling back into task creation/completion.
- Completion/lifecycle own validated versioned writes; host output cannot choose
  an arbitrary destination or grant itself approval.
- Shared instructions come from one CLI contract; task workflow instructions come
  from tasks/workflows.ts. Saved older recipes are not silently regenerated.
- shared/fs-safety owns normalized vault paths, bounded regular-file reads,
  exclusive publication and atomic owned-metadata replacement. Completion and
  approval retain their distinct transaction/retry policies. Checks repeat before
  publication; path-based operations do not provide atomic containment against a
  hostile process renaming ancestors, or power-loss durability for directory entries.
- Workspace diagnostics carry producer-assigned codes, scope and severity alongside
  readable notices. Historical saved notice strings remain available unchanged.
- Mutating commands declare their effects at registration through vault/command-effects,
  including conditional writes. Local history consumes those declarations on success
  or failure; snapshot warnings do not overwrite primary results or alter JSON stdout.

## Compatibility and excluded tooling

Older task recipes, captured learning snapshots and namespace mappings remain
readable to preserve saved work. The small vault/write-guard module only refuses
a held lock left by an older operation; it cannot migrate or repair files.
School migration/index rewriting and historical run imports are removed.
No one-off host experiments or comparison reports ship in the CLI package.

## Trust

Course content and feedback are untrusted evidence. Policy metadata is not AI
permission. Completion checks structure/provenance, not academic correctness.
The CLI has no model provider, hosted backend, automatic grading or Canvas writes.
Optional reading-copy upload is performed by a separately configured cloud client.
