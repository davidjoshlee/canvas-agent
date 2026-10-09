# Student workflow acceptance — 0.4

This release is tested with synthetic Canvas responses and isolated temporary vaults, not a live student's account. No production course files, credentials or coursework were used or changed.

## Automated gates

Run `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. The suite covers GET-only allowlisted sync, HTML-linked file recovery, credential-free CDN redirects, private DNS rejection, extraction/original hashes, onboarding/auth diagnostics, upcoming work, module/session selection, custom prep headings and question answers, assignment revision/approval, calendar overrides/ICS, stale guidance proposal rejection, quantitative batches and fixed-source replay. CI runs on Node 22 and 24.

Packaging acceptance installs the generated tarball into a separate temporary directory, runs the linked CLI from outside the checkout, creates a new config/vault/token template, and runs `doctor --offline`. A plugin remains instructions only: the host also needs a separately installed CLI and local filesystem access.

## Independent host-agent acceptance

A separate Luna host agent followed the bundled prep and assignment skills in an isolated synthetic course. It generated and completed a reading-synthesis brief with exact posted-question answers, citations and explicit missing-evidence statements. It also independently checked a 500-booking pricing example: premium uplift $1,800 minus discount loss $300 minus setup cost $1,000 yields $500 incremental contribution over a $20,000 baseline.

The initial assignment task omitted readings required by its prompt. This exposed a real handoff gap despite structural validation succeeding. The shared CLI contract now requires a source-coverage preflight: recreate a task with explicit, clearly identified in-scope local readings, or ask for missing material and label incomplete work. A passing validator is never evidence that a draft is academically ready. This check is behavioral guidance for the host, not semantic grading by the CLI.

The agent then recreated the task with both required readings, completed a new versioned draft citing them, and retained the genuine demand/conversion/operating-cost gaps. Inspection confirmed current snapshots and no missing task sources. A separate calculator audit recorded `1800 + (-300) + (-1000) = 500` with the assignment prompt as context. This demonstrates the loop with Luna, not equivalent quality guarantees for every host or model.

## Live new-student gate

Before relying on the toolkit, the student and their chosen agent must:

1. Obtain access to the private repository and install/build the selected branch. Install its plugin instructions where supported.
2. Run setup with their own absolute config/vault paths; enter their Canvas token locally, never in chat.
3. Run doctor, auth verify, courses list, and explicitly onboard their selected IDs.
4. Sync; review notices, vault health, upcoming work and one course's complete source inventory against Canvas.
5. Produce one prep brief and one permitted assignment outline/draft. Review citations, all prompt/questions/rubric requirements, missing files and quantitative assumptions—not merely completion status.
6. Exercise revision and local approval only at the student's direction. Nothing submits to Canvas.

Do not infer missing AI permission or treat a new student's access as identical to fixture permissions. OCR, external authentication, course-specific formats and host-agent quality require human review. Fixed replay cannot reconstruct past contents or permissions; OS reminders, automatic Drive publication and hosted/mobile agent execution are separate capabilities.
