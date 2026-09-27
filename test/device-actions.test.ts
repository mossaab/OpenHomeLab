import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import sqlite3 from 'sqlite3';
import { pendingActionLabel } from '../src/actionLabel';
import { en } from '../src/i18n/en';
import { initDb, createApp, AGENT_VERSION } from '../server';

type Ctx = Awaited<ReturnType<typeof initDb>>;

const enT = (key: keyof typeof en, vars?: Record<string, string | number>): string => {
  let text: string = en[key];
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('Device actions (agent channel + SSH fallback)', () => {
  let tmpDir: string;
  let ctx: Ctx;
  let app: ReturnType<typeof createApp>;
  let token: string;
  let deviceId: number;
  let agentToken: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    delete process.env.APP_ENCRYPTION_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhomelab-actions-'));
    ctx = await initDb(path.join(tmpDir, 'db.sqlite'));

    const hash = await bcrypt.hash('password123', 10);
    await ctx.db.run('UPDATE settings SET master_password_hash = ? WHERE id = 1', [hash]);
    token = jwt.sign({ id: 1 }, ctx.jwtSecret, { expiresIn: '24h' });

    app = createApp(ctx);

    const res = await request(app)
      .post('/api/devices')
      .set(auth())
      .send({ name: 'Action Box', ip: '192.168.1.60', type: 'server' });
    deviceId = res.body.id;

    const tok = await request(app).post(`/api/devices/${deviceId}/agent/token`).set(auth());
    agentToken = tok.body.token;
  });

  afterAll(async () => {
    if (ctx) await ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function pushStats() {
    return request(app)
      .post('/api/agent/stats')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ hostname: 'actionhost', cpu: 30, mem_total: 8_000_000_000, mem_used: 4_000_000_000 });
  }

  async function latestAction(action?: string) {
    const where = action ? `AND action = '${action}'` : '';
    return (await ctx.db.get(
      `SELECT * FROM device_actions WHERE device_id = ? ${where} ORDER BY id DESC LIMIT 1`,
      deviceId
    )) as Record<string, unknown> | undefined;
  }

  describe('schema', () => {
    it('creates the device_actions table and its index', async () => {
      const table = (await ctx.db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='device_actions'"
      )) as { name: string } | undefined;
      expect(table?.name).toBe('device_actions');

      const cols = ((await ctx.db.all('PRAGMA table_info(device_actions)')) as { name: string }[])
        .map((c) => c.name);
      for (const col of ['id', 'device_id', 'action', 'command', 'status', 'output', 'created_at', 'executed_at']) {
        expect(cols).toContain(col);
      }

      const index = (await ctx.db.get(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_device_actions_device_status'"
      )) as { name: string } | undefined;
      expect(index?.name).toBe('idx_device_actions_device_status');
    });

    it('migrates an existing database whose device_actions CHECK lacks hibernate', async () => {
      const migPath = path.join(tmpDir, 'migrate-actions.sqlite');
      await new Promise<void>((resolve, reject) => {
        const raw = new sqlite3.Database(migPath);
        raw.serialize(() => {
          raw.exec(
            `CREATE TABLE device_actions (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               device_id INTEGER NOT NULL,
               action TEXT NOT NULL CHECK (action IN ('reboot', 'shutdown')),
               status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'acknowledged', 'started', 'done', 'failed')),
               output TEXT,
               created_at INTEGER NOT NULL,
               executed_at INTEGER,
               FOREIGN KEY (device_id) REFERENCES devices(id)
             );
             CREATE TABLE settings (id INTEGER PRIMARY KEY);
             INSERT INTO settings (id) VALUES (1);
             INSERT INTO device_actions (device_id, action, status, created_at) VALUES (1, 'reboot', 'pending', 12345);`,
            (err: unknown) => (err ? reject(err) : resolve())
          );
        });
        raw.close();
      });

      const migCtx = await initDb(migPath);
      try {
        const rows = (await migCtx.db.all('SELECT id, action, status, created_at FROM device_actions')) as {
          id: number;
          action: string;
          status: string;
          created_at: number;
        }[];
        expect(rows).toEqual([{ id: 1, action: 'reboot', status: 'pending', created_at: 12345 }]);

        await migCtx.db.run(
          "INSERT INTO device_actions (device_id, action, status, created_at) VALUES (1, 'hibernate', 'pending', 999)",
        );
        const hib = (await migCtx.db.get("SELECT action FROM device_actions WHERE action = 'hibernate'")) as {
          action: string;
        } | undefined;
        expect(hib?.action).toBe('hibernate');
      } finally {
        await migCtx.db.close();
      }
    });

    it('migrates an existing database whose device_actions CHECK lacks update', async () => {
      const migPath = path.join(tmpDir, 'migrate-update.sqlite');
      await new Promise<void>((resolve, reject) => {
        const raw = new sqlite3.Database(migPath);
        raw.serialize(() => {
          raw.exec(
            `CREATE TABLE device_actions (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               device_id INTEGER NOT NULL,
               action TEXT NOT NULL CHECK (action IN ('reboot', 'shutdown', 'hibernate')),
               status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'acknowledged', 'started', 'done', 'failed')),
               output TEXT,
               created_at INTEGER NOT NULL,
               executed_at INTEGER,
               FOREIGN KEY (device_id) REFERENCES devices(id)
             );
             CREATE TABLE settings (id INTEGER PRIMARY KEY);
             INSERT INTO settings (id) VALUES (1);
             INSERT INTO device_actions (device_id, action, status, created_at) VALUES (1, 'hibernate', 'pending', 54321);`,
            (err: unknown) => (err ? reject(err) : resolve())
          );
        });
        raw.close();
      });

      const migCtx = await initDb(migPath);
      try {
        const rows = (await migCtx.db.all('SELECT id, action, status FROM device_actions')) as {
          id: number;
          action: string;
          status: string;
        }[];
        expect(rows).toEqual([{ id: 1, action: 'hibernate', status: 'pending' }]);

        await migCtx.db.run(
          "INSERT INTO device_actions (device_id, action, status, created_at) VALUES (1, 'update', 'pending', 65432)",
        );
        const up = (await migCtx.db.get("SELECT action FROM device_actions WHERE action = 'update'")) as {
          action: string;
        } | undefined;
        expect(up?.action).toBe('update');
      } finally {
        await migCtx.db.close();
      }
    });
  });

  describe('hybrid routing', () => {
    it('routes a command through the agent channel when the last push is fresh', async () => {
      const stats = await pushStats();
      expect(stats.status).toBe(200);

      const res = await request(app)
        .post(`/api/devices/${deviceId}/command`)
        .set(auth())
        .send({ action: 'reboot' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.channel).toBe('agent');

      const row = await latestAction('reboot');
      expect(row).toBeDefined();
      expect(row!.status).toBe('pending');
    });

    it('rejects an unknown action with 400', async () => {
      const res = await request(app)
        .post(`/api/devices/${deviceId}/command`)
        .set(auth())
        .send({ action: 'restart' });
      expect(res.status).toBe(400);
    });

    it('falls back to the SSH path when the last push is stale', async () => {
      await ctx.db.run(
        'UPDATE metrics_live SET received_at = ? WHERE device_id = ?',
        [Date.now() - DAY_MS, deviceId]
      );

      const res = await request(app)
        .post(`/api/devices/${deviceId}/command`)
        .set(auth())
        .send({ action: 'shutdown' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No SSH profile assigned');

      expect(await latestAction('shutdown')).toBeUndefined();
    });

    it('rejects hibernate without an SSH profile when the agent is stale', async () => {
      const res = await request(app)
        .post(`/api/devices/${deviceId}/command`)
        .set(auth())
        .send({ action: 'hibernate' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No SSH profile assigned');

      expect(await latestAction('hibernate')).toBeUndefined();
    });

    it('returns 404 for an unknown device', async () => {
      const res = await request(app)
        .post('/api/devices/99999/command')
        .set(auth())
        .send({ action: 'reboot' });
      expect(res.status).toBe(404);
    });
  });

  describe('agent action endpoints', () => {
    let actionId: number;

    it('requires a valid agent token (401)', async () => {
      const noToken = await request(app).get('/api/agent/pending-actions');
      expect(noToken.status).toBe(401);

      const badToken = await request(app)
        .get('/api/agent/pending-actions')
        .set('Authorization', 'Bearer tk-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
      expect(badToken.status).toBe(401);

      const noResult = await request(app)
        .post('/api/agent/action-result')
        .send({ action_id: 1, status: 'started' });
      expect(noResult.status).toBe(401);
    });

    it('delivers pending actions and acknowledges them on fetch', async () => {
      const res = await request(app)
        .get('/api/agent/pending-actions')
        .set('Authorization', `Bearer ${agentToken}`);
      expect(res.status).toBe(200);
      expect(res.body.actions).toHaveLength(1);
      expect(res.body.actions[0]).toEqual({ id: res.body.actions[0].id, action: 'reboot', command: 'reboot' });
      actionId = res.body.actions[0].id;

      const row = (await ctx.db.get('SELECT status, executed_at FROM device_actions WHERE id = ?', actionId)) as {
        status: string;
        executed_at: number | null;
      };
      expect(row.status).toBe('acknowledged');
      expect(row.executed_at).not.toBeNull();

      const second = await request(app)
        .get('/api/agent/pending-actions')
        .set('Authorization', `Bearer ${agentToken}`);
      expect(second.body.actions).toEqual([]);
    });

    it('rejects invalid result payloads', async () => {
      const noPayload = await request(app)
        .post('/api/agent/action-result')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({});
      expect(noPayload.status).toBe(400);
      expect(noPayload.body.error).toBe('Invalid payload');

      const badStatus = await request(app)
        .post('/api/agent/action-result')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ action_id: actionId, status: 'exploded' });
      expect(badStatus.status).toBe(400);
      expect(badStatus.body.error).toBe('Invalid status');

      const unknown = await request(app)
        .post('/api/agent/action-result')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ action_id: 999_999, status: 'done' });
      expect(unknown.status).toBe(404);
    });

    it('records started and done results with output', async () => {
      const started = await request(app)
        .post('/api/agent/action-result')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ action_id: actionId, status: 'started' });
      expect(started.status).toBe(200);

      const done = await request(app)
        .post('/api/agent/action-result')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ action_id: actionId, status: 'done', output: 'ok' });
      expect(done.status).toBe(200);

      const row = (await ctx.db.get('SELECT status, output FROM device_actions WHERE id = ?', actionId)) as {
        status: string;
        output: string | null;
      };
      expect(row.status).toBe('done');
      expect(row.output).toBe('ok');
    });
  });

  describe('back-online marking', () => {
    it('marks in-flight actions done when the device pushes stats again', async () => {
      const fresh = await pushStats();
      expect(fresh.status).toBe(200);

      const enqueue = await request(app)
        .post(`/api/devices/${deviceId}/command`)
        .set(auth())
        .send({ action: 'reboot' });
      expect(enqueue.status).toBe(200);
      const row = await latestAction('reboot');
      expect(row!.status).toBe('pending');

      const fetch = await request(app)
        .get('/api/agent/pending-actions')
        .set('Authorization', `Bearer ${agentToken}`);
      expect(fetch.status).toBe(200);
      expect(fetch.body.actions.length).toBeGreaterThan(0);

      const backOnline = await pushStats();
      expect(backOnline.status).toBe(200);

      const after = (await ctx.db.get('SELECT status, output FROM device_actions WHERE id = ?', row!.id)) as {
        status: string;
        output: string | null;
      };
      expect(after.status).toBe('done');
      expect(after.output).toBe('device back online');
    });

    it('does not close a pending action on a routine push that precedes the agent fetch', async () => {
      const fresh = await pushStats();
      expect(fresh.status).toBe(200);

      const enqueue = await request(app)
        .post(`/api/devices/${deviceId}/command`)
        .set(auth())
        .send({ action: 'reboot' });
      expect(enqueue.status).toBe(200);
      const row = await latestAction('reboot');
      expect(row!.status).toBe('pending');

      const push = await pushStats();
      expect(push.status).toBe(200);

      const after = (await ctx.db.get('SELECT status FROM device_actions WHERE id = ?', row!.id)) as {
        status: string;
      };
      expect(after.status).toBe('pending');

      const fetch = await request(app)
        .get('/api/agent/pending-actions')
        .set('Authorization', `Bearer ${agentToken}`);
      expect(fetch.status).toBe(200);
      const backOnline = await pushStats();
      expect(backOnline.status).toBe(200);

      const done = (await ctx.db.get('SELECT status FROM device_actions WHERE id = ?', row!.id)) as {
        status: string;
      };
      expect(done.status).toBe('done');
    });
  });

  describe('dashboard actions endpoint', () => {
    it('lists in-flight actions and clears them once done', async () => {
      const absent = await request(app).get('/api/devices/actions').set(auth());
      expect(absent.status).toBe(200);
      expect(absent.body[String(deviceId)]).toBeUndefined();

      const fresh = await pushStats();
      expect(fresh.status).toBe(200);
      const enqueue = await request(app)
        .post(`/api/devices/${deviceId}/command`)
        .set(auth())
        .send({ action: 'shutdown' });
      expect(enqueue.status).toBe(200);

      const listed = await request(app).get('/api/devices/actions').set(auth());
      expect(listed.status).toBe(200);
      const entry = listed.body[String(deviceId)] as { action: string; status: string; created_at: number };
      expect(entry.action).toBe('shutdown');
      expect(['pending', 'acknowledged']).toContain(entry.status);
      expect(typeof entry.created_at).toBe('number');

      await request(app)
        .get('/api/agent/pending-actions')
        .set('Authorization', `Bearer ${agentToken}`);
      const backOnline = await pushStats();
      expect(backOnline.status).toBe(200);

      const cleared = await request(app).get('/api/devices/actions').set(auth());
      expect(cleared.body[String(deviceId)]).toBeUndefined();
    });
  });

  describe('stale action auto-completion', () => {
    const MIN_MS = 60_000;

    it('marks a started action done once the device is confirmed offline after execution', async () => {
      const nowTs = Date.now();
      await ctx.db.run(
        `INSERT INTO device_actions (device_id, action, status, created_at, executed_at) VALUES (?, ?, 'started', ?, ?)`,
        [deviceId, 'shutdown', nowTs - 3 * MIN_MS, nowTs - 2 * MIN_MS]
      );
      await ctx.db.run(
        'UPDATE metrics_live SET received_at = ? WHERE device_id = ?',
        [nowTs - 2 * MIN_MS - 30_000, deviceId]
      );

      const res = await request(app).get('/api/devices/actions').set(auth());
      expect(res.status).toBe(200);
      expect(res.body[String(deviceId)]).toBeUndefined();

      const row = (await ctx.db.get(
        `SELECT status, output FROM device_actions WHERE device_id = ? AND action = 'shutdown' ORDER BY id DESC LIMIT 1`,
        deviceId
      )) as { status: string; output: string | null };
      expect(row.status).toBe('done');
      expect(row.output).toMatch(/offline/i);
    });

    it('keeps a started action within the grace window after execution', async () => {
      const nowTs = Date.now();
      await ctx.db.run(
        `INSERT INTO device_actions (device_id, action, status, created_at, executed_at) VALUES (?, ?, 'started', ?, ?)`,
        [deviceId, 'shutdown', nowTs - 30_000, nowTs - 20_000]
      );
      await ctx.db.run(
        'UPDATE metrics_live SET received_at = ? WHERE device_id = ?',
        [nowTs - 50_000, deviceId]
      );

      const res = await request(app).get('/api/devices/actions').set(auth());
      expect(res.body[String(deviceId)]).toBeDefined();
      expect(res.body[String(deviceId)].status).toBe('started');
    });

    it('leaves pending actions untouched regardless of metrics freshness', async () => {
      const nowTs = Date.now();
      await ctx.db.run(
        `INSERT INTO device_actions (device_id, action, status, created_at) VALUES (?, ?, 'pending', ?)`,
        [deviceId, 'reboot', nowTs - MIN_MS]
      );

      const res = await request(app).get('/api/devices/actions').set(auth());
      expect(res.body[String(deviceId)]).toBeDefined();
      expect(res.body[String(deviceId)].status).toBe('pending');
    });
  });

  describe('hibernate action', () => {
    it('queues hibernate through the agent channel and delivers it to the agent', async () => {
      const stats = await pushStats();
      expect(stats.status).toBe(200);

      const res = await request(app)
        .post(`/api/devices/${deviceId}/command`)
        .set(auth())
        .send({ action: 'hibernate' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.channel).toBe('agent');

      const row = await latestAction('hibernate');
      expect(row).toBeDefined();
      expect(row!.status).toBe('pending');

      const fetch = await request(app)
        .get('/api/agent/pending-actions')
        .set('Authorization', `Bearer ${agentToken}`);
      expect(fetch.status).toBe(200);
      const delivered = (fetch.body.actions as { id: number; action: string }[]).find((a) => a.id === row!.id);
      expect(delivered).toEqual({ id: row!.id, action: 'hibernate', command: 'systemctl hibernate' });

      const backOnline = await pushStats();
      expect(backOnline.status).toBe(200);

      const after = (await ctx.db.get('SELECT status FROM device_actions WHERE id = ?', row!.id)) as {
        status: string;
      };
      expect(after.status).toBe('done');
    });
  });

  describe('update action', () => {
    beforeEach(async () => {
      await ctx.db.run(
        "UPDATE device_actions SET status = 'done' WHERE device_id = ? AND status IN ('pending', 'acknowledged', 'started')",
        [deviceId]
      );
    });

    it('queues an agent update through the agent channel and delivers it', async () => {
      const stats = await pushStats();
      expect(stats.status).toBe(200);

      const res = await request(app)
        .post(`/api/devices/${deviceId}/command`)
        .set(auth())
        .send({ action: 'update' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.channel).toBe('agent');

      const row = await latestAction('update');
      expect(row).toBeDefined();
      expect(row!.status).toBe('pending');

      const fetch = await request(app)
        .get('/api/agent/pending-actions')
        .set('Authorization', `Bearer ${agentToken}`);
      expect(fetch.status).toBe(200);
      const delivered = (fetch.body.actions as { id: number; action: string; command: string | null }[]).find(
        (a) => a.id === row!.id,
      );
      expect(delivered).toEqual({ id: row!.id, action: 'update', command: null });

      await ctx.db.run("UPDATE device_actions SET status = 'done' WHERE id = ?", [row!.id]);
    });

    it('rejects update with 400 when the agent is stale (no SSH fallback)', async () => {
      const before = (await ctx.db.get(
        'SELECT COUNT(*) AS c FROM device_actions WHERE device_id = ? AND action = ?',
        [deviceId, 'update']
      )) as { c: number };

      await ctx.db.run(
        'UPDATE metrics_live SET received_at = ? WHERE device_id = ?',
        [Date.now() - DAY_MS, deviceId]
      );

      const res = await request(app)
        .post(`/api/devices/${deviceId}/command`)
        .set(auth())
        .send({ action: 'update' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Agent must be online to update itself');

      const after = (await ctx.db.get(
        'SELECT COUNT(*) AS c FROM device_actions WHERE device_id = ? AND action = ?',
        [deviceId, 'update']
      )) as { c: number };
      expect(after.c).toBe(before.c);
    });
  });

  describe('bulk agent update', () => {
    let bulkDevices: number[] = [];

    beforeEach(async () => {
      await ctx.db.run('DELETE FROM metrics_live WHERE device_id = ?', [deviceId]);
      for (const id of bulkDevices) {
        await ctx.db.run('DELETE FROM devices WHERE id = ?', [id]);
        await ctx.db.run('DELETE FROM device_actions WHERE device_id = ?', [id]);
        await ctx.db.run('DELETE FROM metrics_live WHERE device_id = ?', [id]);
      }
      bulkDevices = [];
    });

    const makeAgentDevice = async (name: string, ip: string) => {
      const res = await request(app).post('/api/devices').set(auth()).send({ name, ip, type: 'server' });
      expect(res.status).toBe(200);
      const id = res.body.id as number;
      bulkDevices.push(id);
      const tok = await request(app).post(`/api/devices/${id}/agent/token`).set(auth());
      return { id, token: tok.body.token as string };
    };

    const pushWithVersion = (token: string, version: string) =>
      request(app)
        .post('/api/agent/stats')
        .set('Authorization', `Bearer ${token}`)
        .send({ hostname: 'bulkhost', cpu: 10, mem_total: 8_000_000_000, mem_used: 4_000_000_000, agent_version: version });

    it('queues an update for outdated online agents and skips up-to-date ones', async () => {
      const old = await makeAgentDevice('Bulk Old', '192.168.1.201');
      const current = await makeAgentDevice('Bulk New', '192.168.1.202');
      expect((await pushWithVersion(old.token, '1.7')).status).toBe(200);
      expect((await pushWithVersion(current.token, AGENT_VERSION)).status).toBe(200);

      const res = await request(app).post('/api/devices/agents/update').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.queued).toBe(1);
      expect(res.body.up_to_date).toBe(1);

      const oldAction = (await ctx.db.get(
        "SELECT id, status FROM device_actions WHERE device_id = ? AND action = 'update'",
        old.id
      )) as { id: number; status: string } | undefined;
      expect(oldAction).toBeDefined();
      expect(oldAction!.status).toBe('pending');

      const currentAction = await ctx.db.get(
        "SELECT id FROM device_actions WHERE device_id = ? AND action = 'update'",
        current.id
      );
      expect(currentAction).toBeUndefined();

      const fetch = await request(app)
        .get('/api/agent/pending-actions')
        .set('Authorization', `Bearer ${old.token}`);
      expect(fetch.status).toBe(200);
      expect(fetch.body.actions).toContainEqual({ id: oldAction!.id, action: 'update', command: null });
    });

    it('skips agents that are stale even when outdated', async () => {
      const stale = await makeAgentDevice('Bulk Stale', '192.168.1.203');
      expect((await pushWithVersion(stale.token, '0.1')).status).toBe(200);
      await ctx.db.run(
        'UPDATE metrics_live SET received_at = ? WHERE device_id = ?',
        [Date.now() - DAY_MS, stale.id]
      );

      const res = await request(app).post('/api/devices/agents/update').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.queued).toBe(0);
      expect(res.body.up_to_date).toBe(0);

      const action = await ctx.db.get(
        "SELECT id FROM device_actions WHERE device_id = ? AND action = 'update'",
        stale.id
      );
      expect(action).toBeUndefined();
    });

    it('ignores devices without an agent token', async () => {
      const res0 = await request(app).post('/api/devices').set(auth()).send({ name: 'Bulk NoAgent', ip: '192.168.1.204', type: 'server' });
      expect(res0.status).toBe(200);
      const noAgentId = res0.body.id as number;
      bulkDevices.push(noAgentId);

      const res = await request(app).post('/api/devices/agents/update').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.queued).toBe(0);
      expect(res.body.up_to_date).toBe(0);

      const action = await ctx.db.get(
        "SELECT id FROM device_actions WHERE device_id = ? AND action = 'update'",
        noAgentId
      );
      expect(action).toBeUndefined();
    });
  });

  describe('agent version endpoint', () => {
    it('serves the agent version without authentication', async () => {
      const res = await request(app).get('/api/agent/version');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.version).toBe(AGENT_VERSION);
    });
  });

  describe('hibernate preflight (sandbox)', () => {
    const makeSandbox = (name: string) => {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `openhomelab-hb-${name}-`));
      const bin = path.join(sandbox, 'bin');
      fs.mkdirSync(bin);
      const stubs: Record<string, string> = {
        swapon: `#!/bin/sh
if [ "$1" = "--show" ]; then exit 0; fi
echo "swapon $*" >> "$SANDBOX/log"
exit 0
`,
        swapoff: `#!/bin/sh
echo "swapoff $*" >> "$SANDBOX/log"
exit 0
`,
        fallocate: `#!/bin/sh
echo "fallocate $*" >> "$SANDBOX/log"
touch "$3"
exit 0
`,
        mkswap: `#!/bin/sh
echo "mkswap $*" >> "$SANDBOX/log"
if [ "\${FAKE_FAIL_MKSWAP:-0}" = "1" ]; then exit 1; fi
exit 0
`,
        'update-grub': `#!/bin/sh
echo "update-grub" >> "$SANDBOX/log"
exit 0
`,
        systemctl: `#!/bin/sh
echo "systemctl $*" >> "$SANDBOX/log"
if [ "$1" = "hibernate" ] && [ -f "$SANDBOX/no_hibernate" ]; then exit 1; fi
exit 0
`,
      };
      for (const [cmd, body] of Object.entries(stubs)) {
        const file = path.join(bin, cmd);
        fs.writeFileSync(file, body, { mode: 0o755 });
      }
      return sandbox;
    };

    const agentFunctions = async () => {
      const res = await request(app).get('/api/agent/install');
      expect(res.status).toBe(200);
      const text = res.text as string;
      const startMarker = "<<'AGENT_EOF'";
      const i0 = text.indexOf(startMarker);
      const i1 = text.indexOf('\nAGENT_EOF\n', i0 + startMarker.length);
      expect(i0).toBeGreaterThanOrEqual(0);
      expect(i1).toBeGreaterThan(i0);
      const src = text.slice(i0 + startMarker.length, i1);
      const f0 = src.indexOf('repair_swap_for_hibernate() {');
      const f1 = src.indexOf('\nprocess_actions()');
      expect(f0).toBeGreaterThanOrEqual(0);
      expect(f1).toBeGreaterThan(f0);
      return `${src.slice(f0, f1)}
do_hibernate
printf 'RC=%s OUT=%s\\n' "$rc" "$out"
`;
    };

    const runHibernate = async (driver: string, sandbox: string, env: Record<string, string> = {}) => {
      const driverPath = path.join(sandbox, 'driver.sh');
      fs.writeFileSync(driverPath, driver);
      const out = execFileSync('sh', [driverPath], {
        encoding: 'utf-8',
        cwd: sandbox,
        env: { ...process.env, PATH: `${path.join(sandbox, 'bin')}:${process.env.PATH}`, SANDBOX: sandbox, ...env },
      });
      const m = /RC=(\d+) OUT=(.*)$/m.exec(out);
      expect(m).not.toBeNull();
      return { rc: Number(m![1]), out: m![2], log: fs.existsSync(path.join(sandbox, 'log')) ? fs.readFileSync(path.join(sandbox, 'log'), 'utf-8') : '' };
    };

    const meminfoFile = (sandbox: string, lines: string[]) => {
      const file = path.join(sandbox, 'meminfo');
      fs.writeFileSync(file, lines.join('\n') + '\n');
      return file;
    };

    it('hibernates directly when swap already covers the used RAM', async () => {
      const sandbox = makeSandbox('fit');
      try {
        const meminfo = meminfoFile(sandbox, [
          'MemTotal:        8388608 kB',
          'MemAvailable:    2097152 kB',
          'SwapTotal:       8388608 kB',
        ]);
        const result = await runHibernate(await agentFunctions(), sandbox, { MEMINFO: meminfo });

        expect(result.rc).toBe(0);
        expect(result.out).not.toContain('repaired');
        expect(result.log).toContain('systemctl hibernate');
        expect(fs.existsSync(path.join(sandbox, 'swap.img'))).toBe(false);
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    });

    it('auto-repairs swap sized to the used RAM and then hibernates', async () => {
      const sandbox = makeSandbox('repair');
      try {
        const meminfo = meminfoFile(sandbox, [
          'MemTotal:        8388608 kB',
          'MemAvailable:    1572864 kB',
          'SwapTotal:       4194304 kB',
        ]);
        const swapFile = path.join(sandbox, 'swap.img');
        const fstab = path.join(sandbox, 'fstab');
        const grub = path.join(sandbox, 'grub');
        fs.writeFileSync(
          fstab,
          `# /etc/fstab generated with update-initramfs\n/dev/sda1  /  ext4  defaults  0 1\n${swapFile} none swap sw 0 0\n`,
        );
        fs.writeFileSync(grub, 'GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"\n');

        const result = await runHibernate(await agentFunctions(), sandbox, {
          MEMINFO: meminfo,
          SWAP_FILE: swapFile,
          FSTAB: fstab,
          GRUB_DEFAULT: grub,
        });

        expect(result.rc).toBe(0);
        expect(result.out).toContain('repaired swap for hibernation (~6656 MB in use)');
        expect(result.log).toContain(`fallocate -l 8G ${swapFile}`);
        expect(fs.existsSync(swapFile)).toBe(true);
        expect(result.log).toContain(`swapon ${swapFile}`);
        const swapLines = fs.readFileSync(fstab, 'utf-8').split('\n').filter((l) => l.includes('none swap sw'));
        expect(swapLines).toEqual([`${swapFile} none swap sw 0 0`]);
        expect(fs.readFileSync(grub, 'utf-8')).toContain(`GRUB_CMDLINE_LINUX_DEFAULT="quiet splash resume=${swapFile}"`);
        expect(result.log).toContain('update-grub');
        expect(result.log).toContain('systemctl hibernate');
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    });

    it('fails with the fix-hibernate hint when auto-repair cannot mkswap', async () => {
      const sandbox = makeSandbox('broken');
      try {
        const meminfo = meminfoFile(sandbox, [
          'MemTotal:        8388608 kB',
          'MemAvailable:    1572864 kB',
          'SwapTotal:       4194304 kB',
        ]);
        const result = await runHibernate(await agentFunctions(), sandbox, {
          MEMINFO: meminfo,
          SWAP_FILE: path.join(sandbox, 'swap.img'),
          FSTAB: path.join(sandbox, 'fstab'),
          GRUB_DEFAULT: path.join(sandbox, 'grub'),
          FAKE_FAIL_MKSWAP: '1',
        });

        expect(result.rc).toBe(1);
        expect(result.out).toContain('swap too small for hibernation');
        expect(result.out).toContain('need ~6656 MB (in use), have 4096 MB');
        expect(result.out).toContain('auto-repair failed');
        expect(result.out).toContain('scripts/fix-hibernate.sh');
        expect(result.log).not.toContain('systemctl hibernate');
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    });
  });

  describe('agent self-update (sandbox)', () => {
    it('replaces the agent script and reports done after a successful update', async () => {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'openhomelab-selfupdate-'));
      try {
        const bin = path.join(sandbox, 'bin');
        fs.mkdirSync(bin);
        const curlStub = `#!/bin/sh
case "$*" in
  *pending-actions*) cat "$SANDBOX/pending.json"; exit 0 ;;
esac
out_file=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out_file="$a"; fi
  prev="$a"
done
case "$*" in
  */api/agent/script*) cat "$SANDBOX/installer.txt" > "$out_file"; printf '200'; exit 0 ;;
esac
echo "curl $*" >> "$SANDBOX/curl.log"
exit 0
`;
        const systemctlStub = `#!/bin/sh
echo "systemctl $*" >> "$SANDBOX/log"
exit 0
`;
        fs.writeFileSync(path.join(bin, 'curl'), curlStub, { mode: 0o755 });
        fs.writeFileSync(path.join(bin, 'systemctl'), systemctlStub, { mode: 0o755 });

        const res = await request(app).get('/api/agent/install');
        expect(res.status).toBe(200);
        const text = res.text as string;
        const startMarker = "<<'AGENT_EOF'";
        const i0 = text.indexOf(startMarker);
        const i1 = text.indexOf('\nAGENT_EOF\n', i0 + startMarker.length);
        const src = text.slice(i0 + startMarker.length, i1);
        const f0 = src.indexOf('report_action_result() {');
        const f1 = src.indexOf('\nwhile :; do');
        expect(f0).toBeGreaterThanOrEqual(0);
        expect(f1).toBeGreaterThan(f0);

        const installerText = `#!/bin/sh
# fake new agent
AGENT_VERSION="2.0"
exit 0
`;
        fs.writeFileSync(path.join(sandbox, 'installer.txt'), installerText);
        fs.writeFileSync(path.join(sandbox, 'pending.json'), '{"success":true,"actions":[{"id":7,"action":"update"}]}');
        const selfPath = path.join(sandbox, 'agent.sh');
        fs.writeFileSync(selfPath, `#!/bin/sh\nAGENT_VERSION="0.9"\nexit 0\n`);
        fs.mkdirSync(path.join(sandbox, 'state'));

        const driverPath = path.join(sandbox, 'driver.sh');
        fs.writeFileSync(
          driverPath,
          `${src.slice(f0, f1)}
process_actions
echo RAN
`,
        );

        const out = execFileSync('sh', [driverPath], {
          encoding: 'utf-8',
          cwd: sandbox,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            SANDBOX: sandbox,
            STATE_DIR: path.join(sandbox, 'state'),
            SERVER_URL: 'http://fake.local:1214',
            TOKEN: 'tk-sandbox',
            AGENT_SELF_PATH: selfPath,
          },
        });
        expect(out).toContain('RAN');

        const curlLog = fs.readFileSync(path.join(sandbox, 'curl.log'), 'utf-8');
        expect(curlLog).toContain('"status":"started"');
        expect(curlLog).toContain('"status":"done"');
        expect(curlLog).toContain('agent updated to v2.0');
        expect(fs.readFileSync(selfPath, 'utf-8')).toBe(installerText);
        expect(fs.readFileSync(`${selfPath}.bak`, 'utf-8')).toContain('AGENT_VERSION="0.9"');
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    });
  });

  describe('agent self-update gpu tools (sandbox)', () => {
    const makeGpuSandbox = (name: string, opts: { intelPresent?: boolean } = {}) => {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `openhomelab-gpu-${name}-`));
      const bin = path.join(sandbox, 'bin');
      fs.mkdirSync(bin);
      const curlStub = `#!/bin/sh
out_file=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out_file="$a"; fi
  prev="$a"
done
cat "$SANDBOX/new_agent.txt" > "$out_file"
printf '200'
exit 0
`;
      const aptGetStub = `#!/bin/sh
echo "apt-get $*" >> "$SANDBOX/log"
if [ "\${FAKE_FAIL_APT:-0}" = "1" ] && [ "$1" = "install" ]; then exit 1; fi
exit 0
`;
      const systemctlStub = `#!/bin/sh
echo "systemctl $*" >> "$SANDBOX/log"
exit 0
`;
      fs.writeFileSync(path.join(bin, 'curl'), curlStub, { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'apt-get'), aptGetStub, { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'systemctl'), systemctlStub, { mode: 0o755 });
      for (const cmd of ['sh', 'grep', 'sed', 'awk', 'mktemp', 'cp', 'mv', 'chmod', 'cat', 'head']) {
        let target = '';
        for (const dir of ['/bin', '/usr/bin']) {
          if (fs.existsSync(path.join(dir, cmd))) {
            target = path.join(dir, cmd);
            break;
          }
        }
        expect(target).not.toBe('');
        fs.symlinkSync(target, path.join(bin, cmd));
      }
      if (opts.intelPresent) {
        const drmCard = path.join(sandbox, 'drm', 'card0', 'device');
        fs.mkdirSync(drmCard, { recursive: true });
        fs.writeFileSync(path.join(drmCard, 'uevent'), 'DRIVER=i915\nPCI_ID=8086:4e91\n');
      }
      return sandbox;
    };

    const runSelfUpdate = async (sandbox: string, env: Record<string, string> = {}) => {
      const res = await request(app).get('/api/agent/install');
      expect(res.status).toBe(200);
      const text = res.text as string;
      const startMarker = "<<'AGENT_EOF'";
      const i0 = text.indexOf(startMarker);
      const i1 = text.indexOf('\nAGENT_EOF\n', i0 + startMarker.length);
      expect(i0).toBeGreaterThanOrEqual(0);
      expect(i1).toBeGreaterThan(i0);
      const src = text.slice(i0 + startMarker.length, i1);
      const f0 = src.indexOf('ensure_intel_gpu_tools() {');
      const f1 = src.indexOf('\nprocess_actions()');
      expect(f0).toBeGreaterThanOrEqual(0);
      expect(f1).toBeGreaterThan(f0);

      fs.writeFileSync(path.join(sandbox, 'new_agent.txt'), '#!/bin/sh\nAGENT_VERSION="9.9"\nexit 0\n');
      const selfPath = path.join(sandbox, 'agent.sh');
      fs.writeFileSync(selfPath, `#!/bin/sh\nAGENT_VERSION="0.9"\nexit 0\n`);

      const driverPath = path.join(sandbox, 'driver.sh');
      fs.writeFileSync(
        driverPath,
        `${src.slice(f0, f1)}
rc=1
out=""
self_update
printf 'RC=%s OUT=%s\\n' "$rc" "$out"
`,
      );

      const out = execFileSync('sh', [driverPath], {
        encoding: 'utf-8',
        cwd: sandbox,
        env: { ...process.env, PATH: path.join(sandbox, 'bin'), SANDBOX: sandbox, AGENT_SELF_PATH: selfPath, ...env },
      });
      const m = /RC=(\d+) OUT=(.*)$/m.exec(out);
      expect(m).not.toBeNull();
      return { rc: Number(m![1]), out: m![2], log: fs.existsSync(path.join(sandbox, 'log')) ? fs.readFileSync(path.join(sandbox, 'log'), 'utf-8') : '' };
    };

    it('installs intel-gpu-tools during update when the iGPU tool is missing', async () => {
      const sandbox = makeGpuSandbox('missing', { intelPresent: true });
      try {
        const result = await runSelfUpdate(sandbox, { DRM_DIR: path.join(sandbox, 'drm') });

        expect(result.rc).toBe(0);
        expect(result.out).toContain('agent updated to v9.9');
        expect(result.out).toContain('+intel-gpu-tools installed');
        expect(result.out).not.toContain('WARNING');
        expect(result.log).toContain('apt-get install -y intel-gpu-tools');
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    });

    it('skips the package install when intel_gpu_top is already available', async () => {
      const sandbox = makeGpuSandbox('present', { intelPresent: true });
      const bin = path.join(sandbox, 'bin');
      fs.writeFileSync(path.join(bin, 'intel_gpu_top'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      try {
        const result = await runSelfUpdate(sandbox, { DRM_DIR: path.join(sandbox, 'drm') });

        expect(result.rc).toBe(0);
        expect(result.out).toContain('agent updated to v9.9');
        expect(result.log).not.toContain('apt-get install');
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    });

    it('never touches a package manager on non-Intel machines', async () => {
      const sandbox = makeGpuSandbox('nointel');
      const drm = path.join(sandbox, 'nodrm');
      fs.mkdirSync(drm);
      try {
        const result = await runSelfUpdate(sandbox, { DRM_DIR: drm });

        expect(result.rc).toBe(0);
        expect(result.out).toContain('agent updated to v9.9');
        expect(result.out).not.toContain('intel-gpu-tools');
        expect(result.log).not.toContain('apt-get');
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    });

    it('completes the update with a warning when the package install fails', async () => {
      const sandbox = makeGpuSandbox('fail', { intelPresent: true });
      try {
        const result = await runSelfUpdate(sandbox, { DRM_DIR: path.join(sandbox, 'drm'), FAKE_FAIL_APT: '1' });

        expect(result.rc).toBe(0);
        expect(result.out).toContain('agent updated to v9.9');
        expect(result.out).toContain('could not install intel-gpu-tools');
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    });
  });

  describe('failed action visibility', () => {
    const TEN_MIN_MS = 10 * 60_000;

    beforeEach(async () => {
      await ctx.db.run(
        "UPDATE device_actions SET status = 'done' WHERE device_id = ? AND status IN ('pending', 'acknowledged', 'started')",
        [deviceId]
      );
    });

    it('keeps the actionable tail of a long failed hibernate output in its label', () => {
      const msg =
        'swap too small for hibernation: need ~6656 MB (in use), have 4096 MB; auto-repair failed; run scripts/fix-hibernate.sh on this host as root';
      const label = pendingActionLabel(
        { action: 'hibernate', status: 'failed', created_at: Date.now(), output: msg },
        enT,
      );
      expect(label).toContain('run scripts/fix-hibernate.sh on this host as root');
    });

    it('lists failed actions with their output, and drops them after ten minutes', async () => {
      const nowTs = Date.now();
      const res = await ctx.db.run(
        `INSERT INTO device_actions (device_id, action, status, output, created_at, executed_at)
         VALUES (?, ?, 'failed', ?, ?, ?)`,
        [deviceId, 'hibernate', 'swap too small for hibernation: need ~30720 MB, have 8192 MB', nowTs - 60_000, nowTs - 59_000]
      );

      const listed = await request(app).get('/api/devices/actions').set(auth());
      expect(listed.status).toBe(200);
      const entry = listed.body[String(deviceId)] as { action: string; status: string; output: string };
      expect(entry.action).toBe('hibernate');
      expect(entry.status).toBe('failed');
      expect(entry.output).toContain('swap too small');

      await ctx.db.run('UPDATE device_actions SET created_at = ? WHERE id = ?', [nowTs - TEN_MIN_MS - 60_000, res.lastID]);
      const cleared = await request(app).get('/api/devices/actions').set(auth());
      expect(cleared.body[String(deviceId)]).toBeUndefined();
    });

    it('shows a failed action until a retry is queued for the same device', async () => {
      const nowTs = Date.now();
      await ctx.db.run(
        `INSERT INTO device_actions (device_id, action, status, output, created_at) VALUES (?, ?, 'failed', ?, ?)`,
        [deviceId, 'hibernate', 'boom', nowTs - 60_000]
      );

      const withFailure = await request(app).get('/api/devices/actions').set(auth());
      const first = withFailure.body[String(deviceId)] as { action: string; status: string };
      expect(first.action).toBe('hibernate');
      expect(first.status).toBe('failed');
      expect((withFailure.body[String(deviceId)] as { output: string }).output).toBe('boom');

      const fresh = await pushStats();
      expect(fresh.status).toBe(200);
      const enqueue = await request(app)
        .post(`/api/devices/${deviceId}/command`)
        .set(auth())
        .send({ action: 'reboot' });
      expect(enqueue.status).toBe(200);

      const afterRetry = await request(app).get('/api/devices/actions').set(auth());
      const second = afterRetry.body[String(deviceId)] as { action: string; status: string };
      expect(second.action).toBe('reboot');
      expect(['pending', 'acknowledged']).toContain(second.status);

      const row = await latestAction('reboot');
      await ctx.db.run("UPDATE device_actions SET status = 'done' WHERE id = ?", [row!.id]);
    });
  });

  describe('agent install script', () => {
    it('is valid POSIX shell and includes the hibernate preflight', async () => {
      const res = await request(app).get('/api/agent/install');
      expect(res.status).toBe(200);
      expect(typeof res.text).toBe('string');
      expect(res.text).toContain('do_hibernate');
      expect(res.text).toContain('repair_swap_for_hibernate');
      expect(res.text).toContain('self_update');
      expect(res.text).toContain(`AGENT_VERSION="${AGENT_VERSION}"`);
      expect(res.text).toContain('"action":"(reboot|shutdown|hibernate|update)"');
      expect(res.text).toContain('swap too small for hibernation');
      expect(res.text).toContain('scripts/fix-hibernate.sh');

      const file = path.join(tmpDir, 'agent-script.sh');
      fs.writeFileSync(file, res.text);
      execFileSync('sh', ['-n', file]);
    });
  });

  describe('agent reinstall over SSH', () => {
    it('returns 404 for an unknown device', async () => {
      const res = await request(app).post('/api/devices/99999/agent/reinstall').set(auth());
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Device not found');
    });

    it('returns 400 when no SSH profile is assigned', async () => {
      const res = await request(app).post(`/api/devices/${deviceId}/agent/reinstall`).set(auth());
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No SSH profile assigned');
    });

    it('rotates the token then fails with 500 when SSH cannot connect', async () => {
      const profRes = await request(app)
        .post('/api/profiles')
        .set(auth())
        .send({ name: 'Reinstall Profile', username: 'root', auth_type: 'password', password: 'secret' });
      expect(profRes.status).toBe(200);

      const devRes = await request(app)
        .post('/api/devices')
        .set(auth())
        .send({ name: 'Reinstall Box', ip: '127.0.0.1', type: 'pc' });
      expect(devRes.status).toBe(200);
      const rid = devRes.body.id as number;
      await ctx.db.run('UPDATE devices SET profile_id = ? WHERE id = ?', [profRes.body.id, rid]);

      const before = (await ctx.db.get('SELECT agent_token FROM devices WHERE id = ?', rid)) as {
        agent_token: string | null;
      };
      expect(before.agent_token).toBeNull();

      const res = await request(app).post(`/api/devices/${rid}/agent/reinstall`).set(auth());
      expect(res.status).toBe(500);
      expect(typeof res.body.error).toBe('string');
      expect(res.body.error.length).toBeGreaterThan(0);

      const after = (await ctx.db.get('SELECT agent_token FROM devices WHERE id = ?', rid)) as {
        agent_token: string | null;
      };
      expect(after.agent_token).not.toBeNull();
    });
  });

  describe('device deletion', () => {
    it('cascades to device_actions', async () => {
      await ctx.db.run(
        'INSERT INTO device_actions (device_id, action, status, created_at) VALUES (?, ?, ?, ?)',
        [deviceId, 'reboot', 'pending', Date.now()]
      );

      const del = await request(app).delete(`/api/devices/${deviceId}`).set(auth());
      expect(del.status).toBe(200);

      const row = (await ctx.db.get('SELECT COUNT(*) AS c FROM device_actions WHERE device_id = ?', deviceId)) as {
        c: number;
      };
      expect(row.c).toBe(0);
    });
  });
});
