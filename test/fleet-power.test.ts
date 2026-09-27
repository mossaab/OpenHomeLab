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
const MIN_MS = 60 * 1000;

describe('Fleet power history', () => {
  let tmpDir: string;
  let ctx: Ctx;
  let app: ReturnType<typeof createApp>;
  let token: string;
  let deviceId: number;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    delete process.env.APP_ENCRYPTION_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhomelab-fleet-power-'));
    ctx = await initDb(path.join(tmpDir, 'db.sqlite'));

    const hash = await bcrypt.hash('password123', 10);
    await ctx.db.run('UPDATE settings SET master_password_hash = ? WHERE id = 1', [hash]);
    token = jwt.sign({ id: 1 }, ctx.jwtSecret, { expiresIn: '24h' });

    app = createApp(ctx);

    const res = await request(app)
      .post('/api/devices')
      .set({ Authorization: `Bearer ${token}` })
      .send({ name: 'Power Box', ip: '192.168.1.51', type: 'server' });
    deviceId = res.body.id;
  });

  afterAll(async () => {
    if (ctx) await ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/devices/stats/power?range=24h');
    expect(res.status).toBe(401);
  });

  it('returns 400 for an invalid range', async () => {
    const res = await request(app).get('/api/devices/stats/power?range=bogus').set(auth());
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('buckets raw metrics into 1-minute fleet totals for 1h', async () => {
    const bucketMs = MIN_MS;
    const bucketStart = Math.floor((Date.now() - 10 * MIN_MS) / bucketMs) * bucketMs;
    await ctx.db.run('INSERT INTO metrics_raw (device_id, ts, power_total_w) VALUES (?, ?, ?)', [deviceId, bucketStart + 2000, 100]);
    await ctx.db.run('INSERT INTO metrics_raw (device_id, ts, power_total_w) VALUES (?, ?, ?)', [deviceId, bucketStart + 30000, 200]);

    const res = await request(app).get('/api/devices/stats/power?range=1h').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.range).toBe('1h');
    const points = res.body.points as { ts: number; power_w: number }[];
    const point = points.find((p) => p.ts === bucketStart);
    expect(point).toBeDefined();
    expect(point?.power_w).toBeCloseTo(150, 1);
    expect(bucketStart % bucketMs).toBe(0);
  });

  it('buckets raw metrics into 30-minute fleet totals for 24h', async () => {
    const bucketMs = 30 * MIN_MS;
    const bucketStart = Math.floor((Date.now() - 2 * HOUR_MS) / bucketMs) * bucketMs;
    await ctx.db.run('INSERT INTO metrics_raw (device_id, ts, power_total_w) VALUES (?, ?, ?)', [deviceId, bucketStart + 5 * MIN_MS, 100]);
    await ctx.db.run('INSERT INTO metrics_raw (device_id, ts, power_total_w) VALUES (?, ?, ?)', [deviceId, bucketStart + 40 * MIN_MS, 200]);

    const res = await request(app).get('/api/devices/stats/power?range=24h').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.range).toBe('24h');
    const points = res.body.points as { ts: number; power_w: number }[];
    const first = points.find((p) => p.ts === bucketStart);
    expect(first).toBeDefined();
    expect(first?.power_w).toBeCloseTo(100, 1);
    const second = points.find((p) => p.ts === bucketStart + bucketMs);
    expect(second).toBeDefined();
    expect(second?.power_w).toBeCloseTo(200, 1);
    expect(bucketStart % bucketMs).toBe(0);
  });

  it('sums power across devices within the same bucket', async () => {
    const second = await request(app)
      .post('/api/devices')
      .set(auth())
      .send({ name: 'Second Box', ip: '192.168.1.52', type: 'pc' });
    const otherId = second.body.id as number;

    const bucketMs = 30 * MIN_MS;
    const bucketStart = Math.floor((Date.now() - 3 * HOUR_MS) / bucketMs) * bucketMs;
    await ctx.db.run('INSERT INTO metrics_raw (device_id, ts, power_total_w) VALUES (?, ?, ?)', [deviceId, bucketStart + 5 * MIN_MS, 100]);
    await ctx.db.run('INSERT INTO metrics_raw (device_id, ts, power_total_w) VALUES (?, ?, ?)', [otherId, bucketStart + 15 * MIN_MS, 25]);

    const res = await request(app).get('/api/devices/stats/power?range=24h').set(auth());
    expect(res.status).toBe(200);
    const points = res.body.points as { ts: number; power_w: number }[];
    const point = points.find((p) => p.ts === bucketStart);
    expect(point).toBeDefined();
    expect(point?.power_w).toBeCloseTo(125, 1);
  });

  it('rolls hourly averages into day buckets for the 30d range', async () => {
    const third = await request(app)
      .post('/api/devices')
      .set(auth())
      .send({ name: 'Third Box', ip: '192.168.1.53', type: 'pc' });
    const hourlyId = third.body.id as number;

    const bucketMs = DAY_MS;
    const windowStart = Math.floor((Date.now() - 3 * DAY_MS) / bucketMs) * bucketMs;
    await ctx.db.run('INSERT INTO metrics_hourly (device_id, bucket, power_total_w_avg) VALUES (?, ?, ?)', [hourlyId, windowStart + HOUR_MS, 50]);
    await ctx.db.run('INSERT INTO metrics_hourly (device_id, bucket, power_total_w_avg) VALUES (?, ?, ?)', [hourlyId, windowStart + 2 * HOUR_MS, 70]);

    const res = await request(app).get('/api/devices/stats/power?range=30d').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.range).toBe('30d');
    const points = res.body.points as { ts: number; power_w: number }[];
    const point = points.find((p) => p.ts === windowStart);
    expect(point).toBeDefined();
    expect(point?.power_w).toBeCloseTo(60, 1);
  });

  it('returns empty points when there is no history', async () => {
    const res = await request(app).get('/api/devices/stats/power?range=30d').set(auth());
    const otherWindowStart = Math.floor((Date.now() - 20 * DAY_MS) / DAY_MS) * DAY_MS;
    const points = res.body.points as { ts: number; power_w: number }[];
    expect(points.find((p) => p.ts === otherWindowStart)).toBeUndefined();
  });
});
