# Implementation contract (0.4)

The executable's `--help` and `plugins/canvas-agent/references/cli.md` are the command authority. All context/task paths are vault-relative POSIX paths except WorkspaceContext.vault and ToolkitConfig.vault.path. Source hashes are SHA-256 of file bytes; extracted text also retains its original path/hash. Never copy personal data/configuration from siblings.

## Modules and invariants

- `inspectVaultHistory(vault)` is the read-only history diagnostic seam used by `vault history status`, full/offline doctor and vault health. It never creates locks/snapshots/repairs, reads current vault document bodies, installs Git or contacts a remote. Disabled state needs no Git and certifies no retained history. Enabled readiness verifies owned store configuration, latest commit/tree and bounded blob headers; missing blobs are errors, but full history/body integrity and current-vault equivalence remain explicitly unverified. Held locks mean unknown readiness, not proof of live jobs. Missing/unusable Git affects configured backup readiness, not authentication; doctor --sync-only deliberately omits this optional check. Invalid metadata is content-free; unsafe/unavailable status exits 1, while empty/locked is advisory. Tests compare complete synthetic vault/store byte and directory inventories across inspection.

- `vault-history.ts` / `vault-history-cli.ts`: explicit default-off local Git history in a new private bare store disjoint from the vault, with exact vault binding and isolated Git environment/config/hooks. No adoption of existing `.git`, remote, checkout, reset, deletion or automatic lock removal. Bounded regular-file inventories preserve text/binary bytes, reject links/credential indicators/changed inventories, skip only `.git` and the control record, and reuse identical trees. Opted-in mutating commands snapshot on success or failure (including partial writes) without changing the primary outcome; config-free/read-only commands do not trigger captures. Hooks never append to JSON stdout. List/show expose bounded commit/tree metadata; export requires an exact reachable commit and a new absolute file outside vault/store, with blob verification and no overwrite. Disable preserves history; re-enable only the same store. Bounds: 50 MB/file, 64 MB aggregate, 10,000 source entries/depth 64, 40,000 store entries, 20-second Git child deadline. Two verified inventories are not a universal concurrent-writer transaction; secret heuristics and Git hashes do not prove secrecy, authorship or historical availability. Partial failed initialization is preserved for explicit inspection, not silently adopted or cleaned.

- `config.ts`: `loadConfig(configPath)`, `createConfig(configPath,input)`, `setupConfig(configPath,input)`, `loadAdjacentEnv(configPath)`, `saveAllowlist(configPath,ids)`. Config-relative path resolution, no replacement on initialization, default empty allowlist. Setup creates a blank private `.env`; the student provisions the token locally. Shell environment takes precedence. Preserve existing files and reject symlinks. Allowlist updates preserve unrelated fields and reject detected concurrent changes.
- `canvas.ts`: `listCourses(config)`, `listActiveCourses(config)`, `verifyAuth(config)`, `syncCourses(config)`. GET-only transport with configured env token, same-origin pagination and explicit sync ID allowlist. Auth verification requires a bounded JSON user profile with ID/name (256 KB, 10-second body deadline), rejects HTML/malformed/stalled responses without body echo and returns no identity data; successful API auth is independent of stale expiry hints and per-course content permissions. HTML-linked file recovery, bounded retries/timeouts and manual credential-free external CDN redirects. Refresh only hash-owned files; preserve student edits and untracked files. Manifest is `_meta/canvas-courses.json`, ownership state `_meta/canvas-sync-state.json`. Reject course-code collisions before writing. Page identity uses Canvas page_id, module Page links page_url; file/assignment links use content_id. Optional discussion/announcement failures become notices.
- `content.ts`: `extractText(input)`, `ingestFile(vault,course,file,title?,options?:{week?:string;module?:string;asOf?:string})`. Bounded selectable PDF and basic DOCX/PPTX/XLSX extraction; no model or OCR. Originals are retained with hash-linked sidecars. Ingest week must be a real Monday; explicit asOf is availability, not a teaching date. Period/availability sidecars preserve one original across multiple versions. Never eagerly decompress unbounded archives or reuse changed/linked originals.
- Quiz sync fetches the optional paginated course `/quizzes` list only, saving sanitized descriptions as `type: quizzes` in `Canvas/Quizzes`. Resolve module Quiz links by their quiz namespace; recover description-linked files through the existing bounded pipeline. Preserve hash ownership/student edits. Permission gaps become notices; authentication failures stop sync. Never fetch questions, answers, attempts or quiz submission endpoints. Description context is not authorization to complete a graded quiz.
- `canvas-feedback.ts`: minimize authenticated assignment `/submissions/self` responses (1 MB, 10-second body deadline) to private score/grade, rubric and comment snapshots. No work/attachments/history/author identities. Hash-named retained versions and checked-at current records stay under `_meta/canvas-feedback` with 0700 directories/0600 files, managed ownership and archive-before-current validation. `feedback COURSE --assignment ID` is an explicit bounded local read; validates course/assignment, permissions, symlinks, schema, hash and archive binding without echoing malformed bodies. Missing values are unknown; author role, present grade and academic permission remain unverified. No automatic task-source injection or public playbook/reading-copy export.
- `session-dates.ts`: pure course-year resolution and module-title teaching-date parsing. Term/start/end evidence, recognized term code, then unique modal assignment deadline year; no current-clock fallback. Validate real calendar dates, honor explicit title years and report ambiguity/invalid/missing year. Fresh sync writes `session_at` plus `session_date_source` into hash-owned module documents, preserving API release fields. Teaching dates are not asserted API releases; old/student-edited module files are never silently rewritten on read.
- Private playbook views retain hash-bound feedback values, not invented event chronology. New current-workflow ordinary tasks capture optional `learningHistory` separately from academic sources/guidance; bind course identity/root and every archived value, 500 rows/5 MB without silent truncation. Preserve old tasks, do not enrich frozen simulations, and do not emit private bodies in provenance summaries. Completion and lifecycle/review/compare checks revalidate archives; revision reuse requires matching fresh private context. The instruction treats feedback as untrusted learning context, not instructor verification, current grades, academic evidence or permission. The value inventory is deduplicated; old observation times remain unknown.
- New feedback current records optionally carry per-assignment observation chains: baseline then distinct consecutive data hashes, contiguous sequence numbers, captured local times, and a tail equal to current dataHash. A→B→A retains three observations; unchanged refreshes retain the chain unchanged. Validate every referenced archive/scope before updates and reads, fail without rewriting malformed history, and enforce 1,000 observations/assignment and 5,000/view. Learning-history hashes include available observations; old records without the optional field stay unchanged. Cache-observation order/time is not instructor grading chronology, and no old timestamps are reconstructed.
- `legacy-playbook.ts`: explicitly inspect/import only the chosen School course's standard `_meta/course-playbook.md`, bounded UTF-8/no links and permitted metadata. Match URL/account/course identity; copy to private hash-bound snapshots under `_meta/canvas-playbooks/<ID>/<root-hash>/`, 50 snapshots/5 MB. Preserve originals and old captures, make identical imports idempotent, and bind imported text into new ordinary learningHistory only. Historical dates/authorship remain unverified, and sourceHash means current original bytes. Never infer feedback events from old text, inject into frozen evaluations, or export private copies as reading material.
- `workspace.ts`: `inspectWorkspace(vault)`, `selectCourse(context,query)`. Read-only course-code and manifest-root inventory without a database. Skip private metadata, hidden entries, credential-like files, symlinks and unsupported binaries. Restricted/unknown policy-marked content has no source text. Check sidecar original integrity and original Markdown policy; extraction cannot launder restrictions. Context output omits source bodies. Missing/ambiguous course selectors fail. Operational created/updated/lock timestamps are not class dates.
- `module-context.ts`: expand only explicit same-course relations from approved records; fail closed above the graph bound. `related_paths` contains full vault-relative paths (as sync writes them), or paths relative to the course root, not basenames relative to the source file. Missing targets produce workspace notices, not external fetches.
- New prep records persist `prepSelectionVersion: 2`; source `moduleDates` retains raw unlock/session dates. Weekly module selection prefers unlock over session and includes modules whose explicitly linked assignment is due in the window. Unflagged prep recipes keep flat-date selection on read/completion; frozen recipes bind the flag separately from assignment selection and question-parser versions. Capture readers verify module dates against their private visibility inventory. Do not reconstruct missing date identity from a flattened list or rewrite old records. Strict assignment freshness ignores only additive moduleDates absent from old snapshots and JSON key order, not identity, source bytes or other field values.
- `requirements.ts`, `workflows.ts`: resolve course `## Brief structure` headings, append mandatory Sources, and detect plainly enumerated questions. New tasks use `workflowForRequirements` v3; saved v2 recipes remain available explicitly and `workflowFor` retains v1 compatibility. Draft v3 requires the actual permitted deliverable, executed derived-value checks and source-based host self-review; review v3 flags ungrounded claims/values without rewriting work. Academic instructions are embedded in JSON and TASK.md, and default blocks are mechanically shared with AGENTS.md/plugin skills. Task-specific requirements override generic defaults. These instructions guide content; they do not prove correctness or AI permission.
- `tasks.ts`: `createPrepTask(vault,course,weekValue?,options?:{session?:string;now?:Date})`, `createAssignmentTask(vault,course,sourcePath,mode,workPath?,contextPaths?,revision?)`, `readTask(vault,id)`. Prep defaults to the host-local current Monday; explicit dates must be Mondays. Week/session are exclusive. Select actual period material and approved relationships plus course references/guidance, never a syllabus-only or link-only-index success. Session identity must be unique. Assignments preserve the prompt as first source and require outline/draft/review/discuss mode; review requires selected text work in Draft/Drafts. Private immutable snapshots and TASK.md live in `_meta/tasks/<UUID>/`. Source/identity/workflow inconsistencies fail; never silently upgrade existing v1/v2 records.
- `completion.ts`: `completeTask(vault,id,candidateFile)`, `readVerifiedCompletedOutput(vault,id)`. Recompute course/period destinations and verify identity, headings, approved citations, unchanged sources/guidance/policy and original hashes. Questions require exact subheadings with substantive answer bodies and a source citation or explicit evidence gap. Reject unsafe/private candidates; this is not semantic grading. Atomically save non-overwriting versions; identical retries are idempotent. Completed output hashes must match before reuse.
- `lifecycle.ts`: `reviseTask(vault,id,feedback,workPath?)` creates a fresh draft from validated completed draft/outline and explicit feedback. Retry reuse requires current v3 workflow plus freshly matching source/guidance/edited-work snapshots and selected context. `approveTask(vault,id)` saves a versioned local Finals copy without replacing prior work; unchanged retries reuse it. Approval requires student direction and never submits.
- Discussion is an assignment mode with an explicit bounded student inquiry, exact blockquoted question preservation and a separate Discussion-note output. Do not force all prompt questions or create/approve/revise a graded draft as discussion. Credential/private-path and source-currentness checks still apply; literal inquiry references are not response evidence citations.
- `onboarding.ts`, `health.ts`, `upcoming.ts`: explicitly chosen active course IDs, local config/auth/vault diagnostics and upcoming/overdue/undated assignment views; timeline adds announcements. Local views do not imply a fresh remote fetch. Auth status checks presence; auth verify checks the server with GET. Health warnings must identify missing/stale context without exposing bodies or tokens.
- `tools.ts`, `tool-cli.ts`: bounded finite arithmetic, values-only XLSX, provenance inspection/comparison and human review bundles. No student code, formulas or macros execute. Records stay private under their task; artifact outputs are versioned in the authoritative destination. A recorded source link does not prove the calculation's inputs came from it. Gates are not academic scores.
  Ordinary output comparison/review shares completion's automatic workbook
  validator before returning findings or saving a bundle. Report exact companion
  hashes, byte changes, empty extraction, pending and uncaptured legacy states.
  Scope is automatic completion companions only; explicit workbook-command
  artifacts are not inventoried. Missing/edited companions stop, without repair;
  byte fidelity does not establish grounding or academic completeness.
- `simulation-calculations.ts`, `calculation-input.ts`: fixed-evaluation single/batch arithmetic and safe JSON inputs. Reuse the pure ordinary calculator; bind private records to the evaluation recipe/snapshot and optional selected source hash, never current-vault substitutions. Validate complete batches before an exclusive locked/atomic write. Readers recompute results and reject malformed records, changed bindings, unsafe paths and resource overflows. New comparison/M1 bundles capture and revalidate the complete arithmetic inventory, including empty inventories; old comparisons leave arithmetic uncaptured/unknown. No source-grounding, execution-time authentication or academic-quality claim.
- `simulation-workbooks.ts`, `json-input.ts`: explicit values-only evaluation companions and shared redacted bounded JSON input. Outputs stay private, preserve prior bundles and bind normalized input/output bytes to the frozen recipe and optional selected source. The shared writer uses fixed ZIP dates for reproducible byte verification and bounds rows, columns, cells, text and sheets. Reject tampered/incomplete/linked bundles and held locks; never delete/adopt them automatically. New comparison/M1 inventories combine explicit bundles and the validated automatic completion workbook, including empty inventories; old comparison bundles report unknown rather than zero. Reserve one of 20 combined slots while a new draft evaluation is pending, release it on no-table completion; bound total workbook evidence to 50 MB.
- `simulation-tasks.ts`: new frozen draft recipes persist workbookVersion 1 and automatically save candidate-bound output.xlsx when finished tables/Computations are present. Exclusive completion and workbook locks coordinate atomic non-overwriting installs; interrupted matching outputs without a receipt can recover, but changed/missing completed outputs cannot be repaired by retry. Inspect verifies both files, normalized-input binding and the exact immutable recipe. Completion retries also validate explicit inventory. Old unflagged recipes/completions remain unchanged; no current-vault substitution, publication or academic grade.
- `draft-workbook.ts`: bounded finished-Markdown table/Computations extraction into values-only reproducible XLSX, with named/deduplicated sheets and accounting-number conversion. Exclude fenced examples/comments; no formula execution. New ordinary draft tasks opt into workbookVersion 1; completion reserves paired filenames, recovers interrupted paired writes, binds output hashes and revalidates bytes before retry/revision/approval. Local approval copies both files without replacing existing versions. Older unflagged tasks retain their original behavior. Extraction is not arithmetic, evidence grounding or academic grading.
- `cli.ts`: `runCli(args?)`, Commander registration and consistent JSON output. `--config` works before/after nested commands; stdout contains results, stderr safe errors without stacks/tokens. Config is explicit in agent workflows. Setup, upcoming views and generation handoff never imply permission for publication, submission or unattended work.
- `reading-copy.ts`, `reading-copy-cli.ts`: course-folder snapshots and an explicitly enabled one-way Current mirror, separate from the working vault. Bound inventory, validate policy/provenance and destination safety, preserve originals, reject unowned output collisions, recover changed/deleted copies, and keep ownership state private. Successful-write hooks refresh locally; mirror failure is a warning, not failure of already-saved primary work. Cloud upload/account selection is external. Disabled mirrors retain ownership for safe re-enable.
- `legacy.ts`: explicit School Agent assignment-header inspection and import into fresh pending tasks. Validate eligible Drafts work, course/prompt/run identity, bounds and version ambiguity. Preserve originals and historical namespaces; never invent past source hashes or approval. Historical references are not automatic source selection. Task-private links must match captured student-work hash and provenance; source-currentness remains the ordinary task audit.
- `obsidian.ts`: names/metadata-only readiness and exclusive guide creation; preserve source/settings bodies. Block private paths, symlinks and unsafe guide paths. Optional app launch permits only a path-only open URI and does not register vaults or configure Sync. Local viewing is not permission to upload course content.

## Verification and scope

Public School baseline is pinned to b22c8e2a798e2acdf7e6cc63d6c7659788635b0d,
not inferred from the different local checkout. New answerEvidenceVersion 1
adds its supplementary English prep-answer vocabulary thresholds (5 distinct
content terms, 3 novel vs question, 2 novel terms in selected source text).
Current citation/heading/source-currentness/gap checks remain; exact backticked
path strings cannot inflate term counts. Source vocabulary is bounded/prepared
once, not re-scanned for every question. Explicit gaps retain prior rules;
old unflagged records are not upgraded. Bind the flag in ordinary/frozen recipes
and authoritative workflows; reject wrong kinds/older workflows/parsers.
Lexical overlap is heuristic, not semantic correctness or verified grounding.

The School source audit distinguishes persistence from destructive follow-up
commands. Confirmed SIGKILL checkpoints preserve parked/completed state, but
controlled School revision approval overwrites its old Final and prep rerun
removes a prior hand edit. Do not imitate those baseline defects or rerun
completed School work as recovery. Canvas fresh-process tests reject changed
completion retries and preserve prior prep/task/draft/Final versions. This does
not authorize sibling fixes, certify shared writers or prove `/goal` recovery.

`guidance-inventory.ts` provides read-only course-scoped list and original-ID
show recovery for private proposals. The shared bounded record reader validates
schema/identity/UTF-8 and rejects unsafe links with no body echo (2 MB/record,
100 MB inventory, 1000 entries). Corrupt unknown-course records make listings
incomplete. Show locates records/handoffs, reports missing handoffs without
repair and emits only metadata/counts/saved paths; no feedback/source bodies,
currentness, archive/candidate verification or activation inference. Existing
proposal IDs/bytes and versioned outputs are preserved; older records are not
enriched or upgraded. Saving still performs the currentness/archive checks.

New guidance proposal records pin proposalContextVersion 1 and snapshot up to 12
syllabi plus five readable same-course assignment prompts. Rank by valid postedAt
then dueAt fallback, deterministic path ties and undated last; this is not release
or grading chronology. Exclude feedback/summary files, existing work and restricted
records. Saving revalidates selected inventory/hash/body/type, including newly
entering prompts; unrelated unselected edits need not stale the proposal. Older
unflagged records stay syllabus-only. Preserve common-guide selection, inactive
versioned candidates and 1.5 MB text/2 MB record bounds. No private feedback is
captured by this recipe; never turn graded memo shape into weekly prep structure.

New proposalFeedbackVersion 1 separately captures up to five meaningful current
own-feedback cache values, ranked by local checked time, not grading chronology.
Repeatable --feedback-assignment IDs narrow the selection (unique, at most five).
The private learningHistory excludes older values, observations and legacy
playbooks, is capped at 500 KB and counts toward the 1.5 MB aggregate limit.
Save verifies archives and selected identities/value hashes; unchanged refreshes
are permitted, changed selections/values require a new proposal. Older unflagged
proposals remain un-enriched. Proposed files never activate automatically or enter
reading copies; review/redact private lessons before manual activation/sharing.

New prepStructureVersion 1 accepts plain/comma-separated safe section names under
Brief structure/Prep brief structure, appends Sources, and is rederived on reads.
Fresh ordinary tasks pin it when parsing differs; fresh frozen prep recipes pin it
explicitly. Existing unflagged tasks retain their original parsing and workflows.

New guidance proposalStructureVersion 1 requires a single explicit non-example
prep structure with at least one substantive section, parsed through the same
declaredPrepSections parser as fresh tasks. Reject missing/empty/Sources-only,
duplicate, unsafe or fenced declarations before writing. The flag is separate
from input/feedback selection; old unflagged proposals retain their save rules.
No automatic activation, structure rewriting or academic validation is implied.

Agent context synchronization now generates compact entrypoint outcomes and
the full default workflow reference from workflows.ts, without modifying saved
workflow versions. All entrypoints retain the exact shared core (5000 bytes max);
complete skills are bounded to 7500 bytes and AGENTS to 24 KiB. Resolve every
target/reference before repair writes. The native Codex 0.162.1 audit verifies
fresh installation/discovery and complete skill/AGENTS body delivery in four
read-only mock-provider turns. It observed prior 8000-character truncation;
this is a version-scoped delivery test, not actual model adherence, a global
instruction-budget guarantee or a goal-controller interruption test.

`numeric-review.ts` provides read-only ordinary/frozen candidate numeric-presence
diagnostics. It requires safe bounded structurally valid candidates, recomputes
recorded operations, validates source path/hash context and labels scalar presence
without body output or writes. Missing/input-only values need review; source or
result equality does not verify claim grounding, complete execution, timestamps,
completed-output authenticity, permission or academic quality. Ordinary review
uses saved sources without currentness claims; frozen review never substitutes
live data. Corrupt records/links/credentials/bounds stop without repair. The
heuristic can miss unsupported notation or unrelated matching values and flag
labels/dates/rounding; correctness/execution-authentication flags remain false.

New `simulation.ts` captures retain a versioned private visibility inventory:
source identity/hash, own dates/releases and exact approved module membership.
`simulation-visibility.ts` implements labeled School structural fallbacks only
when no explicit release exists: module release, due date, post-setup creation.
Explicit future/invalid dates never fall back; ambiguous module membership fails.
Readers recompute inferred signals and source bindings; derived views preserve
the same parent inventory. Old unflagged captures stay explicit-only. Comparison
and M1 bind rule/count evidence without claiming historical visibility or grades.
`simulation.ts` supports derivation of an equal/earlier cutoff view from one
original capture. Never reread live course sources, extend the parent cutoff or
chain derivatives. Child readers validate the bound original hash and exact
filtered source/guidance/exclusion inventories, even if a tampered child has a
new checksum. Preserve original capture time and all old snapshot bytes; redact
malformed snapshot JSON errors. This underpins multi-week frozen evaluation.

`simulation-window.ts` creates/inspects/compares inclusive date-window plans
from one original capture (52 cutoffs/250 potential handoffs). Private journals
bind capture/module identity, exact cutoff selections and task recipe hashes.
Sample cutoffs every seven days; preserve the cutoff separately from its UTC
Monday teaching week used for prep. Compare by exact cutoff or teaching Monday.
Generate pending weekly prep and visible drafts, optionally restricting drafts to
one captured module; unavailable modules never lend future membership. Record
creation failures explicitly and preserve partial journals/old artifacts. Show
validates metadata and completion state without live source reads or claiming a
live job. Comparison requires completed selected handoffs and delegates existing
human review/M1, with a 100-output cap and optional exact-week/review-only refs.
No hidden generation, overwrite, historical reconstruction or automatic grading.

New window journals opt into `planningVersion: 1` with exclusive planner locks,
inode-checked release and hash-named prior-journal archives (500 checkpoints/
100 MB). Explicit window resume revalidates frozen captures, selection prefixes,
recipes and completed outputs, then creates only missing handoffs. Existing task
IDs and recorded failures remain unchanged; planned retries are read-only. Held
locks, legacy incomplete ownership, changed bindings and corrupt history stop
without forced adoption or repair. Unbound artifacts from interrupted writes are
retained, not guessed into the plan. No current-source substitution or automatic
generation/completion/human verdict occurs.

`portable-document.ts` is a staged serializer, not the active sync format. It
remains a separate document-interchange experiment. Preservation mode instead
persists `syncNamespace: "Canvas Agent"` in selected course mappings. Sync writes
below that namespace; new ordinary tasks use `productNamespaceVersion: 1` with
authoritative product destinations, including Generated paths for School-source
workflows. Old recipes retain their original destinations. Do not silently activate
over a hash-owned native root Home, use unsafe mapping fallback, overwrite School
originals, or migrate global School markers. The actual-School coexistence audit
verifies selected synthetic flows in both writer orders, not installed-release or
all-format compatibility. The staged portable serializer
returns strict School-compatible Markdown plus separately hash-bound Canvas
context (relationships, extraction provenance and module position). Callers must
supply explicit eligibility/restriction/status/source metadata; there are no
permission-granting defaults. Context cannot override policy or provenance hash
checks. Module roots use typed item lines, without inline metadata/comments that
break School's loader. Synthetic actual-School parser/selector audit passes,
but context persistence/rehydration, ownership-safe sync integration and existing
path/ordering migration remain unfinished. Do not claim shared writers are safe
or advance whole-vault markers from serializer/parser success.

Modules have no I/O on import. Tests use synthetic Canvas responses/documents and temporary vaults, including compiled CLI fresh-student and lifecycle flows. Never use a live student account/vault during development. Run context parity, build, typecheck, lint, focused regressions and the full suite.

No provider integrations, automatic submission, hosted MCP, direct Drive sync, unattended schedules or historical reconstruction. Existing School Agent folders are read without rewriting by default; explicit scoped migration preview/apply is a separate archive-backed filesystem/index transaction and never advances whole-vault School markers. Native Canvas files are not certified for alternating School writers. Preserve student originals, guidance, drafts and completed outputs. The toolkit never generates academic content internally; the selected coding agent does that using the saved task.
