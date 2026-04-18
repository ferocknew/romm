# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RomM is a self-hosted ROM manager and player for game collections. It scans, enriches, browses, and plays game ROMs using metadata from IGDB, ScreenScraper, MobyGames, and other providers, with in-browser emulation via EmulatorJS, RuffleRS, and js-dos. Licensed under AGPL-3.0.

**AI assistance disclosure is required in all pull requests** (see CONTRIBUTING.md).

## Common Commands

### Backend (Python 3.13, managed by `uv`)

```sh
# Install dependencies
uv venv && source .venv/bin/activate && uv sync --all-extras --dev

# Run backend (migrations run automatically)
cd backend && uv run python3 main.py

# Run all tests
cd backend && uv run pytest -vv

# Run a single test file
cd backend && uv run pytest tests/path/to/test_file.py

# Run a specific test
cd backend && uv run pytest tests/path/to/test_file.py::test_function_name
```

### Frontend (Node 24, Vue 3 + Vite)

```sh
cd frontend
npm install
npm run dev          # Dev server with HMR
npm run build        # Production build
npm run typecheck    # TypeScript checking (vue-tsc)
npm run generate     # Regenerate API client from OpenAPI schema (backend must be running)
npm run lint         # ESLint
```

### Linting (Trunk)

```sh
trunk fmt            # Format code
trunk check          # Lint check (required for CI)
```

### Docker Development

```sh
cp env.template .env  # Set ROMM_BASE_PATH=/app/romm, DEV_MODE=true
docker compose build
docker compose up -d
# App at http://localhost:3000
```

## Architecture

### Backend (`backend/`)

FastAPI application with a layered architecture:

- **`main.py`** — App entry point, registers routers, middleware, WebSocket handlers
- **`endpoints/`** — Route handlers (one file per resource), all under `/api` prefix
  - `endpoints/sockets/` — WebSocket handlers (scan, netplay, sync)
  - `endpoints/responses/` — Pydantic response schemas
  - `endpoints/forms/` — Request form models
- **`handler/`** — Business logic layer, separate from routing
  - `handler/database/` — CRUD operations (one module per model)
  - `handler/metadata/` — Metadata provider integrations (IGDB, ScreenScraper, MobyGames, SteamGridDB, RetroAchievements, etc.)
  - `handler/filesystem/` — File I/O (roms, assets, firmware, resources)
  - `handler/auth/` — Authentication (basic + optional OIDC, Redis sessions, CSRF)
  - `handler/sync/` — SSH-based library sync
- **`adapters/`** — External API client adapters for metadata providers
- **`models/`** — SQLAlchemy ORM models (MariaDB + PostgreSQL support)
- **`tasks/`** — Background jobs via RQ (Redis Queue) with three priority queues: `high`, `default`, `low`
- **`decorators/auth.py`** — `@protected_route` enforces scope-based permissions
- **`alembic/`** — Database migrations (run automatically on startup)
- **`config/`** — Environment variable loading and DB engine configuration

**Auth system:** Role-based (VIEWER/EDITOR/ADMIN) with OAuth2 password bearer + optional OIDC. Scope-based API permissions defined in `handler/auth/constants.py`.

### Frontend (`frontend/`)

Vue 3 + Vuetify 3 + TypeScript SPA:

- **`src/views/`** — Page components (Auth, Gallery, Settings, Player, Scan, Patcher)
- **`src/components/`** — Reusable UI components organized by feature area
- **`src/stores/`** — Pinia state management stores
- **`src/services/api/`** — Auto-generated API client from OpenAPI spec
- **`src/__generated__/`** — **Never edit manually** — regenerated via `npm run generate`
- **`src/locales/`** — i18n files (18 languages)
- **`src/console/`** — Separate TV/controller-friendly UI mode
- **`src/composables/`** — Vue composables

Dev proxy: Vite proxies `/api`, `/ws`, `/netplay`, `/openapi.json` to backend at `http://127.0.0.1:${DEV_PORT}`.

### Production Docker (`docker/`)

Multi-stage build: frontend-build → backend-build → nginx serves frontend + proxies API to Gunicorn/uvicorn workers. Slim image excludes emulators; full image includes EmulatorJS, RuffleRS, and js-dos.

## js-dos Integration (DOSBox-X)

js-dos is the third player backend alongside EmulatorJS and RuffleRS, for DOS platform games.

### Key files

- **Backend config:** `DISABLE_JS_DOS` env var → `backend/config/__init__.py` → heartbeat API
- **Frontend route:** `frontend/src/plugins/router.ts` — `ROUTES.JSDOS`
- **Player component:** `frontend/src/views/Player/JSDOS/Base.vue`
- **Type declarations:** `frontend/src/types/jsdos.d.ts`
- **Utils:** `frontend/src/utils/index.ts` — `isJsDosEmulationSupported`, `hasMultipleBackends`, `getSavedBackend`, `saveBackend`
- **PlayBtn:** `frontend/src/components/common/Game/PlayBtn.vue` — DOS platform shows dropdown for backend selection
- **Docker:** `docker/Dockerfile` emulator-stage downloads js-dos from `https://v8.js-dos.com/latest/`

### js-dos v8 API notes

- `Dos(element, options)` does NOT return `CommandInterface`. Use `onEvent("ci-ready", ci)` callback to get the real CI.
- `persist()` returns filesystem changes (ZIP), not a full emulator save state.
- js-dos sidebar provides built-in save management (diskette button) — do NOT use `noSidebar: true` if saves are needed.
- `dosboxConf` option accepts a string to provide dosbox configuration directly (used to inject `[autoexec]` commands from ROM's .conf file).
- DOS game ZIPs contain `.conf` files with `[autoexec]` mount/launch commands — frontend fetches conf content and passes via `dosboxConf`.
- `autoStart: true` is required to skip js-dos config dialog and use the game's `dosboxConf` directly.

### js-dos server-side state persistence

- State save: on "Save & Quit", call `ci.persist()` → upload ZIP via `stateApi.uploadStates()` with `emulator: "js-dos"`.
- State load: auto-select latest `js-dos` state from `rom.user_states`, download persist data, provide via `fsChanges.pull` callback to `Dos()` so js-dos loads it as `bundleChanges` (bundles[1]).
- **Key files**: `frontend/src/views/Player/JSDOS/Base.vue` (player), `utils.ts` (save helpers), `frontend/src/types/jsdos.d.ts` (types, includes `JsDosFsChanges`).
- js-dos v8 source (from `demo/js-dos-8.xx/src/`): `dos-window.tsx` builds bundles array `[bundle, bundleChanges?, initFs?]` → `emulators.dosboxWorker(bundles)`.
- `bundleChanges` loaded via `changesProducer` → `changesFromUrl` → `fsChanges.pull` (server-side) or OPFS (local browser).
- State restoration uses `fsChanges.pull` instead of `initFs` because `bundleChanges` (bundles[1]) is the proper js-dos changes layer, while `initFs` (bundles[2+]) is for additional files.

### Docker test builds

- Workflow: `.github/workflows/test-tag-build.yml` — triggered by `test-*` tags
- Tag format: `test-<VERSION>` (e.g. `test-4.8.1-7`), VERSION file has no `v` prefix
- Version injection: `sed` replaces `<version>` in `backend/__version__.py` during build
- js-dos CDN: only `/latest/` path works, versioned URLs like `/8/` return 404

## Key Patterns

- **Three-layer backend:** `endpoints/` (routing) → `handler/` (business logic) → `models/` (data). Adapters handle external API calls.
- **Background tasks:** RQ workers with scheduled periodic tasks. Base classes in `tasks/tasks.py`.
- **Frontend API types:** Auto-generated from backend's OpenAPI schema. After any backend API change, run `npm run generate` in `frontend/`.
- **Database:** SQLAlchemy ORM supporting both MariaDB and PostgreSQL. Alembic migrations auto-run on startup.
- **Testing:** pytest with VCR.py for HTTP recording, test matrix runs against both MariaDB and PostgreSQL in CI.
