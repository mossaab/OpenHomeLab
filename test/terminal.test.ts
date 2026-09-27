import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';
import http from 'http';
import { WebSocket } from 'ws';
import { initDb, createApp, attachTerminalWs, encryptCredential } from '../server';

type Ctx = Awaited<ReturnType<typeof initDb>>;

describe('Terminal WebSocket', () => {
  let tmpDir: string;
  let ctx: Ctx;
  let server: http.Server;
  let baseUrl: string;
  let token: string;
  let profileId: number;
  let deviceId: number;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    delete process.env.APP_ENCRYPTION_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhomelab-terminal-test-'));
    ctx = await initDb(path.join(tmpDir, 'db.sqlite'));

    const res = await ctx.db.run(
      `INSERT INTO profiles (name, username, auth_type, private_key) VALUES ('Host profile', 'root', 'key', ?)`,
      encryptCredential('FAKE_KEY_MATERIAL', ctx.encKey)
    );
    profileId = Number((res as { lastID: number }).lastID);

    const devRes = await ctx.db.run(`INSERT INTO devices (name, ip) VALUES ('no-profile', '192.0.2.10')`);
    deviceId = Number((devRes as { lastID: number }).lastID);

    token = jwt.sign({ id: 1 }, ctx.jwtSecret);

    const app = createApp(ctx);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
    attachTerminalWs(server, ctx);
  });

  afterAll(async () => {
    server?.close();
    if (ctx) await ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const openWs = (params: Record<string, string | null> = {}): Promise<{ code: number; reason: string }> =>
    new Promise((resolve) => {
      const query = Object.entries(params)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
        .join('&');
      const ws = new WebSocket(`${baseUrl}/api/terminal/ws${query ? `?${query}` : ''}`);
      ws.on('close', (code, rawReason) => resolve({ code, reason: rawReason.toString() }));
    });

  it('closes with 4001 when no token is provided', async () => {
    const res = await openWs();
    expect(res.code).toBe(4001);
  });

  it('closes with 4001 on an invalid token', async () => {
    const res = await openWs({ token: 'bogus.token.here' });
    expect(res.code).toBe(4001);
  });

  it('rejects an unknown device with 4004', async () => {
    const res = await openWs({ token, target: 'device', deviceId: '99999' });
    expect(res.code).toBe(4004);
    expect(res.reason).toMatch(/not found/i);
  });

  it('asks for a profile when the device has none and no profileId is given', async () => {
    const res = await openWs({ token, target: 'device', deviceId: String(deviceId) });
    expect(res.code).toBe(4003);
    expect(res.reason).toMatch(/profile/i);
  });

  it('asks for a profile to open the host terminal', async () => {
    const res = await openWs({ token, target: 'host' });
    expect(res.code).toBe(4002);
    expect(res.reason).toMatch(/profile/i);
  });

  it('rejects an unknown profileId', async () => {
    const res = await openWs({ token, target: 'device', deviceId: String(deviceId), profileId: '99999' });
    expect(res.code).toBe(4004);
    expect(res.reason).toMatch(/profile/i);
  });

  it('rejects an unknown target', async () => {
    const res = await openWs({ token, target: 'lantern' });
    expect(res.code).toBe(4002);
  });

  it('rejects an invalid ip for the ip target with 4002', async () => {
    const res = await openWs({ token, target: 'ip', ip: 'not-an-ip', profileId: String(profileId) });
    expect(res.code).toBe(4002);
    expect(res.reason).toMatch(/ipv4/i);
  });

  it('rejects an IPv6 address for the ip target with 4002', async () => {
    const res = await openWs({ token, target: 'ip', ip: '::1', profileId: String(profileId) });
    expect(res.code).toBe(4002);
    expect(res.reason).toMatch(/ipv4/i);
  });

  it('asks for a profile when opening the ip terminal without one', async () => {
    const res = await openWs({ token, target: 'ip', ip: '192.0.2.50' });
    expect(res.code).toBe(4003);
    expect(res.reason).toMatch(/profile/i);
  });

  it('rejects an unknown profileId for the ip target', async () => {
    const res = await openWs({ token, target: 'ip', ip: '192.0.2.50', profileId: '99999' });
    expect(res.code).toBe(4004);
    expect(res.reason).toMatch(/profile/i);
  });

  it('uses the selected profile for the ip target and reports SSH failures', async () => {
    const res = await openWs({ token, target: 'ip', ip: '192.0.2.50', profileId: String(profileId) });
    expect(res.code).toBe(4501);
  }, 30_000);

  it('uses the selected profile for a device without one and reports SSH failures', async () => {
    const res = await openWs({ token, target: 'device', deviceId: String(deviceId), profileId: String(profileId) });
    expect(res.code).toBe(4501);
  }, 30_000);
});
