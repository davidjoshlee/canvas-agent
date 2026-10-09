---
name: setup-and-sync
description: Install and onboard the Canvas Agent CLI, select Canvas courses, or sync its local vault. Not for School Agent or generating prep candidates.
---

# Canvas Agent setup and sync

Read [CLI and environment requirements](../../references/cli.md) before operating the toolkit. Plugin installation supplies instructions, not the CLI, a Canvas connection, or access to a student's files. Do not execute from a plugin cache or assume it is the source checkout.

For setup, identify the user's toolkit checkout, explicit Canvas URL, config location and vault path. If the CLI is missing, install from the authorized checkout with Node 22+, `npm ci` and `npm run build`. Use `node /absolute/checkout/dist/cli.js` when the executable is not on PATH; `npm link` is optional and changes the user's npm environment.

Use `init --config PATH --vault PATH --canvas-url URL` for a new config. Preserve an existing config and vault rather than reinitializing them. Course selection is explicit: with the token already set in the configured environment variable, run `courses --json`, show course IDs and names, and ask the user which IDs to allowlist. Update only `courses.allowlist` in the user's selected config. Never select all courses by default.

Have the user provision their Canvas API token locally in the configured environment variable (default `CANVAS_API_TOKEN`). Never request the token in chat, print environment values, persist it in files, or put it into shell command arguments. A missing token is not needed for offline context or tasks. Do not inspect unrelated account credentials or use School Agent configuration implicitly.

When the user asks to sync, run `sync --config PATH --json`, then `context --config PATH --json`. Report preservation notices, skipped external assets, unsupported binary extraction and missing context. Sync is GET-only, refreshes hash-owned source files, and does not remove remotely deleted material locally. Do not claim complete or current coverage merely because sync returned successfully. Do not loop after auth failure: explain the missing setting or access and stop for the user's action.

For a class preparation request, inspect the course inventory and ask for an explicit course and Monday if missing, then create `prep COURSE --week YYYY-MM-DD --config PATH --json`. Route the resulting task to the bundled `canvas-workspace` skill; the CLI itself does not generate content or determine whether AI use is permitted. Never submit to Canvas or configure unattended work from a setup request.
