import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { initDb, createApp, decryptCredential, migrateLegacyCredentials } from '../server';

type Ctx = Awaited<ReturnType<typeof initDb>>;

describe('OpenHomeLab API', () => {
  let tmpDir: string;
  let ctx: Ctx;
  let app: ReturnType<typeof createApp>;
  let token: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    delete process.env.APP_ENCRYPTION_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhomelab-test-'));
    ctx = await initDb(path.join(tmpDir, 'db.sqlite'));
    app = createApp(ctx);
  });

  afterAll(async () => {
    if (ctx) await ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  describe('setup & login', () => {
    it('reports not setup initially', async () => {
      const res = await request(app).get('/api/setup/status');
      expect(res.status).toBe(200);
      expect(res.body.isSetup).toBe(false);
    });

    it('sends security headers on all responses', async () => {
      const res = await request(app).get('/api/setup/status');
      expect(String(res.headers['content-security-policy'])).toContain("default-src 'self'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-powered-by']).toBeUndefined();

      const apiError = await request(app).get('/api/devices');
      expect(apiError.status).toBe(401);
      expect(String(apiError.headers['content-security-policy'])).toContain("default-src 'self'");
    });

    it('rejects passwords shorter than 8 characters', async () => {
      const res = await request(app).post('/api/setup').send({ password: 'short' });
      expect(res.status).toBe(400);
    });

    it('creates the master password and returns a 24h token', async () => {
      const res = await request(app).post('/api/setup').send({ password: 'password123' });
      expect(res.status).toBe(200);
      expect(typeof res.body.token).toBe('string');

      const decoded = jwt.decode(res.body.token) as { iat?: number; exp?: number };
      expect(decoded.exp && decoded.iat ? (decoded.exp - decoded.iat) * 1000 : 0).toBe(24 * 60 * 60 * 1000);

      token = res.body.token;

      const status = await request(app).get('/api/setup/status');
      expect(status.body.isSetup).toBe(true);
    });

    it('rejects a second setup attempt', async () => {
      const res = await request(app).post('/api/setup').send({ password: 'password123' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/already/i);
    });

    it('rejects an invalid login password', async () => {
      const res = await request(app).post('/api/login').send({ password: 'wrongpass1' });
      expect(res.status).toBe(401);
    });

    it('accepts the correct password', async () => {
      const res = await request(app).post('/api/login').send({ password: 'password123' });
      expect(res.status).toBe(200);
      expect(typeof res.body.token).toBe('string');
    });

    it('protects API routes without a token', async () => {
      const res = await request(app).get('/api/profiles');
      expect(res.status).toBe(401);
    });

    it('rejects an invalid token', async () => {
      const res = await request(app).get('/api/profiles').set(auth('garbage.token.here'));
      expect(res.status).toBe(401);
    });
  });

  describe('change password', () => {
    it('rejects a too-short new password', async () => {
      const res = await request(app)
        .post('/api/change-password')
        .set(auth(token))
        .send({ current_password: 'password123', new_password: 'short' });
      expect(res.status).toBe(400);
    });

    it('rejects a wrong current password', async () => {
      const res = await request(app)
        .post('/api/change-password')
        .set(auth(token))
        .send({ current_password: 'nope12345', new_password: 'newpassword1' });
      expect(res.status).toBe(401);
    });

    it('changes the password and invalidates the old one', async () => {
      const res = await request(app)
        .post('/api/change-password')
        .set(auth(token))
        .send({ current_password: 'password123', new_password: 'newpassword1' });
      expect(res.status).toBe(200);

      // Fresh app instance so the shared login rate limiter does not interfere.
      const loginApp = createApp(ctx);
      const oldLogin = await request(loginApp).post('/api/login').send({ password: 'password123' });
      expect(oldLogin.status).toBe(401);

      const newLogin = await request(loginApp).post('/api/login').send({ password: 'newpassword1' });
      expect(newLogin.status).toBe(200);
      token = newLogin.body.token;
    });
  });

  describe('profiles', () => {
    it('rejects profiles without the required credential', async () => {
      const res = await request(app)
        .post('/api/profiles')
        .set(auth(token))
        .send({ name: 'P1', username: 'root', auth_type: 'password' });
      expect(res.status).toBe(400);
    });

    let profileId: number;

    it('creates a profile and encrypts the credential at rest', async () => {
      const res = await request(app)
        .post('/api/profiles')
        .set(auth(token))
        .send({
          name: 'RasPi',
          username: 'root',
          auth_type: 'password',
          password: 'secret123',
        });
      expect(res.status).toBe(200);
      profileId = res.body.id;

      const row = (await ctx.db.get('SELECT password, private_key FROM profiles WHERE id = ?', profileId)) as {
        password: string | null;
        private_key: string | null;
      };
      expect(row.password).toMatch(/^enc:v1:/);
      expect(row.password).not.toContain('secret123');
      expect(decryptCredential(row.password, ctx.encKey)).toBe('secret123');
    });

    it('never returns secrets in the profile list', async () => {
      const res = await request(app).get('/api/profiles').set(auth(token));
      expect(res.status).toBe(200);
      const profile = res.body.find((p: { id: number }) => p.id === profileId);
      expect(profile).toBeDefined();
      expect(profile.password).toBeUndefined();
      expect(profile.private_key).toBeUndefined();
    });

    it('keeps the credential when updating without a password', async () => {
      const res = await request(app)
        .put(`/api/profiles/${profileId}`)
        .set(auth(token))
        .send({ name: 'RasPi v2', username: 'admin', auth_type: 'password' });
      expect(res.status).toBe(200);

      const row = (await ctx.db.get('SELECT password, username FROM profiles WHERE id = ?', profileId)) as {
        password: string | null;
        username: string;
      };
      expect(row.username).toBe('admin');
      expect(decryptCredential(row.password, ctx.encKey)).toBe('secret123');
    });
  });

  describe('legacy credential migration', () => {
    it('encrypts plaintext credentials stored before encryption existed', async () => {
      const migCtx = await initDb(path.join(tmpDir, 'migrate.sqlite'));
      try {
        await migCtx.db.run(
          `INSERT INTO profiles (name, username, auth_type, password, private_key)
           VALUES ('Legacy', 'root', 'password', 'plain-pass', 'plain-key')`
        );
        const id = (await migCtx.db.get('SELECT MAX(id) AS id FROM profiles')) as { id: number };

        await migrateLegacyCredentials(migCtx.db, migCtx.encKey);

        const row = (await migCtx.db.get('SELECT password, private_key FROM profiles WHERE id = ?', id.id)) as {
          password: string | null;
          private_key: string | null;
        };
        expect(row.password).toMatch(/^enc:v1:/);
        expect(row.private_key).toMatch(/^enc:v1:/);
        expect(decryptCredential(row.password, migCtx.encKey)).toBe('plain-pass');
        expect(decryptCredential(row.private_key, migCtx.encKey)).toBe('plain-key');

        // Running the migration again must be a no-op (no double encryption)
        await migrateLegacyCredentials(migCtx.db, migCtx.encKey);
        const row2 = (await migCtx.db.get('SELECT password FROM profiles WHERE id = ?', id.id)) as {
          password: string | null;
        };
        expect(decryptCredential(row2.password, migCtx.encKey)).toBe('plain-pass');
      } finally {
        await migCtx.db.close();
      }
    });
  });

  describe('devices', () => {
    it('rejects devices without a name', async () => {
      const res = await request(app)
        .post('/api/devices')
        .set(auth(token))
        .send({ ip: '192.168.1.10', type: 'pc' });
      expect(res.status).toBe(400);
    });

    it('rejects invalid IPs', async () => {
      const res = await request(app)
        .post('/api/devices')
        .set(auth(token))
        .send({ name: 'Bad IP', ip: '999.1.1.1', type: 'pc' });
      expect(res.status).toBe(400);
    });

    it('rejects invalid MAC addresses', async () => {
      const res = await request(app)
        .post('/api/devices')
        .set(auth(token))
        .send({ name: 'Bad MAC', ip: '192.168.1.10', mac: 'not-a-mac', type: 'pc' });
      expect(res.status).toBe(400);
    });

    it('rejects a non-existent profile assignment', async () => {
      const res = await request(app)
        .post('/api/devices')
        .set(auth(token))
        .send({ name: 'No Profile', ip: '192.168.1.10', type: 'pc', profile_id: 9999 });
      expect(res.status).toBe(400);
    });

    let deviceId: number;

    it('creates a valid device', async () => {
      const res = await request(app)
        .post('/api/devices')
        .set(auth(token))
        .send({
          name: 'Living Room PC',
          ip: '192.168.1.10',
          mac: 'aa:bb:cc:dd:ee:ff',
          type: 'pc',
          profile_id: undefined,
          broadcast_address: '192.168.1.255',
        });
      expect(res.status).toBe(200);
      deviceId = res.body.id;
    });

    it('returns 404 when updating an unknown device', async () => {
      const res = await request(app)
        .put('/api/devices/99999')
        .set(auth(token))
        .send({ name: 'X', ip: '192.168.1.10', type: 'pc' });
      expect(res.status).toBe(404);
    });

    it('rejects an invalid command action', async () => {
      const res = await request(app)
        .post(`/api/devices/${deviceId}/command`)
        .set(auth(token))
        .send({ action: 'explode' });
      expect(res.status).toBe(400);
    });

    it('accepts every supported device type and rejects unknown ones', async () => {
      const types = ['laptop', 'router', 'switch', 'nas', 'tv', 'printer', 'phone', 'tablet', 'camera', 'console', 'audio', 'iot', 'other'];
      for (let i = 0; i < types.length; i += 1) {
        const res = await request(app)
          .post('/api/devices')
          .set(auth(token))
          .send({ name: `box ${types[i]}`, ip: `10.9.${Math.floor(i / 250)}.${(i % 250) + 10}`, type: types[i] });
        expect(res.status).toBe(200);
      }
      const bad = await request(app)
        .post('/api/devices')
        .set(auth(token))
        .send({ name: 'Toaster', ip: '10.9.0.5', type: 'toaster' });
      expect(bad.status).toBe(400);
    });

    it('persists and updates the hostname', async () => {
      const created = await request(app)
        .post('/api/devices')
        .set(auth(token))
        .send({ name: 'Host Box', ip: '10.9.1.50', type: 'server', hostname: 'host-box.local' });
      expect(created.status).toBe(200);

      const list = await request(app).get('/api/devices').set(auth(token));
      const found = (list.body as { id: number; hostname: string | null }[]).find((d) => d.id === created.body.id);
      expect(found?.hostname).toBe('host-box.local');

      const updated = await request(app)
        .put(`/api/devices/${created.body.id}`)
        .set(auth(token))
        .send({ name: 'Host Box', ip: '10.9.1.50', type: 'server', hostname: 'renamed.host' });
      expect(updated.status).toBe(200);

      const list2 = await request(app).get('/api/devices/active').set(auth(token));
      const found2 = (list2.body as { id: number; hostname: string | null }[]).find((d) => d.id === created.body.id);
      expect(found2?.hostname).toBe('renamed.host');

      const cleared = await request(app)
        .put(`/api/devices/${created.body.id}`)
        .set(auth(token))
        .send({ name: 'Host Box', ip: '10.9.1.50', type: 'server', hostname: '' });
      expect(cleared.status).toBe(200);

      const list3 = await request(app).get('/api/devices').set(auth(token));
      const found3 = (list3.body as { id: number; hostname: string | null }[]).find((d) => d.id === created.body.id);
      expect(found3?.hostname).toBeNull();
    });

    it('rejects invalid hostnames', async () => {
      for (const bad of ['bad host', '-leading', 'trailing-', `a${'b'.repeat(120)}`]) {
        const res = await request(app)
          .post('/api/devices')
          .set(auth(token))
          .send({ name: 'H', ip: '10.9.1.60', type: 'pc', hostname: bad });
        expect(res.status).toBe(400);
      }
    });
  });

  describe('unknown API routes', () => {
    it('returns a JSON 404', async () => {
      const res = await request(app).get('/api/nope').set(auth(token));
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });
  });

  describe('login rate limiting', () => {
    it('blocks the 6th failed attempt within the window', async () => {
      const limiterCtx = await initDb(path.join(tmpDir, 'limiter.sqlite'));
      // Seed a known master password directly so failures return 401 (not 400 "Not setup")
      const hash = await bcrypt.hash('some-password-123', 10);
      await limiterCtx.db.run('UPDATE settings SET master_password_hash = ? WHERE id = 1', [hash]);
      const limiterApp = createApp(limiterCtx);

      for (let i = 0; i < 5; i += 1) {
        const res = await request(limiterApp).post('/api/login').send({ password: 'bad' });
        expect(res.status).toBe(401);
      }
      const blocked = await request(limiterApp).post('/api/login').send({ password: 'bad' });
      expect(blocked.status).toBe(429);

      await limiterCtx.db.close();
    });
  });

  describe('data export / import', () => {
    it('exports devices and profiles as JSON', async () => {
      // Create a profile and a device linked to it
      const createProf = await request(app)
        .post('/api/profiles')
        .set(auth(token))
        .send({ name: 'Export-Test', username: 'admin', auth_type: 'password', password: 'testpass123' });
      expect(createProf.status).toBe(200);
      const profId = createProf.body.id;

      await request(app)
        .post('/api/devices')
        .set(auth(token))
        .send({ name: 'Export-Device', ip: '10.0.0.1', type: 'pc', profile_id: profId });

      const res = await request(app).get('/api/data/export').set(auth(token));
      expect(res.status).toBe(200);
      expect(res.body.devices.length).toBeGreaterThan(0);
      expect(res.body.profiles.length).toBeGreaterThan(0);

      // Check device fields
      const dev = res.body.devices.find((d: any) => d.name === 'Export-Device');
      expect(dev).toBeDefined();
      expect(dev.ip).toBe('10.0.0.1');
      expect(dev.type).toBe('pc');
      expect(dev.profile_id).toBe(profId);
      // Has agent_token is excluded from export
      expect(dev.has_agent_token).toBeUndefined();
    });

    it('import rejects empty payload', async () => {
      const res = await request(app)
        .post('/api/data/import')
        .set(auth(token))
        .send({});
      expect(res.status).toBe(400);
    });

    it('imports profiles and devices (full round-trip)', async () => {
      // Clean slate: remove previous test data
      await ctx.db.run('DELETE FROM metrics_daily WHERE device_id IN (SELECT id FROM devices)');
      await ctx.db.run('DELETE FROM metrics_hourly WHERE device_id IN (SELECT id FROM devices)');
      await ctx.db.run('DELETE FROM metrics_raw WHERE device_id IN (SELECT id FROM devices)');
      await ctx.db.run('DELETE FROM metrics_live WHERE device_id IN (SELECT id FROM devices)');

      // Create known profile and device
      const createProf = await request(app)
        .post('/api/profiles')
        .set(auth(token))
        .send({ name: 'RoundTrip', username: 'root', auth_type: 'password', password: 'mysecret' });
      expect(createProf.status).toBe(200);
      const profId = createProf.body.id;

      await request(app)
        .post('/api/devices')
        .set(auth(token))
        .send({ name: 'RT-Device', ip: '172.16.0.99', type: 'server', profile_id: profId, active: 0 });

      // Export then immediately import back (with the same data)
      const exportRes = await request(app).get('/api/data/export').set(auth(token));
      expect(exportRes.status).toBe(200);

      const importRes = await request(app)
        .post('/api/data/import')
        .set(auth(token))
        .send({ devices: exportRes.body.devices, profiles: exportRes.body.profiles });
      expect(importRes.status).toBe(200);

      // Verify device count unchanged (upsert replaced rather than duplicated)
      const profileCountBefore = await ctx.db.get('SELECT COUNT(*) AS cnt FROM profiles');
      const deviceCountBefore = await ctx.db.get('SELECT COUNT(*) AS cnt FROM devices');

      // Re-import the original export data — counts should be identical
      const importRes2 = await request(app)
        .post('/api/data/import')
        .set(auth(token))
        .send({ devices: exportRes.body.devices, profiles: exportRes.body.profiles });
      expect(importRes2.status).toBe(200);

      const profileCountAfter = await ctx.db.get('SELECT COUNT(*) AS cnt FROM profiles');
      const deviceCountAfter = await ctx.db.get('SELECT COUNT(*) AS cnt FROM devices');

      expect(Number(profileCountBefore.cnt)).toBe(Number(profileCountAfter.cnt));
      expect(Number(deviceCountBefore.cnt)).toBe(Number(deviceCountAfter.cnt));
    });

    it('responds to a successful import with { success: true }', async () => {
      const res = await request(app)
        .post('/api/data/import')
        .set(auth(token))
        .send({
          profiles: [{ id: 950, name: 'ContractProf', username: 'contract', auth_type: 'password', password: 'cpw123' }],
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('rejects import when a device references a profile_id absent from the payload', async () => {
      // Create a profile and device outside the import payload
      const createProf = await request(app)
        .post('/api/profiles')
        .set(auth(token))
        .send({ name: 'OrphanProf', username: 'orphan', auth_type: 'password', password: 'x' });
      expect(createProf.status).toBe(200);
      const orphanId = createProf.body.id;

      await request(app)
        .post('/api/devices')
        .set(auth(token))
        .send({ name: 'OrphanDevice', ip: '192.168.9.9', type: 'pc', profile_id: orphanId });

      // Import payload only contains a different profile (no orphanId)
      const res = await request(app)
        .post('/api/data/import')
        .set(auth(token))
        .send({
          devices: [{ id: 900, name: 'OrphanDevice', ip: '192.168.9.9', type: 'pc', profile_id: orphanId }],
          profiles: [{ id: 800, name: 'NewProf', username: 'new', auth_type: 'password', password: 'pw' }],
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('profile_id');
    });

    it('rejects import when a device has an out-of-range base_power_w', async () => {
      for (const value of [-5, 99999, 'abc']) {
        const res = await request(app)
          .post('/api/data/import')
          .set(auth(token))
          .send({ devices: [{ id: 901, name: 'BadBase', ip: '10.1.1.1', type: 'pc', base_power_w: value }] });
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('base_power_w');
      }
    });

    it('rejects oversized bodies on regular routes but accepts large imports', async () => {
      const padding = 'x'.repeat(300 * 1024);
      const rejected = await request(app)
        .post('/api/devices')
        .set(auth(token))
        .send({ name: 'BigDevice', ip: '192.168.5.5', type: 'pc', padding });
      expect(rejected.status).toBe(413);

      const imported = await request(app)
        .post('/api/data/import')
        .set(auth(token))
        .send({ devices: [{ id: 902, name: 'BigImport', ip: '192.168.5.6', type: 'pc', padding }] });
      expect(imported.status).not.toBe(413);
    });
  });
});
