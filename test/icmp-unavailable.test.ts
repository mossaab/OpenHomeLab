import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, createApp } from '../server';

vi.mock('ping', () => ({
  default: {
    promise: {
      probe: vi.fn(async () => ({
        alive: false,
        time: null,
        output: 'PING 192.168.1.50 (192.168.1.50): 56 data bytes\nping: permission denied (are you root?)\n',
      })),
    },
  },
}));

type Ctx = Awaited<ReturnType<typeof initDb>>;

describe('ICMP unavailable (permission denied) handling', () => {
  let tmpDir: string;
  let ctx: Ctx;
  let app: ReturnType<typeof createApp>;
  let token: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    delete process.env.APP_ENCRYPTION_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhomelab-icmp-'));
    ctx = await initDb(path.join(tmpDir, 'db.sqlite'));
    app = createApp(ctx);
    const res = await request(app).post('/api/setup').send({ password: 'password123' });
    token = res.body.token;
  });

  afterAll(async () => {
    if (ctx) await ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('fails the scan job with an icmp_unavailable error code', async () => {
    const start = await request(app)
      .post('/api/scan')
      .set(auth())
      .send({ startIp: '192.168.1.50', endIp: '192.168.1.50' });
    expect(start.status).toBe(200);
    expect(typeof start.body.scanId).toBe('string');

    let data: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      const res = await request(app).get(`/api/scan/${start.body.scanId}`).set(auth());
      expect(res.status).toBe(200);
      data = res.body;
      if (data.status === 'done' || data.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(data.status).toBe('failed');
    expect(data.errorCode).toBe('icmp_unavailable');
    expect(String(data.error)).toMatch(/ICMP/i);
  });

  it('reports devices offline without crashing the status endpoint', async () => {
    const created = await request(app)
      .post('/api/devices')
      .set(auth())
      .send({ name: 'Icmp Box', ip: '192.168.1.50', type: 'pc', mac: 'aa:bb:cc:dd:ee:ff' });
    expect(created.status).toBe(200);

    const res = await request(app).get('/api/devices/status').set(auth());
    expect(res.status).toBe(200);
    expect(res.body[created.body.id]).toBe(false);
  });

  it('returns 503 for a manual ping when ICMP is unavailable', async () => {
    const created = await request(app)
      .post('/api/devices')
      .set(auth())
      .send({ name: 'Icmp Box2', ip: '192.168.1.51', type: 'pc', mac: 'aa:bb:cc:dd:ee:02' });
    expect(created.status).toBe(200);

    const res = await request(app).post(`/api/devices/${created.body.id}/ping`).set(auth());
    expect(res.status).toBe(503);
    expect(String(res.body.error)).toMatch(/ICMP/i);
    expect(res.body.errorCode).toBe('icmp_unavailable');
  });
});
