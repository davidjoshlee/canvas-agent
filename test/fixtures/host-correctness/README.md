# Forward correctness-review host evidence

A fresh Luna host received only checkout/config/course scope for invented ECON903,
not the original task ID, review ID, candidate or expected defects. It manually
read source instructions; this was not native plugin activation or `/goal` resume.
The parent seeded a structurally accepted flawed draft and three calculation
records using scripts/create-correctness-host-acceptance.mjs.

The host discovered the completed draft, created two ordinary review tasks during
workflow exploration, then found correctness prepare and saved the separate note.
The original seven vault files remained byte-identical by parent SHA-256 audit.
Added files were four correctness-review files and four files for the two pending
ordinary review tasks. Those pending tasks were retained, not hidden or deleted.

Actual CLI attempts, in order:

| Command | Exit | Observation |
| --- | --- | --- |
| task list --course ECON903 | 0 | Discovered completed draft |
| task show DRAFT_ID | 0 | Read original context |
| assignment ECON903 --mode review --work DRAFT_PATH | 0 | New pending review omitted pilot context |
| task show FIRST_REVIEW_TASK | 0 | Confirmed missing context |
| assignment ECON903 --mode review --work DRAFT_PATH --context PILOT_PATH | 0 | Second pending review, retained |
| correctness --help | 0 | Found dedicated separate-pass workflow |
| correctness prepare DRAFT_ID | 0 | Created one correctness handoff |
| correctness show REVIEW_ID | 0 | Read bound handoff |
| check-numbers DRAFT_ID --file DRAFT_PATH | 0 | Flagged 8; heuristic, not a grade |
| correctness save REVIEW_ID --file NOTE_PATH | 1 | Exact completed-draft citation was rejected |
| correctness save REVIEW_ID --file NOTE_PATH | 0 | Host adjusted only external note citations |
| correctness show REVIEW_ID | 0 | Completed receipt verified |

The final note is retained verbatim except for its Review UUID placeholder. Parent
inspection confirms it identifies 8 vs recorded contribution 6, a contradictory
fabricated quotation, missing fixed costs/out-of-pilot evidence and no control
group. This is one observed synthetic review, not universal academic correctness.
The initial rejected note was not retained; do not claim a later code fix made
the original attempt successful. Later tests now permit exact validated draft/XLSX
citations. Detailed CLI guidance distinguishes correctness from ordinary review
tasks; new-host acceptance of that clarification remains untested.

Original full command log and artifacts remain in the owned temporary root
canvas-host-correctness-XcCWN7. No account, network, real coursework, approvals,
submissions or source changes were made by the host.
