import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, createApp } from '../server';

type Ctx = Awaited<ReturnType<typeof initDb>>;

describe('Groups API', () => {
  let tmpDir: string;
  let ctx: Ctx;
  let app: ReturnType<typeof createApp>;
  let token: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    delete process.env.APP_ENCRYPTION_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhomelab-groups-'));
    ctx = await initDb(path.join(tmpDir, 'db.sqlite'));
    app = createApp(ctx);
    const setup = await request(app).post('/api/setup').send({ password: 'password123' });
    token = setup.body.token;
  });

  afterAll(async () => {
    if (ctx) await ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  const createDevice = async (name: string, ip: string, extra: Record<string, unknown> = {}) => {
    const res = await request(app)
      .post('/api/devices')
      .set(auth())
      .send({ name, ip, type: 'pc', ...extra });
    expect(res.status).toBe(200);
    return res.body.id as number;
  };

  describe('group CRUD', () => {
    it('requires auth', async () => {
      const res = await request(app).get('/api/groups');
      expect(res.status).toBe(401);
    });

    it('lists empty groups initially', async () => {
      const res = await request(app).get('/api/groups').set(auth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(0);
    });

    it('creates a group with defaults', async () => {
      const res = await request(app).post('/api/groups').set(auth()).send({ name: 'IA' });
      expect(res.status).toBe(200);
      expect(typeof res.body.id).toBe('number');

      const list = await request(app).get('/api/groups').set(auth());
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({ name: 'IA', icon: 'boxes', color: 'slate', position: 0 });
    });

    it('accepts explicit icon and color from the allowlist', async () => {
      const res = await request(app)
        .post('/api/groups')
        .set(auth())
        .send({ name: 'Workers', icon: 'cpu', color: 'indigo' });
      expect(res.status).toBe(200);
    });

    it('rejects unknown icons and colors', async () => {
      const badIcon = await request(app).post('/api/groups').set(auth()).send({ name: 'X1', icon: 'nope' });
      expect(badIcon.status).toBe(400);
      const badColor = await request(app).post('/api/groups').set(auth()).send({ name: 'X2', color: 'pink' });
      expect(badColor.status).toBe(400);
    });

    it('rejects duplicate group names with 409', async () => {
      const res = await request(app).post('/api/groups').set(auth()).send({ name: 'IA' });
      expect(res.status).toBe(409);
    });

    it('renames and restyles a group', async () => {
      const list = await request(app).get('/api/groups').set(auth());
      const workers = list.body.find((g: { name: string }) => g.name === 'Workers');
      const res = await request(app)
        .put(`/api/groups/${workers.id}`)
        .set(auth())
        .send({ name: 'Worker Pool', icon: 'server', color: 'sky' });
      expect(res.status).toBe(200);

      const after = await request(app).get('/api/groups').set(auth());
      const updated = after.body.find((g: { id: number }) => g.id === workers.id);
      expect(updated).toMatchObject({ name: 'Worker Pool', icon: 'server', color: 'sky' });
    });

    it('returns 404 for unknown groups on update/delete', async () => {
      const upd = await request(app).put('/api/groups/9999').set(auth()).send({ name: 'Z' });
      expect(upd.status).toBe(404);
      const del = await request(app).delete('/api/groups/9999').set(auth());
      expect(del.status).toBe(404);
    });
  });

  describe('group reordering', () => {
    let iaId: number;
    let workersId: number;

    beforeAll(async () => {
      const list = (await request(app).get('/api/groups').set(auth())).body;
      iaId = list.find((g: { name: string }) => g.name === 'IA').id;
      workersId = list.find((g: { name: string }) => g.name === 'Worker Pool').id;
    });

    it('reorders groups by provided ids', async () => {
      const res = await request(app).post('/api/groups/reorder').set(auth()).send({ ids: [workersId, iaId] });
      expect(res.status).toBe(200);
      const list = await request(app).get('/api/groups').set(auth());
      expect(list.body.map((g: { id: number }) => g.id)).toEqual([workersId, iaId]);
    });

    it('rejects partial or unknown id lists', async () => {
      const partial = await request(app).post('/api/groups/reorder').set(auth()).send({ ids: [iaId] });
      expect(partial.status).toBe(400);
      const unknown = await request(app).post('/api/groups/reorder').set(auth()).send({ ids: [iaId, workersId, 42] });
      expect(unknown.status).toBe(400);
    });
  });

  describe('device placement', () => {
    let iaId: number;
    let workersId: number;

    beforeAll(async () => {
      const list = (await request(app).get('/api/groups').set(auth())).body;
      iaId = list.find((g: { name: string }) => g.name === 'IA').id;
      workersId = list.find((g: { name: string }) => g.name === 'Worker Pool').id;
    });

    it('creates devices in a group with sequential positions', async () => {
      const d1 = await createDevice('gpu-a', '10.0.1.11', { group_id: iaId });
      const d2 = await createDevice('gpu-b', '10.0.1.12', { group_id: iaId });
      await createDevice('ws-1', '10.0.1.21');
      expect(d1).toBeGreaterThan(0);

      const active = (await request(app).get('/api/devices/active').set(auth())).body;
      const byName = (n: string) => active.find((d: { name: string }) => d.name === n);
      expect(byName('gpu-a')).toMatchObject({ group_id: iaId, position: 0 });
      expect(byName('gpu-b')).toMatchObject({ group_id: iaId, position: 1 });
      expect(byName('ws-1')).toMatchObject({ group_id: null, position: 0 });
      expect(d2).toBeGreaterThan(0);
    });

    it('rejects unknown group on create and update', async () => {
      const created = await request(app)
        .post('/api/devices')
        .set(auth())
        .send({ name: 'bad', ip: '10.0.1.99', type: 'pc', group_id: 4242 });
      expect(created.status).toBe(400);

      const active = (await request(app).get('/api/devices/active').set(auth())).body;
      const dev = active.find((d: { name: string }) => d.name === 'gpu-a');
      const updated = await request(app)
        .put(`/api/devices/${dev.id}`)
        .set(auth())
        .send({ name: dev.name, ip: dev.ip, type: dev.type, group_id: 4242 });
      expect(updated.status).toBe(400);
    });

    it('moves a device at an index within its group', async () => {
      const active = (await request(app).get('/api/devices/active').set(auth())).body;
      const gpuA = active.find((d: { name: string }) => d.name === 'gpu-a');
      const res = await request(app)
        .put(`/api/devices/${gpuA.id}/move`)
        .set(auth())
        .send({ group_id: iaId, index: 1 });
      expect(res.status).toBe(200);

      const after = (await request(app).get('/api/devices/active').set(auth())).body;
      const order = after.filter((d: { group_id: number | null }) => d.group_id === iaId).sort((a: { position: number }, b: { position: number }) => a.position - b.position);
      expect(order.map((d: { name: string }) => d.name)).toEqual(['gpu-b', 'gpu-a']);
    });

    it('moves a device across groups and reindexes both', async () => {
      const active = (await request(app).get('/api/devices/active').set(auth())).body;
      const ws1 = active.find((d: { name: string }) => d.name === 'ws-1');
      const res = await request(app)
        .put(`/api/devices/${ws1.id}/move`)
        .set(auth())
        .send({ group_id: workersId, index: 0 });
      expect(res.status).toBe(200);

      const after = (await request(app).get('/api/devices/active').set(auth())).body;
      const ungrouped = after.filter((d: { group_id: number | null }) => d.group_id === null);
      expect(ungrouped).toHaveLength(0);
      const workers = after.filter((d: { group_id: number | null }) => d.group_id === workersId);
      expect(workers.map((d: { name: string }) => d.name)).toEqual(['ws-1']);
      expect(workers[0].position).toBe(0);

      const ungroupedRes = await request(app)
        .put(`/api/devices/${ws1.id}/move`)
        .set(auth())
        .send({ group_id: null, index: 0 });
      expect(ungroupedRes.status).toBe(200);
      const back = (await request(app).get('/api/devices/active').set(auth())).body;
      expect(back.find((d: { name: string }) => d.name === 'ws-1').group_id).toBeNull();
    });

    it('rejects out-of-range index and unknown groups on move', async () => {
      const active = (await request(app).get('/api/devices/active').set(auth())).body;
      const gpuA = active.find((d: { name: string }) => d.name === 'gpu-a');
      const badIndex = await request(app)
        .put(`/api/devices/${gpuA.id}/move`)
        .set(auth())
        .send({ group_id: iaId, index: 99 });
      expect(badIndex.status).toBe(400);
      const badGroup = await request(app)
        .put(`/api/devices/${gpuA.id}/move`)
        .set(auth())
        .send({ group_id: 777, index: 0 });
      expect(badGroup.status).toBe(400);
    });

    it('deleting a group keeps its devices in the ungrouped section', async () => {
      const active = (await request(app).get('/api/devices/active').set(auth())).body;
      expect(active.filter((d: { group_id: number | null }) => d.group_id === iaId)).toHaveLength(2);

      const res = await request(app).delete(`/api/groups/${iaId}`).set(auth());
      expect(res.status).toBe(200);

      const after = (await request(app).get('/api/devices/active').set(auth())).body;
      expect(after.every((d: { group_id: number | null }) => d.group_id === null)).toBe(true);
      expect(after.map((d: { name: string }) => d.name).sort()).toEqual(['gpu-a', 'gpu-b', 'ws-1']);
    });
  });

  describe('dashboard settings', () => {
    it('returns defaults and accepts valid values', async () => {
      const get = await request(app).get('/api/settings').set(auth());
      expect(get.body.dashboard_view).toBe('grid');
      expect(get.body.dashboard_card_size).toBe('normal');

      const put = await request(app)
        .put('/api/settings')
        .set(auth())
        .send({ dashboard_view: 'list', dashboard_card_size: 'compact' });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({ dashboard_view: 'list', dashboard_card_size: 'compact' });

      const again = await request(app).get('/api/settings').set(auth());
      expect(again.body).toMatchObject({ dashboard_view: 'list', dashboard_card_size: 'compact' });
    });

    it('rejects invalid values', async () => {
      const badView = await request(app).put('/api/settings').set(auth()).send({ dashboard_view: 'cards' });
      expect(badView.status).toBe(400);
      const badSize = await request(app).put('/api/settings').set(auth()).send({ dashboard_card_size: 'huge' });
      expect(badSize.status).toBe(400);
    });

    it('keeps other settings when only dashboard prefs change', async () => {
      const put = await request(app).put('/api/settings').set(auth()).send({ dashboard_view: 'grid' });
      expect(put.status).toBe(200);
      expect(put.body.dashboard_card_size).toBe('compact');
    });
  });

  describe('export / import with groups', () => {
    it('exports groups and device group references, import restores them', async () => {
      const list = (await request(app).get('/api/groups').set(auth())).body;
      const workersId = list.find((g: { name: string }) => g.name === 'Worker Pool').id;

      const active = (await request(app).get('/api/devices/active').set(auth())).body;
      const gpuA = active.find((d: { name: string }) => d.name === 'gpu-a');
      await request(app)
        .put(`/api/devices/${gpuA.id}/move`)
        .set(auth())
        .send({ group_id: workersId, index: 0 });

      const exportRes = await request(app).get('/api/data/export').set(auth());
      expect(exportRes.status).toBe(200);
      expect(Array.isArray(exportRes.body.groups)).toBe(true);
      expect(exportRes.body.groups.length).toBeGreaterThanOrEqual(1);
      const exportedDevice = exportRes.body.devices.find((d: { name: string }) => d.name === 'gpu-a');
      expect(exportedDevice.group_id).toBe(workersId);

      // Import into a fresh DB
      const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'openhomelab-groups-import-'));
      const ctx2 = await initDb(path.join(tmpDir2, 'db.sqlite'));
      try {
        const app2 = createApp(ctx2);
        const setup2 = await request(app2).post('/api/setup').send({ password: 'password123' });
        const token2 = setup2.body.token;

        const importRes = await request(app2)
          .post('/api/data/import')
          .set({ Authorization: `Bearer ${token2}` })
          .send(exportRes.body);
        expect(importRes.status).toBe(200);

        const groups2 = (await request(app2).get('/api/groups').set({ Authorization: `Bearer ${token2}` })).body;
        expect(groups2.map((g: { name: string }) => g.name)).toContain('Worker Pool');
        const active2 = (await request(app2).get('/api/devices/active').set({ Authorization: `Bearer ${token2}` })).body;
        const importedDevice = active2.find((d: { name: string }) => d.name === 'gpu-a');
        const workers2 = groups2.find((g: { name: string }) => g.name === 'Worker Pool');
        expect(importedDevice.group_id).toBe(workers2.id);
      } finally {
        await ctx2.db.close();
        fs.rmSync(tmpDir2, { recursive: true, force: true });
      }
    });

    it('resolves unknown device group refs to ungrouped', async () => {
      const res = await request(app)
        .post('/api/data/import')
        .set(auth())
        .send({ devices: [{ name: 'ghost', ip: '10.9.9.9', type: 'pc', group_id: 321 }] });
      expect(res.status).toBe(200);
      const active = (await request(app).get('/api/devices/active').set(auth())).body;
      const ghost = active.find((d: { name: string }) => d.name === 'ghost');
      expect(ghost).toMatchObject({ group_id: null });
    });
  });
});
