import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { initDb, createApp, AGENT_VERSION } from '../server';

type Ctx = Awaited<ReturnType<typeof initDb>>;

const mockState = vi.hoisted(() => ({ commands: [] as string[], failNext: false }));

vi.mock('node-ssh', () => ({
  NodeSSH: class {
    async connect() {}
    async execCommand(command: string) {
      mockState.commands.push(command);
      if (mockState.failNext) {
        mockState.failNext = false;
        return { code: 1, stdout: '', stderr: 'boom' };
      }
      return { code: 0, stdout: 'ok', stderr: '' };
    }
    dispose() {}
  },
}));

describe('Device deactivation & agent uninstall', () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhomelab-deact-'));
    ctx = await initDb(path.join(tmpDir, 'db.sqlite'));

    const hash = await bcrypt.hash('password123', 10);
    await ctx.db.run('UPDATE settings SET master_password_hash = ? WHERE id = 1', [hash]);
    token = jwt.sign({ id: 1 }, ctx.jwtSecret, { expiresIn: '24h' });

    app = createApp(ctx);

    const res = await request(app)
      .post('/api/devices')
      .set(auth())
      .send({ name: 'Deact Box', ip: '192.168.1.70', type: 'server' });
    deviceId = res.body.id;

    const tok = await request(app).post(`/api/devices/${deviceId}/agent/token`).set(auth());
    agentToken = tok.body.token;
  });

  afterAll(async () => {
    if (ctx) await ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function pushStats(payload: Record<string, unknown> = {}) {
    return request(app)
      .post('/api/agent/stats')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ hostname: 'deactbox', cpu: 20, mem_total: 8_000_000_000, mem_used: 4_000_000_000, ...payload });
  }

  async function waitForCommands(expected: number, timeoutMs = 3000) {
    const start = Date.now();
    while (mockState.commands.length < expected) {
      if (Date.now() - start > timeoutMs) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    return mockState.commands.length >= expected;
  }

  async function pendingUpdateCount(deviceId: number) {
    const row = (await ctx.db.get(
      "SELECT COUNT(*) AS cnt FROM device_actions WHERE device_id = ? AND action = 'update'",
      deviceId
    )) as { cnt: number };
    return Number(row.cnt);
  }

  const toggleBody = (active: number) => ({
    name: 'Deact Box',
    ip: '192.168.1.70',
    mac: null,
    type: 'server',
    profile_id: null,
    broadcast_address: null,
    base_power_w: null,
    interfaces: [],
    active,
  });

  it('reports the active flag in the agent config', async () => {
    const res = await request(app).get('/api/agent/config').set('Authorization', `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
  });

  it('toggles a device without stored interfaces with an empty array (regression)', async () => {
    const res = await request(app).put(`/api/devices/${deviceId}`).set(auth()).send(toggleBody(0));
    expect(res.status).toBe(200);

    const row = (await ctx.db.get('SELECT active, interfaces FROM devices WHERE id = ?', deviceId)) as {
      active: number;
      interfaces: string | null;
    };
    expect(row.active).toBe(0);
    expect(row.interfaces).toBeNull();

    const back = await request(app).put(`/api/devices/${deviceId}`).set(auth()).send(toggleBody(1));
    expect(back.status).toBe(200);
  });

  it('still rejects non-empty invalid interfaces payloads', async () => {
    const res = await request(app)
      .put(`/api/devices/${deviceId}`)
      .set(auth())
      .send({ ...toggleBody(1), interfaces: 'not-json' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid interfaces payload');
  });

  it('deactivating clears live metrics and queues an agent self-update when the agent is online', async () => {
    await pushStats();
    const before = (await ctx.db.get('SELECT COUNT(*) AS cnt FROM metrics_live WHERE device_id = ?', deviceId)) as {
      cnt: number;
    };
    expect(Number(before.cnt)).toBe(1);

    const res = await request(app).put(`/api/devices/${deviceId}`).set(auth()).send(toggleBody(0));
    expect(res.status).toBe(200);

    const after = (await ctx.db.get('SELECT COUNT(*) AS cnt FROM metrics_live WHERE device_id = ?', deviceId)) as {
      cnt: number;
    };
    expect(Number(after.cnt)).toBe(0);

    const actions = (await ctx.db.all(
      "SELECT action, status FROM device_actions WHERE device_id = ? AND action = 'update'",
      deviceId
    )) as { action: string; status: string }[];
    expect(actions).toEqual([{ action: 'update', status: 'pending' }]);
  });

  it('does not queue an update when the running agent is already up to date', async () => {
    const enable = await request(app).put(`/api/devices/${deviceId}`).set(auth()).send(toggleBody(1));
    expect(enable.status).toBe(200);
    await pushStats({ agent_version: AGENT_VERSION });

    await ctx.db.run("DELETE FROM device_actions WHERE device_id = ? AND action = 'update'", [deviceId]);
    const res = await request(app).put(`/api/devices/${deviceId}`).set(auth()).send(toggleBody(0));
    expect(res.status).toBe(200);
    expect(await pendingUpdateCount(deviceId)).toBe(0);
  });

  it('ignores stats pushes while the device is inactive', async () => {
    const rawBefore = (await ctx.db.get('SELECT COUNT(*) AS cnt FROM metrics_raw WHERE device_id = ?', deviceId)) as {
      cnt: number;
    };

    const push = await pushStats();
    expect(push.status).toBe(200);
    expect(push.body.ok).toBe(true);

    const rawAfter = (await ctx.db.get('SELECT COUNT(*) AS cnt FROM metrics_raw WHERE device_id = ?', deviceId)) as {
      cnt: number;
    };
    expect(Number(rawAfter.cnt)).toBe(Number(rawBefore.cnt));

    const live = (await ctx.db.get('SELECT COUNT(*) AS cnt FROM metrics_live WHERE device_id = ?', deviceId)) as {
      cnt: number;
    };
    expect(Number(live.cnt)).toBe(0);

    const config = await request(app).get('/api/agent/config').set('Authorization', `Bearer ${agentToken}`);
    expect(config.body.active).toBe(false);
  });

  it('deleting a device with an agent token and SSH profile uninstalls the agent over SSH', async () => {
    const prof = await request(app)
      .post('/api/profiles')
      .set(auth())
      .send({ name: 'DeactProf', username: 'root', auth_type: 'password', password: 'secret123' });
    expect(prof.status).toBe(200);

    const dev = await request(app)
      .post('/api/devices')
      .set(auth())
      .send({ name: 'Uninstall Box', ip: '192.168.1.72', type: 'server', profile_id: prof.body.id });
    expect(dev.status).toBe(200);

    const tok = await request(app).post(`/api/devices/${dev.body.id}/agent/token`).set(auth());
    expect(tok.status).toBe(200);

    mockState.commands.length = 0;
    const res = await request(app).delete(`/api/devices/${dev.body.id}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const gone = await ctx.db.get('SELECT id FROM devices WHERE id = ?', dev.body.id);
    expect(gone).toBeUndefined();

    expect(await waitForCommands(1)).toBe(true);
    const command = mockState.commands[0];
    expect(command).toContain('systemctl disable --now openhomelab-agent');
    expect(command).toContain('/usr/local/bin/openhomelab-agent');
    expect(command).toContain('rm -rf /etc/openhomelab');
  });

  it('still deletes when the SSH uninstall fails', async () => {
    const prof = await request(app)
      .post('/api/profiles')
      .set(auth())
      .send({ name: 'FailProf', username: 'root', auth_type: 'password', password: 'secret123' });
    const dev = await request(app)
      .post('/api/devices')
      .set(auth())
      .send({ name: 'Fail Box', ip: '192.168.1.74', type: 'server', profile_id: prof.body.id });
    const tok = await request(app).post(`/api/devices/${dev.body.id}/agent/token`).set(auth());
    expect(tok.status).toBe(200);

    mockState.failNext = true;
    const res = await request(app).delete(`/api/devices/${dev.body.id}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const gone = await ctx.db.get('SELECT id FROM devices WHERE id = ?', dev.body.id);
    expect(gone).toBeUndefined();
  });

  it('deletes without any SSH attempt when no profile is attached', async () => {
    const dev = await request(app)
      .post('/api/devices')
      .set(auth())
      .send({ name: 'Bare Box', ip: '192.168.1.76', type: 'pc' });

    mockState.commands.length = 0;
    const res = await request(app).delete(`/api/devices/${dev.body.id}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockState.commands).toHaveLength(0);
  });
});
