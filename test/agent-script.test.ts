import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import http from 'http';
import type { AddressInfo } from 'net';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { buildAgentScript, buildAgentInstaller, initDb, createApp, AGENT_VERSION } from '../server';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const hasCurl = spawnSync('sh', ['-c', 'command -v curl >/dev/null 2>&1']).status === 0;
if (!hasCurl) console.warn('[agent-script] WARNING: curl not found — runtime agent push test will be skipped (no payload coverage)');
const runAgent = hasCurl ? it : it.skip;

describe('agent script payload', () => {
  let child: ReturnType<typeof spawn> | null = null;

  const pushes: string[] = [];
  let tmpDir = '';
  let server!: http.Server;
  let port = 0;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhomelab-agent-test-'));
    server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/agent/stats') {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          pushes.push(body);
          res.end('{"ok":true}');
        });
        return;
      }
      if (req.method === 'GET' && req.url === '/api/agent/pending-actions') {
        res.end('{"actions":[]}');
        return;
      }
      if (req.method === 'GET' && req.url === '/api/agent/config') {
        res.end('{"success":true,"interval":1}');
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (child) child.kill('SIGTERM');
    await sleep(500);
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('installer build', () => {
    it('substitutes the embedded script and interval, leaving no placeholders', () => {
      const installer = buildAgentInstaller(45);
      expect(installer).not.toContain('__AGENT_SCRIPT__');
      expect(installer).not.toContain('__AGENT_INTERVAL__');
      expect(installer).toContain('INTERVAL=45');
      expect(installer).toContain(`AGENT_VERSION="${AGENT_VERSION}"`);
    });

    it('does not reference legacy agent names', () => {
      const installer = buildAgentInstaller(30);
      expect(installer.toLowerCase()).not.toContain('tahakom');
      expect(installer.toLowerCase()).not.toContain('netcontrol');
      expect(buildAgentScript(30).toLowerCase()).not.toContain('tahakom');
    });

    it('passes a sh -n syntax check', () => {
      const p = path.join(tmpDir, 'install.sh');
      fs.writeFileSync(p, buildAgentInstaller(30));
      const result = spawnSync('sh', ['-n', p], { encoding: 'utf8' });
      expect(result.status).toBe(0);
    });

    it('builds a script that passes a sh -n syntax check', () => {
      const p = path.join(tmpDir, 'agent.sh');
      fs.writeFileSync(p, buildAgentScript(30));
      const result = spawnSync('sh', ['-n', p], { encoding: 'utf8' });
      expect(result.status).toBe(0);
    });

    it('reads the active flag from the agent config', () => {
      const script = buildAgentScript(30);
      expect(script).toContain('read_state');
      expect(script).toContain('"active":(true|false)');
      expect(script).toContain('STATE_ACTIVE');
    });

    it('selects an intel_gpu_top invocation that matches the installed version', () => {
      const script = buildAgentScript(30);
      expect(script).toContain('IGT_RUN="intel_gpu_top -c -s 500 -n 1"');
      expect(script).toContain('timeout 2 intel_gpu_top -c -s 500');
      expect(script).toContain('$IGT_RUN > "$STATE_DIR/igt"');
      expect(script).not.toContain('intel_gpu_top -c -s 500 -n 1 > ');
    });

    it('falls back to RAPL MSR when no hwmon package power is exposed', () => {
      const script = buildAgentScript(30);
      expect(script).toContain('rapl_msr_init');
      expect(script).toContain('/dev/cpu/0/msr');
      expect(script).toContain('MSR_DEV=/dev/cpu/0/msr');
      expect(script).toContain('OHL_MSR_FILE');
      expect(script).toContain('modprobe msr');
      expect(script).toContain('rapl_msrd 1542');
      expect(script).toContain('rapl_msrd 1553');
      expect(script).toContain('cpu_power_w=$RPL_W');
    });

    it('tries hwmon RAPL first, then intel_gpu_top, then MSR fallback', () => {
      const script = buildAgentScript(30);
      const idxHwmon = script.indexOf('[ "$pfound" -eq 1 ]');
      const idxIgt = script.indexOf('elif [ -n "$IGT_CPU_W" ]');
      const idxRapl = script.indexOf('else', idxIgt);
      expect(idxHwmon).toBeGreaterThanOrEqual(0);
      expect(idxIgt).toBeGreaterThan(idxHwmon);
      expect(idxRapl).toBeGreaterThan(idxIgt);
    });

    it('collects OS and CPU system information for linux and darwin', () => {
      const script = buildAgentScript(30);
      expect(script).toContain('os_collect()');
      expect(script).toContain('OS_FAMILY=linux');
      expect(script).toContain('OS_ID=macos');
      expect(script).toContain('/etc/os-release');
      expect(script).toContain('/proc/device-tree/model');
      expect(script).toContain('*Raspberry\\ Pi*');
      expect(script).toContain('sw_vers -productName');
      expect(script).toContain('hw.cpufrequency_max');
      expect(script).toContain('json_str_field "$OS_FAMILY"');
      expect(script).toContain('\\"cpu_cores\\":$(num_or_null "$CPU_CORES")');
    });

    it('collects GPU names from nvidia-smi, lspci and driver labels', () => {
      const script = buildAgentScript(30);
      expect(script).toContain('--query-gpu=name');
      expect(script).toContain('vga_names()');
      expect(script).toContain('"AMD GPU"');
      expect(script).toContain('"Intel integrated GPU"');
      expect(script).toContain('\\"name\\":$(json_str_field "$gname")');
    });

    it('computes RAPL power from the raw counter delta with 2^32 wrap handling', () => {
      const script = buildAgentScript(30);
      const block = script.slice(script.indexOf('rapl_msr_power()'), script.indexOf('cpu_power_collect()'));
      expect(block).toContain('d += 4294967296');
      expect(block).toContain('(d / t) * 0.001 / (2 ^ e)');
    });
  });

  describe('real agent run', () => {
    runAgent(
      'pushes valid JSON with properly quoted interface kinds',
      async () => {
        const scriptPath = path.join(tmpDir, 'run-agent.sh');
        fs.writeFileSync(scriptPath, buildAgentScript(30), { mode: 0o755 });
        const confPath = path.join(tmpDir, 'agent.conf');
        fs.writeFileSync(confPath, `SERVER_URL=http://127.0.0.1:${port}\nTOKEN=tk-test\nINTERVAL=1\n`);

        child = spawn('sh', [scriptPath, confPath], { stdio: ['ignore', 'pipe', 'pipe'] });
        await sleep(9000);
        child.kill('SIGINT');
        child = null;

        expect(pushes.length).toBeGreaterThanOrEqual(1);
        for (const raw of pushes) {
          const payload = JSON.parse(raw) as Record<string, unknown>;
          expect(typeof payload.cpu).toBe('number');
          const cpu = Number(payload.cpu);
          expect(cpu).toBeGreaterThanOrEqual(0);
          expect(cpu).toBeLessThanOrEqual(100);

          expect(Array.isArray(payload.load)).toBe(true);
          expect((payload.load as unknown[]).length).toBe(3);

          const memTotal = Number(payload.mem_total);
          const memUsed = Number(payload.mem_used);
          expect(Number.isInteger(memTotal)).toBe(true);
          expect(memTotal).toBeGreaterThan(0);
          expect(Number.isInteger(memUsed)).toBe(true);
          expect(memUsed).toBeGreaterThanOrEqual(0);
          expect(memUsed).toBeLessThanOrEqual(memTotal);

          expect(typeof payload.swap_total).toBe('number');
          expect(typeof payload.swap_used).toBe('number');

          const disks = payload.disks as { name: string; total: number; used: number }[];
          expect(Array.isArray(disks)).toBe(true);
          for (const d of disks) {
            expect(d.name).toBeTruthy();
            expect(Number.isInteger(d.total)).toBe(true);
            expect(Number.isInteger(d.used)).toBe(true);
          }

          expect(typeof payload.net_rx).toBe('number');
          expect(payload.net_rx as number).toBeGreaterThanOrEqual(0);
          expect(typeof payload.net_tx).toBe('number');
          expect(payload.net_tx as number).toBeGreaterThanOrEqual(0);

          expect(typeof payload.uptime_s).toBe('number');
          expect(Array.isArray(payload.gpus)).toBe(true);
          expect(Array.isArray(payload.interfaces)).toBe(true);
          for (const iface of payload.interfaces as { kind: unknown }[]) {
            expect(['eth', 'wifi', null]).toContain(iface.kind);
          }
          expect(payload.agent_version).toBe(AGENT_VERSION);

          if (process.platform === 'linux') {
            expect(payload.os_family).toBe('linux');
            expect(typeof payload.os_name).toBe('string');
            expect((payload.os_name as string).length).toBeGreaterThan(0);
            expect(typeof payload.kernel).toBe('string');
            expect((payload.kernel as string).length).toBeGreaterThan(0);
            if (typeof payload.cpu_model === 'string') expect(payload.cpu_model.length).toBeGreaterThan(0);
            if (typeof payload.cpu_cores === 'number') {
              expect(Number.isInteger(payload.cpu_cores)).toBe(true);
              expect(payload.cpu_cores as number).toBeGreaterThanOrEqual(1);
            }
          }
          for (const gpu of payload.gpus as Record<string, unknown>[]) {
            if ('name' in gpu) {
              expect(gpu.name === null || typeof gpu.name === 'string').toBe(true);
            }
          }
        }
      },
      30000
    );

    runAgent('stops pushing metrics while the server reports the device inactive', async () => {
      const offPushes: string[] = [];
      const offServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/agent/stats') {
          let body = '';
          req.on('data', (chunk: Buffer) => (body += chunk.toString()));
          req.on('end', () => {
            offPushes.push(body);
            res.end('{"ok":true}');
          });
          return;
        }
        if (req.method === 'GET' && req.url === '/api/agent/pending-actions') {
          res.end('{"actions":[]}');
          return;
        }
        if (req.method === 'GET' && req.url === '/api/agent/config') {
          res.end('{"success":true,"interval":1,"active":false}');
          return;
        }
        res.statusCode = 404;
        res.end('not found');
      });
      await new Promise<void>((resolve) => offServer.listen(0, '127.0.0.1', resolve));
      const offPort = (offServer.address() as AddressInfo).port;

      const scriptPath = path.join(tmpDir, 'run-agent-inactive.sh');
      fs.writeFileSync(scriptPath, buildAgentScript(30), { mode: 0o755 });
      const confPath = path.join(tmpDir, 'agent-inactive.conf');
      fs.writeFileSync(confPath, `SERVER_URL=http://127.0.0.1:${offPort}\nTOKEN=tk-off\nINTERVAL=1\n`);

      const proc = spawn('sh', [scriptPath, confPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      await sleep(4000);
      proc.kill('SIGINT');
      offServer.close();

      expect(offPushes.length).toBe(0);
    }, 20000);
  });

  describe('rapl msr fallback (simulated counter)', () => {
    const hwmonHasPackagePower =
      spawnSync(
        'sh',
        [
          '-c',
          `for d in /sys/class/hwmon/hwmon*; do [ -d "$d" ] || continue; n=1; while [ "$n" -le 8 ]; do pf="$d/power$n"_average; if [ -r "$pf" ]; then label=$(cat "$d/power$n"_label 2>/dev/null); case "$label" in *[Pp]ackage*) exit 0;; esac; fi; n=$((n+1)); done; done; exit 1`,
        ],
      ).status === 0;

    const raplRun = !hasCurl || hwmonHasPackagePower ? it.skip : it;
    raplRun(
      'feeds cpu_power_w from the RAPL MSR counter when no hwmon or intel_gpu_top power exists',
      async () => {
        const msrFile = path.join(tmpDir, 'msr.bin');
        const file = Buffer.alloc((1601 + 1) * 8);
        file.writeUInt32LE(0x203a6464, 1542 * 8);
        fs.writeFileSync(msrFile, file);

        const rplPushes: string[] = [];
        const rplServer = http.createServer((req, res) => {
          if (req.method === 'POST' && req.url === '/api/agent/stats') {
            let body = '';
            req.on('data', (chunk: Buffer) => (body += chunk.toString()));
            req.on('end', () => {
              rplPushes.push(body);
              res.end('{"ok":true}');
            });
            return;
          }
          if (req.method === 'GET' && req.url === '/api/agent/pending-actions') {
            res.end('{"actions":[]}');
            return;
          }
          if (req.method === 'GET' && req.url === '/api/agent/config') {
            res.end('{"success":true}');
            return;
          }
          res.statusCode = 404;
          res.end('not found');
        });
        await new Promise<void>((resolve) => rplServer.listen(0, '127.0.0.1', resolve));
        const rplPort = (rplServer.address() as AddressInfo).port;

        let script = buildAgentScript(12);
        script = script.replace('[ "$(id -u)" = "0" ] || return 1', 'true');
        script = script.replaceAll('command -v intel_gpu_top >/dev/null 2>&1', 'false');
        const scriptPath = path.join(tmpDir, 'run-agent-rapl.sh');
        fs.writeFileSync(scriptPath, script, { mode: 0o755 });
        const confPath = path.join(tmpDir, 'agent-rapl.conf');
        fs.writeFileSync(confPath, `SERVER_URL=http://127.0.0.1:${rplPort}\nTOKEN=tk-rapl\nINTERVAL=12\n`);

        const msrFd = fs.openSync(msrFile, 'r+');
        const t0 = Date.now();
        const writeCounter = () => {
          const raw = Math.round(1_000_000 + ((Date.now() - t0) / 1000) * 80000);
          const b = Buffer.alloc(8);
          b.writeBigUInt64LE(BigInt(Math.min(raw, 2 ** 32 - 1)));
          fs.writeSync(msrFd, b, 0, 8, 1553 * 8);
        };
        writeCounter();
        const counterTimer = setInterval(writeCounter, 250);

        const proc = spawn('sh', [scriptPath, confPath], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, OHL_MSR_FILE: msrFile },
        });
        let stderr = '';
        proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        await sleep(35000);
        proc.kill('SIGINT');
        clearInterval(counterTimer);
        fs.closeSync(msrFd);
        rplServer.close();

        expect(rplPushes.length).toBeGreaterThanOrEqual(2);
        const last = JSON.parse(rplPushes[rplPushes.length - 1]) as Record<string, unknown>;
        const w = last.cpu_power_w;
        if (typeof w !== 'number') console.error('[rapl-sim] stderr:', stderr.trim().split('\n').slice(-20).join('\n'));
        expect(typeof w).toBe('number');
        expect(w as number).toBeGreaterThan(3);
        expect(w as number).toBeLessThan(7);
      },
      60000
    );
  });

  describe('server accepts large payloads (regression)', () => {
    it('stores agent stats with values above 2^31 without loss', async () => {
      const bigTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openhomelab-agent-big-'));
      let ctx: Awaited<ReturnType<typeof initDb>>;
      try {
        process.env.NODE_ENV = 'test';
        delete process.env.JWT_SECRET;
        delete process.env.APP_ENCRYPTION_KEY;
        ctx = await initDb(path.join(bigTmp, 'db.sqlite'));

        const hash = await bcrypt.hash('password123', 10);
        await ctx.db.run('UPDATE settings SET master_password_hash = ? WHERE id = 1', [hash]);
        const token = jwt.sign({ id: 1 }, ctx.jwtSecret, { expiresIn: '24h' });

        const app = createApp(ctx);
        const devRes = await request(app)
          .post('/api/devices')
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Big Box', ip: '192.168.1.50', type: 'server' });
        const deviceId = devRes.body.id as number;

        const tok = await request(app).post(`/api/devices/${deviceId}/agent/token`).set('Authorization', `Bearer ${token}`);
        const agentToken = tok.body.token as string;

        // 8 GiB RAM + 4 TiB disk in KB: values comfortably above 2^31.
        const res = await request(app)
          .post('/api/agent/stats')
          .set('Authorization', `Bearer ${agentToken}`)
          .send({
            hostname: 'bigbox',
            cpu: 42.5,
            load: [1.0, 1.2, 1.4],
            mem_total: 8_589_934_592,
            mem_used: 4_294_967_296,
            swap_total: 0,
            swap_used: 0,
            disks: [{ name: 'sda1', total: 4_194_304_000, used: 2_097_152_000 }],
            net_rx: 10_000_000_000,
            net_tx: 5_000_000_000,
            uptime_s: 2_440_980,
            gpus: [],
            cpu_power_w: null,
            interfaces: [],
            interval: 30,
            agent_version: AGENT_VERSION,
          });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        const row = (await ctx.db.get('SELECT payload FROM metrics_live WHERE device_id = ?', deviceId)) as {
          payload: string;
        } | undefined;
        expect(row).toBeTruthy();
        const stored = JSON.parse(row!.payload) as Record<string, unknown>;
        expect(stored.mem_total).toBe(8_589_934_592);
        expect(stored.mem_used).toBe(4_294_967_296);
        const storedDisks = stored.disks as { total: number; used: number }[];
        expect(storedDisks[0].total).toBe(4_194_304_000);
        expect(storedDisks[0].used).toBe(2_097_152_000);
      } finally {
        if (ctx) await ctx.db.close();
        fs.rmSync(bigTmp, { recursive: true, force: true });
      }
    }, 20000);
  });
});
