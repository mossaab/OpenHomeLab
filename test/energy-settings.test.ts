import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { initDb, createApp } from '../server';

type Ctx = Awaited<ReturnType<typeof initDb>>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Trapezoid between two raw samples 30s apart at 400 W -> 600 W
const RAW_A_KWH = ((400 + 600) / 2) * (30_000 / HOUR_MS) / 1000;

describe('Settings & energy integration', () => {
  let tmpDir: string;
  let ctx: Ctx;
  let app: ReturnType<typeof createApp>;
  let token: string;
  let deviceIdA: number;
  let deviceIdB: number;
  let deviceNoPower: number;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    delete process.env.APP_ENCRYPTION_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhomelab-energy-'));
    ctx = await initDb(path.join(tmpDir, 'db.sqlite'));

    const hash = await bcrypt.hash('password123', 10);
    await ctx.db.run('UPDATE settings SET master_password_hash = ? WHERE id = 1', [hash]);
    token = jwt.sign({ id: 1 }, ctx.jwtSecret, { expiresIn: '24h' });

    app = createApp(ctx);

    const resA = await request(app)
      .post('/api/devices')
      .set({ Authorization: `Bearer ${token}` })
      .send({ name: 'Energy A', ip: '192.168.1.10', type: 'server' });
    deviceIdA = resA.body.id;

    const resB = await request(app)
      .post('/api/devices')
      .set({ Authorization: `Bearer ${token}` })
      .send({ name: 'Energy B', ip: '192.168.1.11', type: 'pc' });
    deviceIdB = resB.body.id;

    const resC = await request(app)
      .post('/api/devices')
      .set({ Authorization: `Bearer ${token}` })
      .send({ name: 'Energy C', ip: '192.168.1.12', type: 'pc' });
    deviceNoPower = resC.body.id;
  });

  afterAll(async () => {
    if (ctx) await ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  describe('GET /api/settings', () => {
    it('requires authentication', async () => {
      const res = await request(app).get('/api/settings');
      expect(res.status).toBe(401);
    });

    it('returns defaults when nothing is configured', async () => {
      const res = await request(app).get('/api/settings').set(auth());
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        cost_per_kwh: null,
        currency: '€',
        agent_interval_seconds: 30,
        ui_refresh_seconds: 30,
        dashboard_view: 'grid',
        dashboard_card_size: 'normal',
        poweroff_action: 'poweroff',
        reboot_action: 'reboot',
        hibernate_action: 'systemctl hibernate'
      });
    });
  });

  describe('PUT /api/settings', () => {
    it('rejects a negative rate', async () => {
      const res = await request(app)
        .put('/api/settings')
        .set(auth())
        .send({ cost_per_kwh: -0.5, currency: '€' });
      expect(res.status).toBe(400);
    });

    it('rejects a non-numeric rate', async () => {
      const res = await request(app)
        .put('/api/settings')
        .set(auth())
        .send({ cost_per_kwh: 'abc' });
      expect(res.status).toBe(400);
    });

    it('rejects an empty currency and falls back to the default', async () => {
      const res = await request(app)
        .put('/api/settings')
        .set(auth())
        .send({ cost_per_kwh: 0.25, currency: '   ' });
      expect(res.status).toBe(200);
      expect(res.body.currency).toBe('€');
    });

    it('falls back to the default for an overlong currency', async () => {
      const res = await request(app)
        .put('/api/settings')
        .set(auth())
        .send({ cost_per_kwh: 0.25, currency: 'euros per kwh' });
      expect(res.status).toBe(200);
      expect(res.body.currency).toBe('€');
    });

    it('saves a valid rate and currency', async () => {
      const res = await request(app)
        .put('/api/settings')
        .set(auth())
        .send({ cost_per_kwh: 0.25, currency: 'EUR' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        cost_per_kwh: 0.25,
        currency: 'EUR',
        agent_interval_seconds: 30,
        ui_refresh_seconds: 30,
        dashboard_view: 'grid',
        dashboard_card_size: 'normal',
        poweroff_action: 'poweroff',
        reboot_action: 'reboot',
        hibernate_action: 'systemctl hibernate'
      });

      const got = await request(app).get('/api/settings').set(auth());
      expect(got.body).toEqual({
        cost_per_kwh: 0.25,
        currency: 'EUR',
        agent_interval_seconds: 30,
        ui_refresh_seconds: 30,
        dashboard_view: 'grid',
        dashboard_card_size: 'normal',
        poweroff_action: 'poweroff',
        reboot_action: 'reboot',
        hibernate_action: 'systemctl hibernate'
      });
    });

    it('keeps the current value when a field is omitted', async () => {
      const res = await request(app)
        .put('/api/settings')
        .set(auth())
        .send({ cost_per_kwh: 0.3 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        cost_per_kwh: 0.3,
        currency: 'EUR',
        agent_interval_seconds: 30,
        ui_refresh_seconds: 30,
        dashboard_view: 'grid',
        dashboard_card_size: 'normal',
        poweroff_action: 'poweroff',
        reboot_action: 'reboot',
        hibernate_action: 'systemctl hibernate'
      });
    });

    it('accepts a numeric rate as a string', async () => {
      const res = await request(app)
        .put('/api/settings')
        .set(auth())
        .send({ cost_per_kwh: '0.42' });
      expect(res.status).toBe(200);
      expect(res.body.cost_per_kwh).toBeCloseTo(0.42);
    });

    it('clears the rate with an explicit null', async () => {
      const res = await request(app)
        .put('/api/settings')
        .set(auth())
        .send({ cost_per_kwh: null, currency: 'EUR' });
      expect(res.status).toBe(200);
      expect(res.body.cost_per_kwh).toBeNull();

      const got = await request(app).get('/api/settings').set(auth());
      expect(got.body.cost_per_kwh).toBeNull();
    });
  });

  describe('per-device energy endpoint', () => {
    it('returns 404 for an unknown device', async () => {
      const res = await request(app).get('/api/devices/99999/stats/energy?range=7d').set(auth());
      expect(res.status).toBe(404);
    });

    it('rejects an invalid range with 400', async () => {
      const res = await request(app).get(`/api/devices/${deviceIdA}/stats/energy?range=3w`).set(auth());
      expect(res.status).toBe(400);
    });

    it('integrates raw samples with the trapezoidal rule and reports null cost when unset', async () => {
      await ctx.db.run('DELETE FROM metrics_raw WHERE device_id = ?', deviceIdA);
      const base = Date.now() - HOUR_MS;
      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, power_total_w) VALUES (?, ?, ?)',
        [deviceIdA, base, 400]
      );
      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, power_total_w) VALUES (?, ?, ?)',
        [deviceIdA, base + 30_000, 600]
      );
      // Sample without power must be ignored by the integration
      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, cpu) VALUES (?, ?, ?)',
        [deviceIdA, base + 60_000, 5]
      );

      const res = await request(app).get(`/api/devices/${deviceIdA}/stats/energy?range=7d`).set(auth());
      expect(res.status).toBe(200);
      // ((400+600)/2) * 30s of draw
      expect(res.body.kwh).toBeCloseTo(RAW_A_KWH, 4);
      expect(res.body.cost).toBeNull();
      expect(res.body.range).toBe('7d');
    });

    it('computes the cost from the configured rate', async () => {
      await request(app)
        .put('/api/settings')
        .set(auth())
        .send({ cost_per_kwh: 0.25, currency: 'EUR' });

      const res = await request(app).get(`/api/devices/${deviceIdA}/stats/energy?range=7d`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.kwh).toBeCloseTo(RAW_A_KWH, 4);
      expect(res.body.cost).toBeCloseTo(RAW_A_KWH * 0.25, 4);
      expect(res.body.currency).toBe('EUR');
    });

    it('sums hourly buckets for the 30d range', async () => {
      await ctx.db.run('DELETE FROM metrics_hourly WHERE device_id = ?', deviceIdA);
      const bucket = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 2 * DAY_MS;
      await ctx.db.run(
        'INSERT INTO metrics_hourly (device_id, bucket, power_total_w_avg) VALUES (?, ?, ?)',
        [deviceIdA, bucket, 400]
      );
      await ctx.db.run(
        'INSERT INTO metrics_hourly (device_id, bucket, power_total_w_avg) VALUES (?, ?, ?)',
        [deviceIdA, bucket + HOUR_MS, 600]
      );

      const res = await request(app).get(`/api/devices/${deviceIdA}/stats/energy?range=30d`).set(auth());
      expect(res.status).toBe(200);
      // (400 Wh + 600 Wh) / 1000 = 1 kWh
      expect(res.body.kwh).toBeCloseTo(1, 4);
      expect(res.body.cost).toBeCloseTo(0.25, 5);
    });

    it('does not bill offline gaps inside partially covered hourly buckets', async () => {
      await ctx.db.run('DELETE FROM metrics_hourly WHERE device_id = ?', deviceIdB);
      const bucket = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - DAY_MS;
      await ctx.db.run(
        `INSERT INTO metrics_hourly (device_id, bucket, power_total_w_avg, power_kwh, online_s)
         VALUES (?, ?, 400, 0.05, 1800)`,
        [deviceIdB, bucket]
      );

      const res = await request(app).get(`/api/devices/${deviceIdB}/stats/energy?range=30d`).set(auth());
      expect(res.status).toBe(200);
      // Only the covered 50 Wh counts, not avg x full hour (400 W x 1h = 1.44 kWh)
      expect(res.body.kwh).toBeCloseTo(0.05, 4);
    });

    it('sums daily buckets for the 1y range', async () => {
      await ctx.db.run('DELETE FROM metrics_daily WHERE device_id = ?', deviceIdA);
      const bucket = Math.floor(Date.now() / DAY_MS) * DAY_MS - 3 * DAY_MS;
      await ctx.db.run(
        'INSERT INTO metrics_daily (device_id, bucket, power_total_w_avg) VALUES (?, ?, ?)',
        [deviceIdA, bucket, 100]
      );

      const res = await request(app).get(`/api/devices/${deviceIdA}/stats/energy?range=1y`).set(auth());
      expect(res.status).toBe(200);
      // 100 W * 24h = 2.4 kWh
      expect(res.body.kwh).toBeCloseTo(2.4, 4);
    });

    it('returns zero for a device without power data', async () => {
      await ctx.db.run('DELETE FROM metrics_raw WHERE device_id = ?', deviceNoPower);
      const res = await request(app).get(`/api/devices/${deviceNoPower}/stats/energy?range=7d`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.kwh).toBe(0);
      expect(res.body.cost).toBeCloseTo(0, 5);
    });

    it('does not bill offline gaps between samples', async () => {
      await ctx.db.run('DELETE FROM metrics_raw WHERE device_id = ?', deviceIdB);
      const base = Date.now() - HOUR_MS;
      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, power_total_w) VALUES (?, ?, ?)',
        [deviceIdB, base - 2 * HOUR_MS, 100]
      );
      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, power_total_w) VALUES (?, ?, ?)',
        [deviceIdB, base, 180]
      );

      const res = await request(app).get(`/api/devices/${deviceIdB}/stats/energy?range=7d`).set(auth());
      expect(res.status).toBe(200);
      // 2h offline gap: no energy is charged across it
      expect(res.body.kwh).toBe(0);
    });
  });

  describe('fleet energy endpoint', () => {
    it('rejects an invalid range with 400', async () => {
      const res = await request(app).get('/api/devices/stats/energy?range=bogus').set(auth());
      expect(res.status).toBe(400);
    });

    it('sums every device over the raw range', async () => {
      // Device A keeps its two 30s-apart raw samples from the per-device tests
      await ctx.db.run('DELETE FROM metrics_raw WHERE device_id = ?', deviceIdB);
      const base = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, power_total_w) VALUES (?, ?, ?)',
        [deviceIdB, base - 2 * HOUR_MS, 200]
      );
      // Device C has only a non-power sample and must contribute nothing
      await ctx.db.run('DELETE FROM metrics_raw WHERE device_id = ?', deviceNoPower);
      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, cpu) VALUES (?, ?, ?)',
        [deviceNoPower, base - HOUR_MS, 10]
      );

      const res = await request(app).get('/api/devices/stats/energy?range=7d').set(auth());
      expect(res.status).toBe(200);
      // RAW_A_KWH (A) + 0 Wh (B single sample) + 0 Wh (C no power)
      expect(res.body.kwh).toBeCloseTo(RAW_A_KWH, 4);
      expect(res.body.cost).toBeCloseTo(RAW_A_KWH * 0.25, 4);
      expect(res.body.currency).toBe('EUR');
    });

    it('sums hourly buckets for the 30d range', async () => {
      // Device A: 1 kWh from the previous test (400 Wh + 600 Wh at 0.25 EUR/kWh)
      await ctx.db.run('DELETE FROM metrics_hourly WHERE device_id = ?', deviceIdB);
      const bucket = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - DAY_MS;
      await ctx.db.run(
        'INSERT INTO metrics_hourly (device_id, bucket, power_total_w_avg) VALUES (?, ?, ?)',
        [deviceIdB, bucket, 500]
      );

      const res = await request(app).get('/api/devices/stats/energy?range=30d').set(auth());
      expect(res.status).toBe(200);
      // 1 kWh (A) + 0.5 kWh (B) = 1.5 kWh
      expect(res.body.kwh).toBeCloseTo(1.5, 4);
      expect(res.body.cost).toBeCloseTo(0.375, 5);
    });
  });

  describe('base power offset', () => {
    it('rejects an invalid base_power_w on create', async () => {
      for (const value of [-5, 99999, 'abc']) {
        const res = await request(app)
          .post('/api/devices')
          .set(auth())
          .send({ name: 'Bad Base', ip: '192.168.1.50', type: 'pc', base_power_w: value });
        expect(res.status).toBe(400);
      }
    });

    it('rejects an invalid base_power_w on update', async () => {
      for (const value of [-5, 99999, 'abc']) {
        const res = await request(app)
          .put(`/api/devices/${deviceIdA}`)
          .set(auth())
          .send({ name: 'Energy A', ip: '192.168.1.10', type: 'server', base_power_w: value });
        expect(res.status).toBe(400);
      }
    });

    it('bills base_power_w over online time only for raw ranges', async () => {
      await ctx.db.run('DELETE FROM metrics_raw WHERE device_id = ?', deviceIdA);
      const base = Date.now() - HOUR_MS;
      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, power_total_w) VALUES (?, ?, ?)',
        [deviceIdA, base, 400]
      );
      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, power_total_w) VALUES (?, ?, ?)',
        [deviceIdA, base + 30_000, 600]
      );

      const put = await request(app)
        .put(`/api/devices/${deviceIdA}`)
        .set(auth())
        .send({ name: 'Energy A', ip: '192.168.1.10', type: 'server', base_power_w: 100 });
      expect(put.status).toBe(200);

      const res = await request(app).get(`/api/devices/${deviceIdA}/stats/energy?range=7d`).set(auth());
      expect(res.status).toBe(200);
      const baseKwh = (100 * 30_000) / 3.6e9;
      expect(res.body.base_power_w).toBe(100);
      expect(res.body.components).toEqual([]);
      expect(Math.abs(res.body.base_kwh - baseKwh)).toBeLessThan(1e-4);
      expect(Math.abs(res.body.kwh - (RAW_A_KWH + baseKwh))).toBeLessThan(1e-4);
    });

    it('bills base_power_w over the full bucket duration for legacy buckets', async () => {
      await ctx.db.run('DELETE FROM metrics_hourly WHERE device_id = ?', deviceIdB);
      const put = await request(app)
        .put(`/api/devices/${deviceIdB}`)
        .set(auth())
        .send({ name: 'Energy B', ip: '192.168.1.11', type: 'pc', base_power_w: 50 });
      expect(put.status).toBe(200);

      const bucket = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - DAY_MS;
      await ctx.db.run(
        'INSERT INTO metrics_hourly (device_id, bucket, power_total_w_avg) VALUES (?, ?, ?)',
        [deviceIdB, bucket, 100]
      );

      const res = await request(app).get(`/api/devices/${deviceIdB}/stats/energy?range=30d`).set(auth());
      expect(res.status).toBe(200);
      // 100 W x 1h + 50 W x 1h of base offset
      expect(Math.abs(res.body.kwh - 0.15)).toBeLessThan(1e-6);
      expect(Math.abs(res.body.base_kwh - 0.05)).toBeLessThan(1e-6);

      const clear = await request(app)
        .put(`/api/devices/${deviceIdB}`)
        .set(auth())
        .send({ name: 'Energy B', ip: '192.168.1.11', type: 'pc', base_power_w: null });
      expect(clear.status).toBe(200);
    });

    it('includes each device base offset in the fleet total', async () => {
      await ctx.db.run('DELETE FROM metrics_raw WHERE device_id IN (?, ?)', [deviceIdA, deviceIdB]);
      const base = Date.now() - HOUR_MS;
      await request(app)
        .put(`/api/devices/${deviceIdA}`)
        .set(auth())
        .send({ name: 'Energy A', ip: '192.168.1.10', type: 'server', base_power_w: 100 });

      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, power_total_w) VALUES (?, ?, ?)',
        [deviceIdA, base, 400]
      );
      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, power_total_w) VALUES (?, ?, ?)',
        [deviceIdA, base + 30_000, 600]
      );
      // Device B has no base offset and a single sample: contributes nothing
      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, power_total_w) VALUES (?, ?, ?)',
        [deviceIdB, base - HOUR_MS, 200]
      );

      const res = await request(app).get('/api/devices/stats/energy?range=7d').set(auth());
      expect(res.status).toBe(200);
      const expected = RAW_A_KWH + (100 * 30_000) / 3.6e9;
      expect(Math.abs(res.body.kwh - expected)).toBeLessThan(1e-4);

      await request(app)
        .put(`/api/devices/${deviceIdA}`)
        .set(auth())
        .send({ name: 'Energy A', ip: '192.168.1.10', type: 'server', base_power_w: null });
    });
  });

  describe('per-component breakdown', () => {
    const round4 = (x: number) => Math.round(x * 10000) / 10000;
    const dtKwh = (w: number) => (w * 30_000) / 3.6e9;

    it('breaks raw energy down into cpu and gpu components', async () => {
      await ctx.db.run('DELETE FROM metrics_raw WHERE device_id = ?', deviceIdA);
      const base = Date.now() - HOUR_MS;
      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, power_total_w, cpu_power_w, power_gpu0_w, power_gpu1_w) VALUES (?, ?, ?, ?, ?, ?)',
        [deviceIdA, base, 400, 100, 50, 25]
      );
      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, power_total_w, cpu_power_w, power_gpu0_w, power_gpu1_w) VALUES (?, ?, ?, ?, ?, ?)',
        [deviceIdA, base + 30_000, 600, 150, 75, 45]
      );

      const res = await request(app).get(`/api/devices/${deviceIdA}/stats/energy?range=7d`).set(auth());
      expect(res.status).toBe(200);
      const comps = res.body.components as { key: string; label: string; avg_w: number | null; kwh: number }[];
      expect(comps.map((c) => c.key)).toEqual(['cpu', 'gpu1', 'gpu2']);
      expect(comps[0].label).toBe('CPU');
      expect(comps[0].kwh).toBe(round4(dtKwh(125)));
      expect(comps[0].avg_w).toBeCloseTo(125, 6);
      expect(comps[1].label).toBe('GPU 1');
      expect(comps[1].kwh).toBe(round4(dtKwh(62.5)));
      expect(comps[1].avg_w).toBeCloseTo(62.5, 6);
      expect(comps[2].label).toBe('GPU 2');
      expect(comps[2].kwh).toBe(round4(dtKwh(35)));
      expect(comps[2].avg_w).toBeCloseTo(35, 6);
    });

    it('breaks hourly energy down into cpu and gpu components', async () => {
      await ctx.db.run('DELETE FROM metrics_hourly WHERE device_id = ?', deviceIdA);
      const bucket = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - DAY_MS;
      await ctx.db.run(
        `INSERT INTO metrics_hourly (device_id, bucket, power_kwh, online_s, cpu_power_kwh, gpu0_power_w_avg, gpu0_power_kwh)
         VALUES (?, ?, 0.1, 3600, 0.04, 20, 0.02)`,
        [deviceIdA, bucket]
      );

      const res = await request(app).get(`/api/devices/${deviceIdA}/stats/energy?range=30d`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.kwh).toBeCloseTo(0.1, 4);
      const comps = res.body.components as { key: string; label: string; avg_w: number | null; kwh: number }[];
      expect(comps.map((c) => c.key)).toEqual(['cpu', 'gpu1']);
      expect(comps[0].kwh).toBe(0.04);
      expect(comps[0].avg_w).toBeCloseTo(40, 6);
      expect(comps[1].kwh).toBe(0.02);
      expect(comps[1].avg_w).toBeCloseTo(20, 6);
    });
  });

  describe('history endpoint network columns', () => {
    it('includes net averages in raw-bucketed points', async () => {
      await ctx.db.run('DELETE FROM metrics_raw WHERE device_id = ?', deviceIdB);
      const base = Math.floor(Date.now() / 30_000) * 30_000;
      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, cpu, net_rx, net_tx) VALUES (?, ?, ?, ?, ?)',
        [deviceIdB, base - 60_000, 10, 1000, 500]
      );
      await ctx.db.run(
        'INSERT INTO metrics_raw (device_id, ts, cpu, net_rx, net_tx) VALUES (?, ?, ?, ?, ?)',
        [deviceIdB, base - 30_000, 20, 3000, 1500]
      );

      const res = await request(app).get(`/api/devices/${deviceIdB}/stats/history?range=1h`).set(auth());
      expect(res.status).toBe(200);
      const points = res.body.points as { ts: number; net_rx_avg: number | null; net_tx_avg: number | null }[];
      expect(points).toHaveLength(2);
      expect(points[0].net_rx_avg).toBeCloseTo(1000);
      expect(points[0].net_tx_avg).toBeCloseTo(500);
      expect(points[1].net_rx_avg).toBeCloseTo(3000);
    });
  });
});
