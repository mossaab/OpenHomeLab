# Contributing to OpenHomeLab

Thanks for your interest in contributing! This guide covers the development setup, project conventions, and what makes a good pull request.

## Development setup

Requires Node.js >= 20.17.

```bash
npm install
cp .env.example .env      # optional: PORT / DB_PATH / JWT_SECRET / APP_ENCRYPTION_KEY
npm run dev               # API + Vite dev server on :3000
```

The first request to `GET /api/setup/status` reports `isSetup: false`; use the setup form to create a master password.

## Project layout

- **`server.ts`** — the entire backend in one file: Express app, SQLite schema + migrations, auth, rate limiting, WOL, SSH execution, network scanner, metrics jobs, and the WebSocket SSH-PTY terminal bridge. There is no separate backend source tree; do not create one.
- **`src/`** — React 19 SPA (functional components + hooks only): `App.tsx` (hash-based tab shell), `api.ts` (the single fetch wrapper), `types.ts` (frontend interfaces), `i18n/` (en/fr/es/ar dictionaries), `components/`.
- **`test/`** — Vitest + Supertest API tests, one file per feature area.
- **`docs/`** — `API.md` (full route reference) and `MACHINE_API.md` (external machine API). Update the relevant doc when you change routes.

## Code conventions

- Format with Prettier using `.prettierrc` (`singleQuote`, trailing commas, print width 110).
- No comments in code unless a reviewer explicitly asks for one.
- TypeScript everywhere; DB rows are cast as `as { col: type }[]`; route handlers wrap async logic in `asyncHandler(fn)`.
- All user-facing UI strings go through `t()` from `useI18n()`. When you add UI text, add the key to **every** dictionary in `src/i18n/` (`en.ts` is canonical and defines the `Dict` type) — missing keys silently fall back to English at runtime.
- Several interfaces exist twice (server exports in `server.ts` + `src/types.ts`). Change both when a shape changes, or the frontend breaks silently.
- Schema changes need **dual updates**: add the column to the `CREATE TABLE` block *and* a `PRAGMA table_info` + `ALTER TABLE` migration in `initDb()`, otherwise existing databases break.
- Secrets are never logged and never returned in plaintext by the API.

## Quality gates

Both of these must pass before opening a pull request:

```bash
npm run lint        # ESLint + tsc --noEmit
npm test            # full Vitest suite
```

Run a single test file while iterating:

```bash
npx vitest run test/metrics.test.ts
```

## Pull request guidelines

- Keep PRs small and focused on one change.
- Add tests for new API routes, following the per-feature pattern in `test/` (temp DB via `initDb` + `createApp`, no server started).
- New UI endpoints: add them to `src/api.ts` plus a type in `src/types.ts`.
- Device/profile/group deletion must keep its manual referential cleanup — there are no FK cascades.
- Do not introduce react-router, a second backend tree, or new top-level dependencies without discussing it first.
