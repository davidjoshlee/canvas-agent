# Current parity completion audit

Status: not achieved. This is the current evidence summary; historical increments
in PARITY.md/ACCEPTANCE.md are not independent completion certificates.

## Baselines checked on 2026-10-14

- Public School: `davidjoshlee/school-agent-public`, main commit
  `b22c8e2a798e2acdf7e6cc63d6c7659788635b0d`, package 0.1.1, public.
- Local School is a different working checkout (package 0.0.0), not the public
  commit. Git blob checks match public runner and Canvas sync; prep, assignment,
  guidance proposal and vault writer differ. Prior actual-School runtime audits
  exercised the local checkout. They must not be relabeled public-release tests.
- A separate temporary checkout of the pinned public commit now passes locked
  dependency installation, native SQLite rebuild, TypeScript build and launcher
  version/help checks. Its synthetic recovery audit runs 15 fresh processes with
  five confirmed kills and reproduces both preservation gaps. Source is unchanged.
- A locally packed installation of that public source now also executes eight
  real CLI processes with native SQLite and only the provider factory mocked:
  doctor, prep, draft, approval/retry, revision, revision approval and prep rerun.
  Both overwrite gaps reproduce. This is selected installed CLI acceptance,
  not live provider/sync, approval-tool or published-release acceptance.
- Canvas GitHub remains private. The owner has now approved committing/pushing
  the parity branch for review, not merging or changing repository visibility.
  Earlier remote observations below are historical, not current release evidence.
  Implementation commit `1c54fb8` and whitespace/review-note follow-up `66b73e1`
  are pushed on `feat/student-workflow-parity`; draft PR
  [#1](https://github.com/davidjoshlee/canvas-agent/pull/1) is open against main.
  This review handoff is not a merge, release or full parity certificate.
- The owner also approved the two separate public School preservation fixes.
  Local School fix commit `e5161248253aeb40d448c8b2176b0f4d9c2d0dd9`, on
  `fix/preserve-prep-and-approved-finals`, preserves changed prep/Final output
  using numbered siblings and reuses exact-byte retries. It is not pushed or
  merged into public main; the private School checkout and real vault are untouched.
  Its full suite passes 449 tests with one skipped; typecheck/lint/build pass
  (lint retains informational suggestions). A fresh packed install executes ten
  actual CLI processes with native SQLite and a mocked provider factory, preserving
  edited prep, original drafts and earlier Finals, including repeated approvals
  and prep retries. No live provider, sync or academic-quality acceptance is implied.

Public source was fetched at the immutable commit above, not inferred from
installed plugin version or mutable main documentation. Public prep has two
additional checks absent locally: matching module/Week placement is mandatory,
and question answers need non-generic source vocabulary overlap. Public assignment
and proposal changes primarily add a course-root readiness guard; vault writer
also protects current whole-vault marker handling. These source differences do
not certify a runtime install or compatibility of alternating writers.

## Requirement-by-requirement state

| Requirement | Current evidence | Completion state |
| --- | --- | --- |
| Explicit-course onboarding, `.env`, auth and coverage diagnostics | Source/compiled/install synthetic tests; verified API auth separated from expiry hints/content permissions | Implemented; real new-student institutional acceptance not verified |
| Read-only School index reconciliation | Explicit outside-vault index and numeric course scope; thirteen diagnostic/snapshot regressions, real writer manifest format and installed success/refusal commands; private checked database/WAL copies preserve original index/sidecar bytes | Implemented for supported School schema/local metadata; no automatic relinking, remote availability or authenticated authorship claims |
| Upcoming/homework/timeline and assignment handoff | Compiled and package flows, overdue/undated handling, explicit IDs/scope | Implemented; complete real-class inventory not verified |
| Prep course/period selection and custom shape | Versioned ordinary/frozen recipes, plain declarations, exact questions, no syllabus/empty/pointer-only success; unmatched/operational-only period refusals tested | Implemented; explicit dated local fallback is supported without claiming a School Week/module layout |
| Non-generic prep answer gate | New answerEvidenceVersion 1 supplements exact heading/citation/gap checks with public School's word/novelty/source-overlap thresholds for questions and imperative items; ordinary/frozen binding and old-record tests | Implemented; compiled/install synthetic checks pass, heuristic is not academic grading |
| Finished host-authored prep/draft/review/guidance | Retained forward Luna candidates and fresh-process recovery; current matching-cache installed native Luna frozen draft completes the same task after two retained source/citation gate failures, with six executed operations and all eight originals preserved. Fresh read-only recovery retrieves exact text/hash while preserving eleven files | Selected synthetic current-guidance native forward/recovery evidence; not universal academic correctness or interruption coverage |
| Separate correctness-review pass | Source-host journaled forward/recovery preserves twelve files; authenticated native installed-plugin/package Luna frozen review finds seeded defects and preserves eight originals, with a retained discovery failure | Selected source and native frozen-review evidence; actual controller recovery, other academic flows and reviewer independence remain unverified |
| Revision, approval and preservation | Canvas fresh-process multi-version Final/edited-prep tests and actual completion kill between Markdown/workbook commits; pinned public School baseline retains two reproduced bugs; separate local School fix passes full suite and ten installed CLI lifecycle/retry commands | Selected fixes verified locally/in freshly packed installation; School fix not yet shipped to public main |
| Optional local vault Git history (`gitInit` in School) | Pinned public LocalVaultGit/VaultWriter and vault regression confirm optional commits; new setup disables it but the legacy schema defaults an omitted flag to true. Canvas has private external Git snapshots, discovery/export, automatic success/partial-failure capture and 15 history tests. Read-only status integrates doctor/vault health. A real Git partial-import SIGKILL preserves prior store/ref/current edits; a fresh ingest succeeds with an honest backup warning, preserving the locked store. Full suite and 153 installed commands pass | Implemented bounded history/readiness and selected mid-import preservation/primary continuation; no automatic stale-lock repair, full-history body-integrity/current-vault equivalence certification, School Git adoption or arbitrary-size backup |
| Lost-context task/proposal/frozen/dogfood/window discovery | Metadata discovery/resumable planners, directed native saved-output recovery and School reader; an actual native prep host is SIGKILLed at candidate-write with all seven originals unchanged, then a fresh author completes the same UUID preserving candidate/sources and the eleven-record arithmetic prefix | Selected controller/fresh-session/process-interruption recovery established; path/patch retries are retained, paused/mid-generation controller interruption and all-workflow coverage remain untested |
| Source formats/extraction and calculations/XLSX | Synthetic differential/extraction audits, source hashes, bounded calculations and spreadsheets; actual installed School parser/reader now accepts seven-format explicit declared-policy compatible ingestion, and Canvas context checks companion/original hashes while preserving native sidecars/recipes | Selected mechanics and explicit compatibility mode verified; unchanged legacy sidecars are not auto-converted, live corpus/academic spreadsheet quality and universal interchange not certified |
| Legacy migration/history and two-product vault preservation | Explicit scope, archive-backed transactions, namespaces; pinned public source and locally packed installed School-first writer/retry preservation pass, Canvas-first/legacy markerless orders refuse unchanged; actual installed School prep/draft/revise/approve mechanics execute with native SQLite and a mocked provider factory, reproducing both overwrite gaps | Selected source/installed CLI cases verified; public markerless adoption, native all-format interchange, approval-tool and published-release acceptance unfinished |
| Frozen evaluation/window/comparison/M1 and dogfood sweeps | Versioned immutable captures/visibility, cutoff/window orchestration, human scorecards and checkpoint recovery | Implemented selected flows; live source coverage/human verdicts remain unverified |
| One-way reading copies and Obsidian access | Local snapshot/mirror hooks, exclusions/ownership, configured-path checks | Local mechanics verified; actual selected Drive upload/phone/sharing/OS delivery not verified |
| Agent-context parity and clean package | Current fresh install/five mock requests capture all three complete skills, full AGENTS and combined context. The authorized isolated cache is archived/refreshed and matches all seven current files; matching-cache native Luna frozen draft plus fresh exact-output recovery preserve eight original/eleven recovery files. Topic lookup is used; two candidate gate failures and one recovery literal-query miss remain retained | Current-guidance selected matching-cache forward/recovery established; raw authenticated injection/semantic attention, other hosts and mid-generation interruption unverified |
| GitHub handoff/release for another user | Parity implementation pushed to private repository; draft PR #1 open against main | Review handoff available to authorized repository users; not merged/released, no visibility change |

## Intentional design boundaries, not hidden parity

Last full automated gates: **773 tests/108 files** pass again in 75.73 seconds with two
workers and the existing explicit 20-second test/hook allowances; typecheck,
lint/build/context and whitespace checks pass. The isolated installed package
smoke passes **153 commands**, including optional local Git history/automatic
capture/safe export/readiness diagnostics, installed topic excerpts and refusal, version identification
and ordinary/frozen correctness-review handoffs. Its
dependency audit reports zero findings. The latest
public-baseline audit also executes the pinned public School source with fresh
locked dependencies, fixed mock generation and real CLI completed approvals.
It rejects generic prep answers and unmatched periods without changing prior
prep bytes; this is not provider-backed generation or actual `/goal` recovery.
Current GitHub
visibility/PR/branch observations are point-in-time and do not ship local work.

The `instructions --topic PHRASE --json` lookup additionally has 22 focused
instruction/context tests. Earlier broad runs timed out/reported failures and
two were stopped (exit 143); the preceding default suite also had timing/cleanup
failures. Those failed executions remain documented, not relabeled green. All
40 tests in the three recently failing files then pass serially, followed by the
full current suite/package pass above. The package operator now retains failed
synthetic fixtures and private start/terminal command journals; a real ENOENT
fault regression verifies retention and excludes environment/output bodies.
See ACCEPTANCE.md for exact scope. After those runtime gates, current-guidance
mock run vWH7vf captures five complete-context requests, isolated refresh tglmjO
archives/replaces only the authorized temporary code cache, and native frozen
draft l3Cv3t plus fresh recovery a6Lm9S use matching current guidance. The draft
corrects two validation failures; recovery retains a literal topic miss. Eight
original files and eleven recovery files are preserved respectively. This is
selected forward/fresh-session recovery, not raw authenticated request capture,
all-host adherence or actual mid-generation goal-controller interruption.

After that full run, the new real-Git interruption test is further strengthened
with fresh primary-ingest continuation while the store remains locked; its focused
rerun passes in 825 ms. No production code changes in that turn. See ACCEPTANCE.md
for the failed initial harness checkpoint and exact fault scope. Separate School
fixes and Canvas review handoff were subsequently explicitly authorized by the
owner. Earlier baseline failures remain retained. The separate School fix is
locally committed and installed-tested as described above; this does not turn
either product into a released or universally compatible implementation.

Canvas remains model-free. The chosen coding host authors work; the CLI does not
own provider calls, model routing, provider budgets/billing or automatic grading.
Those are explicit architecture differences requested for this separate product,
not functionalities secretly implemented by mocks. Canvas never submits work.
Read-only phone copies require an explicitly private destination and external
cloud-client upload; no implicit accounts, sharing or subscriptions are added.

Do not imitate known School overwrite defects or fabricate historical access,
feedback authorship, permission, costs, source completeness or human verdicts.
Keep older saved recipes/context intact. Green tests establish only their
asserted scope. Close the real functional gaps and obtain the missing scoped
acceptance/publication evidence before marking the full goal achieved.
