# PicTu Agent Guide

This file is the first stop for anyone changing this repo.

## Working rules

- Use Git for all development work.
- Keep changes grouped by feature or milestone.
- After finishing a meaningful piece of work, make a commit before moving on.
- Do not introduce a PR flow unless the user asks for it.
- Do not overwrite unrelated user changes.
- Prefer small, targeted edits over broad refactors.

## Read first

Start here before opening the whole tree:

- `server/internal/config/config.go` - startup config loading
- `server/internal/store/store.go` - SQLite schema and data access
- `server/internal/api/server.go` - HTTP routes and handlers
- `server/internal/api/planner.go` - planner and LLM flow
- `server/internal/api/upload_provider.go` - upload provider dispatch
- `web/src/App.tsx` - main frontend pages and admin UI
- `web/src/lib/api.ts` - frontend API client
- `web/src/types/api.ts` - shared API types
- `web/src/styles.css` - UI styling

## Change workflow

1. Inspect only the files related to the task.
2. Make the smallest change that matches the request.
3. Build or test the touched area when practical.
4. Review `git diff` before finishing.
5. Commit the work once the feature slice is complete.

## Configuration notes

- `config.toml` and the example TOML files are for startup-only settings.
- Runtime settings should live in SQLite.
- If a setting needs to change from the admin panel, it should not depend on a restart.

## Frontend notes

- Match the existing UI style in the current app.
- Reuse existing page shells, panels, tabs, and form controls.
- Do not add a new visual system unless the user asks for it.

## Default assumptions

- The first registered user becomes admin.
- Existing database content should be migrated forward when possible.
- Default values should exist for new runtime settings so a fresh install works.
