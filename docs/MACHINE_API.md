# Machine API

The external machine API lets outside systems (automation, dashboards, CI) monitor and power-control machines managed by OpenHomeLab — status/stats, start (Wake-on-LAN), stop and restart. It is fully independent from the UI: no master password, no JWT, only scoped `ncapi-*` tokens.

- **Base URL**: your server root (Docker compose default host port: `http://localhost:1214`)
- **Auth header**: `Authorization: Bearer ncapi-<token>` on every request
- **Content type**: JSON (no request body is needed for the machine endpoints)

## 1. Getting an API token

Tokens are created by an authenticated UI user (master password → JWT). There is no self-service endpoint on the machine API itself.

```bash
# 1. Log in with the master password (rate-limited: 5 attempts / 15 min)
curl -s -X POST http://localhost:1214/api/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"<master-password>"}'
# → { "token": "<jwt>" }

# 2. Create an API token (permissions ⊆ status|start|stop|restart)
curl -s -X POST http://localhost:1214/api/api-tokens \
  -H "Authorization: Bearer <jwt>" \
  -H 'Content-Type: application/json' \
  -d '{
    "label": "home-automation",
    "permissions": ["status", "restart"],
    "device_ids": [1, 3]
  }'
# → { "id": 4, "token": "ncapi-…48 hex chars…" }
```

- `device_ids: []` (or omitted) = the token works on **all** machines; a non-empty list scopes it to those device ids only.
- Optional fields: `enabled` (default `true`), `expires_at` (epoch ms in the future, or `null` = never).
- The plaintext token is returned **once**, at creation/rotation time. It is stored as a SHA-256 hash — treat it like a password.

Token management endpoints (all require the UI JWT):

| Method | Route | Description |
| --- | --- | --- |
| GET | `/api/api-tokens` | List tokens (hash, never plaintext) |
| POST | `/api/api-tokens` | Create; returns `{ id, token }` |
| PUT | `/api/api-tokens/:id` | Update label/permissions/scope/enabled/expiry |
| DELETE | `/api/api-tokens/:id` | Delete token + its usage history |
| POST | `/api/api-tokens/:id/rotate` | New plaintext token, same id; returns `{ id, token }` |
| GET | `/api/api-tokens/stats?range=7d\|30d` | Usage counts per token/operation |

## 2. Permissions

Each token carries a subset of: `status`, `start`, `stop`, `restart`.

| Permission | Grants |
| --- | --- |
| `status` | `GET /api/machines`, `GET /api/machines/:id/status` |
| `start` | `POST /api/machines/:id/start` (Wake-on-LAN) |
| `stop` | `POST /api/machines/:id/stop` (shutdown) |
| `restart` | `POST /api/machines/:id/restart` |

A missing permission → `403 API token is not allowed to <operation>`. A machine outside the token's `device_ids` scope → `403 Machine is not allowed for this API token`.

## 3. Endpoints

`:id` in all paths accepts either the **numeric device id** or the **device name**.

### GET `/api/machines` — list machines with live status

Permission: `status`. Returns one entry per machine in scope, each probed with a real ICMP ping at request time.

```bash
curl -s http://localhost:1214/api/machines \
  -H "Authorization: Bearer ncapi-…"
```

```json
{
  "machines": [
    {
      "id": 1,
      "name": "office-pc",
      "ip": "192.168.1.50",
      "online": true,
      "latency_ms": 2.3,
      "agent_online": true,
      "last_agent_seen": 1758288000000
    },
    {
      "id": 2,
      "name": "nas",
      "ip": "192.168.1.42",
      "online": true,
      "latency_ms": 4.1,
      "agent_online": false,
      "last_agent_seen": null
    }
  ]
}
```

### GET `/api/machines/:id/status` — single machine status

Permission: `status`. Same object shape as one list entry (flat, no wrapper):

```bash
curl -s http://localhost:1214/api/machines/office-pc/status \
  -H "Authorization: Bearer ncapi-…"
# → { "id": 1, "name": "office-pc", "ip": "…", "online": true,
#      "latency_ms": 2.3, "agent_online": true, "last_agent_seen": 1758288000000 }
```

Field semantics:

| Field | Meaning |
| --- | --- |
| `online` / `latency_ms` | Live ICMP probe (1 s timeout) executed on your request. `latency_ms` is `null` when the host doesn't answer |
| `agent_online` | Push agent token installed **and** last metrics push < 90 s old |
| `last_agent_seen` | Epoch **milliseconds** of the last agent push, `null` if never |

### POST `/api/machines/:id/start` — wake the machine (Wake-on-LAN)

Permission: `start`. Sends WOL magic packets to every known broadcast address. No effect on a machine that is already on; requires a MAC address configured and a network path to the broadcast.

```bash
curl -s -X POST http://localhost:1214/api/machines/office-pc/start \
  -H "Authorization: Bearer ncapi-…"
# → 200 { "success": true, "broadcastAddresses": 3 }
```

### POST `/api/machines/:id/stop` — shut down

Permission: `stop`.

### POST `/api/machines/:id/restart` — reboot

Permission: `restart`.

Stop and restart are **hybrid**:

1. If the machine has an installed agent that pushed metrics < 90 s ago → the action is queued for the agent to execute on the target machine → `{ "success": true, "channel": "agent" }`.
2. Otherwise it falls back to SSH using the machine's assigned profile (`shutdown_command` / `reboot_command`, defaulting to `shutdown -h now` / `reboot`) → `{ "success": true, "channel": "ssh" }`.

```bash
curl -s -X POST http://localhost:1214/api/machines/office-pc/restart \
  -H "Authorization: Bearer ncapi-…"
# → 200 { "success": true, "channel": "agent" }   (or "channel": "ssh")
```

Notes:

- `200` means the action was **accepted** (queued for the agent) or the SSH command returned exit code 0 — not that the machine has finished rebooting. Poll status afterwards if you need confirmation.
- Agent-delivered actions are at-most-once: a power command is never re-sent; if the agent dies mid-execution you must call the endpoint again.

## 4. Error contract

All errors are JSON: `{ "error": "<message>" }`.

| Status | Message | Cause |
| --- | --- | --- |
| `401` | `Missing API token` | No/empty `Authorization: Bearer` header |
| `401` | `Unknown API token` | Token not recognized |
| `401` | `API token is disabled` | Token `enabled: false` |
| `401` | `API token has expired` | `expires_at` in the past |
| `403` | `API token is not allowed to <operation>` | Permission missing (e.g. `…to start`) |
| `403` | `Machine is not allowed for this API token` | Machine outside the token's `device_ids` scope |
| `404` | `Machine not found` | `:id` matches no device id or name |
| `400` | `MAC address not found` | `start` on a machine without a MAC |
| `400` | `No SSH profile assigned` | `stop`/`restart`: no agent, and the machine has no SSH profile |
| `429` | `Too many requests` | Rate limit: **60 requests / minute per IP** across all machine endpoints |
| `500` | `Failed to send WOL packet` | All WOL broadcasts failed |
| `500` | `<ssh error message>` | SSH connection/execution failure (stop/restart) |

## 5. Consumer checklist

- Store the token as a secret; rotate with `POST /api/api-tokens/:id/rotate` if it leaks (the old token stops working immediately).
- Grant only the permissions you need and scope `device_ids` to the machines you control.
- Handle `429` with backoff; don't poll status faster than ~1 rps.
- After `stop`/`restart`, verify with `GET /api/machines/:id/status` — expect `online: false` during the reboot window.
- For reliable power control, install the push agent on the machine (`GET /api/agent/install`); without it (or when stale > 90 s) actions depend on an SSH profile.
