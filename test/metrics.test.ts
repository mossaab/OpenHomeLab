import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { initDb, createApp, sanitizeAgentPayload, aggregateMetrics } from '../server';

type Ctx = Awaited<ReturnType<typeof initDb>>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('Agent metrics', () => {
  let tmpDir: string;
  let ctx: Ctx;
  let app: ReturnType<typeof createApp>;
  let token: string;
  let deviceId: number;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    delete process.env.APP_ENCRYPTION_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhomelab-metrics-'));
    ctx = await initDb(path.join(tmpDir, 'db.sqlite'));

    const hash = await bcrypt.hash('password123', 10);
    await ctx.db.run('UPDATE settings SET master_password_hash = ? WHERE id = 1', [hash]);
    token = jwt.sign({ id: 1 }, ctx.jwtSecret, { expiresIn: '24h' });

    app = createApp(ctx);

    const res = await request(app)
      .post('/api/devices')
      .set({ Authorization: `Bearer ${token}` })
      .send({ name: 'Metrics Box', ip: '192.168.1.50', type: 'server' });
    deviceId = res.body.id;
  });

  afterAll(async () => {
    if (ctx) await ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  function basePayload() {
    return {
      hostname: 'testhost',
      cpu: 42.5,
      load: [0.5, 0.4, 0.3],
      mem_total: 8_000_000_000,
      mem_used: 4_000_000_000,
      swap_total: 1_000_000_000,
      swap_used: 100_000_000,
      disks: [{ name: '/dev/sda1', total: 1_000_000_000, used: 500_000_000 }],
      net_rx: 1234,
      net_tx: 567,
      uptime_s: 12345,
      gpus: [{ util: 55, mem_used_mb: 2048, mem_total_mb: 8192, temp_c: 60, power_w: 73.5 }],
      cpu_power_w: 45,
    };
  }

  async function postStats(tokenValue: string | undefined, payload: Record<string, unknown>) {
    const req = request(app).post('/api/agent/stats').send(payload);
    if (tokenValue) req.set('Authorization', `Bearer ${tokenValue}`);
    return req;
  }

  describe('schema', () => {
    it('creates the metrics tables and the devices.agent_token column', async () => {
      const tables = (await ctx.db.all(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('metrics_live','metrics_raw','metrics_hourly','metrics_daily')`
      )) as { name: string }[];
      expect(tables.map((t) => t.name).sort()).toEqual(['metrics_daily', 'metrics_hourly', 'metrics_live', 'metrics_raw']);

      const cols = (await ctx.db.all('PRAGMA table_info(devices)')) as { name: string }[];
      expect(cols.map((c) => c.name)).toContain('agent_token');

      const rawCols = ((await ctx.db.all('PRAGMA table_info(metrics_raw)')) as { name: string }[]).map((c) => c.name);
      for (const col of ['gpu_util', 'gpu_mem_pct', 'cpu_power_w', 'power_total_w']) {
        expect(rawCols).toContain(col);
      }
      const hourlyCols = ((await ctx.db.all('PRAGMA table_info(metrics_hourly)')) as { name: string }[]).map((c) => c.name);
      for (const col of ['gpu_util_avg', 'gpu_util_max', 'gpu_mem_pct_max', 'cpu_power_w_avg', 'power_total_w_avg', 'power_total_w_max', 'net_rx_avg', 'net_tx_avg']) {
        expect(hourlyCols).toContain(col);
      }
      const dailyCols = ((await ctx.db.all('PRAGMA table_info(metrics_daily)')) as { name: string }[]).map((c) => c.name);
      for (const col of ['net_rx_avg', 'net_tx_avg']) {
        expect(dailyCols).toContain(col);
      }

      const settingsCols = ((await ctx.db.all('PRAGMA table_info(settings)')) as { name: string }[]).map((c) => c.name);
      for (const col of ['cost_per_kwh', 'currency']) {
        expect(settingsCols).toContain(col);
      }
    });
  });

  describe('sanitizeAgentPayload', () => {
    it('rejects payloads without a numeric cpu value', () => {
      expect(sanitizeAgentPayload({}, Date.now())).toBeNull();
      expect(sanitizeAgentPayload({ cpu: 'nan' }, Date.now())).toBeNull();
    });

    it('clamps cpu into 0..100 and normalizes memory values', () => {
      const snap = sanitizeAgentPayload(
        { cpu: 250, mem_total: 8, mem_used: 9, disks: 'nope' },
        Date.now()
      );
      expect(snap).not.toBeNull();
      expect(snap!.cpu).toBe(100);
      expect(snap!.mem_used).toBe(8);
      expect(snap!.disks).toEqual([]);
    });

    it('sanitizes disk names and caps the disk list', () => {
      const disks = Array.from({ length: 40 }, (_, i) => ({ name: `disk ${i}/x`, total: 10, used: 5 }));
      const snap = sanitizeAgentPayload({ cpu: 1, disks }, Date.now());
      expect(snap!.disks).toHaveLength(16);
      expect(snap!.disks[0].name).toBe('disk_0_x');
    });

    it('sanitizes gpus: clamps util, drops invalid entries, caps at 8', () => {
      const gpus = [
        { util: 150, mem_used_mb: -5, mem_total_mb: 1024, temp_c: 'x', power_w: -1 },
        { util: null, mem_used_mb: 2048, mem_total_mb: 8192, temp_c: 60, power_w: 73.5 },
        'not-an-object',
      ];
      for (let i = 0; i < 6; i += 1) gpus.push({ util: 10, mem_used_mb: 1, mem_total_mb: 2, temp_c: null, power_w: null });
      const snap = sanitizeAgentPayload({ cpu: 1, gpus }, Date.now());
      expect(snap!.gpus).toHaveLength(8);
      expect(snap!.gpus[0].util).toBe(100);
      expect(snap!.gpus[0].mem_used_mb).toBe(0);
      expect(snap!.gpus[0].temp_c).toBeNull();
      expect(snap!.gpus[0].power_w).toBeNull();
      expect(snap!.gpus[1].util).toBeNull();
      expect(snap!.gpus[1].temp_c).toBe(60);
      expect(snap!.gpus[1].power_w).toBeCloseTo(73.5);
    });

    it('sanitizes gpus[].processes: keeps valid entries, drops invalid, caps at 32', () => {
      const valid = Array.from({ length: 35 }, (_, i) => ({ pid: i + 1, name: `proc ${i}`, mem_mb: i * 10 }));
      const mixed = [
        ...valid,
        'not-an-object',
        { pid: -5, name: 'neg', mem_mb: 1 },
        { pid: 7, name: '', mem_mb: 1 },
        { pid: 9, name: 'no-mem' },
        { pid: 11, name: `long-${'x'.repeat(200)}`, mem_mb: -3 },
      ];
      const snap = sanitizeAgentPayload(
        { cpu: 1, gpus: [{ util: 50, mem_used_mb: 1, mem_total_mb: 2, temp_c: null, power_w: null, processes: mixed }] },
        Date.now()
      );
      expect(snap!.gpus[0].processes).toHaveLength(32);
      expect(snap!.gpus[0].processes[0]).toEqual({ pid: 1, name: 'proc_0', mem_mb: 0 });

      const cleaned = sanitizeAgentPayload(
        { cpu: 1, gpus: [{ util: 50, mem_used_mb: 1, mem_total_mb: 2, temp_c: null, power_w: null, processes: [
          { pid: 42, name: 'python3', mem_mb: 128.6 },
          { pid: 'nope', name: 'x', mem_mb: 1 },
        ] }] },
        Date.now()
      );
      expect(cleaned!.gpus[0].processes).toEqual([{ pid: 42, name: 'python3', mem_mb: 129 }]);

      const missing = sanitizeAgentPayload({ cpu: 1, gpus: [{ util: 50, mem_used_mb: 1, mem_total_mb: 2, temp_c: null, power_w: null }] }, Date.now());
      expect(missing!.gpus[0].processes).toEqual([]);
    });

    it('keeps explicit null power values unavailable (not zero)', () => {
      const snap = sanitizeAgentPayload({ cpu: 1, gpus: [{ util: 50, mem_used_mb: 1, mem_total_mb: 2, temp_c: 40, power_w: 73.5 }], cpu_power_w: null }, Date.now());
      expect(snap!.cpu_power_w).toBeNull();
      expect(snap!.power_total_w).toBeCloseTo(73.5);
    });

    it('derives power_total_w from cpu and gpu powers', () => {
      const both = sanitizeAgentPayload({ cpu: 1, gpus: [{ util: 50, mem_used_mb: 1, mem_total_mb: 2, temp_c: null, power_w: 73.5 }], cpu_power_w: 45 }, Date.now());
      expect(both!.power_total_w).toBeCloseTo(118.5);

      const cpuOnly = sanitizeAgentPayload({ cpu: 1, gpus: [], cpu_power_w: 45 }, Date.now());
      expect(cpuOnly!.power_total_w).toBeCloseTo(45);

      const none = sanitizeAgentPayload({ cpu: 1 }, Date.now());
      expect(none!.gpus).toEqual([]);
      expect(none!.cpu_power_w).toBeNull();
      expect(none!.power_total_w).toBeNull();
    });

    it('sanitizes system information fields and clamps lengths', () => {
      const snap = sanitizeAgentPayload(
        {
          cpu: 1,
          os_family: 'linux',
          os_name: `long ${'x'.repeat(300)}`,
          os_id: 'Ubuntu',
          kernel: '6.8.0-40-generic',
          cpu_vendor: 'GenuineIntel',
          cpu_model: 'Intel(R) Xeon(R) W-3275M CPU @ 3.40GHz',
          cpu_cores: 12,
          cpu_freq_ghz: 3.4,
        },
        Date.now()
      );
      expect(snap!.os_family).toBe('linux');
      expect(snap!.os_name).toHaveLength(128);
      expect(snap!.os_id).toBe('ubuntu');
      expect(snap!.kernel).toBe('6.8.0-40-generic');
      expect(snap!.cpu_vendor).toBe('GenuineIntel');
      expect(snap!.cpu_model).toContain('Xeon');
      expect(snap!.cpu_cores).toBe(12);
      expect(snap!.cpu_freq_ghz).toBeCloseTo(3.4);
    });

    it('drops invalid system information values and keeps legacy payloads clean', () => {
      const snap = sanitizeAgentPayload(
        { cpu: 1, os_family: 'windows', kernel: 'a'.repeat(200), cpu_cores: -4, cpu_freq_ghz: 999 },
        Date.now()
      );
      expect(snap!.os_family).toBeNull();
      expect(snap!.os_name).toBeNull();
      expect(snap!.kernel).toHaveLength(64);
      expect(snap!.cpu_cores).toBeNull();
      expect(snap!.cpu_freq_ghz).toBeNull();

      const mac = sanitizeAgentPayload({ cpu: 1, os_family: 'macos', os_name: 'macOS 15.1', cpu_cores: 10.5 }, Date.now());
      expect(mac!.os_family).toBe('macos');
      expect(mac!.os_name).toBe('macOS 15.1');
      expect(mac!.cpu_cores).toBeNull();

      const legacy = sanitizeAgentPayload({ cpu: 1 }, Date.now());
      expect(legacy!.os_family).toBeNull();
      expect(legacy!.os_name).toBeNull();
      expect(legacy!.os_id).toBeNull();
      expect(legacy!.kernel).toBeNull();
      expect(legacy!.cpu_vendor).toBeNull();
      expect(legacy!.cpu_model).toBeNull();
      expect(legacy!.cpu_cores).toBeNull();
      expect(legacy!.cpu_freq_ghz).toBeNull();
    });

    it('keeps GPU names and strips quotes and backslashes from them', () => {
      const snap = sanitizeAgentPayload(
        { cpu: 1, gpus: [{ util: 10, mem_used_mb: 1, mem_total_mb: 2, temp_c: null, power_w: null, name: 'NVIDIA "GeForce" RTX \\"4090' }] },
        Date.now()
      );
      expect(snap!.gpus[0].name).toBe('NVIDIA GeForce RTX 4090');

      const unnamed = sanitizeAgentPayload({ cpu: 1, gpus: [{ util: 10, mem_used_mb: 1, mem_total_mb: 2 }] }, Date.now());
      expect(unnamed!.gpus[0].name).toBeNull();
    });
  });

  describe('agent token', () => {
    let agentToken: string;

    it('requires auth to generate a token', async () => {
      const res = await request(app).post(`/api/devices/${deviceId}/agent/token`);
      expect(res.status).toBe(401);
    });

    it('returns 404 for an unknown device', async () => {
      const res = await request(app).post('/api/devices/99999/agent/token').set(auth());
      expect(res.status).toBe(404);
    });

    it('generates a token and stores only its hash', async () => {
      const res = await request(app).post(`/api/devices/${deviceId}/agent/token`).set(auth());
      expect(res.status).toBe(200);
      agentToken = res.body.token;
      expect(typeof agentToken).toBe('string');
      expect(agentToken.length).toBeGreaterThan(32);
      expect(res.body.install_path).toBe('/api/agent/install');

      const row = (await ctx.db.get('SELECT agent_token FROM devices WHERE id = ?', deviceId)) as {
        agent_token: string;
      };
      expect(row.agent_token.startsWith('sha256:')).toBe(true);
      expect(row.agent_token).not.toContain(agentToken);
    });

    it('rotation invalidates the previous token', async () => {
      const oldToken = agentToken;
      const res = await request(app).post(`/api/devices/${deviceId}/agent/token`).set(auth());
      agentToken = res.body.token;

      const stale = await postStats(oldToken, basePayload());
      expect(stale.status).toBe(401);

      const fresh = await postStats(agentToken, basePayload());
      expect(fresh.status).toBe(200);
    });
  });

  describe('agent installer endpoint', () => {
    it('serves the public install script without JWT auth', async () => {
      const res = await request(app).get('/api/agent/install');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('openhomelab-agent');
      expect(res.text).toContain('/api/agent/stats');
      expect(res.text).toContain('systemctl restart openhomelab-agent');
      expect(res.text).toContain('query-compute-apps');
    });
  });

  describe('stats ingestion', () => {
    let agentToken: string;

    beforeAll(async () => {
      const res = await request(app).post(`/api/devices/${deviceId}/agent/token`).set(auth());
      agentToken = res.body.token;
    });

    it('rejects a missing token with 401', async () => {
      const res = await postStats(undefined, basePayload());
      expect(res.status).toBe(401);
    });

    it('rejects an unknown token with 401', async () => {
      const res = await postStats('tk-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', basePayload());
      expect(res.status).toBe(401);
    });

    it('rejects an invalid payload with 400', async () => {
      const res = await postStats(agentToken, { hostname: 'x' });
      expect(res.status).toBe(400);
    });

    it('stores a raw row and upserts the live snapshot on a valid push', async () => {
      const res = await postStats(agentToken, basePayload());
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const raw = (await ctx.db.get(
        'SELECT * FROM metrics_raw WHERE device_id = ? ORDER BY id DESC LIMIT 1',
        deviceId
      )) as { cpu: number; mem_pct: number; load1: number; net_rx: number; net_tx: number; disk_used_pct: number; gpu_util: number; gpu_mem_pct: number; cpu_power_w: number; power_total_w: number };
      expect(raw.cpu).toBeCloseTo(42.5);
      expect(raw.mem_pct).toBeCloseTo(50);
      expect(raw.load1).toBeCloseTo(0.5);
      expect(raw.net_rx).toBe(1234);
      expect(raw.net_tx).toBe(567);
      expect(raw.disk_used_pct).toBeCloseTo(50);
      expect(raw.gpu_util).toBeCloseTo(55);
      expect(raw.gpu_mem_pct).toBeCloseTo(25);
      expect(raw.cpu_power_w).toBeCloseTo(45);
      expect(raw.power_total_w).toBeCloseTo(118.5);

      const live = (await ctx.db.get('SELECT payload, received_at FROM metrics_live WHERE device_id = ?', deviceId)) as {
        payload: string;
        received_at: number;
      };
      const snap = JSON.parse(live.payload) as { hostname: string; cpu: number; disks: unknown[]; gpus: unknown[]; power_total_w: number };
      expect(snap.hostname).toBe('testhost');
      expect(snap.cpu).toBeCloseTo(42.5);
      expect(Array.isArray(snap.disks)).toBe(true);
      expect(snap.gpus).toHaveLength(1);
      expect(snap.power_total_w).toBeCloseTo(118.5);
      expect(live.received_at).toBeGreaterThan(Date.now() - 10_000);
    });

    it('exposes the live snapshot through GET /devices/:id/stats/live', async () => {
      const res = await request(app).get(`/api/devices/${deviceId}/stats/live`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.live.hostname).toBe('testhost');
      expect(res.body.last_seen).toBeGreaterThan(Date.now() - 10_000);
    });

    it('summarizes every device in GET /devices/stats/all', async () => {
      const res = await request(app).get('/api/devices/stats/all').set(auth());
      expect(res.status).toBe(200);
      const entry = res.body[String(deviceId)];
      expect(entry.cpu).toBe(43);
      expect(entry.mem_pct).toBe(50);
      expect(entry.gpu_util).toBe(55);
      expect(entry.power_total_w).toBeCloseTo(118.5);
      expect(typeof entry.last_seen).toBe('number');
    });
  });

  describe('agent version reporting', () => {
    let agentToken: string;

    beforeAll(async () => {
      const res = await request(app).post(`/api/devices/${deviceId}/agent/token`).set(auth());
      agentToken = res.body.token;
    });

    it('stores the pushed agent_version in the live snapshot and exposes it on devices and stats/all', async () => {
      const res = await postStats(agentToken, { ...basePayload(), agent_version: '1.2' });
      expect(res.status).toBe(200);

      const live = (await ctx.db.get('SELECT payload FROM metrics_live WHERE device_id = ?', deviceId)) as {
        payload: string;
      };
      expect((JSON.parse(live.payload) as { agent_version: string }).agent_version).toBe('1.2');

      const list = await request(app).get('/api/devices').set(auth());
      expect(list.status).toBe(200);
      const device = (list.body as unknown as { id: number; agent_version?: string | null }[]).find(
        (d) => d.id === deviceId,
      );
      expect(device?.agent_version).toBe('1.2');

      const stats = await request(app).get('/api/devices/stats/all').set(auth());
      expect(stats.status).toBe(200);
      expect(stats.body[String(deviceId)].agent_version).toBe('1.2');
    });

    it('drops oversized agent_version values', async () => {
      const res = await postStats(agentToken, { ...basePayload(), agent_version: 'x'.repeat(64) });
      expect(res.status).toBe(200);

      const live = (await ctx.db.get('SELECT payload FROM metrics_live WHERE device_id = ?', deviceId)) as {
        payload: string;
      };
      expect((JSON.parse(live.payload) as { agent_version: string | null }).agent_version).toBeNull();
    });

    it('stores pushed os information and exposes it on devices and stats/all', async () => {
      const res = await postStats(agentToken, {
        ...basePayload(),
        os_family: 'linux',
        os_name: 'Debian GNU/Linux 12',
        os_id: 'debian',
        kernel: '6.1.0-28-amd64',
        cpu_vendor: 'AMD',
        cpu_model: 'AMD Ryzen 9 7950X',
        cpu_cores: 16,
        cpu_freq_ghz: 5.7,
      });
      expect(res.status).toBe(200);

      const list = await request(app).get('/api/devices').set(auth());
      const device = (list.body as unknown as { id: number; os_family?: string | null; os_name?: string | null }[]).find(
        (d) => d.id === deviceId,
      );
      expect(device?.os_family).toBe('linux');
      expect(device?.os_name).toBe('Debian GNU/Linux 12');

      const stats = await request(app).get('/api/devices/stats/all').set(auth());
      expect(stats.body[String(deviceId)].os_family).toBe('linux');
      expect(stats.body[String(deviceId)].os_name).toBe('Debian GNU/Linux 12');
    });
  });

  describe('history endpoint', () => {
    let agentToken: string;

    beforeAll(async () => {
      const res = await request(app).post(`/api/devices/${deviceId}/agent/token`).set(auth());
      agentToken = res.body.token;
    });

    it('rejects an unknown device with 404', async () => {
      const res = await request(app).get('/api/devices/99999/stats/history').set(auth());
      expect(res.status).toBe(404);
    });

    it('rejects an invalid range with 400', async () => {
      const res = await request(app)
        .get(`/api/devices/${deviceId}/stats/history?range=3w`)
        .set(auth());
      expect(res.status).toBe(400);
    });

    it('returns raw-based points bucketed by range (1h)', async () => {
      const base = Math.floor(Date.now() / 30_000) * 30_000;
      await ctx.db.run('DELETE FROM metrics_raw WHERE device_id = ?', deviceId);
      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, cpu, mem_pct, gpu_util, power_total_w) VALUES (?, ?, ?, ?, ?, ?)',
        [deviceId, base - 60_000, 20, 40, 30, 90]
      );
      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, cpu, mem_pct, gpu_util, power_total_w) VALUES (?, ?, ?, ?, ?, ?)',
        [deviceId, base - 30_000, 80, 60, 70, 140]
      );

      const res = await request(app)
        .get(`/api/devices/${deviceId}/stats/history?range=1h`)
        .set(auth());
      expect(res.status).toBe(200);
      expect(res.body.device_id).toBe(deviceId);
      expect(res.body.range).toBe('1h');
      const points = res.body.points as { ts: number; cpu_avg: number; gpu_avg: number | null; power_avg: number | null }[];
      expect(points).toHaveLength(2);
      expect(points[0].ts).toBe(base - 60_000);
      expect(points[0].cpu_avg).toBeCloseTo(20);
      expect(points[1].cpu_avg).toBeCloseTo(80);
      expect(points[0].gpu_avg).toBeCloseTo(30);
      expect(points[1].gpu_avg).toBeCloseTo(70);
      expect(points[0].power_avg).toBeCloseTo(90);
      expect(points[1].power_avg).toBeCloseTo(140);
    });

    it('returns hourly-aggregated points for the 30d range', async () => {
      const bucket = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 5 * DAY_MS;
      await ctx.db.run(
        `INSERT INTO metrics_hourly (device_id, bucket, cpu_avg, cpu_max, mem_pct_avg, mem_pct_max, gpu_util_avg, gpu_util_max, power_total_w_avg, power_total_w_max)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [deviceId, bucket, 12.5, 30, 45, 60, 15, 25, 80, 95]
      );

      const res = await request(app)
        .get(`/api/devices/${deviceId}/stats/history?range=30d`)
        .set(auth());
      expect(res.status).toBe(200);
      const points = res.body.points as { ts: number; cpu_avg: number; gpu_avg: number | null; power_max: number | null }[];
      expect(points.some((p) => p.ts === bucket && Math.abs(p.cpu_avg - 12.5) < 0.01)).toBe(true);
      const pt = points.find((p) => p.ts === bucket);
      expect(pt?.gpu_avg).toBeCloseTo(15);
      expect(pt?.power_max).toBeCloseTo(95);
    });

    it('returns an empty point list for a device without history', async () => {
      const res = await request(app).post('/api/devices').set(auth()).send({ name: 'Empty Box', ip: '192.168.1.51', type: 'pc' });
      const id = res.body.id;
      const hist = await request(app).get(`/api/devices/${id}/stats/history?range=7d`).set(auth());
      expect(hist.status).toBe(200);
      expect(hist.body.points).toEqual([]);
    });

    it('keeps accepting pushes with the generated token', async () => {
      const res = await request(app)
        .post('/api/agent/stats')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ cpu: 10, mem_total: 8, mem_used: 4 });
      expect(res.status).toBe(200);
    });
  });

  describe('aggregation & retention', () => {
    let aggDeviceId: number;

    beforeAll(async () => {
      const res = await request(app)
        .post('/api/devices')
        .set(auth())
        .send({ name: 'Agg Box', ip: '192.168.1.52', type: 'server' });
      aggDeviceId = res.body.id;
    });

    it('aggregates completed hours and days, purges raw older than 7 days, stays idempotent', async () => {
      const now = Date.now();
      const threeHoursAgo = Math.floor((now - 3 * HOUR_MS) / HOUR_MS) * HOUR_MS + 10 * 60_000;
      const eightDaysAgo = Math.floor((now - 8 * DAY_MS) / DAY_MS) * DAY_MS + 10 * 60_000;

      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, cpu, mem_pct, load1, net_rx, net_tx, disk_used_pct, gpu_util, power_total_w) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [aggDeviceId, threeHoursAgo, 10, 40, 0.1, 100, 10, 30, 20, 80]
      );
      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, cpu, mem_pct, load1, net_rx, net_tx, disk_used_pct, gpu_util, power_total_w) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [aggDeviceId, threeHoursAgo + 60_000, 30, 50, 0.3, 200, 20, 40, 40, 120]
      );
      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, cpu, mem_pct, load1, net_rx, net_tx, disk_used_pct, gpu_util, power_total_w) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [aggDeviceId, eightDaysAgo, 20, 55, 0.2, 50, 5, 60, 10, 70]
      );
      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, cpu, mem_pct, load1, net_rx, net_tx, disk_used_pct, gpu_util, power_total_w) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [aggDeviceId, eightDaysAgo + HOUR_MS, 40, 65, 0.4, 70, 7, 70, 30, 130]
      );

      await aggregateMetrics(ctx.db);

      const hourlyBucket = Math.floor(threeHoursAgo / HOUR_MS) * HOUR_MS;
      const hourly = (await ctx.db.get(
        'SELECT * FROM metrics_hourly WHERE device_id = ? AND bucket = ?',
        [aggDeviceId, hourlyBucket]
      )) as { cpu_avg: number; cpu_max: number; mem_pct_avg: number; load1_max: number; net_rx_max: number; gpu_util_avg: number; gpu_util_max: number; power_total_w_avg: number; power_total_w_max: number };
      expect(hourly.cpu_avg).toBeCloseTo(20);
      expect(hourly.cpu_max).toBeCloseTo(30);
      expect(hourly.mem_pct_avg).toBeCloseTo(45);
      expect(hourly.load1_max).toBeCloseTo(0.3);
      expect(hourly.net_rx_max).toBe(200);
      expect(hourly.gpu_util_avg).toBeCloseTo(30);
      expect(hourly.gpu_util_max).toBeCloseTo(40);
      expect(hourly.power_total_w_avg).toBeCloseTo(100);
      expect(hourly.power_total_w_max).toBeCloseTo(120);

      const dailyBucket = Math.floor(eightDaysAgo / DAY_MS) * DAY_MS;
      const daily = (await ctx.db.get(
        'SELECT * FROM metrics_daily WHERE device_id = ? AND bucket = ?',
        [aggDeviceId, dailyBucket]
      )) as {
        cpu_avg: number;
        cpu_max: number;
        mem_pct_max: number;
        disk_used_pct_max: number;
        gpu_util_avg: number;
        power_total_w_max: number;
      };
      expect(daily.cpu_avg).toBeCloseTo(30);
      expect(daily.cpu_max).toBeCloseTo(40);
      expect(daily.mem_pct_max).toBeCloseTo(65);
      expect(daily.disk_used_pct_max).toBeCloseTo(70);
      expect(daily.gpu_util_avg).toBeCloseTo(20);
      expect(daily.power_total_w_max).toBeCloseTo(130);

      const remaining = (await ctx.db.get('SELECT COUNT(*) AS c FROM metrics_raw WHERE device_id = ?', aggDeviceId)) as {
        c: number;
      };
      expect(remaining.c).toBe(2);

      const beforeHourly = (await ctx.db.get('SELECT COUNT(*) AS c FROM metrics_hourly WHERE device_id = ?', aggDeviceId)).c as number;
      await aggregateMetrics(ctx.db);
      const afterHourly = (await ctx.db.get('SELECT COUNT(*) AS c FROM metrics_hourly WHERE device_id = ?', aggDeviceId)).c as number;
      expect(afterHourly).toBe(beforeHourly);
    });

    it('deleting a device cascades to all metrics tables', async () => {
      const res = await request(app)
        .post('/api/devices')
        .set(auth())
        .send({ name: 'Doomed Box', ip: '192.168.1.53', type: 'pc' });
      const id = res.body.id;

      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, cpu) VALUES (?, ?, ?)',
        [id, Date.now() - 1000, 1]
      );
      await ctx.db.run(
        'INSERT INTO metrics_live (device_id, payload, received_at) VALUES (?, ?, ?)',
        [id, JSON.stringify({ cpu: 1 }), Date.now()]
      );

      const del = await request(app).delete(`/api/devices/${id}`).set(auth());
      expect(del.status).toBe(200);

      for (const table of ['metrics_live', 'metrics_raw', 'metrics_hourly', 'metrics_daily']) {
        const row = (await ctx.db.get(`SELECT COUNT(*) AS c FROM ${table} WHERE device_id = ?`, id)) as { c: number };
        expect(row.c).toBe(0);
      }
    });
  });
});
