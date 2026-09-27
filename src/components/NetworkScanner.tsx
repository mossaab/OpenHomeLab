import React from 'react';
import { useState, useEffect, useMemo, useRef } from 'react';
import { apiCall, ApiError } from '../api';
import type { Profile, ScanResult, ScannedHost } from '../types';
import { Radar, Play, Search, Loader2, ArrowUpRight, Plus, X } from 'lucide-react';
import { motion } from 'motion/react';
import Modal from './Modal';
import { useToast } from './Toast';
import { DEVICE_TYPES } from '../deviceTypes';
import { useI18n } from '../i18n';
import type { Dict } from '../i18n/index';

const IPv4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipToNum(ip: string): number | null {
  const m = IPv4_RE.exec(ip.trim());
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function parseCustomPorts(raw: string): number[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const nums = trimmed.split(/[\s,]+/).filter(Boolean).map(Number);
  if (nums.length === 0 || nums.some((n) => !Number.isInteger(n) || n < 1 || n > 65535)) return null;
  return [...new Set(nums)];
}

interface PortTag {
  id: string;
  labelKey: keyof Dict;
  ports: number[];
}

const PORT_TAGS: PortTag[] = [
  { id: 'web', labelKey: 'porttag.web', ports: [80, 443, 8080, 8443] },
  { id: 'ssh', labelKey: 'porttag.ssh', ports: [22] },
  { id: 'sftp', labelKey: 'porttag.sftp', ports: [22] },
  { id: 'telnet', labelKey: 'porttag.telnet', ports: [23] },
  { id: 'ftp', labelKey: 'porttag.ftp', ports: [21] },
  { id: 'dns', labelKey: 'porttag.dns', ports: [53] },
  { id: 'mail', labelKey: 'porttag.mail', ports: [110, 587, 993, 995] },
  { id: 'smb', labelKey: 'porttag.smb', ports: [139, 445] },
  { id: 'rdp', labelKey: 'porttag.rdp', ports: [3389] },
  { id: 'vnc', labelKey: 'porttag.vnc', ports: [5900] },
  { id: 'database', labelKey: 'porttag.database', ports: [1433, 1521, 3306, 5432] },
  { id: 'other', labelKey: 'porttag.other', ports: [] },
];

const KNOWN_TAG_PORTS = new Set(PORT_TAGS.flatMap((t) => t.ports));

function hostMatchesTag(host: ScannedHost, tag: PortTag): boolean {
  if (tag.id === 'other') return host.ports.some((p) => !KNOWN_TAG_PORTS.has(p.port));
  return host.ports.some((p) => tag.ports.includes(p.port));
}

function StatusDot({ online }: { online: boolean }) {
  const { t } = useI18n();
  return (
    <span
      title={online ? t('common.online') : t('common.offline')}
      className={`h-2.5 w-2.5 rounded-full shrink-0 ${online ? 'status-online' : 'status-offline'}`}
    />
  );
}

function PortBadges({ host }: { host: ScannedHost }) {
  const { t } = useI18n();
  if (host.ports.length === 0)
    return <span className="italic text-xs text-slate-500 dark:text-slate-600">{t('common.none')}</span>;
  return (
    <div className="flex flex-wrap gap-1 max-w-[260px]">
      {host.ports.map((p) => (
        <span
          key={p.port}
          title={p.banner || `${p.service}`}
          className="bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/25 px-1.5 py-0.5 rounded text-[10px] font-mono whitespace-nowrap text-indigo-700 dark:text-indigo-300"
        >
          {p.port}
          <span className="text-indigo-400 dark:text-indigo-400/80"> {p.service}</span>
        </span>
      ))}
    </div>
  );
}

function ManagedBadge({ host, onOpen }: { host: ScannedHost; onOpen: (id: number) => void }) {
  const { t } = useI18n();
  if (!host.managed_device_id) return <span className="italic text-xs text-slate-500 dark:text-slate-600">{t('scanner.unknown')}</span>;
  return (
    <button
      onClick={() => onOpen(host.managed_device_id as number)}
      title={t('scanner.openInDash', { name: host.managed_device_name ?? '' })}
      className="inline-flex items-center gap-1 bg-indigo-100 dark:bg-indigo-500/15 border border-indigo-200 dark:border-indigo-500/30 px-2 py-1 rounded text-[10px] uppercase tracking-wider text-indigo-700 dark:text-indigo-300 hover:bg-indigo-200/70 dark:hover:bg-indigo-500/25 transition-colors"
    >
      {host.managed_device_name}
      <ArrowUpRight size={11} />
    </button>
  );
}

function AddButton({ host, onAdd }: { host: ScannedHost; onAdd: (host: ScannedHost) => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={() => onAdd(host)}
      title={t('scanner.addTitle')}
      className="inline-flex items-center gap-1 bg-indigo-600 hover:bg-indigo-500 text-white px-2.5 py-1 rounded text-[10px] font-medium uppercase tracking-wider transition-colors"
    >
      <Plus size={11} /> {t('common.add')}
    </button>
  );
}

export default function NetworkScanner() {
  const [startIp, setStartIp] = useState('');
  const [endIp, setEndIp] = useState('');
  const [customPorts, setCustomPorts] = useState('');
  const [showPortField, setShowPortField] = useState(false);

  const [scanning, setScanning] = useState(false);
  const [scanId, setScanId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [localError, setLocalError] = useState('');
  const [pollNow, setPollNow] = useState<number | null>(null);

  const [search, setSearch] = useState('');
  const [onlineOnly, setOnlineOnly] = useState(true);
  const [portTags, setPortTags] = useState<string[]>([]);
  const [localRange, setLocalRange] = useState<{ startIp: string; endIp: string } | null>(null);
  const { t } = useI18n();
  const { addToast, toastContainer } = useToast();

  const rangePrefix = useMemo(() => {
    const parts = startIp.trim().split('.');
    if (parts.length < 3) return null;
    const prefix = parts.slice(0, 3).join('.');
    const octets = prefix.split('.').map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o > 255)) return null;
    return prefix;
  }, [startIp]);

  const presets = useMemo(() => {
    if (!rangePrefix) return [];
    return [
      { label: `${rangePrefix}.0 – ${rangePrefix}.255`, start: `${rangePrefix}.0`, end: `${rangePrefix}.255` },
      { label: `${rangePrefix}.1 – ${rangePrefix}.126`, start: `${rangePrefix}.1`, end: `${rangePrefix}.126` },
    ];
  }, [rangePrefix]);

  useEffect(() => {
    apiCall<{ success: boolean; startIp: string | null; endIp: string | null }>('/scan/default-range')
      .then((data) => {
        if (data.startIp && data.endIp) {
          const range = { startIp: data.startIp, endIp: data.endIp };
          setLocalRange(range);
          setStartIp((v) => (v.trim() ? v : range.startIp));
          setEndIp((v) => (v.trim() ? v : range.endIp));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!scanning || !scanId) return;
    const timer = setInterval(async () => {
      try {
        const data = await apiCall<ScanResult>(`/scan/${scanId}`);
        setPollNow(Date.now());
        setResult(data);
        if (data.status === 'done' || data.status === 'failed' || data.status === 'cancelled') {
          setScanning(false);
          setCancelling(false);
          if (data.status === 'done') {
            const onlineCount = data.hosts.filter((h) => h.online).length;
            addToast('success', t('scanner.complete', { n: String(onlineCount), plural: onlineCount === 1 ? '' : 's' }));
          } else if (data.status === 'cancelled') {
            addToast('success', t('scanner.cancelled'));
          } else {
            addToast('error', data.errorCode === 'icmp_unavailable' ? t('scanner.errIcmpUnavailable') : data.error || t('scanner.stopped'));
          }
        }
      } catch (err) {
        console.error(err);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [scanning, scanId, addToast, t]);

  const cancelScan = async () => {
    if (!scanId || cancelling) return;
    setCancelling(true);
    try {
      await apiCall('/scan/' + scanId + '/cancel', { method: 'POST' });
    } catch (err) {
      console.error(err);
      setCancelling(false);
    }
  };

  const startScan = async () => {
    setLocalError('');
    const s = ipToNum(startIp);
    const e = ipToNum(endIp);
    if (s === null || e === null) {
      setLocalError(t('scanner.errInvalidIps'));
      return;
    }
    if (s > e) {
      setLocalError(t('scanner.errEndBeforeStart'));
      return;
    }
    if (e - s + 1 > 256) {
      setLocalError(t('scanner.errRangeTooLarge'));
      return;
    }
    let ports: number[] | null = null;
    if (customPorts.trim()) {
      ports = parseCustomPorts(customPorts);
      if (!ports) {
        setLocalError(t('scanner.errInvalidPorts'));
        return;
      }
      if (ports.length > 100) {
        setLocalError(t('scanner.errTooManyPorts'));
        return;
      }
    }

    setScanning(true);
    setResult(null);
    setCancelling(false);
    setSearch('');
    try {
      const body: Record<string, unknown> = { startIp: startIp.trim(), endIp: endIp.trim() };
      if (ports) body.ports = ports;
      const { scanId: id } = await apiCall<{ success: boolean; scanId: string }>('/scan', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setScanId(id);
    } catch (err) {
      setScanning(false);
      const message = err instanceof ApiError ? err.message : t('scanner.startFailed');
      addToast('error', message);
    }
  };

  const openDevice = (id: number) => {
    window.location.hash = `#/dashboard/device/${id}`;
  };

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const profilesFetchedRef = useRef(false);
  const [addTarget, setAddTarget] = useState<ScannedHost | null>(null);
  const [formName, setFormName] = useState('');
  const [formHost, setFormHost] = useState('');
  const [formType, setFormType] = useState<string>('pc');
  const [formProfileId, setFormProfileId] = useState('');
  const [adding, setAdding] = useState(false);

  const openAdd = (host: ScannedHost) => {
    setFormName((host.hostname ?? '').trim() || host.ip);
    setFormHost((host.hostname ?? '').trim());
    setFormType('pc');
    setFormProfileId('');
    if (!profilesFetchedRef.current) {
      profilesFetchedRef.current = true;
      apiCall<Profile[]>('/profiles').then(setProfiles).catch(() => {});
    }
    setAddTarget(host);
  };

  const closeAdd = () => {
    if (!adding) setAddTarget(null);
  };

  const submitAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addTarget || adding) return;
    const name = formName.trim();
    if (!name) return;
    setAdding(true);
    try {
      const data = await apiCall<{ id: number }>('/devices', {
        method: 'POST',
        body: JSON.stringify({
          name,
          ip: addTarget.ip,
          mac: addTarget.mac ?? '',
          hostname: formHost.trim() || null,
          type: formType,
          profile_id: formProfileId ? parseInt(formProfileId) : null,
        }),
      });
      addToast('success', t('scanner.addedToast', { name }));
      setResult((prev) =>
        prev
          ? {
              ...prev,
              hosts: prev.hosts.map((h) =>
                h.ip === addTarget.ip ? { ...h, managed_device_id: data.id, managed_device_name: name } : h
              ),
            }
          : prev
      );
      setAddTarget(null);
    } catch (err) {
      addToast('error', err instanceof ApiError ? err.message : t('scanner.addFailed'));
    } finally {
      setAdding(false);
    }
  };

  const query = search.trim().toLowerCase();
  const visibleHosts = useMemo(() => {
    if (!result) return [];
    const selectedTags = PORT_TAGS.filter((t) => portTags.includes(t.id));
    return result.hosts.filter((h) => {
      if (onlineOnly && !h.online) return false;
      if (selectedTags.length > 0 && !selectedTags.some((t) => hostMatchesTag(h, t))) return false;
      return (
        !query ||
        h.ip.toLowerCase().includes(query) ||
        (h.hostname ?? '').toLowerCase().includes(query) ||
        (h.mac ?? '').toLowerCase().includes(query) ||
        (h.vendor ?? '').toLowerCase().includes(query)
      );
    });
  }, [result, query, onlineOnly, portTags]);

  const onlineCount = result?.hosts.filter((h) => h.online).length ?? 0;
  const progressPct = result && result.total > 0 ? (result.scannedCount / result.total) * 100 : 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">{t('scanner.title')}</h2>
        <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">{t('scanner.subtitle')}</p>
      </div>

      <div className="glass-card p-5 rounded-2xl">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto_auto] gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('scanner.startIp')}</label>
            <input
              type="text"
              value={startIp}
              onChange={(e) => setStartIp(e.target.value)}
              placeholder="192.168.1.1"
              disabled={scanning}
              className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm font-mono text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('scanner.endIp')}</label>
            <input
              type="text"
              value={endIp}
              onChange={(e) => setEndIp(e.target.value)}
              placeholder="192.168.1.254"
              disabled={scanning}
              className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm font-mono text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
            />
          </div>
          <button
            onClick={startScan}
            disabled={scanning}
            className="flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white font-medium px-4 py-2.5 rounded-lg transition-colors text-sm"
          >
            {scanning ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} />}
            {t('scanner.scanBtn')}
          </button>
          {scanning && (
            <button
              onClick={cancelScan}
              disabled={cancelling}
              title={t('scanner.cancelTitle')}
              className="flex items-center justify-center gap-2 bg-slate-200/80 dark:bg-white/10 hover:bg-slate-300/70 dark:hover:bg-white/15 disabled:opacity-60 text-slate-600 dark:text-slate-300 font-medium px-4 py-2.5 rounded-lg transition-colors text-sm"
            >
              <X size={18} />
              {t('common.cancel')}
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-3">
          {presets.map((p) => (
            <button
              key={p.label}
              onClick={() => {
                setStartIp(p.start);
                setEndIp(p.end);
              }}
              disabled={scanning}
              className="bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 hover:bg-slate-200/70 dark:hover:bg-white/10 px-2.5 py-1 rounded-lg text-[11px] font-mono text-slate-600 dark:text-slate-300 transition-colors disabled:opacity-50"
            >
              {p.label}
            </button>
          ))}
          {localRange && (
            <button
              onClick={() => {
                setStartIp(localRange.startIp);
                setEndIp(localRange.endIp);
              }}
              disabled={scanning}
              className="bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/25 hover:bg-indigo-100/70 dark:hover:bg-indigo-500/20 px-2.5 py-1 rounded-lg text-[11px] font-mono text-indigo-700 dark:text-indigo-300 transition-colors disabled:opacity-50"
            >
              {t('scanner.myLan', { start: localRange.startIp, end: localRange.endIp })}
            </button>
          )}
          <button
            onClick={() => setShowPortField((v) => !v)}
            className="ms-auto bg-transparent border border-dashed border-slate-300 dark:border-white/20 hover:border-slate-400 dark:hover:border-white/30 px-2.5 py-1 rounded-lg text-[11px] text-slate-500 dark:text-slate-400 transition-colors"
          >
            {showPortField ? t('scanner.hidePorts') : t('scanner.customPorts')}
          </button>
        </div>

        {showPortField && (
          <div className="mt-3">
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
              {t('scanner.customPorts')}{' '}
              <span className="text-slate-500 dark:text-slate-600">{t('scanner.customPortsNote')}</span>
            </label>
            <input
              type="text"
              value={customPorts}
              onChange={(e) => setCustomPorts(e.target.value)}
              placeholder="22, 80, 443, 3389…"
              disabled={scanning}
              className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm font-mono text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
            />
          </div>
        )}

        {localError && <p className="mt-3 text-xs text-rose-600 dark:text-rose-400">{localError}</p>}
      </div>

      {scanning && result && (
        <div className="rounded-lg border border-indigo-300/60 dark:border-indigo-500/40 bg-indigo-50/50 dark:bg-indigo-500/10 px-4 py-3">
          <div className="flex items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-300">
            <span className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-indigo-500" />
              {t('scanner.scanning', { start: startIp.trim(), end: endIp.trim() })}
            </span>
            <span className="font-mono">
              {result.scannedCount}/{result.total}
              {pollNow !== null && result.startedAt ? ` · ${Math.max(0, Math.round((pollNow - result.startedAt) / 1000))}s` : ''}
            </span>
          </div>
          <div className="mt-2 h-1.5 rounded-full bg-slate-200 dark:bg-white/10 overflow-hidden">
            <motion.div
              initial={false}
              animate={{ width: `${progressPct}%` }}
              transition={{ duration: 0.4 }}
              className="h-full bg-indigo-500 rounded-full"
            />
          </div>
        </div>
      )}

      {result && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="bg-slate-100 dark:bg-white/10 border border-slate-200 dark:border-white/10 px-2 py-1 rounded text-[10px] uppercase tracking-wider text-slate-600 dark:text-slate-300">
            {t('scanner.onlineChip', { n: String(onlineCount) })}
          </span>
          <span className="bg-slate-100 dark:bg-white/10 border border-slate-200 dark:border-white/10 px-2 py-1 rounded text-[10px] uppercase tracking-wider text-slate-600 dark:text-slate-300">
            {t('scanner.scannedChip', { found: String(result.hosts.length), total: String(result.total) })}
          </span>
          {!scanning && (
            <span className="bg-slate-100 dark:bg-white/10 border border-slate-200 dark:border-white/10 px-2 py-1 rounded text-[10px] uppercase tracking-wider text-slate-600 dark:text-slate-300">
              {Math.round((result.durationMs ?? 0) / 100) / 10}s
            </span>
          )}
          <label className="flex items-center gap-1.5 cursor-pointer select-none ms-2">
            <input
              type="checkbox"
              checked={onlineOnly}
              onChange={(e) => setOnlineOnly(e.target.checked)}
              className="h-3.5 w-3.5 accent-indigo-600"
            />
            <span className="text-xs text-slate-600 dark:text-slate-300">{t('common.online')}</span>
          </label>
          <div className="flex items-center gap-1 flex-wrap">
            {PORT_TAGS.map((tag) => (
              <button
                key={tag.id}
                onClick={() => setPortTags((prev) => (prev.includes(tag.id) ? prev.filter((x) => x !== tag.id) : [...prev, tag.id]))}
                title={
                  tag.id === 'other'
                    ? t('porttag.filterOther')
                    : t('porttag.filterExposing', { ports: tag.ports.join(', ') })
                }
                className={`${portTags.includes(tag.id)
                  ? 'bg-indigo-600 border-indigo-600 text-white'
                  : 'bg-slate-100 dark:bg-white/5 border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-white/10'} px-2 py-1 rounded-lg text-[11px] transition-colors`}
              >
                {t(tag.labelKey)}
              </button>
            ))}
          </div>
          <div className="relative flex-1 sm:ms-auto sm:w-56">
            <Search size={15} className="absolute start-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('scanner.filterPlaceholder')}
              aria-label={t('scanner.filterAria')}
              className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg ps-9 pe-3 py-2 text-xs text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
        </div>
      )}

      {!scanning && !result ? (
        <div className="text-center py-16 glass rounded-2xl border border-dashed border-slate-300 dark:border-white/20">
          <Radar size={32} className="mx-auto mb-3 text-slate-400 opacity-50" />
          <p className="text-slate-500 dark:text-slate-400">{t('scanner.emptyHint')}</p>
        </div>
      ) : result && visibleHosts.length === 0 ? (
        <div className="glass-card rounded-2xl overflow-hidden">
          <div className="px-6 py-14 text-center text-sm text-slate-500 dark:text-slate-400">
            {t('scanner.noMatch')}
          </div>
        </div>
      ) : result ? (
        <div className="glass-card rounded-2xl overflow-hidden">
          <div className="hidden md:block">
            <table className="w-full text-start text-sm">
              <thead className="bg-slate-100/70 dark:bg-white/5 border-b border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider [&>tr>th:first-child]:rounded-ss-2xl [&>tr>th:last-child]:rounded-se-2xl">
                <tr>
                  <th className="px-4 py-3 font-medium">{t('scanner.colIp')}</th>
                  <th className="px-4 py-3 font-medium">{t('scanner.colHostname')}</th>
                  <th className="px-4 py-3 font-medium">{t('scanner.colMac')}</th>
                  <th className="hidden lg:table-cell px-4 py-3 font-medium">{t('scanner.colVendor')}</th>
                  <th className="px-4 py-3 font-medium">{t('scanner.colPorts')}</th>
                  <th className="px-4 py-3 font-medium text-end">{t('scanner.colManaged')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-white/10">
                {visibleHosts.map((host, i) => (
                  <motion.tr
                    key={host.ip}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: Math.min(i * 0.03, 0.25) }}
                    className="hover:bg-slate-100/60 dark:hover:bg-white/[0.04] transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <StatusDot online={host.online} />
                        <span
                          className={`font-mono text-xs ${host.online ? 'text-slate-800 dark:text-slate-200' : 'text-slate-400 dark:text-slate-500'}`}
                        >
                          {host.ip}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600 dark:text-slate-300">
                      {host.hostname ?? <span className="italic text-slate-500 dark:text-slate-600">-</span>}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                      {host.mac ?? '-'}
                    </td>
                    <td className="hidden lg:table-cell px-4 py-3 text-xs text-slate-600 dark:text-slate-300">
                      {host.vendor ?? <span className="italic text-slate-500 dark:text-slate-600">{t('scanner.unknown')}</span>}
                    </td>
                    <td className="px-4 py-3">{host.online ? <PortBadges host={host} /> : '-'}</td>
                    <td className="px-4 py-3 text-end">
                      {host.online ? (
                        host.managed_device_id ? (
                          <ManagedBadge host={host} onOpen={openDevice} />
                        ) : (
                          <AddButton host={host} onAdd={openAdd} />
                        )
                      ) : (
                        '-'
                      )}
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="md:hidden divide-y divide-slate-200 dark:divide-white/10">
            {visibleHosts.map((host, i) => (
              <motion.div
                key={host.ip}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.04, 0.25) }}
                className="p-4"
              >
                <div className="flex items-center gap-3">
                  <StatusDot online={host.online} />
                  <span
                    className={`font-mono text-sm ${host.online ? 'text-slate-800 dark:text-slate-200' : 'text-slate-400 dark:text-slate-500'}`}
                  >
                    {host.ip}
                  </span>
                </div>
                <div className="mt-3 pt-1 divide-y divide-slate-200/70 dark:divide-white/5">
                  <div className="flex items-center justify-between gap-3 py-2">
                    <span className="text-xs text-slate-500 dark:text-slate-400">{t('scanner.colHostname')}</span>
                    <span className="text-xs font-mono text-slate-600 dark:text-slate-300">{host.hostname ?? '-'}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 py-2">
                    <span className="text-xs text-slate-500 dark:text-slate-400">{t('scanner.colMac')}</span>
                    <span className="text-xs font-mono text-slate-600 dark:text-slate-300">{host.mac ?? '-'}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 py-2">
                    <span className="text-xs text-slate-500 dark:text-slate-400">{t('scanner.colVendor')}</span>
                    <span className="text-xs font-mono text-slate-600 dark:text-slate-300">{host.vendor ?? t('scanner.unknown')}</span>
                  </div>
                  {host.online && (
                    <div className="py-2">
                      <span className="block text-xs text-slate-500 dark:text-slate-400 mb-1.5">{t('scanner.colPorts')}</span>
                      <PortBadges host={host} />
                    </div>
                  )}
                </div>
                {host.online && (
                  <div className="mt-2 flex justify-end">
                    {host.managed_device_id ? (
                      <ManagedBadge host={host} onOpen={openDevice} />
                    ) : (
                      <AddButton host={host} onAdd={openAdd} />
                    )}
                  </div>
                )}
              </motion.div>
            ))}
          </div>
        </div>
      ) : null}

      {addTarget && (
        <Modal
          onBackdropClick={closeAdd}
          className="w-full sm:max-w-md max-h-[92dvh] sm:max-h-[85vh] overflow-y-auto custom-scrollbar rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl border-b sm:border border-slate-200 dark:border-white/10"
        >
          <div className="flex items-center justify-between mb-6">
            <h3 className="font-medium text-slate-800 dark:text-slate-200 flex items-center gap-2">
              <Plus size={18} className="text-indigo-600 dark:text-indigo-400" /> {t('scanner.addModalTitle')}
            </h3>
            <button
              type="button"
              onClick={closeAdd}
              disabled={adding}
              className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-300 transition-colors p-1 rounded-lg hover:bg-slate-200/70 dark:hover:bg-white/10 disabled:opacity-50"
            >
              <X size={20} />
            </button>
          </div>

          <form onSubmit={submitAdd} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('scanner.nameLabel')}</label>
              <input
                required
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                placeholder="e.g. My Desktop"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('scanner.colIp')}</label>
              <input
                value={addTarget.ip}
                disabled
                className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 font-mono focus:outline-none disabled:opacity-70"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('scanner.colMac')}</label>
              <input
                value={addTarget.mac ?? ''}
                placeholder={t('scanner.unknown')}
                disabled
                className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 font-mono focus:outline-none disabled:opacity-70"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('scanner.hostLabel')}</label>
              <input
                value={formHost}
                onChange={(e) => setFormHost(e.target.value)}
                placeholder="e.g. fileserver.local"
                className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('scanner.typeLabel')}</label>
              <select
                value={formType}
                onChange={(e) => setFormType(e.target.value)}
                className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 [&>option]:bg-white dark:[&>option]:bg-slate-900"
              >
                {DEVICE_TYPES.map((dt) => (
                  <option key={dt.value} value={dt.value}>
                    {t(dt.labelKey)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('scanner.profileLabel')}</label>
              <select
                value={formProfileId}
                onChange={(e) => setFormProfileId(e.target.value)}
                className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 [&>option]:bg-white dark:[&>option]:bg-slate-900"
              >
                <option value="">{t('scanner.noneProfile')}</option>
                {profiles.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={closeAdd}
                disabled={adding}
                className="flex-1 bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 text-slate-700 dark:text-slate-300 font-medium px-4 py-2.5 rounded-lg transition-colors text-sm disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={adding || !formName.trim()}
                className="flex-1 flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white font-medium px-4 py-2.5 rounded-lg transition-colors text-sm"
              >
                {adding && <Loader2 size={15} className="animate-spin" />}
                {t('scanner.addModalTitle')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {toastContainer}
    </div>
  );
}
