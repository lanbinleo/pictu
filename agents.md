# PicTu Agent Guide

This file is the first stop for anyone changing this repo.

## Working rules

- Use Git for all development work.
- Keep changes grouped by feature or milestone.
- After finishing a meaningful piece of work, make a commit before moving on.
- Work on the matching `dev/x.x.x` branch for the current release line.
- Keep release work on the same `dev/x.x.x` branch until the change set is ready.
- Use a PR for publishing and merge through that PR. Once a release PR is opened for already-reviewed code, carry it through to merge without leaving it in a waiting state.
- Do not overwrite unrelated user changes.
- Prefer small, targeted edits over broad refactors.

## Stack overview

- Backend: Go 1.24, Gin HTTP server, modernc SQLite driver, TOML config.
- Frontend: Vite, React, TypeScript, Zustand, lucide-react, react-markdown.
- API routes live in `server/internal/api/server.go`; frontend API calls live in `web/src/lib/api.ts`.
- The app serves the built frontend from the Go server when configured through `server.frontend_dist`.

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
6. When the change is ready for release, open the PR from the matching `dev/x.x.x` branch, merge it, and publish the release with the same version number.

## Verification

- Backend: run `go test ./...` from `server`.
- Frontend: run `npm run build` from `web`.
- For API contract changes, update `web/src/lib/api.ts` and `web/src/types/api.ts` together.
- For database changes, prefer forward-compatible migrations in `server/internal/store/store.go`.

## Configuration notes

- `config.toml` and the example TOML files are for startup-only settings.
- Runtime settings should live in SQLite.
- If a setting needs to change from the admin panel, it should not depend on a restart.
- Avoid committing local secrets or machine-specific values from `config.toml`.

## Frontend notes

- Match the existing UI style in the current app.
- Reuse existing page shells, panels, tabs, and form controls.
- Do not add a new visual system unless the user asks for it.
- Keep text in `web/src/i18n.ts` when it is part of the localized UI.
- Use lucide-react icons when adding toolbar or action buttons.

## Generated and local files

- Do not edit `web/node_modules`.
- Do not edit `web/dist` unless the task is specifically about checked-in build output.
- Treat `pictu.db` and files under `generated/` as local runtime data unless the user says otherwise.

## Default assumptions

- The first registered user becomes admin.
- Existing database content should be migrated forward when possible.
- Default values should exist for new runtime settings so a fresh install works.
- Read the current release version from the root `VERSION` file.
