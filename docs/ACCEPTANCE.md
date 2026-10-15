# Student workflow acceptance — 0.4

## 2026-10-14 authorized preservation fixes and review handoff

After explicit owner approval, separate public School fix commit `e516124`
(`fix/preserve-prep-and-approved-finals`, local only) changes prep and Final
writes to preserve earlier bytes as numbered siblings. Exact-byte retries reuse
the existing artifact. Writer regressions plus real prep/approval engine tests
cover unmarked edits, matching course/period placement, saved answer preservation
and unchanged retries. School typecheck, lint and build pass; the full suite
passes 449 tests with one skipped. Lint emits informational suggestions, not errors.
The first focused run had two test-only failures from expecting an uppercase
course folder instead of the canonical slug; the assertions now use coursePaths.

A fresh packed two-product installation in owned fixture
`canvas-installed-coexistence-sJDMtV` verifies source/installed writer hashes.
School-first preservation passes; Canvas-first and legacy markerless vaults still
refuse School writes unchanged (the coexistence operator correctly exits 2 for
partial compatibility). Installed School CLI audit `canvas-installed-school-cli-4zWpw2`
then passes ten actual fresh CLI processes with native SQLite and a mocked model
factory, no network attempts: doctor, prep, draft, approval/retry, revision,
revision approval/retry, and edited prep rerun/retry. Original drafts, the original
Final and edited prep bytes survive. SDK resolves to 7.0.141 in this new local
installation; this is not the older pinned baseline installation or a registry
release. Live sync/provider, approval-tool and academic-quality acceptance remain
outside this check. Earlier failing public-baseline evidence is not relabeled.

Canvas full regression passes again: 773 tests in 108 files, 75.73 seconds,
two workers and explicit 20-second test/hook allowances. Typecheck, lint,
context/build and whitespace checks pass. The owner authorized Canvas commit/push
for review. The fresh installed Canvas package smoke also passes all 153 commands
with zero dependency-audit findings. This does not exercise a real Canvas account
or host plugin. The authorization is
for review, not merging or making either repository public. Real student vault,
credentials and private School checkout are untouched.

Initial release verification used synthetic Canvas responses and isolated temporary vaults, not a live student's account. Those tests did not use production course files or credentials.

After the initial release, the owner explicitly authorized a read-only live Canvas smoke test using existing local credentials and a separate temporary vault. It reproduced disabled Pages (404) and forbidden Files-list (403) responses despite successful authentication. Sync now reports those coverage limits and retrieves independently accessible module-linked pages and files. The live rerun retrieved module pages, PDF/DOCX originals and extracted text; course-wide list access remains unavailable. Existing coursework and credentials were unchanged. This is one-account sync verification, not live academic-content or new-student acceptance.

## Automated gates

### Real Git mid-import interruption and primary-work continuation — 2026-10-14

The new POSIX-only regression uses a test-only Git wrapper inside an owned
temporary fixture. It starts the actual installed Git, feeds only part of a
bounded fast-import stream, and waits for a newly created pack file. The parent
confirms Git is alive, then SIGKILLs only its detached, explicitly identified
test process group. This is not an injected JavaScript exception or a timeout
assumed to mean stopped. All input files, configuration and Git storage are
invented and temporary; no real vault, credentials or external Git repository
are used. The wrapper is a test fixture, not shipped in the CLI package.

After confirmed termination, all existing store bytes and the previous branch
reference remain unchanged, current edited vault files remain exact, and real
Git retrieves the original reading from the earlier snapshot. The left-behind
history lock and incomplete files are preserved during inspection. Status
reports locked with no liveness claim; a snapshot retry refuses instead of
deleting/adopting/repairing history. A fresh compiled CLI ingest then succeeds
with its original/sidecar saved and prior vault files unchanged, while warning
that the configured history hook failed. The store is byte-identical across
that continuation. This verifies preservation and continued primary work, not
automatic stale-lock recovery, universal interruption safety or a paused goal
controller. The owned synthetic fixture is cleaned after the test.

The initial harness attempt ends before its checkpoint and is not counted as
fault acceptance. Canonicalizing the wrapper's store path fixes the temporary
OS-alias mismatch; the corrected real interruption test passes. The full suite
then passes **773 tests/108 files** in 73.83 seconds with the existing two-worker,
20-second test/hook settings. An additional primary-ingest continuation assertion
is added afterward and passes the focused fault test in 825 ms; no production
CLI behavior changes in this turn. Typecheck/lint/context/whitespace checks pass.
The prior installed 153-command smoke remains the current runtime package gate.

A read-only remote recheck also confirms Canvas is private, the parity branch
still points to 0a34cc865c21a6cec705ddb32cf85b710d93f28f, and no PR exists for
that branch. Public School main remains b22c8e2a798e2acdf7e6cc63d6c7659788635b0d;
its local public checkout is clean. These are point-in-time checks, not publication
or approval. The owner's requested decisions on separate School fixes and
Canvas commit/push are still unanswered; automatic goal continuation is not
new authority for either operation.

### Current plug-in context, native frozen draft and fresh recovery — 2026-10-14

The current guidance now has fresh native-context evidence, using the documented
[local marketplace workflow](https://developers.openai.com/plugins/build/plugins)
and [non-interactive JSONL workflow](https://learn.chatgpt.com/docs/non-interactive-mode),
checked against installed codex-cli 0.162.1. This is CLI/app-server testing, not
Desktop UI or other-host acceptance.

Fresh credential-free mock-provider run canvas-codex-plugin-vWH7vf passes five
requests: all three complete installed skill bodies, complete project AGENTS,
and complete combined AGENTS/assignment-skill context. It checks current source
bytes rather than a preceding skill version. No real model or tools run in those
probes. This proves captured injection for these explicit probes, not semantic
attention or the raw authenticated request in the separate real-model test.

The previously authorized temporary login home receives a local-only plug-in
refresh in canvas-native-plugin-refresh-tglmjO. All seven cached files match
current source and packaged instructions. Its previous code-only plug-in is
retained under that root's prior-plugin before removal/reinstall. Authentication
file inode/size/mtime are unchanged during refresh; the script never reads,
copies, hashes or prints credential contents. Native runtime authentication may
refresh its own login later. Normal user settings/cache are not modified.

Matching-cache native run canvas-host-frozen-draft-l3Cv3t requests exact
gpt-6-luna and uses an actual isolated CLI installation. It discovers existing
task 4151acbf-42d5-45f4-b181-ef55889c20be and capture
be88ac93-2d92-4ee6-aca9-a0bb402a302a without supplied IDs/answers. It reads
task scope/workflow and saved synthetic permission, authors the actual Part 2
deliverable and completes the SAME frozen task. It uses installed topic lookups
for calculate/frozen, with no documentation-path failure. Its first ordinary
task listing is empty despite the requested frozen scope; this discovery detour
is retained, not treated as a successful ordinary recovery.

Of 26 completed command groups, two exit 1: the first candidate fails the exact
question's substantive-answer/source-citation gate; the next cites marginal-analysis
outside the selected task sources. The agent corrects both without editing task
recipes or source files. These are structural/source-selection failures, not an
academic assessment, and they are not erased by the later pass. All six derived
operations execute in one bound frozen batch: 50-30=20, 600*20=12000,
12000-8000=4000, 8000/20=400, 600-400=200, 1000-600=400. The final numeric
check passes. Its conditional recommendation distinguishes forecast demand from
observation and flags unquantified effects; no universal semantic grade is claimed.

The final saved output hash is
f9599805a28ee105cdd922d618c3392d78b69871e9ac57b1004ee4d2ae637e86,
with state completed-pending-human, never approval/submission or a human pass.
Parent rehashing confirms all eight original vault files—including immutable
capture/task/handoff and five live fixture files—remain byte-identical. Only
three private calculation/completion/output files are added. The model's five
file-change events add/revise candidate, batch and report outside vault; saved
artifact writes go through the CLI.

A fresh ephemeral read-only native session, native-recovery-a6Lm9S, discovers the
same task/capture using the current installed CLI and matching cache. Parent
inspection confirms actual simulate task output execution (not --help), exact
saved text/hash and outputIntegrityVerified true with academicCorrectnessVerified
false. All eleven vault file paths and byte hashes remain unchanged and there
are zero model file-change events. Of 17 command groups, one literal topic query
for “frozen draft output” finds no match; it is reported and recovered using other
lookups. The initial ordinary completed-task listing is another empty scope
detour. Frozen top-level completion state is correctly distinguished from the
immutable recipe's pending status; no recipe is repaired or rewritten.

Recorded runtime usage, not authoritative billing: forward 489708 input /
443136 cached input / 7822 output; fresh recovery 197705 input / 149760 cached
input / 2345 output. Actual USD charge is unverified, not zero. No credential
contents, real Canvas account/coursework/vault or ordinary settings/cache are
accessed by the audit scripts. These selected source-preserving forward/recovery
results do not prove raw authenticated context injection, reviewer independence,
all-workflow/other-host adherence, live-source disappearance, actual paused or
mid-generation goal-controller recovery. Live synthetic course files remain
present during this forward run; the frozen CLI/snapshot binding is checked, not
a new native disappearance fault. Broader acceptance/coexistence/release gates
remain open. This turn changes audit documentation, not CLI behavior; the latest
772-test/153-command runtime gates remain the preceding recorded runs.

### Read-only history readiness and doctor integration — 2026-10-14

`vault history status --json` now distinguishes never-configured/disabled, ready,
empty, locked, unusable Git and unsafe control/store/object metadata. It creates
no locks, snapshots or repairs and reads no current vault document bodies. Ready
requires readable latest commit/tree and all latest saved blob headers within
the same bounds, not every historical body or proof that current edits were
captured; the full-history integrity/currentness flags remain false. Disabled
history needs no Git and makes no retained-store integrity claim. Locks indicate
unknown readiness, not process liveness or permission to delete them.

Full/offline doctor and vault health reuse the history module's diagnostic
result. Enabled backup failures are errors, while empty/locked are warnings;
doctor --sync-only omits the optional backup check rather than claiming a Canvas
auth failure for absent Git. Direct status exits nonzero only for unsafe or
unavailable readiness. No command installs Git or silently changes configuration.

Six new synthetic tests exercise source and compiled CLI diagnostics, including
empty PATH, unchanged byte/directory inventories, an unsaved credential-named
fixture ignored by the metadata-only inspection, retained disabled history,
malformed state, a held lock and a deliberately forged saved tree whose blob is
missing while its commit/tree remain readable. The three focused files pass
29 tests. The full run passes **772 tests/107 files** in 73.80 seconds with two
workers and unchanged 20-second test/hook allowances. The locally packed
installation passes **153 commands**, including ready/disabled/missing-Git status;
its dependency audit reports zero findings. Typecheck/lint/build/context and
whitespace checks pass. No real vault/account, School source, native host cache,
source commit, remote or publication state was changed.

### Optional local vault history — 2026-10-14

A source comparison found a previously unlisted School feature: VaultWriter
uses LocalVaultGit to commit changed local writes when gitInit is enabled, and
the public vault regression checks unchanged retry stability/no remotes. Public
setup explicitly disables it for new users; the legacy schema defaults omitted
gitInit to true. No School source or real vault was changed during this audit.

Canvas now implements `vault history enable --directory ABS_NEW_PRIVATE_STORE`,
snapshot/list/show/export/disable and same-store re-enable. Its external private
bare Git store is explicitly opted into, never a student's existing `.git`.
Snapshots preserve text/binary bytes and deletions in prior commits, with
metadata-only discovery and exports to separate new non-executable files.
Known mutating command actions capture retained changes on success or failure;
an actual conflicting-sidecar ingest failure keeps exit 1, preserves the sidecar,
and snapshots the original that was already written. History failure never
converts the primary result into a success or claims a successful backup.
Default-off and config-free documentation reads do not trigger capture.

Eight synthetic regressions exercise history stability, binary/deleted-file
export, original/current preservation, disable/re-enable, foreign/symlink/bounds/
credential refusals, existing vault Git preservation, hook/alternates/config/lock
rejection, poisoned inherited Git variables, compiled automatic ingestion,
partial failure, invalid config and config-free discovery. Both the source
interface and compiled CLI are exercised. All **766 tests/106 files** pass in
75.89 seconds with two workers and the unchanged 20-second test/hook allowances.
The actual locally packed installation passes **150 smoke commands**, including
ten new history lifecycle/automatic-capture/export checks, with zero dependency
audit findings. Typecheck, lint, build, context and whitespace checks pass.

The shared discovery hint is synchronized across AGENTS and all three skills;
the assignment entrypoint is 7492 bytes, under its 7500-byte bound. The retained
native plugin cache/model evidence predates this changed shared block; no new
native injection/attention or model trial is claimed. Local history is not a
cloud reading copy, a credential sanitizer, authenticated availability evidence,
full transaction isolation or unlimited-size backup. Bounds are 50 MB/file,
64 MB aggregate, 10,000 inventory entries/depth 64 and 40,000 store entries;
oversized/unsafe inventories fail rather than omit documents. No history import,
destructive checkout, publication or real-account access was performed. Git
mid-import process interruption is not yet accepted by a fault-injection test.

### Failure evidence and isolated broad-gate recovery — 2026-10-14

The previously reported acceptance, custom-guidance host-v3 and frozen workbook
failures do not reproduce in a subsequent serial run of all three files:
40 tests pass in 16.05 seconds. The exact prep case also passes alone in 677 ms.
This establishes those executions, not the precise cause of earlier delays.

The package operator now records every child start/finish in a private 0600
`commands.jsonl`, with command metadata, terminal status/signal/error and elapsed
time. Arguments over 512 characters are represented by size/hash; environment
values and stdout/stderr bodies are not written to this journal. All inputs are
synthetic. Failed runs retain their owned temporary installation/vault/journal
and print its location; successful runs still remove only that owned fixture.
An intentionally empty PATH exercises an actual npm-launch ENOENT, confirms both
journal events and retained fixture, and confirms a private environment sentinel
is absent from output/journal. The manual retained fixture is
canvas-agent-package-SQPtCX; the new automated regression additionally checks
terminal status, event identity, private permissions and environment exclusion,
then cleans its own verified synthetic fixture. That regression passes in 56 ms.

A subsequent non-concurrent full installed smoke passes **140 commands**,
including installed topic excerpts and unknown-topic refusal, saved-output
recovery, ordinary/frozen task flows, worksheets, custom guidance and preserved
ingestion. The installed dependency audit reports zero findings. This is a
locally packed synthetic installation, not a published release, live Canvas
acceptance or native model trial. Earlier failed runs are not relabeled passing.

The following full regression run passes **758 tests across 105 files** in
71.68 seconds using two workers and the existing explicit 20-second test/hook
allowances. No test assertions or timeouts were relaxed for this recovery.
Typecheck, lint, context consistency and whitespace checks also pass. This
supersedes the unresolved broad-runtime gate at the earlier checkpoint below,
not the separate real-student, native-host, phone/Drive or publication gates.

### Installed CLI topic lookup — 2026-10-14

`instructions --topic PHRASE --json` now returns literal case-insensitive
matching CLI paragraphs, intact fenced examples, exact source line ranges and
the existing installed path/hash index. Metadata-only discovery is unchanged;
neither form reads student config, dotenv, credentials or vault files. Missing,
invalid and over-broad queries fail instead of silently truncating guidance.
Excerpts are explicitly incomplete and do not replace applicable skills, saved
tasks, related rules or student permission. This addresses a documentation-path
guess seen in the retained interrupted-author recovery; it is not evidence of a
new native host trial or universal agent adherence.

Targeted instruction/context tests pass (22 tests reported by Vitest
across two files), as do typecheck, lint, build, context consistency and whitespace
checks. The package-smoke run passes its new installed lookup and unknown-topic
refusal assertions before timing out later on `simulate task list --course
SWEEP101`; the overall package run is **not passing**. Its normal cleanup removes
the owned temporary package fixture. The broader two-worker regression run reports
failures in host-v3 acceptance and simulation-auto-workbooks and is stopped with
exit 143; it is **not a green regression result**. The machine's observed one-minute
load exceeded 70 during these runs, but that observation does not independently
establish the cause of every failure. No timeout assertions were relaxed, no
unrelated processes stopped, and no School source, real vault, credentials,
normal plugin cache or GitHub state changed. A clean broad rerun
was still required at that checkpoint. A subsequent one-worker retry also reports a slow
acceptance-test failure (773545 ms for the failing test) before being stopped
with exit 143; it does not establish a clean regression result either. The
focused one-worker instruction/context rerun passes all 22 tests in 513 ms.
The prior 755-test/138-command pass applies to the
preceding runtime, not this new lookup change.

### Interrupted native authoring followed by fresh completion — 2026-10-14

The native forward operator now has a POSIX ordinary-prep test mode requiring
matching current plugin bytes: --interrupt-after-candidate. It monitors native
JSONL file-change events, records the saved task state and candidate hash, then
SIGKILLs only its detached child process group at the completed candidate-write
event, before task completion. The controlled fixture is invented coursework in
an owned temporary root. This is fault injection at a specific host checkpoint,
not an interrupted Markdown write or actual goal-controller pause.

Run canvas-host-ordinary-prep-448oJG reaches the checkpoint for original task
0b59d6ea-6255-41ac-a1fa-54fc22556095. The native process is terminal with SIGKILL,
not inferred stopped from a timeout. All seven original vault files—including
pending task.json and TASK.md—remain byte-identical. The interrupted candidate
cf1be1da6597f6306f92833002485787367abb40c368d1f1e5582a245809d9c2
is retained outside vault. Nine completed pre-interruption command groups exit
zero; no turn.completed is fabricated. Its eleven saved arithmetic records survive.
The process termination removes no material files, normal settings or credentials.

The recovery operator's explicit --resume-pending mode accepts only a verified
interruption receipt and ordinary pending prep. It starts a fresh ephemeral
gpt-6-luna session in native-recovery-AfRyyB, without IDs, answers or transcript,
using matching plugin/current installed CLI and a new candidate workspace.
Scoped --add-dir permissions cover only the synthetic private metadata and Prep
destination; no explicit write grant is added for the old host workspace/candidate.
This is not a proof about every platform-default temporary-directory permission. The
model must discover and finish the same task, not create a replacement. This uses
the documented [CLI scoped-write/event options](https://learn.chatgpt.com/docs/cli/reference)
and [non-interactive workflow](https://learn.chatgpt.com/docs/non-interactive-mode),
checked against the installed CLI help. The active thread goal was not paused.

The fresh host completes the same UUID and saves
ECON901/Week 02 - Oct 12/Prep/01 Prep Brief.md with verified hash
f33833571131d6924659570d0640fba74936e334582fe50e86707fb158944ea5.
All original source/guidance/handoff bytes and the interrupted candidate survive.
Parent hashing proves the prior calculations JSONL remains an exact byte prefix:
eleven records retained, eight appended, nineteen total. Expected task/output/
arithmetic changes mean vaultUnchanged is false; it is not falsely reported as
read-only recovery. The terminal native exit is zero and turn.completed is present.

This is not clean first-pass adherence. One of sixteen completed command groups
exits 2 after guessing a parent-relative CLI reference path instead of using its
actual installed child-workspace path. The host reports that error and an
absolute-path apply_patch refusal before retrying with relative paths. The JSONL
exposes the failed command group and a successful file-change event; the separate
patch refusal is a host-reported limitation, not an invented extra failed shell
group. Those artifacts remain private and are not erased by eventual success.

Recovery runtime counters: 379847 input / 330752 cached / 7826 output tokens,
not verified USD charges. Interrupted-turn usage is unavailable, not zero. New
operators journal outcomes even when pending recovery has no completed output;
stream decoding and close handling protect the interruption monitor's logs.
Runtime source code is unchanged in this increment; prior 755-test/138-command
gates remain the last runtime checks, with current operator typecheck/lint/context
and whitespace checks passing. This proves one selected native process-interruption
and fresh-authoring recovery, not all modes, mid-generation controller recovery,
academic correctness, live Canvas/student acceptance or publication readiness.

### Matching active native plugin, forward prep and fresh recovery — 2026-10-14

The maintainer operator `refresh-isolated-plugin.mjs` now archives the seven
allowlisted prior plugin files before using native remove/add commands only in
the previously authorized temporary Codex home. The local marketplace is likewise
replaced there; normal user settings/cache are outside scope. Credential contents
are never read, copied, hashed or printed. The refresh checks auth file metadata
before/after, not token contents. The successful audit root is
canvas-native-plugin-refresh-me2oLH, with the old code in prior-plugin. Current
cache files match source byte-for-byte. This removed only the isolated old plugin
cache after its recoverable archive, not the ordinary user's installation.

The OpenAI Docs workflow used the official [plugin packaging/marketplace guidance](https://developers.openai.com/plugins/build/plugins)
and [non-interactive exec documentation](https://learn.chatgpt.com/docs/non-interactive-mode),
with commands verified against local Codex 0.162.1 help. The new forward operator
flag --require-current-plugin compares all seven cached files with source AND
the installed CLI's bundled plugin, and compares workspace AGENTS with the
installed package before requesting gpt-6-luna. It does not intercept authenticated
requests or certify semantic attention/equal authority from byte equality.

A fresh credential-free mock installation, canvas-codex-plugin-kWqK7a, repeats
five native app-server turns. All three complete skill bodies, complete project
AGENTS and combined AGENTS/assignment skill reach the mock provider with no tool
calls. This is exact mock request-injection evidence, not raw authenticated
request capture or real-model correctness. The separately authenticated cache now
has those same current source bytes rather than the earlier stale installation.

Actual forward run canvas-host-ordinary-prep-CWkU4d discovers and completes original
task a50c81ae-9cbf-4b61-8710-fa33f1f32a72, saving
ECON901/Week 02 - Oct 12/Prep/01 Prep Brief.md with hash
3b8857225db35fde3274c74a1bbc06dfb4d4479a4b159bb1f257784fd97775bc.
All fifteen completed command groups exit zero; one reads the matching cached
skill. Seven arithmetic operations cover contribution, revenue/cost, scenario
profit, break-even and incremental comparison. All six original source/guidance/
handoff files remain byte-identical; task.json is the only original file whose
hash changes, as expected for its recorded completed state.
The host states conditional profit/limitations and no failed steps. Integrity and
validation are not an academic grade or verified instructor permission.

Fresh ephemeral read-only recovery native-recovery-N4wcoi uses a new installed
current CLI, with the same matching cache verified again, and no supplied IDs,
answers or transcript. The recovery operator no longer hardcodes a stale-cache
claim; verified matching and unverified cases are distinguished. Parent parsing
requires the exact original UUID-bound task output invocation, not --help or a
filesystem guess. Returned text matches the original saved output byte-for-byte
with outputIntegrityVerified true and academicCorrectnessVerified false. All
eleven completed command groups exit zero, no model file-change event occurs,
all nine vault files remain identical, and the turn completes successfully.
This is directed saved-work recovery, not paused/mid-generation controller proof.

Forward runtime usage is 372993 input / 314368 cached / 6538 output; recovery is
279459 input / 248320 cached / 3548 output. These counters are not reconciled USD
billing. Private prompts/events/reports/install metadata and parent assertions
remain outside the repository. Source runtime code is unchanged in this increment;
755-test extended-timing / 138-command installed gates remain the last runtime
checks, with current operator typecheck/lint/context/whitespace checks passing.
No real coursework, Canvas account, normal config/cache, Git commit or publication
is touched. Auth may be used/refreshed only by the native runtime in the isolated
login; no claim is made about raw real-request injection or other coding hosts.

### Companion-bound recovery and compatible cutoff visibility — 2026-10-14

New compatible source snapshots retain an optional exact sibling companion
path/hash in SourceRecord and the task schema. Workspace reads verify full-document
hash, companion/document availability agreement and the original's exact directory,
filename recipe and digest prefix before using its existing full-original hash check.
Pending prep/assignment completion and source selection/capture checks reject
companion-only byte changes. Old recipes without that field remain readable and
are not silently rewritten or retrospectively certified as companion-bound.
Frozen captures preserve the recorded binding and never reopen live provenance
or originals during replay/task recovery.

The first focused run exposes two failures: the expected invalid-task error wording
was wrong, and frozen capture actually excluded compatible imports despite explicit
as-of dates. The latter is fixed by using only verified companion availability as
a logical available_at signal, not interpreting every ordinary created_at value
as proof of release. Contradictory duplicate signals refuse visibility. Related
filename parsing now excludes the .as-of date before both legacy and compatible
suffixes, preventing an October 12 class source being selected as October 5 class
material solely because it became available then. An earlier cutoff can still
capture that confirmed available reading for the explicitly requested later class.

Seven new regressions prove byte-bound selection, prep/assignment stale refusal
with pending recipe preservation, companion-only date/original-redirection refusal,
old unbound recipe completion without backfill, captured-binding recovery after
live original/companion removal, exact sibling-scope validation and separated
teaching-week/cutoff semantics. The full suite passes 755 tests / 104 files using
two workers and explicit 20-second test/hook allowances, 71.34 seconds, with
typecheck/lint/build/context/whitespace verification. Existing IDs and sources are
not repaired, regenerated or deleted by these changes.

Final installed package smoke passes 138 commands, including actual installed
prep/show and capture/replay roundtrips with companion hashes. One prior packing
attempt correctly fails its byte-for-byte reference check because the maintainer
edited the CLI reference during packaging; its failed result is not green evidence.
The rerun holds package inputs stable and passes. Current installed format audit
canvas-installed-formats-ONKKws also passes 70 processes, retaining seven-format
actual School parser/reader and Canvas context compatibility. These are synthetic
source/installed tests, not native mid-generation goal recovery, authenticated
historical availability, real coursework, live provider or publication acceptance.

### Explicit School-compatible local ingestion — 2026-10-14

The reverse-read gap now has an explicit supported mode: `ingest ...
--school-compatible --ai-policy allowed|prohibited --redistribution allowed|restricted`.
Both declarations are mandatory; no course/API default grants eligibility or
redistribution. A mapped numeric course and safe configured origin are required.
The formatting module centralizes validation and uses the existing portable
document renderer for exact School YAML. Provenance is a separate bounded,
hash-bound .ingest.json companion: original path/hash and optional student-confirmed
availability, with no policy/status override. Local IDs are manual content/recipe
identities, not invented Canvas file IDs. Originals, native extraction sidecars,
old recipes and student edits are preserved; changed policy declarations produce
new variants, not overwrite permission. Relaxing restrictive original metadata is
refused; equally restrictive copies remain possible and excluded from new context.

The first installed prototype, canvas-installed-formats-bbdeic, correctly fails
School's strict schema for extra original/provenance YAML keys. It is retained,
not relabeled successful. The corrected mode keeps those facts outside School
YAML. Hash-stale/missing companions omit the extracted body from fresh Canvas
context; restrictive or unsafe compatible declarations also prevent linked raw
text and older variants bypassing the hold. Edits remain on disk, with an explicit
stale-provenance notice on retry rather than automatic metadata repair. Exact
identity/policy/date/provenance conflicts refuse without replacing artifacts.
School itself does not enforce Canvas's companion checks or establish permission.

Installed runs canvas-installed-formats-Z1TRAM and -GbvN2r pass the explicit mode;
the final current-build run -bYRJwN repeats the stronger checks after strict-original
retention support. The latter two execute 70 processes: two npm pack/install
commands and 68 actual product CLI processes. For PDF/DOCX/PPTX/XLSX/HTML/TXT/MD,
the actual installed School parser AND retrieval reader accept every new compatible
artifact; School content hashes and companion full-document/original hashes match,
installed Canvas context recovers the bound original provenance, and all earlier
bytes/retries are preserved. Legacy sidecars remain intentionally unchanged and
still fail School parsing; passing status is expressly the new declared-policy mode,
not automatic migration or universal old-vault interoperability. Unsupported/scanned
fixtures still retain bytes without a usable extraction claim. No provider or live
Canvas account is used; sync is mocked and this is not academic correctness.

Eleven new regressions exercise canonical metadata/body hashes, old task/edit
preservation, restrictive flags/raw-original holds, unknown/malformed original
policy refusal, equally strict retention, changed identity/provenance conflicts,
variant preservation, missing/stale companions and actual compiled CLI declaration
refusals. Final full suite passes 748 tests / 103 files with two workers and explicit
20-second test/hook allowances (69.86 seconds), plus typecheck/lint/build/context
and whitespace gates. Final installed package smoke passes 134 commands, including
compatible ingestion/retry/declaration refusal with old task/source preservation.
No real vault, School source, normal configuration, Git commit or publication changed.

### Installed local-file format and reverse-read audit — 2026-10-14

The explicit operator `scripts/audit-installed-formats.mjs` accepts only an owned
temporary School installation from the coexistence audit, packs/installs current
Canvas in a fresh private workspace and seeds a School-first synthetic vault with
the installed School writer. Installed Canvas sync uses mocked GET responses to
enable preserved namespaces; ingestion itself runs through both actual launchers
in fresh processes with scrubbed environments and denied fetch. This is not live
Canvas, provider, published-release or academic-quality acceptance.

Ten invented fixtures cover selectable-text PDF, DOCX, PPTX, XLSX, HTML, TXT and
Markdown, plus legacy XLS, unknown binary and a PDF with no selectable text. These
are minimal extraction fixtures, not broad corpus or visual-layout verification.
For seven supported types, both actual CLI ingestions succeed; School reads its
own extracted artifact, and installed Canvas context inventories both products'
text. Original external input hashes, Canvas binary-copy hashes, existing vault
bytes and retries remain unchanged. Canvas writes only its preserved namespace;
School's manifest changes only during School ingestion, as expected. Unsupported
cases are refused by School before vault changes; Canvas retains original bytes
without claiming usable extracted text.

The first run, canvas-installed-formats-LQ82IV, stopped on an overstrict harness
assertion: Canvas retry intentionally adds a preserved-sidecar notice, so retry
JSON is not identical. The directory/journal remain retained. Corrected runs
canvas-installed-formats-jKKyuj and -qzMzEZ execute 49 processes each, including
two npm packaging/install commands and 47 actual product CLI processes. Both
finish partial, exit 2. The latter records eight installed artifact hashes and
also calls the actual School retrieval reader, not merely a parser-shaped mock.
All five recorded School artifact hashes match the built temporary public checkout
at b22c8e2a798e2acdf7e6cc63d6c7659788635b0d; its Git HEAD was checked directly.

The remaining reverse-read gap is real: every native Canvas ingestion sidecar
lacks required School metadata; both installed School parseVaultDocument and
readVaultText reject all seven with VaultDocumentError. It is not safe to call
this complete two-way format interchange. Canvas can read School's artifacts,
but the opposite direction is unfinished for locally ingested files. Fix the
Canvas ingestion contract while preserving original/hash/availability/module
bindings, existing edits and old saved recipes; do not invent AI eligibility or
redistribution permission merely to satisfy School's schema. No School source,
real account, normal config or student vault was changed. Current source gates
remain the earlier 737-test extended-timing run and 131-command package smoke;
new operator lint, typecheck/context and whitespace checks pass separately.

### Explicit read-only School index diagnosis — 2026-10-14

Canvas now exposes `vault reconcile-index --school-index ABS_PATH --course ID
[MORE_IDS] --config PATH --json`, closing the public School diagnostic-command
gap without adopting its config or selecting all indexed courses. It requires
an existing outside-vault index, supported schema and numeric course scope.
Matching metadata distinguishes unique/ambiguous relocation, concluded/deleted
index records, missing validated local identities and identity conflicts. It
never opens outside-vault indexed documents, applies relinks or contacts Canvas.
Both the installed writer's actual `_index.md` manifest type and legacy `index`
are supported; URL origin/resource/course checks prevent cross-course matches.
This is local classification, not proof of remote absence or authentic authorship.

An early synthetic prototype query exposed a SQLite limitation: opening an actual
School WAL-mode database read-only can create its original WAL/SHM sidecars.
Those synthetic files remain retained; the prototype is not zero-mutation evidence.
The final implementation copies bounded database/WAL bytes through non-following
descriptors to a private temporary directory, checks both against fresh source
hashes and queries only that copy. Hot rollback journals or observed concurrent
changes refuse before querying. Normal exit removes the copy; abrupt process
interruption can retain private temporary data. Snapshot checks do not prove the
live index remains current, eliminate every ancestor race or authenticate metadata.

Thirteen focused regressions pass across the diagnostic and snapshot modules,
including actual compiled CLI scope/refusal, canonical writer manifest types,
duplicates, user-owned exclusions, malformed YAML without content echo, mismatched
origins/resource IDs, outside-vault paths, unsupported schemas, linked metadata,
bounded-source refusal, deleted/null paths, closed WAL databases and committed
live WAL rows. Source database/WAL/SHM bytes and directory inventories remain
unchanged in the snapshot cases. A compiled diagnostic against the retained
installed School CLI synthetic vault also returns no findings and preserves all
original index/sidecar bytes. Typecheck, lint, build and context checks pass.
The isolated installed package smoke passes 131 commands, adding diagnostic
success and missing-scope refusal while checking source database/document bytes.

The first full default suite run reports eleven timeouts and a related cleanup
race (723 passed / 734 tests at that point). A two-worker retry also hits timing
failures and is explicitly stopped, terminal exit 143, before changing the core
implementation. Neither run is green. Full post-snapshot verification uses the
same assertions with an explicit longer timing allowance; its result must be
recorded separately. The final post-snapshot command
`npm test -- --maxWorkers=2 --testTimeout=20000 --hookTimeout=20000` passes all
737 tests / 102 files in 69.12 seconds. Assertions are unchanged; this is a
passing extended-timing run, not a claim that the default timing run passed.
No real student vault or School source was touched.

### Installed public School CLI lifecycle — 2026-10-14

The new explicit operator `scripts/audit-installed-school-cli.mjs` accepts only
an owned temporary School installation produced by the coexistence audit. It
rebuilds native better-sqlite3 there and seeds invented sources with the installed
writer and index APIs. The actual installed launcher, config loader, prep/draft/
revision/approval engines, durable run store, writer and SQLite database execute
in fresh CLI processes. A Node preload replaces only the AI SDK gateway factory
with the installed SDK's MockLanguageModelV4; no real provider or Canvas sync is
tested. Responses are text-only, so this does not test model approval-tool calls.

An initial run, canvas-installed-school-cli-B2bWq3, correctly rejected the fixture
for missing Agenda: the generic writer's title-based guidance filename was not
the exact prep-guidance.md name read by the engine. That failed directory remains
untouched. The corrected operator asserts the installed requirements resolver
actually selects the four declared custom sections before running the CLI. It
also records a command journal after each process, including terminal failures.

Corrected runs canvas-installed-school-cli-vg2Rnq and -ZYikyO each execute eight
successful CLI processes: offline sync-only doctor, explicit-week prep, draft,
approval, approval retry, revision, revision approval and prep rerun. The latter
run removes the student-edit marker from revision feedback, so the mock's input
assertion can succeed only if the saved edit reaches generation independently.
Mock call journals include valid prompt SHA-256 hashes; the revision generation
and self-review are distinct calls. The package is locally packed public School
0.1.1, with installed AI SDK 7.0.140, not a published-release download.

Both reports deliberately exit 2 with preservation-gaps-found. Original Draft
bytes and student edits survive revision; approval retry preserves Final bytes.
However, revision approval replaces the prior Final and explicit prep rerun
replaces hand-edited prep. Prior bytes are retained separately outside the
synthetic vault for inspection. No fetch attempts are recorded during the CLI
flow. Temporary npm installation/rebuild is not an offline operation. Reports,
mock inputs' hashes and command journals remain private outside the repository.

This extends the source-engine audit to selected actual installed CLI mechanics;
it does not establish academic quality, live auth/sync, all-format interoperability,
mid-generation goal recovery or complete release acceptance. No School source,
real vault, normal configuration, credential, Git commit or publication changed.

### Native saved-output command recovery — 2026-10-14

Two fresh ephemeral read-only Codex 0.162.1 / gpt-6-luna sessions used the current
locally packed CLI in separate child workspaces against earlier saved synthetic
tasks. The operator now explicitly asks for the applicable read-only task output
command, not filesystem guesses. IDs, previous answers and transcripts are still
withheld. This is directed command acceptance, not an unprompted discovery test.

Prep run native-recovery-IL2hXv executes task output for original task
c0f88048-48b7-4e74-b983-b0ef53ac05d3; frozen run native-recovery-ObUrYI executes
simulate task output for original task 332c4b30-b5c6-4827-8b9d-0ff28a9c25df.
Parent parsing selects the actual UUID-bound invocations, not --help: both return
outputIntegrityVerified true, text exactly matching disk and the original saved
output hash, with academicCorrectnessVerified false. Both preserve the recorded
state and quantitative/evidence limitations. Ordinary prep has no persisted human
verdict field despite the host's phrase "human verdict remains pending"; frozen
completion explicitly retains pending-human. Do not infer a new verdict or approval.

All ten prep and twelve frozen completed shell groups exit 0. Both processes finish
with turn.completed, zero file-change events and all nine/twelve vault files
byte-identical, with no added/deleted file. The real-session reports no longer
claim the output is missing after guessing a different workspace path. Earlier
failed/misleading reports remain untouched; these two passing directed runs do not
erase them or establish universal host behavior, academic correctness or interrupted
goal-controller recovery. The active authorized plugin cache remains unrefreshed;
current packaged guidance is read directly via the CLI's discovery paths.

Private prompts/events/final reports/package metadata and whole-vault comparisons
remain in those run directories. Runtime usage: prep 211280 input / 178432 cached /
2435 output; frozen 275452 input / 245248 cached / 2930 output, not verified USD
billing. No real coursework, Canvas access, normal user config or credentials
were mutated. Source gates remain 724 tests / 100 files, latest package smoke 129
commands, plus current lint/typecheck/context/whitespace verification.

### Frozen retrieval descriptor and growth boundary — 2026-10-14

The shared frozen task-text reader no longer uses path readFile after a size check.
It opens a non-following/nonblocking descriptor, verifies that descriptor is a
bounded regular file, and reads at most limit+1 bytes. Buffers start at the checked
size and grow within the cap, so small records do not allocate the full 20 MB
maximum. Aggregate inventory budgets still account for bytes that grow after stat.
UTF-8, recipe/output hashes and completed automatic-companion checks are unchanged.
Descriptors close on success or failure; no artifact is repaired or replaced.

Two adversarial synthetic tests grow the output after descriptor stat and replace
the final path component with a symlink after ancestor checks. The first records
actual read/request counts at or below 5000001 bytes before refusing overflow;
the second exercises O_NOFOLLOW and never reads/echoes the external synthetic
target. Both preserve the original task record. Their mock prohibits path readFile
on the selected output, so the old read strategy cannot pass accidentally. These
are controlled final-component/growth cases, not a universal guarantee against all
ancestor-directory replacement or concurrent filesystem attacks.

Focused and full regressions pass: 724 tests / 100 files with typecheck, lint,
build/context and whitespace checks. Existing frozen completion, workbook,
comparison, window and recovery assertions still pass under the same reader.
No real vault, account, source-history rewrite or release was touched.
The fresh installed-package smoke also passes all 129 commands, including frozen
saved-output retrieval and the existing capture/completion/comparison workflows.

### Verified saved-output read commands — 2026-10-14

`task output ID` and `simulate task output ID` now return existing completion-bound
text through the CLI instead of requiring a host to guess filesystem paths. JSON
includes scope, state, configured locations and output hash; plain output is the
exact saved text, without an added newline. Integrity is explicit and limited to
checked local completion metadata; current source coverage, permission, authorship,
academic correctness, approval and submission are not inferred.

The ordinary reader accepts completed prep and assignment artifacts, validates
course/destination/filename scope, learning-history bindings, bounded regular-file
bytes and the saved output hash, then verifies automatic workbook evidence. It
does not reselect current source bodies or require a new generation request. The
existing assignment-write reader retains its assignment-only guard and current
destination checks for revision/approval. Prep output reading never grants those
write authorities. The frozen reader revalidates its original capture/recipe and
completion, rereads bounded safe UTF-8 output and checks its hash again; human
verdict remains pending.

Extended ordinary/frozen regressions exercise pending refusal, actual compiled
JSON/plain reads across working directories, unchanged records, no live-source
substitution, missing/modified/linked/oversized output refusal without content echo,
recovery after fixture restoration and continued prep revision/approval refusal.
Ordinary matching-byte fixtures additionally verify BOM preservation and invalid
UTF-8 rejection even when the recorded hash matches the supplied invalid bytes.
Saved retrieval reuses the candidate credential/private-path privacy guard without
imposing newer structural requirements on old ordinary artifacts. Matching-hash
fixtures containing credential-like text or unrelated private metadata are refused
by both direct readers and compiled CLI without echoing those contents. The refactor
retains candidate citation allowlists and existing revision/approval guards.
Full suite passes 722 tests / 99 files with typecheck, lint, build/context and
whitespace checks. Shared AGENTS/skills point hosts to task list/show/output and
remain within native budgets. Earlier incorrect host reports stay intact; this is
a new verified retrieval capability, not retroactive correction or proof that every
native host will use it appropriately.
The fresh installed-package smoke passes 129 commands, reading actual ordinary /
frozen saved text and verified automatic companion metadata across the existing
completion flows. Retrieval bodies match candidates; correctness/currentness flags
remain false. No provider, Canvas or real coursework is used by these checks.

### Native task-location adoption and host-report contradiction — 2026-10-14

Two additional fresh read-only Luna sessions used current packaged code against
the original completed synthetic vaults. Both receive the new scope, executable
inspection arrays and configured absolute locations, recover original IDs/outputs
and exit 0 with turn.completed. Whole-vault comparisons retain all nine ordinary
and twelve frozen files exactly; zero file-change events occur. This is selected
recovery evidence, not a clean first-pass adherence or academic-quality certificate.

Ordinary run native-recovery-HwqhyH has fifteen completed shell groups and two
failed filesystem probes against a guessed child-workspace/vault path. Its final
report incorrectly says recorded output/task directories are absent. Parent parsing
of the actual successful task show event proves locations.output/record point to
the correct original vault; both files exist and output SHA-256 matches the saved
f92baf712ae974b080523edee7983890729793b35a0d3f279acc3134471d3ec1 receipt. The subsequent
read-only number check also succeeds against that correct original path. The
earlier failed probes used different paths, so the host's missing-file conclusion
is contradicted, not merely unverified. Do not certify this self-report or erase it.

Frozen run native-recovery-vqS7Lm has eleven completed shell groups, uses frozen
task inspection rather than ordinary task show, reads the correct returned output
and verifies its original hash. One earlier command group fails to locate relative
CLI/reference files after a working-directory guess. Its final report misdescribes
that group as an output read failure; the actual log remains authoritative. Its
saved verdict stays pending-human and original record/output bytes are unchanged.

The fresh native plugin audit was also rerun under canvas-codex-plugin-mITkNX:
all three installed skills/references match current source, and five mock-provider
turns prove complete project AGENTS, skill and combined instruction delivery within
the existing budgets. This is actual native delivery against a mock provider, not
real-model adherence in that refreshed cache. Real inference sessions still use
the separate authorized original cache, explicitly unrefreshed; no credentials
were copied, read by model tools or placed in vaults.

Reported real-session usage: prep 279606 input / 236544 cached / 3824 output;
frozen 420218 input / 373760 cached / 4099 output, not verified USD bills. The
operator's new installation metadata now says originalInstallationReplaced: false
instead of claiming whole-installation hash verification it did not perform.
Earlier private reports remain intact. The vault comparisons are actual byte
evidence; model process success and metadata-only location flags do not establish
truthful summaries. Current source gates remain 722 tests / 99 files, and the
latest package smoke is 120 commands. No real vault or release was changed.

### Explicit configured task locations and inspection scope — 2026-10-14

Native recovery against a separate workspace exposed vault-root guesses and an
ordinary command used for a frozen ID. Both task listings now return explicit
ordinary/frozen scope plus a row inspectionCommand argv array with selected config
and the appropriate task show command. Selected task show JSON adds absolute
locations for config, configured vault, record, expected handoff and any recorded
output/automatic workbook. Existing relative fields remain for compatibility;
no saved recipe or completion receipt is changed.

The helper validates UUID/scope and bounded relative artifact paths, refusing
traversal, absolute/drive paths, backslashes, controls and empty segments. Absolute
locations themselves are explicitly not existence, integrity, currentness,
permission or approval verification. State and evidence checks retain their
existing ordinary/frozen semantics; missing handoffs are not repaired and null
outputs do not authorize new generation.

Twelve new regressions cover exact argv/path derivation, unsafe relative paths and
ordinary/frozen pending-to-completed inspection from an unrelated workspace with
spaces and a vault elsewhere. Commands returned by listings are actually executed;
record bytes stay unchanged across inspection and outputs match their candidates.
The existing frozen metadata test now asserts the additive command without weakening
its body/ordinary-ID/completion-state exclusions. Default suite passes 722 tests /
99 files, typecheck, lint, build/context and whitespace checks. The earlier native
errors remain retained; native adoption of these new location fields is still a
separate acceptance gate, not inferred from synthetic assertions.
The fresh installed-package smoke passes 120 commands, including ordinary/frozen
locations before/after completion, correct output/workbook pointers and direct
execution of returned inspection arrays.

### Native discovery adoption with earlier saved work — 2026-10-14

The recovery operator's optional `--current-cli` packs/installs the current local
build in a new child workspace and copies current project AGENTS there. It reads
the original completed synthetic vault using its original absolute config, without
replacing the previous installation, source artifacts or transcripts. Both builds
still identify as unreleased local 0.4.0; package integrity distinguishes their
bytes, so this is not a published-version upgrade claim. The existing authorized
plugin cache is intentionally not refreshed and is not certified as matching.

Real new ephemeral gpt-6-luna sessions both successfully invoked instructions and
used current packaged guidance. Prep's first command was instructions; it read
the returned prep SKILL/AGENTS paths, recovered original task
c0f88048-48b7-4e74-b983-b0ef53ac05d3 and revalidated the saved brief/arithmetical
evidence. Its fourteen completed shell groups retain one later wrong vault-root
diagnostic path, corrected using the actual configured vault. All nine vault files
stayed byte-identical. A parent progress update incorrectly called the complete
run failure-free after checking initial commands; that update was corrected against
the full command log, with no artifact/history rewrite.

Frozen recovery also invoked instructions successfully, recovered original task
332c4b30-b5c6-4827-8b9d-0ff28a9c25df/capture and the same saved output hash and
pending-human state, then read-only checked eighteen recorded operations. All twelve
vault files stayed byte-identical. Thirty completed shell groups retain three
failures: two working-directory config guesses and one ordinary task show for the
frozen ID. Its final summary reports only the last failure; parent logs remain
authoritative. Neither run has a failed instruction/reference read after using
the current package's discovery paths, but this does not guarantee every host
will adopt the command or stop guessing other paths.

Both processes exit 0 with turn.completed and no file-change events. Private runs
native-recovery-8LiKg2 (prep) and native-recovery-H8SPcg (frozen) retain prompts,
package metadata, command events, final reports and whole-vault pre/post hashes.
Reported usage: prep 212866 input / 180480 cached / 2654 output; frozen 415915 input /
362752 cached / 3846 output, not verified USD billing. No auth-file read is recorded
by model tools; runtime uses the isolated login. This proves selected native
discovery adoption and backward saved-work recovery, not matching active plugin
injection bytes, new academic generation, interrupted /goal recovery or full parity.
Default gates remain 710 tests / 98 files, typecheck, lint and build/context.

### Config-free installed instruction discovery — 2026-10-14

The fresh native recovery runs exposed working-directory and installed-reference
path guesses. `instructions --json` now resolves AGENTS, all three workflow skills
and detailed CLI/workflow references from the executing CLI's package root. It
returns exact paths, bounded sizes/hashes, version and a matching shared-core hash,
without loading config, dotenv, a vault or Canvas. The human output lists the same
paths. This does not certify active plugin-cache versions, native injection,
publisher authenticity or instruction adherence; those flags remain false.

AGENTS and the synchronized shared contract direct hosts to this discovery command
and clarify that skill links are relative to SKILL.md, not the student workspace.
The new reader rejects missing/linked/non-regular/oversized/invalid UTF-8 artifacts
and missing/duplicate/drifting cores without repair or content echo. Six regressions
cover exact metadata, all three core failure cases, unsafe artifacts and compiled
execution outside checkout with malformed config/dotenv untouched. The shared
entrypoints remain within native context budgets. Full default suite passes 710
tests / 98 files, with typecheck, lint, build/context and whitespace checks.
The fresh installed-package smoke passes 111 commands and verifies all six
returned paths, their exact installed bytes/hashes and matching package version
from an unrelated student workspace with no config present.
Earlier native transcripts remain unchanged; this is an implemented path-discovery
fix, not a retroactive clean-run claim or universal native acceptance.

### Fresh native read-only prep/draft recovery — 2026-10-14

`scripts/run-native-recovery-acceptance.mjs ABS_AUTHORIZED_CODEX_HOME ABS_NATIVE_FIXTURE`
starts a new ephemeral Codex 0.162.1 / gpt-6-luna session with read-only tools.
It supplies course/scope/config/installed CLI paths, but no task/capture IDs,
previous answers or transcript. Hosts are instructed not to read previous
outside-vault candidates/reports/logs. The operator validates only owned synthetic
roots, private login metadata (never credential contents), invented Canvas origin,
empty allowlist and terminal original-host status. It inventories every vault
file before/after and saves a private separate recovery report outside the vault.
This is explicitly authorized real native inference, not a default test or hidden
model invocation by the product.

Ordinary prep recovery native-recovery-jNZCib discovered original task
c0f88048-48b7-4e74-b983-b0ef53ac05d3, read its saved brief and recovered the
conditional $4,000 scenario result and evidence limits. Read-only numeric review
recomputed nine operations; all nine vault files retained identical hashes with
no added/deleted files. Eight completed shell groups retain one failed attempt
to read a checkout-relative reference in the student workspace. The installed
cache prep SKILL.md was read in that same group before the path failure. Its final
report did not mention that failure and labels TASK.md as the task record; the
actual metadata record remains task.json. Do not treat a host summary as exact
command-history evidence.

Frozen recovery native-recovery-I01FXs discovered original capture
68b84691-7d6a-4e28-839e-5c67744543cb and task
332c4b30-b5c6-4827-8b9d-0ff28a9c25df, read the saved output, and inspected two
arithmetic records containing eighteen recomputed operations. It retained the
completed-pending-human state, original output hash and historical/grounding limits.
All twelve vault files stayed byte-identical with no additions/deletions. Thirteen
completed shell groups retain three failures: two incorrect installed/reference
paths and one positional course argument instead of --course. The final report
mentions only the argument failure. There is no direct frozen SKILL.md read in
the shell log; raw inference request bodies were not captured, so exact native
skill injection/attention is not certified by this recovery run.

Both processes exited 0 with turn.completed and zero native file-change events.
Parent inspection confirms recovered IDs, saved-output conclusions and whole-vault
hashes. No auth-file read appears in model commands; native runtime still uses
the authorized isolated login. Reported usage: prep 252994 input / 224000 cached /
2037 output, frozen 424735 input / 382464 cached / 3719 output, not USD billing.
Original forward artifacts/transcripts remain unchanged. These are fresh-session
saved-work recovery tests, not actual mid-generation /goal pause/resume or universal
interruption coverage. Default gates remain 704 tests / 97 files, typecheck, lint,
build/context and whitespace checks. A remaining usability improvement is reliable
installed instruction/reference path discovery without checkout-path guessing.

### Installed two-product writer boundary — 2026-10-14

`node scripts/audit-installed-coexistence.mjs ABS_BUILT_PUBLIC_SCHOOL_CHECKOUT`
packs both explicit built sources with lifecycle scripts disabled, installs the
tarballs under an owned temporary home/cache, checks installed module bytes
against the builds, verifies both launcher versions, and runs the same writer-order
audit entirely through installed compiled modules and the installed Canvas CLI.
Registry dependency installation is the only intended network activity; course
sync is mocked GET-only and no model or real account is used. This operator-only
test is not part of default zero-network tests.

The actual installed run reports School 0.1.1 and Canvas 0.4.0. Nine selected
installed artifacts match their source builds, including both writers, School's
readiness guard, Canvas's diagnostic and launchers. Private package integrity,
actual subprocess argv/status/output hashes and audit JSON are retained under
canvas-installed-coexistence-kT9m2T, outside the repository. Both package launcher
version requests succeed. All nine Canvas task/approval/recovery processes and
two restarted School writer processes use installed package paths, not checkout
source imports.

A second fresh installation under canvas-installed-coexistence-u8pjel reproduced
the same result after the audit metadata was corrected to label compiled-module
hashes as installedArtifactHashes rather than sourceHashes. The earlier private
report remains unchanged. Default regression verification is still 704 tests /
97 files with typecheck, lint, build/context and whitespace checks passing.

The result remains partial (exit 2): School-first preserves the asserted navigation,
layout, student edits and Canvas pending/completed draft/Final/history; Canvas-first
and legacy markerless orders refuse before changing any vault byte. This closes
selected installed-package writer-order evidence, not markerless adoption or
whole-corpus interchange. These are locally packed versions, not fetched/published
release artifacts. SQLite database execution, full School sync/provider generation,
live accounts, concurrent writers and all document formats are not established.
No public School source, normal CLI installation/configuration or real vault was
changed. The runner leaves its private installation/report for evidence inspection.

### Pinned public School writer-order audit — 2026-10-14

Re-running the actual coexistence script against public School main commit
b22c8e2a798e2acdf7e6cc63d6c7659788635b0d first failed at Canvas-first setup:
School's current root guard rejects a nonempty course vault with no layout marker.
The local School baseline previously allowed that state; those passing local
writer-order tests cannot be relabeled public compatibility.

The audit now records this expected refusal rather than aborting or suppressing
the failing orders, and exits 2 for a partial audit so it cannot be treated as
a passing coexistence gate. Its authoritative public result is partial: School-first
preserves School navigation/marker/student edits and Canvas pending/completed tasks,
draft/Final bytes and retry history across nine Canvas CLI processes and two
restarted School writers. Canvas-first and legacy-Canvas orders remain blocked
before any School byte mutation. All original files match pre-refusal hashes.
School writer/parser source hashes are e57e55bc1bc9da797acbba1432756a6f1b1d70ff7e1bdf2c3ec8a16b3a62cbd3
and 8363832611437e2c9be151041caba63f96d4fb4564720f26f40cde19b9b4c1f6 respectively.

Canvas now inspects missing-marker directory state accurately and reports this
block on sticky preserved syncs; no marker is created or advanced. New guidance
requires School initialization first only for genuinely new shared vaults.
Existing markerless vaults require explicit migration/readiness review or separate
vaults, not handwritten marker bypasses. A current marker remains unverified for
shared formats. Regressions exercise empty/private-only/nonempty roots and preserved
sync notices with marker bytes unchanged. This is actual source-writer/compiled
Canvas testing, not installed public releases, concurrent writers, all-format
interchange, a real vault migration or live account acceptance.

### Numeric diagnostic usability follow-up — 2026-10-14

The native tests exposed optional labeled week dates and rounded ratios as
unmatched numeric claims. Read-only ordinary/frozen diagnostics now separate
calendar-valid, explicitly labeled ISO dates, preserving line numbers and reporting
bounded inventory counts. Invalid dates, bare subtraction and malformed suffixes
remain numeric inputs. Explicit approximate decimal/percentage figures can show
up to three rounded recorded-result matches (maximum six decimal places); they
remain flagged for human inspection, never verified or automatically accepted.
An unqualified occurrence of the same value prevents an aggregate rounded label.

Regression coverage includes valid leap days, invalid dates, arithmetic-like
suffixes, date-inventory truncation metadata, rounded and mismatched percentages,
unqualified/scientific notation, arithmetic bounds and ordinary/frozen candidate
preservation. Installed-package tests exercise both scopes. Existing native
transcripts and saved candidates remain unchanged; this is a follow-up fix, not
a retroactive clean-first-pass claim. The canonical CLI reference explains that
reviewing a rounded match does not require replacing readable figures with
excessive digits. Semantic grounding/correctness and execution authentication
remain explicitly false.

### Authenticated native prep and frozen draft — 2026-10-14

The explicit operator runner now accepts `ordinary-prep` or `frozen-draft`
after the separately authorized isolated Codex home argument (default remains
`frozen-review`). Both actual Codex 0.162.1 / gpt-6-luna turns used freshly
installed CLI packages and explicitly requested native installed skills, invented ECON901 sources,
explicit fixture-only AI permission and existing tasks. They were not supplied
task IDs or numeric answers. Both exited 0 with turn.completed; candidates were
authored through native file-change events, outside the vault. Recorded shell
commands read packaged references and saved workflows, but do not directly read
either SKILL.md. Real request bodies are not captured, so these two runs do not
independently prove exact skill injection bytes or attention to every instruction;
the earlier mock injection audit and native review provide separate evidence.

Ordinary prep fixture canvas-host-ordinary-prep-B5i1UF completed the original
task c0f88048-48b7-4e74-b983-b0ef53ac05d3, answered all three preparation questions
and executed nine operations. Parent inspection confirms the conditional $4,000
scenario profit, exclusion of sunk research, 400-unit break-even and explicit
missing demand/cannibalization/working-capital/tax/opportunity evidence. Of seven
baseline files, only task.json changed for completion; sources and TASK.md stayed
byte-identical. There were 26 completed shell groups, no nonzero exits. An initial
numeric diagnostic flagged the optional week date, which the host removed before
rechecking; this is a retained usability issue, not a clean first-pass diagnostic.

Frozen draft fixture canvas-host-frozen-draft-jmrNoN completed original task
332c4b30-b5c6-4827-8b9d-0ff28a9c25df from capture
68b84691-7d6a-4e28-839e-5c67744543cb. It delivered Part 2 with custom headings,
executed arithmetic, conditional recommendation and limitations. All eight baseline
files remained byte-identical. The saved output hash is
51fec8b474148f51b0e6fab94d44a4733ac6d8a467acca321583836e330afd31 and the state is
completed-pending-human. No workbook companion was created or required here.
The final diagnostic recomputed eighteen operations across two recorded batches;
repeated calculations must not be reported as eighteen distinct derived claims.

Twenty-eight completed shell groups retain three exit-1 validation failures:
missing/empty Limitations section, an unselected framework citation, and an
insufficient substantive answer to the incremental-profit item. The native final
report misdescribes the third as a rounded-percentage failure; the actual command
transcript is authoritative. A separate advisory flagged rounding before the
host removed the decimal percentage. No failure or intermediate record was erased.
Final number checks were unflagged, not semantic correctness certificates.

Private transcripts/reports remain with the fixtures, outside Git. Reported
usage was 545430 input / 473600 cached / 7606 output for prep and 1273255 input /
1201408 cached / 10591 output for draft, not verified USD billing. Parent byte
checks and artifact inspection supplement host self-reports. This establishes
selected native forward authoring, not all formats, instructors, desktop hosts,
real student readiness, interrupted generation or full parity. The default
model-free suite still passes 697 tests / 96 files, with typecheck, lint,
build/context checks. No real vault, School source or GitHub release was changed.

### Observed goal-controller resume checkpoint — 2026-10-14

The resumed goal turn reports active under the same original goal ID after its
previous blocked state. The objective is unchanged. This is an observed
blocked-to-active controller transition, not a paused-to-active or mid-generation
process-kill test, and it does not establish a cleared model conversation.

Using the installed CLI and saved synthetic config, metadata discovery recovers
the original native-review task 289d3565-49aa-451f-8e14-9945fa52a0c2 and review
65c426b0-b9ca-4d0c-a681-8658a13d477a without regeneration. Selected show revalidates
capture/recipe/output/arithmetic bindings. The saved review SHA-256 matches the
successful pre-resume native-save event, and all eight original fixture files
still match their baseline hashes. An initial parent transcript selector picked
save --help rather than the actual UUID-bound save; the corrected selector matches
the original hash. That diagnostic mistake did not change any artifact.

Separately, the pinned public School run-store reader loads the original prep
checkpoint run as completed, with its message history/result and unchanged raw
record bytes. It performs no model/network call or sibling write. This selected
disk-read recovery does not erase the known School follow-up overwrite bugs:
revision approval still replaced its earlier Final and explicit prep rerun lost
the earlier hand edit in the controlled audit. These are not safe parity targets.

No workflow, source file, academic output, account or release was mutated by the
resume check. Native prep/draft authoring and interrupted pending workflows still
require their own acceptance; selected recovery is not a full-goal certificate.

### Authenticated native installed-plugin frozen review — 2026-10-14

After explicit owner approval and browser sign-in, the isolated Codex home reports
ChatGPT authentication with a mode-0600 credential file outside all student/test
vaults. Existing credentials were not copied. A real gpt-6-luna access probe
returned the requested marker with no tool calls; native account model access is
therefore verified for that request, not inferred from the catalog.

`scripts/run-native-host-acceptance.mjs ABS_ISOLATED_CODEX_HOME` packs/installs the
CLI into an owned synthetic student workspace, copies project AGENTS and invokes
actual Codex 0.162.1 with the installed assignment plugin and gpt-6-luna. This is
an explicitly authenticated operator-only development test, not hidden toolkit
generation or part of the zero-network default suite. It never reads/copies auth
contents. Future invocations require an owned temporary home and a private native
credential file by metadata checks; model tools are instructed never to read it.

The native process exited 0 with turn.completed. Its recorded commands read the
fresh installed-cache assignment skill and packaged CLI/reference, discovered the
frozen draft/capture, prepared the dedicated review, consumed its captured sources
and recomputed arithmetic, then saved/rechecked a separate note. Parent inspection
confirms the seeded 8-vs-6 error, false quote and unsupported rollout/missing-evidence
findings. All eight original vault files remain byte-identical; only the four new
correctness-review files were added. Thirteen completed shell command groups have
one retained failure: ordinary task listing could not find the removed live course;
the following frozen discovery succeeded. Groups combine commands and must not be
misreported as thirteen individual CLI calls. No credential-file read appears in
the recorded model commands; native runtime authentication still uses its login.

The private fixture is canvas-host-correctness-frozen-Lw6FCZ; frozen review ID
65c426b0-b9ca-4d0c-a681-8658a13d477a. Private JSONL/native final report and artifacts
remain there. Reported usage is 410427 input, 373248 cached input and 4580 output
tokens; this is runtime token accounting, not a verified USD bill. The real model
request content itself was not captured, unlike earlier mock injection probes.
This closes selected authenticated native frozen-review acceptance, not native
prep/draft authoring, desktop/other-host behavior, actual `/goal` pause/resume,
instructor grading, real student source access or release. Verdict remains human.

### Journaled forward and lost-context frozen host acceptance — 2026-10-14

Two more fresh Luna hosts used only the marked synthetic fixture and machine
runner. The forward host discovered the frozen task/capture, saved a review
finding the seeded arithmetic, quote and unsupported-rollout defects, and left
all eight original vault files unchanged. The second host recovered original
task/capture/review IDs and selected saved evidence without being given IDs or
the prior transcript. No replacement tasks/captures or approval were created.

The JSONL journal contains 18 actual child invocations: one parent discovery,
ten forward-host calls (nine exit 0; one retained ordinary-course-discovery
failure) and seven recovery calls (all exit 0). Every row has the correct owned
config/cwd and exact argv/status/output hashes. Parent pre/post SHA-256 checks
preserve all twelve vault files across recovery, including the four new review
artifacts. This new journaled run narrows the exact-history gap; it does not
repair the older incorrectly transcribed recovery log or prove no unrecorded
filesystem/model operations. Scope remains manually instructed source hosts,
not native installed-plugin model use or actual `/goal` controller recovery.

Read-only GitHub recheck still shows public School main b22c8e2, private Canvas,
no open PR and remote parity branch 0a34cc8. Current changes remain local. The
isolated native home still reports no login. Owner direction for a separate
login and user-operated controller/real-student/release acceptance is required;
automated goal continuations are not approval for those actions.

### Machine-recorded host CLI acceptance — 2026-10-14

`scripts/run-host-acceptance-cli.mjs --root ABS_FIXTURE -- CLI_ARGUMENTS` now
records actual child executable/argv/cwd/status/signal/error and stdout/stderr
hashes into a private JSONL journal outside the vault. It accepts only marked
synthetic correctness fixtures under the temporary directory, fixed example.invalid
Canvas, an empty allowlist and an internal vault. Credentials, alternate configs,
auth/sync/approval commands and outside-fixture candidates are refused before
execution; child environment is scrubbed. Log reads/writes have regular-file,
symlink and size checks. This is test instrumentation, not a security sandbox or
proof that an agent made no other unrecorded calls. Wrapper preflight refusals and
non-CLI filesystem/model operations are not child-CLI journal entries.

Regression checks compare the two actual child exit statuses and output hashes,
then verify denied auth/config/file escapes do not execute or append journal rows.
The existing unreliable recovery transcription stays unreliable; the new runner
does not reconstruct or retroactively certify it. Hosts still need a new forward
run using this runner. Gates: 697 tests/96 files, typecheck/lint/build/context pass;
the shipping CLI is unchanged and the last package smoke remains 108 commands.
The real native model session is still awaiting direction for its isolated login.

### Combined native instruction delivery and auth boundary — 2026-10-14

The native audit now captures a fifth mock-provider turn combining project
AGENTS.md with the freshly installed assignment skill. Both complete bodies are
present in the same real Codex 0.162.1 inference request; fresh discovery and
source/reference byte equality still pass. This closes selected combined context
delivery, not real-model adherence, tool use, academic output or `/goal` resume.

Credential-redacted login-status checks classify the existing native CLI session
as ChatGPT-authenticated, while the owned isolated test home with file credential
storage reports no login. No existing credentials were read into assistant context,
copied, printed, refreshed by an inference call or moved to the fixture. No login,
real model call or user-settings/cache change was performed. A real authenticated
fresh-install session needs owner direction and a separate login; the current
mock-provider test must not be relabeled as that acceptance pass.

### Forward frozen review and fresh-host recovery — 2026-10-14

Two fresh Luna hosts received config/course/frozen scope without task/capture/
review IDs or the other host's transcript. The first discovered completed frozen
work and saved a separate review identifying the seeded arithmetic error, false
quote, unsupported rollout and omitted limits. Its 13 recorded CLI invocations
include a retained missing-course failure; no replacement tasks/captures or human
approval were created. Parent hash checks preserve eight original vault files and
three archived source files; only four correctness-review artifacts were added.

The second recovered the saved review/task/capture and findings read-only, but
its reconstructed command log had path transcription errors. It could not safely
reconcile exact arguments/statuses, and retained the original log plus a correction.
Do not certify that recovery log as exact. Parent post-check independently
preserves all eight baseline files and the review note's published forward hash.
Recovered identities/findings and byte checks are scoped evidence; actual `/goal`
interruption, native injection and exact second-host command history are unverified.

The retained frozen note is unchanged except UUID placeholders. A new isolated
builder/replay test removes live course access, discovers the frozen task, saves
the actual note, verifies retry and keeps the eight-file baseline unchanged.
Current suite: 696 tests/95 files, typecheck/lint/build/context/whitespace pass.
The last 108-command package smoke predates this fixture/test-only addition; the
shipping library/CLI is unchanged this increment. No real student/account was used.

### Frozen separate correctness-review handoff — 2026-10-14

`correctness prepare FROZEN_UUID --frozen` creates a version-2 review bound to
the immutable capture/snapshot, frozen recipe/completion and recomputed frozen
arithmetic. Show/save recover that scope from the record; no live source or
ordinary task log is substituted. Hand-offs explicitly name the validated draft
and automatic XLSX path/hash. Exact private output citations are allowed only
for those verified review targets, not unrelated metadata paths. Human verdict
remains pending-human; neither note claims nor save success approve M1.

Synthetic backend/compiled tests cover removed live course folders, newer live
canaries excluded from handoff, stable capture/recipe/completion/output/workbook
bytes, saved/retried notes, namespace separation, pending draft refusal, added or
tampered arithmetic, changed output and unrelated private-citation refusal.
Earlier ordinary version-1 records retain their schema/bindings. This is frozen
review mechanics, not a fresh-host frozen review or authenticated historical
access/academic verdict. The ordinary forward Luna review is separate evidence.
Current gates pass 695 tests/95 files, typecheck/lint/build/context/whitespace.
Isolated installed-package smoke passes 108 commands, including frozen
prepare/list/save/retry/show, exact private output/XLSX citations, recomputed
captured arithmetic and preserved output bytes. No live account or reviewer
model was involved in that package flow.

### Forward separate-review host — 2026-10-14

A fresh Luna host received only checkout/config/ECON903 scope, discovered the
completed synthetic draft and performed the separate correctness pass. Its
retained note identifies the seeded contribution error (8 vs recorded 6), false
scalability quotation, missing fixed costs/out-of-pilot evidence and absence of a
control group. Parent SHA-256 audit confirms all seven pre-existing vault files
are unchanged. New files comprise the separate review and two pending ordinary
review tasks created during discovery; neither extra task was erased or completed.

The 12 recorded CLI attempts include a failed save because the old validator
rejected an exact citation to the draft under review. The host corrected only its
external note before saving. The rejected intermediate candidate was not retained;
do not retroactively treat that first attempt as passing. Correctness save now
accepts the exact validated draft and bound automatic spreadsheet paths while
refusing unrelated output paths. Detailed guidance distinguishes this workflow
from reconstructing ordinary review tasks without the original context/arithmetic.
Fresh-host adherence to that clarification remains unverified.

The final host note is retained in test/fixtures/host-correctness with only its
Review UUID replaced; a compiled-fixture replay saves it, verifies matching retry
and preserves all baseline bytes. This is one manually instructed source-host
review, not native plugin injection, `/goal` interruption, independent-reviewer
identity authentication or real academic grading. No real account/vault was used.
Draft reads now have a five-MB bounded descriptor read before handoff assembly;
old approval/revision reads keep their existing behavior. Reading-copy tests also
explicitly exclude the new private handoffs, notes and receipts.

### Separate correctness-review handoff — 2026-10-14

`correctness prepare/list/show/save` supports an explicit second host pass for
completed ordinary drafts. Private HANDOFF.md contains the saved source/guidance
recipe, finished draft and original calculation records after bounded recomputation
and selected-source hash checks. Review IDs, parent task/arithmetical evidence and
handoff bytes are bound separately; retries reuse matching handoffs and notes.
Metadata-only listings recover IDs without claiming currentness. The reviewer
returns substantive Verified/Needs verification bullets and exact source paths;
save rejects unsafe candidates, secrets, stale evidence and differing existing
artifacts. A missing note behind a saved receipt fails closed, not pending.
Drafts, Finals, source files and task records are never modified by these commands.

Synthetic backend/compiled CLI tests exercise source/draft/log preservation,
empty arithmetic, malformed calculations, credential/symlink refusal, differing
notes, completed retry and missing-output refusal. A seeded matching note without
a receipt can finish saving; a differing partial note is retained and refused.
That seeded case is not a process-kill test. The host, not the CLI, invokes the
reviewer. No automatic second model call, independent reviewer identity, authentic
calculation execution, grading, actual course permission or academic quality is
verified. Old task workflows remain unchanged; explicit review is not approval.
Verification: 689 tests/94 files, typecheck/lint/build/context/whitespace pass;
isolated installed-package smoke passes 102 commands including prepare/list/show,
save/retry and preserved draft bytes. Matching plugin context stays within its
entrypoint bounds and directs hosts to the detailed correctness reference.

### CLI identity parity — 2026-10-14

Public School root help advertises --version; Canvas previously lacked it.
Canvas now reads its own adjacent package version and supports --version/-V
without loading configuration, adjacent .env or Canvas. Synthetic tests verify
both flags with a nonexistent config and a transport that fails on any request.
Full suite: 684 tests/93 files, typecheck/lint/build/context/whitespace pass.
The current isolated installed-package smoke passes 96 commands, including
installed version identification before config exists; original fixtures and
packaged instructions remain unchanged, with zero dependency audit findings.
This identifies the package release number, not the checkout commit or whether
uncommitted work is published. Separate review-pass parity remains open: public
School invokes a second review call with durable computations, whereas Canvas
currently instructs host self-review and offers explicit review tasks.

### Completion process-death recovery — 2026-10-14

`test/completion-recovery.test.ts` kills a confirmed live compiled completion
worker immediately after its Markdown hard link, before workbook and task-record
commits. A fresh CLI sees the original pending task; a conflicting candidate is
refused without changing the transaction/output. Retrying the original candidate
finishes that same output version and its spreadsheet companion. Further retry
preserves completed record, Markdown and workbook bytes. The source and a
pre-existing student draft remain unchanged. This closes one actual mid-write
process-death case, not every interruption boundary or `/goal` controller resume.
Full suite after adding this case: 683 tests/93 files pass, together with
typecheck, lint, context, build and whitespace checks. The installed-package
95-command result below predates this test-only addition and was not rerun here.

### Public-baseline answer evidence parity — 2026-10-14

Read-only GitHub inspection pinned school-agent-public main to
b22c8e2a798e2acdf7e6cc63d6c7659788635b0d (package 0.1.1, public).
The local School checkout is not that commit: runner/sync blob hashes agree,
but prep, assignment, proposal and vault modules differ. Public prep has
mandatory matching module/Week placement and stronger lexical answer checks.
Earlier actual-School process audits were local-source tests, not public runtime
acceptance. Canvas GitHub remains private, no open PR, and remote parity branch
0a34cc865c21a6cec705ddb32cf85b710d93f28f; new work is still local/uncommitted.

Luna implemented new answerEvidenceVersion 1 on fresh ordinary/frozen prep;
parent review aligned tokenization with public School and bounded source/path
processing before allocation. Vocabulary is prepared once per candidate and
backticked exact path strings are excluded. Five content terms/three beyond the
question/two novel source terms apply to detected imperative prep requirements
as well as questions; explicit gaps retain prior rules. Older unflagged saved
recipes/workflows remain unchanged. English/synonym/mathematical false positives
are possible; vocabulary agreement does not verify meaning or grounding.

Synthetic regressions cover generic cited filler rejection, qualifying source
vocabulary, explicit gaps, old-v3 completion without upgrade, wrong-kind/version
refusal, ordinary/frozen binding/tamper checks, tokenization and resource bounds.
Legacy downgrade fixtures remove fields absent from the historical version;
retained host candidates were not altered. A hand-authored round-trip fixture
needed source wording rather than singular/plural synonyms, illustrating the
heuristic's limitation. Compiled period tests reject operational-only timestamps,
other-week/undated inputs without task writes. Explicitly dated local material
is supported with an honest Other/Prep date fallback, not an invented Week/module.

Verification: 682 tests/92 files and typecheck/lint/build/context/whitespace pass.
Isolated installed-package smoke passes 95 commands, including a flagged prep,
generic-cited-answer rejection without body echo and a qualifying completion.
The source/plugin defaults remain unchanged; flag-specific instructions are in
the saved task workflow. Actual controller interruption, native real-host turn,
real-student academic acceptance and publication remain separate gates. See
[the current completion audit](PARITY-COMPLETION-AUDIT.md).

### Expanded two-product preservation audit — 2026-10-14

The pinned public School commit was separately cloned into an owned temporary
checkout, installed using its lockfile, rebuilt for native SQLite and compiled.
The actual launcher reports version 0.1.1 and help with isolated HOME/config;
its source worktree remains unchanged. Setup fetched dependencies, but audit
workers attempted no network calls and never loaded student credentials.

The public-source recovery audit now runs 15 fresh processes and kills
five confirmed live workers at durable checkpoints. It verifies parked-run
approval, interrupted atomic replacement, completed draft approval/retry,
completed revision recovery with the original run ID/history prefix and student
edit/feedback in the model input, and completed prep recovery with correct
course/week/custom headings/question. Engines use keyless fixed mock responses;
draft/revised approval uses full School CLI registration/config loading. Prep
and revision generation are engine-level, not provider-backed CLI generation.
No network attempt, sibling source write or real student artifact was involved.
Two additional public-only cases reject a generic prep answer with
PrepContentError and an unmatched period with PrepPeriodNotFoundError before
any model call. Both preserve the prior prep bytes. The fixture initializes its
empty synthetic vault through School's own metadata writer, respecting public
readiness guards. Results are retained outside the vault in audit-report.json.
Invoke the script with an explicit checkout plus --public-baseline for these
extra cases; earlier local-checkout audits remain distinct evidence.

The expanded audit reports preservation-gaps-found, not pass: approving a
revision overwrote the prior School Final at the same path, and explicit prep
rerun removed a hand edit in the prior auto-final brief. These are controlled
follow-up command losses, not loss from process death itself. Synthetic prior
Final/edited-prep copies are retained outside the owned test vault. School uses
the same run ID for revision and extends its messages; it intentionally changes
that run record rather than preserving its former raw bytes.

Equivalent Canvas fresh-process regressions preserve the edited earlier prep,
reject a completion retry against its changed bytes, and write a new prep
version for an explicit new task. First approval, revision completion and
second approval keep the earlier Final, draft and task record unchanged, as
well as a pre-existing student Final. The two products are not interchangeable
writers. Fixing the separate School source requires explicit direction; its
unsafe behaviors are not Canvas parity targets. Actual `/goal` interruption
and real provider/academic acceptance remain untested.

Canvas verification after these stronger cases: 672 tests/90 files pass, plus
typecheck/lint/build/context/whitespace and a 91-command installed package smoke.
The School audit independently reports fullPreservationRequirementMet false;
Canvas green gates do not override that result or certify both products. The
separate School source remains unchanged pending owner direction.

### Forward guidance host and lost-context recovery — 2026-10-14

A fresh Luna host received only source instructions/config/course, then found
the existing synthetic ECON902 proposal without a supplied UUID or answer.
It authored guidance preserving weekly prep structure, keeping prompt-specific
graded headings separate and using current cached assumptions/causal-limit
lessons without claiming feedback authorship, grading chronology or real policy.
Original candidate and seven-command trace are retained in the owned fixture;
the candidate is replayed from test/fixtures/host-guidance with UUID substitution
only. Thirteen original file hashes were checked: only proposal.json changed
for saved-version metadata; v1/v2 outputs were byte-identical and inactive.

The host hit a real discovery gap: guidance had no list/show and task show could
not accept a proposal ID. Metadata-only guidance list/show now recover original
IDs/record paths with missing-handoff/incomplete-inventory reporting and bounds.
A second fresh Luna host (no ID/answer/prior command log) found the same proposal
through those commands, read its full context/outputs and reported human-review
steps with no vault writes. It made five successful CLI discovery/help calls.
Reports distinguish saved state from currentness/activation/academic quality.
Synthetic regressions cover corrupt/oversized/linked records, aggregate/read
bounds, missing handoffs, cross-course filtering, no body echo and old recipes.
These are manually sourced coding-host turns, not native installed-plugin
injection, live Canvas, real academic evaluation or actual `/goal` interruption.

Verification: 672 tests/90 files, typecheck/lint/build/context and whitespace
checks pass. Isolated package smoke now passes 91 commands, including a
feedback-filled scoped proposal, structure-checked save and guidance list/show
recovery with matching bundled instructions. Parent inspection of the forward
fixture confirms the original ID, two saved versions and original metadata hash
when saved is reset to its initial empty list: no other captured field changed.
The current files remain local/uncommitted; School source and real vaults were
not changed by this increment.

### Guidance parse-back parity — 2026-10-14

New proposalStructureVersion 1 requires a usable prep declaration through the
fresh prep parser before saving, matching School's explicit parse-back gate.
Synthetic tests reject missing/empty/Sources-only/duplicate/unsafe/fenced
structures without modifying records or guidance; old unflagged proposals still
save under their original rules. A fresh-process compiled CLI flow proves saved
proposals remain inactive, then explicitly activates a guide in an owned fixture,
creates the correct course/week/headings/questions and completes a prep artifact.
Original guidance, older task bytes and proposed bytes remain unchanged.
No real host generation or student vault activation was performed.

Verification: 665 tests/89 files pass, including the unchanged earlier
host-authored guidance replay. Sentence-style explanatory prose followed by
backticked citations is not mistaken for a declared heading. Typecheck, lint,
build/context and whitespace gates pass; package smoke passes 86 commands with
matching bundled instructions. The new round-trip activation test runs the
compiled checkout, not a separately installed host plugin or real account.
Changes remain local/uncommitted.

### Guidance prompt-context parity — 2026-10-14

A current-source re-audit found School proposals include up to five recent
assignment prompts while Canvas previously captured only syllabi/common guidance.
New Canvas proposalContextVersion 1 adds five date-ranked readable same-course
prompts and separates standing graded expectations from weekly prep format.
Tests verify selection/bounds, excluded feedback/restricted/student/other-course
material, unchanged active guidance, permitted unselected edits, selected-body/
policy/new-selection rejection without record mutation, old syllabus-only recipe
preservation and compiled proposal/save commands. Current full gates pass 651
tests in 86 files, typecheck/lint/build/context checks. No actual class or host
proposal authoring was used for this increment.

The next increment adds separate versioned private proposal feedback and plain/
comma-separated prep structures. Synthetic tests exercise a maximum of five
current values, archive tampering, changed values/new feedback, unchanged cache
refreshes, exact-ID CLI scope, unrelated-cache isolation, private file modes,
reading-copy exclusion and old unflagged proposal preservation. Ordinary prep
completion and frozen captured-guidance reads exercise the new structure recipe;
unflagged parsing remains unchanged. These are not real academic grading or
actual `/goal` controller-interruption tests.

Post-increment verification: 662 tests in 88 files pass, along with typecheck,
lint, build, context drift and git diff whitespace checks. The isolated installed
package smoke passes 86 commands with matching bundled instructions, separate
default vaults and saved-work discovery/recovery cases. New feedback scope is
tested through the compiled checkout CLI; the package smoke does not separately
exercise feedback-filled proposals. Work remains local and uncommitted.

GitHub was checked read-only: davidjoshlee/canvas-agent is private, there is no open
PR, and remote feat/student-workflow-parity is 0a34cc865c21a6cec705ddb32cf85b710d93f28f.
The newer work is local/uncommitted; these tests do not constitute publication.

### Native context truncation corrected — 2026-10-14

The expanded native audit found explicit selected skills truncated at 8000
characters on Codex 0.162.1. Assignment instructions stopped inside a CLI example;
later outcomes and safety/authoring checks were absent. The same failure occurred
with a declared 200000-token mock context window; changing model context alone
did not resolve it. No owner setting/cache was changed to bypass the failure.

The shared core is now capped at 5000 bytes and complete skills at 7500 bytes.
Entry points keep identical CLI rules plus explicit finished prep/outline/draft/
review/discuss outcomes, required default headings, preserved-state/policy rules,
executed arithmetic and self-review expectations. Full versioned task instructions
remain unchanged; generated references/workflows.md retains complete defaults,
and previous extended CLI guidance is retained outside the shared core. A stale
setup wrapper's School-vault default was corrected to the Canvas default.

Four native ephemeral read-only turns against a localhost mock capture full
assignment/prep/setup skill bodies and the complete project AGENTS.md, including
shared core/outcomes, from a fresh installed plugin. No tools, real model, Canvas
account or student files are used. Captured requests prove delivery, not reasoning,
permission or academic quality. Tests reject skills that fit the previous 24 KiB
limit but exceed the native safety budget without partial repair, and detect/
repair generated full-reference drift. Native combined real-host workflow,
desktop refresh, other models/clients, personal/parent docs and `/goal` remain open.

Two additional fresh Luna hosts forward-tested the compact source instructions.
Prep's first six recorded operations lacked the used 200-unit comparison; the
host reported diagnostic flags, then executed the missing subtraction and removed
an optional rounded percentage. All twelve actual records (including duplicates)
are retained as reproducible operations. Frozen drafting corrected reported
citation-format failures before saving. Final candidates, batches and baseline
hashes were inspected; only the ordinary task status record changed, and all
frozen original/capture/recipe bytes stayed unchanged. Both hosts reported safe
completion retries; deterministic replays independently verify retry bytes and
the initial input-only 200 flag before the second arithmetic group. Initial
candidates/diagnostic output were not separately retained. See host-compact
fixtures for these evidence limits; these hosts manually loaded source skills,
not the native mock runtime. Current gates: 647 tests in 85 files, typecheck, lint,
build/context, three skill validators and 86 installed-package commands pass.

### Native fresh plugin discovery — 2026-10-14

`node scripts/audit-codex-plugin.mjs` passes against Codex CLI 0.162.1. A copied
local marketplace is registered and the plugin actually installed through Codex
into a new temporary home/cache, not by overwriting the owner's installed cache.
A fresh app-server calls native `skills/list` from an unrelated workspace. All
three `canvas-agent:` skills are enabled, come from the fresh cache, and match
source SKILL.md and bundled reference bytes. Installation and native catalog
responses are retained in the printed synthetic root. The initial literal path
check rejected macOS `/private/var` canonical aliases; canonical path comparison
now verifies cache ownership rather than weakening it to an arbitrary prefix.

No credential or real user setting is copied; no model turn, Canvas request,
student vault or remote marketplace is used. This closes a scoped native fresh
installation/discovery gate, not full skill-body/project-doc injection, desktop
activation, academic host adherence, other clients or `/goal` controller recovery.
At this discovery-only checkpoint native injection was open; the later mock
context-capture increment above verifies delivery, not combined real-host behavior.

### Independent forward hosts — 2026-10-14

Two fresh Luna hosts recovered an existing synthetic ordinary prep and frozen
draft from course-only discovery, executed their derived values, ran the advisory
numeric diagnostic and saved actual finished candidates. The ordinary host used
six operations including the 200-unit comparison missed in earlier retained runs.
The frozen host used five operations, respected captured Part 2/custom headings
and retried completion with identical hashes. Both checks had no flags and still
reported correctness/execution authentication false. Parent inspection of actual
candidates and batches matched reported operations; 7/8-file baseline hashes
preserved every original except the ordinary pending-to-completed record change.
No old artifact/log was retroactively fixed. A frozen show attempt with unsupported
--course failed and was corrected; this usability retry is retained in the record.

`test/fixtures/host-forward` contains the actual candidates (only UUID substituted)
and batches. `test/host-forward-acceptance.test.ts` replays both through fresh
compiled processes and checks numeric reports, source preservation, custom shape,
saved output and repeated completion bytes. Current full gates pass 643 tests in
85 files, typecheck/lint/build/context checks. Fixtures can be prepared separately
with `node scripts/create-host-acceptance.mjs ordinary-prep|frozen-draft`; creation
does not run a model, authorize real coursework or connect Canvas.

This is two scoped independent host observations, not semantic grading or a
universal compliance guarantee. Instructions were manually loaded from source,
not proven native AGENTS injection or fresh installed-plugin activation. Actual
`/goal` interruption, real student/course policy and broader corpus remain open.

### Process recovery and quantitative review — 2026-10-14

`npx tsx scripts/audit-school-recovery.mjs ABS_SCHOOL_CHECKOUT` uses the
explicit School source checkout read-only and temporary synthetic config/vault/
HOME paths. It kills three confirmed live worker processes with SIGKILL: a parked
approval run, a completed synthetic draft, and the actual run store after writing
its temporary replacement but before renaming it over the authoritative record.
A fresh School runner recovers the original parked ID/message prefix and executes
the approved mock gate once. Fresh processes load School's full CLI registration
and config, approve the completed draft locally, and repeat approval without
changing original draft/run or Final bytes. A synthetic deliverable edit survives
into the Final; review-section notes stay in the original draft and are excluded
from the Final under School's existing submission format. Interrupted replacement
leaves the prior complete record readable by a fresh runner; the uncommitted temp
file is retained, not adopted or deleted. Seven School processes are involved;
fetch is denied and asserted unused. Source hashes identify the tested runtime.
This is actual process-death recovery at saved checkpoints and one controlled
atomic-replacement boundary, not every filesystem/crash boundary,
pending-gate CLI/provider recovery, prep generation,
the installed release, academic approval, or the host's `/goal` controller.

The advisory ordinary/frozen `check-numbers` commands replay retained host
candidates that missed executing the 200-unit comparison. Both report that value
without retroactively executing it or changing artifacts. Tests cover recomputed
logs, stale bindings, frozen-only sources, input-only and coincidental source
values, unsafe input and resource bounds. This is lexical presence only;
correctness and execution authentication always remain false. Installed smoke
checks both commands. Current verification is 641 tests across 84 files and 86
installed-package command checks; typecheck, lint, build and context checks pass.
Independent host adherence was unverified at this checkpoint; the later scoped
forward-host increment above provides two observed passes, not a universal claim.

Fresh sync now also rejects file metadata marked hidden/locked for the current
user, as well as the global hidden/locked flags, before downloading or extracting.
Parameterized synthetic tests verify zero download requests and no saved blocked
body. See the [Canvas File object documentation](https://canvas.instructure.com/doc/api/files.html).
This does not delete older local copies or certify complete source coverage.

Assignment sync preserves rubric-definition criterion IDs, labels, details,
point weights, range flags and rating guidance, keeping missing points unknown
and zero-valued ratings intact. Only definition-description links are recovered;
private grading objects are not added to academic prompt text. See the
[Canvas rubric definition documentation](https://canvas.instructure.com/doc/api/rubrics.html).
Synthetic fresh-sync tests carry rubric-linked readings and complete definitions
into ordinary and frozen tasks, exclude script bodies, preserve HTML question
headings/lists and common comparison text, and avoid treating rating questions
as posted assignment questions. Existing tasks are not rewritten. This proves
the tested data handoff, not rubric compliance or correct host interpretation.

Run `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. The suite covers GET-only allowlisted sync, HTML-linked file recovery, credential-free CDN redirects, private DNS rejection, extraction/original hashes, onboarding/auth diagnostics, upcoming work, module/session selection, custom prep headings and question answers, assignment revision/approval, calendar overrides/ICS, stale guidance proposal rejection, quantitative batches and fixed-source replay. CI runs on Node 22 and 24.

Context checks enforce a 5000-byte core, 7500-byte complete skills and 24 KiB AGENTS
limit before writing any repair. AGENTS and all three skills contain the same
normal CLI core plus applicable explicit academic outcomes, while the canonical
CLI reference retains the complete detailed catalog outside the shared block.
This leaves room below Codex's [documented default 32 KiB combined project-doc
limit](https://learn.chatgpt.com/docs/agent-configuration/agents-md), but global or
parent instructions can still consume that combined budget. Tests verify drift,
budget failures without partial mutation, installed file size/content and detail
routing structure; the separate native audit now verifies isolated fresh plugin
installation and mock turn-level delivery, not live-host behavior. Do
not increase user settings or rewrite an installed cache to hide a failing check.

Discovery-gap regressions include a real compiled process against a local fake
Canvas HTTP server: a valid profile with course-list 403 still permits sync of the
exact allowlisted ID and safely mapped code. No other allowlisted course is read
by that targeted command and config bytes stay unchanged. A later 401 stops before
course access; malformed discovery is not silently recovered. Backend fixtures
also cover list 404, unavailable selected courses and retained student edits. All
responses/data are synthetic; this is not real-account acceptance.

The same compiled-server flow now starts a second fresh config with an empty
allowlist, reads a valid active-enrollment list, handles general discovery 403 with
a bounded profile check, explicitly onboards one course and syncs that course
only. Backend negatives verify 401, malformed discovery, invalid profiles and
denied active-enrollment evidence leave selection unchanged. Fallback cannot
infer active enrollment from a readable course URL, bypass pilot eligibility or
certify instructor permission/source completeness.

Current numeric-scope host acceptance is retained in
`test/fixtures/host-numeric` and replayed by `test/host-numeric-acceptance.test.ts`.
The primary host read actual ordinary/frozen handoffs and executed the five
calculations before authoring a finished Part 2 response, with matched custom
headings, source references and qualified launch recommendation. Replays substitute
only task IDs, preserve original sources/candidate bytes, verify spreadsheet
values and retry stability, and ensure later live case edits do not enter frozen
inspection/calculations. The README records the initial ambiguous part wording
and rejected bare-array calculator input rather than counting them as passes.
This is one synthetic primary-host exercise, not an independent grader, live
student acceptance or an actual goal-controller interruption. Human verdicts
remain pending.

The retained numeric fixture now includes deliberately flawed supplied work and
the primary host's actual review. It executes the draft's written expression and
the source-based incremental expression, then critiques arithmetic, sunk-cost
treatment, forecast-versus-observation and unsupported zero-effect/approval claims.
Fresh-process replay checks exact review scope/mode, preserved supplied bytes,
separate note and unchanged retry/record bytes; local approval is rejected. These
checks preserve the review boundary. They do not independently grade the critique
or guarantee that all hosts detect all defects in real coursework.

The retained numeric fixture also includes the primary host's current multi-
reading prep brief and the invented framework reading with three posted questions.
The host reads the saved weekly sources, executes the scenario calculations and
authors the complete synthesis/answers/discussion with limitations. Replay checks
source and common-guidance selection, exclusion of future teaching material and
assignment-only preferences, all three captured questions, missing-question
rejection, current provenance and unchanged originals/retry bytes. This is another
primary-host outcome exercise, not a human grading verdict or proof that every
real class is fully covered.

Current-recipe host lifecycle acceptance also retains the supplied edit and the
primary host's full revised response. The host reads the actual diff/feedback and
re-executes the calculations, incorporating the demand-evidence condition as a
local preference without inventing policy or forecast evidence. Replay checks
parent lineage, exact edited/prior input capture, revision reuse, distinct v2
draft, matching locally approved Markdown/spreadsheet copies, unchanged prior
artifacts and byte-stable retry behavior. Approval here is an explicitly tested
local fixture operation; no real student direction, instructor verdict, grade or
remote submission is inferred.

Keep `package-lock.json` and `npm-shrinkwrap.json` aligned after dependency updates:
npm prefers the shrinkwrap, so refresh the development lock from its exact JSON
content as well. Tests and packaging reject drift. Mammoth is bundled with the
verified argparse 2.0.1 override; root overrides alone do not protect a dependency
installation. Package smoke verifies the installed resolution, absence of
sprintf-js, Mammoth help, Word ingestion and production npm audit, rather than
assuming a clean checkout audit means the shipped tree is identical. The
2026-10-14 installed test reports zero audit findings; this is not a general
security or cross-platform certification.

For separate-product disk recovery, first build, then run
`npx tsx scripts/audit-school-coexistence.mjs /absolute/path/to/school-agent`.
The explicit checkout is source-only: no School config, account, environment file
or student vault is loaded. The audit uses synthetic temporary vaults, fresh
compiled Canvas CLI processes and separate School VaultWriter processes. Pending
tasks/briefs survive writer restart; completed task, brief, draft and Final bytes
survive retry and later School updates. It covers three initialization orders,
not all native documents, mid-write process kills, School's complete CLI/provider
workflow or actual Codex `/goal` pause/resume. Do not label those untested gates
passed from this result.

`test/task-inventory.test.ts` now also kills an actual compiled task-writing
process with SIGKILL after task.json is saved but before TASK.md is written.
Test-only filesystem interception establishes that exact boundary; production
code has no fault hook. A fresh CLI discovers the pending ID, reads its unchanged
recipe with `briefStatus: missing`, and completes it without regenerating the
brief. Existing source and other-course task bytes stay unchanged. This covers
one creation boundary, not every mid-write state, School's full runtime or the
host's `/goal` controller.

Packaging acceptance installs the generated tarball into a separate temporary directory, runs the linked CLI from outside the checkout, creates a new config/vault/token template, and runs `doctor --offline`. A plugin remains instructions only: the host also needs a separately installed CLI and local filesystem access.

Saved sweep discovery uses `dogfood sweep list --course COURSE --json` to recover
manifest UUIDs without chat memory. It returns validated selection metadata only;
child status and evidence require show and explicit resume. Tests intentionally
leave a lock and corrupt a child checkpoint: listing must neither touch them nor
claim the child is complete/current. Unknown-scope malformed/linked/oversized or
identity-substituted manifests produce an incomplete inventory without body echo
or repair. Frozen captures/windows remain separate from these sweep records.

`simulate list --course CODE --json` now discovers original and derived captures
from the fixed private namespace, not the live workspace inventory. A compiled
fresh-process regression moves both live course folders outside the vault and
still discovers the selected saved captures, without source-body or other-course
output. The existing reader checks frozen parent bindings; changed parent hashes
invalidate both the parent and derived child in the listing. Malformed, linked,
oversized and identity-substituted records make the inventory incomplete without
rewriting any capture. Listing does not recover evaluation task/window IDs,
certify historical visibility or launch/resume work.

`simulate window list --course CODE --json` discovers hash/schema-validated
saved journal metadata only. It checks internal range/cutoff/phase/task-ID bounds,
but does not read bound captures or tasks; selected window show must validate
those before work continues. Tests verify course isolation, no source/recipe/body
output, unchanged journals, corrupt/linked/oversized records and rehashed invalid
dates. A synthetic building journal retains its partial recorded phase without
automatic repair/adoption. Moving a live course folder and original capture does
not prevent discovery, but the selected show fails, as required. This is discovery,
not a new incomplete-window resume capability or proof of completion.

Explicit continuation is now available separately as
`simulate window resume UUID --course CODE --json` for new versioned journals.
Tests interrupt the actual planner after a saved task-prefix checkpoint, complete
one existing task, then resume through a fresh compiled CLI. That task's recipe,
brief, output and completion receipt stay unchanged; the prior partial journal
is archived exactly, newer live reading text is not used, missing slots become
pending handoffs, and a planned retry leaves journal/history unchanged. Separate
tests preserve recorded creation failures and foreign locks, stop after ownership
replacement, refuse legacy incomplete ownership and reject changed recipe bindings
before adding handoffs. Checkpoint callbacks are source-level synthetic test
instrumentation, not a CLI fault option. This is an orderly interrupted planner;
SIGKILL can retain the exclusive lock and requires explicit inspection, not blind
deletion. Partial task/capture artifacts remain preserved and are never auto-adopted.

`simulate task list --course CODE --json` completes ID discovery for immutable
frozen recipes, using the existing reader's snapshot-bound rederivation. It does
not read completion receipts or output files and never reports a completed or
pending-host state from the recipe's immutable pending field. Tests complete a
synthetic task, change its output, move its live course folder, then rediscover
the recipe in a fresh CLI; selected task show must still reject changed output.
Another course and ordinary-task IDs are omitted. Broken frozen capture bindings,
unsafe/linked/oversized or identity-substituted recipe files make the inventory
incomplete without repair or body echo. Listing is not permission, approval,
academic-quality verification or actual `/goal` controller acceptance.

New setup defaults to `~/canvas-vault` rather than School's default
`~/school-vault`. Backend, command and installed-package checks use synthetic
homes/vaults, leave preexisting School content unchanged, and preserve explicitly
configured existing paths. No existing user config is migrated automatically;
selecting a shared vault remains deliberate and requires preservation handling.

`npm run package:smoke` reports its executed command count in the final JSON. It checks the installed binary's separate default-vault setup, saved-task discovery/status filtering and missing-brief recovery, saved dogfood/sweep/capture discovery and course isolation, prep/draft completion, revision, local approval, derived/window frozen comparison/M1, private feedback/playbook and legacy playbook commands, reminders preview/private save, auth-alert inspection, explicit `sync --full` with an empty allowlist, and supplied host usage. Usage checks preserve the export, retain unknown overall costs when values are absent, sum known USD decimals exactly and reject malformed input without printing its contents. The packaged shared contract, AGENTS.md and three skills match the checkout. This is not live Canvas, actual host-plugin activation, desktop notification delivery or provider-billing acceptance.

Fixed-evaluation arithmetic now also flows into comparison/M1 evidence. Compiled and backend tests verify packaged numeric inputs/results, recomputation and parent/source/inventory hash bindings, including rejection after an empty inventory gains a record. Modified or missing records stop before a new gate is saved. Older comparisons retain uncaptured arithmetic as unknown. A passing consistency check is not proof that inputs came from the sources, every output number was covered, or a timestamp authenticates past execution; the human gate still remains pending.

## Independent host-agent acceptance

Fresh lost-ID acceptance now covers ordinary and frozen prep with separate Luna
contexts, config-only entry and no UUID/answer hints. Both found the original
task IDs and completed those exact tasks. A 22-file pre-delegation hash inventory
shows only the ordinary pending task.json changed on completion; prior completed
work, sources, capture and frozen recipe bytes stayed unchanged, with no new task
IDs. Retained candidates/batches and scope notes are in
`test/fixtures/host-recovery/`. This proves the observed independent discovery/
preservation behavior, not native installed-plugin activation or actual `/goal`
controller recovery.

Both new briefs contain a 200-unit prose comparison without a matching executed
calculation. Their four records cover 20, 12000, 4000 and 400, so quantitative
verification is partial despite successful completion. The frozen agent reported
an unsupported-operation retry; its initial invalid input was not retained.
Calculator help now advertises the supported names and a valid batch example,
sharing one operation registry with frozen record validation. Tests execute every
advertised operation and parse/execute both help examples. This usability fix
does not repair the saved artifacts or certify complete numerical coverage.

A separate Luna host agent followed the bundled prep and assignment skills in an isolated synthetic course. It generated and completed a reading-synthesis brief with exact posted-question answers, citations and explicit missing-evidence statements. It also independently checked a 500-booking pricing example: premium uplift $1,800 minus discount loss $300 minus setup cost $1,000 yields $500 incremental contribution over a $20,000 baseline.

The initial assignment task omitted readings required by its prompt. This exposed a real handoff gap despite structural validation succeeding. The shared CLI contract now requires a source-coverage preflight: recreate a task with explicit, clearly identified in-scope local readings, or ask for missing material and label incomplete work. A passing validator is never evidence that a draft is academically ready. This check is behavioral guidance for the host, not semantic grading by the CLI.

The agent then recreated the task with both required readings, completed a new versioned draft citing them, and retained the genuine demand/conversion/operating-cost gaps. Inspection confirmed current snapshots and no missing task sources. A separate calculator audit recorded `1800 + (-300) + (-1000) = 500` with the assignment prompt as context. This demonstrates the loop with Luna, not equivalent quality guarantees for every host or model.

New workflow v3 handoffs now explicitly require the permitted finished deliverable, executed checks for derived values and a source-based host self-review. Backend/compiled workflow tests verify instruction propagation, question gates and compatibility with saved v1/v2 recipes. A substantive `PENDING — requires …` answer can report an unavailable input without inventing a citation; the missing evidence must still be reviewed. These checks do not prove actual host adherence, correct data extraction or academic quality. The earlier Luna acceptance predates v3 and must not be counted as independent acceptance of the new workflow.

## Live new-student gate

### Compact-entrypoint forward tests (2026-10-14)

Two independent Luna agents used the current checkout's source skills and
compiled CLI in separate synthetic ECON901 vaults. Skills were selected
explicitly; this does not test installed-plugin discovery or automatic AGENTS
injection. Both saved finished, source-cited artifacts, but neither run is a full
quantitative-verification pass:

- Prep task `0e1d482e-49ea-44cc-ad9b-d6fc6a80439d` initially used level-one
  required headings and retried with level two. Its completed brief contains
  derived profit and break-even values, but its task directory has no calculation
  record. The reported command sequence contains no calculator execution.
- Review task `7c2038fb-80c6-4aed-9ecb-d68ab99c4ad9` retains three calculator
  records for revenue, variable costs and incremental profit. The review also
  derives the flawed draft's displayed expression as 1000, without a matching
  executed record. The student's original work remains separate from the note.

The shared core now specifies level-two required sections and level-three exact
question headings. The prep skill explicitly requires verification of every
derived numerical result before completion. Saved workflow v3 recipes and the
initial test artifacts are not rewritten or retroactively certified. A fresh
forward test is required to evaluate the clarification; structural completion
alone remains insufficient. Original isolated evidence is retained locally in
`/tmp/canvas-luna-context-PlPRRe` (temporary, not packaged or durable across a
machine cleanup).

A fresh Luna prep retest created task
`8a340cbf-5e24-4bcd-9644-5c3775aadcbe` in
`/tmp/canvas-prep-forward-retest-MCWgNv`. It completed without a heading retry
and recorded three executed results (12000, 4000, 400), but its derived unit
contribution (20) and forecast-minus-break-even comparison (200) have no matching
execution. This is improvement, not full numerical-verification acceptance. The
shared core now explicitly includes intermediate operands and prose comparisons;
that further clarification still needs independent forward-testing. The agent
also mistakenly initialized its synthetic config in the checkout before moving
that newly generated file to its owned temp directory; future test setup must
provide an explicit config path even on initialization. No real credentials,
account or student vault were used.

After the intermediate-value clarification, fresh Luna task
`7124e2cb-a055-491e-9535-f8519043ec62` in
`/tmp/econ901-synthetic-fIQ1Da` completed a finished synthesis with all three
posted questions and both supplied case deliverables. Inspection of the actual
candidate and calculator log confirms coverage of every derived value it reports:
20, 12000, 4000, 400 and 200. The log includes a repeated 12000 calculation;
all six original operations are retained in the replay fixture, not collapsed
into an invented transcript. `test/fixtures/host-numeric/luna-prep-candidate.md`
retains the candidate with only its task UUID replaced by a replay placeholder;
`luna-prep-calculations.json` retains operations, operands and source paths.
The prep replay now checks both primary-host and Luna candidates through fresh
compiled CLI processes, including exact question gates, scoped source isolation,
unchanged originals and byte-stable completion retries. Deterministic replay is
not a new model invocation or independent academic grading. This one synthetic
forward test meets the observed numerical-verification requirement; it does not
prove universal host adherence, real policy/source completeness or installed
plugin activation.

Current v3 primary-host acceptance has now been exercised separately from the
earlier Luna run. The coding agent read compiled CLI handoffs in a synthetic
ECON101 workspace, captured explicit permission and both readings, authored a
finished prep synthesis answering two posted questions, and completed a pricing
draft covering all three prompt requirements. Five executed calculations yielded
20000, 1800, 300, 500 and 20500; inspection found current sources, and direct XLSX
inspection confirmed the signed contribution values. Demand/cost/test-precision
gaps remain explicit, with no observed business-outcome claim or approval.
Retained sources/candidates and scope notes live in
`test/fixtures/host-v3/`; `test/host-v3-acceptance.test.ts` replays the compiled
mechanics with original-byte preservation. This is one primary-host synthetic
acceptance example, not independent grading, a new model invocation during tests,
installed-plugin acceptance, real-class completeness or general academic quality.


Before relying on the toolkit, the student and their chosen agent must:

1. Obtain access to the private repository and install/build the selected branch. Install its plugin instructions where supported.
2. Run setup with their own absolute config/vault paths; enter their Canvas token locally, never in chat.
3. Run doctor, auth verify, courses list, and explicitly onboard their selected IDs.
4. Sync; review notices, vault health, upcoming work and one course's complete source inventory against Canvas.
5. Produce one prep brief and one permitted assignment outline/draft. Review citations, all prompt/questions/rubric requirements, missing files and quantitative assumptions—not merely completion status.
6. Exercise revision and local approval only at the student's direction. Nothing submits to Canvas.

Do not infer missing AI permission or treat a new student's access as identical to fixture permissions. OCR, external authentication, course-specific formats and host-agent quality require human review. Fixed replay cannot reconstruct past contents or permissions; OS reminders, automatic Drive publication and hosted/mobile agent execution are separate capabilities.
