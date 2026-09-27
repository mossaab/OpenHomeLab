import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { initDb, createApp, sanitizeAgentInterfaces } from '../server';

type Ctx = Awaited<ReturnType<typeof initDb>>;

describe('Agent claim flow (add-device via installer)', () => {
  let tmpDir: string;
  let ctx: Ctx;
  let app: ReturnType<typeof createApp>;
  let token: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    delete process.env.APP_ENCRYPTION_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhomelab-claim-'));
    ctx = await initDb(path.join(tmpDir, 'db.sqlite'));

    const hash = await bcrypt.hash('password123', 10);
    await ctx.db.run('UPDATE settings SET master_password_hash = ? WHERE id = 1', [hash]);
    token = jwt.sign({ id: 1 }, ctx.jwtSecret, { expiresIn: '24h' });

    app = createApp(ctx);
  });

  afterAll(async () => {
    if (ctx) await ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const pushClaim = async (claimToken: string, payload: Record<string, unknown>) =>
    request(app).post('/api/agent/stats').set('Authorization', `Bearer ${claimToken}`).send(payload);

  const createClaim = async () => {
    const res = await request(app).post('/api/devices/claim').set(auth());
    return res.body as { claim_id: number; token: string; install_path: string; expires_at: number };
  };

  const basePayload = { hostname: 'claimed-box', cpu: 25, mem_total: 16_000_000_000, mem_used: 8_000_000_000 };

  const ifacesPayload = [
    { name: 'eth0', mac: 'aa:bb:cc:dd:ee:01', kind: 'eth', ips: ['192.168.1.50'], broadcast: '192.168.1.255' },
    { name: 'wlan0', mac: 'aa:bb:cc:dd:ee:02', kind: 'wifi', ips: ['192.168.1.51'], broadcast: null }
  ];

  describe('schema', () => {
    it('creates the agent_claims table, its index and devices.interfaces column', async () => {
      const table = (await ctx.db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_claims'"
      )) as { name: string } | undefined;
      expect(table?.name).toBe('agent_claims');

      const cols = ((await ctx.db.all('PRAGMA table_info(agent_claims)')) as { name: string }[])
        .map((c) => c.name);
      for (const col of ['id', 'token_hash', 'created_at', 'expires_at', 'last_payload', 'last_seen', 'samples']) {
        expect(cols).toContain(col);
      }

      const index = (await ctx.db.get(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_claims_token'"
      )) as { name: string } | undefined;
      expect(index?.name).toBe('idx_agent_claims_token');

      const deviceCols = ((await ctx.db.all('PRAGMA table_info(devices)')) as { name: string }[]).map((c) => c.name);
      expect(deviceCols).toContain('interfaces');
    });
  });

  describe('sanitizeAgentInterfaces', () => {
    it('normalizes valid entries and uppercases MACs', () => {
      const out = sanitizeAgentInterfaces(ifacesPayload);
      expect(out).toHaveLength(2);
      expect(out[0]).toEqual({
        name: 'eth0',
        mac: 'AA:BB:CC:DD:EE:01',
        kind: 'eth',
        ips: ['192.168.1.50'],
        broadcast: '192.168.1.255'
      });
      expect(out[1].kind).toBe('wifi');
      expect(out[1].broadcast).toBeNull();
    });

    it('drops invalid entries and unknown kinds', () => {
      const out = sanitizeAgentInterfaces([
        { name: 'eth0', mac: 'not-a-mac', kind: 'eth', ips: ['999.1.1.1'], broadcast: 'bogus' },
        { mac: 'aa:bb:cc:dd:ee:ff', kind: 'bluetooth', ips: [] },
        'nope',
        null,
        { name: 'ok0', kind: 'eth', ips: ['10.0.0.2', '10.0.0.2', 'bad'] }
      ]);
      expect(out).toHaveLength(2);
      expect(out[0]).toEqual({ name: 'eth0', mac: null, kind: 'eth', ips: [], broadcast: null });
      expect(out[1]).toEqual({ name: 'ok0', mac: null, kind: 'eth', ips: ['10.0.0.2'], broadcast: null });
    });

    it('returns an empty array for non-array input', () => {
      expect(sanitizeAgentInterfaces(undefined)).toEqual([]);
      expect(sanitizeAgentInterfaces({ name: 'x' })).toEqual([]);
      expect(sanitizeAgentInterfaces(null)).toEqual([]);
    });
  });

  describe('claim creation', () => {
    it('creates a one-time claim with a clm- token and 15 minute expiry', async () => {
      const before = Date.now();
      const res = await request(app).post('/api/devices/claim').set(auth());
      expect(res.status).toBe(200);
      const body = res.body as { claim_id: number; token: string; install_path: string; expires_at: number };
      expect(typeof body.claim_id).toBe('number');
      expect(body.token.startsWith('clm-')).toBe(true);
      expect(body.install_path).toBe('/api/agent/install');
      expect(body.expires_at - before).toBeGreaterThanOrEqual(15 * 60_000 - 2000);
      expect(body.expires_at - before).toBeLessThan(16 * 60_000);

      const devices = (await ctx.db.all('SELECT id FROM devices')) as { id: number }[];
      expect(devices.length).toBe(0);
    });

    it('requires auth', async () => {
      const res = await request(app).post('/api/devices/claim');
      expect(res.status).toBe(401);
    });
  });

  describe('status and agent push against a claim', () => {
    let claim: { claim_id: number; token: string };

    it('reports not installed before any push', async () => {
      const created = await createClaim();
      claim = created;
      const res = await request(app).get(`/api/devices/claims/${created.claim_id}/status`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.installed).toBe(false);
      expect(res.body.snapshot).toBeNull();
      expect(res.body.power_samples).toEqual([]);
    });

    it('stores payloads and accumulates power samples on pushes', async () => {
      const r1 = await pushClaim(claim.token, { ...basePayload, cpu_power_w: 10.5, interfaces: ifacesPayload });
      expect(r1.status).toBe(200);
      expect(r1.body.ok).toBe(true);

      const r2 = await pushClaim(claim.token, { ...basePayload, cpu: 40, cpu_power_w: 12, interfaces: ifacesPayload });
      expect(r2.status).toBe(200);

      const res = await request(app).get(`/api/devices/claims/${claim.claim_id}/status`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.installed).toBe(true);
      expect(res.body.last_seen).toBeGreaterThan(0);
      expect(res.body.power_samples).toEqual([10.5, 12]);

      const snapshot = res.body.snapshot as { hostname: string; cpu: number; interfaces: unknown[] };
      expect(snapshot.hostname).toBe('claimed-box');
      expect(snapshot.cpu).toBe(40);
      expect(snapshot.interfaces).toHaveLength(2);
      expect((snapshot.interfaces[1] as { kind: string }).kind).toBe('wifi');
    });

    it('keeps accepting old payloads without an interfaces field', async () => {
      const legacy = await createClaim();
      const res = await pushClaim(legacy.token, basePayload);
      expect(res.status).toBe(200);
      const status = await request(app).get(`/api/devices/claims/${legacy.claim_id}/status`).set(auth());
      expect(status.status).toBe(200);
      expect(status.body.installed).toBe(true);
      expect((status.body.snapshot as { interfaces: unknown[] }).interfaces).toEqual([]);
    });

    it('rejects pushes with an unknown agent token', async () => {
      const res = await pushClaim('clm-unknown', basePayload);
      expect(res.status).toBe(401);
    });
  });

  describe('finalize (POST /devices with agent_token)', () => {
    it('binds the claim to a new device, seeds metrics_live and deletes the claim', async () => {
      const created = await createClaim();
      await pushClaim(created.token, { ...basePayload, cpu_power_w: 18.2, interfaces: ifacesPayload });

      const res = await request(app)
        .post('/api/devices')
        .set(auth())
        .send({
          name: 'Claimed Box',
          ip: '192.168.1.50',
          mac: 'AA:BB:CC:DD:EE:01',
          type: 'pc',
          base_power_w: 12,
          agent_token: created.token,
          interfaces: ifacesPayload
        });
      expect(res.status).toBe(200);
      const deviceId = res.body.id as number;

      const claimGone = await request(app).get(`/api/devices/claims/${created.claim_id}/status`).set(auth());
      expect(claimGone.status).toBe(404);

      const row = (await ctx.db.get('SELECT agent_token, interfaces FROM devices WHERE id = ?', deviceId)) as {
        agent_token: string | null;
        interfaces: string | null;
      };
      expect(row.agent_token?.startsWith('sha256:')).toBe(true);
      const stored = JSON.parse(row.interfaces ?? '[]') as { name: string }[];
      expect(stored).toHaveLength(2);

      const live = (await ctx.db.get(
        'SELECT payload, received_at FROM metrics_live WHERE device_id = ?',
        deviceId
      )) as { payload: string; received_at: number };
      const seed = JSON.parse(live.payload) as { hostname: string; power_total_w: number | null };
      expect(seed.hostname).toBe('claimed-box');
      expect(seed.power_total_w).toBe(18.2);

      const list = await request(app).get('/api/devices').set(auth());
      const device = (list.body as { id: number; interfaces?: unknown[] }[]).find((d) => d.id === deviceId);
      expect(device).toBeDefined();
      const ifaces = device?.interfaces as { name: string; mac: string | null; kind: string | null }[] | undefined;
      expect(Array.isArray(ifaces)).toBe(true);
      expect(ifaces?.[0]?.name).toBe('eth0');
      expect(ifaces?.[0]?.mac).toBe('AA:BB:CC:DD:EE:01');

      const after = await pushClaim(created.token, { ...basePayload, cpu: 55 });
      expect(after.status).toBe(200);
      const raw = (await ctx.db.get('SELECT device_id FROM metrics_raw WHERE device_id = ?', deviceId)) as {
        device_id: number;
      } | undefined;
      expect(raw?.device_id).toBe(deviceId);
    });

    it('rejects an unknown or expired agent_token with 404', async () => {
      const res = await request(app)
        .post('/api/devices')
        .set(auth())
        .send({ name: 'Ghost', ip: '192.168.1.99', type: 'pc', agent_token: 'clm-does-not-exist' });
      expect(res.status).toBe(404);
    });

    it('prunes expired claims lazily on status lookup', async () => {
      const now = Date.now();
      await ctx.db.run(
        'INSERT INTO agent_claims (token_hash, created_at, expires_at) VALUES (?, ?, ?)',
        ['sha256:stale', now - 20 * 60_000, now - 5 * 60_000]
      );
      const row = (await ctx.db.get('SELECT id FROM agent_claims WHERE token_hash = ?', 'sha256:stale')) as {
        id: number;
      };
      const res = await request(app).get(`/api/devices/claims/${row.id}/status`).set(auth());
      expect(res.status).toBe(404);
      const gone = (await ctx.db.get('SELECT id FROM agent_claims WHERE id = ?', row.id)) as { id: number } | undefined;
      expect(gone).toBeUndefined();
    });

    it('accepts interfaces provided as a JSON string', async () => {
      const res = await request(app)
        .post('/api/devices')
        .set(auth())
        .send({
          name: 'String Ifaces',
          ip: '192.168.1.77',
          type: 'pc',
          interfaces: JSON.stringify([{ name: 'eth9', mac: 'aa:bb:cc:dd:ee:09', kind: 'eth', ips: ['192.168.1.77'] }])
        });
      expect(res.status).toBe(200);
      const list = await request(app).get('/api/devices').set(auth());
      const device = (list.body as { id: number; interfaces?: unknown[] }[]).find((d) => d.id === res.body.id);
      expect(device?.interfaces).toHaveLength(1);
    });

    it('rejects a non-normalizable interfaces payload', async () => {
      const res = await request(app)
        .post('/api/devices')
        .set(auth())
        .send({ name: 'Bad Ifaces', ip: '192.168.1.78', type: 'pc', interfaces: { bogus: true } });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid interfaces payload');
    });
  });

  describe('abandon and expiry edges', () => {
    it('DELETE removes the claim so later status is 404', async () => {
      const created = await createClaim();
      const del = await request(app).delete(`/api/devices/claims/${created.claim_id}`).set(auth());
      expect(del.status).toBe(200);
      const res = await request(app).get(`/api/devices/claims/${created.claim_id}/status`).set(auth());
      expect(res.status).toBe(404);
    });

    it('unknown claim id is 404', async () => {
      const res = await request(app).get('/api/devices/claims/999999/status').set(auth());
      expect(res.status).toBe(404);
    });
  });

  describe('export / import round-trip', () => {
    it('keeps interfaces through export and re-import', async () => {
      const res = await request(app)
        .post('/api/devices')
        .set(auth())
        .send({ name: 'Round Trip', ip: '192.168.1.70', type: 'pc', interfaces: ifacesPayload });
      const deviceId = res.body.id as number;

      const exported = await request(app).get('/api/data/export').set(auth());
      expect(exported.status).toBe(200);
      const devices = (exported.body as { devices: Record<string, unknown>[] }).devices;
      const row = devices.find((d) => d.id === deviceId);
      expect(row).toBeDefined();
      const ifaces = JSON.parse(String(row?.interfaces ?? '[]')) as { name: string }[];
      expect(ifaces).toHaveLength(2);

      const del = await request(app).delete(`/api/devices/${deviceId}`).set(auth());
      expect(del.status).toBe(200);

      const imported = await request(app).post('/api/data/import').set(auth()).send({ devices: [row] });
      expect(imported.status).toBe(200);

      const list = await request(app).get('/api/devices').set(auth());
      const restored = (list.body as { id: number; name: string; interfaces?: unknown[] }[]).find(
        (d) => d.name === 'Round Trip'
      );
      expect(restored).toBeDefined();
      expect(restored?.interfaces).toHaveLength(2);
    });
  });
});
