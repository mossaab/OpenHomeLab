import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, createApp } from '../server';

type Ctx = Awaited<ReturnType<typeof initDb>>;

describe('API tokens & external machine API', () => {
  let tmpDir: string;
  let ctx: Ctx;
  let app: ReturnType<typeof createApp>;
  let adminToken: string;
  let deviceA: number;
  let deviceB: number;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    delete process.env.APP_ENCRYPTION_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhomelab-api-tokens-'));
    ctx = await initDb(path.join(tmpDir, 'db.sqlite'));
    app = createApp(ctx);

    const setup = await request(app).post('/api/setup').send({ password: 'password123' });
    adminToken = setup.body.token;

    const a = await request(app)
      .post('/api/devices')
      .set(auth(adminToken))
      .send({ name: 'box-a', ip: '192.168.1.50', mac: 'aa:bb:cc:dd:ee:ff', type: 'server' });
    deviceA = a.body.id;

    const b = await request(app)
      .post('/api/devices')
      .set(auth(adminToken))
      .send({ name: 'box-b', ip: '192.168.1.51', type: 'pc' });
    deviceB = b.body.id;
  });

  afterAll(async () => {
    if (ctx) await ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const createToken = async (body: Record<string, unknown>) =>
    request(app).post('/api/api-tokens').set(auth(adminToken)).send(body);

  describe('token management', () => {
    it('rejects a token without a label', async () => {
      const res = await createToken({ permissions: ['status'] });
      expect(res.status).toBe(400);
    });

    it('rejects unknown permissions', async () => {
      const res = await createToken({ label: 'bad', permissions: ['reboot-everything'] });
      expect(res.status).toBe(400);
    });

    it('rejects an expired-in-past token', async () => {
      const res = await createToken({ label: 'old', permissions: [], expires_at: Date.now() - 1000 });
      expect(res.status).toBe(400);
    });

    it('creates a token and returns the full token only once', async () => {
      const res = await createToken({ label: 'litellm-bot', permissions: ['status', 'start'] });
      expect(res.status).to.equal(200);
      expect(typeof res.body.token).toBe('string');
      expect(res.body.token.startsWith('ncapi-')).toBe(true);
      const tokenId = res.body.id;

      const list = await request(app).get('/api/api-tokens').set(auth(adminToken));
      expect(list.status).toBe(200);
      const row = list.body.find((t: any) => t.id === tokenId);
      expect(row).toBeTruthy();
      expect(row.label).toBe('litellm-bot');
      expect(row.permissions).toEqual(['status', 'start']);
      expect(row.device_ids).toEqual([]);
      expect(row.enabled).toBe(true);
      expect(JSON.stringify(list.body)).not.toContain('ncapi-');

      const tokenRow = (await ctx.db.get(
        'SELECT token_hash FROM api_tokens WHERE id = ?',
        tokenId
      )) as { token_hash: string };
      expect(tokenHashPrefix(tokenRow.token_hash)).toBe('sha256');
    });

    it('rotates a token and invalidates the old one', async () => {
      const created = await createToken({ label: 'rotate-me', permissions: ['status'] });
      const tokenId = created.body.id;
      const oldToken = created.body.token;

      const statusBefore = await request(app)
        .get(`/api/machines/${deviceA}/status`)
        .set(auth(oldToken));
      expect(statusBefore.status).toBe(200);

      const rotated = await request(app)
        .post(`/api/api-tokens/${tokenId}/rotate`)
        .set(auth(adminToken));
      expect(rotated.status).toBe(200);
      expect(typeof rotated.body.token).toBe('string');
      expect(rotated.body.token).not.toBe(oldToken);

      const oldAfter = await request(app)
        .get(`/api/machines/${deviceA}/status`)
        .set(auth(oldToken));
      expect(oldAfter.status).toBe(401);

      const newStatus = await request(app)
        .get(`/api/machines/${deviceA}/status`)
        .set(auth(rotated.body.token));
      expect(newStatus.status).toBe(200);
    });

    it('updates label, permissions, scope and expiry via PUT', async () => {
      const created = await createToken({ label: 'edit-me', permissions: ['status'] });
      const tokenId = created.body.id;

      const res = await request(app)
        .put(`/api/api-tokens/${tokenId}`)
        .set(auth(adminToken))
        .send({ label: 'edited', permissions: ['start'], device_ids: [deviceA], enabled: false });
      expect(res.status).toBe(200);
      expect(res.body.label).toBe('edited');
      expect(res.body.permissions).toEqual(['start']);
      expect(res.body.device_ids).toEqual([deviceA]);
      expect(res.body.enabled).toBe(false);

      const list = await request(app).get('/api/api-tokens').set(auth(adminToken));
      const row = list.body.find((t: any) => t.id === tokenId);
      expect(row.permissions).toEqual(['start']);
    });

    it('rejects PUT with unknown device ids', async () => {
      const created = await createToken({ label: 'scope-bad', permissions: [] });
      const res = await request(app)
        .put(`/api/api-tokens/${created.body.id}`)
        .set(auth(adminToken))
        .send({ device_ids: [99999] });
      expect(res.status).toBe(400);
    });

    it('rejects PUT with a past expires_at', async () => {
      const created = await createToken({ label: 'keep-expiry', permissions: ['status'] });
      const res = await request(app)
        .put(`/api/api-tokens/${created.body.id}`)
        .set(auth(adminToken))
        .send({ expires_at: Date.now() - 1000 });
      expect(res.status).toBe(400);

      const list = await request(app).get('/api/api-tokens').set(auth(adminToken));
      const row = list.body.find((t: any) => t.id === created.body.id);
      expect(row.expires_at).toBe(null);
    });

    it('deletes a token and its usage history', async () => {
      const created = await createToken({ label: 'doomed', permissions: ['status'] });
      const tokenId = created.body.id;
      const call = await request(app)
        .get(`/api/machines/${deviceA}/status`)
        .set(auth(created.body.token));
      expect(call.status).toBe(200);

      const del = await request(app)
        .delete(`/api/api-tokens/${tokenId}`)
        .set(auth(adminToken));
      expect(del.status).toBe(200);

      const list = await request(app).get('/api/api-tokens').set(auth(adminToken));
      expect(list.body.find((t: any) => t.id === tokenId)).toBeUndefined();

      const usageCount = (await ctx.db.get(
        'SELECT COUNT(*) AS c FROM api_usage WHERE token_id = ?',
        tokenId
      )) as { c: number };
      expect(usageCount.c).toBe(0);

      const afterDelete = await request(app)
        .get(`/api/machines/${deviceA}/status`)
        .set(auth(created.body.token));
      expect(afterDelete.status).toBe(401);
    });
  });

  describe('public machine API', () => {
    it('rejects missing and unknown tokens', async () => {
      const noAuth = await request(app).get(`/api/machines/${deviceA}/status`);
      expect(noAuth.status).toBe(401);

      const bad = await request(app)
        .get(`/api/machines/${deviceA}/status`)
        .set(auth('ncapi-not-a-real-token'));
      expect(bad.status).toBe(401);
    });

    it('rejects a disabled token with 401', async () => {
      const created = await createToken({ label: 'disabled', permissions: ['status'], enabled: false });
      const res = await request(app)
        .get(`/api/machines/${deviceA}/status`)
        .set(auth(created.body.token));
      expect(res.status).toBe(401);
    });

    it('rejects an expired token with 401', async () => {
      const created = await createToken({ label: 'expired', permissions: ['status'], expires_at: Date.now() + 30 });
      expect(created.status).toBe(200);
      await new Promise((r) => setTimeout(r, 60));
      const res = await request(app)
        .get(`/api/machines/${deviceA}/status`)
        .set(auth(created.body.token));
      expect(res.status).toBe(401);
    });

    it('enforces per-operation permissions', async () => {
      const created = await createToken({ label: 'status-only', permissions: ['status'] });
      const token = created.body.token;

      const status = await request(app).get(`/api/machines/${deviceA}/status`).set(auth(token));
      expect(status.status).toBe(200);
      expect(status.body.name).toBe('box-a');
      expect(typeof status.body.online).toBe('boolean');

      for (const op of ['start', 'stop', 'restart']) {
        const denied = await request(app).post(`/api/machines/${deviceA}/${op}`).set(auth(token));
        expect(denied.status).toBe(403);
      }

      const actionOnly = await createToken({ label: 'actions-only', permissions: ['start', 'stop', 'restart'] });
      const deniedStatus = await request(app)
        .get(`/api/machines/${deviceA}/status`)
        .set(auth(actionOnly.body.token));
      expect(deniedStatus.status).toBe(403);
    });

    it('scopes tokens to their allowed devices', async () => {
      const created = await createToken({ label: 'scoped', permissions: ['status', 'start'], device_ids: [deviceA] });
      const token = created.body.token;

      const allowed = await request(app).get(`/api/machines/${deviceA}/status`).set(auth(token));
      expect(allowed.status).toBe(200);

      const denied = await request(app).get(`/api/machines/${deviceB}/status`).set(auth(token));
      expect(denied.status).toBe(403);

      const listDenied = await request(app).get('/api/machines').set(auth(token));
      expect(listDenied.status).toBe(200);
      expect(listDenied.body.machines.map((m: any) => m.id)).toEqual([deviceA]);
    });

    it('resolves machines by name', async () => {
      const created = await createToken({ label: 'by-name', permissions: ['status'] });
      const res = await request(app).get('/api/machines/box-b/status').set(auth(created.body.token));
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(deviceB);

      const unknown = await request(app).get('/api/machines/nope/status').set(auth(created.body.token));
      expect(unknown.status).toBe(404);
    });

    it('starts a machine with WOL when a MAC is set', async () => {
      const created = await createToken({ label: 'waker', permissions: ['start'] });
      const res = await request(app).post(`/api/machines/${deviceA}/start`).set(auth(created.body.token));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const noMac = await request(app).post(`/api/machines/${deviceB}/start`).set(auth(created.body.token));
      expect(noMac.status).toBe(400);
    });

    it('stops and restarts via the hybrid agent/SSH logic (no profile → 400)', async () => {
      const created = await createToken({ label: 'power', permissions: ['stop', 'restart'] });
      const token = created.body.token;

      const stop = await request(app).post(`/api/machines/${deviceA}/stop`).set(auth(token));
      expect(stop.status).toBe(400);
      expect(stop.body.error).toMatch(/no ssh profile/i);

      const restart = await request(app).post(`/api/machines/${deviceA}/restart`).set(auth(token));
      expect(restart.status).toBe(400);
    });
  });

  describe('usage stats', () => {
    it('aggregates calls per token and per operation', async () => {
      const created = await createToken({ label: 'stat-tok', permissions: ['status', 'start', 'stop'] });
      const token = created.body.token;
      const tokenId = created.body.id;

      expect((await request(app).get(`/api/machines/${deviceA}/status`).set(auth(token))).status).toBe(200);
      expect((await request(app).post(`/api/machines/${deviceA}/start`).set(auth(token))).status).toBe(200);
      expect((await request(app).post(`/api/machines/${deviceA}/stop`).set(auth(token))).status).toBe(400);

      const stats = await request(app).get('/api/api-tokens/stats?range=7d').set(auth(adminToken));
      expect(stats.status).toBe(200);
      const row = stats.body.tokens.find((t: any) => t.token_id === tokenId);
      expect(row).toBeTruthy();
      expect(row.label).toBe('stat-tok');
      expect(row.total).toBe(3);
      expect(row.operations).toEqual({ status: 1, start: 1, stop: 1, restart: 0 });

      const list = await request(app).get('/api/api-tokens').set(auth(adminToken));
      const tokenRow = list.body.find((t: any) => t.id === tokenId);
      expect(tokenRow.last_used_at).toBeTypeOf('number');
    });

    it('rejects an invalid range', async () => {
      const res = await request(app).get('/api/api-tokens/stats?range=5h').set(auth(adminToken));
      expect(res.status).toBe(400);
    });
  });

  describe('usage logs', () => {
    it('returns the latest calls newest-first with token and device details', async () => {
      const created = await createToken({ label: 'log-tok', permissions: ['status', 'start'] });
      const token = created.body.token;
      const tokenId = created.body.id;

      expect((await request(app).get(`/api/machines/${deviceA}/status`).set(auth(token))).status).toBe(200);
      expect((await request(app).post(`/api/machines/${deviceA}/start`).set(auth(token))).status).toBe(200);
      expect((await request(app).get(`/api/machines/${deviceB}/status`).set(auth(token))).status).toBe(200);

      const res = await request(app).get('/api/api-tokens/logs').set(auth(adminToken));
      expect(res.status).toBe(200);
      const logs: any[] = res.body.logs;
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.length).toBeLessThanOrEqual(20);

      for (let i = 1; i < logs.length; i++) {
        expect(logs[i - 1].created_at).toBeGreaterThanOrEqual(logs[i].created_at);
      }

      const mine = logs.filter((l) => l.token_id === tokenId);
      expect(mine.length).toBe(3);
      expect(mine[0].token_label).toBe('log-tok');
      expect(mine[0].operation).toBe('status');
      expect(mine[0].device_id).toBe(deviceB);
      expect(mine[0].device_name).toBe('box-b');
      expect(mine[0].status_code).toBe(200);
      expect(mine[1].operation).toBe('start');
      expect(mine[1].device_name).toBe('box-a');
    });

    it('requires authentication', async () => {
      const res = await request(app).get('/api/api-tokens/logs');
      expect(res.status).toBe(401);
    });
  });
});

function tokenHashPrefix(hash: string): string {
  return hash.split(':')[0];
}
