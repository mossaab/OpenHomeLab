import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, Trash2, Pencil, Copy, RefreshCw, KeyRound, X, Loader2, AlertCircle, Globe, Activity } from 'lucide-react';
import { apiCall } from '../api';
import Modal from './Modal';
import { ApiOperation, API_OPERATIONS, ApiToken, ApiTokenStatsRow, ApiTokenLogRow, Device } from '../types';
import ConfirmDialog from './ConfirmDialog';
import { useI18n } from '../i18n';


type Range = '7d' | '30d';

const toLocalInput = (ts: number | null): string => {
  if (ts === null) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const formatDate = (ts: number | null): string => (ts === null ? '—' : new Date(ts).toLocaleString());

const statusBadge = (code: number) =>
  code < 300
    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
    : code < 500
      ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20'
      : 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/20';

interface FormState {
  label: string;
  permissions: ApiOperation[];
  device_ids: number[];
  expires_at: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = { label: '', permissions: [], device_ids: [], expires_at: '', enabled: true };

export default function ApiTokensSetup() {
  const { t } = useI18n();
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [newToken, setNewToken] = useState<{ id: number; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statsRange, setStatsRange] = useState<Range>('7d');
  const [stats, setStats] = useState<ApiTokenStatsRow[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);
  const [logs, setLogs] = useState<ApiTokenLogRow[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);

  const [now, setNow] = useState(() => 0);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const serverUrl = window.location.origin;
  const deviceName = (id: number) => devices.find((d) => d.id === id)?.name ?? `#${id}`;

  const fetchTokens = useCallback(async () => {
    try {
      const list = await apiCall<ApiToken[]>('/api-tokens');
      setTokens(list);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const data = await apiCall<{ tokens: ApiTokenStatsRow[] }>(`/api-tokens/stats?range=${statsRange}`);
      setStats(data.tokens);
    } catch (e) {
      console.error(e);
    } finally {
      setStatsLoading(false);
    }
  }, [statsRange]);

  const fetchLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const data = await apiCall<{ logs: ApiTokenLogRow[] }>('/api-tokens/logs');
      setLogs(data.logs);
    } catch (e) {
      console.error(e);
    } finally {
      setLogsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTokens();
    apiCall<Device[]>('/devices').then(setDevices).catch(console.error);
    fetchLogs();
  }, [fetchTokens, fetchLogs]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const openAddModal = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError(null);
    setShowModal(true);
  };

  const openEditModal = (token: ApiToken) => {
    setEditingId(token.id);
    setForm({
      label: token.label,
      permissions: [...token.permissions],
      device_ids: [...token.device_ids],
      expires_at: toLocalInput(token.expires_at),
      enabled: token.enabled,
    });
    setError(null);
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingId(null);
    setError(null);
  };

  const togglePermission = (op: ApiOperation) => {
    setForm((f) => ({
      ...f,
      permissions: f.permissions.includes(op) ? f.permissions.filter((v) => v !== op) : [...f.permissions, op],
    }));
  };

  const toggleDevice = (id: number) => {
    setForm((f) => ({
      ...f,
      device_ids: f.device_ids.includes(id) ? f.device_ids.filter((v) => v !== id) : [...f.device_ids, id],
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      let expiresAt: number | null = null;
      if (form.expires_at.trim() !== '') {
        const ts = new Date(form.expires_at).getTime();
        if (!Number.isFinite(ts)) throw new Error(t('api.invalidDate'));
        expiresAt = ts;
      }
      const body: Record<string, unknown> = {
        label: form.label.trim(),
        permissions: form.permissions,
        device_ids: form.device_ids,
        expires_at: expiresAt,
      };

      if (editingId === null) {
        body.enabled = form.enabled;
        const data = await apiCall<{ id: number; token: string }>('/api-tokens', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        setNewToken({ id: data.id, token: data.token });
      } else {
        await apiCall(`/api-tokens/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
      }
      closeModal();
      fetchTokens();
      fetchStats();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('api.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async (token: ApiToken) => {
    try {
      await apiCall(`/api-tokens/${token.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: !token.enabled }),
      });
      fetchTokens();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('api.updateFailed'));
    }
  };

  const handleRotate = async (token: ApiToken) => {
    try {
      const data = await apiCall<{ id: number; token: string }>(`/api-tokens/${token.id}/rotate`, { method: 'POST' });
      setNewToken({ id: data.id, token: data.token });
      fetchTokens();
      fetchStats();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('api.rotateFailed'));
    }
  };

  const handleDelete = async () => {
    if (deleteId === null) return;
    setDeleting(true);
    try {
      await apiCall(`/api-tokens/${deleteId}`, { method: 'DELETE' });
      setDeleteId(null);
      fetchTokens();
      fetchStats();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('api.deleteFailed'));
      setDeleteId(null);
    } finally {
      setDeleting(false);
    }
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError(t('api.copyFailed'));
    }
  };

  const curlExample = (token: string) => [
    `curl -s ${serverUrl}/api/machines -H "Authorization: Bearer ${token}"`,
    `curl -s -X POST ${serverUrl}/api/machines/box-a/start -H "Authorization: Bearer ${token}"`,
  ].join('\n');

  return (
    <div className="flex flex-col gap-8">
      <AnimatePresence>
        {newToken && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="glass border border-amber-500/30 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-amber-600 dark:text-amber-400/90 flex items-center gap-1.5 font-medium">
                  <AlertCircle size={14} /> {t('api.copyNowBanner')}
                </p>
                <button
                  onClick={() => setNewToken(null)}
                  className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-300 transition-colors p-1 rounded-lg hover:bg-slate-200/70 dark:hover:bg-white/10"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-black/40 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-xs text-emerald-300 font-mono overflow-x-auto whitespace-nowrap">
                  {newToken.token}
                </code>
                <button
                  onClick={() => handleCopy(newToken.token)}
                  className="p-2.5 glass hover:bg-slate-200/70 dark:hover:bg-white/10 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 transition-colors shrink-0"
                  title={t('api.copyTokenTitle')}
                >
                  <Copy size={16} />
                </button>
              </div>
              <div className="flex items-start gap-2">
                <pre className="flex-1 bg-black/40 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-[11px] text-slate-700 dark:text-slate-300 font-mono overflow-x-auto whitespace-pre leading-relaxed">
{curlExample(newToken.token)}
                </pre>
                <button
                  onClick={() => handleCopy(curlExample(newToken.token))}
                  className="p-2.5 glass hover:bg-slate-200/70 dark:hover:bg-white/10 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 transition-colors shrink-0"
                  title={t('api.copyCurlTitle')}
                >
                  <Copy size={16} />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {error && !showModal && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
          <AlertCircle size={14} className="shrink-0" />
          {error}
        </div>
      )}

      {/* Token list */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-2">
            <KeyRound size={14} /> {t('api.sectionTokens')}
          </h4>
          <button
            onClick={openAddModal}
            className="flex items-center gap-2 px-3 py-1.5 glass hover:bg-indigo-500/20 rounded-lg text-xs font-bold text-indigo-600 dark:text-indigo-400 transition-colors"
          >
            <Plus size={14} /> {t('api.newTokenBtn')}
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-slate-500" />
          </div>
        ) : tokens.length === 0 ? (
          <p className="text-xs text-slate-500">{t('api.emptyHint')}</p>
        ) : (
          <div className="space-y-3">
            {tokens.map((token) => {
              const expired = token.expires_at !== null && token.expires_at <= now;
              return (
                <div key={token.id} className="glass border border-slate-200 dark:border-white/10 rounded-xl p-4 space-y-2.5">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-800 dark:text-slate-200 truncate">{token.label}</div>
                      <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                        <span
                          className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${
                            token.enabled && !expired
                              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                              : 'bg-slate-100/70 dark:bg-white/5 text-slate-500 border border-slate-200 dark:border-white/10'
                          }`}
                        >
                          {expired ? t('api.expired') : token.enabled ? t('api.enabled') : t('api.disabled')}
                        </span>
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 border border-indigo-500/20">
                          {token.permissions.length === 0 ? t('api.noPermissions') : token.permissions.join(', ')}
                        </span>
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100/70 dark:bg-white/5 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-white/10 flex items-center gap-1">
                          {token.device_ids.length === 0 ? (
                            <>
                              <Globe size={10} /> {t('api.allDevices')}
                            </>
                          ) : (
                            token.device_ids.map(deviceName).join(', ')
                          )}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => handleToggleEnabled(token)}
                        title={token.enabled ? t('api.disableToggle') : t('api.enableToggle')}
                        className={`w-9 h-5 rounded-full relative transition-colors ${
                          token.enabled ? 'bg-emerald-500/60' : 'bg-slate-100 dark:bg-white/10'
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${
                            token.enabled ? 'start-[18px]' : 'start-0.5'
                          }`}
                        />
                      </button>
                      <button
                        onClick={() => openEditModal(token)}
                        className="p-2 glass hover:bg-slate-200/70 dark:hover:bg-white/10 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 transition-colors"
                        title={t('api.editTokenTitle')}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => handleRotate(token)}
                        className="p-2 glass hover:bg-slate-200/70 dark:hover:bg-white/10 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 transition-colors"
                        title={t('api.rotateTokenTitle')}
                      >
                        <RefreshCw size={14} />
                      </button>
                      <button
                        onClick={() => setDeleteId(token.id)}
                        className="p-2 glass hover:bg-rose-500/20 rounded-lg text-slate-500 dark:text-slate-400 hover:text-rose-600 dark:text-rose-400 transition-colors"
                        title={t('api.deleteTokenTitle')}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {t('api.createdLine', {
                      created: formatDate(token.created_at),
                      expires: formatDate(token.expires_at),
                      used: formatDate(token.last_used_at)
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Usage stats */}
      <section className="pb-1">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400">{t('api.usage')}</h4>
          <div className="flex gap-1">
            {(['7d', '30d'] as Range[]).map((r) => (
              <button
                key={r}
                onClick={() => setStatsRange(r)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition-colors ${
                  statsRange === r
                    ? 'bg-indigo-500/30 text-indigo-200 border border-indigo-500/30'
                    : 'bg-slate-100/70 dark:bg-white/5 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-white/10 hover:bg-slate-200/70 dark:hover:bg-white/10'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {statsLoading || stats.length === 0 ? (
          <p className="text-xs text-slate-500">
            {statsLoading ? t('api.loadingUsage') : t('api.noUsage', { range: statsRange })}
          </p>
        ) : (
          <div className="glass border border-slate-200 dark:border-white/10 rounded-xl overflow-x-auto no-scrollbar">
            <table className="w-full min-w-[560px] text-xs whitespace-nowrap">
              <thead>
                <tr className="text-slate-500 border-b border-slate-200 dark:border-white/10">
                  <th className="text-start font-medium px-3 py-2">{t('api.colToken')}</th>
                  <th className="text-end font-medium px-3 py-2">{t('api.colTotal')}</th>
                  {API_OPERATIONS.map((op) => (
                    <th key={op} className="text-end font-medium px-3 py-2">
                      {op}
                    </th>
                  ))}
                  <th className="text-end font-medium px-3 py-2">{t('api.colLastUsed')}</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((row) => (
                  <tr key={row.token_id} className="border-b border-slate-200 dark:border-white/5 last:border-0 text-slate-700 dark:text-slate-300">
                    <td className="px-3 py-2">{row.label}</td>
                    <td className="px-3 py-2 text-end font-mono">{row.total}</td>
                    {API_OPERATIONS.map((op) => (
                      <td key={op} className="px-3 py-2 text-end font-mono">
                        {row.operations[op] ?? 0}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-end text-slate-500">{formatDate(row.last_used_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Recent calls */}
      <section className="pb-1">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-2">
            <Activity size={14} /> {t('api.recentCalls')}
          </h4>
          <button
            onClick={fetchLogs}
            disabled={logsLoading}
            className="p-1.5 glass hover:bg-slate-200/70 dark:hover:bg-white/10 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 transition-colors disabled:opacity-50"
            title={t('api.refreshLogs')}
          >
            <RefreshCw size={13} className={logsLoading ? 'animate-spin' : ''} />
          </button>
        </div>

        {logsLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-slate-500" />
          </div>
        ) : logs.length === 0 ? (
          <p className="text-xs text-slate-500">{t('api.emptyLogs')}</p>
        ) : (
          <div className="glass border border-slate-200 dark:border-white/10 rounded-xl overflow-x-auto no-scrollbar">
            <table className="w-full min-w-[640px] text-xs whitespace-nowrap">
              <thead>
                <tr className="text-slate-500 border-b border-slate-200 dark:border-white/10">
                  <th className="text-start font-medium px-3 py-2">{t('api.colTime')}</th>
                  <th className="text-start font-medium px-3 py-2">{t('api.colToken')}</th>
                  <th className="text-start font-medium px-3 py-2">{t('api.colOperation')}</th>
                  <th className="text-start font-medium px-3 py-2">{t('api.colDevice')}</th>
                  <th className="text-end font-medium px-3 py-2">{t('api.colStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} className="border-b border-slate-200 dark:border-white/5 last:border-0 text-slate-700 dark:text-slate-300">
                    <td className="px-3 py-2 text-slate-500">{formatDate(log.created_at)}</td>
                    <td className="px-3 py-2">{log.token_label ?? t('api.deletedToken')}</td>
                    <td className="px-3 py-2">
                      <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100/70 dark:bg-white/5 border border-slate-200 dark:border-white/10">
                        {log.operation}
                      </span>
                    </td>
                    <td className="px-3 py-2">{log.device_name ?? '—'}</td>
                    <td className="px-3 py-2 text-end">
                      <span className={`inline-block px-2 py-0.5 rounded-md text-[10px] font-bold ${statusBadge(log.status_code)}`}>
                        {log.status_code}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Create / edit modal */}
      {showModal && (
        <Modal
          onBackdropClick={closeModal}
          className="w-full sm:max-w-lg max-h-[92dvh] sm:max-h-[85vh] overflow-y-auto custom-scrollbar rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl border-b sm:border border-slate-200 dark:border-white/10"
        >
            <h3 className="font-medium text-slate-800 dark:text-slate-200 mb-5">
              {editingId === null ? t('api.newModalTitle') : t('api.editModalTitle')}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('api.labelField')}</label>
                <input
                  type="text"
                  value={form.label}
                  onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                  placeholder="litellm-bot"
                  maxLength={80}
                  required
                  className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">{t('api.permissions')}</label>
                <div className="grid grid-cols-2 gap-2">
                  {API_OPERATIONS.map((op) => (
                    <label
                      key={op}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                        form.permissions.includes(op)
                          ? 'border-indigo-500/40 bg-indigo-500/10'
                          : 'border-slate-200 dark:border-white/10 bg-white/70 dark:bg-black/20 hover:bg-slate-100 dark:hover:bg-white/5'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={form.permissions.includes(op)}
                        onChange={() => togglePermission(op)}
                        className="accent-indigo-500"
                      />
                      <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{op}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">{t('api.allowedDevices')}</label>
                {devices.length === 0 ? (
                  <p className="text-xs text-slate-500">{t('api.noDevicesConfigured')}</p>
                ) : (
                  <div className="max-h-36 overflow-y-auto custom-scrollbar space-y-1 pr-1">
                    {devices.map((device) => (
                      <label
                        key={device.id}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border cursor-pointer transition-colors ${
                          form.device_ids.includes(device.id)
                            ? 'border-indigo-500/40 bg-indigo-500/10'
                            : 'border-slate-200 dark:border-white/10 bg-white/70 dark:bg-black/20 hover:bg-slate-100 dark:hover:bg-white/5'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={form.device_ids.includes(device.id)}
                          onChange={() => toggleDevice(device.id)}
                          className="accent-indigo-500"
                        />
                        <span className="text-xs text-slate-700 dark:text-slate-300">{device.name}</span>
                        <span className="text-[10px] text-slate-500 ms-auto font-mono">{device.ip}</span>
                      </label>
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-slate-500 mt-2">{t('api.noSelectionNote')}</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-end">
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('api.expirationField')}</label>
                  <input
                    type="datetime-local"
                    value={form.expires_at}
                    onChange={(e) => setForm((f) => ({ ...f, expires_at: e.target.value }))}
                    className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                {editingId === null && (
                  <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 dark:border-white/10 bg-white/70 dark:bg-black/20 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.enabled}
                      onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                      className="accent-indigo-500"
                    />
                    <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{t('api.enabled')}</span>
                  </label>
                )}
              </div>

              {error && (
                <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
                  <AlertCircle size={14} className="shrink-0" />
                  {error}
                </div>
              )}

              <div className="sticky bottom-0 -mx-6 flex justify-end gap-3 border-t border-slate-200 dark:border-white/10 bg-white/95 px-6 pt-3 pb-[max(1.5rem,env(safe-area-inset-bottom))] backdrop-blur-md dark:bg-slate-900/95">
                <button
                  type="button"
                  onClick={closeModal}
                  disabled={saving}
                  className="bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 text-slate-700 dark:text-slate-300 font-medium px-4 py-2 rounded-lg transition-colors text-sm"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-lg transition-colors text-sm"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  {editingId === null ? t('api.createTokenBtn') : t('api.saveChangesBtn')}
                </button>
              </div>
            </form>
        </Modal>
      )}

      {deleteId !== null && (
        <ConfirmDialog
          title={t('api.deleteDialogTitle')}
          message={t('api.deleteConfirmMessage')}
          confirmLabel={t('common.delete')}
          loading={deleting}
          onConfirm={handleDelete}
          onCancel={() => setDeleteId(null)}
        />
      )}
    </div>
  );
}
