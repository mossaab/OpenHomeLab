import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, encryptCredential, decryptCredential } from '../server';

type Ctx = Awaited<ReturnType<typeof initDb>>;

describe('APP_ENCRYPTION_KEY handling', () => {
  let tmpDir: string;
  let ctx: Ctx | null = null;
  const savedEnv = process.env.APP_ENCRYPTION_KEY;

  const restoreEnv = () => {
    if (savedEnv === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = savedEnv;
  };

  const storedKey = async (c: Ctx): Promise<string> => {
    const row = (await c.db.get('SELECT app_encryption_key FROM settings WHERE id = 1')) as {
      app_encryption_key: string | null;
    };
    return row.app_encryption_key ?? '';
  };

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhomelab-enc-test-'));
  });

  afterEach(async () => {
    if (ctx) {
      await ctx.db.close();
      ctx = null;
    }
    restoreEnv();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists the env APP_ENCRYPTION_KEY into the database when none is stored', async () => {
    const key = 'a'.repeat(64);
    process.env.APP_ENCRYPTION_KEY = key;
    ctx = await initDb(path.join(tmpDir, 'persist.sqlite'));
    expect(await storedKey(ctx)).toBe(key);
  });

  it('warns when the env key differs from the stored database key and the env key wins', async () => {
    delete process.env.APP_ENCRYPTION_KEY;
    const first = await initDb(path.join(tmpDir, 'drift.sqlite'));
    const stored = await storedKey(first);
    expect(stored).not.toBe('');
    await first.db.close();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.APP_ENCRYPTION_KEY = 'b'.repeat(64);
    ctx = await initDb(path.join(tmpDir, 'drift.sqlite'));
    expect(warn.mock.calls.some((call) => String(call[0]).includes('APP_ENCRYPTION_KEY'))).toBe(true);
    warn.mockRestore();

    expect(await storedKey(ctx)).toBe(stored);
    const encrypted = encryptCredential('secret-value', ctx.encKey);
    expect(decryptCredential(encrypted, ctx.encKey)).toBe('secret-value');
  });

  it('does not warn when the env key matches the stored database key', async () => {
    delete process.env.APP_ENCRYPTION_KEY;
    const first = await initDb(path.join(tmpDir, 'match.sqlite'));
    const stored = await storedKey(first);
    await first.db.close();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.APP_ENCRYPTION_KEY = stored;
    ctx = await initDb(path.join(tmpDir, 'match.sqlite'));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();

    const encrypted = encryptCredential('another-secret', ctx.encKey);
    expect(decryptCredential(encrypted, ctx.encKey)).toBe('another-secret');
  });
});
