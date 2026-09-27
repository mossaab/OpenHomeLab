import { useState, useEffect, useCallback, type ReactNode, type FormEvent } from 'react';
import { apiCall } from '../api';
import { pendingActionLabel, compareAgentVersions } from '../actionLabel';
import { formatAgo } from '../relativeTime';
import { Device, DeviceInterface, DeviceLiveStats, Group, HistoryPoint, HistoryRange, EnergyStats, PendingDeviceAction, Profile } from '../types';
import { ArrowLeft, Cpu, MemoryStick, HardDrive, Network, RefreshCw, Server, Gpu, Zap, KeyRound, AlertCircle, Loader2, Pencil, Power, Trash2, X, Info } from 'lucide-react';
import { deviceTypeSpec } from '../deviceTypes';
import { deviceToPutBody } from '../devicePutBody';
import DeviceActions from './DeviceActions';
import DeviceForm, { DeviceFormValues, EMPTY_DEVICE_FORM } from './DeviceForm';
import Modal from './Modal';
import { motion } from 'motion/react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { useToast } from './Toast';
import PingDialog from './PingDialog';
import AgentTokenDialog from './AgentTokenDialog';
import ConfirmDialog from './ConfirmDialog';
import OsIcon from './OsIcon';
import { useI18n } from '../i18n';
import type { Dict } from '../i18n/index';

const RANGES: HistoryRange[] = ['1h', '6h', '24h', '7d', '30d', '1y'];

const LINE_META: Record<string, { labelKey: keyof Dict; color: string; width?: number; dash?: string; opacity?: number }> = {
  cpu_avg: { labelKey: 'detail.chartCpuAvg', color: '#818cf8' },
  cpu_max: { labelKey: 'detail.chartCpuMax', color: '#818cf8', width: 1, dash: '4 3', opacity: 0.5 },
  mem_avg: { labelKey: 'detail.chartMemAvg', color: '#34d399' },
  mem_max: { labelKey: 'detail.chartMemMax', color: '#34d399', width: 1, dash: '4 3', opacity: 0.5 },
  gpu_avg: { labelKey: 'detail.chartGpuAvg', color: '#38bdf8' },
  power_avg: { labelKey: 'detail.chartPowerAvg', color: '#fbbf24' },
  power_max: { labelKey: 'detail.chartPowerMax', color: '#fbbf24', width: 1, dash: '4 3', opacity: 0.5 },
  net_rx_mbps: { labelKey: 'detail.chartRx', color: '#34d399' },
  net_tx_mbps: { labelKey: 'detail.chartTx', color: '#818cf8' },
};

function formatBytes(bytes: number, unitSize: number = 1024, suffix: string = 'B'): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let i = 0;
  while (value >= unitSize && i < units.length - 1) {
    value /= unitSize;
    i += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}${suffix === 'B' ? '' : suffix}`;
}

function formatUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTime(ts: number, range: HistoryRange): string {
  const date = new Date(ts);
  if (range === '1y' || range === '30d') {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  if (range === '7d') {
    return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
  }
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function MetricCard({ icon, label, value, sub }: { icon: ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="glass-card p-4 rounded-xl">
      <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 mb-2">
        {icon}
        <span className="text-xs uppercase tracking-wider font-semibold">{label}</span>
      </div>
      <div className="text-lg font-bold text-slate-900 dark:text-slate-100">{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function MetricCardSkeleton() {
  return (
    <div className="glass-card p-4 rounded-xl skeleton-shimmer" style={{ backgroundSize: '200% 100%' }}>
      <div className="flex items-center gap-2 mb-2">
        <div className="w-[15px] h-[15px] rounded bg-slate-200 dark:bg-white/5" />
        <div className="h-3 w-14 rounded bg-slate-200 dark:bg-white/5" />
      </div>
      <div className="text-lg font-bold">
        <span className="inline-block h-6 w-12 rounded-md bg-slate-200 dark:bg-white/5" />
      </div>
      <div className="h-3 w-24 mt-1.5 rounded bg-slate-100 dark:bg-white/[0.03]" />
    </div>
  );
}

interface ChartPoint {
  ts: number;
  cpu_avg: number | null;
  cpu_max: number | null;
  mem_avg: number | null;
  mem_max: number | null;
  gpu_avg: number | null;
  power_avg: number | null;
  power_max: number | null;
  net_rx_mbps: number | null;
  net_tx_mbps: number | null;
}

interface HistoryChartProps {
  title: string;
  points: ChartPoint[];
  keys: (keyof ChartPoint)[];
  range: HistoryRange;
  unit: string;
  yDomain?: [number, number | 'auto'];
  loading?: boolean;
}

function HistoryChart({ title, points, keys, range, unit, yDomain = [0, 100], loading }: HistoryChartProps) {
  const { t } = useI18n();
  const makeTooltip = (props: any) => {
    const { active, payload, label } = props;
    if (!active || !payload?.length) return null;
    return (
      <div className="glass-card rounded-lg px-3 py-2 shadow-xl border border-slate-200 dark:border-white/10">
        <div className="text-slate-500 dark:text-slate-400 font-mono text-xs mb-1">{formatTime(Number(label), range)}</div>
        {payload.map((entry: any) => (
          <div key={String(entry.dataKey)} className="flex items-center gap-2 text-xs">
            <span className="w-2 h-2 rounded-full" style={{ background: entry.color }} />
            <span className="text-slate-500 dark:text-slate-400">
              {t(LINE_META[String(entry.dataKey)]?.labelKey ?? (String(entry.dataKey) as keyof Dict))}
            </span>
            <span className="ml-auto font-mono text-slate-800 dark:text-slate-200 pl-3">
              {typeof entry.value === 'number' ? `${entry.value.toFixed(1)} ${unit}` : '—'}
            </span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="glass-card p-5 rounded-xl">
      <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 mb-3">{title}</h4>
      {points.length < 2 ? (
        <div className="h-[220px] flex items-center justify-center text-slate-500 text-sm">
          {t('detail.noHistoryPeriod')}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={points} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="chart-grid" />
            <XAxis
              dataKey="ts"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(v: number) => formatTime(v, range)}
              stroke="rgba(148,163,184,0.2)"
              tick={{ fill: 'rgba(148,163,184,0.7)', fontSize: 10 }}
              tickCount={6}
            />
            <YAxis
              domain={yDomain}
              stroke="rgba(148,163,184,0.2)"
              tick={{ fill: 'rgba(148,163,184,0.7)', fontSize: 10 }}
              width={44}
              tickFormatter={(v: number) => `${v}${unit === '%' ? '%' : ''}`}
            />
            <Tooltip content={makeTooltip} isAnimationActive={false} />
            <Legend
              wrapperStyle={{ fontSize: '11px', paddingTop: '6px' }}
              formatter={(value: string) => (
                <span className="text-slate-500 dark:text-slate-400">{value}</span>
              )}
            />
            {keys.map((key) => {
              const meta = LINE_META[key as string];
              return (
                <Line
                  key={String(key)}
                  type="monotone"
                  dataKey={key as string}
                  name={t(meta.labelKey)}
                  stroke={meta.color}
                  strokeWidth={meta.width ?? 2}
                  strokeDasharray={meta.dash}
                  strokeOpacity={meta.opacity ?? 1}
                  dot={false}
                  isAnimationActive={false}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      )}
      {loading && (
        <div className="flex items-center justify-center gap-2 text-slate-500 text-xs mt-2">
          <RefreshCw size={12} className="animate-spin" /> {t('detail.updating')}
        </div>
      )}
    </div>
  );
}

export default function DeviceDetail({ device, onBack, onOpenSettings, onOpenTerminal, settingsTick, refreshMs = 30000, agentIntervalS = 30, agentStaleMs = 90000, onUpdated }: { device: Device; onBack: () => void; onOpenSettings: () => void; onOpenTerminal: () => void; settingsTick: number; refreshMs?: number; agentIntervalS?: number; agentStaleMs?: number; onUpdated?: () => void }) {
  const [live, setLive] = useState<DeviceLiveStats | null>(null);
  const [liveLoading, setLiveLoading] = useState(true);
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const [points, setPoints] = useState<HistoryPoint[]>([]);
  const [range, setRange] = useState<HistoryRange>('24h');
  const [chartLoading, setChartLoading] = useState(true);
  const [energy, setEnergy] = useState<EnergyStats | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [pingOpen, setPingOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'reboot' | 'shutdown' | 'hibernate' | 'update' | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [actionEntry, setActionEntry] = useState<PendingDeviceAction | null>(null);
  const [servedVersion, setServedVersion] = useState<string | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editProfiles, setEditProfiles] = useState<Profile[]>([]);
  const [editGroups, setEditGroups] = useState<Group[]>([]);
  const [editValues, setEditValues] = useState<DeviceFormValues>(EMPTY_DEVICE_FORM);
  const [syncing, setSyncing] = useState(false);
  const [wolIfaceName, setWolIfaceName] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const { t } = useI18n();
  const { addToast, toastContainer } = useToast();

  const actionLabel = pendingActionLabel(actionEntry, t);

  const openEditModal = async () => {
    const stored = device.interfaces ?? [];
    const matched =
      stored.find((i) => i.ips.includes(device.ip)) ??
      (device.mac ? stored.find((i) => i.mac !== null && i.mac.toLowerCase() === device.mac.toLowerCase()) : undefined);
    setWolIfaceName(matched?.name ?? null);
    setEditValues({
      name: device.name,
      hostname: device.hostname ?? '',
      ip: device.ip,
      mac: device.mac || '',
      type: device.type || 'pc',
      profile_id: device.profile_id ? String(device.profile_id) : '',
      group_id: device.group_id ? String(device.group_id) : '',
      broadcast_address: device.broadcast_address || '',
      base_power_w: device.base_power_w ? String(device.base_power_w) : '',
      poweroff_action: device.poweroff_action ?? '',
      reboot_action: device.reboot_action ?? '',
      hibernate_action: device.hibernate_action ?? '',
      disable_power: !!device.disable_power,
      disable_ping: !!device.disable_ping,
      disable_terminal: !!device.disable_terminal,
      disable_agent_update: !!device.disable_agent_update
    });
    setShowEditModal(true);
    try {
      const [profs, grps] = await Promise.all([apiCall<Profile[]>('/profiles'), apiCall<Group[]>('/groups')]);
      setEditProfiles(profs);
      setEditGroups(grps);
    } catch (e) {
      console.error(e);
    }
  };

  const submitEdit = async (e: FormEvent) => {
    e.preventDefault();
    const body = deviceToPutBody(device, {
      name: editValues.name,
      hostname: editValues.hostname || null,
      ip: editValues.ip,
      mac: editValues.mac,
      type: editValues.type,
      profile_id: editValues.profile_id ? parseInt(editValues.profile_id) : null,
      group_id: editValues.group_id ? parseInt(editValues.group_id) : null,
      broadcast_address: editValues.broadcast_address || null,
      base_power_w: editValues.base_power_w === '' ? null : Number(editValues.base_power_w),
      poweroff_action: editValues.poweroff_action,
      reboot_action: editValues.reboot_action,
      hibernate_action: editValues.hibernate_action,
      disable_power: editValues.disable_power,
      disable_ping: editValues.disable_ping,
      disable_terminal: editValues.disable_terminal,
      disable_agent_update: editValues.disable_agent_update
    });
    try {
      await apiCall(`/devices/${device.id}`, { method: 'PUT', body: JSON.stringify(body) });
      addToast('success', t('detail.deviceUpdated'));
      setShowEditModal(false);
      onUpdated?.();
    } catch (err: any) {
      addToast('error', t('detail.failedPrefix', { message: err.message }));
    }
  };

  const handleIfaceSelect = (iface: DeviceInterface) => {
    setWolIfaceName(iface.name);
    setEditValues((prev) => ({
      ...prev,
      ip: iface.ips[0] || prev.ip,
      mac: iface.mac || prev.mac,
      broadcast_address: iface.broadcast || prev.broadcast_address
    }));
  };

  const handleSyncFromAgent = async () => {
    setSyncing(true);
    try {
      const data = await apiCall<DeviceLiveStats>(`/devices/${device.id}/stats/live`);
      const snapData = data.live;
      if (!snapData) throw new Error(t('detail.noAgentData'));
      const list = snapData.interfaces ?? [];
      const iface =
        (wolIfaceName ? list.find((i) => i.name === wolIfaceName && (i.ips.length > 0 || i.mac)) : undefined) ??
        list.find((i) => i.kind === 'eth' && i.ips.length > 0) ??
        list.find((i) => i.ips.length > 0) ??
        list[0] ?? null;
      setEditValues((prev) => ({
        ...prev,
        name: snapData.hostname || prev.name,
        hostname: snapData.hostname || prev.hostname,
        ip: iface?.ips[0] || prev.ip,
        mac: iface?.mac || prev.mac,
        broadcast_address: iface?.broadcast || prev.broadcast_address
      }));
      if (iface?.name) setWolIfaceName(iface.name);
      addToast('success', t('detail.syncedFromAgent'));
    } catch (e: any) {
      addToast('error', t('detail.syncFailed', { message: e.message }));
    } finally {
      setSyncing(false);
    }
  };

  const toggleActive = async () => {
    setToggling(true);
    try {
      await apiCall(`/devices/${device.id}`, {
        method: 'PUT',
        body: JSON.stringify(deviceToPutBody(device, { active: device.active ? 0 : 1 }))
      });
      addToast('success', device.active ? t('detail.deactivatedToast') : t('detail.activatedToast'));
      onUpdated?.();
      if (device.active) onBack();
    } catch (e: any) {
      addToast('error', t('detail.toggleFailed', { message: e.message }));
    } finally {
      setToggling(false);
    }
  };

  const confirmDeleteDevice = async () => {
    setDeleting(true);
    try {
      await apiCall(`/devices/${device.id}`, { method: 'DELETE' });
      addToast('success', t('detail.deletedToast', { name: device.name }));
      onUpdated?.();
      onBack();
    } catch (e: any) {
      addToast('error', t('detail.deleteFailed', { message: e.message }));
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleAction = async (action: 'wake' | 'reboot' | 'shutdown' | 'hibernate' | 'update'): Promise<boolean> => {
    setActionLoading((prev) => ({ ...prev, [action]: true }));
    try {
      if (action === 'wake') {
        await apiCall(`/devices/${device.id}/wake`, { method: 'POST' });
        addToast('success', t('action.wolSent'));
      } else {
        const result = await apiCall<{ success: boolean; channel?: 'agent' | 'ssh' }>(`/devices/${device.id}/command`, {
          method: 'POST',
          body: JSON.stringify({ action })
        });
        const labels =
          result?.channel === 'agent'
            ? { reboot: t('action.rebootQueued'), shutdown: t('action.shutDownQueued'), hibernate: t('action.hibernateQueued'), update: t('action.updateQueued') }
            : { reboot: t('action.rebootSent'), shutdown: t('action.shutDownSent'), hibernate: t('action.hibernateSent'), update: t('action.updateSent') };
        addToast('success', labels[action]);
      }
      return true;
    } catch (e: any) {
      addToast('error', t('action.actionFailed', { message: e.message }));
      return false;
    } finally {
      setActionLoading((prev) => ({ ...prev, [action]: false }));
    }
  };

  const fetchLive = useCallback(async () => {
    setNowTs(Date.now());
    setLiveLoading(true);
    try {
      const [statusMap, liveStats] = await Promise.all([
        apiCall<Record<number, boolean>>('/devices/status'),
        apiCall<DeviceLiveStats>(`/devices/${device.id}/stats/live`)
      ]);
      setIsOnline(!!statusMap[device.id]);
      setLive(liveStats);
    } catch (e) {
      console.error(e);
    }
    try {
      const actions = await apiCall<Record<string, PendingDeviceAction>>('/devices/actions');
      setActionEntry(actions[String(device.id)] ?? null);
    } catch (e) {
      console.error(e);
    } finally {
      setLiveLoading(false);
    }
  }, [device.id]);

  const fetchHistory = useCallback(async () => {
    setChartLoading(true);
    try {
      const data = await apiCall<{ points: HistoryPoint[] }>(`/devices/${device.id}/stats/history?range=${range}`);
      setPoints(data.points);
    } catch (e) {
      console.error(e);
    } finally {
      setChartLoading(false);
    }
  }, [device.id, range]);

  const fetchEnergy = useCallback(async () => {
    try {
      const data = await apiCall<EnergyStats>(`/devices/${device.id}/stats/energy?range=${range}`);
      setEnergy(data);
    } catch (e) {
      console.error(e);
    }
  }, [device.id, range]);

  useEffect(() => {
    setLive(null);
    setIsOnline(null);
    fetchLive();
    const interval = setInterval(fetchLive, refreshMs);
    return () => clearInterval(interval);
  }, [fetchLive, refreshMs]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  useEffect(() => {
    fetchEnergy();
  }, [fetchEnergy, settingsTick]);

  useEffect(() => {
    apiCall<{ success: boolean; version: string }>('/agent/version')
      .then((data) => setServedVersion(data.version))
      .catch(() => setServedVersion(null));
  }, []);

  const chartData: ChartPoint[] = points.map((p) => ({
    ts: p.ts,
    cpu_avg: p.cpu_avg,
    cpu_max: p.cpu_max,
    mem_avg: p.mem_avg,
    mem_max: p.mem_max,
    gpu_avg: p.gpu_avg,
    power_avg: p.power_avg,
    power_max: p.power_max,
    net_rx_mbps: p.net_rx_avg === null || p.net_rx_avg === undefined ? null : p.net_rx_avg / 125000,
    net_tx_mbps: p.net_tx_avg === null || p.net_tx_avg === undefined ? null : p.net_tx_avg / 125000,
  }));

  const snap = live?.live ?? null;
  const lastSeen = live?.last_seen ?? null;
  const agentState: 'online' | 'stale' | 'none' = !snap
    ? 'none'
    : lastSeen && nowTs - lastSeen < agentStaleMs
      ? 'online'
      : 'stale';
  const reportedVersion = snap?.agent_version ?? null;
  const agentOutdated = !!reportedVersion && !!servedVersion && compareAgentVersions(reportedVersion, servedVersion) < 0;
  const syncHint =
    agentState === 'none'
      ? t('detail.noAgentData')
      : agentState === 'stale' && lastSeen
        ? t('detail.agentOfflineLast', { ago: formatAgo(lastSeen, t) })
        : null;
  const reportedInterval = snap?.interval ?? null;
  const intervalOutdated = reportedInterval !== null && reportedInterval !== agentIntervalS;

  const agentOnlineLabel = [
    t('detail.agentOnline'),
    reportedVersion ? `v${reportedVersion}` : null,
    agentOutdated ? t('detail.outdated') : null,
    intervalOutdated && reportedInterval !== null ? t('detail.intervalSuffix', { n: String(reportedInterval) }) : null,
  ]
    .filter(Boolean)
    .join(' ');
  const agentStaleLabel = [t('detail.agentStale'), reportedVersion ? `v${reportedVersion}` : null, agentOutdated ? t('detail.outdated') : null]
    .filter(Boolean)
    .join(' ');

  const memPct = snap && snap.mem_total > 0 ? (snap.mem_used / snap.mem_total) * 100 : null;
  const swapPct = snap && snap.swap_total > 0 ? (snap.swap_used / snap.swap_total) * 100 : null;

  const gpus = snap?.gpus ?? [];
  let gpuUtilMax: number | null = null;
  let gpuTempC: number | null = null;
  let gpuVramUsedMb = 0;
  let gpuVramTotalMb = 0;
  let gpuPowerW: number | null = null;
  for (const g of gpus) {
    if (g.util !== null && (gpuUtilMax === null || g.util > gpuUtilMax)) gpuUtilMax = g.util;
    if (g.temp_c !== null && (gpuTempC === null || g.temp_c > gpuTempC)) gpuTempC = g.temp_c;
    gpuVramUsedMb += g.mem_used_mb;
    gpuVramTotalMb += g.mem_total_mb;
    if (g.power_w !== null) gpuPowerW = (gpuPowerW ?? 0) + g.power_w;
  }

  const gpuProcesses = gpus.flatMap((g, i) => (g.processes ?? []).map((p) => ({ ...p, gpu: i + 1 }))).sort((a, b) => b.mem_mb - a.mem_mb);

  const gpuNames = [...new Set(gpus.map((g) => g.name ?? '').filter((n) => n.length > 0))];

  const formatGpuSub = (): string | undefined => {
    const parts: string[] = [];
    parts.push(gpus.length > 1 ? t('detail.gpusPlural', { n: String(gpus.length) }) : t('detail.gpuSingle'));
    if (gpuNames.length > 0) parts.push(gpuNames.join(' + '));
    if (gpuTempC !== null) parts.push(`${Math.round(gpuTempC)}\u00B0C`);
    if (gpuVramTotalMb > 0) {
      parts.push(`${formatBytes(gpuVramUsedMb * 1024 * 1024)} / ${formatBytes(gpuVramTotalMb * 1024 * 1024)}`);
    }
    return parts.join(' \u00B7 ');
  };

  const formatPowerSub = (): string | undefined => {
    if (!snap) return undefined;
    const parts: string[] = [];
    if (typeof snap.cpu_power_w === 'number') parts.push(`${t('detail.metricCpu')} ${snap.cpu_power_w} W`);
    if (gpuPowerW !== null) parts.push(`${t('detail.metricGpu')} ${Math.round(gpuPowerW * 10) / 10} W`);
    return parts.length > 0 ? parts.join(' \u00B7 ') : undefined;
  };

  const cpuSub = [
    snap?.cpu_cores ? `${snap.cpu_cores} ${t('detail.cores')}` : '',
    typeof snap?.cpu_freq_ghz === 'number' ? `${snap.cpu_freq_ghz} GHz` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const typeSpec = deviceTypeSpec(device.type);

  const actionButtons = (
    <>
      <button
        onClick={() => setTokenOpen(true)}
        className="p-2 glass border border-slate-200 dark:border-white/10 hover:bg-slate-200/70 dark:hover:bg-white/10 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 transition-colors shrink-0"
        title={t('detail.agentTokenTitle')}
        aria-label={t('detail.agentTokenTitle')}
      >
        <KeyRound size={16} />
      </button>
      <button
        onClick={() => void openEditModal()}
        className="p-2 glass border border-slate-200 dark:border-white/10 hover:bg-slate-200/70 dark:hover:bg-white/10 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 transition-colors shrink-0"
        title={t('detail.editDevice')}
        aria-label={t('detail.editDevice')}
      >
        <Pencil size={16} />
      </button>
      <button
        onClick={() => void toggleActive()}
        disabled={toggling}
        className={`p-2 glass border rounded-lg transition-colors disabled:opacity-50 shrink-0 ${
          device.active
            ? 'border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 hover:bg-slate-200/70 dark:hover:bg-white/10 hover:text-slate-900 dark:hover:text-slate-200'
            : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20'
        }`}
        title={device.active ? t('detail.deactivate') : t('detail.activate')}
        aria-label={device.active ? t('detail.deactivateAria') : t('detail.activateAria')}
      >
        <Power size={16} />
      </button>
      <button
        onClick={() => setConfirmDelete(true)}
        className="p-2 glass border border-slate-200 dark:border-white/10 hover:bg-rose-500/10 rounded-lg text-slate-500 dark:text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 transition-colors shrink-0"
        title={t('detail.deleteDeviceTitle')}
        aria-label={t('detail.deleteDeviceTitle')}
      >
        <Trash2 size={16} />
      </button>
    </>
  );

  const agentPill =
    agentState === 'online' ? (
      <span
        title={agentOnlineLabel}
        className={`flex items-center gap-1.5 min-w-0 max-w-[50%] md:max-w-none px-3 py-1.5 rounded-lg text-xs font-bold border whitespace-nowrap ${agentOutdated || intervalOutdated ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/20' : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'}`}
      >
        <Server size={14} className="shrink-0" />
        <span className="truncate">{agentOnlineLabel}</span>
      </span>
    ) : agentState === 'stale' ? (
      <span
        title={agentStaleLabel}
        className="flex items-center gap-1.5 min-w-0 max-w-[50%] md:max-w-none px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20 whitespace-nowrap"
      >
        <Server size={14} className="shrink-0" />
        <span className="truncate">{agentStaleLabel}</span>
      </span>
    ) : null;

  const backButton = (
    <button
      onClick={onBack}
      className="p-2 glass border border-slate-200 dark:border-white/10 hover:bg-slate-200/70 dark:hover:bg-white/10 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 transition-colors shrink-0"
      title={t('detail.backToDash')}
    >
      <ArrowLeft size={18} />
    </button>
  );

  const statusDot =
    isOnline !== null ? (
      <span
        className={`w-2.5 h-2.5 rounded-full shrink-0 ${isOnline ? 'status-online' : 'status-offline'}`}
        title={isOnline ? t('common.online') : t('common.offline')}
      />
    ) : null;

  const deviceName = (
    <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight truncate min-w-0">{device.name}</h2>
  );

  const typeBadge = (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold border shrink-0 ${typeSpec.badge}`}>
      <typeSpec.icon size={11} /> {t(typeSpec.labelKey)}
    </span>
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="md:hidden border-b border-slate-200 dark:border-white/5 pb-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {backButton}
            {deviceName}
            {statusDot}
          </div>
          <div className="flex items-center gap-2 shrink-0">{actionButtons}</div>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate">{t('detail.ipPrefix')}: {device.ip}</span>
            {typeBadge}
          </div>
          {agentPill}
        </div>
      </div>
      <div className="hidden md:flex items-center justify-between gap-3 border-b border-slate-200 dark:border-white/5 pb-4">
        <div className="flex items-start gap-3 min-w-0">
          {backButton}
          <div className="min-w-0">
            <div className="flex items-center gap-3 min-w-0">
              {deviceName}
              {statusDot}
              {typeBadge}
            </div>
            <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono">{t('detail.ipPrefix')}: {device.ip}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {agentPill}
          {actionButtons}
        </div>
      </div>

      {actionLabel && (
        <div className={`mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider ${actionEntry.status === 'failed' ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400'}`}>
          {actionEntry.status === 'failed' ? <AlertCircle size={11} /> : <Loader2 size={11} className="animate-spin" />}
          {actionLabel}
        </div>
      )}

      <DeviceActions
        isOnline={isOnline}
        loading={actionLoading}
        onPing={() => setPingOpen(true)}
        onWake={() => void handleAction('wake')}
        hasAgentToken={device.has_agent_token}
        agentOutdated={agentOutdated || intervalOutdated}
        disablePower={device.disable_power}
        disablePing={device.disable_ping}
        disableTerminal={device.disable_terminal}
        disableAgentUpdate={device.disable_agent_update}
        onReboot={() => setConfirmAction('reboot')}
        onShutdown={() => setConfirmAction('shutdown')}
        onHibernate={() => setConfirmAction('hibernate')}
        onUpdate={() => setConfirmAction('update')}
        onTerminal={onOpenTerminal}
      />

      {!device.has_agent_token && (
        <div className="flex items-center justify-between gap-3 flex-wrap rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <Server size={16} className="text-amber-600 dark:text-amber-400" />
            <p className="text-xs font-medium text-amber-700 dark:text-amber-300">{t('detail.noAgentBanner')}</p>
          </div>
          <button
            onClick={() => setTokenOpen(true)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-700 dark:text-amber-300 border border-amber-500/20 text-xs font-bold transition-colors"
          >
            <KeyRound size={14} /> {t('detail.installAgent')}
          </button>
        </div>
      )}

      {/* Live metrics */}
      {!snap && liveLoading ? (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="space-y-4">
          <h3 className="font-bold text-slate-800 dark:text-slate-200 text-sm uppercase tracking-wider">{t('detail.liveMetrics')}</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <MetricCardSkeleton key={i} />
            ))}
          </div>
        </motion.div>
      ) : snap ? (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="space-y-4">
          <h3 className="font-bold text-slate-800 dark:text-slate-200 text-sm uppercase tracking-wider">{t('detail.liveMetrics')}</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            <MetricCard icon={<Cpu size={15} />} label={t('detail.metricCpu')} value={snap.cpu !== null ? `${Math.round(snap.cpu)}%` : '—'} />
            <MetricCard
              icon={<MemoryStick size={15} />}
              label={t('detail.metricMemory')}
              value={memPct !== null ? `${Math.round(memPct)}%` : '—'}
              sub={`${formatBytes(snap.mem_used)} / ${formatBytes(snap.mem_total)}`}
            />
            {gpus.length > 0 && (
              <MetricCard
                icon={<Gpu size={15} />}
                label={t('detail.metricGpu')}
                value={gpuUtilMax !== null ? `${Math.round(gpuUtilMax)}%` : '—'}
                sub={formatGpuSub()}
              />
            )}
            {typeof snap.power_total_w === 'number' && (
              <MetricCard
                icon={<Zap size={15} />}
                label={t('detail.metricConsumption')}
                value={`${Math.round(snap.power_total_w * 10) / 10} W`}
                sub={formatPowerSub()}
              />
            )}
            <MetricCard
              icon={<RefreshCw size={15} />}
              label={t('detail.metricSwap')}
              value={swapPct !== null ? `${Math.round(swapPct)}%` : '—'}
              sub={`${formatBytes(snap.swap_used)} / ${formatBytes(snap.swap_total)}`}
            />
            <MetricCard icon={<Cpu size={15} />} label={t('detail.metricLoad1m')} value={snap.load?.[0] !== undefined ? snap.load[0].toFixed(2) : '—'} />
            <MetricCard icon={<Server size={15} />} label={t('detail.metricUptime')} value={formatUptime(snap.uptime_s)} sub={snap.hostname ?? undefined} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="glass-card p-5 rounded-xl">
              <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-2">
                <Network size={14} /> {t('detail.networkThroughput')}
              </h4>
              <div className="space-y-3">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-slate-500 dark:text-slate-400">{t('detail.receive')}</span>
                    <span className="text-emerald-600 dark:text-emerald-400 font-mono">{formatBytes(snap.net_rx)}/s</span>
                  </div>
                  <div className="metric-track h-2 rounded-full overflow-hidden">
                    <div className="h-full metric-fill bg-emerald-500/70 rounded-full" style={{ width: `${Math.min(snap.net_rx / 1048576, 1) * 100}%` }} />
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-slate-500 dark:text-slate-400">{t('detail.transmit')}</span>
                    <span className="text-indigo-600 dark:text-indigo-400 font-mono">{formatBytes(snap.net_tx)}/s</span>
                  </div>
                  <div className="metric-track h-2 rounded-full overflow-hidden">
                    <div className="h-full metric-fill bg-indigo-500/70 rounded-full" style={{ width: `${Math.min(snap.net_tx / 1048576, 1) * 100}%` }} />
                  </div>
                </div>
              </div>
            </div>

            <div className="glass-card p-5 rounded-xl">
              <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-2">
                <HardDrive size={14} /> {t('detail.disks')}
              </h4>
              {snap.disks.length === 0 ? (
                <p className="text-xs text-slate-500">{t('detail.noDisks')}</p>
              ) : (
                <div className="space-y-3">
                  {snap.disks.map((d) => {
                    const pct = d.total > 0 ? (d.used / d.total) * 100 : 0;
                    return (
                      <div key={d.name}>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-slate-500 dark:text-slate-400 font-mono">{d.name}</span>
                          <span className="text-slate-700 dark:text-slate-300 font-mono">
                            {formatBytes(d.used * 1024)} / {formatBytes(d.total * 1024)} ({Math.round(pct)}%)
                          </span>
                        </div>
                        <div className="metric-track h-2 rounded-full overflow-hidden">
                          <div
                            className={`h-full metric-fill rounded-full ${pct > 90 ? 'bg-rose-500/80' : pct > 75 ? 'bg-amber-500/80' : 'bg-indigo-500/70'}`}
                            style={{ width: `${Math.min(pct, 100)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="glass-card p-5 rounded-xl">
            <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-2">
              <Info size={14} /> {t('detail.systemInfo')}
            </h4>
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <OsIcon osFamily={snap.os_family} osId={snap.os_id} osName={snap.os_name} size={28} className="text-slate-700 dark:text-slate-200" />
                <div className="min-w-0">
                  <div className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">{snap.os_name ?? '—'}</div>
                  {snap.kernel && (
                    <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                      {t('detail.kernelLabel')} {snap.kernel}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="flex items-center gap-2 text-slate-500 dark:text-slate-400 shrink-0">
                  <Cpu size={14} /> {t('detail.metricCpu')}
                </span>
                <span className="text-slate-800 dark:text-slate-200 font-medium min-w-0 text-right">
                  <span className="block truncate">{[snap.cpu_vendor, snap.cpu_model].filter(Boolean).join(' ') || '—'}</span>
                  {cpuSub && <span className="block text-slate-500 dark:text-slate-400 font-normal">{cpuSub}</span>}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="flex items-center gap-2 text-slate-500 dark:text-slate-400 shrink-0">
                  <MemoryStick size={14} /> {t('detail.ram')}
                </span>
                <span className="text-slate-800 dark:text-slate-200 font-medium">{snap.mem_total > 0 ? formatBytes(snap.mem_total) : '—'}</span>
              </div>
            </div>
          </div>

          {gpuProcesses.length > 0 && (
            <div className="glass-card p-5 rounded-xl">
              <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-2">
                <Gpu size={14} /> {t('detail.gpuProcesses')}
              </h4>
              <div className="space-y-2">
                {gpuProcesses.map((p, idx) => (
                  <div key={`${p.gpu}-${p.pid}-${idx}`} className="flex items-center justify-between text-xs">
                    <span className="min-w-0 text-slate-700 dark:text-slate-300 font-mono truncate">{p.name}</span>
                    <span className="text-slate-500 font-mono shrink-0 ms-3">GPU {p.gpu} · PID {p.pid} · {formatBytes(p.mem_mb * 1024 * 1024)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </motion.div>
      ) : (
        <div className="glass rounded-2xl border border-dashed border-slate-300 dark:border-white/20 text-center py-10 text-slate-500 text-sm">
          {agentState === 'stale' ? t('detail.agentStaleHint') : t('detail.waitingAgent')}
        </div>
      )}

      {/* History */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="font-bold text-slate-800 dark:text-slate-200 text-sm uppercase tracking-wider">{t('detail.history')}</h3>
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar max-w-full">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                disabled={chartLoading && range === r}
                className={`px-2.5 py-1 rounded-md text-xs font-bold transition-colors shrink-0 whitespace-nowrap ${
                  range === r ? 'bg-indigo-600 text-white' : 'glass border border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-white/10'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        <div className="glass-card p-5 rounded-xl">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
              <Zap size={16} className="text-amber-600 dark:text-amber-400" />
              <span className="text-xs uppercase tracking-wider font-semibold">{t('detail.energyTitle', { range })}</span>
            </div>
            {energy ? (
              <div className="flex items-baseline gap-3 flex-wrap">
                <span className="text-xl font-bold text-slate-900 dark:text-slate-100">{energy.kwh.toFixed(energy.kwh >= 100 ? 1 : 2)} kWh</span>
                {energy.cost !== null ? (
                  <span className="font-mono text-sm text-amber-700 dark:text-amber-300">≈ {energy.cost.toFixed(2)} {energy.currency}</span>
                ) : (
                  <button
                    onClick={onOpenSettings}
                    className="text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 dark:hover:text-indigo-300 underline underline-offset-2 transition-colors"
                  >
                    {t('detail.setCostHint')}
                  </button>
                )}
              </div>
            ) : (
              <span className="text-sm text-slate-500">{t('detail.noDataPeriod')}</span>
            )}
          </div>
          {energy && ((energy.components?.length ?? 0) > 0 || (energy.base_power_w ?? 0) > 0) ? (
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {energy.components?.map((c) => (
                <div key={c.key} className="rounded-lg bg-slate-100/80 dark:bg-white/5 px-3 py-2.5">
                  <div className="text-[11px] uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400">{c.label}</div>
                  <div className="mt-1 text-sm font-bold text-slate-900 dark:text-slate-100">
                    {c.kwh >= 100 ? c.kwh.toFixed(1) : c.kwh.toFixed(2)} kWh
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    {c.avg_w !== null && c.avg_w > 0 ? t('detail.avgW', { w: String(Math.round(c.avg_w)) }) : t('detail.componentNoData')}
                  </div>
                </div>
              ))}
              {(energy.base_power_w ?? 0) > 0 ? (
                <div className="rounded-lg bg-slate-100/80 dark:bg-white/5 px-3 py-2.5">
                  <div className="text-[11px] uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400">{t('detail.baseSystem')}</div>
                  <div className="mt-1 text-sm font-bold text-slate-900 dark:text-slate-100">
                    {(energy.base_kwh ?? 0) >= 100 ? (energy.base_kwh ?? 0).toFixed(1) : (energy.base_kwh ?? 0).toFixed(2)} kWh
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">{t('detail.wOffset', { w: String(energy.base_power_w) })}</div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <HistoryChart title={t('detail.chartUtilization')} points={chartData} keys={['cpu_avg', 'cpu_max', 'mem_avg', 'mem_max', 'gpu_avg']} range={range} unit="%" loading={chartLoading} />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <HistoryChart title={t('detail.chartPower')} points={chartData} keys={['power_avg', 'power_max']} range={range} unit=" W" yDomain={[0, 'auto']} loading={chartLoading} />
          <HistoryChart title={t('detail.chartNetwork')} points={chartData} keys={['net_rx_mbps', 'net_tx_mbps']} range={range} unit=" Mbps" yDomain={[0, 'auto']} loading={chartLoading} />
        </div>
      </motion.div>

      {pingOpen && (
        <PingDialog deviceId={device.id} deviceName={device.name} deviceIp={device.ip} onClose={() => setPingOpen(false)} />
      )}
      {tokenOpen && (
        <AgentTokenDialog
          device={device}
          agentState={agentState}
          lastSeen={lastSeen}
          reportedVersion={reportedVersion}
          servedVersion={servedVersion}
          onClose={() => setTokenOpen(false)}
          onUpdated={onUpdated}
        />
      )}
      {confirmAction && (
        <ConfirmDialog
          title={
            confirmAction === 'reboot'
              ? t('detail.confirmReboot', { name: device.name })
              : confirmAction === 'hibernate'
                ? t('detail.confirmHibernate', { name: device.name })
                : confirmAction === 'update'
                  ? t('detail.confirmUpdate', { name: device.name })
                  : t('detail.confirmShutdown', { name: device.name })
          }
          message={
            confirmAction === 'reboot'
              ? t('detail.msgReboot')
              : confirmAction === 'hibernate'
                ? t('detail.msgHibernate')
                : confirmAction === 'update'
                  ? t('detail.msgUpdate')
                  : t('detail.msgShutdown')
          }
          confirmLabel={
            confirmAction === 'reboot'
              ? t('action.nameReboot')
              : confirmAction === 'hibernate'
                ? t('action.nameHibernate')
                : confirmAction === 'update'
                  ? t('common.update')
                  : t('action.nameShutdown')
          }
          loading={!!actionLoading[confirmAction]}
          onConfirm={async () => {
            const ok = await handleAction(confirmAction);
            if (ok) setConfirmAction(null);
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {showEditModal && (
        <Modal
          onBackdropClick={() => setShowEditModal(false)}
          className="w-full sm:max-w-lg max-h-[92dvh] sm:max-h-[85vh] overflow-y-auto custom-scrollbar rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl border-b sm:border border-slate-200 dark:border-white/10"
        >
          <div className="flex items-center justify-between mb-6">
            <h3 className="font-medium text-slate-800 dark:text-slate-200 flex items-center gap-2 min-w-0">
              <Pencil size={18} className="text-indigo-600 dark:text-indigo-400 shrink-0" />
              <span className="truncate">{t('detail.editTitle', { name: device.name })}</span>
            </h3>
            <button
              onClick={() => setShowEditModal(false)}
              className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-300 transition-colors p-1 rounded-lg hover:bg-slate-200/70 dark:hover:bg-white/10"
              aria-label={t('detail.closeEdit')}
            >
              <X size={20} />
            </button>
          </div>
          <DeviceForm
            values={editValues}
            onChange={setEditValues}
            profiles={editProfiles}
            groups={editGroups}
            interfaces={device.interfaces ?? []}
            selectedIfaceName={wolIfaceName}
            onIfaceSelect={handleIfaceSelect}
            submitLabel={t('detail.saveChanges')}
            onSubmit={(e) => void submitEdit(e)}
            onCancel={() => setShowEditModal(false)}
            agentSync={
              device.has_agent_token
                ? {
                    onClick: () => void handleSyncFromAgent(),
                    loading: syncing,
                    disabled: agentState === 'none',
                    hint: syncHint
                  }
                : undefined
            }
          />
        </Modal>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={t('detail.deleteDeviceTitle')}
          message={t('detail.deleteConfirmMessage', { name: device.name })}
          confirmLabel={t('common.delete')}
          loading={deleting}
          onConfirm={() => void confirmDeleteDevice()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {toastContainer}
    </div>
  );
}
