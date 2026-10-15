# Independent host numeric-review forward acceptance

These are actual outputs from two fresh Luna coding hosts on 2026-10-14, using
only invented engineering sources from `host-numeric`. Neither host received
task UUIDs, prior candidates, replay text, or calculation answers. They manually
read source AGENTS/the applicable skill, recovered the existing task by course,
read saved sources and explicit fixture permission, executed arithmetic, authored
a finished candidate, ran the advisory numeric check, and saved it. Only UUIDs
are replaced with `{{TASK_ID}}` for regression replay; no headings/answers are
adapted. Batches are retained as authored.

Ordinary prep root: `/var/folders/p0/jl0b091915qg3rjq_shj70zw0000gn/T/canvas-host-ordinary-prep-GSxqv8`.
It executed six results: 20, 12000, 4000, 400, 200, 400, including the prose
comparison missed by earlier retained hosts. The seven-file baseline changed
only the original pending task record on completion. All original source/guidance
and TASK.md bytes remained unchanged. It did not retry completion; regression
replay separately tests retries.

Frozen draft root: `/var/folders/p0/jl0b091915qg3rjq_shj70zw0000gn/T/canvas-host-frozen-draft-eISLsB`.
It executed five results: 30000, 18000, 12000, 4000, 400. The captured custom
Recommendation/Computations/Limitations/Sources structure and Part 2 scope were
preserved. Its eight-file baseline remained byte-identical. Completion was
retried with identical hashes; state remains completed-pending-human with no
verdict, approval, submission or workbook (no finished table was supplied).
An initial read-only `simulate task show UUID --course ECON901` failed because
show does not accept --course; the host corrected it to show UUID with config.

Both numeric checks reported no flags while correctness/execution-authentication
remained false. The parent inspected the actual candidates, arithmetic batches
and baseline hashes. These are two scoped observed passes, not a universal host
adherence guarantee, independent academic grading, actual course/student policy
acceptance, native installed-plugin activation/injection, or `/goal` interruption.
