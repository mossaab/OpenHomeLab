import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { initDb, createApp, attachTerminalWs } from '../server';

type Ctx = Awaited<ReturnType<typeof initDb>>;

describe('Power actions: settings + per-device overrides', () => {
  let tmpDir: string;
  let ctx: Ctx;
  let app: ReturnType<typeof createApp>;
  let token: string;
  let plainId: number;

  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    delete process.env.APP_ENCRYPTION_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhomelab-power-'));
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

  describe('PUT /api/settings action parameters', () => {
    it('returns the defaults on a fresh database', async () => {
      const res = await request(app).get('/api/settings').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.poweroff_action).toBe('poweroff');
      expect(res.body.reboot_action).toBe('reboot');
      expect(res.body.hibernate_action).toBe('systemctl hibernate');
    });

    it('rejects an invalid poweroff_action with 400', async () => {
      const res = await request(app).put('/api/settings').set(auth()).send({ poweroff_action: 'shutdown -h now' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('poweroff_action');
    });

    it('rejects an invalid reboot_action with 400', async () => {
      const res = await request(app).put('/api/settings').set(auth()).send({ reboot_action: 'init 6' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('reboot_action');
    });

    it('rejects an invalid hibernate_action with 400', async () => {
      const res = await request(app).put('/api/settings').set(auth()).send({ hibernate_action: 'echo nope' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('hibernate_action');
    });

    it('persists valid values and leaves the others untouched', async () => {
      const res = await request(app)
        .put('/api/settings')
        .set(auth())
        .send({ poweroff_action: 'systemctl suspend', reboot_action: 'systemctl reboot' });
      expect(res.status).toBe(200);
      expect(res.body.poweroff_action).toBe('systemctl suspend');
      expect(res.body.reboot_action).toBe('systemctl reboot');
      expect(res.body.hibernate_action).toBe('systemctl hibernate');

      const got = await request(app).get('/api/settings').set(auth());
      expect(got.body.poweroff_action).toBe('systemctl suspend');
      expect(got.body.reboot_action).toBe('systemctl reboot');
      expect(got.body.hibernate_action).toBe('systemctl hibernate');
    });
  });

  describe('per-device overrides', () => {
    let deviceId: number;

    it('round-trips the three overrides and disable flags via POST', async () => {
      const res = await request(app)
        .post('/api/devices')
        .set(auth())
        .send({
          name: 'Override Box',
          ip: '192.168.1.50',
          type: 'server',
          poweroff_action: 'poweroff',
          reboot_action: 'systemctl reboot',
          hibernate_action: 'systemctl hibernate',
          disable_power: true,
          disable_ping: 0,
          disable_terminal: true,
          disable_agent_update: false,
        });
      expect(res.status).toBe(200);
      deviceId = res.body.id;

      const got = await request(app).get('/api/devices').set(auth());
      const device = got.body.find((d: { id: number }) => d.id === deviceId);
      expect(device.poweroff_action).toBe('poweroff');
      expect(device.reboot_action).toBe('systemctl reboot');
      expect(device.hibernate_action).toBe('systemctl hibernate');
      expect(device.disable_power).toBe(1);
      expect(device.disable_ping).toBe(0);
      expect(device.disable_terminal).toBe(1);
      expect(device.disable_agent_update).toBe(0);
    });

    it('rejects an invalid override value with 400', async () => {
      const res = await request(app)
        .post('/api/devices')
        .set(auth())
        .send({ name: 'Bad Override', ip: '192.168.1.51', type: 'pc', poweroff_action: 'echo boom' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('poweroff_action');
    });

    it('rejects a non-boolean disable flag with 400', async () => {
      const res = await request(app)
        .post('/api/devices')
        .set(auth())
        .send({ name: 'Bad Flag', ip: '192.168.1.52', type: 'pc', disable_ping: 'yes' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('disable_ping');
    });

    it('treats an empty string as no override (null)', async () => {
      const res = await request(app)
        .put(`/api/devices/${deviceId}`)
        .set(auth())
        .send({
          name: 'Override Box',
          ip: '192.168.1.50',
          type: 'server',
          poweroff_action: '',
          reboot_action: '',
          hibernate_action: '',
        });
      expect(res.status).toBe(200);

      const got = await request(app).get('/api/devices').set(auth());
      const device = got.body.find((d: { id: number }) => d.id === deviceId);
      expect(device.poweroff_action ?? null).toBeNull();
      expect(device.reboot_action ?? null).toBeNull();
      expect(device.hibernate_action ?? null).toBeNull();
    });

    it('round-trips overrides via PUT', async () => {
      const res = await request(app)
        .put(`/api/devices/${deviceId}`)
        .set(auth())
        .send({
          name: 'Override Box',
          ip: '192.168.1.50',
          type: 'server',
          poweroff_action: 'systemctl suspend',
          reboot_action: 'reboot',
          hibernate_action: '',
        });
      expect(res.status).toBe(200);

      const got = await request(app).get('/api/devices').set(auth());
      const device = got.body.find((d: { id: number }) => d.id === deviceId);
      expect(device.poweroff_action).toBe('systemctl suspend');
      expect(device.reboot_action).toBe('reboot');
      expect(device.hibernate_action ?? null).toBeNull();
    });
  });

  describe('executePowerAction resolution order', () => {
    let overriddenId: number;
    let overriddenAgentToken: string;
    let plainAgentToken: string;

    const pushStats = (agentTokenValue: string) =>
      request(app)
        .post('/api/agent/stats')
        .set('Authorization', `Bearer ${agentTokenValue}`)
        .send({ hostname: 'powerhost', cpu: 30, mem_total: 8_000_000_000, mem_used: 4_000_000_000 });

    beforeAll(async () => {
      const putSettings = await request(app)
        .put('/api/settings')
        .set(auth())
        .send({ poweroff_action: 'systemctl suspend', reboot_action: 'systemctl reboot' });
      expect(putSettings.status).toBe(200);

      const dev1 = await request(app)
        .post('/api/devices')
        .set(auth())
        .send({ name: 'Overridden', ip: '192.168.1.60', type: 'server', poweroff_action: 'poweroff', reboot_action: 'reboot' });
      overriddenId = dev1.body.id;
      const tok1 = await request(app).post(`/api/devices/${overriddenId}/agent/token`).set(auth());
      overriddenAgentToken = tok1.body.token;

      const dev2 = await request(app)
        .post('/api/devices')
        .set(auth())
        .send({ name: 'Plain', ip: '192.168.1.61', type: 'server' });
      plainId = dev2.body.id;
      const tok2 = await request(app).post(`/api/devices/${plainId}/agent/token`).set(auth());
      plainAgentToken = tok2.body.token;

      expect((await pushStats(overriddenAgentToken)).status).toBe(200);
      expect((await pushStats(plainAgentToken)).status).toBe(200);
    });

    const latestCommand = async (deviceId: number, action: string) => {
      const row = (await ctx.db.get(
        `SELECT command FROM device_actions WHERE device_id = ? AND action = ? ORDER BY id DESC LIMIT 1`,
        [deviceId, action],
      )) as { command: string | null } | undefined;
      return row?.command ?? null;
    };

    it('uses the device override over the global setting on the agent channel', async () => {
      const res = await request(app)
        .post(`/api/devices/${overriddenId}/command`)
        .set(auth())
        .send({ action: 'shutdown' });
      expect(res.status).toBe(200);
      expect(res.body.channel).toBe('agent');
      expect(await latestCommand(overriddenId, 'shutdown')).toBe('poweroff');

      const rebootRes = await request(app)
        .post(`/api/devices/${overriddenId}/command`)
        .set(auth())
        .send({ action: 'reboot' });
      expect(rebootRes.status).toBe(200);
      expect(await latestCommand(overriddenId, 'reboot')).toBe('reboot');
    });

    it('falls back to the global setting when the device has no override', async () => {
      const res = await request(app)
        .post(`/api/devices/${plainId}/command`)
        .set(auth())
        .send({ action: 'shutdown' });
      expect(res.status).toBe(200);
      expect(res.body.channel).toBe('agent');
      expect(await latestCommand(plainId, 'shutdown')).toBe('systemctl suspend');

      const hibernateRes = await request(app)
        .post(`/api/devices/${plainId}/command`)
        .set(auth())
        .send({ action: 'hibernate' });
      expect(hibernateRes.status).toBe(200);
      expect(await latestCommand(plainId, 'hibernate')).toBe('systemctl hibernate');
    });
  });

  describe('server-side disable-flag guards', () => {
    let powerBlockedId: number;
    let pingBlockedId: number;
    let updateBlockedId: number;
    let updateAgentToken: string;

    const pushStats = (agentTokenValue: string) =>
      request(app)
        .post('/api/agent/stats')
        .set('Authorization', `Bearer ${agentTokenValue}`)
        .send({ hostname: 'guardhost', cpu: 10, mem_total: 8_000_000_000, mem_used: 2_000_000_000 });

    beforeAll(async () => {
      const p = await request(app)
        .post('/api/devices')
        .set(auth())
        .send({ name: 'Power Blocked', ip: '192.168.1.70', mac: 'aa:bb:cc:dd:ee:01', type: 'server', disable_power: true });
      powerBlockedId = p.body.id;

      const g = await request(app)
        .post('/api/devices')
        .set(auth())
        .send({ name: 'Ping Blocked', ip: '192.168.1.71', type: 'pc', disable_ping: true });
      pingBlockedId = g.body.id;

      const u = await request(app)
        .post('/api/devices')
        .set(auth())
        .send({ name: 'Update Blocked', ip: '192.168.1.72', type: 'server', disable_agent_update: true });
      updateBlockedId = u.body.id;
      const tok = await request(app).post(`/api/devices/${updateBlockedId}/agent/token`).set(auth());
      updateAgentToken = tok.body.token;
      expect((await pushStats(updateAgentToken)).status).toBe(200);
    });

    it.each(['reboot', 'shutdown', 'hibernate'] as const)(
      'rejects the %s command with 403 when disable_power is set',
      async (action) => {
        const res = await request(app).post(`/api/devices/${powerBlockedId}/command`).set(auth()).send({ action });
        expect(res.status).toBe(403);
        expect(res.body.error).toContain('disabled');
      }
    );

    it('rejects WOL with 403 when disable_power is set', async () => {
      const res = await request(app).post(`/api/devices/${powerBlockedId}/wake`).set(auth());
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('disabled');
    });

    it('rejects ping with 403 when disable_ping is set', async () => {
      const res = await request(app).post(`/api/devices/${pingBlockedId}/ping`).set(auth());
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('disabled');
    });

    it('rejects an agent update with 403 when disable_agent_update is set', async () => {
      const res = await request(app)
        .post(`/api/devices/${updateBlockedId}/command`)
        .set(auth())
        .send({ action: 'update' });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('disabled');
    });

    it('skips disabled devices in the bulk agent update and reports the count', async () => {
      const res = await request(app).post('/api/devices/agents/update').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.disabled).toBeGreaterThanOrEqual(1);

      const row = (await ctx.db.get(
        `SELECT action FROM device_actions WHERE device_id = ? ORDER BY id DESC LIMIT 1`,
        [updateBlockedId]
      )) as { action: string } | undefined;
      expect(row?.action).not.toBe('update');
    });

    it('still allows actions on devices without the flags', async () => {
      const res = await request(app).post(`/api/devices/${plainId}/command`).set(auth()).send({ action: 'hibernate' });
      expect(res.status).toBe(200);
    });

    describe('external machine API propagation', () => {
      let apiToken: string;

      beforeAll(async () => {
        const created = await request(app)
          .post('/api/api-tokens')
          .set(auth())
          .send({ label: 'guard-bot', permissions: ['start', 'stop', 'restart'], device_ids: [powerBlockedId] });
        expect(created.status).toBe(200);
        apiToken = created.body.token;
      });

      it.each(['start', 'stop', 'restart'] as const)('returns 403 on /api/machines/:id/%s', async (op) => {
        const res = await request(app).post(`/api/machines/${powerBlockedId}/${op}`).set({ Authorization: `Bearer ${apiToken}` });
        expect(res.status).toBe(403);
        expect(res.body.error).toContain('disabled');
      });
    });

    describe('terminal WebSocket', () => {
      let server: http.Server;
      let port: number;

      beforeAll(async () => {
        server = http.createServer(app);
        attachTerminalWs(server, ctx);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = (server.address() as AddressInfo).port;
      });

      afterAll(async () => {
        server.close();
      });

      it('closes with 4403 when disable_terminal is set on a device target', async () => {
        const t = await request(app)
          .post('/api/devices')
          .set(auth())
          .send({ name: 'Terminal Blocked', ip: '192.168.1.73', type: 'server', disable_terminal: true });
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws?token=${token}&target=device&deviceId=${t.body.id}`);
        const code = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timed out waiting for close')), 5_000);
          ws.on('close', (c: number) => {
            clearTimeout(timer);
            resolve(c);
          });
        });
        expect(code).toBe(4403);
      });
    });
  });
});

describe('legacy profile command migration', () => {
  let tmpDir: string;
  let ctx: Ctx;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    delete process.env.APP_ENCRYPTION_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhomelab-power-mig-'));
    const dbPath = path.join(tmpDir, 'db.sqlite');

    const legacy = await open({ filename: dbPath, driver: sqlite3.Database });
    await legacy.exec(`
      CREATE TABLE profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, username TEXT NOT NULL, auth_type TEXT NOT NULL,
        password TEXT, private_key TEXT, reboot_command TEXT, shutdown_command TEXT, hibernate_command TEXT
      );
      CREATE TABLE devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ip TEXT NOT NULL, mac TEXT, hostname TEXT, type TEXT,
        profile_id INTEGER, broadcast_address TEXT, active INTEGER DEFAULT 1, agent_token TEXT, base_power_w REAL,
        interfaces TEXT, group_id INTEGER, position INTEGER NOT NULL DEFAULT 0,
        poweroff_action TEXT, reboot_action TEXT, hibernate_action TEXT
      );
    `);
    await legacy.run(
      "INSERT INTO profiles (name, username, auth_type, reboot_command, shutdown_command, hibernate_command) VALUES ('p1', 'root', 'password', 'reboot', 'poweroff', 'systemctl hibernate')"
    );
    await legacy.run(
      "INSERT INTO profiles (name, username, auth_type, reboot_command, shutdown_command, hibernate_command) VALUES ('p2', 'root', 'password', 'sudo -n reboot || reboot', 'shutdown -h now', NULL)"
    );
    await legacy.run("INSERT INTO devices (name, ip, profile_id) VALUES ('d1', '192.168.1.10', 1)");
    await legacy.run("INSERT INTO devices (name, ip, profile_id) VALUES ('d2', '192.168.1.11', 2)");
    await legacy.run(
      "INSERT INTO devices (name, ip, profile_id, poweroff_action) VALUES ('d3', '192.168.1.12', 1, 'systemctl suspend')"
    );
    await legacy.close();

    ctx = await initDb(dbPath);
  });

  afterAll(async () => {
    if (ctx) await ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copies representable profile commands onto devices without an explicit override', async () => {
    const d1 = (await ctx.db.get('SELECT poweroff_action, reboot_action, hibernate_action FROM devices WHERE id = 1')) as {
      poweroff_action: string | null;
      reboot_action: string | null;
      hibernate_action: string | null;
    };
    expect(d1.poweroff_action).toBe('poweroff');
    expect(d1.reboot_action).toBe('reboot');
    expect(d1.hibernate_action).toBe('systemctl hibernate');
  });

  it('leaves non-representable profile commands unmigrated', async () => {
    const d2 = (await ctx.db.get('SELECT poweroff_action, reboot_action, hibernate_action FROM devices WHERE id = 2')) as {
      poweroff_action: string | null;
      reboot_action: string | null;
      hibernate_action: string | null;
    };
    expect(d2.poweroff_action ?? null).toBeNull();
    expect(d2.reboot_action ?? null).toBeNull();
    expect(d2.hibernate_action ?? null).toBeNull();
  });

  it('never overwrites an existing device override', async () => {
    const d3 = (await ctx.db.get('SELECT poweroff_action FROM devices WHERE id = 3')) as { poweroff_action: string | null };
    expect(d3.poweroff_action).toBe('systemctl suspend');
  });

  it('drops the legacy profile command columns', async () => {
    const cols = (await ctx.db.all('PRAGMA table_info(profiles)')) as { name: string }[];
    for (const name of ['reboot_command', 'shutdown_command', 'hibernate_command']) {
      expect(cols.find((c) => c.name === name)).toBeUndefined();
    }
  });
});
