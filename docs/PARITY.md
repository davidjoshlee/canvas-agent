# Student workflow parity

Canvas Agent keeps School Agent's student-facing workflow while moving content generation into the user's chosen coding agent. It is not a drop-in replacement for School Agent's provider runtime or database.

Full parity is not yet verified. Command presence and green unit tests do not
establish equivalent source coverage or successful use with an existing School
Agent vault.

See [the current completion audit](PARITY-COMPLETION-AUDIT.md) for pinned public
and local baselines, active gaps and acceptance/release evidence. Historical
increment counts below are not substitutes for the current requirement audit.

## Optional local Git history gap — 2026-10-14

The pinned public School VaultWriter/LocalVaultGit sources and vault regression
confirm optional local commits after changed writes, with unchanged retries
remaining at the same commit count. New School setup writes `gitInit: false`;
the older schema default is `true` if that field is omitted. Canvas does not
silently inherit either School config or a pre-existing vault `.git`.

Canvas now offers explicit `vault history enable --directory ABS_NEW_PRIVATE_STORE`
and bounded metadata list/show, changed-only snapshots, separate non-overwriting
binary/text export, disable and same-store re-enable. Its private bare Git store
lives outside the vault; existing student Git/config/hooks stay untouched. Git
processes have scrubbed environment/global config, fixed local config and disabled
hooks, no remote operation or destructive checkout. Opted-in mutating commands
capture success or retained partial writes after failure without changing the
primary command result. Default-off, config-free discovery and read-only commands
do not capture editor changes; use explicit snapshot for those.

Eight focused synthetic source/compiled tests cover stable retries, old/deleted
binary/text recovery, retention, foreign stores, credential/link/bounds refusal,
hook/alternates/config/lock rejection, poisoned inherited Git variables, actual
partial ingest failure and config-free discovery. This implements local recovery
value, not School Git adoption, arbitrary-size corpus support, live-user consent,
universal secret detection, authenticated timestamps or mid-import interruption
acceptance. Limits and private-history implications are explicit in the CLI
reference. Current full-suite/installed gates are tracked in the completion audit.

## Migration regressions being closed

Expanded actual-School preservation evidence finds two separate-product bugs:
revision approval overwrites the prior Final, and rerunning prep discards a
hand edit in its prior auto-final brief. Thirteen synthetic processes/five
confirmed checkpoint kills verify completed prep/revision recovery and isolate
the losses to follow-up commands, not process death. This source audit uses
keyless fixed mock generation and actual CLI approval, not a real provider or
goal-controller test. School revision reuses its run ID/message history, while
Canvas revision creates an explicit child task; neither implies format/runtime
interchangeability. Canvas compiled regressions now exercise the equivalent
multi-command cases and preserve edited prep, original task/draft and both
approved Finals. Do not reproduce School's destructive behavior for parity or
silently modify its separate source; owner direction is needed for that fix.

Forward guidance acceptance now uses a fresh Luna host and invented syllabus,
two memo prompts, existing prep guide and two current own-feedback values.
The retained candidate preserves prep/graded distinctions and prior bytes on
versioned retry. The host exposed missing proposal discovery; read-only guidance
list/show now recover original private IDs/handoffs, with bounded metadata-only
output, incomplete records and missing handoffs rather than history repair.
A second fresh host discovered the original ID via CLI and recovered the saved
context/outputs without writing. This is lost-context/fresh-process evidence,
not `/goal` controller recovery, native plugin delivery or real student grading.

School's proposal writer requires parse-back structure, whereas Canvas previously
accepted cited prose without a usable prep declaration. New
proposalStructureVersion 1 closes that gate with the same prep parser: one safe,
substantive declaration, not missing/empty/Sources-only/duplicate/fenced examples.
Old unflagged proposals retain their save behavior. A compiled synthetic flow
saves proposed guidance, proves it remains inactive, explicitly copies it into
an owned test fixture's active guide, then creates/completes correctly scoped
prep with the declared headings and question. Older task bytes, existing active
guide and proposed candidate are preserved. This is structural flow acceptance,
not a real model-authored proposal, student activation, grade or `/goal` test.

Current-source Luna audits found Canvas already exceeds the School baseline in
selected-active-course onboarding, overdue/undated homework, vault health,
reading-copy policy/resource guards, outline/review modes, ordinary comparisons
and paired spreadsheet Final preservation. School's stale-expiry verify refusal,
Keychain/doctor mismatch and opt-in destructive pilot refresh are not behavior
to reproduce. These are source audits, not new School runtime reproductions.
The intentional external-host/provider boundary remains unchanged.

One actual Canvas gap was proposal inputs: School uses recent assignments and
past feedback, while Canvas was syllabus/common-guidance only. New versioned
proposalContextVersion 1 captures up to five readable date-ranked prompts in
addition to at most 12 syllabi, with unchanged aggregate bounds and common-guide
scoping. Save revalidates selection and snapshots; old proposals remain
syllabus-only. Tests exclude private feedback, summary/student/other-course and
restricted material, preserve active guidance/old recipes, permit unselected
edits, reject selected/new-selection/policy changes and exercise compiled CLI.
The subsequent proposalFeedbackVersion 1 separately snapshots up to five current
own-feedback values in private learningHistory, with exact optional assignment
scope, archive/current-value checks and unchanged-refresh tolerance. No older
values or legacy playbooks are silently imported. New prepStructureVersion 1
adds School-style plain/comma section declarations for ordinary/frozen prep,
without retroactively changing saved unflagged parser semantics. Synthetic
regressions cover these additions; full parity still requires acceptance/release
gates, not merely implemented flags or passing tests.

Post-increment gates: 662 tests/88 files, typecheck/lint/build/context and
whitespace checks pass; isolated package smoke passes 86 commands. New feedback
scope has compiled-checkout CLI coverage, not a separately feedback-filled
installed-package/real-host acceptance run. No School source or real student
vault was changed, and no publication occurred.

Native turn capture exposed 8000-character selected-skill truncation in Codex
0.162.1, reproduced even with a 200000-token mock context declaration. The old
assignment skill lost part of the CLI contract and its outcomes. Compact shared
entrypoints now deliver the complete file: core capped at 5000 bytes, skills at
7500, AGENTS at 24 KiB. Explicit outcomes/default headings remain equally embedded
from workflows.ts; full default instructions are generated into workflows.md.
Saved workflow versions and extended CLI details remain intact. Native captures
of three selected skills plus project AGENTS pass with no setting override,
account/credential, tool execution or real model. This proves context delivery,
not semantic adherence, desktop/other-client activation, a student's combined
parent/global context or `/goal`. Independent post-compaction hosts are audited
separately rather than inferred from fixed mock acknowledgements.

Two post-compaction Luna hosts completed existing ordinary/frozen fixture tasks,
respecting full saved workflows and preserving originals. Prep initially omitted
execution of the 200-unit comparison, then used the diagnostic and executed it;
the twelve actual log operations are retained without erasing duplicates. Frozen
drafting corrected reported citation formatting before completion. Parent checks
of final artifacts/logs and 7/8-file baselines preserved all originals except the
normal ordinary task status change. host-compact fixtures and fresh-process
replays verify the final artifacts/retries and input-only 200 before the second
batch; initial candidates/check output are not retained. These are observed
corrections, not universal first-pass compliance or installed-native generation.
Verification: 647 tests/85 files, typecheck/lint/build/context, three validators
and 86 installed-package command checks pass; native four-turn mock delivery
passes separately. Full parity is still not established by these scoped gates.

Native fresh plugin installation/discovery now has direct runtime evidence on
Codex CLI 0.162.1. `scripts/audit-codex-plugin.mjs` copies only the local marketplace
and plugin into an owned temporary fixture, invokes actual marketplace/plugin
installation with a child-only isolated home/cache, then calls app-server's native
skills/list in an unrelated workspace. All three namespaced skills are enabled
and loaded from that new installed cache; full skill/reference bytes match source.
Real settings/cache, auth, student vaults and model turns are unused. This narrows
the portability gap; full turn-level skill/project-AGENTS injection, desktop
refresh, other coding hosts and combined installed-host task acceptance remain
unverified. It does not retroactively prove the preceding manually loaded Luna
tests were native plugin sessions or validate `/goal` interruption.

Two fresh Luna coding hosts now exercised the current numeric-review instructions
on separate synthetic ordinary-prep and frozen-draft installations. They received
course/config scope, not UUIDs, prior candidates or answers, and recovered the
existing tasks without replacement. Both read the source AGENTS/skill manually,
read saved policy/materials, executed arithmetic, ran check-numbers before saving
and kept missing evidence explicit. Prep executed all six used derived values,
including the previously missed 200-unit comparison; the custom-shaped frozen
draft executed all five used derived values. The parent inspected both actual
candidates and batches, not only host completion claims. Across the 7/8-file
baselines, only the ordinary task record changed legitimately; frozen originals,
capture and immutable recipe stayed byte-identical. Frozen completion retry kept
the same hashes and pending-human verdict. One unsupported read-only --course
option on frozen task show was corrected, not counted as an initial success.

Actual outputs/batches are retained in `test/fixtures/host-forward`; fresh compiled
replays validate numeric findings, source/custom-shape gates and unchanged retry
bytes. `scripts/create-host-acceptance.mjs` prepares isolated reusable fixtures.
Current gates pass 643 tests across 85 files, typecheck/lint/build/context checks.
These two observed forward passes narrow the host-adherence gap but do not prove
universal compliance, semantic arithmetic grounding, academic grading, fresh
installed-plugin activation/native injection or actual `/goal` interruption.
Prior host failures remain retained; no historical output/log was repaired into
a pass. Broader new-student/source-corpus and controller acceptance remain open.

School recovery evidence now includes actual SIGKILL of three live synthetic
workers at durable checkpoints and the run store's pre-rename replacement
boundary, not only fresh objects in one process. The
read-only-checkout `scripts/audit-school-recovery.mjs` resumes a parked run through
a fresh School runner with the original ID/message prefix, then exercises full
School CLI local approval and retry of a completed draft in fresh processes.
Original draft/run, deliverable edits and repeated Final bytes remain intact;
the old record survives the staged replacement, and denied fetch is unused.
School intentionally strips its correctness-review section from Finals while
retaining it in the draft; this is not native-document interchangeability.
This narrows the School recovery gap; full prep/revise/provider workflows,
other mid-write boundaries, installed releases and actual `/goal` controller recovery
remain open. Neither product relies on the other's chat or default vault path.

Ordinary and frozen `check-numbers` now provide a bounded, read-only presence
diagnostic before quantitative handoff. Retained independent host failures flag
the previously unexecuted 200-unit prose comparison. Equal source literals or
recorded results may be unrelated, so the report never authenticates execution,
grounding or correctness and does not gate completion or grade work. Resource
limits precede concatenation/masking; exact backticked source references are
masked in one pass. Verification: 641 tests/84 files and 86 installed-package
checks, with typecheck/lint/build/context checks passing. A deterministic replay
is not independent model adherence to these new instructions.

New frozen windows now support explicit
`simulate window resume UUID --course CODE --json` for versioned partial journals.
New create/resume writers persist `planningVersion: 1`, use exclusive inode-bound
locks, check ownership before task/capture/history/journal writes, and archive
prior journal bytes by hash before replacement. Existing recipes, completed
outputs, capture IDs and recorded failures stay intact; only missing slots are
created, and planned retries are read-only. Legacy incomplete ownership and held
or replaced locks stop without adoption/removal. A controlled real planner
interruption followed by a fresh compiled CLI verifies preserved completed-prefix
bytes, archived partial journal bytes, frozen-only selection after live edits,
unchanged retries and pending-human verdicts. Additional tests preserve failure
slots, reject changed recipes before new handoffs and refuse foreign lock cleanup.
Luna's read-only review found a history-write ownership-check gap; checks now
cover that side effect too. Unbound artifacts from interrupted writes are retained,
not guessed into the plan. This is explicit partial-plan continuation, not a
general corrupt-history/legacy adoption command, actual SIGKILL lock recovery,
installed host-plugin activation or goal-controller acceptance.
Verification: 636 tests across 83 files, typecheck, lint, build, context and skill
checks pass. Installed-package smoke passes 84 command checks with
`partialWindowResumeTested: true`, exact preserved prefix bytes, archived partial
journal bytes and unchanged planned retry bytes. The package fixture seeds the
interruption through the installed module, then exercises CLI continuation; no
live account, model or academic human verdict is involved.

Independent lost-ID recovery now has observed ordinary and frozen Luna host
evidence, not only deterministic backend replay: each fresh context received its
config/course/week but no UUIDs, found the existing task and completed it without
replacement IDs. A pre/post 22-file audit preserved prior work and all source/
capture/frozen recipe bytes; only the ordinary pending record changed as normal
completion requires. Artifacts are retained in `test/fixtures/host-recovery`.
Both outputs still omit execution for a 200-unit prose comparison; academic/
quantitative acceptance remains partial. The reported frozen operation-name retry
prompted a narrow usability fix: ordinary/frozen help now lists supported names
and a runnable batch shape, backed by one operation registry also used by frozen
record validation. Tests exercise all names and both help examples. Do not count
this recovery evidence as an installed-plugin or goal-controller interruption
test, or retroactively claim all numbers in the artifacts were verified.
Verification: 631 tests across 83 files, typecheck, lint, build and context checks
pass. Installed-package smoke passes 82 command checks, including both calculator
help examples. The independently executed recovery attempts are retained as
preservation passes and quantitative partial results, not full parity acceptance.

Standalone frozen recipe discovery now exists as
`simulate task list --course CODE --json`. It reuses authoritative recipe
rederivation against frozen capture/parent bindings, filters the saved course code
without current course folders and omits source/guidance/workflow/inquiry bodies.
Results are immutable recipe IDs and selection metadata, not completion status.
A fresh-process regression moves the live course folder and deliberately changes
a completed output: recipe discovery succeeds, while selected task show refuses
that output. Ordinary task IDs and another course's frozen IDs stay out. Invalid/
linked/oversized/substituted recipes or broken capture bindings make inventory
incomplete without echo or repair. Limits are 5000 entries, 20 MB per recipe and
100 MB total reads including repeated capture/parent validation. Existing ordinary
single-record reader calls retain their prior behavior; no saved recipe or workflow
is rewritten.
Incomplete-window continuation and actual host-controller/installed-plugin
acceptance remain open.
Verification: 629 tests across 83 files, typecheck, lint, build, context and skill
checks pass. Installed-package smoke passes 80 command checks with
`savedFrozenTaskDiscoveryTested: true`, exact derived-capture ID association,
course isolation, absent output-status/body fields and unchanged recipe bytes.

Saved frozen window discovery now exists as
`simulate window list --course CODE --json`. It validates journal schema/hash/
UUID, real range and prefix cutoff ordering, recorded phase consistency, unique
task IDs and the 250-handoff bound. Results contain only window/parent IDs,
creation time, range, recorded phase and cutoff/handoff counts. It does not read
current course folders or verify captures, task recipes, outputs or completion;
selected window show is mandatory before continuing. A regression with a moved
live course folder and unavailable original capture demonstrates this distinction:
listing succeeds while show refuses the broken binding. Building journals remain
building, not inferred running/completed. Malformed/linked/oversized/rehashed
invalid-date records make the inventory incomplete without echo or repair.
Discovery bounds are 5000 entries, 4 MB per journal and 100 MB total reads.
Standalone frozen task discovery, explicit incomplete-window recovery and host
goal-controller acceptance remain open.
Verification: 626 tests across 82 files, typecheck, lint, build, context and
skill checks pass. Installed-package smoke passes 78 command checks with
`savedWindowDiscoveryTested: true`, exact selected IDs, course isolation and
unchanged journal bytes. It does not prove installed-host plugin activation,
incomplete-plan continuation or academic completion.

Frozen capture discovery now exists as `simulate list --course CODE --json`.
It uses the existing immutable capture reader and validates derived-parent
bindings before returning original/derived metadata, omitting source/guidance
bodies and excluded paths. It filters the explicitly saved course code without
looking up current course folders, so fresh-process recovery still works after
those folders become unavailable. Invalid/linked/oversized/identity-substituted
records and broken parents yield an incomplete inventory without echo or repair.
Bounds are 5000 entries, 20 MiB per capture and 100 MB total reads, including
repeated parent reads; total-budget overflow stops. Backend and compiled tests
verify course isolation, preserved frozen bytes and absent live-course folders.
Evaluation task/window discovery and actual host goal-controller recovery remain
separate open gates.
Verification: 623 tests across 82 files, typecheck, lint, build, context and
skill checks pass. Installed-package smoke passes 76 command checks with
`savedCaptureDiscoveryTested: true`, exact original/derived IDs, course isolation
and unchanged capture bytes. The current run does not test installed-host plugin
activation or recover all frozen evaluation namespaces.

Saved multi-session sweep discovery now exists as
`dogfood sweep list --course COURSE --json`. It validates immutable manifest
schema/hash/UUID, filters exact saved course code/root and returns only IDs,
creation time, session count and reserved child run IDs. It never reads child
checkpoint bodies, initializes/resumes work, changes locks, syncs, generates,
assigns verdicts or approves. Unreadable records make the inventory incomplete
with unknown course scope; bounds are 5000 entries, 1 MB per manifest and 100 MB
aggregate. Backend and fresh compiled-process tests cover empty inventories,
cross-course isolation, both course-option positions, held-lock preservation,
child-body omission, malformed/linked/oversized/substituted manifests, explicit
course requirements and unchanged original bytes. This closes sweep-ID recovery,
not frozen capture/window discovery or actual host goal-controller acceptance.
Verification: 620 tests across 81 files, typecheck, lint, build, context and
skill checks pass. Installed-package smoke passes 74 command checks with
`savedSweepDiscoveryTested: true`, unchanged manifest bytes and another-course
omission. All inputs are synthetic; the test imports installed sweep creation
before exercising listing and does not claim a full installed sweep-generation
or human-verdict flow.

Separate-product setup auditing found that both Canvas's backend and command
wrapper defaulted new installations to School's `~/school-vault`. Canvas now
defaults new setup to `~/canvas-vault`, with the backend owning that default.
Existing configs remain unchanged, and explicit shared-vault selection remains
available through the preservation workflow. Regression tests check both setup
entrypoints against a synthetic preexisting School vault and verify original
bytes plus an existing explicit config are preserved. Installed-package smoke
also checks the omitted-`--vault` path under an isolated synthetic home. This is
default separation, not migration of an existing user's files or config.
Verification: 618 tests across 81 files, typecheck, lint, build, context checks
and all three skill validations pass. The installed package passes 72 synthetic
command checks with `separateDefaultVaultTested: true`; installed instructions
match the checkout. No real home/vault or School source files were changed.

Latest independent prep forward-testing now covers the compact source skill and
all reported derived values. A fresh Luna host produced a finished multi-reading
brief with executed intermediate, final and prose-comparison results; its actual
artifact and six recorded operations are retained as replay fixtures. The first
two partial attempts remain documented in ACCEPTANCE.md rather than relabeled
passes. A new process-interruption regression also SIGKILLs the compiled task
writer between saved recipe and brief, then discovers and completes that exact
recipe from a fresh CLI without rebuilding the brief or changing protected
records. Neither proves School's complete runtime or Codex goal-controller
recovery. Full parity and release acceptance remain open.
Verification for this increment: 617 tests across 81 files, typecheck, lint,
build and context checks pass. The actual-source coexistence audit was rerun
successfully in all three writer orders (27 Canvas CLI processes and six School
writer processes); source hashes match the earlier recorded baseline. This is
scoped synthetic writer/recovery evidence, not full School CLI or installed
plugin acceptance.

Agent-context size auditing found a real portability defect: AGENTS.md was 91949
bytes and the three skills were 84899–92538 bytes, above Codex's documented
default 32 KiB combined project-instruction limit. Their matched content alone
could not prove successful injection. The identical shared core is now about
10 KiB with normal commands, source/policy safeguards, recovery, academic
handoffs and routes to advanced topics; all default academic outcomes remain
embedded. The previous detailed contract was retained byte-for-byte outside the
shared block in the canonical CLI reference, not deleted or put into private
runtime recipes. Complete entrypoints are now 13125–20680 bytes (AGENTS 20091).
The context generator rejects cores above 12 KiB and entrypoints above 24 KiB
before any repair writes. Regression tests reject oversized core/wrapper inputs
without partial mutation and prove detailed reference bodies are not copied;
packaging checks the full installed entrypoints too. This uses skill-creator's
progressive disclosure while preserving equally shared CLI instructions and
explicit prep/draft/review outcomes. Verification: 615 tests, typecheck, lint,
context and skill validation pass. Combined global/parent instructions and actual
fresh host-plugin activation still need observation; no user settings/cache were
changed, and file-size checks are not a host-behavior or academic-quality verdict.

The primary host has now exercised local-edit revision and explicit synthetic
approval with the current numeric-scope/custom-format recipe. It read the prior
output, edited snapshot, versioned diff and feedback, re-executed the five
calculations, then authored the full revised response incorporating the supplied
demand-evidence condition as a preference rather than new factual evidence or
policy. V2 draft and local Final Markdown/spreadsheet bytes matched; original
draft, companion, edit and parent-record hashes stayed unchanged. The retained
artifacts replay through fresh processes with lineage/diff/input capture,
revision reuse, paired output copies, current provenance and byte-stable
completion/approval retries. This is an explicit local fixture operation, not
real student/instructor approval, academic grading or Canvas submission.
Verification: 612 tests, typecheck, lint and context checks pass; wider
class/host/controller acceptance remains open.

Current primary-host prep acceptance now combines the invented launch case with
a second marginal-analysis reading and three posted preparation questions. The
host read the actual weekly handoff, re-executed five scenario computations and
authored a finished reading synthesis, concepts, answered questions and discussion
points with explicit evidence gaps. Assignment-bound format guidance stays out;
common fixture permission remains. The retained brief replays through fresh
compiled processes with exact source/question capture, next-week and assignment-
preference isolation, rejected omitted-question completion, current provenance,
unchanged originals and stable retry bytes. It is neither a plan nor reading
pointers, but a primary-host artifact; no test independently grades its quality
or proves complete real-class/cross-host coverage. Verification: 611 tests,
typecheck, lint and context checks pass; broader acceptance remains open.

Primary-host acceptance now also covers a current scoped review task with supplied
flawed work. After reading the actual saved handoff and explicit synthetic review
permission, the host executed the work's written expression ($1000, not its $3100
claim) and the correct incremental-cost expression ($4000), then authored a
separate requirement-by-requirement critique. It distinguishes arithmetic and
sunk-cost classification from unsupported observed-demand, zero-effect and
approval assertions; missing evidence is not manufactured or treated as proof of
what an instructor said elsewhere. The retained review and original flawed work
replay through fresh compiled processes with exact Part 2 scope, review-mode
headings, executed values, distinct output, current provenance, unchanged source
and retry bytes, and rejected local approval. No replacement draft, automatic
spreadsheet, academic grade or instructor verdict is created. Verification: 610
tests, typecheck, lint and context checks pass. This is one primary-host synthetic
review plus deterministic replay, not independent grading or proof that every
host will catch every substantive error.

The primary host now exercised a fresh numeric-Part-2 assignment end to end with
the current parser/scope/guidance/format recipes, not adapted older candidate
headings. Invented ECON901 materials explicitly permit AI drafting; the host read
ordinary and frozen JSON handoffs, executed five source-context calculations,
authored a finished conditional launch decision and self-reviewed its inputs,
requirements, sunk-cost treatment and uncertainty. Both modes saved the retained
candidate and automatic spreadsheet; the frozen verdict stayed pending-human.
`test/fixtures/host-numeric` retains the raw synthetic sources, operations object,
candidate and observed first-attempt limitations. Regression replays verify exact
Part 2 scope/two items, custom headings, results 30000/18000/20/4000/400, workbook
values, original bytes, unchanged completion retries and frozen isolation after
new live source edits. This adds meaningful current-recipe host evidence, not
independent grading, real policy/source completeness, installed-host activation
or a goal-controller interruption test. Verification: 609 tests, typecheck, lint
and context checks pass; broad real-class/host acceptance remains open.

Active onboarding now handles a narrower discovery-permission gap too: when the
student's active-enrollment list succeeds but general course discovery returns
403/404, it verifies a bounded API self profile and selects only those known
active IDs. Explicit --course still excludes other active courses; --all-active
remains a separate deliberate choice. Missing/denied active-enrollment evidence,
401, malformed general responses or invalid profiles stop before selection is
saved; no guessed IDs, direct-resource enrollment inference or pilot relaxation.
The warning names the fallback and its source-coverage/academic-permission limits.
Six new regressions cover these conditions and config retention, including
unknown-course rejection. A fresh compiled CLI on a local synthetic server now
onboards from an empty allowlist and syncs just the selected course despite list
403. Verification: 607 tests, typecheck, lint and context checks pass. Complete
institution source access and a real new student's onboarding remain unverified.

Targeted sync no longer depends on readable course discovery when an exact
allowlisted ID is already known. Backend discovery HTTP 403/404 becomes an
explicit coverage notice and triggers identity-checked lookups of selected IDs
only; API profile/subject checks still precede course access. CLI numeric selection
avoids an unnecessary second discovery call. When a code/name needs resolution
and discovery is unavailable, only safe local course identities already in the
allowlist are candidates; ambiguous, unsafe, missing or unselected identities
stop. Stored selection is never rewritten. Discovery 401, malformed responses,
unsafe pagination and other failures do not use this fallback. Backend/CLI
regressions cover 403/404 versus 401/schema failures, unavailable individual
courses, unchanged config/student edits and absence of off-scope requests or
response-body leakage. A fresh compiled CLI against a local synthetic HTTP server
verifies positive API auth with forbidden discovery, exact ID and mapped code
sync, and later 401 stop. Verification: 601 tests, typecheck, lint and shared-context
checks pass. This does not certify a real institution's source coverage or live
account, and it does not automatically onboard unknown courses.

Saved dogfood runs are now discoverable through `dogfood list --course COURSE`.
The read-only view validates checkpoint hashes, sequence and identity, then emits
only selected-course ID/period/assignment and last recorded flow status/count.
Evidence, next-step text and data remain out of the listing. A lock is neither
deleted nor interpreted as a live worker; discovery never resumes flows, syncs,
approves or assigns human verdicts. Malformed/linked journals make inventory
incomplete with unknown course scope; 5000-entry/100 MB bounds stop excess scans.
Tests preserve journal/lock bytes, isolate another course and private sentinel
data, report corrupt records and exercise both inherited course-flag placements
through fresh compiled processes. Installed-package discovery also passes.
Verification: 595 tests, typecheck, lint and synchronized context pass; package
smoke now runs 71 commands. Sweep/window/frozen discovery and actual goal-controller
interruption acceptance remain separate, unverified surfaces.

An interrupted ordinary-task creation could save task.json before TASK.md and
leave even JSON show unusable. A fresh-process regression reproduced that failure.
JSON show now returns the validated original recipe with `briefStatus: missing`
and no taskFile; text show explains how to read it. Neither recreates the brief or
changes the record, ID, source snapshots or workflow. Completion uses that same
ID/recipe and leaves the absent brief absent. Linked/nonregular briefs and invalid
records remain errors rather than silently falling back. The installed package
also exercises this interrupted-write-shaped state with the prior brief retained
outside the synthetic vault. Verification: 593 tests pass, with typecheck, lint
and synchronized context. This tests a missing-file state and fresh-process
recovery, not process termination at every write boundary or an actual goal pause.

Host recovery no longer requires remembering an ordinary task UUID. `task list`
requires one explicit course and returns validated saved-recipe metadata, with an
optional pending/completed filter. It exposes neither captured bodies nor workflow
instructions, does not create duplicate tasks and keeps old records unchanged.
Malformed, linked or oversized records produce an incomplete-inventory count of
unknown course scope; excessive aggregate inventory stops. Context's lightweight
pending scan is also bounded and warns on unreadable records rather than silently
presenting a complete list. Fresh-process tests cover missing-ID discovery,
course/body isolation, retained bytes, completed status with changed live sources
and malformed/linked/oversized records. This is discovery, not automatic job
resumption or output/currentness/approval verification. Read the selected task and
inspect it before continuing; frozen evaluations and dogfood retain their separate
IDs/journals. The shared recovery instructions are synchronized across AGENTS and
all three skills. Verification: 592 tests, typecheck, lint and shared-context checks
pass; installed-package smoke now includes task discovery/status filtering.

Separate-product recovery now has a cross-process coexistence check. The audit
creates Canvas tasks through the compiled CLI in three synthetic shared-vault
orders, then starts a separate process running School's actual VaultWriter with
its own source implementation. A new Canvas process rereads the pending task and
unchanged handoff, completes it and approves locally; further fresh processes
inspect and retry completion/approval without changing task, brief, draft or Final
bytes. Later School refreshes and student-owned edits leave those artifacts
readable and unchanged. This proves selected on-disk recovery and independent
writer preservation, not survival of an interrupted write, full School CLI/model
runs, installed plugin activation or the Codex `/goal` controller. Those broader
acceptance gates remain open; the tools stay separate products.

Word-source differential testing exposed dropped tab-separated question markers.
DOCX extraction now uses the same Mammoth 1.12.1 raw-text reader as School, retaining
tabs and paragraph boundaries. Before parsing, all ZIP members are streamed under
entry/aggregate bounds into a validated in-memory archive; XML declarations and
excessive structure stop, and only a buffer (no filesystem path) reaches the reader.
Synthetic fixtures were corrected to proper Word namespaces, not supported through
a weaker fallback. Existing originals/sidecars/task snapshots stay unchanged.
The extractor comparison now matches the added DOCX tab case too.

The initial reader install exposed three moderate dependency findings through
`argparse`/`sprintf-js`. Mammoth now uses an explicit argparse 2.0.1 override,
removing the vulnerable formatter without downgrading the Word reader. A clean
tarball install proved that a root override plus shrinkwrap alone was insufficient:
npm resolved the old chain when Canvas Agent was installed as a dependency.
The package therefore bundles Mammoth's verified dependency tree and retains a
publishable shrinkwrap. Packaging and regression tests reject lockfile drift.
Installed checks verify the actual argparse version, absence of sprintf-js,
Mammoth's help command and Word ingestion; installed production audit reports
zero findings. This resolves the observed dependency chain, not all security,
platform or academic-quality risks. Work remains local testing, not publication.
Verification: 589 tests, typecheck, lint and shared-context checks pass. Eleven
source-only extraction cases now match, including Word tab/paragraph text; the
installed package also retains tab-separated Word context and original bytes.
The installed package exercises 67 synthetic CLI commands. Full parity and live
host-plugin/controller recovery remain unverified, not inferred from audit results.

HTML extraction now preserves headings, ordered/nested lists, emphasis, links and
code indentation using the same pinned Turndown 7.2.4 converter as the reference
School checkout. Active-content elements and unsafe URL targets are excluded;
conversion does not fetch referenced resources or expand task authority. Inputs
above 5 MB or 100,000 markup delimiters stop before DOM conversion. Originals and
existing/student-edited sidecars stay unchanged on ingestion retry. A synthetic
HTML-to-assignment regression verifies numbered imperative items enter the saved
checklist and missing answers fail completion. The source differential matches
ten cases, including rich structure and nested/code formatting. Arbitrary HTML,
tables/images, DOCX differential and live-corpus coverage remain unverified.
Verification: 586 tests, typecheck, lint and shared-context checks pass; ten
synthetic extraction cases match the current School source. The installed-package
smoke also exercises structured HTML ingestion with original bytes retained.
No real course/account or installed-host plugin was used, and full parity remains
unproven rather than inferred from these scoped checks.

Named spreadsheet tab context is now retained through bounded workbook metadata
and relationship-ID resolution, rather than pairing names with sorted filenames.
Declared tab order and worksheet bytes stay associated, including reordered paths
and XML-escaped names. Missing relationship evidence leaves a separately labeled
unmapped-name inventory plus generic worksheet data; it never guesses the pair.
External/unsafe/missing/duplicate worksheet targets stop extraction with a generic
notice, without returning target contents. Metadata-only tab names cannot count
as readable cell data. Existing originals and saved source/task snapshots are not
rewritten. The source differential now matches eight cases, including two named
tab cases with aligned metadata/file order; reordered correctness is tested against
explicit relationships, not School's positional name heuristic. Basic extraction
still does not execute formulas/macros or reconstruct charts, styles or grading.
Verification: 584 tests, typecheck, lint and shared-context checks pass. The
source-only extraction differential passes eight cases. Installed ingestion also
retains a named worksheet's context and exact original bytes; real-course corpus,
complex spreadsheet and installed-host-plugin acceptance remain unverified.

The mixed-format source comparison found missing MIME dispatch for extensionless
Office files and unexplained legacy binary files. Extraction now recognizes
DOCX/PPTX/XLSX MIME metadata and returns explicit conversion/supplied-text notices
for legacy XLS or binary Office containers, without claiming file persistence
from the pure extractor. A mocked GET-only Canvas sync carries an extensionless
slide deck into original-hash-bound assignment context while retaining bytes.
`scripts/audit-school-extraction.mjs` compares six synthetic cases against the
actual School extractor: PPTX/XLSX extension and MIME paths, legacy XLS and raw
unknown files match exact text/degradation presence. It prints hashes/case names,
never bodies, and reads no config/index/account/vault. DOCX differential, named
spreadsheet tabs, rich HTML structure and complex-format acceptance remain open;
the current XLSX renderer still loses School's named-tab context.
Verification: 583 tests, typecheck, lint and shared-context checks pass. The
source-only extractor comparison passes six cases; it does not certify DOCX,
named-tab mapping, rich HTML, OCR or whole-corpus extraction parity.

Mixed-file auditing found that local `ingest` did not honor preservation mode and
discarded unsafe-mapping notices. New ingestion now uses the selected course's
persistent `Canvas Agent/Canvas/Files` namespace and refuses damaged/unsafe mapping
fallbacks. Known credential/config filenames and the CLI's selected config/auth
files (including custom names) stop before source-file access. This is not a
comprehensive secret audit. A Word-file regression exercises retained originals,
old sidecars/task records, linked-path refusal, namespaced provenance, compiled
retry and fresh prep selection; another proves failed preflight preserves mapping
and config bytes without copying/printing their contents. Earlier files and
historical snapshots are not migrated or rewritten. PDF/Office support remains
bounded/basic extraction, not OCR or proof of academic completeness.
Verification: 581 tests and 65 isolated installed-package commands pass. The
installed binary ingests a synthetic Word file into the preservation namespace,
retains original/sidecar bytes on retry, exposes its sidecar to fresh prep and
rejects the selected config as ingestion input. Typecheck, lint, synchronized
shared context and all three skill validators pass. Real account/vault, complex
document/OCR and installed-host-plugin acceptance remain unverified.

The primary host has now exercised finished course-guidance authoring through the
current compiled external-checkout CLI: it read the actual source-bound handoff,
authored the retained `host-v3/guidance-candidate.md`, saved a versioned proposal
and confirmed active guidance stayed unchanged. The replay verifies syllabus and
common-guide snapshots, unrelated restricted assignment exclusion, two versioned
saves, inactive context and exact original/candidate bytes. Explicit fixture AI
permission and unknown grading/attendance/exam policies stay distinct; assignment
scope is not replaced by prep format. This is one primary-host scenario, not an
independent human verdict, policy authentication or activation. Student review,
broader policy cases and live/installed-plugin acceptance remain unverified.
Current verification passes 579 tests across 78 files, typecheck, lint and shared
context checks. The retained proposal is byte-identical to the primary-host
exercise; replay remains mechanical evidence, not a new model run or human grade.

Fresh ordinary and frozen tasks now pin `deliverableParserVersion: 3`, adding
explicit numeric multipart boundaries without changing saved parser-v2/default
recipes. Positive Part labels (up to ten digits) are recognized in standalone
plain/Markdown/HTML headings or inline colon-labeled sections, including due-date
scaffolding. A uniquely requested part scopes the checklist; prose references do
not create boundaries, duplicates/missing matches stop, and multiple requested
parts remain unnarrowed. Tests verify ordinary/frozen completion, later-live-text
isolation, HTML list boundaries and exact saved-v2 unscoped-record preservation.
No instructor permission, group contribution or complete prompt coverage is
inferred, and no historical source/task bytes are upgraded. Numeric shapes outside
these explicit boundaries still require source/scope review.
Verification: 578 tests and 61 isolated installed-package commands pass, including
numeric part selection and a structurally completed outline with explicit missing
inputs. The first expanded smoke attempt exposed a missing synthetic fixture
directory; after correcting that setup, the installed-binary rerun passed.
Typecheck, lint, shared context, skill validation and the eight-case legacy School
parser differential also pass. These are not live-account or academic-quality
verdicts; full parity and broader host acceptance remain unproven.

Draft continuity across refreshed prompt paths is now explicit. In preserved
courses, `homework.relatedDrafts` exposes completed saved tasks with the same
numeric Canvas assignment ID but a different prompt path, retaining task IDs and
original prompt/output paths. Current-prompt draftVersion/draftPaths remain
separate, so an old draft is not falsely marked current. Readable CLI output
labels the association and directs the user to JSON/provenance inspection. A
compiled regression verifies title changes, same-course association, different/
unknown identities, cross-course isolation and original record/source/output
bytes. No body, academic verdict, currentness or authenticated identity is
inferred. This makes preserved work discoverable, not automatically migrated,
approved or reconciled with changed assignment requirements.
Verification: 576 tests and 58 isolated installed-package checks pass, including
the related-draft association with current-prompt status still empty. Typecheck,
lint, synchronized AGENTS/skills and all three skill validators pass. Real
accounts/vaults and installed-host plugin activation remain unverified.

The broader School command-source audit found a coexistence defect in draft
presence: `homework` assumed every native output sat beside its prompt, omitting
preservation-mode outputs. It now uses the validated saved task destination while
retaining exact course/prompt binding. A compiled external-checkout regression
keeps older root-level drafts/records and original prompts byte-identical, reports
separate namespaced versions for two prompts sharing a destination, and confirms
changed draft bodies are not exposed or certified. No output moves, identity
guessing, currentness/approval claims or historical rewrites are introduced.
The suite now passes 575 tests; isolated installed-package smoke passes 57 command
checks, including namespaced draft creation/completion and a `homework` inventory
that also retains earlier root-level outputs. Typecheck, lint, shared-context
checks and all three skill validators pass. All fixture originals are retained.
Live-account/vault and installed-host-plugin acceptance are still unverified.

The imperative-question gap observed below is now fixed for fresh tasks through
`deliverableParserVersion: 2`, separate from the existing evidence schema and scope
version. Ordinary and frozen tasks detect “answer these questions”; separately
line-labeled Rubric sections remain sources but no longer leak into the last
question's literal heading. Mid-sentence mentions stay intact. Omitted answers
stop completion, frozen selection does not read later live prompts, and coherent
older detector records remain byte-identical/unenriched. Fresh revision reuse
requires the new recipe. The host-artifact replay now adapts retained prose into
the new exact question headings without overwriting the original fixture files
or claiming a new independent model/academic verdict. Heuristic completeness,
numeric multipart support and broader live/plugin acceptance remain unverified.

The primary host has now exercised first-use assignment guidance and a finished
custom-format draft through the current compiled CLI in an isolated fixture.
The retained `test/fixtures/host-v3/custom-candidate.md` applies both readings,
uses five executed calculations, separates conditional recommendations from
missing empirical evidence, and produces a checked automatic XLSX. The compiled
replay checks starter/edit preservation, unrelated restricted-guide isolation,
saved headings, and unchanged task/output/workbook bytes across fresh processes
and completion retry. This is one ordinary scenario, not independent grading,
installed-plugin activation or a test of the `/goal` controller. The actual
handoff exposed an open detector gap: an imperative-only list introduced by
“answer these questions” has no heuristic questions/deliverable checklist. The
host read and answered the complete prompt; neither the test nor a successful
completion certifies exhaustive detected requirements. The versioned fix above
closes this observed cue gap; further scoped/frozen host acceptance remains required.

Policy exclusions now participate in scoped guidance selection instead of silently
disappearing. Ordinary task creation/completion and course-proposal creation/save
stop on matching or common restricted guides, while unrelated assignment guides
remain out of scope. New frozen captures pin `restrictedGuidanceVersion: 1` and
retain bounded identity/hash metadata with empty bodies; frozen task creation uses
only that captured evidence, never live files. Earlier cutoffs preserve restrictions
conservatively because their historical applicability is unknown. Replay rejects
missing inventory entries, body injection and parent-evidence downgrades. Synthetic
regressions cover unrelated versus matching restrictions, live-edit isolation,
common guidance and derived-capture tampering. Earlier snapshots/recipes stay
unchanged, without retroactive policy clearance. Live policy/host acceptance and
the broader full-parity audit remain open.

Verification for this increment: 571 tests across 78 files, typecheck, lint,
synchronized shared context, validation of all three plugin skills, and 53
isolated installed-package command checks pass. The actual-source two-writer
audit also passes all three write-order scenarios; the deliverable differential
matches eight School-source cases. These checks use synthetic fixtures only,
without real accounts, student vaults, installed-host activation or publication.

Starter adoption now checks excluded active guidance paths as bounded identity
evidence, so an existing restricted assignment guide is retained/reported rather
than shadowed by a new blank starter. Public `policyRestrictedPaths` contains
paths only; it is not policy clearance, AI permission or a readable-guide claim.
Malformed/unsafe identity and oversized inventories stop; proposed files stay
inactive. The added regression preserves exact restricted-guide bytes and proves
no duplicate starter appears. Installed-package smoke now executes create/retry
with the real installed binary and checks retained starter bytes: 53 command
checks pass, in addition to 567 current tests. No real guide, account or vault
was changed, and full host/live/plugin acceptance remains open.

First-use assignment guidance now has an explicit offline starter command:
`guidance init-assignment COURSE --source EXACT_PROMPT`. A readable numeric Canvas
prompt binds the new local student-preference file; preservation mode keeps new
writes in the product namespace. Existing matching School/native guides are
reported and retained, not duplicated, chosen arbitrarily or overwritten. The
starter contains no instructor policy, AI permission or fabricated student goals;
draft creation never invokes it implicitly. Four regressions cover starter/task
capture, changed originals and existing School guidance, namespace/link refusal,
compiled external-checkout metadata-only CLI and unknown identities. This adds
the first-use outcome without School's automatic write on draft initiation.
Host/student preference authoring and live/plugin acceptance remain unverified.

The course-guidance proposal path also had whole-course guide contamination.
New proposals now pin `guidanceSelectionVersion: 1` and capture common guidance
only, using the same bounded identity-selection/policy checks as prep. Save
revalidates the scoped inventory; unrelated assignment-guide body changes do not
stale the course proposal. Older proposal records retain their former selection.
The added regression checks body exclusion, retained active bytes and versioned
inactive save after an unrelated edit. Existing stale-source/citation/credential
guards remain. This does not implement assignment-guide scaffolding or human
activation, authenticate an instructor, or authorize academic generation.

### Audit checkpoint — 2026-10-14

This is a scoped checkpoint, not an exhaustive completion certificate. Current
HEAD is `0a34cc8` on `feat/student-workflow-parity`; the parity work remains local
and uncommitted. The current synthetic suite passes 615 tests. Source-only audits
were rerun after the guidance/structure changes: both actual writers preserve
navigation/student edits/task/draft/Final bytes in three ordering scenarios, and
the ported deliverable parser matches eight current School-source cases exactly.

| Requirement | Current evidence | Still needed for full claim |
| --- | --- | --- |
| Two products survive in a shared vault | Actual School writer audit; fresh compiled Canvas processes with restarted School writer; namespace/preservation regressions; separate School process-kill and local CLI approval audit | Full School prep/revise/provider workflows and actual goal-controller interruption/resume; installed-release/live-vault acceptance; native documents are not fully interchangeable |
| New-task context and source preservation | Task, completion, module, coexistence and frozen-recipe regressions | Real-class complete source inventory and academic review |
| Prep and finished assignment outcomes | Retained primary-host v3 artifacts and compiled replay | Host acceptance of newer deliverable/scope/guidance/format recipes |
| Assignment guidance, scope and format | Guidance-selection, task-deliverable and explicit starter tests, old-recipe checks | First-use host/student acceptance and ambiguous/unbound guidance review |
| Course-guidance proposal | Retained primary-host artifact, compiled scoped proposal/save/inactive replay, active originals retained | Student review/activation and broader policy acceptance |
| Auth/onboarding/sync/upcoming | Synthetic compiled/backend tests and earlier release smoke | Current branch's live-account/new-student acceptance and complete source coverage |
| Agent portability | Synchronized compact AGENTS/skills/full reference; isolated package install; native Codex 0.162.1 fresh install/discovery and full mock turn-input delivery | Combined real installed-host workflow, desktop activation, personal/parent budgets and other host platforms |
| Evaluation and historical continuity | Frozen parent/recipe/derived-cutoff and human-stop checks | Broader host evaluation matrix; historical contents/permission remain unknown |
| Quantitative/spreadsheet support | Executed arithmetic, deterministic XLSX and tamper/paired-output checks | Source-grounded inputs and required spreadsheet coverage reviewed by a person |
| Phone reading copies | Local snapshot/Current ownership and success-hook tests | Actual chosen Drive upload/account/sharing acceptance |

No row's unit tests prove live acceptance, instructor permission or academic
correctness. These open gates keep the original full-parity objective active.

Matching per-assignment guidance now controls fresh draft shape through
`assignmentStructureVersion: 1`, in both ordinary and identity-scoped frozen
recipes. Declared Brief/Prep brief/Assignment structure supports enumerated,
headed and School-style plain/comma-separated section names. Sources is appended
when absent; other modes retain their own templates. Only matching assignment
guides can declare the shape, not unrelated/common prep guides. Conflicting
declarations, unsafe/oversized headings and more than 40 sections stop. Structure
blocks are removed from generated free-form guidance instructions. Generated
workflow/group gap instructions adapt to the persisted format without silently
adding Open questions. Readers rederive structure, old unflagged drafts retain
their prior shape, and new revision retries do not reuse old format recipes.
Three added regressions cover ordinary completion and prep/outline separation,
frozen/live format isolation with completion, conflicting declarations and exact
older-record preservation. Further host/live/plugin acceptance and complete
requirement-by-requirement parity auditing remain necessary.

Frozen guidance isolation is now implemented with separately versioned evidence:
new captures pin `guidanceIdentityVersion: 1` and retain validated canonical
guidance Canvas identity. New evaluation recipes from those captures pin
`guidanceSelectionVersion: 1` and select common/matching guides from the captured
inventory only. Earlier-cutoff views preserve that marker and reject rehashed
marker downgrades against the parent. Old snapshots remain unchanged; new tasks
from identity-uncaptured snapshots explicitly pin selection version 0 and warn
that whole-course guidance remains unverified, never claiming assignment isolation
or borrowing live identity fields. Existing unflagged recipes retain old behavior.
Three added regressions verify live-edit isolation and body/query exclusion,
derived-marker integrity and old-capture bytes/uncaptured reporting. GUIDANCE
identity conflicts and noncanonical/signed URLs fail capture/replay. Identity
fields are accepted in frozen guidance only under the new capture marker.
Assignment-specific declared output structure is now implemented above; full
host/live/plugin acceptance and instructor/permission/quality verification.

Another verified School gap was whole-course guidance contamination: every active
guide previously entered every ordinary task, including other assignments' goals
or detection suppression. Fresh ordinary tasks now pin `guidanceSelectionVersion:
1`. Bounded identity-only reads select common plus matching assignment guidance,
then selected records undergo policy validation and a hash recheck. Canvas
assignment URL/ID and School-style guide names bind the target; course URL/ID and
standard course/prep files remain common. URL queries/fragments are removed from
new evidence. Explicit wrong-task guides and conflicting/captured identity changes
fail; unrelated guide-body edits do not stale the selected task. Prep excludes
assignment-bound guides, and old selection recipes stay unchanged. Five tests
verify these cases, body/query exclusion, selected-policy enforcement, course-owned
identity, original-byte preservation and historical selection retention.
Frozen captures/tasks now have separately versioned guidance identity/selection
as described above, with draft structure now integrated too. Unbound guides remain common/ownership unknown,
and restricted workspace exclusions still require host policy/source review.
This increment is not a whole-guidance inventory audit, instructor authentication,
AI permission or academic-quality acceptance.

Assignment multipart context now has an explicit `deliverableScopeVersion: 1`
recipe, separate from earlier unscoped deliverable-v1 evidence. A uniquely named
Roman/letter part in the captured prompt limits attached-case items and question
checks; the embedded scope instruction keeps other retained case parts as context,
not requested work. Ordinary readers and frozen derivation recheck scope, and new
revision requests cannot reuse an older unscoped recipe. Three regressions cover
part/item bindings, scoped question gates, completion, altered scope rejection,
frozen/live isolation, exact earlier-record preservation, multiple-parts non-narrowing,
and missing/numeric-part refusal. The unique-part rule follows School's common
single-part request shape; unlike School's first-match heuristic, multiple distinct
prompt parts are not silently narrowed to the first. Numeric multipart boundaries
remain unsupported and require review rather than a falsely scoped checklist.
This is source-derived task context, not confirmation of individual group scope,
course permission, complete source coverage or academic quality.

An additional actual School feature gap is now identified: directive-led
deliverables such as `Required:` preserve enumerated imperatives and multipart
requirements, whereas Canvas's question-only extractor omits them. The owner's
deterministic parser and enumeration helper have been ported locally, with fourteen
synthetic reference tests. A separate bounded version-1 evidence derivation adds
explicit active-guidance `## Deliverable` / `none` suppression, scope validation
and non-truncating input/item limits; four additional tests cover these boundaries.
The maintainer `scripts/audit-school-deliverables.mjs` compares eight synthetic
cases directly with the explicit School source checkout, without configs/accounts.
Reference SHA-256: `deliverable.ts`
`2a908537247a850c9d4bb9edda81752647f4fe928319895a109e1ebc3f040348`;
enumeration helper
`e4f70447def9c3300612c8ef7821893b2dbb237c284a6120801a3a4a9520baf7`.
The seam is now integrated into fresh ordinary and frozen task handoffs as
`deliverable.version: 1`; fixed records separately pin `deliverableVersion: 1`.
Readers rederive source-bound evidence and instructions; completion requires exact
item-text subheadings and substantive cited responses or specific evidence/scope
gaps. Declared active-guidance suppression also suppresses new question heuristics,
without waiving the actual prompt. Outline/review/discussion mode boundaries stay
explicit, and revisions cannot reuse an unenriched old request. Four integration
tests exercise compiled external-checkout inspection, imperative omission/tamper
refusal, frozen/live isolation, suppression, old-v3 byte preservation and mode
boundaries. A fifth integration case verifies explicitly selected attached case
material without a question-like filename. Detection follows the prompt then all
selected course texts, excluding student-work snapshots, as School does; it is not
limited to files whose names happen to contain questions. Synthetic legacy fixtures explicitly omit the new recipe; production
guards were not weakened. All earlier records remain unchanged. The parser and
completion checks are not AI permission, semantic completeness or correctness
gates; host acceptance of these enriched handoffs remains to be exercised.

Current academic workflow v3 now also has a primary-host synthetic acceptance
example, rather than instruction-only evidence. The coding agent authored a
source-cited prep synthesis with posted-question answers and a finished pricing
draft after reading actual handoffs, executed five calculations, and inspected
saved provenance and automatic XLSX values. Source/policy/candidate fixtures and
a compiled CLI replay regression are retained under `test/fixtures/host-v3`.
Real-class coverage, independent review and installed-plugin/live acceptance
remain open; replaying a retained candidate is not fresh model generation.

Calendar comparison now applies the preserved namespace's current-identity
preference within each course. An edited historical copy stays available as
student context but no longer makes a refreshed assignment's matching calendar
event falsely ambiguous. Multiple active copies, cross-course collisions and
title-only ambiguity still require review. The sync/migration regression exercises
all three cases without changing calendar dates or source bytes.

Preserved namespaces now exclude unchanged hash-owned old Canvas sources from
fresh workspace selection before deriving module relationships. Originals and
saved task bytes remain intact; edited/untracked School and student documents
stay eligible for explicit selection. Upcoming views prefer active namespaced
identities even if an older edited copy has a different deadline; outside-horizon
current dates do not revive old deadlines. Bounded no-follow ownership reads fail
closed when metadata is missing or unsafe. Two added synthetic regression tests
exercise the actual sync/migration/task/upcoming transition, retained history,
edited originals and ownership failures. This is not live-vault acceptance.

The legacy root navigation activation blocker now has an explicit offline,
preview-first `vault preserve-school --course ID [--apply]` transition. Only a
still-hash-owned generated Home is archived; exact Home/mapping/ownership backups
remain private. Course namespace and Canvas ownership update under a lock checked
by sync, without School configuration/index/layout changes or task-history rewrites.
Ordinary failure restores only still-owned changes; concurrent replacement
navigation/metadata are preserved for recovery, never overwritten. Old tasks can
be stale after the move and need fresh snapshots; an already-enabled result does
not authenticate old archives. Seven tests cover preview/application, stale and
forged plans, edited navigation, injected rollback, concurrent replacement,
held-lock/no-request behavior and compiled external-checkout CLI redaction.
The actual-School writer audit now adds a legacy Canvas-first transition: archived
Home bytes match the original, and later School navigation/student edits and
Canvas task/draft/Final bytes survive. This is selected synthetic source-writer
evidence, not whole-corpus conversion, installed-release or live-account acceptance.

The owner's testing direction is coexistence, not retirement of School Agent.
`sync --preserve-school` (also supported with pilot onboarding) now persists a
separate per-course Canvas Agent writable namespace. Later unflagged syncs retain
it. Fresh ordinary task recipe `productNamespaceVersion: 1` isolates prep, drafts,
revisions and Finals even when the selected source is an existing School file;
saved older tasks are not rewritten. Invalid course mappings stop fresh creation
instead of silently falling back to shared output paths. Existing Canvas-owned
root Home files require reviewed migration or separate testing; no original is
silently converted/deleted. Five backend tests and compiled pilot flows cover
sticky namespaces, preservation, legacy activation refusal, destination tampering,
unsafe paths/mapping and legacy-source prep/draft/revision/approval.
`scripts/audit-school-coexistence.mjs` uses the actual current School VaultWriter
and parser in synthetic shared vaults, School-first and Canvas-first. Both pass:
School navigation/layout/student edits and Canvas task/draft/Final bytes survive
alternating writes; one draft uses a School source. School source hashes are saved
in the report. This proves those source-writer flows, not live accounts, installed
releases, every file format or migration of existing native root artifacts. Native
Canvas documents remain non-interchangeable with School's strict parser; separate
writable paths avoid requiring identical document formats for product survival.

Read-only doctor diagnostics now inspect bounded fixed-path sync ownership records,
checking configured-origin conflicts and malformed/exposed/linked account evidence
without profiles, feedback or coursework reads. A stored account reservation is
explicitly unverified-current, not an authentication success. Missing/legacy
bindings retain historical ownership as unknown. Backend and compiled offline
tests verify reporting, failure exit status, payload redaction and unchanged bytes.

Sync now checks existing configured-origin ownership and reservations before
network requests. New ownership state retains that origin. An exclusive origin
reservation before document writes also
prevents competing first-time servers from both taking ownership; retained
reservations remain checked even if a sync was interrupted before saving state.
A different server (even with matching numeric course and
assignment IDs), malformed origin or credential/path-bearing saved binding stops
without changing coursework or private feedback. Compiled and backend tests cover
the guard. Legacy unbound ownership state receives an explicit first-binding
notice: it protects future syncs, not historical cache authenticity. This is a
configured-server guard by itself, not API subject/account verification.

Nonempty sync now also verifies the bounded `/users/self` profile and checks a
private, atomically reserved server-scoped subject hash before course reads/writes.
Changed accounts stop without replacing feedback; renewed tokens and numeric/string
representations of the same ID remain supported. No raw profile/name/email/token is
saved in the binding. Present own-submission `user_id` values must match the verified
subject before feedback is normalized/saved. Profile 403/404 remains a permission
limitation, not an expiry claim, and stops sync because account scope is unverified.
Backend tests cover token rotation, mismatched accounts/payloads, profile denial,
unsafe IDs, concurrent reservations and edited/exposed state. Old caches remain
unverified at first binding; no historical record/task is retroactively certified.
Offline readers still do not authenticate today's account or prove archive authorship.

Assignment sync now explicitly requests `include[]=all_dates` and
`override_assignment_dates=true`, retaining minimized date evidence separately
from teaching-date signals. Upcoming work uses API requester-effective `due_at`,
not an arbitrary alternative section/group date. Explicit API null remains undated
even when old description prose says Due. `context`, tasks, frozen evaluation,
inspection and upcoming JSON retain the evidence; calendar reconciliation flags
alternative-only matches for applicability review rather than changing deadlines.
Alternate identities/titles/targeting are discarded, unsupported values fail
without payload echoes and saved older tasks remain unchanged. This differs from
School's first-non-base-date index shortcut when several alternatives are visible;
the [Assignments API](https://developerdocs.instructure.com/services/canvas/resources/assignments)
defines `due_at` as requester-effective when overrides are applied. Cached evidence
does not authenticate the student or verify today's deadline or historical access.

School's revision handoff explicitly supplies a student edit diff. Canvas now
captures equivalent textual evidence for an explicit `revise --work` selection:
`revisionEdits.version: 1` binds the prior/edited snapshot hashes and deterministic
diff. Readers recompute the evidence, and the private handoff tells the host to
preserve edits, explain conflicts and return the complete revised artifact.
Large inputs use a labeled whole-text replacement view rather than an unbounded
quadratic matrix. Earlier revision records stay unchanged; fresh edited-work
retries cannot reuse an older task lacking the recipe. Tests cover byte binding,
changed same-path input, modified diff refusal and compiled task-show exposure.
This does not verify authorship, semantic intent, academic quality or host adherence.

Fixed evaluation comparisons can now explicitly use native private self-feedback
via repeatable `--feedback-assignment ID`, including whole-window comparison.
School's source comparison checks rubric criteria from saved grading feedback;
it does not compare against submitted essay bodies. Canvas captures selected
normalized score/grade/comment/rubric values as separate private review-only
evidence, matched to exact frozen assignment identities—not prep or another prompt.
Frozen generation remains unchanged. New versioned comparisons recheck retained
archives, reference text/criteria and recomputed literal indicators before M1;
later current-cache changes do not rewrite old evidence. Unmatched/missing/unsafe
scope, altered archives and rehashed indicator substitutions fail. Older
comparisons remain readable without automatic feedback enrichment and M1 labels
that absence uncaptured/unknown. Five synthetic tests cover assignment scope,
private payload minimization, zero scores, retained snapshots, unchanged generation,
tamper refusal before new gates, legacy preservation, compiled individual/M1 and
window flows. Clean-install smoke also passes selected native feedback through
comparison/M1. Scores and comments stay out of JSON summaries and phone copies;
account subject, current grade, author identity, AI permission and academic quality
remain unverified. Literal criteria mentions are indicators only, never grades or
automatic M1 PASS. No real student account or submitted-work body was accessed.

Multi-course sync now closes School's per-course failure-isolation gap. Non-auth
failures are recorded as metadata-only outcomes and other selected courses are
attempted; a 401 still stops immediately. Duplicate IDs are deduplicated. Missing
allowlisted identities with permission gaps remain unavailable/coverage notices.
Single-course diagnostics and global unsafe-root/collision preflight remain
fail-closed. Library multi-course failures throw a typed partial report; the CLI
returns its successful/failed counts and per-course status with a nonzero exit,
retaining partial files and ownership evidence. Failed runs do not resolve auth
warnings, refresh due-soon alerts or publish an opted-in Current reading copy.
Seven synthetic tests cover HTTP/resource failures, missing discovery, malformed
JSON, wrong metadata identity, authentication abort, allowlist protection,
deduplication and redacted reports. A compiled GET-only local-server flow proves
that the other course's local prompt updates while the existing mirror and alert
remain byte-identical. Resource-object JSON parsing now redacts invalid bodies,
and fetched course metadata must match the selected ID. This does not certify
complete source coverage or live multi-course behavior; `synced` is operation
completion, not academic readiness. No source files are rolled back or deleted
to make an incomplete run look successful.

Authentication alerts now preserve School's durable remediation/clear-on-success
outcome without its stale-expiry short circuit. CLI HTTP 401 failures save private
config/origin-scoped observations; successful profile verification or nonempty
CLI sync resolves owned warnings while retaining old reports. Sync resolution is
resource-access evidence, not a profile check. `auth alerts` inspects locally;
`--apply` explicitly records a fingerprint-matched expired metadata hint, and
`--notify` opts into desktop delivery. Ordinary status stays read-only. No token,
token hash, profile or account label enters vault alerts. Shared private alert
storage preserves changed/unowned files, rejects unsafe state/held locks and
retains hashes/versions separately from due-soon data. Four tests verify scope
isolation, retained resolution history, private/phone/context exclusion, edited
file retention, expiry labels and a compiled local-server 401→invalid-200→valid
profile flow despite expired metadata. The same flow verifies sync failure/
resolution and genuine API success remaining success when an edited warning
cannot be updated. Real OS delivery/account acceptance remains unverified;
cached notes do not verify current authorization, user identity, course permission
or complete source access. Missing/malformed profile responses do not resolve
API warnings, and local expiry alone is never treated as current API denial.

Due-soon alerts now refresh after successful nonempty sync within its selected
course scope, with a seven-day inclusive default and explicit cached check time.
Public `reminders` previews local deadlines or saves the owned private alert and
retained report with `--apply`; desktop delivery requires explicit `--notify`
or `sync --notify-due-soon`. Default delivery is off, unlike School's default
best-effort macOS notifier. Local overrides apply; past work and announcements
are excluded. Files are private and excluded from generation/reading copies;
changed/unowned alerts, unsafe state and held locks fail or remain preserved.
Interrupted alert/state updates require inspection rather than silent adoption.
Synthetic tests cover exact boundaries, overrides, retained reports, file modes,
edit/lock/link preservation, phone exclusion, notification escaping/transport
bounds and compiled preview/apply. No real OS delivery was used. The current
alert labels its scope and does not replace the full account's deadline view.
The actual School reminder source audit compares two fake-index cases (empty
and boundary-bearing work) with source hash
`f024482b323be70a003ea0f2d054c5717c3d6f190a8e05f1c4d266ecd41e08eb`;
no real notifier, index, student account or source was touched. Submission status,
complete live coverage and desktop acceptance remain unverified. Authentication
alerts are kept in a separate namespace, not mixed into due-soon reports.

Timeline now groups dated assignments/announcements by UTC day and ISO week,
with announcement attention flags and a School-style today-midnight/exclusive-end
window. JSON retains flat items, separate overdue assignments and undated entries,
plus explicit UTC window metadata. Private date overrides remain local. Four
tests verify today's earlier deadlines, horizon exclusion, year rollover, offset
grouping, scope/count/time validation, preserved originals, body-free metadata and
compiled text/JSON output. `scripts/audit-school-timeline.mjs` executes School's
actual timeline function on a synthetic fake index: four common window/scope/
undated/year-rollover cases agree (source hash
`c3389a6515bb927fe8ce3a77d06217c45ff203ab16d5f4c0d8e81bf2731f892d`).
Deliberate differences: offset timestamps use the actual UTC day, earlier overdue
assignments remain separately visible, and undated ties sort by local path.
Announcement ACTION means attention/read, not a verified required reply. This is
not live announcement coverage, notifications, source completeness or submission
verification.

Homework now includes School's draft-presence affordance for upcoming, overdue
and undated assignments. New native drafts match exact prompt paths through
saved task metadata, so a shared Drafts directory does not attach every file to
every assignment. Legacy course-root School slug/base/version filenames are
recognized with highest observed version and paths; colliding titles are flagged
instead of assigned. Four synthetic tests cover distinct native prompt bindings,
edited-body privacy, preserved prompts, legacy Unicode/version parsing, unrelated
course/review files, collisions, symlinks and unreadable task records. The compiled
lifecycle flow also checks homework after actual synthetic completion. This is
metadata/filename presence, not output-byte verification, revision count, approval,
submission status or academic readiness. Unreadable records may hide drafts.

Concluded-course discovery and pilot onboarding now have an explicit path:
`courses list --all` includes completed enrollments, and `onboard EXACT_ID --pilot`
requires one uniquely discovered completed enrollment, selects it and immediately
syncs it. Regular active onboarding still saves selection only. Sync resolves
allowlisted IDs missing from the default course listing by exact course GET;
narrowed sync can discover concluded course codes without expanding its allowlist.
Synthetic CLI tests verify mode/identity refusal before config changes, prompt
edit preservation, inaccessible-course notices and no unrelated course fetches.
A separate compiled CLI flow uses a local synthetic GET-only server. Additional
tests cover 401 failure, 403/404 coverage notices and mismatched identity refusal.
This does not implement School's destructive `--fresh` reset, authenticated
historical reconstruction or live pilot acceptance.

The unresolved-course fallback is now implemented separately: an exact ID absent
from completed discovery and not present in active discovery needs readable
assignments with a valid date span of at least 14 days and a non-null self-submission
score or nonempty rubric assessment. Zero qualifies; grade labels alone do not.
The probe does not save response bodies, work or grades, and returns only eligibility
metadata. Nine synthetic cases verify the date boundary, zero/rubric evidence,
missing evidence, permissions, authentication, mismatched submissions, active-course
refusal and unchanged config after refusal. Explicit unresolved pilot sync can use
identity-only metadata when its profile/syllabus is unavailable, with coverage
notices, while syncing independently accessible resources. Its transient fallback
is bound to exactly one selected ID and is not silently enabled for later syncs.
Compiled GET-only server flows cover concluded and unresolved pilots; exact
allowlisted numeric narrowed sync no longer depends on discovery membership.
The date span follows School's source rule but does not prove elapsed history,
historical visibility, instructor authorship, AI-use permission or live acceptance.

`sync --full` now accepts the School command shape. Canvas already fetches current
metadata and downloads on every sync; the explicit flag and JSON refresh metadata
make that behavior clear without changing allowlist/ownership guards. A mocked
GET-only CLI regression verifies repeated downloads, default/full equivalence,
edited-original retention and no requests to an unselected course. Clean-install
smoke covers the flag with an empty allowlist; it is not live sync acceptance.

School's own graded-feedback sync was missing. Canvas now GETs only the current
student's assignment self-submission, retaining minimal score/grade, rubric and
comment snapshots under private metadata. The explicit `feedback` command reads
one chosen course/assignment cache with checked time and archival hash binding.
Six synthetic tests cover minimization, permissions, workspace/phone exclusion,
version retention/reversion, user edits, malformed/wrong-identity payloads,
permission versus authentication failure, archival tampering, exposed files,
symlinks, compiled CLI error privacy and stalled-stream cancellation. Null scores
are not converted to zero and comments are not assumed instructor-authored.
Clean-install smoke also reads a synthetic cached snapshot, not live feedback.
School's fixed playbook context now has a private retained-value view and a separate
`learningHistory` snapshot on new ordinary prep/assignment tasks. Two additional
tests verify accumulation, explicit assignment scope, compiled playbook use,
private role/instruction binding, course-source separation, frozen history despite
later updates, old-task preservation and no live feedback enrichment of fixed
replay. Inspection/comparison/review expose only hashes/counts; completion and
revision/approval reads verify archive bindings. Fresh revision reuse also checks
private context. Clean-install smoke covers the playbook command. This restores
prior-learning context without publishing grades as course reading. It does not
reconstruct older change events or first-observation times. New native sync now
retains per-assignment observation chains with a baseline and distinct consecutive
values: A→B→A remains three events while unchanged syncs do not duplicate entries.
Sequences/tails/scope and all referenced archives are revalidated before updates,
and available observations are bound into private learning-history snapshots.
Two further tests exercise repeats, unchanged refreshes, legacy baselines, private
task binding, invalid sequences/tails and corrupted older-archive preservation.
Times describe local successful cache observations, not actual instructor grading
dates; cross-assignment global operation order and historical reconstruction are
not verified. Explicit legacy playbook inspect/import now preserves the selected
School `_meta/course-playbook.md` as private hash-bound learning context, leaving
originals unchanged and validating account/course URL and eligibility policy.
Four synthetic tests verify metadata-only inspection, idempotent import, changed
versions, new task capture/completion, old task context preservation, phone exclusion,
restricted/wrong-account/course refusal, symlinks, exposed/tampered snapshots and
compiled commands. Old text is not converted into authenticated feedback events or
known instructor statements; historical provenance stays explicitly unverified.
Real existing-vault/account/host acceptance remains open.

Explicit playbook assignment scope now reads only the chosen cache directories,
rather than enumerating the whole course before filtering. A synthetic course
with more than 1,000 cache entries verifies backend and compiled CLI retrieval
of one chosen assignment, duplicate-ID normalization, missing-cache errors,
selected symlink/traversal refusal and a 500-ID scope bound. Whole-course
retrieval retains its bounded-inventory refusal; unrelated assignment symlinks
are not inspected by the scoped reader. Imported course-level legacy playbooks
remain separate context and are still validated.

School's quiz-description sync was missing from Canvas. Fresh sync now fetches
the optional paginated quiz list, writes sanitized descriptions with explicit
quiz type/identity, resolves module Quiz links independently of colliding assignment
IDs, and recovers linked reading files. Synthetic tests cover ordinary/frozen prep
context, pagination, student-edit/original retention, HTTP 403/404 coverage notices
and HTTP 401 authentication failure. No question, answer, attempt or submission
endpoints are called. Quiz descriptions are context only, not a graded-quiz solver
or submission feature. Existing capture availability rules still apply: undated
navigation references can be present in ordinary prep but excluded from replay.
Real course/host acceptance of this change remains unverified.

Fresh sync now derives module `session_at` teaching dates with year provenance from
term/start/end dates, a recognized term code or the unique modal assignment-deadline
year. It does not default to the current year. Titles must identify one real date;
missing-year, conflicting and impossible dates produce notices. Explicit title
years and ISO dates are honored. A synthetic sync-to-ordinary/frozen-prep test
verifies correct reading selection, next-session exclusion and original retention.
`scripts/audit-school-session-dates.mjs` executes School's current parser/year
resolver (source hash 1c95929408d61469c8702c9d44472f02c1e5aa2e47aece1a187391cd211fb8fe):
15 shared cases agree. Deliberate boundaries: refuse February 30 instead of writing
an impossible date, honor an explicit title year instead of substituting the
course year, and recognize explicit ISO title dates. Teaching dates remain separate
from API releases; session-based replay visibility is labeled inference. This is
not live-class or installed-host acceptance.

New ordinary/frozen prep recipes now persist `prepSelectionVersion: 2`, retain
raw module unlock/session dates, and match School's unlock-first priority plus
directly linked assignment-deadline selection. The actual School source audit
confirms both cases. Tests cover ordinary completion, frozen recipe binding,
rehashed capture date substitution, and coherent unflagged flat-date recipes
remaining readable/completable without retroactive rewriting. Older strict
assignment snapshots ignore only newly parsed module-date metadata that was not
captured originally; source identity, bytes, selected scope and other metadata
remain checked. Fresh strict comparison is independent of JSON object key order,
not of field values. Compiled ordinary/frozen completion/comparison/M1 tests verify
matching source paths and pending human verdicts. Captures lacking raw module-date
metadata cannot prove date priority; refreshing a capture is required for that
evidence rather than inventing it from a flattened list.

Synthetic regressions now cover section-suffixed term codes reusing conventional
course roots, Canvas ID/code selection from both manifests and legacy navigation
files, assignment titles recovered from dated assignment folders, nested session
dates, module/page/file relationships in legacy snapshots, and HTML question
extraction. Session pages with the same owning module count as one session;
different module identities still fail as ambiguous. Links resolve only to the
selected course's already approved inventory, never by fetching arbitrary URLs.

A new isolated acceptance run used 20 separate Luna agents and 147 CLI commands
across seven authorized October 9 course snapshots. Course aliases, prompt titles,
dates, the five Uber preparation questions, calendar roundtrips, legacy assignment
import and synthetic completion guards were exercised. This is not live-account
or academic-quality verification. Many generation cases correctly stopped for
unclear permission or missing student inputs. Installed plugin instructions were
older than the source contract; synchronized source files do not refresh a cache.

Follow-up synthetic regressions now reject Markdown, plain-text and HTML title-only
prep sources, warn on empty selected reading text, include detailed syllabus files
in assignment handoffs, and reject uncited or unbound guidance proposals. Guidance
still saves only proposed versions and never activates policy. These follow-up
fixes have not been re-run on the private course snapshots.

Auth login/renew now provide portable private-dotenv storage, expiry recording,
fingerprint-bound renewal warnings and manual renewal instructions. Status is not
API verification; stale expiry metadata cannot override a successful `auth verify`.
Unlike School Agent, this does not store tokens in macOS Keychain or auto-open a
browser. The shared agent instructions now explicitly distinguish legacy
`ai_policy: allowed` eligibility metadata from actual course permission.

## Remaining parity work

- A renewed current-School command/source audit found that `simulate --weeks`
  generates weekly prep plus visible assignment drafts, optionally restricted
  to a module. Individual Canvas frozen tasks are not equivalent orchestration.
  The cutoff foundation is now implemented as `simulate derive`: one immutable
  original capture yields equal/earlier views without live source reads, preserving
  captured availability, guidance, exclusions, original time and parent hash.
  Readers reject rehashed child substitution and changed/rebound parents, while
  old snapshots remain unchanged. Backend and compiled derivation-to-completion-
  comparison/M1 tests verify source isolation and pending human verdicts. Multi-week
  orchestration now exists as `simulate window create/show/compare`, with private
  progress journals, per-cutoff prep/visible draft handoffs, optional module scope,
  bound recipes, dynamic completion counts and whole-window/exact-week review.
  Tests verify source isolation, full and per-week comparison/M1, future-module
  refusal, recorded failures, interrupted journals, rehashed selection/recipe
  tampering, invalid scope/range and ambiguous-ID exact-path resolution. A compiled
  flow exercises creation/show/completion/comparison and M1. Boundaries differ
  explicitly from School: arbitrary real-date cutoffs are sampled every seven days,
  while prep uses the containing UTC Monday (School uses the cutoff as its prep
  period anchor); both dates are explicit in the plan. Windows are
  bounded to 52 cutoffs/250 possible tasks, comparison to 100 outputs, no future
  module relationships are borrowed, no old runs are deleted and no hidden models
  are invoked. Host course
  acceptance, full source completeness and academic quality remain unverified.

- Re-audit source completeness for each preparation and assignment workflow;
  `scripts/audit-school-visibility.mjs` now executes School's actual pure visibility
  functions against nine synthetic cases and compares Canvas capture inclusion.
  The source hash is bfca2022dcbcea5e778b44f7719e19f4db740e3118769f1731ee06dfe220f76c.
  Explicit unlock/posted dates, future unlock refusal, bulk creation refusal and
  unknown visibility agree. The four previously differing fallback-only cases—containing
  module unlock, session-minus-seven-day release, due date and post-setup creation—
  now agree through versioned structural evidence. New captures preserve a private
  source-hash/date/membership inventory and label inferred signals `school.*`.
  Readers recompute the rule and bindings; earlier views keep the original metadata
  inventory without reading current files. Guidance/student work do not inherit
  these estimates. Unknown, restricted, invalid and explicitly future releases
  remain excluded; ambiguous membership stops capture. Unflagged old captures
  retain explicit-only behavior unchanged. Tests cover structural inclusion,
  cutoff filtering, live-edit isolation, legacy bytes, ambiguity and rehashed
  signal/inventory substitution. Compiled capture-to-completion/comparison/M1
  verifies rule/count evidence and pending human verdicts, including rejection of
  coherently rehashed count changes. Nine synthetic visibility outcomes agree;
  this does not prove every date conflict, historical access or full class coverage.
  Fresh sync now preserves page/assignment publication and posted dates, extracted
  files' own unlock/publication/posted dates and real page_id identity. A synthetic
  sync-to-capture-to-frozen-assignment regression verifies that published pages and
  released file text are selected, future/creation-only files stay excluded, and
  original binary/text bytes remain unchanged. No module/creation visibility is
  silently inferred by the metadata-preservation fix; the new separately versioned
  visibility rules are explicit. Real-class source coverage remains unverified.
  Explicitly report missing linked readings, empty extraction text and uncertainty.
- Run host-agent acceptance of legacy assignment migration. Synthetic tests cover
  explicit inspect/import, fresh pending tasks, scope/policy checks, version ties,
  preserved old work, hash-bound links and approval only after new draft completion.
  Historical inputs cannot be verified from path-only provenance; old approval is
  intentionally not imported as validation under the new workflow.
- Re-run host-agent acceptance of scoped legacy prep-log inspection and saved-task
  compatibility. Synthetic tests preserve coherent older parsing recipes without
  rewriting questions and keep changed-source/question guards active. Prep logs
  lack reliable course, historical-hash and generated-run bindings; inspection
  reports those limits explicitly instead of inventing context.
- The current School selector has now been executed on synthetic fixtures with
  `scripts/audit-school-selection.mjs`: on Node 24.4.1, `0`, `1` and `2` go through
  Date.parse and select January 2000, January 2001 and February 2001 respectively,
  not course-week ordinals. Invalid dates trigger keyword fallback. The audit uses
  actual current School source functions and records their source hash; it does not
  reconstruct the historical `--week 0` run or establish its intended period.
  Canvas continues requiring an explicit Monday/session rather than preserving
  accidental numeric date parsing or guessing that intent.
- The same source audit confirms that School assignment retrieval includes the
  owning module plus its preceding teaching module. Ordinary Canvas assignment
  handoffs now use exact approved membership and persisted directory order to
  include those modules/readings, without pulling following modules or guessing
  unlinked membership. Competing predecessor identities require an explicit module
  context path; unknown order is not invented. Synthetic helper and real-handoff
  tests verify scope, ambiguity resolution and preservation. Existing snapshots
  are not rewritten; newly required source selection may need a fresh task.
  Fixed-snapshot assignment evaluations now use the same expanded selection solely
  against their captured inventory, with `selectionVersion: 2` saved separately
  from the question parser version. Coherent unversioned evaluation records retain
  outgoing-link selection without rewriting old sources/recipes. Unsupported
  versions and inconsistent downgrades fail. Synthetic tests verify frozen
  predecessor scope, captured ambiguity resolution, live-edit isolation and old
  record preservation; a compiled completion/comparison/M1 flow checks the new
  context through the human-review boundary. Capture now also keeps permitted
  global/course guidance separately, including approved course `_meta/guidance`
  paths, only when explicit availability evidence supports the cutoff. Undated,
  future and policy-restricted guidance is excluded/reported rather than borrowed
  from the current vault. Old captures without a guidance array remain unchanged
  and replay with no injected guidance. New selection-v2 tasks derive custom prep
  headings/instructions from frozen guidance; older unversioned task recipes retain
  their prior no-guidance shape. Comparison citation/binding inventories include
  captured guidance alongside material. Synthetic tests verify scope/role guards,
  rehashed private/cross-course path refusal, old capture preservation and live-edit
  isolation; a compiled custom-prep completion/comparison/M1 flow tests the private
  guidance path and keeps human verdicts pending. This does not establish current
  instructor permission, genuine past visibility, full source completeness or
  academic quality. Host acceptance of these changes remains unverified.
  Fresh Canvas sync now records `type: modules` and the API's valid positive
  `module_position`, carried as modulePosition through workspace, tasks and frozen
  snapshots. Selection prefers that persisted order and retains directory-order
  fallback for older records. A synthetic real-sync-to-handoff test verifies owning
  and preceding readings in ordinary and frozen assignments, excluding following
  material. This closes a fresh-sync gap that typed legacy-only fixtures missed.
  Canvas defines module position as one-based in its
  [official Modules API](https://developerdocs.instructure.com/services/canvas/resources/modules).
  Missing/invalid positions are not fabricated. Native Canvas document frontmatter
  is not certified as directly readable by School's strict document parser; matching
  folder names/markers alone still do not establish safe shared writers.
  Follow-up source inspection found additional constraints: School module roots
  require a title followed solely by typed item lines, derive module order from
  filenames/directories, and resolve page paths by filename slug. Strict YAML
  compatibility alone therefore cannot certify module retrieval. A staged
  `portable-document.ts` serializer now returns strict portable Markdown and
  separately hash-bound Canvas-only context, with explicit policy/status/source
  inputs and no eligibility defaults. Context cannot override policy. Unit tests
  check hashes, typed module shape, stale context, credentials, paths and bounds.
  `scripts/audit-school-documents.mjs` executes the actual current School parser
  and module loader/selector on nine synthetic portable documents; all parse,
  owning/preceding assignment selection resolves assignment/page/file paths,
  and Canvas still excludes explicitly restricted material. The fixture supplies
  ordered module filenames and matching page filename/title slugs deliberately.
  Current sync does not yet use this serializer. Private context persistence,
  rehydration, existing-path migration and ownership-safe integration remain open;
  no student files, sibling source or global markers were rewritten. Alternating
  writers requires a separate explicit product/ownership decision and audit.
- Run host-agent acceptance of the reading-copy/current-mirror workflow with a
  student-confirmed private cloud destination. Local synthetic tests verify
  exclusion, recovery, successful-write hooks and parseable JSON, not actual uploads.
  Explicit legacy mirror-state import transfers ownership without modifying course
  files and retains the old mapping as a private backup; unsafe mappings fail closed.
- Audit auth login/renew ergonomics, local-vault diagnostics and migration,
  evaluation/review commands, and Obsidian support against School Agent's command
  inventory. Equivalent outcomes may use external-host handoffs, not internal models.
- Strengthen host instructions and acceptance checks so generic legacy
  `ai_policy: allowed` frontmatter is not mistaken for explicit course permission.
- Re-run the complete host-agent test matrix and source-by-source comparisons,
  including onboarding from a clean install and operation outside this checkout.

Provider model routing and billing remain with the chosen coding agent, as required
by the model-free architecture. This is an intentional implementation boundary,
not permission to omit student prep, assignment or evaluation outcomes.

The 2026-10-14 source audit rechecked School's prep, assignment, guidance, cost,
comparison, reading-copy and command-registration implementations against Canvas
entrypoints. School's `models map/check`, generation-time `--model/--catalog`,
automatic Gateway estimates and `cost reconcile` depend on its embedded provider
runtime/index. Canvas retains external-host generation and supplied-export cost
reporting, without claiming authoritative billing or silently loading provider
credentials. This audit distinguishes those intentional boundaries from student
workflow defects; it is not a full behavioral parity certificate. Frozen window
and source-bound comparison workflows use different explicit IDs from School's
pilot-directory command, and still need broader host acceptance.

| Student need | Canvas Agent 0.4 |
| --- | --- |
| First-run setup and course selection | setup, doctor, auth status/verify, courses list, onboard, scoped sync |
| Know what to work on | upcoming, homework, timeline, context; overdue/undated work, announcements, private date overrides and ICS check/export |
| Prepare a class | current week, explicit Monday or unique session; module-linked reading snapshots; course-defined structure and detected question gates |
| Assignment lifecycle | outline/draft/review handoffs; draft by title/ID/path; revise from validated prior output; explicit local approval |
| Read non-Markdown materials | retained originals, basic PDF/DOCX/PPTX/XLSX extraction; HTML-linked Canvas file recovery, bounded retries, credential-free CDN redirects; ingest by week or module |
| Provenance and review | inspect, compare, human review bundle, snapshot/original checks, preserved output versions |
| Existing School Agent assignments | explicit legacy inspect/import with known course/prompt identity; fresh draft/review handoffs and preserved originals; historical hashes/approval not fabricated |
| Quantitative support | arithmetic/statistics/NPV and bounded JSON batches with audit, values-only XLSX artifacts; no arbitrary script execution |
| Course guidance | syllabus-bound proposal handoff and versioned proposed files; human activation remains separate |
| Repeatable evaluation | fixed private source capture/replay with explicit availability metadata; external agent generates the work |
| Agent portability | matching core contract in AGENTS.md and three bundled skills, generated default academic workflows, private task-specific instructions |
| Phone reading copy | preview/apply snapshots, opt-in Current mirror after successful writes, recovery and disable/re-enable; uploads handled by the desktop cloud client |
| Local Obsidian viewing | names-only readiness, preserved getting-started guide and optional path-only app launch; no sync/account/settings changes |
| Homework-to-draft shortcut | exact Canvas ID selection, ambiguity guards and a pending external-host draft task; legacy plural prompt types supported |
| Assignment discussion | draft --discuss or explicit discuss mode; exact quoted inquiry, source-bound reply, separate notes, no graded draft/version/approval implied |

## Command-level finish line

The baseline is the existing School Agent CLI source, including the local reading
copy and Obsidian additions. The model-free architecture remains intentional;
student outcomes must be preserved even when generation moves to the chosen host.

Before full parity can be claimed, close and verify these concrete remaining gaps:

1. `vault migrate`: compatible document-layout/course-root migration planning and
   conflict-safe application, with existing references/provenance preserved.
   The combined preview/apply command now has bounded inventory,
   exclusive copy/hash checks, private original archives, a migration lock and
   interruption rollback that preserves concurrent edits. Synthetic tests cover
   classification, stale/forged plans, collisions, unsafe links, invalid dates,
   lock ownership, byte preservation and interrupted writes. `vault migrate`
   requires an explicit absolute School index outside the vault and selected numeric
   course IDs; it defaults to preview, and only `--apply` writes. Compiled CLI tests
   verify preview is read-only, conflicts refuse application, and workspace context
   follows the updated identity and prompt path. Current extraction `original_path` and ordinary
   inline Markdown links can now be rebased, with separate original/output hashes,
   staged rewritten files, unchanged historical comments/code and original archives.
   Synthetic workspace inspection verifies the rebased original-file hash binding;
   interruption tests verify restoration even after rewritten files were copied.
   Structured `related_paths` scalars and flow/block string lists now rebase to
   current vault-relative destinations too. YAML scalar token ranges preserve
   inline/unrelated comments and other metadata; unsupported aliases/block scalar
   values, unsafe/missing targets and oversized lists stop for review. Synthetic
   migrations verify preserved original archives and that actual post-migration
   prep selection still reaches the moved reading. Opted-in incoming scans also
   detect structured references in unselected text without rewriting that text.
   Reference-style Markdown definitions, quoted/unquoted HTML href/src and explicit
   vault-relative Obsidian wiki links now rebase with aliases, anchors and embeds
   retained. Existing course `_index.md` navigation is allowed, while private paths
   remain blocked. Missing/ambiguous targets, short-name wiki links, complex local
   unsupported Markdown syntax and HTML entities require review rather than guessed
   paths. Balanced/escaped inline destination parentheses and angle-wrapped paths
   now rebase with percent-encoded parentheses, retaining quoted link titles.
   Common amp/quot/apos/lt/gt/nbsp HTML entities and valid numeric Unicode entities
   are decoded for target validation, then safely re-escaped in attributes. Tests
   verify parentheses, ampersand/apostrophe filenames, preserved titles/literals,
   unsupported entities, invalid controls, unclosed links and bounded nesting.
   The root/index phase verifies selected course identities against
   `_index.md` and the explicit School SQLite index; it fingerprints the selected
   filesystem inventory and all five path tables, checks course ownership, backs
   up the database and rebases paths in one transaction with directory rollback.
   Tests cover Unicode paths, unselected-course/payload preservation, stale and
   forged plans, collisions, nested symlinks, locks, schema versions and triggers.
   This command needs Node 22.16+ for the built-in SQLite backup API.
   Current-reference rewrites and Canvas mapping updates
   are now integrated with the root/index transaction. Synthetic workspace
   inspection verifies the new identity and original-file binding, and injected
   commit failure restores references, mapping, roots and all indexed paths.
   Rewrite staging/original backups remain private; stale/ambiguous mappings fail.
   No global School layout marker is advanced. Compatibility for continuing to use
   both writers, incoming references from unselected courses, and unsupported link
   forms still need review before migration can be called full School parity.
   Current School source requires layout_version=2 and course_root_version=2
   before writing to a nonempty course vault; a missing marker is initialized on
   first write. Canvas migration now inspects the bounded `_meta/layout.json`
   marker read-only, fingerprints it for stale-plan checks, reports legacy/current/
   missing/invalid/unsupported states and blocks invalid/future versions. Tests
   verify preserved bytes/extra fields, marker changes invalidating plans, and CLI
   reporting without exposing unrelated metadata. A current marker is still
   explicitly shared-writer-unverified, not a compatibility certificate. Selected
   migration never authorizes advancing a whole-vault marker, and actual concurrent
   writer acceptance remains unfinished.
   The maintainer School-source audit also executes the actual marker guard on a
   synthetic nonempty vault: absent and 2/2 markers permit entry, while 2/1, layout
   1 and future layout 999 refuse it. It records the current source hash and does
   not run a writer, use a real index/account, or prove installed-release behavior.
   The same audit now exercises the actual School document parser against native
   Canvas Home, assignment and module records produced by mocked GET-only sync.
   All three are rejected by the strict School schema; this is demonstrated
   incompatibility, not merely missing concurrent-writer evidence. Conversely,
   Canvas workspace inspection reads synthetic School module and assignment
   records with their identities intact. The audit records the School parser
   source hash (`8363832611437e2c9be151041caba63f96d4fb4564720f26f40cde19b9b4c1f6`)
   and emits only synthetic paths/results. It does not certify alternating writers:
   native Canvas records have additional metadata and lack required School fields,
   and changing a whole-vault marker cannot repair that format difference.
   An explicit opt-in incoming-reference planning backend now scans bounded current
   text in indexed unselected course roots read-only. Supported Markdown, reference
   definition, HTML and qualified wiki links needing a selected-file rebase become
   conflicts, not writes to unselected files. Its content digest participates in
   application freshness checks. Synthetic tests verify conflict refusal, unchanged
   unselected documents/index, preserved historical comments/code, stale new links
   and symlink refusal without reading their targets. Private/hidden/archive paths,
   short-name wiki links and binary formats remain unverified; readiness is not a
   whole-vault proof. Public `vault migrate --check-incoming` now explicitly opts
   into that read scope and returns requested/scanCompleted/documents/digest/limits
   metadata, not document bodies. Compiled CLI tests verify blocked preview/apply,
   default-unrequested reporting and successful conflict-free apply with unselected
   documents and index rows unchanged. The flag never authorizes unselected writes.
   Combined layout/root application is now implemented: preview projects final
   paths, stages original/rewritten bytes privately, exclusively creates new
   document destinations, updates exact document paths in all five SQLite tables,
   and rolls back layout/root/mapping/index changes on ordinary failure. Tests
   exercise both renamed legacy roots and already-canonical roots, original-file
   bindings, linked readings, prompt destinations and injected commit failure.
   Short-name Obsidian links now support explicit student choices through repeatable
   `--wiki-target NAME=VAULT_PATH`. The selected target must match its filename and
   stay within the selected course inventory; no global name search or inferred
   alias is performed. Preview/apply persist and revalidate the choices, expand
   current links to explicit destination paths and preserve aliases, anchors,
   embeds, comments/code and archived originals. Layout and compiled combined
   root/index tests verify these outcomes, unresolved-link refusal and invalid,
   duplicate or out-of-scope choices. This does not resolve unselected incoming
   short-name links or metadata aliases, so whole-vault compatibility remains open.
2. Auth storage compatibility: School Agent's macOS Keychain workflow remains
   different from the new portable dotenv workflow; verify an explicit supported
   transition without reading unrelated accounts or claiming Keychain storage.
   Public `auth import-school-keychain` now supports that explicit transition for
   one exact School service/account and a student-confirmed future expiry. It uses
   bounded `/usr/bin/security find-generic-password -s school-agent-canvas -a
   ACCOUNT -w`, never enumerates/falls back to other accounts and does not modify
   Keychain or shell variables. Storage stays in private adjacent dotenv/auth
   files outside the vault; a different saved token requires --replace, and a
   different shell token is reported as overriding the import. API verification
   remains separate. Synthetic backend tests verify platform/account/expiry/path
   refusal, private permissions, retained settings, exact lookup, replacement
   protection and redacted failure. A CLI test captures the actual subprocess
   boundary with synthetic output and checks executable/arguments/time/buffer
   bounds plus redacted JSON; compiled help registration is also verified. No real
   Keychain entry was read, and real OS access/API acceptance still needs explicit
   student scope. This provides an import, not native cross-platform Keychain use.
3. `dogfood`, `gate m1`, `simulate` and `compare`: map the actual legacy inputs and
   evaluation outcomes to host-generated workflows, not just similarly named tools.
   The legacy M1 packaging backend now reads the actual School simulation report,
   comparison, scorecard and listed Markdown artifacts, extracts correctness
   self-review, inventories declared grounding, and includes local base/overridden
   dates and discrepancy checks. It saves private versioned bundles with a pending
   human verdict and never independently confirms old visibility/source/course
   binding from path-only reports. Traversal, symlinks, wrong run IDs and duplicate
   artifacts fail. `gate m1 --run RUN --course COURSE` is now public; compiled CLI
   tests verify private metadata-only output, explicit scope, unsafe-run rejection,
   preservation of legacy artifacts and the pending-human stop. Fixed-snapshot
   host-generation comparison is implemented below; dogfood orchestration remains unfinished.
   Simulation replay now retains module IDs, supports nested
   availability signals, and rejects malformed timestamps and cross-course sources.
   The fixed-snapshot task backend now persists prep by explicit week/session and
   assignment outline/draft handoffs, derives approved source selection and question
   requirements from the frozen snapshot, and rejects changed recipes. Candidate
   completion reuses normal identity/structure/question/citation guards, saves only
   private evaluation output, and is idempotent for the same candidate. Tests verify
   frozen evidence remains unchanged after live-vault edits and no student artifact
   is replaced. Public `simulate task create/show/complete` is wired and tested
   through the compiled CLI from capture through completion, live-source edits,
   same-candidate retries and tampered-output rejection. Shared agent/plugin
   instructions explain the distinct namespace and pending-human states.
   Review/discussion and explicitly captured student-work inputs are now supported
   in the same frozen-evidence namespace. Compiled CLI tests exercise both modes
   from capture through completion and comparison/M1, retain old work after live
   edits, require review work and exact quoted discussion inquiries, and reject
   uncaptured/restricted/future/undated work or invalid/credential-like questions.
   Explicit work capture is limited to eligible course Draft/Drafts text; it never
   silently feeds prep/context selection. These are synthetic mechanics, not proof
   of academic-quality review or actual historical work visibility. Dogfood
   orchestration remains unfinished; this is not full parity yet. Its internal
   resumable core now preserves the actual ten-flow School order in private,
   exclusive hash-checked checkpoints. It requires explicit flow implementations,
   revalidates prior pass/skipped evidence, invalidates downstream results after
   stale evidence and stops on fail/pending-host/pending-human states. Tests exercise
   resume, preservation, scope/identity, locking, corrupt journals, unsafe IDs and
   symlink rejection. Exceptions are not copied into records because they may
   contain credentials/source bodies. The first five concrete flow backends are
   now wired to selected-course opt-in sync (or explicit offline skip), local
   upcoming/overdue/undated timeline, a preserved private operational note, and
   real prep/draft tasks. The note does not activate guidance or invent AI-use
   permission. Generation waits for the host; structurally completed outputs wait
   for explicit human pass/fail verdicts, bound to output hashes. Synthetic tests
   exercise those continuations, exact prompt/period binding, source/output
   changes, note preservation, prep-only skipping and unauthorized sync rejection.
   Successful live sync is not established by these tests. All ten concrete
   backends now run in an integrated resumable synthetic test. Co-edit creates a
   revision and separately quoted discussion, checks parent/prompt/work/inquiry
   bindings, requires human review of each and preserves the original draft.
   Approval waits for direction on the exact revised task or verifies an existing
   approval receipt; changed/missing Final evidence fails rather than being forced.
   Renewal exercises shared expiry classification and immutable local instructions
   with a credential-free expired fixture, not real auth or an OS notifier. Source
   gaps are recomputed from the actual local inventory; reported counts do not prove
   completeness. Cost reporting explicitly skips toolkit billing and directs the
   user to host usage rather than fabricating costs. Tests also verify safe repeat
   resume and failure before downstream steps after a changed Final. Public
   CLI/verdict/approval wiring is now public: scoped `dogfood`, `dogfood show` and
   `dogfood resume` connect real handoffs, `--verdict UUID=pass|fail` and exact
   student-directed `--approve-task`. A compiled CLI test executes all ten flows
   across external synthetic completion, human-review decisions, local approval
   and repeat resume; it rejects unfinished/off-run verdicts, wrong approval IDs,
   wrong scope/traversal and changed Finals. JSON contains run metadata, not source
   bodies. Failure returns nonzero; valid host/human stops return zero. Successful
   actual sync/approval writes can refresh an opted-in Current mirror; failed runs
   do not refresh. Session sweeps now have an internal numbered-session resolver
   and private manifest/run-creation backend. It selects exact module identities,
   groups legacy page snapshots by owning module, binds one explicit linked prompt
   (or prep-only), and creates isolated per-session journals without guessed dates.
   Tests cover numerical order, grouping, prompt/target binding, invalid counts,
   duplicate session numbers, multiple prompts, unavailable links and changed
   manifest rejection. Inspection reports recorded states only, explicitly not
   revalidated evidence. Sweep manifests now reserve every per-session run UUID
   before initializing any child journal. Interrupted ordinary-error initialization
   can resume those exact IDs without duplicate runs or modified existing
   checkpoints. Synthetic interruption tests verify preservation, repeat recovery,
   corrupt/nonempty run refusal, selection changes and lock preservation. Missing
   child runs appear as not-initialized, never as completed. An actual killed writer
   may leave a lock or partial checkpoint: these require explicit inspection/manual
   recovery, not guessed lock deletion or overwriting corrupt evidence. Public
   `dogfood --sessions N` and scoped `dogfood sweep show/resume` now orchestrate
   exact child runs, preserve independent host/human stops, recheck teaching scope
   and save private versioned aggregate reports. Compiled two-session tests verify
   linked-prompt/prep-only scope, distinct IDs, external completion/human review,
   aggregate refresh and continuation/revalidation after one child fails. Inspection
   remains explicitly recorded-only; failure never becomes an aggregate pass.
   Authorized sync evidence is shared across the sweep rather than intentionally
   syncing each child; live-account efficiency/acceptance remains unverified.
   Live student acceptance and academic quality are unproven.
   A comparison backend now validates completed fixed-snapshot evaluation outputs,
   verifies explicitly selected current review-only references, inventories exact
   citations, surfaces literal rubric-criterion mentions without calling them
   substantive coverage, and creates blank anchored human scorecards. It preserves
   outputs/snapshots, rejects pending/tampered/cross-course work, restricted/missing
   references and malformed rubric data, and keeps historical visibility and the
   verdict unverified/pending-human. Public `simulate compare --course COURSE
   --task UUID` and `gate m1 --comparison UUID --course COURSE` now connect completed
   fixed-snapshot outputs to private comparison/scorecard and human-review bundles.
   Compiled CLI tests exercise the complete comparison-to-gate flow, metadata-only
   JSON, explicit scope, exactly-one-run-or-comparison selection and unsafe IDs.
   Gate reads verify saved file hashes, parent output/snapshot/source bindings and
   replay-derived availability counts. Modified evidence/scorecards or parent output
   fail before a gate is created. These checks detect inconsistency, not malicious
   rewriting of every local file or authentic historical visibility. Existing later
   feedback never enters generation snapshots, and human scores/verdicts remain
   deliberately pending; no academic quality or M1 PASS is inferred automatically.
4. Re-run the scoped host-agent acceptance matrix against the fixed selectors,
   source relationships, questions, migration, discussion and reading-copy flows.
   A passing structural validator is not source completeness or academic quality.
5. Verify a clean packaged install and matching plugin instructions outside the
   checkout. `npm run package:smoke` now builds/packs the current checkout,
   installs the tarball without dev dependencies into an isolated temporary npm
   project, and executes its actual installed binary from a separate student
   workspace. The executed 26-command synthetic flow covers setup, offline doctor,
   config/auth diagnostics (missing-token verification), local work inventory,
   prep/draft completion, provenance/review, revision, local approval and frozen
   evaluation comparison/M1, plus a supplied host-usage export and redacted
   malformed-export rejection. Usage checks prove exact known subtotals, unknown
   overall cost when a row lacks cost, separate function/source groups and
   byte-preserved input; they do not verify provider billing. Original synthetic
   sources remain byte-identical;
   packaged AGENTS.md, shared contract and all three skill/workflow blocks match
   the checkout. Temporary files are removed even on failure; dependency download
   is the only network step. Host plugin discovery/activation in a fresh Codex
   session and other host platforms remain unverified, and the existing installed
   cache is not refreshed. Live accounts, uploads, model costs and course
   permissions require explicit student scope; no broad-account tests or
   submissions are implied.

Old provider model routing/cost accounting are delegated to the host, not silently
emulated with unsupported numbers or hidden calls. Historical context hashes and
permissions cannot be recovered from path-only records; report that limit.

An optional public `cost --file ABSOLUTE_HOST_USAGE_EXPORT.json [--weeks N]` now
summarizes explicitly supplied normalized host rows by function/model/source. It
preserves bytes, sums decimal USD strings exactly, leaves unknown token/cost totals
null, reports known subtotals/missing rows, and rejects duplicate IDs, unsafe labels,
credential/symlink paths, malformed input and invalid cached-token accounting.
Synthetic and compiled CLI tests exercise those outcomes and bounded period views.
The non-JSON terminal report now exposes function/model/source groups, input,
output, cached and derived uncached tokens, exact decimal USD totals and the
reporting window. Partial values explicitly show unknown totals with known
subtotals/missing rows; an empty window says unknown rather than zero spend.
Uncached counts require both input and cached counts on each row, so omitted
caching data is not silently treated as zero. Compiled CLI tests verify the actual
terminal table as well as JSON. This restores School's useful grouped terminal
view without importing its provider calls or falsely treating an export as full
account billing.
No host export discovery, format conversion, provider reconciliation or authoritative
billing verification is performed. Dogfood still delegates billing review; model
selection/budgets stay with the chosen host rather than being silently reimplemented.
After the preceding flows finish, public `dogfood resume --usage-file` now attaches
an explicit normalized export, replacing the default skipped cost step with a
mechanical summary pass. It preserves unknown costs, binds the export hash and
fixed current-month window, and explicitly reports no run attribution or verified
billing. Later ordinary/sweep resumes reread the saved export; a changed, missing
or malformed report fails closed, while restoring original bytes can resume safely.
Backend and compiled full-workflow tests verify the optional attachment, metadata-
only evidence, fixed-window/byte revalidation, early-input refusal and redacted
malformed-input failure. Export discovery, run correlation, provider reconciliation
and budget enforcement remain host-owned; a mechanical pass is not billing approval.

## Limits that remain explicit

An actual School-source audit confirms `simulate` calls `draftAssignment`, whose
writer derives an XLSX sibling from finished Markdown tables/computations. Canvas
now implements that behavior for new ordinary draft tasks using an explicit
workbookVersion 1 recipe; older tasks are not retrofitted. Completion binds both
artifacts, same-candidate retries check unchanged bytes, revisions inherit the
new recipe, and explicit approval copies the pair into Finals. A six-case
`scripts/audit-school-workbooks.mjs` audit executes actual School extraction and
writer functions on synthetic strings and matches sheet names and cell values.
Backend/compiled CLI tests verify inert formula text, naming/accounting conversion,
comment/fence exclusion, bounds, interrupted completion recovery, protected versions,
tamper rejection, paired approval and older-record preservation. A delayed compiled
retry caught wall-time dates on implicit ZIP directories; the writer now fixes all
entry timestamps, with new frozen records explicitly tagging rendererVersion 1.
Older unflagged companions retain their bytes and hashes through narrowly scoped
directory-date reproduction, not file/record rewriting. Tests verify that new records
reject that older rendering and legacy readers preserve it unchanged. New frozen
draft evaluations now persist the same explicit workbookVersion 1 recipe and
automatically save private output.xlsx on completion. Its hash, normalized input
and sheet inventory are bound to the saved candidate and immutable capture/recipe.
New receipts also bind the complete recipe hash; even a structurally coherent
recipe edit cannot rebind an existing completion. A clean installed-package smoke
test exercises ordinary/revised/approved and frozen automatic companions across
32 CLI commands. Completion JSON names ordinary workbooks, and approval JSON names
the Finals companion instead of requiring the host to infer its path.
Ordinary comparison/review now shares the completion workbook validator too,
rejecting missing/edited automatic companions before findings or new bundles.
Reports bind the companion path/hash and distinguish byte changes, additions,
removals, no extracted companion, pending work and uncaptured legacy evidence.
Backend and compiled CLI regressions check those states, preserve older records
and existing review files, and prevent missing-file repair by a review command.
This is explicitly automatic-completion-only evidence; ordinary explicit workbook
command artifacts still require separate inspection, and no academic score or
deliverable-completeness claim is made.
Completion/inspection/retry tests check unchanged files, lock ownership, symlink
refusal, interrupted matching writes, no-table/over-limit cases and older evaluation
preservation. A compiled delayed retry verifies output bytes across ZIP time ticks;
the compiled completion/show/inventory/comparison/M1 loop keeps human verdicts pending
and reports metadata rather than cell bodies. The combined inventory includes the
automatic candidate-bound artifact and explicit companions, reserves one of 20 slots
while a draft is pending and revalidates both kinds before gating. Missing/changed
completed workbooks stop retries rather than being silently repaired. Fixed evaluations
also support public `simulate task workbook/workbooks` with
explicit sheets/rows JSON and optional selected frozen source context. Companions
are private exclusive bundles, byte-reproducible and bound to normalized input,
output and frozen recipe hashes; existing incomplete/tampered/linked bundles or
locks fail closed. Backend/compiled tests verify XLSX structure, literal formula
strings, no macros, source scope, live edits not replacing fixed evidence, private
permissions, redacted input failures and row/column bounds. The ordinary workbook
reader now shares credential-file refusal and redacted bounded JSON parsing with
calculation inputs. New comparison/M1 bundles now capture the complete workbook
inventory, including empty inventories, and revalidate input/output/recipe/source
hashes plus deterministic XLSX bytes before gating. Added, missing or changed
companions require a fresh comparison; older bundles leave workbook evidence
uncaptured/unknown. Backend and compiled CLI tests verify private metadata-only
indexing, the workbook-to-comparison-to-M1 loop, empty inventory changes, modified
bytes refusing gates and unchanged old-format evidence. This closes the automatic
XLSX mechanics gap, not academic spreadsheet verification: no spreadsheet-grade, deliverable-
completeness or input-grounding claim is made. One unrelated prep acceptance timeout followed a large
wall-clock delay; the isolated rerun passed before continuing verification.

Auth verification now checks the actual bounded user-profile response, matching
School's profile-validation intent while returning only credential-free success.
An arbitrary HTTP 200 (HTML sign-in page, malformed/missing/invalid profile,
oversized payload or stalled stream) is not accepted as authorization. Synthetic
transport/CLI tests verify profile-shape checks, GET/no-redirect behavior, body
limits/deadline cancellation and redacted failure, while valid API profiles still
override stale local expiry hints. No real student account was used for this change;
successful auth is not proof of per-course Pages/Files permission or source coverage.

Fixed evaluation tasks now have public `simulate task calculate` single/batch and
`simulate task calculations` inspection commands. They reuse ordinary bounded
arithmetic while binding private numeric evidence to the immutable evaluation
recipe/snapshot and optional selected frozen source. Whole batches validate before
writing; locked exclusive atomic installation preserves prior records. Readers
recompute results, verify bindings and enforce record/byte/input bounds without
reading current course bodies. Synthetic/compiled tests verify the pricing $500
example, NPV, live-file edits not changing frozen results, unchanged recipes,
source-scope refusal, invalid-batch atomicity, tampering, symlinks, held locks,
private permissions, count limits and redacted malformed JSON. The shared JSON
input reader also hardens ordinary batches against credential-file reads and
parse-error content echo. Input grounding remains unverified; explicit arithmetic
inspection is not academic grading or historical authentication. New comparison/M1
bundles now automatically package the numeric records and revalidate their
inventory/recipe/snapshot/source bindings plus recomputed results. Empty inventories
are captured too; later additions, removals or modifications require a fresh
comparison rather than silently changing review evidence. Older bundles remain
readable with arithmetic explicitly uncaptured/unknown, not zero or verified.
Backend/compiled tests exercise the $500 record through comparison/M1, metadata-only
stdout, stale/modified/missing arithmetic refusal before gate creation, fresh-bundle
recovery and unchanged older comparison bytes. Input grounding, output-number
coverage, execution-time authenticity and human academic judgment remain unproven.

New academic workflow v3 closes a handoff-instruction gap relative to School's
explicit deliverable and correctness-review prompts. Drafts now ask for the actual
permitted response (not a guide/outline), executed quantitative verification and
source/rubric-based host self-review with explicit unverified gaps. Review mode
checks grounding without rewriting or approving work. Required heading structure
and course-permission boundaries remain unchanged. Saved ordinary v1/v2 workflows
and frozen v2 recipes retain their original instructions; frozen records version
the new workflow separately from source-selection/parser recipes. Tests cover
older recipe reads/completion, current JSON/TASK.md instructions and question gates,
plus substantive PENDING missing-source answers without fabricated citations.
This is a behavioral handoff, not automatic substantive grading or independent
host acceptance; the older Luna matrix does not verify workflow v3 quality.

Revision retries now compare freshly policy-checked source/guidance/student-work
snapshots and complete selected context before reusing an existing revision task.
Changing a student-edited Drafts file at the same `--work` path creates a new
handoff instead of silently returning the obsolete snapshot. The prior output and
earlier task records remain unchanged; unchanged retries still reuse the current
task, and newly restricted work fails before reuse. Backend and compiled CLI tests
exercise first edits, later edits, retained parent evidence and stable retries.

Local ingestion now accepts explicit `--as-of YYYY-MM-DD` availability independently
of the teaching `--week` and module link. Distinct dates preserve separate sidecars
bound to the same unchanged original. Synthetic capture/replay tests include an
available reading while excluding a later-declared version; invalid calendar
dates fail before writes. Omission does not infer historical availability, and the
date remains a student declaration rather than proof of past access or permission.

- This release has synthetic end-to-end verification, not live-account acceptance. A new student's Canvas permissions, external-hosted assets and course-specific conventions still need review before reliance.
- Scanned PDFs need OCR elsewhere; complex Office/PDF tables, equations and layout may not extract faithfully. Unsafe external file hosts are skipped; external downloads never receive Canvas bearer credentials.
- External DNS answers are checked for private/reserved addresses, but fetch does not pin the validated address; this is not a hardened server-side URL-fetch sandbox. Use a trusted Canvas configuration and review download notices.
- Undated modules are not guessed into a week. Select an exact session or associate a local reading with an explicit week. Review notices and source selection before generation.
- Date views and overrides are local; they do not change Canvas. ICS reconciliation supports UTC and date-only values, reporting unsupported timezone/floating forms. OS reminder integration is not reproduced here.
- Inspect/compare/review are provenance tools, not rubric grading. Simulation preserves current source versions filtered by explicit availability metadata; it cannot reconstruct historical file contents, past permissions or every past vault state. Replay requires a separately supplied prompt and policy check.
- Model selection, provider authentication, billing and costs belong to the host coding agent. No hidden model call is added to obtain command-name parity.
- The plugin is instructions-only; another host needs local shell/filesystem access and a separately installed CLI. Installing it is not a hosted mobile backend. Reading-copy refreshes write locally; cloud upload/account/sharing and unattended schedules are separate capabilities. Retained snapshots and Recovered versions require manual review if material becomes restricted or must be removed.

Existing v1 task records retain parsing compatibility. Vault files migrate only on explicit direction; changed source paths require fresh tasks rather than rewriting historical snapshots. Completion/approval remains local and non-overwriting; nothing submits to Canvas.

Group assignments now retain Canvas `group_category_id` in the synced prompt and
new ordinary/frozen assignment handoffs. Group-scope recipe v1 asks the host to
work only on the student's explicitly identified contribution and clarify missing
responsibilities before generation. It does not infer membership, team consent or
AI permission. Saved metadata is checked against the selected prompt snapshot;
frozen tasks cannot acquire newer live group context. Earlier unflagged recipes
remain unchanged. Synthetic tests verify bindings and instructions, not actual
host adherence or academic correctness.
