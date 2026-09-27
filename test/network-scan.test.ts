import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, createApp, parseScanRange } from '../server';

type Ctx = Awaited<ReturnType<typeof initDb>>;

describe('network scan API', () => {
  let tmpDir: string;
  let ctx: Ctx;
  let app: ReturnType<typeof createApp>;
  let token: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    delete process.env.APP_ENCRYPTION_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhomelab-scan-'));
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

  it('rejects scans without a token', async () => {
    const res = await request(app).post('/api/scan').send({ startIp: '127.0.0.1', endIp: '127.0.0.1' });
    expect(res.status).toBe(401);
  });

  it('rejects invalid ranges with 400', async () => {
    const cases = [
      { startIp: 'not-an-ip', endIp: '127.0.0.5' },
      { startIp: '8.8.8.0', endIp: '8.8.8.5' },
      { startIp: '192.168.1.200', endIp: '192.168.1.10' },
      { startIp: '10.0.0.1', endIp: '10.0.10.1' },
    ];
    for (const body of cases) {
      const res = await request(app).post('/api/scan').set(auth()).send(body);
      expect(res.status).toBe(400);
      expect(typeof res.body.error).toBe('string');
    }
  });

  it('scans a single local host and reports it online', async () => {
    const start = await request(app)
      .post('/api/scan')
      .set(auth())
      .send({ startIp: '127.0.0.1', endIp: '127.0.0.1' });
    expect(start.status).toBe(200);
    expect(typeof start.body.scanId).toBe('string');

    let data: Record<string, unknown> = {};
    for (let i = 0; i < 60; i++) {
      const res = await request(app).get(`/api/scan/${start.body.scanId}`).set(auth());
      expect(res.status).toBe(200);
      data = res.body;
      if (data.status === 'done' || data.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 500));
    }

    expect(data.status).toBe('done');
    expect(data.total).toBe(1);
    expect(data.scannedCount).toBe(1);
    const hosts = data.hosts as { ip: string; online: boolean; ports: unknown[] }[];
    expect(hosts[0].ip).toBe('127.0.0.1');
    expect(hosts[0].online).toBe(true);
    expect(Array.isArray(hosts[0].ports)).toBe(true);
  });

  it('rejects default-range requests without a token', async () => {
    const res = await request(app).get('/api/scan/default-range');
    expect(res.status).toBe(401);
  });

  it('returns the local subnet range with a token', async () => {
    const res = await request(app).get('/api/scan/default-range').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const ipRe = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    if (res.body.startIp === null) {
      expect(res.body.endIp).toBe(null);
      return;
    }
    expect(ipRe.test(res.body.startIp)).toBe(true);
    expect(ipRe.test(res.body.endIp)).toBe(true);
    const octets = res.body.startIp.split('.').map(Number);
    const isRfc1918 =
      octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168);
    expect(isRfc1918).toBe(true);
    const toNum = (ip: string) => ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
    expect(toNum(res.body.startIp)).toBeLessThanOrEqual(toNum(res.body.endIp));
  });

  it('returns 404 for unknown scan ids', async () => {
    const res = await request(app).get('/api/scan/doesnotexist').set(auth());
    expect(res.status).toBe(404);
  });
});

describe('parseScanRange private network restriction', () => {
  it('accepts all private ranges including boundaries and link-local', () => {
    const accepted = [
      ['10.0.0.0', '10.0.0.5'],
      ['172.16.0.0', '172.16.0.5'],
      ['172.31.255.0', '172.31.255.5'],
      ['192.168.0.0', '192.168.0.5'],
      ['169.254.10.0', '169.254.10.5'],
      ['127.0.0.0', '127.0.0.5'],
    ];
    const toNum = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
    const toIp = (n: number) => [24, 16, 8, 0].map((s) => (n >> s) & 255).join('.');
    for (const [start, end] of accepted) {
      expect(parseScanRange(start, end)).toEqual([0, 1, 2, 3, 4, 5].map((i) => toIp(toNum(start) + i)));
    }
  });

  it('rejects public ranges', () => {
    const rejected = [
      ['8.8.8.0', '8.8.8.5'],
      ['1.1.1.0', '1.1.1.5'],
      ['93.184.216.0', '93.184.216.5'],
      ['172.32.0.0', '172.32.0.5'],
      ['172.15.0.0', '172.15.0.5'],
      ['192.169.0.0', '192.169.0.5'],
      ['100.64.0.0', '100.64.0.5'],
    ];
    for (const [start, end] of rejected) {
      expect(typeof parseScanRange(start, end)).toBe('string');
    }
  });

  it('rejects ranges crossing a private/public boundary', () => {
    expect(typeof parseScanRange('9.255.255.0', '10.0.0.1')).toBe('string');
  });

  it('keeps the host count limit', () => {
    expect(typeof parseScanRange('192.168.1.0', '192.168.2.255')).toBe('string');
    expect(parseScanRange('192.168.1.0', '192.168.1.255')).toHaveLength(256);
  });
});
