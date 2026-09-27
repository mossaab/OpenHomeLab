# AGENTS.md — OpenHomeLab

Guide for AI coding agents working in this repository. Read before editing.

## 1. Project Overview

**OpenHomeLab** is a self-hosted network device controller with a web UI: live ping monitoring, Wake-on-LAN, remote reboot/shutdown/hibernate/update (push agent or SSH fallback), per-device metrics collection with energy statistics, an active network scanner, in-browser SSH terminal, and an external machine API — all behind a single master password. The UI is localized (en/fr/es/ar, RTL supported).

**Architecture:**
- **Backend**: a single file `server.ts` (~4900 lines) — Express 4 app, SQLite schema + migrations, auth, rate limiting, WOL packets, SSH execution (node-ssh), network scanning, metrics aggregation jobs, and a WebSocket SSH-PTY terminal bridge (ssh2). There is no separate backend source tree; do not create one.
- **Frontend**: React 19 SPA in `src/` (functional components + hooks only), Tailwind CSS v4, `motion`, `lucide-react`, `recharts`, xterm.js for the terminal. Served by the same Express app (Vite middleware in dev, static `dist/` in production).
- **Agent**: a lightweight shell script served at `GET /api/agent/install`; runs on target machines, pushes metrics every N seconds (interval configurable in settings, default 30s), executes pending power actions, and self-updates.

**Tech stack:** Node.js >= 20, TypeScript ~5.8 (ES2022, module ESNext, bundler resolution), Express 4, `sqlite` + `sqlite3`, bcryptjs, jsonwebtoken, node-ssh, ssh2, `ws`, ping (ICMP), dgram (WOL), ipaddr.js, Vite 6, esbuild (server bundle → `dist/server.cjs` CJS, `--packages=external` so native modules load from `node_modules`).

## 2. Directory Structure

```
server.ts                # ENTIRE backend: initDb(), createApp(ctx), all /api routes, WOL, SSH, scanner, metrics jobs, WS terminal
src/
  main.tsx               # React entry (index.html)
  App.tsx                # Auth gate + hash-based tab shell (#/dashboard, #/scanner, #/settings), theme/i18n providers, terminal session manager
  api.ts                 # apiCall<T>() fetch wrapper (auth header from localStorage, 401 → /login, ApiError)
  types.ts               # Frontend TS interfaces (duplicates several server types — keep in sync)
  i18n/                  # Dictionaries en/fr/es/ar + I18nProvider/useI18n; all UI strings go through t()
  index.css              # Tailwind v4 entry
  components/            # Dashboard, DeviceDetail, DevicesSetup, NetworkScanner, ProfilesSetup, SettingsPanel + sub-settings
                         # (Appearance/Monitoring/Power/Security), ApiTokensSetup, DataImportExport, TerminalDialog/Dock,
                         # SetupWizard, GroupManager, AgentTokenDialog, Toast, ...
server-data/oui.json     # MAC vendor DB for scanner enrichment (regenerate with scripts/generate-oui.mjs)
test/                    # Vitest + Supertest API tests (one file per feature area)
scripts/                 # render-icons.mjs (public/*.png from logo.svg), generate-oui.mjs, ops shell scripts
public/                  # PWA assets: manifest.webmanifest, icons, logo.svg
docs/API.md              # Full API route reference (README keeps only an auth-model summary)
docs/MACHINE_API.md      # External machine API reference
dist/                    # Build output (vite assets + dist/server.cjs); gitignored
data/                    # SQLite location in dev (DB_PATH); ignored by eslint and git
.env / .env.example      # Env config read by docker compose (never commit .env)
docker-compose.yml       # Prod: pulls the pre-built GHCR image (${OPENHOMELAB_IMAGE}:${OPENHOMELAB_VERSION})
docker-compose.dev.yml   # Dev: builds the image locally from the Dockerfile
```

## 3. Commands

**Running the server — project rule: ALWAYS via docker compose. Never run `node dist/server.cjs`, `tsx server.ts` or any local dev server to verify behavior.**

Dev = local build via the dev compose file. Prod = plain `docker compose up` pulling the pre-built GHCR image (see README «Releasing»). Both files share the same `openhomelab_sqlite_data` volume, so switching dev ↔ prod needs no data migration.

```bash
docker compose -f docker-compose.dev.yml up --build -d   # build + start (reads .env automatically; no --env-file)
curl http://localhost:1214/api/setup/status               # health check → {"isSetup":...}
docker compose -f docker-compose.dev.yml ps               # state
docker compose -f docker-compose.dev.yml logs app         # logs
docker compose -f docker-compose.dev.yml restart          # restart (SQLite persists via sqlite_data volume)
docker compose -f docker-compose.dev.yml down             # stop (NEVER delete the sqlite_data volume)
```

Host port is **1214** (`network_mode: host` — required for WOL broadcast; internal PORT defaults to 3000). Production refuses to start without a non-default `JWT_SECRET`.

**Build / lint / test (allowed locally):**

```bash
npm install
npm run build        # vite build && esbuild server.ts → dist/server.cjs
npm run lint         # eslint . && tsc --noEmit  (run after EVERY change)
npm test             # vitest run — full API suite
npx vitest run test/metrics.test.ts              # single file
npx vitest run test/server.test.ts -t 'subtest name'   # single test by name
```

## 4. Code Conventions

- **No comments** in code unless explicitly asked. No emoji, no decorative naming.
- Prettier (`.prettierrc`): `singleQuote`, `trailingComma: "all"`, `printWidth: 110`, `tabWidth: 2`.
- Path alias `@/` → project root (configured in both `tsconfig.json` and `vite.config.ts`).
- `.tsx` for React components, `.ts` for logic/server. No React classes.
- Server style: DB rows are cast with `as { col: type }[]`; validation helpers return `string | null` (error message or null); route handlers wrap async logic in `asyncHandler(fn)` to reach the Express error middleware; responses use `{ success: true, ... }` on success and `{ error: '...' }` with a precise status code (400/401/403/404/429/500) on failure.
- Frontend i18n: **all user-facing strings go through `t()`** from `useI18n()`. When adding UI text, add the key to every dictionary in `src/i18n/*` (`en.ts` is canonical and defines the `Dict` type).
- Secrets are never logged and never returned in plaintext by the API (credentials come back as `enc:v1:...` prefixes at most).
- ESLint: react-hooks plugin, `no-explicit-any` warn, unused vars error (`_` prefix exempt).

## 5. Key Abstractions

All defined in `server.ts` and exported where useful:

- **`initDb(dbPath?) → AppContext { db, jwtSecret, encKey }`** — opens SQLite, runs all `CREATE TABLE IF NOT EXISTS` + PRAGMA-based `ALTER TABLE` migrations, seeds the `settings` row, resolves the encryption key (env `APP_ENCRYPTION_KEY` or generated+stored in DB), migrates legacy plaintext credentials.
- **`createApp(ctx)`** — Express app factory; testable in isolation with a temp DB. Route order matters: public routes (`/setup/*`, `/login`, all `/agent/*`, all `/api/machines/*`) are defined first, then **`app.use('/api', requireAuth)`** (~line 2343) guards everything below it. The terminal WebSocket at `/api/terminal/ws` authenticates via JWT query param on upgrade.
- **Credential crypto**: `encryptCredential(value, key)` / `decryptCredential(stored, key)` — AES-256-GCM, format `enc:v1:{iv_hex}:{tag_hex}:{data_hex}`, key via `scryptSync(secret, 'netcontrol-enc-salt-v1', 32)`.
- **`executePowerAction(db, encKey, deviceId, action)`** — the hybrid power path shared by UI and external API. Actions: `reboot | shutdown | hibernate | update`. If the device has an agent token and pushed metrics < `agentStaleMsFor(interval)` (max(90s, 3× interval)) ago → queue a `device_actions` row (channel `agent`); else fall back to the per-device command over SSH (channel `ssh`). Per-device action commands override the defaults stored in `settings`.
- **Agent onboarding** (two paths): (a) UI-issued agent token (`tk-*`) pasted into the install script; (b) zero-config **claim flow** — `clm-*` code with 15-min TTL, target runs the installer with `--claim <code>`, and the first metrics push auto-registers the device. Tokens/claims are stored only as SHA-256 hashes.
- **WOL**: `wakeDevice()`, `sendWoL()` (UDP dgram), `getBroadcastAddresses()` (host interfaces) + `computeBroadcastFromIp()` + per-device `broadcast_address`.
- **Agent payload**: `sanitizeAgentPayload(body, receivedAt)` — strict clamping/normalization to an `AgentSnapshot`; returns null if invalid. Push upserts `metrics_live`, inserts `metrics_raw`, and marks in-flight actions `done` ("device back online").
- **Metrics pipeline** (5-min job via `startMetricsJob`): `aggregateMetrics()` rolls raw → hourly/daily with `ON CONFLICT ... DO UPDATE` idempotency and prunes raw past 7 days; `settleStaleActions()` completes actions whose agent went offline; `pruneApiUsage()` keeps 30 days of usage. Energy: `computeEnergyKwh()` + `trapezoidKwh()` — gaps wider than `energyGapLimitMsFor(interval)` (max(150s, 5× interval)) contribute zero; per-device breakdown applies a `base_power_w` offset and splits cpu/gpu components.
- **Network scanner**: in-memory background jobs (`scanJobs` map, 10-min TTL) with progress polling, ARP discovery + port probing, vendor enrichment from `server-data/oui.json`, cancellable; results are returned via the job endpoint (not persisted).
- **Web terminal**: `attachTerminalWs()` bridges a WebSocket at `/api/terminal/ws` to an ssh2 PTY (xterm.js on the client); targets a `device` (its SSH credentials) or a `host` profile.
- **Rate limiters** (in-memory per process): `authRateLimiter` (5 req / 15 min on setup+login), `agentRateLimiter`, `apiRateLimiter` (60/min).
- **External API**: `requireApiToken(operation)` middleware — hashed `ncapi-*` tokens with permission lists (`status|start|stop|restart`) and device scoping; usage recorded in `api_usage` on response finish. See `docs/MACHINE_API.md`.
- **Frontend**: `apiCall<T>(endpoint, options?)` from `src/api.ts` is the only fetch path — attach auth, throw `ApiError`, redirect on 401. New UI endpoints = add here + type in `src/types.ts`.

**DB tables** (created/migrated in `initDb`): `settings` (single row id=1: master_password_hash, app_encryption_key, cost_per_kwh, currency, agent_interval_seconds, ui_refresh_seconds, action defaults, UI prefs), `groups`, `profiles`, `devices`, `agent_claims`, `metrics_live`, `metrics_raw`, `metrics_hourly`, `metrics_daily`, `device_actions`, `api_tokens`, `api_usage`. No FK cascades — referential cleanup is done in JS.

## 6. Common Pitfalls

1. **Public vs protected routes**: `app.use('/api', requireAuth)` sits at ~line 2343. Any new public route (agent/machines-style) must be defined ABOVE it, with its own auth middleware; protected routes go below it.
2. **Schema changes need dual updates**: add the column to the `CREATE TABLE` block AND a `PRAGMA table_info` + `ALTER TABLE` migration in `initDb()`, or existing databases break.
3. **Device deletion** must manually clean `metrics_live`, `metrics_raw`, `metrics_hourly`, `metrics_daily`, `device_actions`, and device-scoped API token entries; **profile deletion** must set `devices.profile_id = NULL` for attached devices; **group deletion** detaches member devices (no FK cascades exist anywhere).
4. **Action delivery is at-most-once**: `pending → acknowledged → started → done|failed`. Never re-deliver `acknowledged` actions; stale ones are dropped/settled by the UI window and `settleStaleActions()`.
5. **Never change `APP_ENCRYPTION_KEY`** after credentials exist — stored SSH secrets become undecryptable. The key is generated once and persisted in `settings.app_encryption_key`.
6. **Credentials**: encrypt on write, decrypt only at use (SSH exec / terminal), never serialize decrypted values into responses or logs. Import (`POST /api/data/import`) passes through `enc:v1:` values as-is — preserve that behavior.
7. **Type drift**: several interfaces exist twice (server exports + `src/types.ts`). Change both when a shape changes, or the frontend breaks silently at runtime.
8. **Tests must not start the server**: importing `server.ts` in tests is safe because `startServer()` runs only when `NODE_ENV !== 'test'`. Tests build their own stack with `initDb(tempPath)` + `createApp(ctx)` — always use a temp dir DB and close it in `afterAll`.
9. **Docker constraints**: keep `network_mode: host`, `NET_RAW` (ICMP ping) + `NET_BROADCAST` (WOL UDP broadcast send), and the `sqlite_data` volume. The container runs as non-root `node` (uid 1000); volumes from older root-era images need a one-time `chown -R 1000:1000` before first start (see README). WOL silently fails without NET_BROADCAST; deleting the volume destroys the DB. `.env` is read automatically by compose — don't pass `--env-file`.
10. **Vite config HMR lines are deliberate** (`DISABLE_HMR` handling to prevent flicker during agent edits) — do not "clean up" those lines.
11. **esbuild uses `--packages=external`**: native modules (sqlite3, bcryptjs via prebuilds) stay external and resolve from the image's `node_modules`; don't inline them or the Docker build/runtime breaks.
12. **Frontend has no router**: views are hash-based state in `App.tsx`. Don't introduce react-router without restructuring `App.tsx` deliberately.
13. **i18n drift**: user-facing strings must exist in ALL `src/i18n/*` dictionaries (en is canonical and defines `Dict`). Missing keys silently fall back to English at runtime.
