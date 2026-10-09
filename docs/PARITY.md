# Student workflow parity

Canvas Agent keeps School Agent's student-facing workflow while moving content generation into the user's chosen coding agent. It is not a drop-in replacement for School Agent's provider runtime or database.

| Student need | Canvas Agent 0.4 |
| --- | --- |
| First-run setup and course selection | setup, doctor, auth status/verify, courses list, onboard, scoped sync |
| Know what to work on | upcoming, homework, timeline, context; overdue/undated work, announcements, private date overrides and ICS check/export |
| Prepare a class | current week, explicit Monday or unique session; module-linked reading snapshots; course-defined structure and detected question gates |
| Assignment lifecycle | outline/draft/review handoffs; draft by title/ID/path; revise from validated prior output; explicit local approval |
| Read non-Markdown materials | retained originals, basic PDF/DOCX/PPTX/XLSX extraction; HTML-linked Canvas file recovery, bounded retries, credential-free CDN redirects; ingest by week or module |
| Provenance and review | inspect, compare, human review bundle, snapshot/original checks, preserved output versions |
| Quantitative support | arithmetic/statistics/NPV and bounded JSON batches with audit, values-only XLSX artifacts; no arbitrary script execution |
| Course guidance | syllabus-bound proposal handoff and versioned proposed files; human activation remains separate |
| Repeatable evaluation | fixed private source capture/replay with explicit availability metadata; external agent generates the work |
| Agent portability | matching core contract in AGENTS.md and three bundled skills, generated default academic workflows, private task-specific instructions |

## Limits that remain explicit

- This release has synthetic end-to-end verification, not live-account acceptance. A new student's Canvas permissions, external-hosted assets and course-specific conventions still need review before reliance.
- Scanned PDFs need OCR elsewhere; complex Office/PDF tables, equations and layout may not extract faithfully. Unsafe external file hosts are skipped; external downloads never receive Canvas bearer credentials.
- External DNS answers are checked for private/reserved addresses, but fetch does not pin the validated address; this is not a hardened server-side URL-fetch sandbox. Use a trusted Canvas configuration and review download notices.
- Undated modules are not guessed into a week. Select an exact session or associate a local reading with an explicit week. Review notices and source selection before generation.
- Date views and overrides are local; they do not change Canvas. ICS reconciliation supports UTC and date-only values, reporting unsupported timezone/floating forms. OS reminder integration is not reproduced here.
- Inspect/compare/review are provenance tools, not rubric grading. Simulation preserves current source versions filtered by explicit availability metadata; it cannot reconstruct historical file contents, past permissions or every past vault state. Replay requires a separately supplied prompt and policy check.
- Model selection, provider authentication, billing and costs belong to the host coding agent. No hidden model call is added to obtain command-name parity.
- The plugin is instructions-only; another host needs local shell/filesystem access and a separately installed CLI. Installing it is not a hosted mobile backend. Drive publication and unattended schedules are separate capabilities.

Existing v1 task records remain usable, and existing vault files are not migrated. Completion/approval remains local and non-overwriting; nothing submits to Canvas.
