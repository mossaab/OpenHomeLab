import express from 'express';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import ping from 'ping';
import { NodeSSH } from 'node-ssh';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import os from 'os';
import crypto from 'crypto';
import dgram from 'dgram';
import ipaddr from 'ipaddr.js';
import fs from 'fs';
import net from 'net';
import dns from 'dns/promises';
import http from 'http';
import { WebSocketServer } from 'ws';
import type { WebSocket as WsSocket, RawData } from 'ws';
import { Client as SshClient } from 'ssh2';
import type { ClientChannel } from 'ssh2';
import {
  POWER_OFF_ACTIONS,
  REBOOT_ACTIONS,
  HIBERNATE_ACTIONS,
  DEFAULT_POWER_OFF_ACTION,
  DEFAULT_REBOOT_ACTION,
  DEFAULT_HIBERNATE_ACTION,
} from './src/powerActions';

export {
  POWER_OFF_ACTIONS,
  REBOOT_ACTIONS,
  HIBERNATE_ACTIONS,
  DEFAULT_POWER_OFF_ACTION,
  DEFAULT_REBOOT_ACTION,
  DEFAULT_HIBERNATE_ACTION,
};

const PORT = parseInt(process.env.PORT || '3000', 10);
const DEFAULT_JWT_SECRET = 'super_secret_key_change_me_in_prod_1234';
const JWT_EXPIRES_IN = '24h';
const MIN_PASSWORD_LENGTH = 8;
const ENC_PREFIX = 'enc:v1:';
const DEVICE_TYPES = [
  'pc',
  'laptop',
  'server',
  'router',
  'switch',
  'nas',
  'tv',
  'printer',
  'phone',
  'tablet',
  'camera',
  'console',
  'audio',
  'iot',
  'other',
];
export const GROUP_ICONS = [
  'boxes',
  'box',
  'cpu',
  'server',
  'monitor',
  'laptop',
  'router',
  'network',
  'hard-drive',
  'tv',
  'printer',
  'smartphone',
  'tablet',
  'camera',
  'gamepad-2',
  'volume-2',
  'plug',
  'zap',
] as const;
export type GroupIcon = (typeof GROUP_ICONS)[number];
export const GROUP_COLORS = [
  'indigo',
  'violet',
  'sky',
  'cyan',
  'emerald',
  'lime',
  'amber',
  'rose',
  'slate',
] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];
const MAC_RE = /^([0-9a-f]{2}[:.-]){5}[0-9a-f]{2}$/i;
const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

let OUI_DB: Record<string, string> = {};
try {
  OUI_DB = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'server-data', 'oui.json'), 'utf8'));
} catch {
  console.warn('OUI database unavailable — manufacturer lookup will be disabled');
  OUI_DB = {};
}

export interface AppContext {
  db: Database;
  jwtSecret: string;
  encKey: Buffer;
}

// ---- Credential encryption (AES-256-GCM) ----

function deriveKey(secret: string): Buffer {
  return crypto.scryptSync(secret, 'netcontrol-enc-salt-v1', 32);
}

export function encryptCredential(value: string | null | undefined, key: Buffer): string | null {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptCredential(stored: string | null | undefined, key: Buffer): string | null {
  if (!stored) return null;
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  const [ivHex, tagHex, dataHex] = stored.slice(ENC_PREFIX.length).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

export async function migrateLegacyCredentials(db: Database, key: Buffer): Promise<void> {
  const rows = (await db.all(
    `SELECT id, password, private_key FROM profiles
     WHERE (password IS NOT NULL AND password NOT LIKE 'enc:v1:%')
        OR (private_key IS NOT NULL AND private_key NOT LIKE 'enc:v1:%')`
  )) as { id: number; password: string | null; private_key: string | null }[];
  for (const row of rows) {
    const password = row.password ? encryptCredential(row.password, key) : null;
    const privateKey = row.private_key ? encryptCredential(row.private_key, key) : null;
    await db.run('UPDATE profiles SET password = ?, private_key = ? WHERE id = ?', [password, privateKey, row.id]);
  }
}

// ---- Database init ----

export async function initDb(dbPath?: string): Promise<AppContext> {
  const dbFile = dbPath || process.env.DB_PATH || './database.sqlite';
  const db = await open({ filename: dbFile, driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY,
      master_password_hash TEXT,
      app_encryption_key TEXT,
      agent_interval_seconds INTEGER DEFAULT 30,
      ui_refresh_seconds INTEGER DEFAULT 30,
      poweroff_action TEXT,
      reboot_action TEXT,
      hibernate_action TEXT
    );

    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      icon TEXT NOT NULL DEFAULT 'boxes',
      color TEXT NOT NULL DEFAULT 'slate',
      position INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_groups_position ON groups(position);

    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT NOT NULL,
      auth_type TEXT NOT NULL,
      password TEXT,
      private_key TEXT
    );

    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      ip TEXT NOT NULL,
      mac TEXT,
      hostname TEXT,
      type TEXT,
      profile_id INTEGER,
      broadcast_address TEXT,
      active INTEGER DEFAULT 1,
      agent_token TEXT,
      base_power_w REAL,
      interfaces TEXT,
      group_id INTEGER,
      position INTEGER NOT NULL DEFAULT 0,
      poweroff_action TEXT,
      reboot_action TEXT,
      hibernate_action TEXT,
      disable_power INTEGER DEFAULT 0,
      disable_ping INTEGER DEFAULT 0,
      disable_terminal INTEGER DEFAULT 0,
      disable_agent_update INTEGER DEFAULT 0,
      FOREIGN KEY (profile_id) REFERENCES profiles (id),
      FOREIGN KEY (group_id) REFERENCES groups(id)
    );

    CREATE TABLE IF NOT EXISTS agent_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_payload TEXT,
      last_seen INTEGER,
      samples TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_claims_token ON agent_claims(token_hash);

    CREATE TABLE IF NOT EXISTS metrics_live (
      device_id INTEGER PRIMARY KEY,
      payload TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      FOREIGN KEY (device_id) REFERENCES devices (id)
    );

    CREATE TABLE IF NOT EXISTS metrics_raw (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      cpu REAL,
      mem_pct REAL,
      load1 REAL,
      net_rx REAL,
      net_tx REAL,
      disk_used_pct REAL,
      gpu_util REAL,
      gpu_mem_pct REAL,
      cpu_power_w REAL,
      power_total_w REAL,
      power_gpu0_w REAL,
      power_gpu1_w REAL,
      power_gpu2_w REAL,
      power_gpu3_w REAL,
      FOREIGN KEY (device_id) REFERENCES devices (id)
    );

    CREATE INDEX IF NOT EXISTS idx_metrics_raw_device_ts ON metrics_raw(device_id, ts);

    CREATE TABLE IF NOT EXISTS metrics_hourly (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL,
      bucket INTEGER NOT NULL,
      cpu_avg REAL,
      cpu_max REAL,
      mem_pct_avg REAL,
      mem_pct_max REAL,
      load1_avg REAL,
      load1_max REAL,
      net_rx_max REAL,
      net_tx_max REAL,
      disk_used_pct_max REAL,
      gpu_util_avg REAL,
      gpu_util_max REAL,
      gpu_mem_pct_max REAL,
      cpu_power_w_avg REAL,
      power_total_w_avg REAL,
      power_total_w_max REAL,
      power_kwh REAL,
      online_s REAL,
      cpu_power_kwh REAL,
      gpu0_power_w_avg REAL,
      gpu0_power_kwh REAL,
      gpu1_power_w_avg REAL,
      gpu1_power_kwh REAL,
      gpu2_power_w_avg REAL,
      gpu2_power_kwh REAL,
      gpu3_power_w_avg REAL,
      gpu3_power_kwh REAL,
      UNIQUE(device_id, bucket),
      FOREIGN KEY (device_id) REFERENCES devices (id)
    );

    CREATE TABLE IF NOT EXISTS metrics_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL,
      bucket INTEGER NOT NULL,
      cpu_avg REAL,
      cpu_max REAL,
      mem_pct_avg REAL,
      mem_pct_max REAL,
      load1_avg REAL,
      load1_max REAL,
      net_rx_max REAL,
      net_tx_max REAL,
      disk_used_pct_max REAL,
      gpu_util_avg REAL,
      gpu_util_max REAL,
      gpu_mem_pct_max REAL,
      cpu_power_w_avg REAL,
      power_total_w_avg REAL,
      power_total_w_max REAL,
      power_kwh REAL,
      online_s REAL,
      cpu_power_kwh REAL,
      gpu0_power_w_avg REAL,
      gpu0_power_kwh REAL,
      gpu1_power_w_avg REAL,
      gpu1_power_kwh REAL,
      gpu2_power_w_avg REAL,
      gpu2_power_kwh REAL,
      gpu3_power_w_avg REAL,
      gpu3_power_kwh REAL,
      UNIQUE(device_id, bucket),
      FOREIGN KEY (device_id) REFERENCES devices (id)
    );

    CREATE TABLE IF NOT EXISTS device_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('reboot', 'shutdown', 'hibernate', 'update')),
      command TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'acknowledged', 'started', 'done', 'failed')),
      output TEXT,
      created_at INTEGER NOT NULL,
      executed_at INTEGER,
      FOREIGN KEY (device_id) REFERENCES devices (id)
    );

    CREATE INDEX IF NOT EXISTS idx_device_actions_device_status ON device_actions(device_id, status);

    CREATE TABLE IF NOT EXISTS api_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      permissions TEXT NOT NULL DEFAULT '[]',
      device_ids TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      last_used_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);

    CREATE TABLE IF NOT EXISTS api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id INTEGER NOT NULL,
      operation TEXT NOT NULL,
      device_id INTEGER,
      status_code INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_api_usage_token_created ON api_usage(token_id, created_at);
  `);

  await pruneApiUsage(db);

  const settingsCols = (await db.all('PRAGMA table_info(settings)')) as { name: string }[];
  if (!settingsCols.find((c) => c.name === 'app_encryption_key')) {
    await db.exec('ALTER TABLE settings ADD COLUMN app_encryption_key TEXT');
  }
  const freshSettings = (await db.all('PRAGMA table_info(settings)')) as { name: string }[];
  if (!freshSettings.find((c) => c.name === 'cost_per_kwh')) {
    await db.exec('ALTER TABLE settings ADD COLUMN cost_per_kwh REAL');
  }
  if (!freshSettings.find((c) => c.name === 'currency')) {
    await db.exec("ALTER TABLE settings ADD COLUMN currency TEXT DEFAULT '€'");
  }
  const finalSettings = (await db.all('PRAGMA table_info(settings)')) as { name: string }[];
  if (!finalSettings.find((c) => c.name === 'agent_interval_seconds')) {
    await db.exec('ALTER TABLE settings ADD COLUMN agent_interval_seconds INTEGER DEFAULT 30');
  }
  if (!finalSettings.find((c) => c.name === 'ui_refresh_seconds')) {
    await db.exec('ALTER TABLE settings ADD COLUMN ui_refresh_seconds INTEGER DEFAULT 30');
  }
  const cols = await db.all('PRAGMA table_info(devices)');
  if (!cols.find((c: { name: string }) => c.name === 'broadcast_address')) {
    await db.exec('ALTER TABLE devices ADD COLUMN broadcast_address TEXT');
  }
  if (!cols.find((c: { name: string }) => c.name === 'active')) {
    await db.exec('ALTER TABLE devices ADD COLUMN active INTEGER DEFAULT 1');
    await db.run('UPDATE devices SET active = 1 WHERE active IS NULL');
  }
  if (!cols.find((c: { name: string }) => c.name === 'agent_token')) {
    await db.exec('ALTER TABLE devices ADD COLUMN agent_token TEXT');
  }
  const deviceCols = (await db.all('PRAGMA table_info(devices)')) as { name: string }[];
  if (!deviceCols.find((c) => c.name === 'base_power_w')) {
    await db.exec('ALTER TABLE devices ADD COLUMN base_power_w REAL');
  }
  if (!deviceCols.find((c) => c.name === 'hostname')) {
    await db.exec('ALTER TABLE devices ADD COLUMN hostname TEXT');
  }
  if (!deviceCols.find((c) => c.name === 'interfaces')) {
    await db.exec('ALTER TABLE devices ADD COLUMN interfaces TEXT');
  }
  const groupDeviceCols = (await db.all('PRAGMA table_info(devices)')) as { name: string }[];
  if (!groupDeviceCols.find((c) => c.name === 'group_id')) {
    await db.exec('ALTER TABLE devices ADD COLUMN group_id INTEGER');
  }
  await db.exec('CREATE INDEX IF NOT EXISTS idx_devices_group ON devices(group_id)');
  if (!groupDeviceCols.find((c) => c.name === 'position')) {
    await db.exec('ALTER TABLE devices ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
    await db.exec('UPDATE devices SET position = id WHERE position = 0');
  }
  const viewSettings = (await db.all('PRAGMA table_info(settings)')) as { name: string }[];
  if (!viewSettings.find((c) => c.name === 'dashboard_view')) {
    await db.exec("ALTER TABLE settings ADD COLUMN dashboard_view TEXT DEFAULT 'grid'");
  }
  if (!viewSettings.find((c) => c.name === 'dashboard_card_size')) {
    await db.exec("ALTER TABLE settings ADD COLUMN dashboard_card_size TEXT DEFAULT 'normal'");
  }
  const rawCols = (await db.all('PRAGMA table_info(metrics_raw)')) as { name: string }[];
  for (const col of [
    'gpu_util REAL',
    'gpu_mem_pct REAL',
    'cpu_power_w REAL',
    'power_total_w REAL',
    'power_gpu0_w REAL',
    'power_gpu1_w REAL',
    'power_gpu2_w REAL',
    'power_gpu3_w REAL',
  ]) {
    const name = col.split(' ')[0];
    if (!rawCols.find((c) => c.name === name)) {
      await db.exec(`ALTER TABLE metrics_raw ADD COLUMN ${col}`);
    }
  }
  for (const table of ['metrics_hourly', 'metrics_daily']) {
    const aggCols = (await db.all(`PRAGMA table_info(${table})`)) as { name: string }[];
    for (const col of [
      'gpu_util_avg REAL',
      'gpu_util_max REAL',
      'gpu_mem_pct_max REAL',
      'cpu_power_w_avg REAL',
      'power_total_w_avg REAL',
      'power_total_w_max REAL',
      'net_rx_avg REAL',
      'net_tx_avg REAL',
      'power_kwh REAL',
      'online_s REAL',
      'cpu_power_kwh REAL',
      'gpu0_power_w_avg REAL',
      'gpu0_power_kwh REAL',
      'gpu1_power_w_avg REAL',
      'gpu1_power_kwh REAL',
      'gpu2_power_w_avg REAL',
      'gpu2_power_kwh REAL',
      'gpu3_power_w_avg REAL',
      'gpu3_power_kwh REAL',
    ]) {
      const name = col.split(' ')[0];
      if (!aggCols.find((c) => c.name === name)) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
      }
    }
  }
  const profileCols = (await db.all('PRAGMA table_info(profiles)')) as { name: string }[];
  for (const [srcCol, dstCol] of [
    ['reboot_command', 'reboot_action'],
    ['shutdown_command', 'poweroff_action'],
    ['hibernate_command', 'hibernate_action'],
  ] as const) {
    if (!profileCols.find((c) => c.name === srcCol)) continue;
    const allowed =
      srcCol === 'reboot_command' ? REBOOT_ACTIONS : srcCol === 'shutdown_command' ? POWER_OFF_ACTIONS : HIBERNATE_ACTIONS;
    const profiles = (await db.all(
      `SELECT id, ${srcCol} AS value FROM profiles WHERE ${srcCol} IS NOT NULL`
    )) as { id: number; value: string }[];
    for (const profile of profiles) {
      const value = String(profile.value).trim();
      if (!allowed.includes(value)) continue;
      await db.run(`UPDATE devices SET ${dstCol} = ? WHERE profile_id = ? AND ${dstCol} IS NULL`, [value, profile.id]);
    }
  }
  for (const col of ['reboot_command', 'shutdown_command', 'hibernate_command']) {
    if (profileCols.find((c) => c.name === col)) {
      try {
        await db.exec(`ALTER TABLE profiles DROP COLUMN ${col}`);
      } catch {
        // SQLite < 3.35 without DROP COLUMN — column stays, no longer read by the API
      }
    }
  }
  const actionsSchema = (await db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'device_actions'")) as {
    sql: string | null;
  } | undefined;
  if (actionsSchema?.sql && (!actionsSchema.sql.includes("'hibernate'") || !actionsSchema.sql.includes("'update'"))) {
    await db.exec(`
      BEGIN;
      CREATE TABLE device_actions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('reboot', 'shutdown', 'hibernate', 'update')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'acknowledged', 'started', 'done', 'failed')),
        output TEXT,
        created_at INTEGER NOT NULL,
        executed_at INTEGER,
        FOREIGN KEY (device_id) REFERENCES devices (id)
      );
      INSERT INTO device_actions_new (id, device_id, action, status, output, created_at, executed_at)
       SELECT id, device_id, action, status, output, created_at, executed_at FROM device_actions;
      DROP TABLE device_actions;
      ALTER TABLE device_actions_new RENAME TO device_actions;
      CREATE INDEX IF NOT EXISTS idx_device_actions_device_status ON device_actions(device_id, status);
      COMMIT;
    `);
  }

  const powerSettingsCols = (await db.all('PRAGMA table_info(settings)')) as { name: string }[];
  for (const col of ['poweroff_action', 'reboot_action', 'hibernate_action']) {
    if (!powerSettingsCols.find((c) => c.name === col)) {
      await db.exec(`ALTER TABLE settings ADD COLUMN ${col} TEXT`);
    }
  }
  const powerDeviceCols = (await db.all('PRAGMA table_info(devices)')) as { name: string }[];
  for (const col of [
    'poweroff_action',
    'reboot_action',
    'hibernate_action',
    'disable_power',
    'disable_ping',
    'disable_terminal',
    'disable_agent_update',
  ]) {
    if (!powerDeviceCols.find((c) => c.name === col)) {
      const def = col.startsWith('disable_') ? ' INTEGER DEFAULT 0' : ' TEXT';
      await db.exec(`ALTER TABLE devices ADD COLUMN ${col}${def}`);
    }
  }
  const actionsCols = (await db.all('PRAGMA table_info(device_actions)')) as { name: string }[];
  if (!actionsCols.find((c) => c.name === 'command')) {
    await db.exec('ALTER TABLE device_actions ADD COLUMN command TEXT');
  }

  const existing = await db.get('SELECT id FROM settings WHERE id = 1');
  if (!existing) {
    await db.run('INSERT INTO settings (id) VALUES (1)');
  }

  let encSecret: string;
  const storedKey =
    ((await db.get('SELECT app_encryption_key FROM settings WHERE id = 1')) as {
      app_encryption_key: string | null;
    } | undefined)?.app_encryption_key ?? '';
  if (process.env.APP_ENCRYPTION_KEY) {
    encSecret = process.env.APP_ENCRYPTION_KEY;
    if (!storedKey) {
      await db.run('UPDATE settings SET app_encryption_key = ? WHERE id = 1', encSecret);
    } else if (storedKey !== encSecret) {
      console.warn(
        'WARNING: APP_ENCRYPTION_KEY in the environment differs from the key stored in the database. ' +
          'SSH credentials encrypted with the other key are undecryptable.'
      );
    }
  } else if (storedKey) {
    encSecret = storedKey;
  } else {
    const generated = crypto.randomBytes(32).toString('hex');
    await db.run('UPDATE settings SET app_encryption_key = ? WHERE id = 1', generated);
    encSecret = generated;
  }
  const encKey = deriveKey(encSecret);

  await migrateLegacyCredentials(db, encKey);

  return { db, jwtSecret: process.env.JWT_SECRET || DEFAULT_JWT_SECRET, encKey };
}

// ---- Validation helpers ----

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidIp(value: string): boolean {
  try {
    ipaddr.parse(value.trim());
    return true;
  } catch {
    return false;
  }
}

function validateDeviceInput(body: Record<string, unknown>): string | null {
  if (!isNonEmptyString(body.name)) return 'Device name is required';
  if (body.name.length > 120) return 'Device name is too long';
  if (!isNonEmptyString(body.ip) || !isValidIp(body.ip)) return 'A valid IP address is required';
  if (body.mac !== undefined && body.mac !== null && body.mac !== '') {
    if (typeof body.mac !== 'string' || !MAC_RE.test(body.mac.trim())) return 'Invalid MAC address format';
  }
  if (typeof body.type !== 'string' || !DEVICE_TYPES.includes(body.type)) {
    return `Invalid device type (expected one of: ${DEVICE_TYPES.join(', ')})`;
  }
  if (body.hostname !== undefined && body.hostname !== null && body.hostname !== '') {
    const host = String(body.hostname).trim();
    if (!HOSTNAME_RE.test(host) || host.length > 120) return 'Invalid hostname format';
  }
  if (body.profile_id !== null && body.profile_id !== undefined) {
    if (!Number.isInteger(body.profile_id) || (body.profile_id as number) <= 0) return 'profile_id must be a positive integer';
  }
  if (body.broadcast_address !== null && body.broadcast_address !== undefined && body.broadcast_address !== '' && !isValidIp(String(body.broadcast_address))) {
    return 'Invalid broadcast address';
  }
  if (body.active !== undefined && ![0, 1, true, false].includes(body.active as never)) {
    return 'active must be a boolean';
  }
  if (body.base_power_w !== undefined && body.base_power_w !== null) {
    const n = Number(body.base_power_w);
    if (!Number.isFinite(n) || n < 0 || n > 10000) return 'base_power_w must be a number between 0 and 10000';
  }
  if (body.interfaces !== undefined && body.interfaces !== null) {
    const isEmpty = Array.isArray(body.interfaces)
      ? body.interfaces.length === 0
      : typeof body.interfaces === 'string' && body.interfaces.trim() === '';
    if (!isEmpty && normalizeStoredInterfaces(body.interfaces) === null) return 'Invalid interfaces payload';
  }
  const actionOverrides: [string, readonly string[]][] = [
    ['poweroff_action', POWER_OFF_ACTIONS],
    ['reboot_action', REBOOT_ACTIONS],
    ['hibernate_action', HIBERNATE_ACTIONS],
  ];
  for (const [field, allowed] of actionOverrides) {
    const value = body[field];
    if (value !== undefined && value !== null && value !== '') {
      if (!allowed.includes(String(value).trim())) {
        return `${field} must be one of: ${allowed.join(', ')}`;
      }
    }
  }
  for (const field of ['disable_power', 'disable_ping', 'disable_terminal', 'disable_agent_update']) {
    const value = body[field];
    if (value !== undefined && ![0, 1, true, false].includes(value as never)) {
      return `${field} must be a boolean`;
    }
  }
  return null;
}

function normalizeGroupId(value: unknown): number | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isInteger(value) || (value as number) <= 0) return 'invalid';
  return value as number;
}

function validateGroupInput(body: Record<string, unknown>, partial: boolean): string | null {
  if (!partial && !isNonEmptyString(body.name)) return 'Group name is required';
  if (body.name !== undefined && body.name !== null) {
    const name = String(body.name).trim();
    if (name.length === 0 || name.length > 60) return 'Group name must be between 1 and 60 characters';
  }
  if (body.icon !== undefined && !GROUP_ICONS.includes(body.icon as GroupIcon)) {
    return `Invalid group icon (expected one of: ${GROUP_ICONS.join(', ')})`;
  }
  if (body.color !== undefined && !GROUP_COLORS.includes(body.color as GroupColor)) {
    return `Invalid group color (expected one of: ${GROUP_COLORS.join(', ')})`;
  }
  return null;
}

async function nextGroupPosition(db: Database, groupId: number | null): Promise<number> {
  const row = groupId === null
    ? await db.get('SELECT COALESCE(MAX(position), -1) AS m FROM devices WHERE group_id IS NULL')
    : await db.get('SELECT COALESCE(MAX(position), -1) AS m FROM devices WHERE group_id = ?', [groupId]);
  return Number((row as { m: number } | undefined)?.m ?? -1) + 1;
}

async function reindexGroupPositions(db: Database, groupId: number | null): Promise<void> {
  const rows = (groupId === null
    ? await db.all('SELECT id FROM devices WHERE group_id IS NULL ORDER BY position ASC, id ASC')
    : await db.all('SELECT id FROM devices WHERE group_id = ? ORDER BY position ASC, id ASC', [groupId])) as { id: number }[];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] as { id: number };
    await db.run('UPDATE devices SET position = ? WHERE id = ?', [i, row.id]);
  }
}

function parseBasePowerW(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function resolveHostname(value: unknown, seed?: { payload: string; ts: number } | null): string | null {
  if (isNonEmptyString(value)) return String(value).trim();
  if (!seed) return null;
  try {
    const parsed = JSON.parse(seed.payload) as { hostname?: unknown };
    if (typeof parsed.hostname === 'string' && parsed.hostname.trim()) {
      const host = parsed.hostname.trim().slice(0, 120);
      if (HOSTNAME_RE.test(host)) return host;
    }
  } catch {
    return null;
  }
  return null;
}

function validateProfileInput(body: Record<string, unknown>, partial: boolean): string | null {
  if (!isNonEmptyString(body.name)) return 'Profile name is required';
  if (!isNonEmptyString(body.username)) return 'SSH username is required';
  if (body.auth_type !== 'password' && body.auth_type !== 'key') return 'auth_type must be "password" or "key"';
  if (!partial) {
    if (body.auth_type === 'password' && !isNonEmptyString(body.password)) return 'Password is required for password auth';
    if (body.auth_type === 'key' && !isNonEmptyString(body.private_key)) return 'Private key is required for key auth';
  }
  return null;
}

// ---- Agent metrics helpers ----

const RAW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const AGENT_RATE_WINDOW_MS = 60 * 1000;
const AGENT_RATE_MAX = 120;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const AGENT_STALE_MS = 90 * 1000;

export const DEFAULT_AGENT_INTERVAL_S = 30;
export const DEFAULT_UI_REFRESH_S = 30;
export const MIN_REFRESH_INTERVAL_S = 5;
export const MAX_REFRESH_INTERVAL_S = 3600;

async function getActionSettings(
  db: Database
): Promise<{ poweroff_action: string; reboot_action: string; hibernate_action: string }> {
  const row = (await db.get('SELECT poweroff_action, reboot_action, hibernate_action FROM settings WHERE id = 1')) as {
    poweroff_action: string | null;
    reboot_action: string | null;
    hibernate_action: string | null;
  } | undefined;
  return {
    poweroff_action: row?.poweroff_action && POWER_OFF_ACTIONS.includes(row.poweroff_action) ? row.poweroff_action : DEFAULT_POWER_OFF_ACTION,
    reboot_action: row?.reboot_action && REBOOT_ACTIONS.includes(row.reboot_action) ? row.reboot_action : DEFAULT_REBOOT_ACTION,
    hibernate_action: row?.hibernate_action && HIBERNATE_ACTIONS.includes(row.hibernate_action) ? row.hibernate_action : DEFAULT_HIBERNATE_ACTION,
  };
}

function parseActionOverride(value: unknown, allowed: readonly string[]): string | null {
  if (value === undefined || value === null || value === '') return null;
  const v = String(value).trim();
  return allowed.includes(v) ? v : null;
}

function parseDisableFlag(value: unknown): number {
  return value === true || value === 1 ? 1 : 0;
}

const agentStaleMsFor = (agentIntervalS: number) => Math.max(AGENT_STALE_MS, 3 * agentIntervalS * 1000);
const energyGapLimitMsFor = (agentIntervalS: number) =>
  Math.max(MAX_ENERGY_SEGMENT_MS, 5 * agentIntervalS * 1000);

export const AGENT_VERSION = '2.1';

export interface GpuProcess {
  pid: number;
  name: string;
  mem_mb: number;
}

export interface GpuMetrics {
  util: number | null;
  mem_used_mb: number;
  mem_total_mb: number;
  temp_c: number | null;
  power_w: number | null;
  name?: string | null;
  processes: GpuProcess[];
}

export interface AgentInterface {
  name: string;
  mac: string | null;
  kind: 'eth' | 'wifi' | null;
  ips: string[];
  broadcast: string | null;
}

export interface AgentSnapshot {
  hostname: string | null;
  cpu: number | null;
  load: [number, number, number];
  mem_total: number;
  mem_used: number;
  swap_total: number;
  swap_used: number;
  disks: { name: string; total: number; used: number }[];
  net_rx: number;
  net_tx: number;
  uptime_s: number | null;
  gpus: GpuMetrics[];
  cpu_power_w: number | null;
  power_total_w: number | null;
  interfaces?: AgentInterface[];
  agent_version: string | null;
  interval: number | null;
  ts: number;
  os_family?: 'linux' | 'macos' | null;
  os_name?: string | null;
  os_id?: string | null;
  kernel?: string | null;
  cpu_vendor?: string | null;
  cpu_model?: string | null;
  cpu_cores?: number | null;
  cpu_freq_ghz?: number | null;
}

export function sanitizeAgentInterfaces(value: unknown): AgentInterface[] {
  if (!Array.isArray(value)) return [];
  const out: AgentInterface[] = [];
  for (const entry of value.slice(0, 16)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const i = entry as Record<string, unknown>;
    const name = typeof i.name === 'string' ? i.name.slice(0, 32).replace(/[^\w.-]/g, '_') : '';
    if (!name) continue;
    const mac = typeof i.mac === 'string' && MAC_RE.test(i.mac.trim()) ? i.mac.trim().toUpperCase() : null;
    const kind = i.kind === 'eth' || i.kind === 'wifi' ? i.kind : null;
    const ips: string[] = [];
    if (Array.isArray(i.ips)) {
      for (const ip of i.ips.slice(0, 8)) {
        const s = typeof ip === 'string' ? ip.trim() : '';
        if (isValidIp(s) && !ips.includes(s)) ips.push(s);
      }
    }
    const broadcast = typeof i.broadcast === 'string' && isValidIp(i.broadcast) ? i.broadcast.trim() : null;
    out.push({ name, mac, kind, ips, broadcast });
  }
  return out;
}

export function normalizeStoredInterfaces(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  let arr: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      arr = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  const out = sanitizeAgentInterfaces(arr);
  return out.length > 0 ? JSON.stringify(out) : null;
}

export function parseStoredInterfaces(raw: unknown): AgentInterface[] | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const out = sanitizeAgentInterfaces(parsed);
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function hashAgentToken(token: string): string {
  return `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;
}

function generateAgentToken(): string {
  return `tk-${crypto.randomBytes(24).toString('hex')}`;
}

const CLAIM_TTL_MS = 15 * 60_000;
const CLAIM_SAMPLE_MAX = 24;

export interface AgentClaimRow {
  id: number;
  token_hash: string;
  created_at: number;
  expires_at: number;
  last_payload: string | null;
  last_seen: number | null;
  samples: string | null;
}

function generateClaimToken(): string {
  return `clm-${crypto.randomBytes(24).toString('hex')}`;
}

async function pruneExpiredClaims(db: Database): Promise<void> {
  await db.run('DELETE FROM agent_claims WHERE expires_at <= ?', Date.now());
}

async function getActiveClaimById(db: Database, id: string | number): Promise<AgentClaimRow | null> {
  const now = Date.now();
  const row = (await db.get('SELECT * FROM agent_claims WHERE id = ?', [id])) as AgentClaimRow | undefined;
  if (!row) return null;
  if (row.expires_at <= now) {
    await db.run('DELETE FROM agent_claims WHERE id = ?', [row.id]);
    return null;
  }
  return row;
}

async function getActiveClaimByToken(db: Database, token: string): Promise<AgentClaimRow | null> {
  const now = Date.now();
  const row = (await db.get(
    'SELECT * FROM agent_claims WHERE token_hash = ?',
    [hashAgentToken(token)]
  )) as AgentClaimRow | undefined;
  if (!row) return null;
  if (row.expires_at <= now) {
    await db.run('DELETE FROM agent_claims WHERE id = ?', [row.id]);
    return null;
  }
  return row;
}

function appendClaimSample(samplesRaw: string | null, powerW: number | null): string {
  let arr: number[] = [];
  if (samplesRaw) {
    try {
      const parsed = JSON.parse(samplesRaw) as unknown;
      if (Array.isArray(parsed)) arr = parsed.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    } catch {
      arr = [];
    }
  }
  if (powerW !== null) {
    arr.push(powerW);
    if (arr.length > CLAIM_SAMPLE_MAX) arr = arr.slice(-CLAIM_SAMPLE_MAX);
  }
  return JSON.stringify(arr);
}

export function parseClaimSamples(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  } catch {
    // corrupted samples, treat as empty
  }
  return [];
}

// ---- External API tokens ----

const API_OPERATIONS = ['status', 'start', 'stop', 'restart'] as const;
export type ApiOperation = (typeof API_OPERATIONS)[number];
const API_USAGE_RETENTION_MS = 30 * DAY_MS;
const API_RATE_WINDOW_MS = 60 * 1000;
const API_RATE_MAX = 60;

function generateApiToken(): string {
  return `ncapi-${crypto.randomBytes(24).toString('hex')}`;
}

function hashApiToken(token: string): string {
  return `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;
}

export async function pruneApiUsage(db: Database): Promise<void> {
  await db.run('DELETE FROM api_usage WHERE created_at < ?', Date.now() - API_USAGE_RETENTION_MS);
}

function parseApiPermissions(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ops = new Set<string>();
  for (const v of value) {
    if (typeof v !== 'string' || !(API_OPERATIONS as readonly string[]).includes(v)) return null;
    ops.add(v);
  }
  return [...ops];
}

function parseApiDeviceIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<number>();
  for (const v of value) {
    if (!Number.isInteger(v) || (v as number) <= 0) return null;
    ids.add(v as number);
  }
  return [...ids];
}

interface ApiTokenRow {
  id: number;
  label: string;
  token_hash: string;
  permissions: string;
  device_ids: string;
  enabled: number;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
}

const toPublicApiToken = (row: ApiTokenRow) => ({
  id: row.id,
  label: row.label,
  permissions: JSON.parse(row.permissions),
  device_ids: JSON.parse(row.device_ids),
  enabled: row.enabled === 1,
  created_at: row.created_at,
  expires_at: row.expires_at,
  last_used_at: row.last_used_at,
});

// ---- Shared machine actions (used by UI routes and the public API) ----

type PowerAction = 'reboot' | 'shutdown' | 'hibernate' | 'update';

const UNINSTALL_AGENT_COMMAND = [
  'systemctl disable --now openhomelab-agent 2>/dev/null',
  'rm -f /etc/systemd/system/openhomelab-agent.service',
  'systemctl daemon-reload 2>/dev/null',
  'pkill -f /usr/local/bin/openhomelab-agent 2>/dev/null',
  'rm -f /usr/local/bin/openhomelab-agent',
  'rm -rf /etc/openhomelab',
  '[ ! -f /usr/local/bin/openhomelab-agent ] && [ ! -f /etc/systemd/system/openhomelab-agent.service ] || exit 1',
].join('; ');

async function runProfileSshCommand(
  opts: { ip: string; username: string; password?: string; privateKey?: string },
  command: string
): Promise<string | null> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: opts.ip,
      username: opts.username,
      readyTimeout: 10_000,
      password: opts.password,
      privateKey: opts.privateKey,
    });
    const result = await ssh.execCommand(command);
    if (result.code !== 0) {
      const message = `Command failed with exit code ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`;
      ssh.dispose();
      return message;
    }
    ssh.dispose();
    return null;
  } catch (error) {
    return (error as Error).message || 'SSH connection failed';
  }
}

export async function executePowerAction(
  db: Database,
  encKey: Buffer,
  deviceId: number,
  action: PowerAction
): Promise<{ status: number; body: Record<string, unknown> }> {
  const device = (await db.get(`
    SELECT d.id, d.ip, d.agent_token, d.poweroff_action, d.reboot_action, d.hibernate_action,
           d.disable_power, d.disable_agent_update, ml.received_at AS last_seen,
           p.username, p.auth_type, p.password, p.private_key
    FROM devices d
    LEFT JOIN profiles p ON d.profile_id = p.id
    LEFT JOIN metrics_live ml ON ml.device_id = d.id
    WHERE d.id = ?
  `, deviceId)) as {
    id: number;
    ip: string;
    agent_token: string | null;
    poweroff_action: string | null;
    reboot_action: string | null;
    hibernate_action: string | null;
    disable_power: number;
    disable_agent_update: number;
    last_seen: number | null;
    username: string | null;
    auth_type: string | null;
    password: string | null;
    private_key: string | null;
  } | undefined;

  if (!device) return { status: 404, body: { error: 'Device not found' } };
  if (action !== 'update' && device.disable_power) {
    return { status: 403, body: { error: 'Power actions are disabled for this device' } };
  }
  if (action === 'update' && device.disable_agent_update) {
    return { status: 403, body: { error: 'Agent updates are disabled for this device' } };
  }

  const actionSettings = await getActionSettings(db);
  const commandToRun = action === 'update'
    ? null
    : action === 'reboot'
      ? device.reboot_action || actionSettings.reboot_action
      : action === 'shutdown'
        ? device.poweroff_action || actionSettings.poweroff_action
        : device.hibernate_action || actionSettings.hibernate_action;

  const { agentIntervalS } = await getRefreshSettings(db);
  const agentStaleMs = agentStaleMsFor(agentIntervalS);
  const agentOnline = !!device.agent_token
    && device.last_seen !== null
    && Date.now() - (device.last_seen as number) < agentStaleMs;
  if (agentOnline) {
    const nowTs = Date.now();
    await db.run(
      "DELETE FROM device_actions WHERE device_id = ? AND (status IN ('done', 'failed') OR created_at < ?)",
      [device.id, nowTs - 24 * HOUR_MS]
    );
    await db.run(
      "INSERT INTO device_actions (device_id, action, command, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
      [device.id, action, commandToRun ?? null, nowTs]
    );
    return { status: 200, body: { success: true, channel: 'agent' } };
  }

  if (action === 'update' && !agentOnline) {
    return { status: 400, body: { error: 'Agent must be online to update itself' } };
  }

  if (!device.username) return { status: 400, body: { error: 'No SSH profile assigned' } };

  const password = decryptCredential(device.password, encKey) ?? undefined;
  const privateKey = decryptCredential(device.private_key, encKey) ?? undefined;

  const error = await runProfileSshCommand({ ip: device.ip, username: device.username, password, privateKey }, commandToRun);
  if (error) {
    console.error('SSH Error:', error);
    return { status: 500, body: { error } };
  }
  return { status: 200, body: { success: true, channel: 'ssh' } };
}

export async function wakeDevice(
  db: Database,
  deviceId: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  const device = (await db.get(
    'SELECT mac, ip, broadcast_address, disable_power FROM devices WHERE id = ?',
    [deviceId]
  )) as { mac: string | null; ip: string; broadcast_address: string | null; disable_power: number } | undefined;
  if (!device) return { status: 404, body: { error: 'Device not found' } };
  if (device.disable_power) return { status: 403, body: { error: 'Power actions are disabled for this device' } };
  if (!device.mac) return { status: 400, body: { error: 'MAC address not found' } };

  const addresses = new Set<string>();
  for (const addr of getBroadcastAddresses()) addresses.add(addr);
  const ipBroadcast = computeBroadcastFromIp(device.ip);
  if (ipBroadcast) addresses.add(ipBroadcast);
  if (device.broadcast_address) addresses.add(device.broadcast_address);

  let lastError: Error | null = null;
  let sent = 0;
  for (const addr of addresses) {
    try {
      await sendWoL(device.mac, addr);
      sent += 1;
      console.log(`WOL packet sent to ${device.mac} via ${addr}`);
    } catch (error) {
      lastError = error as Error;
      console.warn(`WOL broadcast to ${addr} failed:`, error);
    }
  }

  if (sent === 0) {
    console.error('WOL Error:', lastError);
    return { status: 500, body: { error: 'Failed to send WOL packet' } };
  }
  return { status: 200, body: { success: true, broadcastAddresses: sent } };
}

const ICMP_UNAVAILABLE_PATTERN = /permission denied|operation not permitted|eperm|eacces/i;
const ICMP_UNAVAILABLE_MESSAGE =
  'ICMP pings are not available in this environment. Run the container with host networking and the NET_RAW capability.';

class IcmpUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IcmpUnavailableError';
  }
}

let icmpUnavailableWarned = false;

function detectIcmpUnavailable(text: string): boolean {
  return ICMP_UNAVAILABLE_PATTERN.test(text);
}

function warnIcmpUnavailableOnce(context: string): void {
  if (icmpUnavailableWarned) return;
  icmpUnavailableWarned = true;
  console.warn(`ICMP pings unavailable (${context}): ${ICMP_UNAVAILABLE_MESSAGE}`);
}

async function icmpProbe(
  ip: string,
  timeoutS: number,
  extra?: string[]
): Promise<{ alive: boolean; time: number | null; output: string }> {
  try {
    const result = await ping.promise.probe(ip, {
      timeout: timeoutS,
      ...(extra ? { extra } : {}),
    });
    if (detectIcmpUnavailable(result.output ?? '')) {
      throw new IcmpUnavailableError((result.output ?? '').trim());
    }
    return { alive: result.alive, time: result.time ?? null, output: result.output ?? '' };
  } catch (err) {
    if (err instanceof IcmpUnavailableError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (detectIcmpUnavailable(message)) throw new IcmpUnavailableError(message);
    return { alive: false, time: null, output: '' };
  }
}

async function probeDeviceStatus(ip: string): Promise<{ online: boolean; latency_ms: number | null }> {
  try {
    const result = await icmpProbe(ip, 1);
    return { online: result.alive, latency_ms: result.time };
  } catch (err) {
    if (err instanceof IcmpUnavailableError) warnIcmpUnavailableOnce('probeDeviceStatus');
    return { online: false, latency_ms: null };
  }
}

function toNum(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNullableNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return toNum(value);
}

function toClampedStr(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/[\\"]/g, '');
  return trimmed ? trimmed.slice(0, maxLen) : null;
}

function toOsFamily(value: unknown): 'linux' | 'macos' | null {
  return value === 'linux' || value === 'macos' ? value : null;
}

export function sanitizeAgentPayload(body: Record<string, unknown>, receivedAt: number): AgentSnapshot | null {
  const cpu = toNum(body.cpu);
  if (cpu === null) return null;

  const memTotal = Math.max(0, toNum(body.mem_total) ?? 0);
  const memUsed = Math.min(memTotal, Math.max(0, toNum(body.mem_used) ?? 0));
  const swapTotal = Math.max(0, toNum(body.swap_total) ?? 0);
  const swapUsed = Math.min(swapTotal, Math.max(0, toNum(body.swap_used) ?? 0));

  const loadIn = Array.isArray(body.load) ? body.load : [];
  const load: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3 && i < loadIn.length; i += 1) {
    const v = toNum(loadIn[i]);
    if (v !== null && v >= 0) load[i] = v;
  }

  const rawDisks = Array.isArray(body.disks) ? body.disks : [];
  const disks: { name: string; total: number; used: number }[] = [];
  for (const entry of rawDisks.slice(0, 16)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const d = entry as Record<string, unknown>;
    const name = typeof d.name === 'string' ? d.name.slice(0, 64).replace(/[^\w.-]/g, '_') : '';
    const total = toNum(d.total);
    const used = toNum(d.used);
    if (name && total !== null && used !== null && total > 0 && used >= 0) {
      disks.push({ name, total: Math.max(0, total), used: Math.min(total, Math.max(0, used)) });
    }
  }

  const hostname = typeof body.hostname === 'string' ? body.hostname.slice(0, 128) : null;
  const agentVersion = typeof body.agent_version === 'string' && body.agent_version.length <= 32
    ? body.agent_version
    : null;
  const uptimeS = toNum(body.uptime_s);

  const rawGpus = Array.isArray(body.gpus) ? body.gpus : [];
  const gpus: GpuMetrics[] = [];
  for (const entry of rawGpus) {
    if (gpus.length >= 8) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const g = entry as Record<string, unknown>;
    const utilIn = toNullableNum(g.util);
    const memTotalMb = Math.max(0, toNum(g.mem_total_mb) ?? 0);
    const memUsedMb = Math.min(memTotalMb, Math.max(0, toNum(g.mem_used_mb) ?? 0));
    const tempC = toNullableNum(g.temp_c);
    const powerW = toNullableNum(g.power_w);
    const rawProcs = Array.isArray(g.processes) ? g.processes : [];
    const processes: GpuProcess[] = [];
    for (const entry of rawProcs) {
      if (processes.length >= 32) break;
      if (typeof entry !== 'object' || entry === null) continue;
      const p = entry as Record<string, unknown>;
      const pid = toNum(p.pid);
      const name = typeof p.name === 'string' ? p.name.slice(0, 64).replace(/[^\w@.-]/g, '_') : '';
      const memMb = toNum(p.mem_mb);
      if (pid !== null && pid > 0 && name) {
        processes.push({ pid: Math.floor(pid), name, mem_mb: Math.round(Math.max(0, memMb ?? 0)) });
      }
    }
    const gpuName = toClampedStr(g.name, 128) ?? undefined;
    gpus.push({
      util: utilIn !== null ? Math.min(100, Math.max(0, utilIn)) : null,
      mem_used_mb: memUsedMb,
      mem_total_mb: memTotalMb,
      temp_c: tempC !== null && tempC >= 0 ? tempC : null,
      power_w: powerW !== null && powerW >= 0 ? Math.round(powerW * 10) / 10 : null,
      name: gpuName ?? null,
      processes,
    });
  }

  const intervalIn = toNum(body.interval);
  const agentInterval = intervalIn !== null && Number.isInteger(intervalIn) && intervalIn >= 1 && intervalIn <= 86400
    ? intervalIn
    : null;

  const cpuPowerW = toNullableNum(body.cpu_power_w);
  let powerTotalW: number | null = null;
  if (cpuPowerW !== null && cpuPowerW >= 0) powerTotalW = cpuPowerW;
  for (const g of gpus) {
    if (g.power_w !== null) powerTotalW = (powerTotalW ?? 0) + g.power_w;
  }
  powerTotalW = powerTotalW !== null ? Math.round(powerTotalW * 10) / 10 : null;

  const osIdRaw = toClampedStr(body.os_id, 32);
  const cpuCoresIn = toNum(body.cpu_cores);
  const cpuFreqIn = toNullableNum(body.cpu_freq_ghz);

  return {
    hostname: hostname || null,
    cpu: Math.min(100, Math.max(0, cpu)),
    load,
    mem_total: memTotal,
    mem_used: memUsed,
    swap_total: swapTotal,
    swap_used: swapUsed,
    disks,
    net_rx: Math.max(0, toNum(body.net_rx) ?? 0),
    net_tx: Math.max(0, toNum(body.net_tx) ?? 0),
    uptime_s: uptimeS !== null && uptimeS >= 0 ? uptimeS : null,
    gpus,
    cpu_power_w: cpuPowerW !== null && cpuPowerW >= 0 ? Math.round(cpuPowerW * 10) / 10 : null,
    power_total_w: powerTotalW,
    interfaces: sanitizeAgentInterfaces(body.interfaces),
    agent_version: agentVersion,
    interval: agentInterval,
    ts: receivedAt,
    os_family: toOsFamily(body.os_family),
    os_name: toClampedStr(body.os_name, 128),
    os_id: osIdRaw ? osIdRaw.replace(/[^\w.-]/g, '_').toLowerCase() : null,
    kernel: toClampedStr(body.kernel, 64),
    cpu_vendor: toClampedStr(body.cpu_vendor, 32),
    cpu_model: toClampedStr(body.cpu_model, 128),
    cpu_cores:
      cpuCoresIn !== null && Number.isInteger(cpuCoresIn) && cpuCoresIn >= 1 && cpuCoresIn <= 4096 ? cpuCoresIn : null,
    cpu_freq_ghz:
      cpuFreqIn !== null && cpuFreqIn > 0 && cpuFreqIn <= 200 ? Math.round(cpuFreqIn * 100) / 100 : null,
  };
}

function computeGpuUtil(snap: AgentSnapshot): number | null {
  let max: number | null = null;
  for (const g of snap.gpus) {
    if (g.util !== null && (max === null || g.util > max)) max = g.util;
  }
  return max;
}

function computeGpuMemPct(snap: AgentSnapshot): number | null {
  let max: number | null = null;
  for (const g of snap.gpus) {
    if (g.mem_total_mb > 0) {
      const pct = (g.mem_used_mb / g.mem_total_mb) * 100;
      if (max === null || pct > max) max = pct;
    }
  }
  return max;
}

function computeMemPct(snap: AgentSnapshot): number | null {
  return snap.mem_total > 0 ? (snap.mem_used / snap.mem_total) * 100 : null;
}

function computeDiskUsedPct(snap: AgentSnapshot): number | null {
  let max: number | null = null;
  for (const d of snap.disks) {
    const pct = (d.used / d.total) * 100;
    if (max === null || pct > max) max = pct;
  }
  return max;
}

const HISTORY_RANGES: Record<string, { fromMs: number; bucketMs: number; source: 'raw' | 'hourly' | 'daily' }> = {
  '1h': { fromMs: HOUR_MS, bucketMs: 30 * 1000, source: 'raw' },
  '6h': { fromMs: 6 * HOUR_MS, bucketMs: 5 * 60 * 1000, source: 'raw' },
  '24h': { fromMs: DAY_MS, bucketMs: 10 * 60 * 1000, source: 'raw' },
  '7d': { fromMs: 7 * DAY_MS, bucketMs: HOUR_MS, source: 'raw' },
  '30d': { fromMs: 30 * DAY_MS, bucketMs: HOUR_MS, source: 'hourly' },
  '1y': { fromMs: 365 * DAY_MS, bucketMs: DAY_MS, source: 'daily' },
};

const FLEET_POWER_RANGES: Record<string, { fromMs: number; bucketMs: number; table: string; powerCol: string; tsCol: string }> = {
  '1h': { fromMs: HOUR_MS, bucketMs: MINUTE_MS, table: 'metrics_raw', powerCol: 'power_total_w', tsCol: 'ts' },
  '24h': { fromMs: DAY_MS, bucketMs: 30 * MINUTE_MS, table: 'metrics_raw', powerCol: 'power_total_w', tsCol: 'ts' },
  '30d': { fromMs: 30 * DAY_MS, bucketMs: DAY_MS, table: 'metrics_hourly', powerCol: 'power_total_w_avg', tsCol: 'bucket' },
};

// ---- Metrics aggregation & retention job ----

const GPU_POWER_COLUMNS = ['power_gpu0_w', 'power_gpu1_w', 'power_gpu2_w', 'power_gpu3_w'] as const;

function energyKwhExpr(powerCol: string, prevCol: string, gapMs: number): string {
  return `COALESCE(SUM(CASE WHEN ts - prev_ts > 0 AND ts - prev_ts <= ${gapMs} AND ${powerCol} IS NOT NULL AND ${prevCol} IS NOT NULL THEN (${powerCol} + ${prevCol}) * (ts - prev_ts) / 2.0 ELSE 0 END), 0) / 3600000000`;
}

function buildBucketAggregation(table: string, divisorMs: number, gapMs: number): string {
  const selectEnergy = [
    `${energyKwhExpr('power_total_w', 'prev_total_w', gapMs)} AS power_kwh`,
    `COALESCE(SUM(CASE WHEN ts - prev_ts > 0 AND ts - prev_ts <= ${gapMs} AND power_total_w IS NOT NULL THEN ts - prev_ts ELSE 0 END), 0) / 1000.0 AS online_s`,
    `${energyKwhExpr('cpu_power_w', 'prev_cpu_w', gapMs)} AS cpu_power_kwh`,
  ];
  GPU_POWER_COLUMNS.forEach((col, i) => {
    selectEnergy.push(`AVG(${col}) AS gpu${i}_power_w_avg`);
    selectEnergy.push(`${energyKwhExpr(col, `prev_gpu${i}_w`, gapMs)} AS gpu${i}_power_kwh`);
  });

  const updateClauses = [
    'cpu_avg = excluded.cpu_avg',
    'cpu_max = excluded.cpu_max',
    'mem_pct_avg = excluded.mem_pct_avg',
    'mem_pct_max = excluded.mem_pct_max',
    'load1_avg = excluded.load1_avg',
    'load1_max = excluded.load1_max',
    'net_rx_max = excluded.net_rx_max',
    'net_tx_max = excluded.net_tx_max',
    'net_rx_avg = excluded.net_rx_avg',
    'net_tx_avg = excluded.net_tx_avg',
    'disk_used_pct_max = excluded.disk_used_pct_max',
    'gpu_util_avg = excluded.gpu_util_avg',
    'gpu_util_max = excluded.gpu_util_max',
    'gpu_mem_pct_max = excluded.gpu_mem_pct_max',
    'cpu_power_w_avg = excluded.cpu_power_w_avg',
    'power_total_w_avg = excluded.power_total_w_avg',
    'power_total_w_max = excluded.power_total_w_max',
    'power_kwh = excluded.power_kwh',
    'online_s = excluded.online_s',
    'cpu_power_kwh = excluded.cpu_power_kwh',
  ];
  GPU_POWER_COLUMNS.forEach((_, i) => {
    updateClauses.push(`gpu${i}_power_w_avg = excluded.gpu${i}_power_w_avg`);
    updateClauses.push(`gpu${i}_power_kwh = excluded.gpu${i}_power_kwh`);
  });

  return `
    WITH base AS (
      SELECT device_id, (ts / ${divisorMs}) * ${divisorMs} AS bucket, ts, cpu, mem_pct, load1, net_rx, net_tx, disk_used_pct, gpu_util, gpu_mem_pct,
             cpu_power_w, power_total_w, ${GPU_POWER_COLUMNS.join(', ')}
      FROM metrics_raw WHERE ts < ?
    ),
    lagged AS (
      SELECT base.*,
             LAG(ts) OVER w AS prev_ts,
             LAG(cpu_power_w) OVER w AS prev_cpu_w,
             LAG(power_total_w) OVER w AS prev_total_w,
             ${GPU_POWER_COLUMNS.map((_, i) => `LAG(power_gpu${i}_w) OVER w AS prev_gpu${i}_w`).join(', ')}
      FROM base
      WINDOW w AS (PARTITION BY device_id, bucket ORDER BY ts)
    )
    INSERT INTO ${table} (device_id, bucket, cpu_avg, cpu_max, mem_pct_avg, mem_pct_max, load1_avg, load1_max, net_rx_max, net_tx_max, net_rx_avg, net_tx_avg, disk_used_pct_max, gpu_util_avg, gpu_util_max, gpu_mem_pct_max, cpu_power_w_avg, power_total_w_avg, power_total_w_max, power_kwh, online_s, cpu_power_kwh, ${GPU_POWER_COLUMNS.map((_, i) => `gpu${i}_power_w_avg, gpu${i}_power_kwh`).join(', ')})
    SELECT device_id, bucket, AVG(cpu), MAX(cpu), AVG(mem_pct), MAX(mem_pct), AVG(load1), MAX(load1), MAX(net_rx), MAX(net_tx), AVG(net_rx), AVG(net_tx), MAX(disk_used_pct), AVG(gpu_util), MAX(gpu_util), MAX(gpu_mem_pct),
           AVG(cpu_power_w), AVG(power_total_w), MAX(power_total_w), ${selectEnergy.join(', ')}
    FROM lagged GROUP BY device_id, bucket
    ON CONFLICT(device_id, bucket) DO UPDATE SET ${updateClauses.join(', ')}
  `;
}

export async function aggregateMetrics(db: Database, agentIntervalS = DEFAULT_AGENT_INTERVAL_S): Promise<void> {
  const now = Date.now();
  const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const gapMs = energyGapLimitMsFor(agentIntervalS);

  await db.run(buildBucketAggregation('metrics_hourly', 3600000, gapMs), [hourStart]);
  await db.run(buildBucketAggregation('metrics_daily', 86400000, gapMs), [dayStart]);

  await db.run('DELETE FROM metrics_raw WHERE ts < ?', now - RAW_RETENTION_MS);
}

export async function settleStaleActions(db: Database, agentIntervalS = DEFAULT_AGENT_INTERVAL_S): Promise<void> {
  await db.run(
    `UPDATE device_actions SET status = 'done', output = 'device offline - action completed'
     WHERE status IN ('acknowledged', 'started')
       AND executed_at IS NOT NULL
       AND created_at > ?
       AND (executed_at + ?) < ?
       AND device_id NOT IN (
         SELECT device_id FROM metrics_live WHERE received_at >= device_actions.executed_at
       )`,
    [Date.now() - 24 * HOUR_MS, agentStaleMsFor(agentIntervalS), Date.now()]
  );
}

export function startMetricsJob(ctx: AppContext, intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  const timer = setInterval(() => {
    getRefreshSettings(ctx.db)
      .then(({ agentIntervalS }) => aggregateMetrics(ctx.db, agentIntervalS))
      .catch((err) => console.error('Metrics aggregation failed:', err));
    getRefreshSettings(ctx.db)
      .then(({ agentIntervalS }) => settleStaleActions(ctx.db, agentIntervalS))
      .catch((err) => console.error('Action settlement failed:', err));
    pruneApiUsage(ctx.db).catch((err) => console.error('API usage prune failed:', err));
  }, intervalMs);
  return timer;
}

// ---- Energy integration ----

const RAW_SAMPLE_INTERVAL_MS = 30 * 1000;
// Gaps wider than a few sample intervals mean the agent was offline: charge no energy across them
const MAX_ENERGY_SEGMENT_MS = 5 * RAW_SAMPLE_INTERVAL_MS;

function integrateSamples(samples: { ts: number; w: number }[], gapMs: number): { kwh: number; coveredMs: number } {
  let kwh = 0;
  let coveredMs = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const dtMs = samples[i].ts - samples[i - 1].ts;
    if (dtMs <= 0 || dtMs > gapMs) continue;
    kwh += ((samples[i].w + samples[i - 1].w) / 2) * (dtMs / HOUR_MS) / 1000;
    coveredMs += dtMs;
  }
  return { kwh, coveredMs };
}

function basePowerKwh(baseW: number | null, onlineS: number): number {
  return ((baseW ?? 0) * onlineS) / 3.6e6;
}

export interface EnergyBreakdown {
  totalKwh: number;
  cpuKwh: number;
  cpuAvgW: number | null;
  gpuKwh: (number | null)[];
  gpuAvgW: (number | null)[];
  onlineS: number;
}

export async function computeEnergyBreakdown(
  db: Database,
  spec: { fromMs: number; source: 'raw' | 'hourly' | 'daily' },
  deviceId?: number,
  agentIntervalS = DEFAULT_AGENT_INTERVAL_S
): Promise<EnergyBreakdown> {
  const nowTs = Date.now();
  const gapMs = energyGapLimitMsFor(agentIntervalS);
  if (spec.source === 'raw') {
    const rows = (await db.all(
      `SELECT device_id, ts, power_total_w, cpu_power_w, power_gpu0_w, power_gpu1_w, power_gpu2_w, power_gpu3_w
       FROM metrics_raw
       WHERE ${deviceId !== undefined ? 'device_id = ? AND ' : ''}ts >= ?
       ORDER BY device_id, ts`,
      deviceId !== undefined ? [deviceId, nowTs - spec.fromMs] : [nowTs - spec.fromMs]
    )) as {
      device_id: number;
      ts: number;
      power_total_w: number | null;
      cpu_power_w: number | null;
      power_gpu0_w: number | null;
      power_gpu1_w: number | null;
      power_gpu2_w: number | null;
      power_gpu3_w: number | null;
    }[];

    const byDevice = new Map<number, typeof rows>();
    for (const r of rows) {
      const arr = byDevice.get(r.device_id) ?? [];
      arr.push(r);
      byDevice.set(r.device_id, arr);
    }

    let totalKwh = 0;
    let cpuKwh = 0;
    let cpuCoveredMs = 0;
    let onlineS = 0;
    const gpuTotals = [0, 1, 2, 3].map(() => ({ kwh: 0, coveredMs: 0 }));

    for (const deviceRows of byDevice.values()) {
      const totalSamples: { ts: number; w: number }[] = [];
      const cpuSamples: { ts: number; w: number }[] = [];
      const gpuSamples: { ts: number; w: number }[][] = [[], [], [], []];
      for (const r of deviceRows) {
        if (r.power_total_w !== null) totalSamples.push({ ts: r.ts, w: r.power_total_w });
        if (r.cpu_power_w !== null) cpuSamples.push({ ts: r.ts, w: r.cpu_power_w });
        for (let i = 0; i < 4; i += 1) {
          const v = r[`power_gpu${i}_w`] as number | null;
          if (v !== null) gpuSamples[i].push({ ts: r.ts, w: v });
        }
      }

      const total = integrateSamples(totalSamples, gapMs);
      totalKwh += total.kwh;
      onlineS += total.coveredMs / 1000;
      const cpu = integrateSamples(cpuSamples, gapMs);
      cpuKwh += cpu.kwh;
      cpuCoveredMs += cpu.coveredMs;
      for (let i = 0; i < 4; i += 1) {
        const g = integrateSamples(gpuSamples[i], gapMs);
        gpuTotals[i].kwh += g.kwh;
        gpuTotals[i].coveredMs += g.coveredMs;
      }
    }

    return {
      totalKwh,
      cpuKwh,
      cpuAvgW: cpuCoveredMs > 0 ? (cpuKwh * 3.6e9) / cpuCoveredMs : null,
      gpuKwh: gpuTotals.map((g) => (g.kwh > 0 ? g.kwh : null)),
      gpuAvgW: gpuTotals.map((g) => (g.coveredMs > 0 && g.kwh > 0 ? (g.kwh * 3.6e9) / g.coveredMs : null)),
      onlineS,
    };
  }

  const hoursPerBucket = spec.source === 'hourly' ? 1 : 24;
  const legacySeconds = hoursPerBucket * 3600;
  const row = (await db.get(
    `SELECT
       COALESCE(SUM(power_kwh), 0) AS new_total,
       COALESCE(SUM(CASE WHEN power_kwh IS NULL AND power_total_w_avg IS NOT NULL THEN power_total_w_avg * ${hoursPerBucket} / 1000.0 ELSE 0 END), 0) AS legacy_total,
       COALESCE(SUM(cpu_power_kwh), 0) AS new_cpu,
       COALESCE(SUM(CASE WHEN cpu_power_kwh IS NULL AND power_kwh IS NULL AND cpu_power_w_avg IS NOT NULL THEN cpu_power_w_avg * ${hoursPerBucket} / 1000.0 ELSE 0 END), 0) AS legacy_cpu,
       COALESCE(SUM(gpu0_power_kwh), 0) AS gpu0,
       COALESCE(SUM(gpu1_power_kwh), 0) AS gpu1,
       COALESCE(SUM(gpu2_power_kwh), 0) AS gpu2,
       COALESCE(SUM(gpu3_power_kwh), 0) AS gpu3,
       COALESCE(SUM(CASE WHEN power_kwh IS NOT NULL THEN online_s ELSE ${legacySeconds} END), 0) AS online_s
     FROM metrics_${spec.source}
     WHERE ${deviceId !== undefined ? 'device_id = ? AND ' : ''}bucket >= ?`,
    deviceId !== undefined ? [deviceId, nowTs - spec.fromMs] : [nowTs - spec.fromMs]
  )) as {
    new_total: number;
    legacy_total: number;
    new_cpu: number;
    legacy_cpu: number;
    gpu0: number;
    gpu1: number;
    gpu2: number;
    gpu3: number;
    online_s: number;
  };

  const totalKwh = row.new_total + row.legacy_total;
  const cpuKwh = row.new_cpu + row.legacy_cpu;
  const gpus = [row.gpu0, row.gpu1, row.gpu2, row.gpu3];
  const toAvgW = (kwh: number): number | null => (row.online_s > 0 && kwh > 0 ? (kwh * 3.6e9) / (row.online_s * 1000) : null);

  return {
    totalKwh,
    cpuKwh,
    cpuAvgW: toAvgW(cpuKwh),
    gpuKwh: gpus.map((v) => (v > 0 ? v : null)),
    gpuAvgW: gpus.map(toAvgW),
    onlineS: row.online_s,
  };
}

// ---- Network scanner ----

const SCAN_MAX_HOSTS = 256;
const SCAN_JOB_TTL_MS = 10 * 60 * 1000;
const SCAN_PING_TIMEOUT_S = 1;
const SCAN_PORT_TIMEOUT_MS = 500;
const SCAN_BANNER_TIMEOUT_MS = 900;
const SCAN_CONCURRENCY = 25;
const SCAN_RATE_WINDOW_MS = 60 * 1000;
const SCAN_RATE_MAX = 5;
const DEFAULT_SCAN_PORTS = [
  21, 22, 23, 53, 80, 110, 111, 135, 139, 443, 445, 515, 587, 631, 993, 995, 1080, 1433,
  1521, 2049, 3306, 3389, 5432, 5900, 6379, 8080, 8443,
];

const SCAN_PORT_NAMES: Record<number, string> = {
  21: 'ftp',
  22: 'ssh',
  23: 'telnet',
  53: 'dns',
  80: 'http',
  110: 'pop3',
  111: 'rpcbind',
  135: 'msrpc',
  139: 'netbios',
  443: 'https',
  445: 'smb',
  515: 'lpd',
  587: 'smtp',
  631: 'ipp',
  993: 'imaps',
  995: 'pop3s',
  1080: 'socks',
  1433: 'mssql',
  1521: 'oracle',
  2049: 'nfs',
  3306: 'mysql',
  3389: 'rdp',
  5432: 'postgres',
  5900: 'vnc',
  6379: 'redis',
  8080: 'http-alt',
  8443: 'https-alt',
};

interface ScanPortInfo {
  port: number;
  service: string;
  banner: string | null;
}

interface ScannedHost {
  ip: string;
  online: boolean;
  hostname: string | null;
  mac: string | null;
  vendor: string | null;
  ports: ScanPortInfo[];
  managed_device_id: number | null;
  managed_device_name: string | null;
}

interface ScanJob {
  id: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  total: number;
  scannedCount: number;
  hosts: ScannedHost[];
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
  errorCode: string | null;
  cancelled: boolean;
  ips: string[];
  ports: number[];
}

function ip4ToDecimal(ip: ipaddr.IPv4): number {
  const [a, b, c, d] = ip.octets;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function decimalToIp4(n: number): string {
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

function detectLocalRange(): { startIp: string | null; endIp: string | null } {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.internal || info.family !== 'IPv4' || !info.netmask) continue;
      try {
        const ip = ipaddr.parse(info.address);
        const mask = ipaddr.parse(info.netmask);
        if (ip.kind() !== 'ipv4' || mask.kind() !== 'ipv4') continue;
        const [a, b] = (ip as ipaddr.IPv4).octets;
        if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) continue;
        const network = (ip4ToDecimal(ip as ipaddr.IPv4) & ip4ToDecimal(mask as ipaddr.IPv4)) >>> 0;
        const broadcast = (network | ~ip4ToDecimal(mask as ipaddr.IPv4)) >>> 0;
        return { startIp: decimalToIp4(network), endIp: decimalToIp4(broadcast) };
      } catch {
        continue;
      }
    }
  }
  return { startIp: null, endIp: null };
}

function isPrivateIpv4(ip: ipaddr.IPv4): boolean {
  const [a, b] = ip.octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 127;
}

export function parseScanRange(startIp: string, endIp: string): string[] | string {
  let start: ipaddr.IPv4;
  let end: ipaddr.IPv4;
  try {
    const parsedStart = ipaddr.parse(startIp.trim());
    if (parsedStart.kind() !== 'ipv4') return 'Only IPv4 addresses are supported';
    start = parsedStart as ipaddr.IPv4;
  } catch {
    return 'A valid start IP is required';
  }
  try {
    const parsedEnd = ipaddr.parse(endIp.trim());
    if (parsedEnd.kind() !== 'ipv4') return 'Only IPv4 addresses are supported';
    end = parsedEnd as ipaddr.IPv4;
  } catch {
    return 'A valid end IP is required';
  }
  if (!isPrivateIpv4(start) || !isPrivateIpv4(end)) return 'Only private network ranges are supported (10/8, 172.16/12, 192.168/16, 169.254/16, 127/8)';
  const startDec = ip4ToDecimal(start);
  const endDec = ip4ToDecimal(end);
  if (startDec > endDec) return 'The end IP must be after the start IP';
  if (endDec - startDec + 1 > SCAN_MAX_HOSTS) return `Range too large, maximum ${SCAN_MAX_HOSTS} IPs per scan`;
  const ips: string[] = [];
  for (let i = startDec; i <= endDec; i++) {
    ips.push(decimalToIp4(i));
  }
  return ips;
}

function readArpTable(): Map<string, string> {
  const entries = new Map<string, string>();
  try {
    const lines = fs.readFileSync('/proc/net/arp', 'utf8').split('\n');
    for (const line of lines.slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4 && parts[3] !== '00:00:00:00:00:00') {
        entries.set(parts[0], parts[3].toLowerCase());
      }
    }
  } catch {
    // ARP table unavailable on this platform
  }
  return entries;
}

function reverseLookup(ip: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(null), SCAN_BANNER_TIMEOUT_MS + 400);
    dns
      .reverse(ip)
      .then((names) => {
        clearTimeout(timer);
        finish(names.length > 0 ? names[0] : null);
      })
      .catch(() => {
        clearTimeout(timer);
        finish(null);
      });
  });
}

function grabBanner(ip: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host: ip, port });
    socket.setTimeout(SCAN_BANNER_TIMEOUT_MS);
    let buffer = '';
    const done = (value: string | null) => {
      if (!settled) {
        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      }
    };
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      if (port === 80 && buffer.includes('\r\n\r\n')) {
        const header = buffer.split('\r\n').find((l) => l.toLowerCase().startsWith('server:'));
        done(header ? header.slice(7).trim().slice(0, 120) : null);
      } else if (buffer.includes('\n') || buffer.length >= 160) {
        done(buffer.split(/\r?\n/)[0].trim().slice(0, 120));
      }
    });
    socket.once('timeout', () => {
      const header = buffer.split('\r\n').find((l) => l.toLowerCase().startsWith('server:'));
      done(header ? header.slice(7).trim() : buffer.trim().slice(0, 120) || null);
    });
    socket.once('error', () => done(null));
    socket.once('connect', () => {
      if (port === 80) {
        socket.write(`GET / HTTP/1.0\r\nHost: ${ip}\r\nUser-Agent: OpenHomeLab\r\n\r\n`);
      }
    });
  });
}

function probePort(ip: string, port: number): Promise<ScanPortInfo | null> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port });
    let settled = false;
    const finish = (value: ScanPortInfo | null) => {
      if (!settled) {
        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      }
    };
    socket.setTimeout(SCAN_PORT_TIMEOUT_MS);
    socket.once('connect', async () => {
      const info: ScanPortInfo = { port, service: SCAN_PORT_NAMES[port] || 'tcp', banner: null };
      if (port === 22 || port === 80) {
        info.banner = await grabBanner(ip, port);
      }
      finish(info);
    });
    socket.once('timeout', () => finish(null));
    socket.once('error', () => finish(null));
  });
}

async function enrichScannedHost(
  db: Database,
  host: ScannedHost,
  ports: number[],
  arpTable: Map<string, string>,
): Promise<void> {
  const [portResults, hostname] = await Promise.all([
    Promise.all(ports.map((p) => probePort(host.ip, p).catch(() => null))).then((r) => r.filter((p): p is ScanPortInfo => p !== null)),
    reverseLookup(host.ip),
  ]);
  host.ports = portResults.sort((a, b) => a.port - b.port);
  host.hostname = hostname;
  const mac = arpTable.get(host.ip) ?? null;
  host.mac = mac;
  if (mac) {
    const prefix = mac.replace(/[^0-9a-f]/g, '').slice(0, 6);
    host.vendor = OUI_DB[prefix] ?? null;
  }
  try {
    const row = (await db.get('SELECT id, name FROM devices WHERE ip = ?', host.ip)) as
      | { id: number; name: string }
      | undefined;
    if (row) {
      host.managed_device_id = row.id;
      host.managed_device_name = row.name;
    }
  } catch {
    // cross-reference is best-effort
  }
}

async function runScanJob(db: Database, job: ScanJob): Promise<void> {
  let cursor = 0;
  const arpTable = readArpTable();
  const worker = async (): Promise<void> => {
    while (cursor < job.ips.length) {
      if (job.cancelled) break;
      const ip = job.ips[cursor++];
      const host: ScannedHost = {
        ip,
        online: false,
        hostname: null,
        mac: null,
        vendor: null,
        ports: [],
        managed_device_id: null,
        managed_device_name: null,
      };
      try {
        const result = await icmpProbe(ip, SCAN_PING_TIMEOUT_S);
        if (result.alive) {
          host.online = true;
          await enrichScannedHost(db, host, job.ports, arpTable);
        }
      } catch (err) {
        if (err instanceof IcmpUnavailableError) throw err;
      }
      job.hosts.push(host);
      job.scannedCount += 1;
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(SCAN_CONCURRENCY, job.ips.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

// ---- App factory ----

async function getRefreshSettings(db: Database): Promise<{ agentIntervalS: number; uiRefreshS: number }> {
  const row = (await db.get('SELECT agent_interval_seconds, ui_refresh_seconds FROM settings WHERE id = 1')) as {
    agent_interval_seconds: number | null;
    ui_refresh_seconds: number | null;
  } | undefined;
  return {
    agentIntervalS: row?.agent_interval_seconds ?? DEFAULT_AGENT_INTERVAL_S,
    uiRefreshS: row?.ui_refresh_seconds ?? DEFAULT_UI_REFRESH_S,
  };
}

export function createApp(ctx: AppContext): express.Express {
  const { db, jwtSecret, encKey } = ctx;
  const app = express();
  app.disable('x-powered-by');

  const securityHeaders = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'"
    );
    next();
  };

  app.use(securityHeaders);

  const strictJson = express.json({ limit: '256kb' });
  app.use((req, res, next) => {
    if (req.path === '/api/data/import') return next();
    strictJson(req, res, next);
  });

  // Per-app in-memory rate limiter for login/setup
  const hitMap = new Map<string, { count: number; resetAt: number }>();
  const authRateLimiter = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    if (hitMap.size > 1024) {
      for (const [k, v] of hitMap) {
        if (v.resetAt <= now) hitMap.delete(k);
      }
    }
    let entry = hitMap.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + 15 * 60 * 1000 };
      hitMap.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > 5) {
      res.status(429).json({ error: 'Too many attempts, please try again in 15 minutes' });
      return;
    }
    next();
  };

  const requireAuth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      jwt.verify(token, jwtSecret);
      next();
    } catch {
      res.status(401).json({ error: 'Invalid token' });
    }
  };

  type AsyncRoute = (req: express.Request, res: express.Response) => Promise<unknown>;
  const asyncHandler = (fn: AsyncRoute) => (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    fn(req, res).catch(next);
  };

  // Public routes
  app.get('/api/setup/status', asyncHandler(async (_req, res) => {
    const row = await db.get('SELECT master_password_hash FROM settings WHERE id = 1');
    res.json({ isSetup: !!(row as { master_password_hash?: string } | undefined)?.master_password_hash });
  }));

  app.post('/api/setup', authRateLimiter, asyncHandler(async (req, res) => {
    const { password } = req.body ?? {};
    if (!isNonEmptyString(password)) return res.status(400).json({ error: 'Password is required' });
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    const row = await db.get('SELECT master_password_hash FROM settings WHERE id = 1');
    if ((row as { master_password_hash?: string } | undefined)?.master_password_hash) {
      return res.status(400).json({ error: 'Already setup' });
    }

    const hash = await bcrypt.hash(password, 10);
    await db.run('UPDATE settings SET master_password_hash = ? WHERE id = 1', hash);
    const token = jwt.sign({ id: 1 }, jwtSecret, { expiresIn: JWT_EXPIRES_IN });
    res.json({ token });
  }));

  app.post('/api/login', authRateLimiter, asyncHandler(async (req, res) => {
    const { password } = req.body ?? {};
    if (!isNonEmptyString(password)) return res.status(400).json({ error: 'Password is required' });

    const row = (await db.get('SELECT master_password_hash FROM settings WHERE id = 1')) as {
      master_password_hash?: string | null;
    } | undefined;
    if (!row?.master_password_hash) return res.status(400).json({ error: 'Not setup' });

    const valid = await bcrypt.compare(password, row.master_password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid password' });

    const token = jwt.sign({ id: 1 }, jwtSecret, { expiresIn: JWT_EXPIRES_IN });
    res.json({ token });
  }));

  // Agent-facing public routes (device-token auth, no JWT)
  app.get('/api/agent/install', asyncHandler(async (_req, res) => {
    const { agentIntervalS } = await getRefreshSettings(db);
    res.type('text/plain').send(buildAgentInstaller(agentIntervalS));
  }));

  app.get('/api/agent/version', (_req, res) => {
    res.json({ success: true, version: AGENT_VERSION });
  });

  const agentHitMap = new Map<string, { count: number; resetAt: number }>();
  const agentRateLimiter = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = req.ip || 'unknown';
    const nowTs = Date.now();
    if (agentHitMap.size > 1024) {
      for (const [k, v] of agentHitMap) {
        if (v.resetAt <= nowTs) agentHitMap.delete(k);
      }
    }
    let entry = agentHitMap.get(key);
    if (!entry || entry.resetAt <= nowTs) {
      entry = { count: 0, resetAt: nowTs + AGENT_RATE_WINDOW_MS };
      agentHitMap.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > AGENT_RATE_MAX) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    next();
  };

  app.post('/api/agent/stats', agentRateLimiter, asyncHandler(async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const device = (await db.get('SELECT id FROM devices WHERE agent_token = ?', hashAgentToken(token))) as {
      id: number;
    } | undefined;
    if (!device) {
      const claimBody = (req.body ?? {}) as Record<string, unknown>;
      const claimSnapshot = sanitizeAgentPayload(claimBody, Date.now());
      if (!claimSnapshot) return res.status(400).json({ error: 'Invalid payload' });
      const claim = await getActiveClaimByToken(db, token);
      if (claim) {
        await db.run(
          'UPDATE agent_claims SET last_payload = ?, last_seen = ?, samples = ? WHERE id = ?',
          [JSON.stringify(claimSnapshot), claimSnapshot.ts, appendClaimSample(claim.samples, claimSnapshot.power_total_w), claim.id]
        );
        return res.json({ ok: true });
      }
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const stateRow = (await db.get('SELECT active FROM devices WHERE id = ?', device.id)) as {
      active: number;
    } | undefined;
    if (stateRow?.active !== 1) return res.json({ ok: true });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const snapshot = sanitizeAgentPayload(body, Date.now());
    if (!snapshot) return res.status(400).json({ error: 'Invalid payload' });

    const gpuPowerW = [0, 1, 2, 3].map((i) => snapshot.gpus[i]?.power_w ?? null);
    await db.run(
      `INSERT INTO metrics_raw (device_id, ts, cpu, mem_pct, load1, net_rx, net_tx, disk_used_pct, gpu_util, gpu_mem_pct, cpu_power_w, power_total_w, power_gpu0_w, power_gpu1_w, power_gpu2_w, power_gpu3_w)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [device.id, snapshot.ts, snapshot.cpu, computeMemPct(snapshot), snapshot.load[0], snapshot.net_rx, snapshot.net_tx, computeDiskUsedPct(snapshot), computeGpuUtil(snapshot), computeGpuMemPct(snapshot), snapshot.cpu_power_w, snapshot.power_total_w, ...gpuPowerW]
    );
    await db.run(
      `INSERT INTO metrics_live (device_id, payload, received_at) VALUES (?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET payload = excluded.payload, received_at = excluded.received_at`,
      [device.id, JSON.stringify(snapshot), snapshot.ts]
    );
    await db.run(
      `UPDATE device_actions SET status = 'done', output = 'device back online', executed_at = ?
       WHERE device_id = ? AND status IN ('acknowledged', 'started')`,
      [Date.now(), device.id]
    );
    res.json({ ok: true });
  }));

  const resolveAgentDevice = async (req: express.Request): Promise<{ id: number } | null> => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return null;
    return (await db.get(
      'SELECT id FROM devices WHERE agent_token = ?',
      hashAgentToken(token)
    )) as { id: number } | null;
  };

  app.get('/api/agent/pending-actions', agentRateLimiter, asyncHandler(async (req, res) => {
    const device = await resolveAgentDevice(req);
    if (!device) return res.status(401).json({ error: 'Unauthorized' });

    const actions = (await db.all(
      "SELECT id, action, command FROM device_actions WHERE device_id = ? AND status = 'pending' ORDER BY id ASC",
      device.id
    )) as { id: number; action: string; command: string | null }[];
    for (const action of actions) {
      await db.run(
        "UPDATE device_actions SET status = 'acknowledged', executed_at = ? WHERE id = ? AND status = 'pending'",
        [Date.now(), action.id]
      );
    }
    res.json({ actions });
  }));

  app.get('/api/agent/config', agentRateLimiter, asyncHandler(async (req, res) => {
    const device = await resolveAgentDevice(req);
    if (!device) return res.status(401).json({ error: 'Unauthorized' });

    const row = (await db.get('SELECT active FROM devices WHERE id = ?', device.id)) as { active: number } | undefined;
    const { agentIntervalS } = await getRefreshSettings(db);
    res.json({ success: true, interval: agentIntervalS, active: row?.active === 1 });
  }));

  app.get('/api/agent/script', agentRateLimiter, asyncHandler(async (req, res) => {
    const device = await resolveAgentDevice(req);
    if (!device) return res.status(401).json({ error: 'Unauthorized' });

    const { agentIntervalS } = await getRefreshSettings(db);
    res.type('text/plain').send(buildAgentScript(agentIntervalS));
  }));

  app.post('/api/agent/action-result', agentRateLimiter, asyncHandler(async (req, res) => {
    const device = await resolveAgentDevice(req);
    if (!device) return res.status(401).json({ error: 'Unauthorized' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const actionId = toNum(body.action_id);
    if (!Number.isInteger(actionId)) return res.status(400).json({ error: 'Invalid payload' });
    if (body.status !== 'started' && body.status !== 'done' && body.status !== 'failed') {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const output = typeof body.output === 'string' ? body.output.slice(0, 1000) : null;
    const result = await db.run(
      `UPDATE device_actions SET status = ?, output = COALESCE(?, output), executed_at = ?
       WHERE id = ? AND device_id = ? AND status IN ('acknowledged', 'started')`,
      [body.status, output, Date.now(), actionId, device.id]
    );
    if (result.changes === 0) return res.status(404).json({ error: 'Action not found' });
    res.json({ ok: true });
  }));

  // Public machine API (external token auth, no JWT)
  const apiHitMap = new Map<string, { count: number; resetAt: number }>();
  const apiRateLimiter = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = req.ip || 'unknown';
    const nowTs = Date.now();
    if (apiHitMap.size > 1024) {
      for (const [k, v] of apiHitMap) {
        if (v.resetAt <= nowTs) apiHitMap.delete(k);
      }
    }
    let entry = apiHitMap.get(key);
    if (!entry || entry.resetAt <= nowTs) {
      entry = { count: 0, resetAt: nowTs + API_RATE_WINDOW_MS };
      apiHitMap.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > API_RATE_MAX) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    next();
  };

  const requireApiToken = (operation: ApiOperation) => async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    try {
      const header = String(req.headers.authorization ?? '');
      if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing API token' });
      const token = header.slice(7).trim();
      if (!token) return res.status(401).json({ error: 'Missing API token' });

      const row = (await db.get('SELECT * FROM api_tokens WHERE token_hash = ?', hashApiToken(token))) as
        | ApiTokenRow
        | undefined;
      if (!row) return res.status(401).json({ error: 'Unknown API token' });
      if (row.enabled !== 1) return res.status(401).json({ error: 'API token is disabled' });
      if (row.expires_at !== null && row.expires_at <= Date.now()) {
        return res.status(401).json({ error: 'API token has expired' });
      }

      const permissions = JSON.parse(row.permissions) as string[];
      if (!permissions.includes(operation)) {
        return res.status(403).json({ error: `API token is not allowed to ${operation}` });
      }
      const deviceIds = JSON.parse(row.device_ids) as number[];

      (res.locals as Record<string, unknown>).apiToken = { id: row.id, deviceIds };
      res.on('finish', () => {
        const deviceId = Number((res.locals as Record<string, unknown>).apiDeviceId);
        db.run(
          'INSERT INTO api_usage (token_id, operation, device_id, status_code, created_at) VALUES (?, ?, ?, ?, ?)',
          [row.id, operation, Number.isInteger(deviceId) && deviceId > 0 ? deviceId : null, res.statusCode, Date.now()]
        ).catch((err) => console.error('API usage log failed:', err));
        if (res.statusCode >= 200 && res.statusCode < 300) {
          db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [Date.now(), row.id])
            .catch((err) => console.error('API token last_used update failed:', err));
        }
      });
      next();
    } catch (error) {
      next(error);
    }
  };

  const resolvePublicMachine = async (req: express.Request, res: express.Response): Promise<{ id: number } | null> => {
    const param = String(req.params.id ?? '');
    let machine: { id: number } | null = null;
    if (/^\d+$/.test(param)) {
      machine = (await db.get('SELECT id FROM devices WHERE id = ?', Number(param))) as { id: number } | null;
    } else if (param) {
      machine = (await db.get('SELECT id FROM devices WHERE name = ?', param)) as { id: number } | null;
    }
    if (!machine) {
      res.status(404).json({ error: 'Machine not found' });
      return null;
    }

    const apiToken = (res.locals as Record<string, unknown>).apiToken as { id: number; deviceIds: number[] };
    if (apiToken.deviceIds.length > 0 && !apiToken.deviceIds.includes(machine.id)) {
      res.status(403).json({ error: 'Machine is not allowed for this API token' });
      return null;
    }
    (res.locals as Record<string, unknown>).apiDeviceId = machine.id;
    return machine;
  };

  const machineStatusQuery = `
    SELECT d.id, d.name, d.ip, ml.received_at AS last_seen
    FROM devices d
    LEFT JOIN metrics_live ml ON ml.device_id = d.id`;

  app.get('/api/machines', apiRateLimiter, requireApiToken('status'), asyncHandler(async (req, res) => {
    const apiToken = (res.locals as Record<string, unknown>).apiToken as { id: number; deviceIds: number[] };
    const scope = apiToken.deviceIds;
    const where = scope.length > 0 ? `WHERE d.id IN (${scope.map(() => '?').join(', ')})` : '';
    const rows = (await db.all(`${machineStatusQuery} ${where} ORDER BY d.id`, scope)) as {
      id: number;
      name: string;
      ip: string;
      last_seen: number | null;
    }[];

    const { agentIntervalS } = await getRefreshSettings(db);
    const agentStaleMs = agentStaleMsFor(agentIntervalS);
    const machines = await Promise.all(
      rows.map(async (d) => {
        const probe = await probeDeviceStatus(d.ip);
        return {
          id: d.id,
          name: d.name,
          ip: d.ip,
          online: probe.online,
          latency_ms: probe.latency_ms,
          agent_online: d.last_seen !== null && Date.now() - d.last_seen < agentStaleMs,
          last_agent_seen: d.last_seen,
        };
      })
    );
    res.json({ machines });
  }));

  app.get('/api/machines/:id/status', apiRateLimiter, requireApiToken('status'), asyncHandler(async (req, res) => {
    const machine = await resolvePublicMachine(req, res);
    if (!machine) return;

    const row = (await db.get(
      `SELECT d.id, d.name, d.ip, ml.received_at AS last_seen FROM devices d
       LEFT JOIN metrics_live ml ON ml.device_id = d.id WHERE d.id = ?`,
      machine.id
    )) as { id: number; name: string; ip: string; last_seen: number | null };
    const { agentIntervalS } = await getRefreshSettings(db);
    const agentStaleMs = agentStaleMsFor(agentIntervalS);
    const probe = await probeDeviceStatus(row.ip);
    res.json({
      id: row.id,
      name: row.name,
      ip: row.ip,
      online: probe.online,
      latency_ms: probe.latency_ms,
      agent_online: row.last_seen !== null && Date.now() - row.last_seen < agentStaleMs,
      last_agent_seen: row.last_seen,
    });
  }));

  app.post('/api/machines/:id/start', apiRateLimiter, requireApiToken('start'), asyncHandler(async (req, res) => {
    const machine = await resolvePublicMachine(req, res);
    if (!machine) return;
    const result = await wakeDevice(db, machine.id);
    res.status(result.status).json(result.body);
  }));

  app.post('/api/machines/:id/stop', apiRateLimiter, requireApiToken('stop'), asyncHandler(async (req, res) => {
    const machine = await resolvePublicMachine(req, res);
    if (!machine) return;
    const result = await executePowerAction(db, encKey, machine.id, 'shutdown');
    res.status(result.status).json(result.body);
  }));

  app.post('/api/machines/:id/restart', apiRateLimiter, requireApiToken('restart'), asyncHandler(async (req, res) => {
    const machine = await resolvePublicMachine(req, res);
    if (!machine) return;
    const result = await executePowerAction(db, encKey, machine.id, 'reboot');
    res.status(result.status).json(result.body);
  }));

  // Protected routes below
  app.use('/api', requireAuth);

  const scanJobs = new Map<string, ScanJob>();
  const pruneScanJobs = () => {
    const nowTs = Date.now();
    for (const [id, job] of scanJobs) {
      if (nowTs - job.createdAt > SCAN_JOB_TTL_MS) scanJobs.delete(id);
    }
  };

  const scanHitMap = new Map<string, { count: number; resetAt: number }>();
  const scanRateLimiter = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = req.ip || 'unknown';
    const nowTs = Date.now();
    if (scanHitMap.size > 1024) {
      for (const [k, v] of scanHitMap) {
        if (v.resetAt <= nowTs) scanHitMap.delete(k);
      }
    }
    let entry = scanHitMap.get(key);
    if (!entry || entry.resetAt <= nowTs) {
      entry = { count: 0, resetAt: nowTs + SCAN_RATE_WINDOW_MS };
      scanHitMap.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > SCAN_RATE_MAX) {
      res.status(429).json({ error: 'Too many scans, please try again in a minute' });
      return;
    }
    next();
  };

  app.post('/api/scan', scanRateLimiter, asyncHandler(async (req, res) => {
    pruneScanJobs();
    const body = req.body ?? {};
    if (!isNonEmptyString(body.startIp) || !isNonEmptyString(body.endIp)) {
      return res.status(400).json({ error: 'startIp and endIp are required' });
    }
    const range = parseScanRange(String(body.startIp), String(body.endIp));
    if (typeof range === 'string') return res.status(400).json({ error: range });

    let ports = DEFAULT_SCAN_PORTS;
    if (body.ports !== undefined && body.ports !== null) {
      const rawPorts = Array.isArray(body.ports) ? body.ports : String(body.ports).split(',');
      const cleaned: number[] = [];
      for (const entry of rawPorts) {
        const n = Number(String(entry).trim());
        if (Number.isInteger(n) && n >= 1 && n <= 65535) cleaned.push(n);
      }
      const unique = [...new Set(cleaned)];
      if (unique.length === 0 || unique.length > 100) {
        return res.status(400).json({ error: 'ports must contain between 1 and 100 valid port numbers' });
      }
      ports = unique;
    }

    const id = crypto.randomBytes(8).toString('hex');
    const job: ScanJob = {
      id,
      status: 'running',
      total: range.length,
      scannedCount: 0,
      hosts: [],
      createdAt: Date.now(),
      finishedAt: null,
      error: null,
      errorCode: null,
      cancelled: false,
      ips: range,
      ports,
    };
    scanJobs.set(id, job);
    runScanJob(db, job)
      .then(() => {
        if (job.status !== 'running') return;
        job.finishedAt = Date.now();
        job.status = job.cancelled ? 'cancelled' : 'done';
      })
      .catch((err) => {
        console.error('Network scan failed:', err);
        if (job.status === 'running') {
          job.status = 'failed';
          job.finishedAt = Date.now();
          if (err instanceof IcmpUnavailableError) {
            job.errorCode = 'icmp_unavailable';
            job.error = ICMP_UNAVAILABLE_MESSAGE;
          } else {
            job.error = 'The scan stopped unexpectedly';
          }
        }
      });
    res.json({ success: true, scanId: id });
  }));

  app.get('/api/scan/default-range', asyncHandler(async (_req, res) => {
    const range = detectLocalRange();
    res.json({ success: true, startIp: range.startIp, endIp: range.endIp });
  }));

  app.get('/api/scan/:id', asyncHandler(async (req, res) => {
    pruneScanJobs();
    const job = scanJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Scan not found' });
    res.json({
      success: true,
      status: job.status,
      scannedCount: job.scannedCount,
      total: job.total,
      hosts: job.hosts,
      startedAt: job.createdAt,
      finishedAt: job.finishedAt,
      durationMs: job.finishedAt ? job.finishedAt - job.createdAt : null,
      error: job.error,
      errorCode: job.errorCode,
    });
  }));

  app.post('/api/scan/:id/cancel', asyncHandler(async (req, res) => {
    pruneScanJobs();
    const job = scanJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Scan not found' });
    if (job.status !== 'running') return res.status(400).json({ error: 'The scan is not running' });
    job.cancelled = true;
    res.json({ success: true });
  }));

  app.post('/api/change-password', asyncHandler(async (req, res) => {
    const { current_password, new_password } = req.body ?? {};
    if (!isNonEmptyString(current_password) || !isNonEmptyString(new_password)) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    if (new_password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    const row = (await db.get('SELECT master_password_hash FROM settings WHERE id = 1')) as {
      master_password_hash?: string | null;
    } | undefined;
    if (!row?.master_password_hash) return res.status(400).json({ error: 'Not setup' });

    const valid = await bcrypt.compare(current_password, row.master_password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid current password' });

    const hash = await bcrypt.hash(new_password, 10);
    await db.run('UPDATE settings SET master_password_hash = ? WHERE id = 1', hash);
    res.json({ success: true });
  }));

  const DEFAULT_CURRENCY = '\u20AC';

  const DASHBOARD_VIEWS = ['grid', 'list'];
  const DASHBOARD_CARD_SIZES = ['normal', 'compact', 'minimal'];

  app.get('/api/settings', asyncHandler(async (_req, res) => {
    const row = (await db.get(
      'SELECT cost_per_kwh, currency, agent_interval_seconds, ui_refresh_seconds, dashboard_view, dashboard_card_size, poweroff_action, reboot_action, hibernate_action FROM settings WHERE id = 1'
    )) as {
      cost_per_kwh: number | null;
      currency: string | null;
      agent_interval_seconds: number | null;
      ui_refresh_seconds: number | null;
      dashboard_view: string | null;
      dashboard_card_size: string | null;
      poweroff_action: string | null;
      reboot_action: string | null;
      hibernate_action: string | null;
    } | undefined;
    res.json({
      cost_per_kwh: row?.cost_per_kwh ?? null,
      currency: row?.currency || DEFAULT_CURRENCY,
      agent_interval_seconds: row?.agent_interval_seconds ?? DEFAULT_AGENT_INTERVAL_S,
      ui_refresh_seconds: row?.ui_refresh_seconds ?? DEFAULT_UI_REFRESH_S,
      dashboard_view: DASHBOARD_VIEWS.includes(row?.dashboard_view ?? '') ? (row.dashboard_view as string) : 'grid',
      dashboard_card_size: DASHBOARD_CARD_SIZES.includes(row?.dashboard_card_size ?? '')
        ? (row.dashboard_card_size as string)
        : 'normal',
      ...(await getActionSettings(db)),
    });
  }));

  app.put('/api/settings', asyncHandler(async (req, res) => {
    const current = (await db.get(
      'SELECT cost_per_kwh, currency, agent_interval_seconds, ui_refresh_seconds, dashboard_view, dashboard_card_size, poweroff_action, reboot_action, hibernate_action FROM settings WHERE id = 1'
    )) as {
      cost_per_kwh: number | null;
      currency: string | null;
      agent_interval_seconds: number | null;
      ui_refresh_seconds: number | null;
      dashboard_view: string | null;
      dashboard_card_size: string | null;
      poweroff_action: string | null;
      reboot_action: string | null;
      hibernate_action: string | null;
    } | undefined;
    const body = req.body ?? {};

    let costPerKwh: number | null;
    if (body.cost_per_kwh === null) {
      costPerKwh = null;
    } else if (body.cost_per_kwh === undefined) {
      costPerKwh = current?.cost_per_kwh ?? null;
    } else {
      const parsed = typeof body.cost_per_kwh === 'string' ? Number.parseFloat(body.cost_per_kwh) : body.cost_per_kwh;
      if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0) {
        return res.status(400).json({ error: 'cost_per_kwh must be a number >= 0 or null' });
      }
      costPerKwh = parsed;
    }

    let currency: string;
    const rawCurrency = body.currency ?? current?.currency ?? DEFAULT_CURRENCY;
    if (typeof rawCurrency !== 'string' || rawCurrency.trim().length === 0 || rawCurrency.trim().length > 8) {
      currency = DEFAULT_CURRENCY;
    } else {
      currency = rawCurrency.trim();
    }

    let agentIntervalS: number;
    if (body.agent_interval_seconds === undefined) {
      agentIntervalS = current?.agent_interval_seconds ?? DEFAULT_AGENT_INTERVAL_S;
    } else {
      const parsed =
        typeof body.agent_interval_seconds === 'string' ? Number(body.agent_interval_seconds) : body.agent_interval_seconds;
      if (
        typeof parsed !== 'number' ||
        !Number.isInteger(parsed) ||
        parsed < MIN_REFRESH_INTERVAL_S ||
        parsed > MAX_REFRESH_INTERVAL_S
      ) {
        return res.status(400).json({
          error: `agent_interval_seconds must be an integer between ${MIN_REFRESH_INTERVAL_S} and ${MAX_REFRESH_INTERVAL_S}`,
        });
      }
      agentIntervalS = parsed;
    }

    let uiRefreshS: number;
    if (body.ui_refresh_seconds === undefined) {
      uiRefreshS = current?.ui_refresh_seconds ?? DEFAULT_UI_REFRESH_S;
    } else {
      const parsed =
        typeof body.ui_refresh_seconds === 'string' ? Number(body.ui_refresh_seconds) : body.ui_refresh_seconds;
      if (
        typeof parsed !== 'number' ||
        !Number.isInteger(parsed) ||
        parsed < MIN_REFRESH_INTERVAL_S ||
        parsed > MAX_REFRESH_INTERVAL_S
      ) {
        return res.status(400).json({
          error: `ui_refresh_seconds must be an integer between ${MIN_REFRESH_INTERVAL_S} and ${MAX_REFRESH_INTERVAL_S}`,
        });
      }
      uiRefreshS = parsed;
    }

    const actionFields: [string, readonly string[], string | null, string][] = [
      ['poweroff_action', POWER_OFF_ACTIONS, current?.poweroff_action ?? null, DEFAULT_POWER_OFF_ACTION],
      ['reboot_action', REBOOT_ACTIONS, current?.reboot_action ?? null, DEFAULT_REBOOT_ACTION],
      ['hibernate_action', HIBERNATE_ACTIONS, current?.hibernate_action ?? null, DEFAULT_HIBERNATE_ACTION],
    ];
    const nextActions: Record<string, string> = {};
    for (const [field, allowed, currentValue, fallback] of actionFields) {
      if (body[field] === undefined) {
        nextActions[field] = currentValue && allowed.includes(currentValue) ? currentValue : fallback;
      } else if (allowed.includes(String(body[field]))) {
        nextActions[field] = String(body[field]);
      } else {
        return res.status(400).json({ error: `${field} must be one of: ${allowed.join(', ')}` });
      }
    }

    let dashboardView: string;
    if (body.dashboard_view === undefined) {
      dashboardView = current?.dashboard_view && DASHBOARD_VIEWS.includes(current.dashboard_view) ? current.dashboard_view : 'grid';
    } else if (DASHBOARD_VIEWS.includes(String(body.dashboard_view))) {
      dashboardView = String(body.dashboard_view);
    } else {
      return res.status(400).json({ error: `dashboard_view must be one of: ${DASHBOARD_VIEWS.join(', ')}` });
    }

    let dashboardCardSize: string;
    if (body.dashboard_card_size === undefined) {
      dashboardCardSize = current?.dashboard_card_size && DASHBOARD_CARD_SIZES.includes(current.dashboard_card_size)
        ? current.dashboard_card_size
        : 'normal';
    } else if (DASHBOARD_CARD_SIZES.includes(String(body.dashboard_card_size))) {
      dashboardCardSize = String(body.dashboard_card_size);
    } else {
      return res.status(400).json({ error: `dashboard_card_size must be one of: ${DASHBOARD_CARD_SIZES.join(', ')}` });
    }

    await db.run(
      'UPDATE settings SET cost_per_kwh = ?, currency = ?, agent_interval_seconds = ?, ui_refresh_seconds = ?, dashboard_view = ?, dashboard_card_size = ?, poweroff_action = ?, reboot_action = ?, hibernate_action = ? WHERE id = 1',
      [costPerKwh, currency, agentIntervalS, uiRefreshS, dashboardView, dashboardCardSize, nextActions.poweroff_action, nextActions.reboot_action, nextActions.hibernate_action]
    );
    res.json({
      cost_per_kwh: costPerKwh,
      currency,
      agent_interval_seconds: agentIntervalS,
      ui_refresh_seconds: uiRefreshS,
      dashboard_view: dashboardView,
      dashboard_card_size: dashboardCardSize,
      poweroff_action: nextActions.poweroff_action,
      reboot_action: nextActions.reboot_action,
      hibernate_action: nextActions.hibernate_action,
    });
  }));

  app.get('/api/profiles', asyncHandler(async (_req, res) => {
    const profiles = await db.all('SELECT id, name, username, auth_type FROM profiles');
    res.json(profiles);
  }));

  app.post('/api/profiles', asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const invalid = validateProfileInput(body, false);
    if (invalid) return res.status(400).json({ error: invalid });

    const password = body.auth_type === 'password' ? encryptCredential(body.password, encKey) : null;
    const privateKey = body.auth_type === 'key' ? encryptCredential(body.private_key, encKey) : null;
    const result = await db.run(
      'INSERT INTO profiles (name, username, auth_type, password, private_key) VALUES (?, ?, ?, ?, ?)',
      [body.name.trim(), body.username.trim(), body.auth_type, password, privateKey]
    );
    res.json({ id: result.lastID });
  }));

  app.put('/api/profiles/:id', asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const invalid = validateProfileInput(body, true);
    if (invalid) return res.status(400).json({ error: invalid });

    if (body.auth_type === 'password' && isNonEmptyString(body.password)) {
      await db.run(
        'UPDATE profiles SET name = ?, username = ?, auth_type = ?, password = ?, private_key = NULL WHERE id = ?',
        [body.name.trim(), body.username.trim(), body.auth_type, encryptCredential(body.password, encKey), req.params.id]
      );
    } else if (body.auth_type === 'key' && isNonEmptyString(body.private_key)) {
      await db.run(
        'UPDATE profiles SET name = ?, username = ?, auth_type = ?, private_key = ?, password = NULL WHERE id = ?',
        [body.name.trim(), body.username.trim(), body.auth_type, encryptCredential(body.private_key, encKey), req.params.id]
      );
    } else {
      await db.run(
        'UPDATE profiles SET name = ?, username = ?, auth_type = ? WHERE id = ?',
        [body.name.trim(), body.username.trim(), body.auth_type, req.params.id]
      );
    }
    res.json({ success: true });
  }));

  app.delete('/api/profiles/:id', asyncHandler(async (req, res) => {
    await db.run('DELETE FROM profiles WHERE id = ?', req.params.id);
    await db.run('UPDATE devices SET profile_id = NULL WHERE profile_id = ?', req.params.id);
    res.json({ success: true });
  }));

  const DEVICE_COLUMNS = `d.id AS id, d.name, d.ip, d.mac, d.hostname, d.type, d.profile_id, d.broadcast_address, d.active, d.base_power_w, d.interfaces AS interfaces_raw, (d.agent_token IS NOT NULL) AS has_agent_token, ml.received_at AS last_seen, JSON_EXTRACT(ml.payload, '$.agent_version') AS agent_version, JSON_EXTRACT(ml.payload, '$.os_family') AS os_family, JSON_EXTRACT(ml.payload, '$.os_name') AS os_name, d.group_id AS group_id, d.position AS position, d.poweroff_action, d.reboot_action, d.hibernate_action, d.disable_power, d.disable_ping, d.disable_terminal, d.disable_agent_update`;
  const DEVICES_FROM = `devices d LEFT JOIN metrics_live ml ON ml.device_id = d.id`;

  const mapDeviceRows = (rows: Record<string, unknown>[]) =>
    rows.map((row) => {
      const { interfaces_raw, ...rest } = row;
      return { ...rest, interfaces: parseStoredInterfaces(interfaces_raw) };
    });

  app.get('/api/devices', asyncHandler(async (_req, res) => {
    const devices = mapDeviceRows((await db.all(`SELECT ${DEVICE_COLUMNS} FROM ${DEVICES_FROM}`)) as Record<string, unknown>[]);
    res.json(devices);
  }));

  app.get('/api/devices/active', asyncHandler(async (_req, res) => {
    const devices = mapDeviceRows(
      (await db.all(`SELECT ${DEVICE_COLUMNS} FROM ${DEVICES_FROM} WHERE d.active = 1`)) as Record<string, unknown>[]
    );
    res.json(devices);
  }));

  app.post('/api/devices/agents/update', asyncHandler(async (_req, res) => {
    const { agentIntervalS } = await getRefreshSettings(db);
    const staleMs = agentStaleMsFor(agentIntervalS);
    const rows = (await db.all(
      `SELECT d.id AS id, d.disable_agent_update, ml.received_at AS last_seen, JSON_EXTRACT(ml.payload, '$.agent_version') AS agent_version
       FROM devices d LEFT JOIN metrics_live ml ON ml.device_id = d.id WHERE d.agent_token IS NOT NULL`
    )) as { id: number; disable_agent_update: number; last_seen: number | null; agent_version: string | null }[];

    const nowTs = Date.now();
    let queued = 0;
    let upToDate = 0;
    let disabled = 0;
    for (const row of rows) {
      if (row.disable_agent_update) {
        disabled += 1;
        continue;
      }
      const online = row.last_seen !== null && nowTs - Number(row.last_seen) < staleMs;
      if (!online || row.agent_version === AGENT_VERSION) {
        if (online) upToDate += 1;
        continue;
      }
      await db.run(
        "DELETE FROM device_actions WHERE device_id = ? AND (status IN ('done', 'failed') OR created_at < ?)",
        [row.id, nowTs - 24 * HOUR_MS]
      );
      await db.run(
        "INSERT INTO device_actions (device_id, action, status, created_at) VALUES (?, 'update', 'pending', ?)",
        [row.id, nowTs]
      );
      queued += 1;
    }

    res.json({ success: true, queued, up_to_date: upToDate, disabled });
  }));

  app.post('/api/devices', asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const invalid = validateDeviceInput(body);
    if (invalid) return res.status(400).json({ error: invalid });

    if (body.profile_id !== null && body.profile_id !== undefined) {
      const profile = await db.get('SELECT id FROM profiles WHERE id = ?', body.profile_id);
      if (!profile) return res.status(400).json({ error: 'Assigned profile does not exist' });
    }

    const newGroupId = normalizeGroupId(body.group_id);
    if (newGroupId === 'invalid') return res.status(400).json({ error: 'group_id must be a positive integer' });
    let resolvedGroupId: number | null = null;
    if (newGroupId !== null) {
      const group = await db.get('SELECT id FROM groups WHERE id = ?', newGroupId);
      if (!group) return res.status(400).json({ error: 'Assigned group does not exist' });
      resolvedGroupId = newGroupId;
    }

    let boundAgentToken: string | null = null;
    let claimSeed: { payload: string; ts: number } | null = null;
    if (isNonEmptyString(body.agent_token)) {
      const claim = await getActiveClaimByToken(db, String(body.agent_token).trim());
      if (!claim) return res.status(404).json({ error: 'Installation link not found or expired' });
      boundAgentToken = claim.token_hash;
      if (claim.last_payload) claimSeed = { payload: claim.last_payload, ts: claim.last_seen ?? claim.created_at };
    }

    const startPosition = await nextGroupPosition(db, resolvedGroupId);
    const result = await db.run(
      `INSERT INTO devices (name, ip, mac, hostname, type, profile_id, broadcast_address, active, base_power_w, agent_token, interfaces, group_id, position, poweroff_action, reboot_action, hibernate_action, disable_power, disable_ping, disable_terminal, disable_agent_update)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.name.trim(),
        body.ip.trim(),
        isNonEmptyString(body.mac) ? body.mac.trim() : null,
        resolveHostname(body.hostname, claimSeed),
        body.type,
        body.profile_id ?? null,
        isNonEmptyString(body.broadcast_address) ? body.broadcast_address.trim() : null,
        body.active === undefined || body.active === true || body.active === 1 ? 1 : 0,
        parseBasePowerW(body.base_power_w),
        boundAgentToken,
        normalizeStoredInterfaces(body.interfaces),
        resolvedGroupId,
        startPosition,
        parseActionOverride(body.poweroff_action, POWER_OFF_ACTIONS),
        parseActionOverride(body.reboot_action, REBOOT_ACTIONS),
        parseActionOverride(body.hibernate_action, HIBERNATE_ACTIONS),
        parseDisableFlag(body.disable_power),
        parseDisableFlag(body.disable_ping),
        parseDisableFlag(body.disable_terminal),
        parseDisableFlag(body.disable_agent_update),
      ]
    );

    if (claimSeed) {
      await db.run(
        `INSERT INTO metrics_live (device_id, payload, received_at) VALUES (?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET payload = excluded.payload, received_at = excluded.received_at`,
        [result.lastID, claimSeed.payload, claimSeed.ts]
      );
    }
    if (boundAgentToken) {
      await db.run('DELETE FROM agent_claims WHERE token_hash = ?', [boundAgentToken]);
    }

    res.json({ id: result.lastID });
  }));

  app.get('/api/groups', asyncHandler(async (_req, res) => {
    const groups = (await db.all('SELECT id, name, icon, color, position FROM groups ORDER BY position ASC, id ASC')) as {
      id: number;
      name: string;
      icon: string;
      color: string;
      position: number;
    }[];
    res.json(groups);
  }));

  app.post('/api/groups', asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const invalid = validateGroupInput(body, false);
    if (invalid) return res.status(400).json({ error: invalid });
    const name = String(body.name).trim();
    const existing = await db.get('SELECT id FROM groups WHERE name = ?', [name]);
    if (existing) return res.status(409).json({ error: 'A group with this name already exists' });
    const positionRow = (await db.get('SELECT COALESCE(MAX(position), -1) AS m FROM groups')) as { m: number };
    const result = await db.run(
      'INSERT INTO groups (name, icon, color, position) VALUES (?, ?, ?, ?)',
      [name, body.icon ?? 'boxes', body.color ?? 'slate', Number(positionRow?.m ?? -1) + 1]
    );
    res.json({ id: result.lastID });
  }));

  app.put('/api/groups/:id', asyncHandler(async (req, res) => {
    const group = (await db.get('SELECT id, name, icon, color FROM groups WHERE id = ?', req.params.id)) as {
      id: number;
      name: string;
      icon: string;
      color: string;
    } | undefined;
    if (!group) return res.status(404).json({ error: 'Group not found' });
    const body = req.body ?? {};
    const invalid = validateGroupInput(body, true);
    if (invalid) return res.status(400).json({ error: invalid });
    const name = body.name !== undefined && body.name !== null ? String(body.name).trim() : group.name;
    if (body.name !== undefined && body.name !== null) {
      const clash = await db.get('SELECT id FROM groups WHERE name = ? AND id != ?', [name, group.id]);
      if (clash) return res.status(409).json({ error: 'A group with this name already exists' });
    }
    const icon = body.icon !== undefined && body.icon !== null ? String(body.icon) : group.icon;
    const color = body.color !== undefined && body.color !== null ? String(body.color) : group.color;
    await db.run('UPDATE groups SET name = ?, icon = ?, color = ? WHERE id = ?', [name, icon, color, group.id]);
    res.json({ success: true });
  }));

  app.delete('/api/groups/:id', asyncHandler(async (req, res) => {
    const group = (await db.get('SELECT id FROM groups WHERE id = ?', req.params.id)) as { id: number } | undefined;
    if (!group) return res.status(404).json({ error: 'Group not found' });
    await db.run('UPDATE devices SET group_id = NULL WHERE group_id = ?', [group.id]);
    await db.run('DELETE FROM groups WHERE id = ?', [group.id]);
    await reindexGroupPositions(db, null);
    res.json({ success: true });
  }));

  app.post('/api/groups/reorder', asyncHandler(async (req, res) => {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be an array of group ids' });
    for (const id of ids) {
      if (!Number.isInteger(id) || (id as number) <= 0) return res.status(400).json({ error: 'ids must contain positive integers' });
    }
    const known = (await db.all('SELECT id FROM groups')) as { id: number }[];
    const knownIds = new Set(known.map((g) => g.id));
    if (ids.length !== knownIds.size || ids.some((id) => !knownIds.has(Number(id)))) {
      return res.status(400).json({ error: 'ids must contain every group exactly once' });
    }
    for (let i = 0; i < ids.length; i += 1) {
      await db.run('UPDATE groups SET position = ? WHERE id = ?', [i, Number(ids[i])]);
    }
    res.json({ success: true });
  }));

  app.put('/api/devices/:id/move', asyncHandler(async (req, res) => {
    const device = (await db.get('SELECT id, group_id FROM devices WHERE id = ?', req.params.id)) as {
      id: number;
      group_id: number | null;
    } | undefined;
    if (!device) return res.status(404).json({ error: 'Device not found' });

    const body = req.body ?? {};
    const groupId = normalizeGroupId(body.group_id);
    if (groupId === 'invalid') return res.status(400).json({ error: 'group_id must be a positive integer or null' });
    if (groupId !== null) {
      const group = await db.get('SELECT id FROM groups WHERE id = ?', groupId);
      if (!group) return res.status(400).json({ error: 'Group does not exist' });
    }

    const siblings = (groupId === null
      ? await db.all('SELECT id, position FROM devices WHERE group_id IS NULL AND id != ? ORDER BY position ASC, id ASC', [device.id])
      : await db.all('SELECT id, position FROM devices WHERE group_id = ? AND id != ? ORDER BY position ASC, id ASC', [groupId, device.id])) as {
      id: number;
      position: number;
    }[];

    const index = Number(body.index);
    if (!Number.isInteger(index) || index < 0 || index > siblings.length) {
      return res.status(400).json({ error: `index must be an integer between 0 and ${siblings.length}` });
    }

    const ordered = [...siblings];
    ordered.splice(index, 0, { id: device.id, position: -1 });
    for (let i = 0; i < ordered.length; i += 1) {
      await db.run('UPDATE devices SET group_id = ?, position = ? WHERE id = ?', [groupId, i, ordered[i].id]);
    }
    if (device.group_id !== groupId) {
      await reindexGroupPositions(db, device.group_id);
    }
    res.json({ success: true });
  }));

  app.put('/api/devices/:id', asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const invalid = validateDeviceInput(body);
    if (invalid) return res.status(400).json({ error: invalid });

    const device = (await db.get(
      `SELECT d.id, d.active, d.agent_token, d.group_id AS current_group_id, ml.received_at AS last_seen,
              JSON_EXTRACT(ml.payload, '$.agent_version') AS agent_version
       FROM devices d LEFT JOIN metrics_live ml ON ml.device_id = d.id WHERE d.id = ?`,
      req.params.id
    )) as {
      id: number;
      active: number;
      agent_token: string | null;
      current_group_id: number | null;
      last_seen: number | null;
      agent_version: string | null;
    } | undefined;
    if (!device) return res.status(404).json({ error: 'Device not found' });

    if (body.profile_id !== null && body.profile_id !== undefined) {
      const profile = await db.get('SELECT id FROM profiles WHERE id = ?', body.profile_id);
      if (!profile) return res.status(400).json({ error: 'Assigned profile does not exist' });
    }

    let updatedGroupId = device.current_group_id;
    if (body.group_id !== undefined) {
      const parsedGroupId = normalizeGroupId(body.group_id);
      if (parsedGroupId === 'invalid') return res.status(400).json({ error: 'group_id must be a positive integer' });
      if (parsedGroupId !== null) {
        const group = await db.get('SELECT id FROM groups WHERE id = ?', parsedGroupId);
        if (!group) return res.status(400).json({ error: 'Assigned group does not exist' });
      }
      updatedGroupId = parsedGroupId;
    }

    const newActive = body.active === undefined || body.active === true || body.active === 1 ? 1 : 0;
    const newPosition =
      updatedGroupId === device.current_group_id ? (await db.get('SELECT position FROM devices WHERE id = ?', [device.id]) as { position: number } | undefined)?.position ?? 0 : await nextGroupPosition(db, updatedGroupId);
    await db.run(
      `UPDATE devices SET name = ?, ip = ?, mac = ?, hostname = ?, type = ?, profile_id = ?, broadcast_address = ?, active = ?, base_power_w = ?, interfaces = ?, group_id = ?, position = ?, poweroff_action = ?, reboot_action = ?, hibernate_action = ?, disable_power = ?, disable_ping = ?, disable_terminal = ?, disable_agent_update = ? WHERE id = ?`,
      [
        body.name.trim(),
        body.ip.trim(),
        isNonEmptyString(body.mac) ? body.mac.trim() : null,
        resolveHostname(body.hostname),
        body.type,
        body.profile_id ?? null,
        isNonEmptyString(body.broadcast_address) ? body.broadcast_address.trim() : null,
        newActive,
        parseBasePowerW(body.base_power_w),
        normalizeStoredInterfaces(body.interfaces),
        updatedGroupId,
        newPosition,
        parseActionOverride(body.poweroff_action, POWER_OFF_ACTIONS),
        parseActionOverride(body.reboot_action, REBOOT_ACTIONS),
        parseActionOverride(body.hibernate_action, HIBERNATE_ACTIONS),
        parseDisableFlag(body.disable_power),
        parseDisableFlag(body.disable_ping),
        parseDisableFlag(body.disable_terminal),
        parseDisableFlag(body.disable_agent_update),
        req.params.id,
      ]
    );
    if (updatedGroupId !== device.current_group_id) {
      await reindexGroupPositions(db, device.current_group_id);
      await reindexGroupPositions(db, updatedGroupId);
    }

    if (Number(device.active) === 1 && newActive === 0) {
      await db.run('DELETE FROM metrics_live WHERE device_id = ?', req.params.id);
      const { agentIntervalS } = await getRefreshSettings(db);
      const agentOnline = !!device.agent_token
        && device.last_seen !== null
        && Date.now() - Number(device.last_seen) < agentStaleMsFor(agentIntervalS);
      const agentOutdated = device.agent_version !== AGENT_VERSION;
      if (agentOnline && agentOutdated) {
        const nowTs = Date.now();
        await db.run(
          `DELETE FROM device_actions WHERE device_id = ? AND (status IN ('done', 'failed') OR created_at < ?)`,
          [device.id, nowTs - 24 * HOUR_MS]
        );
        await db.run(
          "INSERT INTO device_actions (device_id, action, status, created_at) VALUES (?, 'update', 'pending', ?)",
          [device.id, nowTs]
        );
      }
    }

    res.json({ success: true });
  }));

  app.delete('/api/devices/:id', asyncHandler(async (req, res) => {
    const before = (await db.get(
      `SELECT d.id, d.ip, d.agent_token, p.username, p.auth_type, p.password, p.private_key
       FROM devices d LEFT JOIN profiles p ON d.profile_id = p.id WHERE d.id = ?`,
      req.params.id
    )) as {
      id: number;
      ip: string;
      agent_token: string | null;
      username: string | null;
      auth_type: 'password' | 'key' | null;
      password: string | null;
      private_key: string | null;
    } | undefined;

    for (const table of ['metrics_live', 'metrics_raw', 'metrics_hourly', 'metrics_daily', 'device_actions']) {
      await db.run(`DELETE FROM ${table} WHERE device_id = ?`, req.params.id);
    }
    const deletedRow = (await db.get('SELECT group_id FROM devices WHERE id = ?', req.params.id)) as {
      group_id: number | null;
    } | undefined;
    const deletedId = Number(req.params.id);
    if (Number.isInteger(deletedId)) {
      const tokens = (await db.all('SELECT id, device_ids FROM api_tokens')) as {
        id: number;
        device_ids: string;
      }[];
      for (const t of tokens) {
        const ids = JSON.parse(t.device_ids) as number[];
        if (ids.includes(deletedId)) {
          await db.run('UPDATE api_tokens SET device_ids = ? WHERE id = ?', [
            JSON.stringify(ids.filter((v) => v !== deletedId)),
            t.id,
          ]);
        }
      }
    }
    await db.run('DELETE FROM devices WHERE id = ?', req.params.id);
    if (deletedRow) {
      await reindexGroupPositions(db, deletedRow.group_id);
    }
    res.json({ success: true });

    if (before?.agent_token && before.username) {
      const password = before.auth_type === 'password' ? decryptCredential(before.password, encKey) ?? undefined : undefined;
      const privateKey = before.auth_type === 'key' ? decryptCredential(before.private_key, encKey) ?? undefined : undefined;
      runProfileSshCommand({ ip: before.ip, username: before.username, password, privateKey }, UNINSTALL_AGENT_COMMAND).then(
        (error) => {
          if (error) console.warn(`Agent uninstall failed for device ${before.id}:`, error);
        }
      );
    }
  }));

  app.get('/api/devices/status', asyncHandler(async (_req, res) => {
    const devices = (await db.all('SELECT id, ip FROM devices')) as { id: number; ip: string }[];
    const statuses = await Promise.all(
      devices.map(async (d) => {
        try {
          const result = await icmpProbe(d.ip, 1);
          return { id: d.id, online: result.alive };
        } catch (err) {
          if (err instanceof IcmpUnavailableError) warnIcmpUnavailableOnce('devices/status');
          return { id: d.id, online: false };
        }
      })
    );

    const statusMap: Record<number, boolean> = {};
    for (const s of statuses) statusMap[s.id] = s.online;
    res.json(statusMap);
  }));

  app.post('/api/devices/:id/ping', asyncHandler(async (req, res) => {
    const device = (await db.get('SELECT ip, disable_ping FROM devices WHERE id = ?', req.params.id)) as {
      ip: string;
      disable_ping: number;
    } | undefined;
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (device.disable_ping) {
      return res.status(403).json({ error: 'Ping is disabled for this device' });
    }

    try {
      const result = await icmpProbe(device.ip, 2, ['-c', '1']);
      res.json({ alive: result.alive, time: result.time, output: result.output });
    } catch (err) {
      if (err instanceof IcmpUnavailableError) {
        warnIcmpUnavailableOnce('devices/:id/ping');
        return res.status(503).json({ error: ICMP_UNAVAILABLE_MESSAGE, errorCode: 'icmp_unavailable' });
      }
      throw err;
    }
  }));

  app.post('/api/devices/:id/wake', asyncHandler(async (req, res) => {
    const result = await wakeDevice(db, Number(req.params.id));
    res.status(result.status).json(result.body);
  }));

  app.post('/api/devices/:id/command', asyncHandler(async (req, res) => {
    const { action } = req.body ?? {};
    if (!['reboot', 'shutdown', 'hibernate', 'update'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const result = await executePowerAction(db, encKey, Number(req.params.id), action);
    res.status(result.status).json(result.body);
  }));

  app.get('/api/devices/actions', asyncHandler(async (_req, res) => {
    const { agentIntervalS } = await getRefreshSettings(db);
    await settleStaleActions(db, agentIntervalS);
    const rows = (await db.all(
      `SELECT device_id, action, status, created_at, output FROM device_actions
       WHERE status IN ('pending', 'acknowledged', 'started', 'failed') AND created_at > ?
       ORDER BY id DESC`,
      [Date.now() - 10 * 60_000]
    )) as { device_id: number; action: string; status: string; created_at: number; output: string | null }[];
    const map: Record<string, { action: string; status: string; created_at: number; output: string | null }> = {};
    for (const row of rows) {
      const key = String(row.device_id);
      if (!map[key] || (map[key].status === 'failed' && row.status !== 'failed')) {
        map[key] = { action: row.action, status: row.status, created_at: row.created_at, output: row.output };
      }
    }
    res.json(map);
  }));

  app.post('/api/devices/:id/agent/token', asyncHandler(async (req, res) => {
    const device = await db.get('SELECT id FROM devices WHERE id = ?', req.params.id);
    if (!device) return res.status(404).json({ error: 'Device not found' });

    const agentToken = generateAgentToken();
    await db.run('UPDATE devices SET agent_token = ? WHERE id = ?', [hashAgentToken(agentToken), req.params.id]);
    res.json({ token: agentToken, install_path: '/api/agent/install' });
  }));

  app.post('/api/devices/:id/agent/reinstall', asyncHandler(async (req, res) => {
    const device = (await db.get(
      `SELECT d.id, d.ip, p.username, p.auth_type, p.password, p.private_key
       FROM devices d LEFT JOIN profiles p ON d.profile_id = p.id WHERE d.id = ?`,
      req.params.id
    )) as {
      id: number;
      ip: string;
      username: string | null;
      auth_type: string | null;
      password: string | null;
      private_key: string | null;
    } | undefined;
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (!device.username) return res.status(400).json({ error: 'No SSH profile assigned' });

    const agentToken = generateAgentToken();
    await db.run('UPDATE devices SET agent_token = ? WHERE id = ?', [hashAgentToken(agentToken), device.id]);

    const proto = (req.get('x-forwarded-proto') ?? 'http').split(',')[0].trim() || 'http';
    const host = req.get('host');
    if (!host) return res.status(500).json({ error: 'Cannot determine server URL' });
    const serverUrl = `${proto}://${host}`;
    const installCommand = `curl -fsS ${serverUrl}/api/agent/install | sh -s -- ${serverUrl} ${agentToken}`;

    const password = device.auth_type === 'password' ? decryptCredential(device.password, encKey) ?? undefined : undefined;
    const privateKey = device.auth_type === 'key' ? decryptCredential(device.private_key, encKey) ?? undefined : undefined;
    const error = await runProfileSshCommand({ ip: device.ip, username: device.username, password, privateKey }, installCommand);
    if (error) {
      console.error('Agent reinstall SSH error for device', device.id, ':', error);
      return res.status(500).json({ error });
    }
    res.json({ success: true, channel: 'ssh' });
  }));

  app.post('/api/devices/claim', asyncHandler(async (_req, res) => {
    await pruneExpiredClaims(db);
    const now = Date.now();
    const token = generateClaimToken();
    const result = await db.run(
      'INSERT INTO agent_claims (token_hash, created_at, expires_at) VALUES (?, ?, ?)',
      [hashAgentToken(token), now, now + CLAIM_TTL_MS]
    );
    res.json({ claim_id: result.lastID, token, install_path: '/api/agent/install', expires_at: now + CLAIM_TTL_MS });
  }));

  app.get('/api/devices/claims/:id/status', asyncHandler(async (req, res) => {
    const claim = await getActiveClaimById(db, req.params.id);
    if (!claim) return res.status(404).json({ error: 'Claim not found or expired' });

    let snapshot: AgentSnapshot | null = null;
    if (claim.last_payload) {
      try {
        snapshot = JSON.parse(claim.last_payload) as AgentSnapshot;
      } catch {
        snapshot = null;
      }
    }
    res.json({
      installed: !!snapshot,
      expires_at: claim.expires_at,
      last_seen: claim.last_seen,
      power_samples: parseClaimSamples(claim.samples),
      snapshot,
    });
  }));

  app.delete('/api/devices/claims/:id', asyncHandler(async (req, res) => {
    await db.run('DELETE FROM agent_claims WHERE id = ?', req.params.id);
    res.json({ success: true });
  }));

  app.get('/api/devices/stats/all', asyncHandler(async (_req, res) => {
    const rows = (await db.all(
      'SELECT device_id, payload, received_at FROM metrics_live'
    )) as { device_id: number; payload: string; received_at: number }[];

    const map: Record<string, { cpu: number | null; mem_pct: number | null; gpu_util: number | null; power_total_w: number | null; agent_version: string | null; agent_interval: number | null; last_seen: number; os_family: 'linux' | 'macos' | null; os_name: string | null }> = {};
    for (const row of rows) {
      try {
        const snap = JSON.parse(row.payload) as AgentSnapshot;
        map[String(row.device_id)] = {
          cpu: snap.cpu !== null ? Math.round(snap.cpu) : null,
          mem_pct: computeMemPct(snap) !== null ? Math.round(computeMemPct(snap) as number) : null,
          gpu_util: computeGpuUtil(snap) !== null ? Math.round(computeGpuUtil(snap) as number) : null,
          power_total_w: snap.power_total_w,
          agent_version: snap.agent_version ?? null,
          agent_interval: snap.interval ?? null,
          last_seen: row.received_at,
          os_family: toOsFamily(snap.os_family),
          os_name: snap.os_name ?? null,
        };
      } catch {
        continue;
      }
    }
    res.json(map);
  }));

  const respondEnergy = async (range: string, kwh: number) => {
    const row = (await db.get('SELECT cost_per_kwh, currency FROM settings WHERE id = 1')) as {
      cost_per_kwh: number | null;
      currency: string | null;
    } | undefined;
    return {
      range,
      kwh: Math.round(kwh * 10000) / 10000,
      cost: row?.cost_per_kwh === null || row?.cost_per_kwh === undefined
        ? null
        : Math.round(kwh * (row.cost_per_kwh as number) * 1000) / 1000,
      currency: row?.currency || DEFAULT_CURRENCY,
    };
  };

  app.get('/api/devices/stats/energy', asyncHandler(async (req, res) => {
    const range = String(req.query.range ?? '24h');
    const spec = HISTORY_RANGES[range];
    if (!spec) return res.status(400).json({ error: 'Invalid range, use 1h|6h|24h|7d|30d|1y' });

    const devices = (await db.all('SELECT id, base_power_w FROM devices')) as {
      id: number;
      base_power_w: number | null;
    }[];
    const { agentIntervalS } = await getRefreshSettings(db);
    const gapMs = energyGapLimitMsFor(agentIntervalS);
    const bd = await computeEnergyBreakdown(db, spec, undefined, agentIntervalS);

    let baseKwh = 0;
    if (spec.source === 'raw') {
      const rows = (await db.all(
        `WITH lagged AS (
           SELECT device_id, ts, LAG(ts) OVER w AS prev_ts
           FROM metrics_raw
           WHERE ts >= ? AND power_total_w IS NOT NULL
           WINDOW w AS (PARTITION BY device_id ORDER BY ts)
         )
         SELECT device_id, SUM(CASE WHEN prev_ts IS NOT NULL AND ts - prev_ts > 0 AND ts - prev_ts <= ${gapMs} THEN ts - prev_ts ELSE 0 END) / 1000.0 AS online_s
         FROM lagged GROUP BY device_id`,
        [Date.now() - spec.fromMs]
      )) as { device_id: number; online_s: number }[];
      const byDevice = new Map(rows.map((r) => [r.device_id, r.online_s]));
      for (const d of devices) baseKwh += basePowerKwh(d.base_power_w, byDevice.get(d.id) ?? 0);
    } else {
      const hoursPerBucket = spec.source === 'hourly' ? 1 : 24;
      const rows = (await db.all(
        `SELECT device_id, SUM(CASE WHEN power_kwh IS NOT NULL THEN online_s ELSE ${hoursPerBucket * 3600} END) AS online_s
         FROM metrics_${spec.source} WHERE bucket >= ? GROUP BY device_id`,
        [Date.now() - spec.fromMs]
      )) as { device_id: number; online_s: number }[];
      const byDevice = new Map(rows.map((r) => [r.device_id, r.online_s]));
      for (const d of devices) baseKwh += basePowerKwh(d.base_power_w, byDevice.get(d.id) ?? 0);
    }

    res.json(await respondEnergy(range, bd.totalKwh + baseKwh));
  }));

  app.get('/api/devices/stats/power', asyncHandler(async (req, res) => {
    const range = String(req.query.range ?? '24h');
    const spec = FLEET_POWER_RANGES[range];
    if (!spec) return res.status(400).json({ error: 'Invalid range, use 1h|24h|30d' });

    const points = (await db.all(
      `WITH per_device AS (
         SELECT device_id, (${spec.tsCol} / ?) * ? AS bucket, AVG(${spec.powerCol}) AS avg_w
         FROM ${spec.table}
         WHERE ${spec.tsCol} >= ? AND ${spec.powerCol} IS NOT NULL
         GROUP BY 1, 2
       )
       SELECT bucket AS ts, SUM(avg_w) AS power_w
       FROM per_device
       GROUP BY bucket
       ORDER BY bucket`,
      [spec.bucketMs, spec.bucketMs, Date.now() - spec.fromMs]
    )) as { ts: number; power_w: number }[];

    res.json({ range, points: points.map((p) => ({ ts: p.ts, power_w: Math.round(p.power_w * 10) / 10 })) });
  }));

  app.get('/api/devices/:id/stats/live', asyncHandler(async (req, res) => {
    const row = (await db.get(
      'SELECT payload, received_at FROM metrics_live WHERE device_id = ?',
      req.params.id
    )) as { payload: string; received_at: number } | undefined;

    let live: AgentSnapshot | null = null;
    if (row) {
      try {
        live = JSON.parse(row.payload) as AgentSnapshot;
      } catch {
        live = null;
      }
    }
    res.json({ live, last_seen: row?.received_at ?? null });
  }));

  app.get('/api/devices/:id/stats/history', asyncHandler(async (req, res) => {
    const device = await db.get('SELECT id FROM devices WHERE id = ?', req.params.id);
    if (!device) return res.status(404).json({ error: 'Device not found' });

    const range = String(req.query.range ?? '24h');
    const spec = HISTORY_RANGES[range];
    if (!spec) return res.status(400).json({ error: 'Invalid range, use 1h|6h|24h|7d|30d|1y' });

    const nowTs = Date.now();
    let points: { ts: number; cpu_avg: number | null; cpu_max: number | null; mem_avg: number | null; mem_max: number | null; gpu_avg: number | null; gpu_max: number | null; power_avg: number | null; power_max: number | null; net_rx_avg: number | null; net_tx_avg: number | null }[];

    if (spec.source === 'raw') {
      points = (await db.all(
        `SELECT (ts / ?) * ? AS ts, AVG(cpu) AS cpu_avg, MAX(cpu) AS cpu_max, AVG(mem_pct) AS mem_avg, MAX(mem_pct) AS mem_max,
                AVG(gpu_util) AS gpu_avg, MAX(gpu_util) AS gpu_max, AVG(power_total_w) AS power_avg, MAX(power_total_w) AS power_max,
                AVG(net_rx) AS net_rx_avg, AVG(net_tx) AS net_tx_avg
         FROM metrics_raw WHERE device_id = ? AND ts >= ? GROUP BY 1 ORDER BY 1`,
        [spec.bucketMs, spec.bucketMs, req.params.id, nowTs - spec.fromMs]
      )) as typeof points;
    } else {
      points = (await db.all(
        `SELECT bucket AS ts, AVG(cpu_avg) AS cpu_avg, MAX(cpu_max) AS cpu_max, AVG(mem_pct_avg) AS mem_avg, MAX(mem_pct_max) AS mem_max,
                AVG(gpu_util_avg) AS gpu_avg, MAX(gpu_util_max) AS gpu_max, AVG(power_total_w_avg) AS power_avg, MAX(power_total_w_max) AS power_max,
                AVG(net_rx_avg) AS net_rx_avg, AVG(net_tx_avg) AS net_tx_avg
         FROM metrics_${spec.source} WHERE device_id = ? AND bucket >= ? GROUP BY bucket ORDER BY bucket`,
        [req.params.id, nowTs - spec.fromMs]
      )) as typeof points;
    }

    res.json({ device_id: Number(req.params.id), range, points });
  }));

  app.get('/api/devices/:id/stats/energy', asyncHandler(async (req, res) => {
    const device = (await db.get(
      'SELECT id, base_power_w FROM devices WHERE id = ?',
      req.params.id
    )) as { id: number; base_power_w: number | null } | undefined;
    if (!device) return res.status(404).json({ error: 'Device not found' });

    const range = String(req.query.range ?? '24h');
    const spec = HISTORY_RANGES[range];
    if (!spec) return res.status(400).json({ error: 'Invalid range, use 1h|6h|24h|7d|30d|1y' });

    const { agentIntervalS } = await getRefreshSettings(db);
    const bd = await computeEnergyBreakdown(db, spec, Number(req.params.id), agentIntervalS);
    const baseKwh = basePowerKwh(device.base_power_w, bd.onlineS);
    const components: { key: string; label: string; avg_w: number | null; kwh: number }[] = [];
    if (bd.cpuKwh > 0) {
      components.push({ key: 'cpu', label: 'CPU', avg_w: bd.cpuAvgW, kwh: Math.round(bd.cpuKwh * 10000) / 10000 });
    }
    for (let i = 0; i < 4; i += 1) {
      const gpuKwh = bd.gpuKwh[i];
      if (gpuKwh !== null && gpuKwh > 0) {
        components.push({
          key: `gpu${i + 1}`,
          label: `GPU ${i + 1}`,
          avg_w: bd.gpuAvgW[i],
          kwh: Math.round(gpuKwh * 10000) / 10000,
        });
      }
    }

    res.json({
      ...(await respondEnergy(range, bd.totalKwh + baseKwh)),
      base_power_w: device.base_power_w,
      base_kwh: Math.round(baseKwh * 10000) / 10000,
      components,
    });
  }));

  // Data export / import
  const EXPORT_KEYS = `id, name, ip, mac, type, profile_id, broadcast_address, active, base_power_w, interfaces, group_id, position, poweroff_action, reboot_action, hibernate_action, disable_power, disable_ping, disable_terminal, disable_agent_update`;

  app.get('/api/data/export', asyncHandler(async (_req, res) => {
    const devices = await db.all(`SELECT ${EXPORT_KEYS} FROM devices`);
    const profiles = await db.all(`SELECT id, name, username, auth_type, password, private_key FROM profiles`);
    const groups = (await db.all('SELECT id, name, icon, color, position FROM groups ORDER BY position ASC')) as unknown[];
    res.json({ devices, profiles, groups });
  }));

  app.post('/api/data/import', express.json({ limit: '10mb' }), asyncHandler(async (req, res) => {
    const { devices, profiles, groups } = req.body ?? {};
    if (!Array.isArray(devices) && !Array.isArray(profiles) && !Array.isArray(groups)) {
      return res.status(400).json({ error: 'Request must include at least one of "devices", "profiles" or "groups"' });
    }

    // Collect referenced profile_ids from imported profiles first
    const profileIds = new Set<number>();
    if (Array.isArray(profiles)) {
      for (const p of profiles) {
        if (typeof p.id === 'number' && p.id > 0) profileIds.add(p.id);
      }
    }

    // Validate devices before any writes
    if (Array.isArray(devices)) {
      const errors: string[] = [];
      for (const d of devices) {
        const invalid = validateDeviceInput(d);
        if (invalid) errors.push(`device ${d.id ?? '?'}: ${invalid}`);
        if (d.profile_id !== null && d.profile_id !== undefined && d.profile_id !== '') {
          if (!profileIds.has(Number(d.profile_id))) {
            errors.push(`device ${d.id ?? '?'}: profile_id ${d.profile_id} not found in import payload`);
          }
        }
      }
      if (errors.length) return res.status(400).json({ error: errors.join('; ') });
    }

    // --- Groups upsert ---
    const groupMap = new Map<number, number>();
    if (Array.isArray(groups)) {
      for (const g of groups) {
        const name = isNonEmptyString(g?.name) ? String(g.name).trim() : null;
        if (!name) continue;
        const icon = typeof g.icon === 'string' && GROUP_ICONS.includes(g.icon as GroupIcon) ? String(g.icon) : 'boxes';
        const color = typeof g.color === 'string' && GROUP_COLORS.includes(g.color as GroupColor) ? String(g.color) : 'slate';
        let localId: number | null = null;
        if (typeof g.id === 'number' && g.id > 0) {
          const byId = (await db.get('SELECT id FROM groups WHERE id = ?', [g.id])) as { id: number } | undefined;
          if (byId) localId = Number(byId.id);
        }
        if (!localId) {
          const byName = (await db.get('SELECT id FROM groups WHERE name = ?', [name])) as { id: number } | undefined;
          if (byName) localId = Number(byName.id);
        }
        if (localId !== null) {
          await db.run('UPDATE groups SET name = ?, icon = ?, color = ? WHERE id = ?', [name, icon, color, localId]);
        } else {
          const posRow = (await db.get('SELECT COALESCE(MAX(position), -1) AS m FROM groups')) as { m: number };
          const ins = await db.run(
            'INSERT INTO groups (id, name, icon, color, position) VALUES (?, ?, ?, ?, ?)',
            [typeof g.id === 'number' && g.id > 0 ? Number(g.id) : null, name, icon, color, Number(posRow?.m ?? -1) + 1]
          );
          localId = Number(ins.lastID);
        }
        if (typeof g.id === 'number' && g.id > 0) groupMap.set(Number(g.id), localId);
      }
    }

    // --- Profiles upsert ---
    if (Array.isArray(profiles)) {
      for (const p of profiles) {
        const name = isNonEmptyString(p.name) ? String(p.name).trim() : null;
        const username = isNonEmptyString(p.username) ? String(p.username).trim() : null;
        if (!name || !username) continue;

        // Determine current state
        const existing = await db.get(
          'SELECT id, auth_type, password, private_key FROM profiles WHERE name = ? AND username = ?',
          [name, username]
        );

        let pw: string | null | undefined = p.password ?? existing?.password;
        let pk: string | null | undefined = p.private_key ?? existing?.private_key;

        // Validate auth_type
        const authType = p.auth_type === 'password' || p.auth_type === 'key' ? p.auth_type : (existing?.auth_type ?? 'password');

        // Encrypt if plain text credential provided
        if (authType === 'password' && isNonEmptyString(p.password) && !String(p.password).startsWith(ENC_PREFIX)) {
          pw = encryptCredential(p.password, encKey);
        } else if (!pw || pw.startsWith(ENC_PREFIX)) {
          // keep existing or pass-through encrypted value as-is
        }

        if (authType === 'key' && isNonEmptyString(p.private_key) && !String(p.private_key).startsWith(ENC_PREFIX)) {
          pk = encryptCredential(p.private_key, encKey);
        } else if (!pk || pk.startsWith(ENC_PREFIX)) {
          // keep existing or pass-through encrypted value as-is
        }

        if (existing) {
          await db.run(
            `UPDATE profiles SET name = ?, username = ?, auth_type = ?, password = ?, private_key = ? WHERE id = ?`,
            [name, username, authType, pw, pk, existing.id]
          );
        } else {
          await db.run(
            `INSERT INTO profiles (id, name, username, auth_type, password, private_key)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [p.id > 0 ? Number(p.id) : null, name, username, authType, pw, pk]
          );
        }
      }
    }

    // Fix profile_ids that were not in the original payload (newly inserted profiles from import)
    if (Array.isArray(profiles)) {
      for (const p of profiles) {
        if (typeof p.id === 'number' && p.id > 0) profileIds.add(p.id);
      }
    }

    // --- Devices upsert ---
    if (Array.isArray(devices)) {
      for (const d of devices) {
        const name = isNonEmptyString(d.name) ? String(d.name).trim() : null;
        const ip = isNonEmptyString(d.ip) ? String(d.ip).trim() : null;
        if (!name || !ip) continue;

        const existing = await db.get(
          `SELECT id FROM devices WHERE name = ? AND ip = ?`,
          [name, ip]
        );

        const mac = isNonEmptyString(d.mac) ? String(d.mac).trim() : null;
        const bcast = isNonEmptyString(d.broadcast_address) ? String(d.broadcast_address).trim() : null;
        const ifaces = normalizeStoredInterfaces(d.interfaces);
        const profileId = d.profile_id !== null && d.profile_id !== undefined && d.profile_id !== '' ? Number(d.profile_id) : null;
        const poweroffAction = parseActionOverride(d.poweroff_action, POWER_OFF_ACTIONS);
        const rebootAction = parseActionOverride(d.reboot_action, REBOOT_ACTIONS);
        const hibernateAction = parseActionOverride(d.hibernate_action, HIBERNATE_ACTIONS);
        const disablePower = parseDisableFlag(d.disable_power);
        const disablePing = parseDisableFlag(d.disable_ping);
        const disableTerminal = parseDisableFlag(d.disable_terminal);
        const disableAgentUpdate = parseDisableFlag(d.disable_agent_update);

        let groupLocalId: number | null = null;
        if (d.group_id !== null && d.group_id !== undefined && d.group_id !== '') {
          const gid = Number(d.group_id);
          if (groupMap.has(gid)) {
            groupLocalId = groupMap.get(gid) ?? null;
          } else if (Number.isInteger(gid) && gid > 0) {
            const localGroup = (await db.get('SELECT id FROM groups WHERE id = ?', [gid])) as { id: number } | undefined;
            groupLocalId = localGroup ? Number(localGroup.id) : null;
          }
        }

        if (existing) {
          await db.run(
            `UPDATE devices SET name = ?, ip = ?, mac = ?, type = ?, profile_id = ?, broadcast_address = ?, active = ?, base_power_w = ?, interfaces = ?, group_id = ?, poweroff_action = ?, reboot_action = ?, hibernate_action = ?, disable_power = ?, disable_ping = ?, disable_terminal = ?, disable_agent_update = ? WHERE id = ?`,
            [name, ip, mac, d.type, profileId, bcast, (d.active === undefined || d.active === true || d.active === 1) ? 1 : 0, parseBasePowerW(d.base_power_w), ifaces, groupLocalId, poweroffAction, rebootAction, hibernateAction, disablePower, disablePing, disableTerminal, disableAgentUpdate, existing.id]
          );
        } else {
          const importedPosition = Number.isInteger(Number(d.position)) ? Math.max(0, Number(d.position)) : 0;
          await db.run(
            `INSERT INTO devices (id, name, ip, mac, type, profile_id, broadcast_address, active, agent_token, base_power_w, interfaces, group_id, position, poweroff_action, reboot_action, hibernate_action, disable_power, disable_ping, disable_terminal, disable_agent_update)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [d.id > 0 ? Number(d.id) : null, name, ip, mac, d.type, profileId, bcast, (d.active === undefined || d.active === true || d.active === 1) ? 1 : 0, parseBasePowerW(d.base_power_w), ifaces, groupLocalId, importedPosition, poweroffAction, rebootAction, hibernateAction, disablePower, disablePing, disableTerminal, disableAgentUpdate]
          );
        }
      }
    }

    // Normalize per-group ordering after import
    const allGroups = (await db.all('SELECT id FROM groups')) as { id: number }[];
    await reindexGroupPositions(db, null);
    for (const g of allGroups) {
      await reindexGroupPositions(db, Number(g.id));
    }

    res.json({ success: true });
  }));

  // ---- API token management (admin JWT) ----
  const parseApiTokenBody = async (
    body: Record<string, unknown>,
    requireLabel: boolean
  ): Promise<
    | { label?: string; permissions?: string[]; device_ids?: number[]; enabled?: boolean; expires_at?: number | null }
    | string
  > => {
    const out: { label?: string; permissions?: string[]; device_ids?: number[]; enabled?: boolean; expires_at?: number | null } = {};

    if (body.label !== undefined) {
      if (!isNonEmptyString(body.label)) return 'Label is required';
      out.label = String(body.label).trim();
    } else if (requireLabel) {
      return 'Label is required';
    }

    if (body.permissions !== undefined) {
      const perms = parseApiPermissions(body.permissions);
      if (perms === null) return 'Invalid permissions';
      out.permissions = perms;
    }

    if (body.device_ids !== undefined) {
      const ids = parseApiDeviceIds(body.device_ids);
      if (ids === null) return 'Invalid device scope';
      for (const id of ids) {
        const exists = await db.get('SELECT id FROM devices WHERE id = ?', id);
        if (!exists) return 'A device in the token scope does not exist';
      }
      out.device_ids = ids;
    }

    if (body.enabled !== undefined) out.enabled = body.enabled === true || body.enabled === 1;

    if (body.expires_at !== undefined) {
      if (body.expires_at === null) {
        out.expires_at = null;
      } else if (typeof body.expires_at === 'number' && Number.isFinite(body.expires_at)) {
        if (body.expires_at <= Date.now()) return 'Expiration must be in the future';
        out.expires_at = Math.floor(body.expires_at);
      } else {
        return 'Invalid expiration';
      }
    }

    return out;
  };

  app.get('/api/api-tokens', asyncHandler(async (_req, res) => {
    const rows = (await db.all('SELECT * FROM api_tokens ORDER BY id ASC')) as ApiTokenRow[];
    res.json(rows.map(toPublicApiToken));
  }));

  app.post('/api/api-tokens', asyncHandler(async (req, res) => {
    const parsed = await parseApiTokenBody(req.body ?? {}, true);
    if (typeof parsed === 'string') return res.status(400).json({ error: parsed });

    const token = generateApiToken();
    const result = await db.run(
      `INSERT INTO api_tokens (label, token_hash, permissions, device_ids, enabled, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        parsed.label as string,
        hashApiToken(token),
        JSON.stringify(parsed.permissions ?? []),
        JSON.stringify(parsed.device_ids ?? []),
        parsed.enabled === false ? 0 : 1,
        Date.now(),
        parsed.expires_at ?? null,
      ]
    );
    res.json({ id: Number(result.lastID), token });
  }));

  app.put('/api/api-tokens/:id', asyncHandler(async (req, res) => {
    const row = (await db.get('SELECT * FROM api_tokens WHERE id = ?', req.params.id)) as ApiTokenRow | undefined;
    if (!row) return res.status(404).json({ error: 'API token not found' });

    const parsed = await parseApiTokenBody(req.body ?? {}, false);
    if (typeof parsed === 'string') return res.status(400).json({ error: parsed });

    const label = parsed.label !== undefined ? parsed.label : row.label;
    const permissions = parsed.permissions !== undefined ? parsed.permissions : JSON.parse(row.permissions) as string[];
    const deviceIds = parsed.device_ids !== undefined ? parsed.device_ids : JSON.parse(row.device_ids) as number[];
    const enabled = parsed.enabled !== undefined ? (parsed.enabled ? 1 : 0) : row.enabled;
    const expiresAt = parsed.expires_at !== undefined ? parsed.expires_at : row.expires_at;

    await db.run(
      'UPDATE api_tokens SET label = ?, permissions = ?, device_ids = ?, enabled = ?, expires_at = ? WHERE id = ?',
      [label, JSON.stringify(permissions), JSON.stringify(deviceIds), enabled, expiresAt, row.id]
    );
    res.json(toPublicApiToken({
      ...row,
      label,
      permissions: JSON.stringify(permissions),
      device_ids: JSON.stringify(deviceIds),
      enabled,
      expires_at: expiresAt,
    }));
  }));

  app.delete('/api/api-tokens/:id', asyncHandler(async (req, res) => {
    const row = await db.get('SELECT id FROM api_tokens WHERE id = ?', req.params.id);
    if (!row) return res.status(404).json({ error: 'API token not found' });
    await db.run('DELETE FROM api_usage WHERE token_id = ?', req.params.id);
    await db.run('DELETE FROM api_tokens WHERE id = ?', req.params.id);
    res.json({ success: true });
  }));

  app.post('/api/api-tokens/:id/rotate', asyncHandler(async (req, res) => {
    const row = await db.get('SELECT id FROM api_tokens WHERE id = ?', req.params.id);
    if (!row) return res.status(404).json({ error: 'API token not found' });
    const token = generateApiToken();
    await db.run('UPDATE api_tokens SET token_hash = ? WHERE id = ?', [hashApiToken(token), row.id]);
    res.json({ id: Number(row.id), token });
  }));

  app.get('/api/api-tokens/stats', asyncHandler(async (req, res) => {
    const range = String(req.query.range ?? '7d');
    const rangeMs = range === '30d' ? 30 * DAY_MS : range === '7d' ? 7 * DAY_MS : null;
    if (rangeMs === null) return res.status(400).json({ error: 'Invalid range' });

    const tokens = (await db.all('SELECT * FROM api_tokens ORDER BY id ASC')) as ApiTokenRow[];
    const usageRows = (await db.all(
      `SELECT token_id, operation, COUNT(*) AS c FROM api_usage WHERE created_at >= ? GROUP BY token_id, operation`,
      [Date.now() - rangeMs]
    )) as { token_id: number; operation: string; c: number }[];

    const statsById = new Map<number, { total: number; operations: Record<string, number> }>();
    for (const t of tokens) {
      statsById.set(t.id, { total: 0, operations: { status: 0, start: 0, stop: 0, restart: 0 } });
    }
    for (const u of usageRows) {
      const entry = statsById.get(u.token_id);
      if (!entry || !(u.operation in entry.operations)) continue;
      entry.total += u.c;
      entry.operations[u.operation as string] += u.c;
    }

    res.json({
      tokens: tokens.map((t) => ({
        token_id: t.id,
        label: t.label,
        total: statsById.get(t.id)?.total ?? 0,
        operations: statsById.get(t.id)?.operations ?? { status: 0, start: 0, stop: 0, restart: 0 },
        last_used_at: t.last_used_at,
      })),
    });
  }));

  app.get('/api/api-tokens/logs', asyncHandler(async (_req, res) => {
    const rows = (await db.all(
      `SELECT u.id, u.token_id, t.label AS token_label, u.operation, u.device_id, d.name AS device_name, u.status_code, u.created_at
       FROM api_usage u
       LEFT JOIN api_tokens t ON t.id = u.token_id
       LEFT JOIN devices d ON d.id = u.device_id
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT 20`
    )) as { id: number; token_id: number; token_label: string | null; operation: string; device_id: number | null; device_name: string | null; status_code: number; created_at: number }[];

    res.json({ logs: rows });
  }));

  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Global error handler
  app.use(
    (err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = typeof err.status === 'number' && err.status >= 400 ? err.status : 500;
      if (status === 500) console.error('Unhandled error:', err);
      else console.warn(`Rejected request (${status}): ${err.message}`);
      if (res.headersSent) return;
      res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message || 'Bad request' });
    }
  );

  return app;
}

// ---- WOL helpers ----

function getBroadcastAddresses(): string[] {
  const addresses: string[] = ['255.255.255.255'];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    const iface = ifaces[name];
    if (!iface) continue;
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal) {
        const ipParts = info.address.split('.').map(Number);
        const maskParts = info.netmask.split('.').map(Number);
        const broadcast = ipParts.map((part, i) => part | (~maskParts[i] & 255)).join('.');
        if (!addresses.includes(broadcast)) {
          addresses.push(broadcast);
        }
      }
    }
  }
  return addresses;
}

function normalizeMac(mac: string): string {
  return mac.replace(/[^a-fA-F0-9]/g, '');
}

function sendWoL(mac: string, address: string, port = 9): Promise<void> {
  return new Promise((resolve, reject) => {
    const macStr = normalizeMac(mac);
    if (macStr.length !== 12) {
      return reject(new Error(`Invalid MAC address: ${mac}`));
    }

    const macBuffer = Buffer.from(macStr, 'hex');
    const packet = Buffer.alloc(6 + 16 * 6);
    for (let i = 0; i < 6; i += 1) packet[i] = 0xff;
    for (let i = 0; i < 16; i += 1) macBuffer.copy(packet, 6 + i * 6);

    const socket = dgram.createSocket('udp4');
    socket.on('error', (err) => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      reject(err);
    });

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        // broadcast permission unavailable on this interface
      }
      socket.send(packet, 0, packet.length, port, address, (err) => {
        try {
          socket.close();
        } catch {
          // already closed
        }
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

function computeBroadcastFromIp(ip: string): string | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  return `${parts.slice(0, 3).join('.')}.255`;
}

// ---- Agent payload (installer served at GET /api/agent/install) ----

const ENSURE_INTEL_GPU_TOOLS = String.raw`ensure_intel_gpu_tools() {
  drm=/sys/class/drm
  [ -n "$DRM_DIR" ] && drm="$DRM_DIR"
  if ! grep -q '^DRIVER=i915$' $drm/card*/device/uevent 2>/dev/null; then
    return 0
  fi
  command -v intel_gpu_top >/dev/null 2>&1 && return 0
  echo "Intel iGPU detected - installing intel-gpu-tools for GPU power metrics (best effort)..." >&2
  pkgok=1
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y intel-gpu-tools >/dev/null 2>&1 || pkgok=0
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y intel-gpu-tools >/dev/null 2>&1 || pkgok=0
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm intel-gpu-tools >/dev/null 2>&1 || pkgok=0
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache intel-gpu-tools >/dev/null 2>&1 || pkgok=0
  fi
  if [ "$pkgok" = "0" ]; then
    echo "WARNING: could not install intel-gpu-tools; Intel GPU power metrics will be unavailable" >&2
    echo failed
    return 1
  fi
  echo installed
  return 0
}

`;

const AGENT_SCRIPT_TPL = String.raw`#!/bin/sh
# OpenHomeLab agent - pushes system metrics to the OpenHomeLab server
AGENT_VERSION="${AGENT_VERSION}"

if [ -z "$1" ]; then CONFIG=/etc/openhomelab/agent.conf; else CONFIG=$1; fi

STATE_DIR=$(mktemp -d /tmp/openhomelab-agent.XXXXXX 2>/dev/null) || STATE_DIR=/tmp/.openhomelab-agent-$$
trap 'rm -rf "$STATE_DIR"' EXIT
trap 'exit 0' INT TERM

if [ ! -r "$CONFIG" ]; then
  echo "config file not found: $CONFIG" >&2
  exit 1
fi
. "$CONFIG"

if [ -z "$SERVER_URL" ] || [ -z "$TOKEN" ]; then
  echo "SERVER_URL and TOKEN must be set in $CONFIG" >&2
  exit 1
fi
if [ -z "$INTERVAL" ]; then INTERVAL=__AGENT_INTERVAL__; fi

read_cpu() {
  grep '^cpu ' /proc/stat | awk '{t=0; for(i=2;i<=NF;i++) t+=$i; printf "%.0f %.0f\n", t, $5+$6}'
}

net_totals() {
  awk 'NR>1 && $1 !~ /lo:/ {r+=$2; t+=$10} END{printf "%.0f %.0f\n", r, t}' /proc/net/dev
}

num_or_null() {
  case "$1" in ''|*[!0-9.-]*) echo null ;; *) echo "$1" ;; esac
}

num_or_zero() {
  case "$1" in ''|*[!0-9.-]*) echo 0 ;; *) echo "$1" ;; esac
}

json_str_field() {
  esc=$(printf '%s' "$1" | tr -d '\\"' | cut -c1-128)
  if [ -z "$esc" ]; then echo null; else printf '"%s"' "$esc"; fi
}

is_darwin() {
  [ "$(uname -s)" = "Darwin" ]
}

vga_names() {
  command -v lspci >/dev/null 2>&1 || return 0
  lspci 2>/dev/null | awk 'tolower($0) ~ /vga compatible controller|display controller/ { line=$0; sub(/^[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-9][[:space:]]*/, "", line); sub(/^[^:]*:[[:space:]]*/, "", line); print line }'
}

os_collect() {
  OS_FAMILY=""; OS_NAME=""; OS_ID=""; KERNEL=""; CPU_VENDOR=""; CPU_MODEL=""; CPU_CORES=""; CPU_FREQ_GHZ=""
  if is_darwin; then
    OS_FAMILY=macos
    OS_ID=macos
    p_name=$(sw_vers -productName 2>/dev/null)
    p_ver=$(sw_vers -productVersion 2>/dev/null)
    [ -n "$p_name" ] && OS_NAME=$p_name
    [ -n "$p_ver" ] && OS_NAME="$OS_NAME $p_ver"
    KERNEL=$(sw_vers -buildVersion 2>/dev/null)
    CPU_MODEL=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)
    [ -z "$CPU_MODEL" ] && CPU_MODEL=$(sysctl -n hw.model 2>/dev/null)
    CPU_CORES=$(sysctl -n hw.ncpu 2>/dev/null)
    cfreq_hz=$(sysctl -n hw.cpufrequency_max 2>/dev/null)
    case "$cfreq_hz" in ''|*[!0-9]*) ;; *)
      CPU_FREQ_GHZ=$(awk -v hz="$cfreq_hz" 'BEGIN{if (hz>=1000000000) printf "%.2f", hz/1000000000; else if (hz>1000) printf "%.2f", hz/1000}')
      ;;
    esac
    return
  fi
  OS_FAMILY=linux
  KERNEL=$(uname -r 2>/dev/null)
  osrel=/etc/os-release
  [ -r "$osrel" ] || osrel=/usr/lib/os-release
  if [ -r "$osrel" ]; then
    p_name=$(awk -F= '$1=="NAME"{print $2}' "$osrel" | tr -d '"')
    p_id=$(awk -F= '$1=="ID"{print $2}' "$osrel" | tr -d '"')
    p_vers=$(awk -F= '$1=="VERSION_ID"{print $2}' "$osrel" | tr -d '"')
    [ -z "$p_vers" ] && p_vers=$(awk -F= '$1=="VERSION"{v=$2; gsub(/"/,"",v); if (v ~ /^[0-9]/) print v}' "$osrel")
    OS_NAME=$p_name
    [ -n "$p_vers" ] && OS_NAME="$OS_NAME $p_vers"
    OS_ID=$(printf '%s' "$p_id" | tr 'A-Z' 'a-z')
  fi
  if [ -r /proc/device-tree/model ]; then
    dt_model=$(tr '\000' ' ' < /proc/device-tree/model 2>/dev/null)
    case "$dt_model" in
      *Raspberry\ Pi*) OS_ID=raspberrypi ;;
    esac
  fi
  CPU_VENDOR=$(awk '/vendor_id/{print $3; exit}' /proc/cpuinfo 2>/dev/null)
  CPU_MODEL=$(awk -F: '/model name/{v=$2; sub(/^[[:space:]]*/,"",v); print v; exit}' /proc/cpuinfo 2>/dev/null)
  CPU_CORES=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)
  case "$CPU_CORES" in ''|*[!0-9]*) CPU_CORES="" ;; esac
  max_khz=$(cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq 2>/dev/null)
  [ -z "$max_khz" ] && max_khz=$(awk '/cpu MHz/{v=$4+0; if (v>0) { printf "%.0f", v*1000; exit }}' /proc/cpuinfo 2>/dev/null)
  case "$max_khz" in ''|*[!0-9]*) ;; *) CPU_FREQ_GHZ=$(awk -v khz="$max_khz" 'BEGIN{printf "%.2f", khz/1000000}') ;; esac
}

collect_cpu_usage() {
  if is_darwin; then
    idle_pct=$(LC_ALL=C top -l 1 -s 1 2>/dev/null | awk '/CPU usage/ { for (i = NF; i >= 1; i--) if ($i == "idle") { print $(i-1); exit } }' | tr -cd '0-9.')
    case "$idle_pct" in ''|*[!0-9.]*) CPU_USAGE=0.0 ;; *) CPU_USAGE=$(awk -v i="$idle_pct" 'BEGIN{p=100-i; if(p<0)p=0; if(p>100)p=100; printf "%.1f", p}') ;; esac
    return
  fi
  cpu_a=$(read_cpu)
  sleep 1
  cpu_b=$(read_cpu)
  set -- $cpu_a
  total_a=$1; idle_a=$2
  set -- $cpu_b
  total_b=$1; idle_b=$2
  CPU_USAGE=$(awk -v ta="$total_a" -v tb="$total_b" -v ia="$idle_a" -v ib="$idle_b" \
    'BEGIN{dt=tb-ta; di=ib-ia; if(dt<=0){printf "0.0"; exit} p=(1-di/dt)*100; if(p<0)p=0; if(p>100)p=100; printf "%.1f", p}')
}

collect_memory() {
  mem_total=0
  mem_used=0
  if is_darwin; then
    mt=$(sysctl -n hw.memsize 2>/dev/null)
    case "$mt" in ''|*[!0-9]*) ;; *) mem_total=$mt ;; esac
    page_size=$(sysctl -n hw.pagesize 2>/dev/null)
    case "$page_size" in ''|*[!0-9]*|0) page_size=4096 ;; esac
    free_pages=$(vm_stat 2>/dev/null | awk '/^Pages free/{print $3}' | tr -cd '0-9')
    inactive_pages=$(vm_stat 2>/dev/null | awk '/^Pages inactive/{print $3}' | tr -cd '0-9')
    [ -z "$free_pages" ] && free_pages=0
    [ -z "$inactive_pages" ] && inactive_pages=0
    mem_used=$(awk -v t="$mem_total" -v f="$free_pages" -v i="$inactive_pages" -v ps="$page_size" 'BEGIN{d=t-(f+i)*ps; if(d<0)d=0; if(d>t)d=t; printf "%.0f", d}')
    return
  fi
  mem_total=$(awk '/^MemTotal:/{printf "%.0f", $2*1024}' /proc/meminfo)
  mem_avail=$(awk '/^MemAvailable:/{printf "%.0f", $2*1024}' /proc/meminfo)
  [ -z "$mem_total" ] && mem_total=0
  [ -z "$mem_avail" ] && mem_avail=0
  mem_used=$(awk -v a="$mem_total" -v b="$mem_avail" 'BEGIN{d=a-b; if(d<0)d=0; printf "%.0f", d}')
}

collect_swap() {
  swap_total=0
  swap_used=0
  if is_darwin; then
    st=$(sysctl -n vm.swapusage 2>/dev/null)
    case "$st" in *M*)
      swap_total=$(printf '%s' "$st" | awk -F'total = ' 'NF>1{split($2,a," "); v=a[1]; gsub(/[^0-9.]/,"",v); printf "%.0f", v*1048576}')
      swap_used=$(printf '%s' "$st" | awk -F'used = ' 'NF>1{split($2,a," "); v=a[1]; gsub(/[^0-9.]/,"",v); printf "%.0f", v*1048576}')
      ;;
    esac
    return
  fi
  swap_total=$(awk '/^SwapTotal:/{printf "%.0f", $2*1024}' /proc/meminfo)
  swap_free=$(awk '/^SwapFree:/{printf "%.0f", $2*1024}' /proc/meminfo)
  [ -z "$swap_total" ] && swap_total=0
  [ -z "$swap_free" ] && swap_free=0
  swap_used=$(awk -v a="$swap_total" -v b="$swap_free" 'BEGIN{d=a-b; if(d<0)d=0; printf "%.0f", d}')
}

collect_loadavg() {
  load1=""; load5=""; load15=""
  if is_darwin; then
    set -- $(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}')
  else
    set -- $(cat /proc/loadavg)
  fi
  load1=$1; load5=$2; load15=$3
  case "$load1" in ''|*[!0-9.]*) load1=0 ;; esac
  case "$load5" in ''|*[!0-9.]*) load5=0 ;; esac
  case "$load15" in ''|*[!0-9.]*) load15=0 ;; esac
}

collect_uptime() {
  if is_darwin; then
    bt=$(sysctl -n kern.boottime 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+$/ && $i + 0 > 1000000) {print $i; exit}}')
    [ -z "$bt" ] && bt=0
    now=$(date +%s)
    uptime_s=$((now - bt))
    [ "$uptime_s" -lt 0 ] && uptime_s=0
    return
  fi
  uptime_s=$(cut -d' ' -f1 /proc/uptime | cut -d. -f1)
  [ -z "$uptime_s" ] && uptime_s=0
}

GPU_SOURCE=none
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name >/dev/null 2>&1; then
  GPU_SOURCE=nvidia
else
  for d in /sys/class/drm/card*/device; do
    if [ -r "$d/gpu_busy_percent" ]; then GPU_SOURCE=amdgpu; break; fi
  done
fi
if [ "$GPU_SOURCE" = "none" ]; then
  for d in /sys/class/drm/card*/device; do
    if grep -q '^DRIVER=i915$' "$d/uevent" 2>/dev/null; then GPU_SOURCE=intel; break; fi
  done
fi
IGT_CPU_W=""
IGT_RUN=""
if [ "$GPU_SOURCE" = "intel" ] && command -v intel_gpu_top >/dev/null 2>&1; then
  if intel_gpu_top --help 2>&1 | grep -qE '(^|[[:space:]])-n([ ,]|$)'; then
    IGT_RUN="intel_gpu_top -c -s 500 -n 1"
  elif command -v timeout >/dev/null 2>&1; then
    IGT_RUN="timeout 2 intel_gpu_top -c -s 500"
  else
    IGT_RUN="intel_gpu_top -c -s 500"
  fi
fi

gpu_collect() {
  gpu_json=""
  if [ "$GPU_SOURCE" = "nvidia" ]; then
    nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits > "$STATE_DIR/nv" 2>/dev/null || : > "$STATE_DIR/nv"
    nvidia-smi --query-gpu=name --format=csv,noheader > "$STATE_DIR/nv_names" 2>/dev/null || : > "$STATE_DIR/nv_names"
    nvidia-smi --query-gpu=uuid --format=csv,noheader,nounits > "$STATE_DIR/nv_uuids" 2>/dev/null || : > "$STATE_DIR/nv_uuids"
    nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory,process_name --format=csv,noheader,nounits > "$STATE_DIR/nv_apps" 2>/dev/null || : > "$STATE_DIR/nv_apps"
    gi=0
    while IFS=',' read -r u mu mt t p; do
      [ -z "$(echo $u)" ] && continue
      gi=$((gi + 1))
      uuid=$(awk -v n="$gi" 'NR==n' "$STATE_DIR/nv_uuids")
      gname=$(awk -v n="$gi" 'NR==n' "$STATE_DIR/nv_names")
      procs_json=""
      np=0
      while IFS=',' read -r a_uuid pid mem pname; do
        [ "$a_uuid" = "$uuid" ] || continue
        case "$pid" in ''|*[!0-9]*) continue ;; esac
        esc=$(printf '%s' "$pname" | tr -d '\\"' | cut -c1-64)
        [ -z "$esc" ] && continue
        entry_p="{\"pid\":$pid,\"mem_mb\":$(num_or_zero $(echo $mem)),\"name\":\"$esc\"}"
        if [ -z "$procs_json" ]; then procs_json=$entry_p; else procs_json="$procs_json,$entry_p"; fi
        np=$((np + 1))
        [ $np -ge 32 ] && break
      done < "$STATE_DIR/nv_apps"
      entry="{\"name\":$(json_str_field "$gname"),\"util\":$(num_or_null $(echo $u)),\"mem_used_mb\":$(num_or_zero $(echo $mu)),\"mem_total_mb\":$(num_or_zero $(echo $mt)),\"temp_c\":$(num_or_null $(echo $t)),\"power_w\":$(num_or_null $(echo $p)),\"processes\":[$procs_json]}"
      if [ -z "$gpu_json" ]; then gpu_json=$entry; else gpu_json="$gpu_json,$entry"; fi
    done < "$STATE_DIR/nv"
  elif [ "$GPU_SOURCE" = "amdgpu" ]; then
    vga_names > "$STATE_DIR/vga"
    gi=0
    for d in /sys/class/drm/card*/device; do
      [ -r "$d/gpu_busy_percent" ] || continue
      gi=$((gi + 1))
      aname=$(awk -v n="$gi" 'NR==n' "$STATE_DIR/vga")
      [ -z "$aname" ] && aname="AMD GPU"
      vram_used=0
      vram_total=0
      if [ -r "$d/mem_info_vram_used" ]; then vram_used=$(($(cat "$d/mem_info_vram_used") / 1048576)); fi
      if [ -r "$d/mem_info_vram_total" ]; then vram_total=$(($(cat "$d/mem_info_vram_total") / 1048576)); fi
      entry="{\"name\":$(json_str_field "$aname"),\"util\":$(num_or_null $(echo $(cat "$d/gpu_busy_percent" 2>/dev/null))),\"mem_used_mb\":$vram_used,\"mem_total_mb\":$vram_total,\"temp_c\":null,\"power_w\":null,\"processes\":[]}"
      if [ -z "$gpu_json" ]; then gpu_json=$entry; else gpu_json="$gpu_json,$entry"; fi
    done
  elif [ "$GPU_SOURCE" = "intel" ] && command -v intel_gpu_top >/dev/null 2>&1; then
    hwmon_power_scan
    if [ "$pfound" -eq 0 ]; then IGT_NO_RAPL=1; else IGT_NO_RAPL=0; fi
    vga_names > "$STATE_DIR/vga"
    iname_g=$(head -n 1 "$STATE_DIR/vga" 2>/dev/null)
    [ -z "$iname_g" ] && iname_g="Intel integrated GPU"
    $IGT_RUN > "$STATE_DIR/igt" 2>/dev/null || true
    set -- $(awk -F, 'NR == 1 { for (i = 1; i <= NF; i++) idx[$i] = i; next } ("Power W pkg" in idx) && NF >= 3 { s_p += $idx["Power W pkg"]; if ("Power W gpu" in idx) { s_g += $idx["Power W gpu"]; g_seen = 1 } row = -1; for (k in idx) if (k ~ /%$/ && k != "RC6 %") { v = $idx[k] + 0; if (v > row) row = v }; if (row < 0) row = 0; usum += row; n++ } END { if (n == 0) { print "null null null"; exit }; gpu = g_seen ? sprintf("%.2f", s_g / n) : "null"; printf "%.1f %s %.2f", usum / n, gpu, s_p / n }' "$STATE_DIR/igt")
    i_util=$(num_or_null $1)
    i_gpuw=$(num_or_null $2)
    IGT_CPU_W=""
    case "$3" in ''|null) ;; *)
      if [ "$IGT_NO_RAPL" = "1" ]; then
        if [ "$i_gpuw" != "null" ]; then
          IGT_CPU_W=$(awk -v p="$3" -v g="$i_gpuw" 'BEGIN { d = p - g; if (d < 0) d = 0; printf "%.1f", d }')
        else
          IGT_CPU_W=$3
        fi
      else
        i_gpuw=null
      fi
    ;; esac
    entry="{\"name\":$(json_str_field "$iname_g"),\"util\":$i_util,\"mem_used_mb\":0,\"mem_total_mb\":0,\"temp_c\":null,\"power_w\":$i_gpuw,\"processes\":[]}"
    gpu_json=$entry
  fi
}

iface_kind() {
  i=$1
  if [ -e "/sys/class/net/$i/device" ]; then
    drv=$(readlink -f "/sys/class/net/$i/device/driver" 2>/dev/null)
    case "$drv" in *wireless*) echo '"wifi"'; return ;; esac
    if [ -L "/sys/class/net/$i/device/phy8xxx" ]; then echo '"wifi"'; return; fi
    echo '"eth"'; return
  fi
  echo null
}

ip_bcast() {
  # $1 = ipv4 dotted quad, $2 = prefix length
  [ -z "$1" ] && return 0
  awk -v a="$1" -v p="$2" 'BEGIN{
    if (split(a,o,".")!=4) exit
    f=o[1]*16777216+o[2]*65536+o[3]*256+o[4]
    hb=32-p
    if (hb<0) hb=0
    if (hb>32) hb=32
    step=2^hb
    b=int(f/step)*step+step-1
    printf "%d.%d.%d.%d", int(b/16777216), int(b/65536)%256, int(b/256)%256, b%256
  }'
}

collect_interfaces() {
  ifaces_json=""
  icount=0
  for i in /sys/class/net/*; do
    [ $icount -ge 16 ] && break
    iname=$(basename "$i")
    [ "$iname" = "lo" ] && continue
    imac=$(cat "$i/address" 2>/dev/null)
    [ -z "$imac" ] && continue
    ikind=$(iface_kind "$iname")
    iips=""
    ibcast=null
    if command -v ip >/dev/null 2>&1; then
      ip -4 -o addr show dev "$iname" > "$STATE_DIR/ia" 2>/dev/null || : > "$STATE_DIR/ia"
      while read -r _num _ifc _af _ipa _rest; do
        [ "$_af" = "inet" ] || continue
        bare=$(printf '%s' "$_ipa" | cut -d/ -f1)
        pfx=$(printf '%s' "$_ipa" | cut -d/ -f2)
        case "$pfx" in ''|*[!0-9]*) pfx=24 ;; esac
        if [ -z "$iips" ]; then iips="\"$bare\""; else iips="$iips,\"$bare\""; fi
        b=$(ip_bcast "$bare" "$pfx")
        [ -n "$b" ] && ibcast="\"$b\""
      done < "$STATE_DIR/ia"
    fi
    entry="{\"name\":\"$iname\",\"mac\":\"$imac\",\"kind\":$ikind,\"ips\":[$iips],\"broadcast\":$ibcast}"
    if [ -z "$ifaces_json" ]; then ifaces_json=$entry; else ifaces_json="$ifaces_json,$entry"; fi
    icount=$((icount + 1))
  done
}

hwmon_power_scan() {
  psum=0
  gsum=0
  pfound=0
  gfound=0
  for d in /sys/class/hwmon/hwmon*; do
    [ -d "$d" ] || continue
    n=1
    while [ "$n" -le 8 ]; do
      pf="$d/power$n"_average
      if [ -r "$pf" ]; then
        label=$(cat "$d/power$n"_label 2>/dev/null)
        case "$label" in
          *[Pp]ackage*)
            pv=$(cat "$pf" 2>/dev/null)
            case "$pv" in ''|*[!0-9]*) ;; *) psum=$((psum + pv)); pfound=1 ;; esac
            ;;
          *[Gg][Pp][Uu]*|*[Ss]o[Cc]*)
            pv=$(cat "$pf" 2>/dev/null)
            case "$pv" in ''|*[!0-9]*) ;; *) gsum=$((gsum + pv)); gfound=1 ;; esac
            ;;
        esac
      fi
      n=$((n + 1))
    done
  done
}

RPL_STATE=0
RPL_ES_MSR=""
RPL_NEXP=0
RPL_W=""
MSR_DEV=/dev/cpu/0/msr
if [ -n "$OHL_MSR_FILE" ]; then MSR_DEV="$OHL_MSR_FILE"; fi

rapl_msrd() {
  dd if="$MSR_DEV" bs=8 skip="$1" count=1 2>/dev/null | od -An -t u4 -N 8 | awk 'NF >= 2 { printf "%.0f", $1 + $2 * 4294967296 }'
}

rapl_msr_init() {
  [ "$(id -u)" = "0" ] || return 1
  modprobe msr 2>/dev/null || true
  [ -r "$MSR_DEV" ] || return 1
  rpl_unit=$(rapl_msrd 1542)
  [ -n "$rpl_unit" ] || return 1
  rpl_nexp=$(awk -v u="$rpl_unit" 'BEGIN { e = int(u / 256) % 32; if (e > 24) exit; print e }')
  [ -n "$rpl_nexp" ] || return 1
  RPL_ES_MSR=""
  rpl_cur=$(rapl_msrd 1553)
  case "$rpl_cur" in ''|0) ;; *) RPL_ES_MSR=1553 ;; esac
  if [ -z "$RPL_ES_MSR" ]; then
    rpl_cur=$(rapl_msrd 1601)
    case "$rpl_cur" in ''|0) ;; *) RPL_ES_MSR=1601 ;; esac
  fi
  [ -n "$RPL_ES_MSR" ] || return 1
  RPL_NEXP=$rpl_nexp
  RPL_STATE=1
}

rapl_msr_power() {
  [ "$RPL_STATE" = "1" ] || return 0
  RPL_W=""
  rpl_cur=$(rapl_msrd "$RPL_ES_MSR")
  [ -n "$rpl_cur" ] || return 0
  rpl_ts=$(date +%s)
  rpl_pf="$STATE_DIR/rapl_prev"
  rpl_prev=$(cat "$rpl_pf" 2>/dev/null)
  if [ -n "$rpl_prev" ]; then
    rpl_pts=$(printf '%s\n' "$rpl_prev" | awk '{print $1}')
    rpl_praw=$(printf '%s\n' "$rpl_prev" | awk '{print $2}')
    case "$rpl_pts$rpl_praw" in ''|*[!0-9]*) ;; *)
      rpl_dt=$((rpl_ts - rpl_pts))
      if [ $rpl_dt -ge 10 ] && [ $rpl_dt -le 900 ]; then
        rpl_pw=$(awk -v c="$rpl_cur" -v p="$rpl_praw" -v t="$rpl_dt" -v e="$RPL_NEXP" 'BEGIN { d = c - p; if (d < 0) d += 4294967296; pw = (d / t) * 0.001 / (2 ^ e); if (pw > 0 && pw < 400) printf "%.1f", pw }')
        [ -n "$rpl_pw" ] && RPL_W=$rpl_pw
      fi
    esac
  fi
  echo "$rpl_ts $rpl_cur" > "$rpl_pf"
}

cpu_power_collect() {
  cpu_power_w=null
  hwmon_gpu_w=null
  hwmon_power_scan
  if [ "$pfound" -eq 1 ]; then
    cpu_power_w=$(awk -v v="$psum" 'BEGIN{printf "%.1f", v/1000000}')
  elif [ -n "$IGT_CPU_W" ]; then
    cpu_power_w=$IGT_CPU_W
  else
    if [ "$RPL_STATE" = "0" ]; then
      rapl_msr_init
    fi
    rapl_msr_power
    if [ -n "$RPL_W" ]; then cpu_power_w=$RPL_W; fi
  fi
  if [ "$gfound" -eq 1 ]; then
    hwmon_gpu_w=$(awk -v v="$gsum" 'BEGIN{printf "%.1f", v/1000000}')
  fi
}

report_action_result() {
  aid=$1; st=$2; out="$3"
  [ -n "$aid" ] || return 0
  body="{\"action_id\":$aid,\"status\":\"$st\""
  if [ -n "$out" ]; then body="$body,\"output\":\"$out\""; fi
  body="$body}"
  curl -s -o /dev/null -m 10 -X POST "$SERVER_URL/api/agent/action-result" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$body" \
    || echo "action result push failed at $(date)" >&2
}

[ -z "$SWAP_FILE" ] && SWAP_FILE=/swap.img
[ -z "$FSTAB" ] && FSTAB=/etc/fstab
[ -z "$GRUB_DEFAULT" ] && GRUB_DEFAULT=/etc/default/grub

repair_swap_for_hibernate() {
  used_mb=$1
  size_gb=1
  while [ $(( (used_mb + 1023) / 1024 )) -gt "$size_gb" ]; do size_gb=$(( size_gb * 2 )); done
  if swapon --show --noheadings 2>/dev/null | awk '{print $1}' | grep -qx "$SWAP_FILE"; then
    swapoff "$SWAP_FILE" 2>/dev/null || return 1
  fi
  rm -f "$SWAP_FILE"
  if ! fallocate -l "$size_gb"G "$SWAP_FILE" 2>/dev/null; then
    dd if=/dev/zero of="$SWAP_FILE" bs=1M count=$(( size_gb * 1024 )) >/dev/null 2>&1 || return 1
  fi
  chmod 600 "$SWAP_FILE"
  mkswap "$SWAP_FILE" >/dev/null 2>&1 || return 1
  swapon "$SWAP_FILE" 2>/dev/null || return 1
  if [ -f "$FSTAB" ]; then
    if awk -v f="$SWAP_FILE" '$1 == f {found=1} END {exit found ? 0 : 1}' "$FSTAB"; then
      tmp=$(mktemp) && awk -v l="$SWAP_FILE none swap sw 0 0" -v f="$SWAP_FILE" '$1 == f {print l; next} {print}' "$FSTAB" > "$tmp" && mv "$tmp" "$FSTAB" || return 1
    else
      echo "$SWAP_FILE none swap sw 0 0" >> "$FSTAB" || return 1
    fi
  fi
  if [ -f "$GRUB_DEFAULT" ]; then
    if ! grep -q 'resume=' "$GRUB_DEFAULT"; then
      line=$(grep -E '^GRUB_CMDLINE_LINUX_DEFAULT=' "$GRUB_DEFAULT" || true)
      if [ -z "$line" ]; then
        echo "GRUB_CMDLINE_LINUX_DEFAULT=\"resume=$SWAP_FILE\"" >> "$GRUB_DEFAULT" || return 1
      else
        val=$(printf '%s' "$line" | cut -d= -f2-)
        inner=$(printf '%s' "$val" | sed 's/^\"//; s/\"$//')
        if [ -z "$inner" ]; then new="\"resume=$SWAP_FILE\""; else new="\"$inner resume=$SWAP_FILE\""; fi
        tmp=$(mktemp) && sed "s|^GRUB_CMDLINE_LINUX_DEFAULT=.*$|GRUB_CMDLINE_LINUX_DEFAULT=$new|" "$GRUB_DEFAULT" > "$tmp" && mv "$tmp" "$GRUB_DEFAULT" || return 1
      fi
      if command -v update-grub >/dev/null 2>&1; then
        update-grub >/dev/null 2>&1 || true
      fi
    fi
  fi
  return 0
}

do_hibernate() {
  meminfo=/proc/meminfo
  [ -n "$MEMINFO" ] && meminfo="$MEMINFO"
  mem_total_kb=$(awk '/^MemTotal:/{print $2}' "$meminfo")
  mem_avail_kb=$(awk '/^MemAvailable:/{print $2}' "$meminfo")
  swap_kb=$(awk '/^SwapTotal:/{print $2}' "$meminfo")
  [ -z "$mem_total_kb" ] && mem_total_kb=0
  [ -z "$mem_avail_kb" ] && mem_avail_kb=$mem_total_kb
  [ -z "$swap_kb" ] && swap_kb=0
  used_kb=$(( mem_total_kb - mem_avail_kb ))
  [ "$used_kb" -lt 1 ] && used_kb=1
  prefix=""
  if [ "$swap_kb" -lt "$used_kb" ]; then
    used_mb=$(( (used_kb + 511) / 1024 ))
    swap_mb=$(( swap_kb / 1024 ))
    if ! repair_swap_for_hibernate $used_mb; then
      out="swap too small for hibernation: need ~$used_mb MB (in use), have $swap_mb MB; auto-repair failed; run scripts/fix-hibernate.sh on this host as root"
      rc=1
      return
    fi
    prefix="repaired swap for hibernation (~$used_mb MB in use); "
  fi
  out=$(systemctl hibernate 2>&1); hb_rc=$?
  if [ $hb_rc -ne 0 ] && [ -e /proc/driver/nvidia/suspend ]; then
    echo resume > /proc/driver/nvidia/suspend 2>/dev/null || true
    out="$out; nvidia driver reset attempted"
  fi
  out="$prefix$out"
  rc=$hb_rc
}

${ENSURE_INTEL_GPU_TOOLS}

self_update() {
  self_path=$0
  [ -n "$AGENT_SELF_PATH" ] && self_path="$AGENT_SELF_PATH"
  [ -f "$self_path" ] || { out="agent update failed: own script not found at $self_path"; rc=1; return; }
  tmp=$(mktemp /tmp/openhomelab-agent-update.XXXXXX) || { out="agent update failed: mktemp"; rc=1; return; }
  code=$(curl -s -m 30 -o "$tmp" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$SERVER_URL/api/agent/script")
  if [ "$code" != "200" ] || [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    out="agent update failed: script download returned $code"
    rc=1
    return
  fi
  if ! sh -n "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    out="agent update failed: downloaded script failed syntax check"
    rc=1
    return
  fi
  newver=$(sed -n 's/^AGENT_VERSION="\([^"]*\)".*/\1/p' "$tmp" | head -n 1)
  if ! cp "$self_path" "$self_path.bak"; then
    rm -f "$tmp"
    out="agent update failed: backup of current agent failed"
    rc=1
    return
  fi
  if ! mv "$tmp" "$self_path"; then
    out="agent update failed: could not replace $self_path"
    rc=1
    return
  fi
  chmod 755 "$self_path"
  gpu_note=""
  case "$(ensure_intel_gpu_tools 2>/dev/null)" in
    installed) gpu_note=" (+intel-gpu-tools installed)" ;;
    failed) gpu_note=" WARNING: could not install intel-gpu-tools (Intel GPU power metrics unavailable)" ;;
  esac
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    systemctl restart openhomelab-agent >/dev/null 2>&1 || true
    out="agent updated to v$newver (service restarted)$gpu_note"
  else
    out="agent updated to v$newver (non-systemd agent picks it up on its next start)$gpu_note"
  fi
  rc=0
}

process_actions() {
  resp=$(curl -s -m 10 "$SERVER_URL/api/agent/pending-actions" -H "Authorization: Bearer $TOKEN") || return 0
  [ -n "$resp" ] || return 0
  pairs=$(printf '%s\n' "$resp" | tr '}' '\n' \
    | grep -oE '"id":[0-9]+,"action":"(reboot|shutdown|hibernate|update)"(,"command":"[^"]*")?' \
    | sed -n 's/^"id":\([0-9]*\),"action":"\([a-z]*\)"\(,"command":"\([^"]*\)"\)\{0,1\}$/\1 \2 \4/p')
  [ -n "$pairs" ] || return 0
  printf '%s\n' "$pairs" | while read -r a_id a_action a_cmd; do
    [ -n "$a_id" ] || continue
    a_log="executing $a_action (action $a_id)"
    [ -n "$a_cmd" ] && a_log="$a_log cmd=$a_cmd"
    echo "$(date) $a_log" >> "$STATE_DIR/agent.log" 2>/dev/null || true
    report_action_result "$a_id" "started" ""
    if [ "$a_action" != "update" ] && [ -n "$a_cmd" ]; then
      out=$(sh -c "$a_cmd" 2>&1); rc=$?
    else
      case "$a_action" in
        reboot) out=$(reboot 2>&1); rc=$? ;;
        hibernate) do_hibernate ;;
        update) self_update ;;
        *) out=$(shutdown -h now 2>&1); rc=$? ;;
      esac
    fi
    if [ $rc -ne 0 ]; then
      esc=$(printf '%s' "$out" | tr -d '\\"' | cut -c1-300)
      report_action_result "$a_id" "failed" "$esc"
    elif [ "$a_action" = "update" ]; then
      esc=$(printf '%s' "$out" | tr -d '\\"' | cut -c1-300)
      report_action_result "$a_id" "done" "$esc"
    fi
    return 0
  done
}

STATE_ACTIVE=true

sync_interval() {
  resp="$1"
  [ -n "$resp" ] || return 0
  new_int=$(printf '%s\n' "$resp" | grep -oE '"interval":[0-9]+' | sed 's/"interval"://')
  [ -n "$new_int" ] || return 0
  [ "$new_int" = "$INTERVAL" ] && return 0
  sed -i "s/^INTERVAL=.*/INTERVAL=$new_int/" "$CONFIG" 2>/dev/null || return 0
  echo "$(date) push interval updated: $INTERVAL -> $new_int" >> "$STATE_DIR/agent.log" 2>/dev/null || true
  INTERVAL=$new_int
}

read_state() {
  resp=$(curl -s -m 10 "$SERVER_URL/api/agent/config" -H "Authorization: Bearer $TOKEN") || return 0
  [ -n "$resp" ] || return 0
  sync_interval "$resp"
  case "$(printf '%s' "$resp" | grep -oE '"active":(true|false)' | head -n 1)" in
    *"false") STATE_ACTIVE=false ;;
    *"true") STATE_ACTIVE=true ;;
  esac
}

while :; do
  process_actions
  read_state
  if [ "$STATE_ACTIVE" != "true" ]; then
    sleep "$INTERVAL"
    continue
  fi
  collect_cpu_usage
  collect_memory
  collect_swap
  collect_loadavg
  collect_uptime
  os_collect

  host_name=$(hostname 2>/dev/null || uname -n)

  prev_net="$STATE_DIR/net_prev"
  now_ts=$(date +%s)
  net_line=$(net_totals)
  set -- $net_line
  cur_rx=$1; cur_tx=$2
  rx_rate=0; tx_rate=0
  if [ -f "$prev_net" ]; then
    read -r prev_ts prev_rx prev_tx < "$prev_net"
    dts=$((now_ts - prev_ts))
    if [ "$dts" -gt 0 ]; then
      rx_rate=$(awk -v p="$prev_rx" -v c="$cur_rx" -v t="$dts" 'BEGIN{d=c-p; if(d<0)d=0; printf "%.0f", d/t}')
      tx_rate=$(awk -v p="$prev_tx" -v c="$cur_tx" -v t="$dts" 'BEGIN{d=c-p; if(d<0)d=0; printf "%.0f", d/t}')
    fi
  fi
  echo "$now_ts $cur_rx $cur_tx" > "$prev_net"

  disks_json=""
  df -kP 2>/dev/null | awk 'NR>1 && $1 ~ /^\/dev\// {n=$6; gsub(/[^A-Za-z0-9_.-]/,"_",n); printf "%s %.0f %.0f\n", n, $2, $3}' > "$STATE_DIR/disks"
  while read -r d_name d_total d_used; do
    [ -z "$d_name" ] && continue
    entry="{\"name\":\"$d_name\",\"total\":$d_total,\"used\":$d_used}"
    if [ -z "$disks_json" ]; then disks_json=$entry; else disks_json="$disks_json,$entry"; fi
  done < "$STATE_DIR/disks"

  gpu_collect
  cpu_power_collect
  collect_interfaces
  if [ -n "$gpu_json" ] && [ -n "$hwmon_gpu_w" ]; then
    case "$gpu_json" in
      *',{'*) ;;
      *) gpu_json=$(printf '%s' "$gpu_json" | sed "s/\"power_w\":null/\"power_w\":$hwmon_gpu_w/")
      ;;
    esac
  fi

  payload="{\"hostname\":\"$host_name\",\"cpu\":$CPU_USAGE,\"load\":[$load1,$load5,$load15],\"mem_total\":$mem_total,\"mem_used\":$mem_used,\"swap_total\":$swap_total,\"swap_used\":$swap_used,\"disks\":[$disks_json],\"net_rx\":$rx_rate,\"net_tx\":$tx_rate,\"uptime_s\":$uptime_s,\"gpus\":[$gpu_json],\"cpu_power_w\":$cpu_power_w,\"interfaces\":[$ifaces_json],\"interval\":$INTERVAL,\"agent_version\":\"$AGENT_VERSION\",\"os_family\":$(json_str_field "$OS_FAMILY"),\"os_name\":$(json_str_field "$OS_NAME"),\"os_id\":$(json_str_field "$OS_ID"),\"kernel\":$(json_str_field "$KERNEL"),\"cpu_vendor\":$(json_str_field "$CPU_VENDOR"),\"cpu_model\":$(json_str_field "$CPU_MODEL"),\"cpu_cores\":$(num_or_null "$CPU_CORES"),\"cpu_freq_ghz\":$(num_or_null "$CPU_FREQ_GHZ")}"

  curl -s -o /dev/null -m 10 -X POST "$SERVER_URL/api/agent/stats" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$payload" \
    || echo "push to $SERVER_URL failed at $(date)" >&2

  sleep "$INTERVAL"
done
`;

export const buildAgentScript = (intervalSeconds: number): string =>
  AGENT_SCRIPT_TPL.split('__AGENT_INTERVAL__').join(String(intervalSeconds));

const AGENT_INSTALLER = String.raw`#!/bin/sh
# OpenHomeLab agent installer
set -e

if [ "$#" -lt 2 ] || [ -z "$2" ]; then
  echo "Usage: sh install.sh <server_url> <agent_token>" >&2
  exit 1
fi

SERVER_URL=$(printf '%s' "$1" | sed 's:/*$::')
TOKEN=$2

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl is required on this machine" >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    echo "Root privileges required - re-running under sudo (a password may be requested)..." >&2
    exec sudo sh -c 'curl -fsS "$0/api/agent/install" | sh -s -- "$0" "$1"' "$SERVER_URL" "$TOKEN"
  fi
  echo "ERROR: this installer must run as root. Use: curl -fsS $SERVER_URL/api/agent/install | sudo sh -s -- $SERVER_URL <token>" >&2
  exit 1
fi

${ENSURE_INTEL_GPU_TOOLS}

ensure_intel_gpu_tools >/dev/null 2>&1 || true

AGENT_BIN=/usr/local/bin/openhomelab-agent
CONFIG_DIR=/etc/openhomelab
CONFIG_FILE=$CONFIG_DIR/agent.conf

TMP_BIN=$(mktemp "$AGENT_BIN.tmp.XXXXXX") || { echo "ERROR: mktemp failed" >&2; exit 1; }
cat > "$TMP_BIN" <<'AGENT_EOF'
__AGENT_SCRIPT__
AGENT_EOF
if ! sh -n "$TMP_BIN"; then
  rm -f "$TMP_BIN"
  echo "ERROR: downloaded agent script failed syntax check; previous agent kept" >&2
  exit 1
fi
chmod 755 "$TMP_BIN"
mv -f "$TMP_BIN" "$AGENT_BIN"

mkdir -p "$CONFIG_DIR"
TMP_CONF=$(mktemp "$CONFIG_DIR/.agent.conf.XXXXXX") || { echo "ERROR: mktemp failed" >&2; exit 1; }
cat > "$TMP_CONF" <<CONF_EOF
SERVER_URL=$SERVER_URL
TOKEN=$TOKEN
INTERVAL=__AGENT_INTERVAL__
CONF_EOF
chmod 600 "$TMP_CONF"
mv -f "$TMP_CONF" "$CONFIG_FILE"

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  TMP_UNIT=$(mktemp /etc/systemd/system/.openhomelab-agent.service.XXXXXX) || { echo "ERROR: mktemp failed" >&2; exit 1; }
  cat > "$TMP_UNIT" <<UNIT_EOF
[Unit]
Description=OpenHomeLab agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openhomelab-agent /etc/openhomelab/agent.conf
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT_EOF
  mv -f "$TMP_UNIT" /etc/systemd/system/openhomelab-agent.service
  systemctl daemon-reload
  systemctl enable openhomelab-agent
  systemctl restart openhomelab-agent
  echo "OpenHomeLab agent installed and running (systemd: openhomelab-agent)"
else
  if command -v pkill >/dev/null 2>&1; then
    pkill -f "$AGENT_BIN" >/dev/null 2>&1 || true
  fi
  nohup "$AGENT_BIN" "$CONFIG_FILE" >> /var/log/openhomelab-agent.log 2>&1 &
  echo "OpenHomeLab agent installed and running (background process)"
fi
`;

export const buildAgentInstaller = (intervalSeconds: number): string =>
  AGENT_INSTALLER.split('__AGENT_SCRIPT__').join(AGENT_SCRIPT_TPL).split('__AGENT_INTERVAL__').join(
    String(intervalSeconds)
  );

// ---- Terminal WebSocket (xterm.js bridge over SSH PTY) ----

export function attachTerminalWs(server: http.Server, ctx: AppContext) {
  const wss = new WebSocketServer({ server, path: '/api/terminal/ws' });

  const closeWithError = (ws: WsSocket, code: number, message: string) => {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message }));
      ws.close(code, message);
    } catch {
      // socket already gone
    }
  };

  const loadProfile = async (profileId: number) =>
    (await ctx.db.get(
      'SELECT id, username, auth_type, password, private_key FROM profiles WHERE id = ?',
      profileId
    )) as
      | {
          id: number;
          username: string;
          auth_type: string;
          password: string | null;
          private_key: string | null;
        }
      | undefined;

  wss.on('connection', (ws, req) => {
    let shellStream: ClientChannel | null = null;
    let conn: SshClient | null = null;
    const cleanup = () => {
      try {
        if (shellStream && !shellStream.ended) shellStream.end();
      } catch {
        // stream already ended
      }
      shellStream = null;
      if (conn) {
        conn.end();
        conn = null;
      }
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);

    const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
    let token = query.get('token') ?? '';
    if (!token) {
      const headerAuth = req.headers.authorization;
      token = headerAuth?.split(' ')[1] ?? '';
    }
    if (!token) return closeWithError(ws, 4001, 'Unauthorized');
    try {
      jwt.verify(token, ctx.jwtSecret);
    } catch {
      return closeWithError(ws, 4001, 'Invalid token');
    }

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (!shellStream || shellStream.ended) return;
      if (!isBinary && data.toString().startsWith('{')) {
        let msg: { type?: string; cols?: number; rows?: number } | null = null;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          // not a control message — fall through and forward to the shell
        }
        if (msg && msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
          shellStream.setWindow(Number(msg.rows), Number(msg.cols), 0, 0);
          return;
        }
      }
      shellStream.write(data);
    });

    void (async () => {
      try {
        const target = query.get('target') ?? 'device';
        let host: string;
        let profile: { username: string; password: string | null; private_key: string | null } | undefined;

        if (target === 'host') {
          host = '127.0.0.1';
          const requestedProfileId = Number(query.get('profileId'));
          if (!Number.isInteger(requestedProfileId) || requestedProfileId <= 0) {
            return closeWithError(ws, 4002, 'Select an SSH profile to open the host terminal');
          }
          profile = await loadProfile(requestedProfileId);
          if (!profile) return closeWithError(ws, 4004, 'SSH profile not found');
        } else if (target === 'device') {
          const deviceId = Number(query.get('deviceId'));
          if (!Number.isInteger(deviceId) || deviceId <= 0) return closeWithError(ws, 4002, 'deviceId is required');
          const device = (await ctx.db.get(
            `SELECT d.id, d.ip, d.profile_id, d.disable_terminal, p.username, p.password, p.private_key
             FROM devices d LEFT JOIN profiles p ON d.profile_id = p.id WHERE d.id = ?`,
            deviceId
          )) as {
            id: number;
            ip: string;
            profile_id: number | null;
            disable_terminal: number;
            username: string | null;
            password: string | null;
            private_key: string | null;
          } | undefined;
          if (!device) return closeWithError(ws, 4004, 'Device not found');
          if (device.disable_terminal) {
            return closeWithError(ws, 4403, 'Terminal access is disabled for this device');
          }
          host = device.ip;
          if (device.profile_id !== null && device.username !== null) {
            profile = { username: device.username, password: device.password, private_key: device.private_key };
          } else {
            const requestedProfileId = Number(query.get('profileId'));
            if (!Number.isInteger(requestedProfileId) || requestedProfileId <= 0) {
              return closeWithError(ws, 4003, 'No SSH profile assigned — select one first');
            }
            profile = await loadProfile(requestedProfileId);
            if (!profile) return closeWithError(ws, 4004, 'SSH profile not found');
          }
        } else if (target === 'ip') {
          const rawIp = (query.get('ip') ?? '').trim();
          let parsed: ipaddr.IPv4 | null = null;
          try {
            const p = ipaddr.parse(rawIp);
            if (p.kind() === 'ipv4') parsed = p as ipaddr.IPv4;
          } catch {
            // not a valid address
          }
          if (!parsed) return closeWithError(ws, 4002, 'A valid IPv4 address is required');
          const requestedProfileId = Number(query.get('profileId'));
          if (!Number.isInteger(requestedProfileId) || requestedProfileId <= 0) {
            return closeWithError(ws, 4003, 'No SSH profile selected — select one first');
          }
          profile = await loadProfile(requestedProfileId);
          if (!profile) return closeWithError(ws, 4004, 'SSH profile not found');
          host = parsed.toString();
        } else {
          return closeWithError(ws, 4002, 'Unknown terminal target');
        }

        if (ws.readyState !== 1) return;
        conn = new SshClient();
        await new Promise<void>((resolve, reject) => {
          conn!.once('ready', () => resolve());
          conn.once('error', (err: Error) => reject(err));
          conn.connect({
            host,
            port: 22,
            username: profile.username,
            readyTimeout: 15_000,
            password: decryptCredential(profile.password, ctx.encKey) ?? undefined,
            privateKey: decryptCredential(profile.private_key, ctx.encKey) ?? undefined,
          });
        });
        shellStream = await new Promise<ClientChannel>((resolve, reject) => {
          conn!.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) =>
            err ? reject(err) : resolve(stream)
          );
        });
        const stream = shellStream;
        conn.on('error', () => {
          // connection lost — the stream close below terminates the session
        });
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ready' }));
        stream.on('data', (chunk: Buffer) => {
          if (ws.readyState === 1) ws.send(chunk);
        });
        stream.once('close', () => {
          try {
            if (ws.readyState === 1) ws.close(1000, 'shell exited');
          } catch {
            // socket already closed
          }
        });
      } catch (err) {
        closeWithError(ws, 4501, (err as Error).message || 'SSH connection failed');
      }
    })();
  });
}

// ---- Server startup ----

async function startServer() {
  if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEFAULT_JWT_SECRET)) {
    console.error('FATAL: JWT_SECRET must be set to a strong, unique value in production.');
    process.exit(1);
  }

  const ctx = await initDb();
  const app = createApp(ctx);
  aggregateMetrics(ctx.db).catch((err) => console.error('Metrics aggregation failed:', err));
  settleStaleActions(ctx.db).catch((err) => console.error('Action settlement failed:', err));
  startMetricsJob(ctx);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
  attachTerminalWs(httpServer, ctx);
}

if (process.env.NODE_ENV !== 'test') {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
