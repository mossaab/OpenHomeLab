import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { execSync } from 'node:child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { initDb, createApp, sanitizeAgentPayload, computeEnergyBreakdown } from '../server';

type Ctx = Awaited<ReturnType<typeof initDb>>;

describe('Data refresh intervals', () => {
  let tmpDir: string;
  let ctx: Ctx;
  let app: ReturnType<typeof createApp>;
  let token: string;
  let deviceId: number;
  let agentToken: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    delete process.env.APP_ENCRYPTION_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhomelab-refresh-'));
    ctx = await initDb(path.join(tmpDir, 'db.sqlite'));

    const hash = await bcrypt.hash('password123', 10);
    await ctx.db.run('UPDATE settings SET master_password_hash = ? WHERE id = 1', [hash]);
    token = jwt.sign({ id: 1 }, ctx.jwtSecret, { expiresIn: '24h' });

    app = createApp(ctx);

    const res = await request(app)
      .post('/api/devices')
      .set(auth())
      .send({ name: 'Refresh Box', ip: '192.168.1.71', type: 'server' });
    deviceId = res.body.id;

    const tok = await request(app).post(`/api/devices/${deviceId}/agent/token`).set(auth());
    agentToken = tok.body.token;
  });

  afterAll(async () => {
    if (ctx) await ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function putSettings(body: Record<string, unknown>) {
    return request(app).put('/api/settings').set(auth()).send(body);
  }

  describe('settings round-trip', () => {
    it('exposes defaults of 30s for both intervals', async () => {
      const res = await request(app).get('/api/settings').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.agent_interval_seconds).toBe(30);
      expect(res.body.ui_refresh_seconds).toBe(30);
    });

    it('rejects out-of-range, non-integer and missing-interval values', async () => {
      const bad = [
        { agent_interval_seconds: 4 },
        { agent_interval_seconds: 'abc' },
        { agent_interval_seconds: 99999 },
        { agent_interval_seconds: 2.5 },
        { ui_refresh_seconds: -1 },
        { ui_refresh_seconds: 0 },
        { ui_refresh_seconds: true },
      ];
      for (const body of bad) {
        const res = await putSettings(body);
        expect(res.status).toBe(400);
        expect(typeof res.body.error).toBe('string');
      }
      const after = await request(app).get('/api/settings').set(auth());
      expect(after.body.agent_interval_seconds).toBe(30);
      expect(after.body.ui_refresh_seconds).toBe(30);
    });

    it('accepts valid values and echoes them', async () => {
      const res = await putSettings({ agent_interval_seconds: 45, ui_refresh_seconds: 10 });
      expect(res.status).toBe(200);
      expect(res.body.agent_interval_seconds).toBe(45);
      expect(res.body.ui_refresh_seconds).toBe(10);

      const check = await request(app).get('/api/settings').set(auth());
      expect(check.body.agent_interval_seconds).toBe(45);
      expect(check.body.ui_refresh_seconds).toBe(10);
    });

    it('supports partial updates', async () => {
      const res = await putSettings({ ui_refresh_seconds: 20 });
      expect(res.status).toBe(200);
      expect(res.body.agent_interval_seconds).toBe(45);
      expect(res.body.ui_refresh_seconds).toBe(20);

      const cost = await putSettings({ cost_per_kwh: 0.3, agent_interval_seconds: '60' });
      expect(cost.status).toBe(200);
      expect(cost.body.agent_interval_seconds).toBe(60);
      expect(cost.body.ui_refresh_seconds).toBe(20);
      expect(cost.body.cost_per_kwh).toBe(0.3);

      await putSettings({ agent_interval_seconds: 45, ui_refresh_seconds: 10 });
    });
  });

  describe('agent installer', () => {
    it('is served dynamically with the configured interval', async () => {
      await putSettings({ agent_interval_seconds: 45, ui_refresh_seconds: 10 });
      const res = await request(app).get('/api/agent/install');
      expect(res.status).toBe(200);
      const body = res.text;
      expect(body).toContain('INTERVAL=45');
      expect(body).not.toMatch(/(^|\n)INTERVAL=30($|\n)/);
      expect(body).not.toContain('__AGENT_INTERVAL__');
      expect(body).toContain('\\"interval\\":$INTERVAL,');
      expect(body).toContain('/api/agent/config');
    });

    it('falls back to defaults when no interval is stored', async () => {
      await ctx.db.run('UPDATE settings SET agent_interval_seconds = NULL WHERE id = 1');
      const res = await request(app).get('/api/agent/install');
      expect(res.text).toContain('INTERVAL=30');
    });

    it('escalates via sudo when not run as root and keeps script-based self-update', async () => {
      const res = await request(app).get('/api/agent/install');
      expect(res.status).toBe(200);
      const body = res.text;
      expect(body).toContain('[ "$(id -u)" -ne 0 ]');
      expect(body).toContain("exec sudo sh -c 'curl -fsS \"$0/api/agent/install\" | sh -s -- \"$0\" \"$1\"'");
      expect(body).toContain('/api/agent/script');
      expect(body).not.toContain('__AGENT_SCRIPT__');
    });
  });

  describe('GET /api/agent/script', () => {
    it('requires a valid agent token', async () => {
      const none = await request(app).get('/api/agent/script');
      expect(none.status).toBe(401);
      const ui = await request(app).get('/api/agent/script').set(auth());
      expect(ui.status).toBe(401);
    });

    it('serves a runnable agent script, not the installer', async () => {
      await putSettings({ agent_interval_seconds: 45, ui_refresh_seconds: 10 });
      const res = await request(app)
        .get('/api/agent/script')
        .set('Authorization', `Bearer ${agentToken}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      const body = res.text;
      expect(body.startsWith('#!/bin/sh')).toBe(true);
      expect(body).toContain('OpenHomeLab agent - pushes system metrics');
      expect(body).not.toContain('Usage: sh install.sh');
      expect(body).toContain('while :; do');
      expect(body).toContain('sync_interval');
      expect(body).toContain('\\"interval\\":$INTERVAL,');
      expect(body).toContain('INTERVAL=45');

      const scriptPath = path.join(tmpDir, 'agent-script.sh');
      fs.writeFileSync(scriptPath, body);
      execSync(`sh -n "${scriptPath}"`);
    });
  });

  describe('GET /api/agent/config', () => {
    it('rejects requests without a valid agent token', async () => {
      const none = await request(app).get('/api/agent/config');
      expect(none.status).toBe(401);
      const uiToken = await request(app).get('/api/agent/config').set(auth());
      expect(uiToken.status).toBe(401);
    });

    it('returns the configured interval for a known device', async () => {
      await putSettings({ agent_interval_seconds: 45, ui_refresh_seconds: 10 });
      const res = await request(app)
        .get('/api/agent/config')
        .set('Authorization', `Bearer ${agentToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, interval: 45, active: true });
    });
  });

  describe('reported interval in stats', () => {
    it('exposes the pushed interval via stats/all and live', async () => {
      const push = await request(app)
        .post('/api/agent/stats')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ hostname: 'refreshbox', cpu: 12, mem_total: 8_000_000_000, mem_used: 4_000_000_000, interval: 45 });
      expect(push.status).toBe(200);

      const all = await request(app).get('/api/devices/stats/all').set(auth());
      expect(all.body[String(deviceId)].agent_interval).toBe(45);

      const live = await request(app).get(`/api/devices/${deviceId}/stats/live`).set(auth());
      expect(live.body.live.interval).toBe(45);
    });
  });

  describe('sanitizeAgentPayload interval clamping', () => {
    it('keeps valid integer intervals', async () => {
      expect(sanitizeAgentPayload({ cpu: 1, interval: 60 }, Date.now())?.interval).toBe(60);
      expect(sanitizeAgentPayload({ cpu: 1, interval: 1 }, Date.now())?.interval).toBe(1);
      expect(sanitizeAgentPayload({ cpu: 1, interval: 86400 }, Date.now())?.interval).toBe(86400);
    });

    it('nulls out-of-range or non-integer intervals', async () => {
      for (const value of [0, -5, 100000, 2.5, 'abc', null]) {
        const snap = sanitizeAgentPayload({ cpu: 1, interval: value }, Date.now());
        expect(snap).not.toBeNull();
        expect(snap?.interval).toBeNull();
      }
    });

    it('defaults to null when the field is absent', async () => {
      expect(sanitizeAgentPayload({ cpu: 1 }, Date.now())?.interval).toBeNull();
    });
  });

  describe('energy gap scaling', () => {
    const t0 = Date.now() - 500 * 1000;

    beforeAll(async () => {
      for (const offset of [0, 200, 400]) {
        await ctx.db.run(
          `INSERT INTO metrics_raw (device_id, ts, cpu, mem_pct, load1, net_rx, net_tx, disk_used_pct, gpu_util, gpu_mem_pct, cpu_power_w, power_total_w, power_gpu0_w, power_gpu1_w, power_gpu2_w, power_gpu3_w)
           VALUES (?, ?, 10, 50, 0.5, 0, 0, 50, NULL, NULL, 100, 100, NULL, NULL, NULL, NULL)`,
          [deviceId, t0 + offset * 1000]
        );
      }
    });

    it('counts 200s gaps when the agent interval is 60s', async () => {
      const bd = await computeEnergyBreakdown(ctx.db, { fromMs: 3_600_000, source: 'raw' }, deviceId, 60);
      expect(bd.onlineS).toBe(400);
      expect(bd.totalKwh).toBeGreaterThan(0);
    });

    it('drops them at the default 30s interval', async () => {
      const bd = await computeEnergyBreakdown(ctx.db, { fromMs: 3_600_000, source: 'raw' }, deviceId, 30);
      expect(bd.onlineS).toBe(0);
      expect(bd.totalKwh).toBe(0);
    });

    it('the energy route follows the stored setting', async () => {
      await putSettings({ agent_interval_seconds: 60, ui_refresh_seconds: 10 });
      const withGap = await request(app).get(`/api/devices/${deviceId}/stats/energy?range=1h`).set(auth());
      expect(withGap.status).toBe(200);
      expect(withGap.body.kwh).toBeGreaterThan(0);

      await putSettings({ agent_interval_seconds: 30, ui_refresh_seconds: 10 });
      const withoutGap = await request(app).get(`/api/devices/${deviceId}/stats/energy?range=1h`).set(auth());
      expect(withoutGap.status).toBe(200);
      expect(withoutGap.body.kwh).toBe(0);
    });
  });
});
