# API Reference

All routes are under `/api`. Authenticated routes require `Authorization: Bearer <token>` (the JWT from setup/login); "agent token" routes take a per-device `tk-…` token in the same header. External automation uses scoped `ncapi-*` tokens on the public machine surface — full reference in [MACHINE_API.md](MACHINE_API.md).

## Setup & auth

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| GET | `/setup/status` | no | `{ isSetup }` |
| POST | `/setup` | no | Create the master password, returns a token (rate-limited) |
| POST | `/login` | no | Authenticate with the master password, returns a 24h token (rate-limited) |
| POST | `/change-password` | yes | Change the master password (`current_password`, `new_password` ≥ 8 chars) |

## SSH profiles

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| GET | `/profiles` | yes | List SSH profiles (secrets are never included) |
| POST | `/profiles` | yes | Create a profile (name, username, auth_type + credential, optional reboot/shutdown commands) |
| PUT | `/profiles/:id` | yes | Update a profile (empty credential keeps the current one) |
| DELETE | `/profiles/:id` | yes | Delete a profile and detach its devices |

## Devices

Device types: `pc`, `laptop`, `server`, `router`, `switch`, `nas`, `tv`, `printer`, `phone`, `tablet`, `camera`, `console`, `audio`, `iot`, `other`.

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| GET | `/devices` | yes | List all devices (group, base power and per-device action overrides included) |
| GET | `/devices/active` | yes | List active devices |
| POST | `/devices` | yes | Add a device (name, ip, mac, type, optional profile_id, group_id, broadcast_address, base_power_w, `disable_*` flags) |
| PUT | `/devices/:id` | yes | Update a device (404 if unknown) |
| DELETE | `/devices/:id` | yes | Delete a device and all its metrics/actions |
| GET | `/devices/status` | yes | Map of device id → online status (live ping) |
| POST | `/devices/:id/ping` | yes | Ping a single device, returns latency and raw output |
| POST | `/devices/:id/wake` | yes | Send Wake-on-LAN magic packets |
| POST | `/devices/:id/command` | yes | Queue `reboot`, `shutdown`, `hibernate` (agent channel when online, else SSH via the assigned profile) or `update` (agent only — self-updates from the installer and restarts itself) |
| PUT | `/devices/:id/move` | yes | Move a device to a group position (`group_id` + `index`) |
| GET | `/devices/actions` | yes | In-flight power actions of the last 10 minutes (status, failure output) |

## Agent endpoints

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| GET | `/agent/install` | no | Serves the agent installer shell script (`sh install.sh <server_url> <agent_token>`) |
| GET | `/agent/version` | no | Current agent version (used by the UI to flag outdated agents) |
| POST | `/agent/stats` | agent token | Accept a metrics push; upserts live snapshot + raw history, rate-limited per IP. Also accepts claim tokens and auto-registers the device on first contact |
| GET | `/agent/pending-actions` | agent token | Fetch queued actions (marks them acknowledged) |
| GET | `/agent/config` | agent token | Effective agent configuration (push interval, server URL) |
| GET | `/agent/script` | agent token | Latest agent script (used by the `update` action to self-update) |
| POST | `/agent/action-result` | agent token | Report an action result (`started` / `done` / `failed` + output) |

## Device tokens & claims

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| POST | `/devices/:id/agent/token` | yes | Generate or rotate the device's agent token (returned once, stored as a hash) |
| POST | `/devices/:id/agent/reinstall` | yes | Reinstall the agent remotely over SSH using the device's profile (new token generated server-side) |
| POST | `/devices/agents/update` | yes | Queue `update` for every online device running an outdated agent; returns `{ queued, up_to_date, disabled }` |
| POST | `/devices/claim` | yes | Create a one-time claim token (15-min TTL) + install path (`claim_id`, `token`, `install_path`, `expires_at`) |
| GET | `/devices/claims/:id/status` | yes | Claim installation state (`installed`, `last_seen`, last snapshot) |
| DELETE | `/devices/claims/:id` | yes | Cancel a pending claim |

## Network scan

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| POST | `/scan` | yes | Start a background range scan (`startIp`, `endIp`, optional `ports[]` ≤ 100) → `{ scanId }` (rate-limited) |
| GET | `/scan/default-range` | yes | Auto-detected local LAN range for the form |
| GET | `/scan/:id` | yes | Job progress and discovered hosts (`online`, `hostname`, `mac`, `vendor`, `ports[]`) |
| POST | `/scan/:id/cancel` | yes | Cancel a running scan |

## Groups

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| GET | `/groups` | yes | List groups ordered by position |
| POST | `/groups` | yes | Create a group (`name`, optional `icon`, `color`) — 409 on duplicate name |
| PUT | `/groups/:id` | yes | Update name / icon / color |
| DELETE | `/groups/:id` | yes | Delete a group and detach its devices |
| POST | `/groups/reorder` | yes | Reorder all groups (`ids` = every group id exactly once) |

## Metrics & energy

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| GET | `/devices/stats/all` | yes | Latest CPU/RAM/GPU/power summary per device from agent pushes |
| GET | `/devices/:id/stats/live` | yes | Last live snapshot (`live`) and `last_seen` timestamp |
| GET | `/devices/:id/stats/history?range=` | yes | History points, range `1h`\|`6h`\|`24h`\|`7d` (raw) `\|`30d`\|`1y` (aggregated) |
| GET | `/devices/stats/energy?range=` | yes | Fleet energy (`kwh`, `cost`, `currency`) for the range (`1h`\|`6h`\|`24h`\|`7d`\|`30d`\|`1y`) |
| GET | `/devices/:id/stats/energy?range=` | yes | Per-device breakdown: base power offset + CPU/GPU components, kWh and cost (same ranges) |
| GET | `/devices/stats/power?range=` | yes | Fleet power curve in watts (`1h`\|`24h`\|`30d`) |

## Settings

`GET /api/settings` returns the current values; `PUT /api/settings` updates any subset.

| Field | Values |
| --- | --- |
| `cost_per_kwh` | number ≥ 0 or `null` |
| `currency` | ≤ 8-char string (default `€`) |
| `agent_interval_seconds` | integer 5–3600 (agent push interval) |
| `ui_refresh_seconds` | integer 5–3600 (dashboard refresh) |
| `dashboard_view` | `grid` \| `list` |
| `dashboard_card_size` | `normal` \| `compact` \| `minimal` |
| `poweroff_action` | `systemctl suspend` \| `poweroff` |
| `reboot_action` | `reboot` \| `systemctl reboot` |
| `hibernate_action` | `systemctl hibernate` |

Devices can override the action commands individually (`poweroff_action`, `reboot_action`, `hibernate_action` on the device).

## API tokens & data

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api-tokens` | yes | List machine-API tokens (plaintext is never included) |
| POST | `/api-tokens` | yes | Create a token (`label`, `permissions[]` of `status\|start\|stop\|restart`, optional `device_ids[]`, `expires_at`) — plaintext returned once |
| PUT | `/api-tokens/:id` | yes | Update label / permissions / scope / enabled / expiry |
| DELETE | `/api-tokens/:id` | yes | Delete a token and its usage history |
| POST | `/api-tokens/:id/rotate` | yes | Rotate the secret, returns the new plaintext once |
| GET | `/api-tokens/stats?range=` | yes | Usage per token (`7d` \| `30d`) |
| GET | `/api-tokens/logs` | yes | Last 20 usage entries (token, operation, device, status) |
| GET | `/data/export` | yes | JSON of devices, profiles (encrypted credentials) and groups |
| POST | `/data/import` | yes | Idempotent upsert of `devices`, `profiles` and/or `groups`; plaintext credentials are re-encrypted, `enc:v1:` values pass through |

## External machine API (for automation & integrations)

A dedicated public surface for outside systems, authenticated with scoped `ncapi-*` tokens (no master password / JWT). Full reference: [MACHINE_API.md](MACHINE_API.md).
