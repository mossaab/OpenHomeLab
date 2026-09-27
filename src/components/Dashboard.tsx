import { useState, useEffect, type DragEvent } from 'react';
import { apiCall } from '../api';
import { pendingActionLabel, compareAgentVersions } from '../actionLabel';
import { AppSettings, CardSize, DashboardView, Device, EnergyRange, EnergyStats, FleetPowerStats, Group, PendingDeviceAction } from '../types';
import OsIcon from './OsIcon';
import { groupColorSpec, groupIcon } from '../groupOptions';
import { deviceTypeSpec } from '../deviceTypes';
import { RefreshCw, AlertCircle, WifiOff, Zap, Search, Loader2, LayoutGrid, List as ListIcon, ChevronDown, ChevronRight, GripVertical, Layers, Boxes, Router } from 'lucide-react';
import { motion } from 'motion/react';
import DeviceActions from './DeviceActions';
import GroupManager from './GroupManager';
import DevicesSetup from './DevicesSetup';
import Modal from './Modal';
import { useToast } from './Toast';
import PingDialog from './PingDialog';
import ConfirmDialog from './ConfirmDialog';
import DeviceDetail from './DeviceDetail';
import { useI18n } from '../i18n';

const POWER_SCALE_W = 200;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const ENERGY_RANGES: EnergyRange[] = ['1h', '24h', '30d'];

const ENERGY_SLOTS: Record<EnergyRange, { slotMs: number; slots: number; tickEvery: number }> = {
  '1h': { slotMs: MINUTE_MS, slots: 60, tickEvery: 10 },
  '24h': { slotMs: 30 * MINUTE_MS, slots: 48, tickEvery: 8 },
  '30d': { slotMs: DAY_MS, slots: 30, tickEvery: 5 },
};

const formatSlotLabel = (range: EnergyRange, ts: number, locale: string) => {
  const d = new Date(ts);
  return range === '30d' ? d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' }) : d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
};

const CARD_SIZES: CardSize[] = ['normal', 'compact', 'minimal'];
const CARD_SIZE_KEYS: Record<CardSize, 'dashboard.sizeNormal' | 'dashboard.sizeCompact' | 'dashboard.sizeMinimal'> = {
  normal: 'dashboard.sizeNormal',
  compact: 'dashboard.sizeCompact',
  minimal: 'dashboard.sizeMinimal',
};

const CARD_SIZE_SHORT_KEYS: Record<CardSize, 'dashboard.sizeShortNormal' | 'dashboard.sizeShortCompact' | 'dashboard.sizeShortMinimal'> = {
  normal: 'dashboard.sizeShortNormal',
  compact: 'dashboard.sizeShortCompact',
  minimal: 'dashboard.sizeShortMinimal',
};

const POWER_ACTION_KEYS = {
  reboot: 'action.nameReboot',
  shutdown: 'action.nameShutdown',
  hibernate: 'action.nameHibernate',
  update: 'action.nameUpdate',
} as const;
type StatusFilter = 'all' | 'online' | 'offline';

interface MiniStats {
  cpu: number | null;
  mem_pct: number | null;
  gpu_util: number | null;
  power_total_w: number | null;
  agent_version?: string | null;
  agent_interval?: number | null;
  last_seen: number;
  os_family?: 'linux' | 'macos' | null;
  os_name?: string | null;
}

interface DeviceMetrics {
  isOnline: boolean;
  agentStale: boolean;
  cpuPct: number | null;
  memPct: number | null;
  gpuPct: number | null;
  powerW: number | null;
  agentVersion: string | null;
  agentOutdated: boolean;
  intervalOutdated: boolean;
  reportedInterval: number | null;
  osFamily: 'linux' | 'macos' | null;
  osName: string | null;
}

const byPos = (a: Device, b: Device) => (a.position ?? 0) - (b.position ?? 0) || a.id - b.id;

function MetricBar({ label, valueText, pct, barClass }: { label: string; valueText: string; pct: number | null; barClass: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-7 text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</span>
      <div className="metric-track flex-1 h-1.5 rounded-full overflow-hidden">
        {pct !== null && (
          <div className={`h-full metric-fill rounded-full ${barClass}`} style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }} />
        )}
      </div>
      <span className="w-14 text-right text-xs font-mono text-slate-700 dark:text-slate-300">{valueText}</span>
    </div>
  );
}

function MiniStat({ label, valueText, pct, barClass }: { label: string; valueText: string; pct: number | null; barClass: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-[9px] font-bold uppercase tracking-wider text-slate-400 dark:text-white/25 leading-none">
        <span>{label}</span>
        <span className="font-mono text-slate-600 dark:text-slate-300">{valueText}</span>
      </div>
      <div className="metric-track h-1 rounded-full overflow-hidden">
        {pct !== null && (
          <div className={`h-full metric-fill ${barClass}`} style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }} />
        )}
      </div>
    </div>
  );
}

function FleetEnergy({ range, onRangeChange, settingsTick, onOpenSettings, currentW }: { range: EnergyRange; onRangeChange: (r: EnergyRange) => void; settingsTick: number; onOpenSettings: () => void; currentW: number | null }) {
  const [stats, setStats] = useState<EnergyStats | null>(null);
  const [power, setPower] = useState<FleetPowerStats | null>(null);
  const [loading, setLoading] = useState(true);
  const { t, lang } = useI18n();

  const slotSpec = ENERGY_SLOTS[range];
  const [windowStart, setWindowStart] = useState(0);

  useEffect(() => {
    const align = () => setWindowStart(Math.floor(Date.now() / slotSpec.slotMs) * slotSpec.slotMs);
    align();
    const t = setInterval(align, 1000);
    return () => clearInterval(t);
  }, [slotSpec.slotMs]);

  useEffect(() => {
    if (windowStart === 0) return;
    let cancelled = false;
    setLoading(true);
    apiCall<EnergyStats>(`/devices/stats/energy?range=${range}`)
      .then((data) => { if (!cancelled) setStats(data); })
      .catch((e) => console.error(e))
      .finally(() => { if (!cancelled) setLoading(false); });
    apiCall<FleetPowerStats>(`/devices/stats/power?range=${range}`)
      .then((data) => { if (!cancelled) setPower(data); })
      .catch((e) => console.error(e));
    return () => { cancelled = true; };
  }, [range, settingsTick, windowStart]);

  const rawPoints: { ts: number; power_w: number }[] = power?.points ?? [];
  const pointByTs = new Map(rawPoints.map((p) => [p.ts, p.power_w] as [number, number]));
  const slots = Array.from({ length: slotSpec.slots }, (_, i) => {
    const ts = windowStart - (slotSpec.slots - 1 - i) * slotSpec.slotMs;
    return { ts, powerW: pointByTs.get(ts) ?? null };
  });
  const filled = slots.filter((s) => s.powerW !== null);
  const peakW = filled.length > 0 ? filled.reduce((m, s) => Math.max(m, s.powerW ?? 0), -Infinity) : null;
  const avgW = filled.length > 0 ? filled.reduce((sum, s) => sum + (s.powerW ?? 0), 0) / filled.length : null;

  return (
    <div className="glass-card rounded-2xl p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <Zap size={16} className="text-amber-600 dark:text-amber-400" />
            <span className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400">{t('dashboard.fleetEnergy')}</span>
          </div>
          {loading && !stats ? (
            <div className="flex items-center gap-2 text-sm text-slate-500 h-7">
              <Loader2 size={16} className="animate-spin" /> {t('app.loading')}
            </div>
          ) : stats ? (
            <>
              <div className="flex items-baseline gap-3 flex-wrap">
                <span className="text-2xl font-bold text-slate-900 dark:text-slate-100">{stats.kwh.toFixed(stats.kwh >= 100 ? 1 : 2)} kWh</span>
                {stats.cost !== null ? (
                  <span className="font-mono text-sm text-amber-700 dark:text-amber-300">≈ {stats.cost.toFixed(2)} {stats.currency}</span>
                ) : (
                  <button
                    onClick={onOpenSettings}
                    className="text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 dark:hover:text-indigo-300 underline underline-offset-2 transition-colors"
                  >
                    {t('dashboard.setCostHint')}
                  </button>
                )}
              </div>
              <div className="mt-1 text-[11px] font-mono text-slate-500 dark:text-slate-400">
                {currentW !== null || (filled.length > 0 && avgW !== null && peakW !== null) ? (
                  <>
                    {currentW !== null && <>{t('dashboard.energyNow', {w: Math.round(currentW)})}</>}
                    {currentW !== null && filled.length > 0 && avgW !== null && peakW !== null && ' · '}
                    {filled.length > 0 && avgW !== null && peakW !== null && (
                      <>{t('dashboard.energyAvgPeak', {a: Math.round(avgW), p: Math.round(peakW), n: filled.length, m: slots.length})}</>
                    )}
                  </>
                ) : (
                  t('dashboard.noPowerHistory')
                )}
              </div>
            </>
          ) : (
            <span className="text-sm text-slate-500">{t('dashboard.noData')}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {ENERGY_RANGES.map((r) => (
            <button
              key={r}
              onClick={() => onRangeChange(r)}
              className={`px-2.5 py-1 rounded-md text-xs font-bold transition-colors ${
                range === r ? 'bg-indigo-600 text-white' : 'glass border border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-white/10'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className="border-t border-slate-200 dark:border-white/5 pt-3">
        {loading && power === null ? (
          <div className="h-24 flex items-center justify-center">
            <Loader2 size={14} className="animate-spin text-slate-400 dark:text-slate-500" />
          </div>
        ) : (
          <>
            <div className="relative h-20 flex gap-[2px]">
              {slots.map((slot) => (
                <div key={slot.ts} className="group relative h-full min-w-0 flex-1 flex items-end">
                  {slot.powerW !== null ? (
                    <div
                      className="w-full bg-amber-400/90"
                      style={{ height: `${Math.max(8, (slot.powerW / (peakW ?? 1)) * 100).toFixed(2)}%` }}
                    />
                  ) : (
                    <div className="w-full h-[3px] bg-slate-300/70 dark:bg-white/10" />
                  )}
                  <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:flex items-center gap-1.5 whitespace-nowrap glass-card rounded-md px-2 py-1 shadow-lg border border-slate-200 dark:border-white/10 text-[10px] font-mono z-10">
                    <span className="text-slate-500 dark:text-slate-400">{formatSlotLabel(range, slot.ts, lang)}</span>
                    <span className="font-semibold text-slate-800 dark:text-slate-200">{slot.powerW !== null ? `${Math.round(slot.powerW)} W` : '—'}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-1 flex gap-[2px]">
              {slots.map((slot, i) => (
                <div
                  key={slot.ts}
                  className={`min-w-0 flex-1 text-center text-[9px] font-mono text-slate-400 dark:text-slate-500 ${i % slotSpec.tickEvery === 0 ? '' : 'invisible'}`}
                >
                  {formatSlotLabel(range, slot.ts, lang)}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
export default function Dashboard({ settingsTick, onOpenSettings, onOpenTerminal, onOpenIpTerminal, selectedDeviceId, onSelectDevice, refreshMs = 30000, agentIntervalS = 30, agentStaleMs = 90000, appSettings, onAppSettingsChanged }: {
  settingsTick: number;
  onOpenSettings: () => void;
  onOpenTerminal: (deviceId: number, name: string, profileId: number | null) => void;
  onOpenIpTerminal: (ip: string, name?: string) => void;
  selectedDeviceId: number | null;
  onSelectDevice: (id: number | null) => void;
  refreshMs?: number;
  agentIntervalS?: number;
  agentStaleMs?: number;
  appSettings: AppSettings | null;
  onAppSettingsChanged: () => void;
}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [statusMap, setStatusMap] = useState<Record<number, boolean>>({});
  const [statsMap, setStatsMap] = useState<Record<string, MiniStats>>({});
  const [actionMap, setActionMap] = useState<Record<string, PendingDeviceAction>>({});
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [tick, setTick] = useState(() => Date.now());
  const [selectedId, setSelectedId] = useState<number | null>(selectedDeviceId);
  const [detailDevice, setDetailDevice] = useState<Device | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [pingDevice, setPingDevice] = useState<{ id: number; name: string; ip: string } | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ id: number; name: string; action: 'reboot' | 'shutdown' | 'hibernate' | 'update' } | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<number, boolean>>({});
  const [energyRange, setEnergyRange] = useState<EnergyRange>('24h');
  const [servedVersion, setServedVersion] = useState<string | null>(null);
  const [showGroupManager, setShowGroupManager] = useState(false);
  const [showDevicesModal, setShowDevicesModal] = useState(false);
  const [dragDeviceId, setDragDeviceId] = useState<number | null>(null);
  const [deviceDropHint, setDeviceDropHint] = useState<{ groupId: number | null; index: number } | null>(null);
  const [dragGroupId, setDragGroupId] = useState<number | null>(null);
  const [groupOverId, setGroupOverId] = useState<number | 'end' | null>(null);
  const { addToast, toastContainer } = useToast();
  const { t } = useI18n();

  const view: DashboardView = appSettings?.dashboard_view === 'list' ? 'list' : 'grid';
  const size: CardSize = CARD_SIZES.includes(appSettings?.dashboard_card_size as CardSize)
    ? (appSettings!.dashboard_card_size as CardSize)
    : 'normal';

  const fetchData = async () => {
    try {
      setNowTs(Date.now());
      const [devsRes, groupsRes, statusesRes, statsRes, actionsRes] = await Promise.allSettled([
        apiCall<Device[]>('/devices/active'),
        apiCall<Group[]>('/groups'),
        apiCall<Record<number, boolean>>('/devices/status'),
        apiCall<Record<string, MiniStats>>('/devices/stats/all'),
        apiCall<Record<string, PendingDeviceAction>>('/devices/actions'),
      ]);
      if (devsRes.status === 'fulfilled') setDevices(devsRes.value);
      else console.error(devsRes.reason);
      if (groupsRes.status === 'fulfilled') setGroups(groupsRes.value);
      else console.error(groupsRes.reason);
      if (statusesRes.status === 'fulfilled') setStatusMap(statusesRes.value);
      else console.error(statusesRes.reason);
      if (statsRes.status === 'fulfilled') setStatsMap(statsRes.value);
      else console.error(statsRes.reason);
      if (actionsRes.status === 'fulfilled') setActionMap(actionsRes.value);
      else console.error(actionsRes.reason);
    } finally {
      setLoading(false);
      setLastUpdated(Date.now());
      setTick(Date.now());
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, refreshMs);
    return () => clearInterval(interval);
  }, [refreshMs]);

  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    setSelectedId(selectedDeviceId);
  }, [selectedDeviceId]);

  useEffect(() => {
    apiCall<{ success: boolean; version: string }>('/agent/version')
      .then((data) => setServedVersion(data.version))
      .catch(() => setServedVersion(null));
  }, []);

  const closeDevicesModal = () => {
    setShowDevicesModal(false);
    fetchData();
  };

  const handleViewDeviceFromModal = (id: number) => {
    setShowDevicesModal(false);
    onSelectDevice(id);
  };

  useEffect(() => {
    if (selectedId === null) {
      setDetailDevice(null);
      return;
    }
    const found = devices.find((d) => d.id === selectedId);
    if (found || (detailDevice && detailDevice.id === selectedId)) return;
    let cancelled = false;
    apiCall<Device[]>('/devices')
      .then((all) => {
        if (!cancelled) setDetailDevice(all.find((d) => d.id === selectedId) ?? null);
      })
      .catch((e) => console.error(e));
    return () => { cancelled = true; };
  }, [selectedId, devices]);

  const selectedDevice =
    devices.find((d) => d.id === selectedId) ?? (detailDevice && detailDevice.id === selectedId ? detailDevice : null);

  const handleSelect = (id: number | null) => {
    setSelectedId(id);
    onSelectDevice(id);
  };

  const persistSetting = async (patch: { dashboard_view?: DashboardView; dashboard_card_size?: CardSize }) => {
    try {
      await apiCall('/settings', { method: 'PUT', body: JSON.stringify(patch) });
      onAppSettingsChanged();
    } catch (e: any) {
      addToast('error', e.message || t('dashboard.failedDisplayPrefs'));
    }
  };

  const applyLocalMove = (list: Device[], deviceId: number, targetGroupId: number | null, uiIndex: number): Device[] => {
    const source = list.find((d) => d.id === deviceId);
    if (!source) return list;
    const without = list.filter((d) => d.id !== deviceId);
    const target = without
      .filter((d) => (targetGroupId === null ? d.group_id === null : d.group_id === targetGroupId))
      .sort(byPos);
    const clamped = Math.max(0, Math.min(uiIndex, target.length));
    const merged = [...target.slice(0, clamped), { ...source, group_id: targetGroupId }, ...target.slice(clamped)];
    const newPositions = new Map<number, number>();
    merged.forEach((d, i) => newPositions.set(d.id, i));
    return list.map((d) => {
      if (d.id === deviceId) return { ...d, group_id: targetGroupId, position: clamped };
      if (newPositions.has(d.id)) return { ...d, position: newPositions.get(d.id)! };
      return d;
    });
  };

  const moveDevice = async (deviceId: number, targetGroupId: number | null, uiIndex: number) => {
    const source = devices.find((d) => d.id === deviceId);
    if (!source) return;
    let apiIndex = uiIndex;
    if ((source.group_id ?? null) === targetGroupId) {
      const sameGroup = devices.filter((d) => (d.group_id ?? null) === targetGroupId).sort(byPos);
      const curIdx = sameGroup.findIndex((d) => d.id === deviceId);
      if (curIdx >= 0 && curIdx < uiIndex) apiIndex = uiIndex - 1;
    }
    const siblingsLength = devices.filter((d) => (d.group_id ?? null) === targetGroupId && d.id !== deviceId).length;
    if (apiIndex < 0 || apiIndex > siblingsLength) return;
    setDevices((prev) => applyLocalMove(prev, deviceId, targetGroupId, uiIndex));
    try {
      await apiCall(`/devices/${deviceId}/move`, { method: 'PUT', body: JSON.stringify({ group_id: targetGroupId, index: apiIndex }) });
      fetchData();
    } catch (e: any) {
      addToast('error', e.message || t('dashboard.failedMoveDevice'));
      fetchData();
    }
  };

  const reorderGroups = (ids: number[]) => {
    setGroups((prev) => prev.map((g) => ({ ...g, position: ids.indexOf(g.id) })));
    apiCall('/groups/reorder', { method: 'POST', body: JSON.stringify({ ids }) })
      .then(() => fetchData())
      .catch((e: any) => {
        addToast('error', e.message || t('dashboard.failedReorderGroups'));
        fetchData();
      });
  };

  const handleGroupDrop = (beforeGroupId: number | null) => {
    if (dragGroupId === null) return;
    const ids = [...groups].sort((a, b) => a.position - b.position || a.id - b.id).map((g) => g.id);
    const from = ids.indexOf(dragGroupId);
    ids.splice(from, 1);
    let to = beforeGroupId === null ? ids.length : ids.indexOf(beforeGroupId);
    if (to < 0) to = ids.length;
    ids.splice(to, 0, dragGroupId);
    reorderGroups(ids);
    setDragGroupId(null);
    setGroupOverId(null);
  };

  const handleAction = async (deviceId: number, action: 'wake' | 'reboot' | 'shutdown' | 'hibernate' | 'update'): Promise<boolean> => {
    setActionLoading(prev => ({ ...prev, [`${deviceId}-${action}`]: true }));
    try {
      if (action === 'wake') {
        await apiCall(`/devices/${deviceId}/wake`, { method: 'POST' });
        addToast('success', t('action.wolSent'));
      } else {
        const result = await apiCall<{ success: boolean; channel?: 'agent' | 'ssh' }>(`/devices/${deviceId}/command`, {
          method: 'POST',
          body: JSON.stringify({ action })
        });
        const queuedKeys = {
          reboot: 'action.rebootQueued',
          shutdown: 'action.shutDownQueued',
          hibernate: 'action.hibernateQueued',
          update: 'action.updateQueued',
        } as const;
        const sentKeys = {reboot: 'action.rebootSent', shutdown: 'action.shutDownSent', hibernate: 'action.hibernateSent', update: 'action.updateSent'} as const;
        addToast('success', result?.channel === 'agent' ? t(queuedKeys[action]) : t(sentKeys[action]));
      }
      return true;
    } catch (e: any) {
      addToast('error', t('action.actionFailed', {message: e.message}));
      return false;
    } finally {
      setActionLoading(prev => ({ ...prev, [`${deviceId}-${action}`]: false }));
      fetchData();
    }
  };

  const onlineCount = devices.filter((d) => statusMap[d.id]).length;
  let fleetPower: number | null = null;
  for (const id of Object.keys(statsMap)) {
    const m = statsMap[id];
    if (m && nowTs - m.last_seen < agentStaleMs && typeof m.power_total_w === 'number') {
      fleetPower = (fleetPower ?? 0) + m.power_total_w;
    }
  }

  if (selectedDevice) {
    return (
      <DeviceDetail
        device={selectedDevice}
        onBack={() => handleSelect(null)}
        onOpenSettings={onOpenSettings}
        onOpenTerminal={() => onOpenTerminal(selectedDevice.id, selectedDevice.name, selectedDevice.profile_id)}
        settingsTick={settingsTick}
        refreshMs={refreshMs}
        agentIntervalS={agentIntervalS}
        agentStaleMs={agentStaleMs}
        onUpdated={fetchData}
      />
    );
  }

  const query = search.trim().toLowerCase();
  const groupNameById = new Map<number, string>(groups.map((g) => [g.id, g.name.toLowerCase()] as [number, string]));
  const visibleDevices = devices.filter((d) => {
    if (statusFilter === 'online' && !statusMap[d.id]) return false;
    if (statusFilter === 'offline' && statusMap[d.id]) return false;
    if (!query) return true;
    return (
      d.name.toLowerCase().includes(query) ||
      d.ip.toLowerCase().includes(query) ||
      t(deviceTypeSpec(d.type).labelKey).toLowerCase().includes(query) ||
      (d.group_id !== null && d.group_id !== undefined ? groupNameById.get(d.group_id)?.includes(query) ?? false : false)
    );
  });

  const sortedGroups = [...groups].sort((a, b) => a.position - b.position || a.id - b.id);
  const knownGroupIds = new Set(sortedGroups.map((g) => g.id));
  const sections: { groupId: number | null; group: Group | null; items: Device[] }[] = [
    ...sortedGroups.map((g) => ({ groupId: g.id, group: g, items: visibleDevices.filter((d) => d.group_id === g.id).sort(byPos) })),
    {
      groupId: null as number | null,
      group: null as Group | null,
      items: visibleDevices.filter((d) => !d.group_id || !knownGroupIds.has(d.group_id)).sort(byPos),
    },
  ];

  const metricsFor = (device: Device): DeviceMetrics => {
    const mini = statsMap[String(device.id)];
    const agentFresh = mini ? nowTs - mini.last_seen < agentStaleMs : false;
    const agentVersion = agentFresh ? mini?.agent_version ?? null : null;
    return {
      isOnline: !!statusMap[device.id],
      agentStale: !!device.has_agent_token && !agentFresh,
      cpuPct: agentFresh ? mini?.cpu ?? null : null,
      memPct: agentFresh ? mini?.mem_pct ?? null : null,
      gpuPct: agentFresh ? mini?.gpu_util ?? null : null,
      powerW: agentFresh && typeof mini?.power_total_w === 'number' ? mini.power_total_w : null,
      agentVersion,
      agentOutdated: !!agentVersion && !!servedVersion && compareAgentVersions(agentVersion, servedVersion) < 0,
      intervalOutdated: agentFresh ? (mini?.agent_interval ?? null) !== null && (mini?.agent_interval as number) !== agentIntervalS : false,
      reportedInterval: agentFresh ? mini?.agent_interval ?? null : null,
      osFamily: (agentFresh ? mini?.os_family ?? null : null) ?? device.os_family ?? null,
      osName: (agentFresh ? mini?.os_name ?? null : null) ?? device.os_name ?? null,
    };
  };

  const dragHandlersFor = (device: Device) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.effectAllowed = 'move';
      setDragDeviceId(device.id);
    },
    onDragEnd: () => {
      setDragDeviceId(null);
      setDeviceDropHint(null);
    },
  });

  const deviceOverAt = (groupId: number | null, index: number) => (e: DragEvent) => {
    if (dragDeviceId === null) return;
    e.preventDefault();
    e.stopPropagation();
    setDeviceDropHint((prev) => (prev && prev.groupId === groupId && prev.index === index ? prev : { groupId, index }));
  };

  const sectionOverAtEnd = (groupId: number | null, length: number) => (e: DragEvent) => {
    if (dragDeviceId === null) return;
    e.preventDefault();
    setDeviceDropHint((prev) => (prev && prev.groupId === groupId && prev.index === length ? prev : { groupId, index: length }));
  };

  const dropSection = (groupId: number | null) => (e: DragEvent) => {
    e.preventDefault();
    if (dragDeviceId !== null && deviceDropHint && deviceDropHint.groupId === groupId) {
      void moveDevice(dragDeviceId, groupId, deviceDropHint.index);
    }
    setDragDeviceId(null);
    setDeviceDropHint(null);
  };

  const renderDropIndicator = (fullWidth: boolean) => (
    <div className={fullWidth ? 'col-span-full' : ''}>
      <div className="h-0.5 rounded-full bg-indigo-500/90 my-1" />
    </div>
  );

  const renderDevice = (device: Device, index: number) => {
    const m = metricsFor(device);
    const typeSpec = deviceTypeSpec(device.type);
    const TypeIcon = typeSpec.icon;
    const pendingAction = actionMap[String(device.id)];
    const actionLabel = pendingActionLabel(pendingAction, t);
    const showOsIcon = m.osFamily !== null || m.osName !== null;
    const loadingState = {
      wake: !!actionLoading[`${device.id}-wake`],
      reboot: !!actionLoading[`${device.id}-reboot`],
      shutdown: !!actionLoading[`${device.id}-shutdown`],
      hibernate: !!actionLoading[`${device.id}-hibernate`],
      update: !!actionLoading[`${device.id}-update`],
    };
    const renderActions = (menuAlign?: 'start' | 'end', part?: 'all' | 'menu' | 'wake') => (
      <DeviceActions
        menuAlign={menuAlign}
        showWake={part !== 'menu'}
        showMenu={part !== 'wake'}
        isOnline={m.isOnline || null}
        hasAgentToken={device.has_agent_token}
        agentOutdated={m.agentOutdated}
        disablePower={device.disable_power}
        disablePing={device.disable_ping}
        disableTerminal={device.disable_terminal}
        disableAgentUpdate={device.disable_agent_update}
        loading={loadingState}
        onPing={() => setPingDevice({ id: device.id, name: device.name, ip: device.ip })}
        onWake={() => void handleAction(device.id, 'wake')}
        onReboot={() => setConfirmAction({ id: device.id, name: device.name, action: 'reboot' })}
        onShutdown={() => setConfirmAction({ id: device.id, name: device.name, action: 'shutdown' })}
        onHibernate={() => setConfirmAction({ id: device.id, name: device.name, action: 'hibernate' })}
        onUpdate={() => setConfirmAction({ id: device.id, name: device.name, action: 'update' })}
        onTerminal={() => onOpenTerminal(device.id, device.name, device.profile_id)}
      />
    );

    if (view === 'list') {
      return (
        <div
          key={device.id}
          onClick={() => handleSelect(device.id)}
          onDragOver={deviceOverAt(device.group_id ?? null, index)}
          className={`flex items-center gap-3 px-4 py-2.5 glass rounded-xl cursor-pointer hover:bg-slate-100 dark:hover:bg-white/[0.03] transition-colors ${dragDeviceId === device.id ? 'opacity-50' : ''}`}
          {...dragHandlersFor(device)}
        >
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${m.isOnline ? (m.agentStale ? 'status-stale' : 'status-online') : 'status-offline'}`}
            title={m.isOnline ? (m.agentStale ? t('action.onlineStaleTitle') : t('common.online')) : t('common.offline')}
          />
          <span className={`w-7 h-7 rounded-lg border flex items-center justify-center shrink-0 ${typeSpec.badge}`}>
            <TypeIcon size={13} />
          </span>
          {showOsIcon && (
            <OsIcon osFamily={m.osFamily} osName={m.osName} size={15} className="text-slate-500 dark:text-white/50" title={m.osName ?? m.osFamily ?? undefined} />
          )}
          <div className="min-w-0 w-40 md:w-56">
            <div className="font-semibold text-sm text-slate-800 dark:text-slate-200 truncate">{device.name}</div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono truncate">{device.ip}</div>
          </div>
          {m.isOnline ? (
            <div className="hidden lg:flex items-center gap-4 flex-1 min-w-0 pl-2">
              <MiniStat label="CPU" valueText={m.cpuPct !== null ? `${Math.round(m.cpuPct)}%` : '—'} pct={m.cpuPct} barClass="bg-indigo-400/80" />
              <MiniStat label="RAM" valueText={m.memPct !== null ? `${Math.round(m.memPct)}%` : '—'} pct={m.memPct} barClass="bg-emerald-400/80" />
              <MiniStat label="GPU" valueText={m.gpuPct !== null ? `${Math.round(m.gpuPct)}%` : '—'} pct={m.gpuPct} barClass="bg-sky-400/80" />
              <MiniStat label="PWR" valueText={m.powerW !== null ? `${Math.round(m.powerW)} W` : '—'} pct={m.powerW !== null ? (m.powerW / POWER_SCALE_W) * 100 : null} barClass="bg-amber-400/80" />
            </div>
          ) : (
            <div className="flex-1 hidden lg:flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-white/25">
              <WifiOff size={13} /> {t('common.offline')}
            </div>
          )}
          <span className={`ml-auto hidden md:inline-flex px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider border shrink-0 ${typeSpec.badge}`}>
            {t(typeSpec.labelKey)}
          </span>
          {renderActions()}
        </div>
      );
    }

    if (size === 'minimal') {
      return (
        <div
          key={device.id}
          onClick={() => handleSelect(device.id)}
          onDragOver={deviceOverAt(device.group_id ?? null, index)}
          className={`flex items-center gap-3 px-4 py-2 glass-card rounded-xl cursor-pointer hover:bg-slate-100 dark:hover:bg-white/[0.03] transition-colors ${dragDeviceId === device.id ? 'opacity-50' : ''}`}
          {...dragHandlersFor(device)}
        >
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${m.isOnline ? (m.agentStale ? 'status-stale' : 'status-online') : 'status-offline'}`}
            title={m.isOnline ? (m.agentStale ? t('action.onlineStaleTitle') : t('common.online')) : t('common.offline')}
          />
          <span className={`w-7 h-7 rounded-lg border flex items-center justify-center shrink-0 ${typeSpec.badge}`}>
            <TypeIcon size={13} />
          </span>
          {showOsIcon && (
            <OsIcon osFamily={m.osFamily} osName={m.osName} size={15} className="text-slate-500 dark:text-white/50" title={m.osName ?? m.osFamily ?? undefined} />
          )}
          <span className="flex-1 min-w-0 truncate text-sm font-semibold text-slate-800 dark:text-slate-200">{device.name}</span>
          {m.isOnline ? (
            <div className="flex items-center gap-3 sm:gap-4 shrink-0">
              <span className="text-[11px] font-mono text-slate-600 dark:text-slate-300 w-10 text-right">{m.cpuPct !== null ? `${Math.round(m.cpuPct)}%` : '—'}</span>
              <span className="text-[11px] font-mono text-slate-600 dark:text-slate-300 w-10 text-right hidden sm:inline">{m.memPct !== null ? `${Math.round(m.memPct)}%` : '—'}</span>
              <span className="text-[11px] font-mono text-slate-600 dark:text-slate-300 w-12 text-right">{m.powerW !== null ? `${Math.round(m.powerW)} W` : '—'}</span>
            </div>
          ) : (
            <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-white/25 shrink-0">
              <WifiOff size={12} /> {t('common.offline')}
            </span>
          )}
          <div className="shrink-0">{renderActions()}</div>
        </div>
      );
    }

    const compact = size === 'compact';
    return (
      <motion.div
        key={device.id}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: Math.min(index * 0.04, 0.2) }}
        onClick={() => handleSelect(device.id)}
        onDragOver={deviceOverAt(device.group_id ?? null, index)}
        className={`glass-card relative rounded-2xl cursor-pointer hover:bg-slate-100 dark:hover:bg-white/[0.03] transition-colors ${compact ? 'p-2.5' : 'p-3.5'} pb-5 ${m.isOnline ? (m.agentStale ? 'card-status-stale' : 'card-status-online') : 'card-status-offline'} ${dragDeviceId === device.id ? 'opacity-50' : ''}`}
        {...dragHandlersFor(device)}
      >
        <span
          title={t(typeSpec.labelKey)}
          className={`absolute bottom-2 right-2 inline-flex items-center gap-1 max-w-[88px] px-1.5 py-px rounded-md text-[9px] font-bold uppercase tracking-wider border ${typeSpec.badge}`}
        >
          <TypeIcon size={10} className="shrink-0" />
          <span className="min-w-0 truncate">{t(typeSpec.labelKey)}</span>
        </span>
        <div className={`flex items-center gap-2 ${compact ? 'mb-3' : 'mb-4'}`}>
          <div className="flex items-center gap-2 min-w-0">
            {renderActions('start', 'menu')}
            {showOsIcon && (
              <OsIcon osFamily={m.osFamily} osName={m.osName} size={compact ? 15 : 18} className="text-slate-500 dark:text-white/50 shrink-0" title={m.osName ?? m.osFamily ?? undefined} />
            )}
            <div className="min-w-0">
              <h3 className={`font-bold text-slate-800 dark:text-slate-200 truncate ${compact ? 'text-sm' : 'text-lg'}`}>{device.name}</h3>
              <div className={`flex items-center gap-1.5 text-slate-500 dark:text-slate-400 mt-0.5 font-mono ${compact ? 'text-[11px]' : 'text-xs'}`}>
                <span
                  className={`w-[0.9em] h-[0.9em] rounded-full shrink-0 ${m.isOnline ? (m.agentStale ? 'status-stale' : 'status-online') : 'status-offline'}`}
                  title={m.isOnline ? (m.agentStale ? t('action.onlineStaleTitle') : t('common.online')) : t('common.offline')}
                />
                <span className="truncate">{device.ip}</span>
              </div>
            </div>
          </div>
        </div>

        {!compact && (m.agentVersion || m.intervalOutdated) && (
          <div className="mb-3 flex flex-col gap-0.5">
            {m.agentVersion && (
              <div className={`text-[10px] font-bold uppercase tracking-wider ${m.agentOutdated ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400 dark:text-slate-500'}`}>
                {m.agentOutdated ? t('dashboard.agentOutdated', {v: m.agentVersion}) : t('dashboard.agentVersion', {v: m.agentVersion})}
              </div>
            )}
            {m.intervalOutdated && (
              <div className="text-[10px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                {t('dashboard.intervalOutdated', {s: m.reportedInterval})}
              </div>
            )}
          </div>
        )}

        {m.isOnline ? (
          compact ? (
            <div className="grid grid-cols-4 gap-2 mb-3">
              <MiniStat label="CPU" valueText={m.cpuPct !== null ? `${Math.round(m.cpuPct)}%` : '—'} pct={m.cpuPct} barClass="bg-indigo-400/80" />
              <MiniStat label="RAM" valueText={m.memPct !== null ? `${Math.round(m.memPct)}%` : '—'} pct={m.memPct} barClass="bg-emerald-400/80" />
              <MiniStat label="GPU" valueText={m.gpuPct !== null ? `${Math.round(m.gpuPct)}%` : '—'} pct={m.gpuPct} barClass="bg-sky-400/80" />
              <MiniStat label="PWR" valueText={m.powerW !== null ? `${Math.round(m.powerW)} W` : '—'} pct={m.powerW !== null ? (m.powerW / POWER_SCALE_W) * 100 : null} barClass="bg-amber-400/80" />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 mb-4">
              <MetricBar label="CPU" valueText={m.cpuPct !== null ? `${m.cpuPct}%` : '—'} pct={m.cpuPct} barClass="bg-indigo-400/80" />
              <MetricBar label="RAM" valueText={m.memPct !== null ? `${m.memPct}%` : '—'} pct={m.memPct} barClass="bg-emerald-400/80" />
              <MetricBar label="GPU" valueText={m.gpuPct !== null ? `${m.gpuPct}%` : '—'} pct={m.gpuPct} barClass="bg-sky-400/80" />
              <MetricBar
                label="PWR"
                valueText={m.powerW !== null ? `${Math.round(m.powerW)} W` : '—'}
                pct={m.powerW !== null ? (m.powerW / POWER_SCALE_W) * 100 : null}
                barClass="bg-amber-400/80"
              />
            </div>
          )
        ) : (
          compact ? (
            <div className="mb-3 flex items-center justify-center gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              {renderActions('start', 'wake')}
              <WifiOff size={13} />
              {t('common.offline')}
            </div>
          ) : (
            <div className="flex h-[42px] items-center justify-center gap-3 rounded-xl border border-slate-200 dark:border-white/10 bg-white/[0.03] mb-4 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              {renderActions('start', 'wake')}
              <span className="flex items-center gap-2">
                <WifiOff size={14} />
                {t('common.offline')}
              </span>
            </div>
          )
        )}

        {actionLabel && (
          <div className={`flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider mb-3 ${pendingAction.status === 'failed' ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400'}`}>
            {pendingAction.status === 'failed' ? <AlertCircle size={11} /> : <Loader2 size={11} className="animate-spin" />}
            {actionLabel}
          </div>
        )}
      </motion.div>
    );
  };

  const renderSection = (section: { groupId: number | null; group: Group | null; items: Device[] }) => {
    const isUngrouped = section.group === null;
    const colorSpec = isUngrouped ? groupColorSpec('slate') : groupColorSpec(section.group!.color);
    const SectionIcon = isUngrouped ? Boxes : groupIcon(section.group!.icon);
    const onlineInSection = section.items.filter((d) => statusMap[d.id]).length;
    const collapsed = !isUngrouped && !!collapsedGroups[section.group!.id];
    const gridClass =
      view === 'list'
        ? 'flex flex-col gap-1'
        : size === 'minimal'
          ? 'flex flex-col gap-1'
          : size === 'compact'
            ? 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4'
            : 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6';

    return (
      <section
        key={isUngrouped ? 'ungrouped' : section.group!.id}
        className="flex flex-col gap-3"
        onDragOver={(e) => {
          if (dragDeviceId !== null) sectionOverAtEnd(section.groupId, section.items.length)(e);
          if (dragGroupId !== null && !isUngrouped && dragGroupId !== section.group!.id) {
            e.preventDefault();
            setGroupOverId(section.group!.id);
          }
        }}
        onDrop={(e) => {
          if (dragDeviceId !== null) dropSection(section.groupId)(e);
          if (dragGroupId !== null && !isUngrouped && dragGroupId !== section.group!.id) handleGroupDrop(section.group!.id);
        }}
      >
        <div
          className={`flex items-center gap-2.5 ${!isUngrouped ? 'cursor-grab' : ''} rounded-xl transition-colors px-1 py-0.5 ${groupOverId === (isUngrouped ? null : section.group!.id) ? 'bg-indigo-500/10' : ''}`}
          draggable={!isUngrouped}
          onDragStart={(e) => {
            if (isUngrouped) return;
            e.dataTransfer.effectAllowed = 'move';
            setDragGroupId(section.group!.id);
          }}
          onDragEnd={() => {
            setDragGroupId(null);
            setGroupOverId(null);
          }}
        >
          <button
            onClick={() => !isUngrouped && setCollapsedGroups((prev) => ({ ...prev, [section.group!.id]: !prev[section.group!.id] }))}
            className="p-1 -ml-1 rounded-md text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
            title={collapsed ? t('dashboard.expandGroup') : t('dashboard.collapseGroup')}
          >
            {isUngrouped ? <GripVertical size={14} className="opacity-30" /> : collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          </button>
          <span className={`w-7 h-7 rounded-lg border flex items-center justify-center shrink-0 ${colorSpec.chip}`}>
            <SectionIcon size={14} />
          </span>
          <h3 className="font-bold text-sm md:text-base text-slate-800 dark:text-slate-200 tracking-tight truncate">
            {isUngrouped ? t('dashboard.ungrouped') : section.group!.name}
          </h3>
          {!isUngrouped && (
            <span className="w-4 h-4 rounded-full shrink-0 hidden sm:block" style={{ background: colorSpec.dot }} aria-hidden />
          )}
          <span className={`ml-auto flex items-center gap-1.5 text-xs font-bold px-2 py-0.5 rounded-md border shrink-0 ${onlineInSection === section.items.length && section.items.length > 0 ? 'border-emerald-500/30 text-emerald-600 dark:text-emerald-400' : 'border-slate-300 dark:border-white/10 text-slate-500 dark:text-slate-400'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${onlineInSection > 0 ? 'bg-emerald-500' : 'bg-slate-400'}`} />
            {onlineInSection}/{section.items.length}
          </span>
        </div>

        {!collapsed && (
          <div className={gridClass}>
            {section.items.length === 0 ? (
              <div className="col-span-full text-center py-8 rounded-xl border border-dashed border-slate-300 dark:border-white/15 text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                {dragDeviceId !== null ? t('dashboard.dropDeviceHere') : filterActive ? t('dashboard.noDevicesMatchFilters') : t('dashboard.noDevicesDragHere')}
              </div>
            ) : (
              section.items.map((device, i) => (
                <div key={device.id} className={view !== 'list' && size !== 'minimal' ? '' : 'contents'}>
                  {deviceDropHint && deviceDropHint.groupId === section.groupId && deviceDropHint.index === i && renderDropIndicator(view === 'list' || size === 'minimal')}
                  {renderDevice(device, i)}
                </div>
              ))
            )}
            {section.items.length > 0 && deviceDropHint && deviceDropHint.groupId === section.groupId && deviceDropHint.index === section.items.length &&
              renderDropIndicator(view === 'list' || size === 'minimal')}
          </div>
        )}
      </section>
    );
  };

  const filterActive = query !== '' || statusFilter !== 'all';

  return (
    <div className="flex flex-col gap-6">
      <div className="border-b border-slate-200 dark:border-white/5 pb-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight truncate">{t('dashboard.title')}</h2>
            <p className="text-slate-500 dark:text-slate-400 text-xs sm:text-sm mt-1 truncate">
              {t('dashboard.statusSummary', {online: onlineCount, total: devices.length})}
              {fleetPower !== null && t('dashboard.fleetPower', {w: fleetPower.toFixed(1)})}
              {lastUpdated !== null && (
                <span className="hidden md:inline text-slate-400 dark:text-slate-500 whitespace-nowrap">
                  {' · '}
                  {t('dashboard.updatedAgo', {n: Math.max(0, Math.floor((tick - lastUpdated) / 1000))})}
                </span>
              )}
            </p>
            {lastUpdated !== null && (
              <div className="text-[10px] leading-tight whitespace-nowrap text-slate-400 dark:text-slate-500 md:hidden">
                {t('dashboard.updatedAgo', {n: Math.max(0, Math.floor((tick - lastUpdated) / 1000))})}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowDevicesModal(true)}
              className="flex items-center gap-2 h-9 glass border border-slate-200 dark:border-white/10 rounded-lg px-2.5 md:px-3 text-sm font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200/70 dark:hover:bg-white/10 transition-colors"
              title={t('dashboard.manageDevices')}
              aria-label={t('dashboard.manageDevices')}
            >
              <Router size={16} className="shrink-0" />
              <span className="hidden md:inline">{t('dashboard.devicesBtn')}</span>
            </button>
            <button
              onClick={() => setShowGroupManager(true)}
              className="flex items-center gap-2 h-9 glass border border-slate-200 dark:border-white/10 rounded-lg px-2.5 md:px-3 text-sm font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200/70 dark:hover:bg-white/10 transition-colors"
              title={t('dashboard.manageGroups')}
              aria-label={t('dashboard.manageGroups')}
            >
              <Layers size={16} className="shrink-0" />
              <span className="hidden md:inline">{t('dashboard.groupsBtn')}</span>
            </button>
            <button
              onClick={() => { setLoading(true); fetchData(); }}
              className="p-2 glass border border-slate-200 dark:border-white/10 hover:bg-slate-200/70 dark:hover:bg-white/10 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 transition-colors"
              title={t('dashboard.refreshStatuses')}
            >
              <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative w-full sm:w-auto sm:flex-1 md:flex-none">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('dashboard.searchPlaceholder')}
              className="w-full md:w-60 bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div className="flex items-center glass border border-slate-200 dark:border-white/10 rounded-lg p-0.5">
            {(['all', 'online', 'offline'] as StatusFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setStatusFilter(f)}
                className={`px-2 md:px-2.5 py-1.5 rounded-md text-[10px] md:text-[11px] font-bold uppercase tracking-wider transition-colors ${
                  statusFilter === f ? 'bg-slate-200/80 dark:bg-white/10 text-slate-900 dark:text-white' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                {f === 'all' ? t('dashboard.filterAll') : f === 'online' ? t('common.online') : t('common.offline')}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <div className="flex items-center glass border border-slate-200 dark:border-white/10 rounded-lg p-0.5">
              <button
                onClick={() => void persistSetting({ dashboard_view: 'grid' })}
                className={`p-1 md:p-1.5 rounded-md transition-colors ${view === 'grid' ? 'bg-slate-200/80 dark:bg-white/10 text-slate-900 dark:text-white' : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}
                title={t('dashboard.gridTitle')}
              >
                <LayoutGrid size={15} />
              </button>
              <button
                onClick={() => void persistSetting({ dashboard_view: 'list' })}
                className={`p-1 md:p-1.5 rounded-md transition-colors ${view === 'list' ? 'bg-slate-200/80 dark:bg-white/10 text-slate-900 dark:text-white' : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}`}
                title={t('dashboard.listTitle')}
              >
                <ListIcon size={15} />
              </button>
            </div>
            {view === 'grid' && (
              <div className="flex items-center glass border border-slate-200 dark:border-white/10 rounded-lg p-0.5">
                {CARD_SIZES.map((s) => (
                  <button
                    key={s}
                    onClick={() => void persistSetting({ dashboard_card_size: s })}
                    title={t(CARD_SIZE_KEYS[s])}
                    className={`px-1.5 md:px-2.5 py-1.5 rounded-md text-[10px] md:text-[11px] font-bold uppercase tracking-wider transition-colors ${
                      size === s ? 'bg-slate-200/80 dark:bg-white/10 text-slate-900 dark:text-white' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                    }`}
                  >
                    <span className="hidden md:inline">{t(CARD_SIZE_KEYS[s])}</span>
                    <span className="md:hidden">{t(CARD_SIZE_SHORT_KEYS[s])}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <FleetEnergy range={energyRange} onRangeChange={setEnergyRange} settingsTick={settingsTick} onOpenSettings={onOpenSettings} currentW={fleetPower} />

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="glass-card p-6 rounded-2xl skeleton-shimmer" style={{ background: 'linear-gradient(90deg, transparent 25%, rgba(255,255,255,0.06) 50%, transparent 75%)', backgroundSize: '200% 100%' }}>
              <div className="flex justify-between items-start mb-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-slate-200 dark:bg-white/5" />
                  <div className="min-w-0 space-y-2">
                    <div className="h-4 w-28 rounded-md bg-slate-200 dark:bg-white/5" />
                    <div className="h-3 w-20 rounded bg-slate-100 dark:bg-white/[0.03]" />
                  </div>
                </div>
                <div className="px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider bg-slate-200 dark:bg-white/5 w-16 h-5 shrink-0" />
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 mb-4">
                {['CPU', 'RAM', 'GPU', 'PWR'].map((label) => (
                  <div key={label} className="flex items-center gap-2">
                    <span className="w-7 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-white/20">{label}</span>
                    <div className="flex-1 h-1.5 bg-slate-100/70 dark:bg-white/[0.03] rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${i % 2 === 0 ? 'bg-indigo-200 dark:bg-white/8' : 'bg-emerald-200 dark:bg-white/5'} skeleton-shimmer`} style={{ width: `${30 + Math.random() * 60}%`, backgroundSize: '200% 100%' }} />
                    </div>
                    <span className="w-14 text-right text-xs font-mono text-slate-400 dark:text-white/15 skeleton-shimmer" style={{ backgroundSize: '200% 100%', width: '3rem', height: '0.875rem' }}>—</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : devices.length === 0 ? (
        <div className="text-center py-20 glass rounded-2xl border border-dashed border-slate-300 dark:border-white/20 text-slate-500 dark:text-slate-400">
          <AlertCircle className="mx-auto mb-3 opacity-40" size={32} />
          <p>{t('dashboard.emptyCta')}</p>
        </div>
      ) : visibleDevices.length === 0 ? (
        <div className="text-center py-16 glass rounded-2xl border border-dashed border-slate-300 dark:border-white/20 text-slate-500 dark:text-slate-400 text-sm flex flex-col items-center gap-3">
          {t('dashboard.noMatchClear')}
          {filterActive && (
            <button
              onClick={() => { setSearch(''); setStatusFilter('all'); }}
              className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-colors"
            >
              {t('dashboard.clearFilters')}
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {sections.map((sec) => renderSection(sec))}
          {dragGroupId !== null && groups.length > 0 && (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setGroupOverId('end');
              }}
              onDrop={(e) => {
                e.preventDefault();
                handleGroupDrop(null);
              }}
              className={`rounded-xl border border-dashed px-3 py-4 text-center text-xs font-bold uppercase tracking-wider transition-colors ${
                groupOverId === 'end'
                  ? 'border-indigo-500 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300'
                  : 'border-slate-300 dark:border-white/15 text-slate-400 dark:text-slate-500'
              }`}
            >
              {t('dashboard.dropGroupEnd')}
            </div>
          )}
        </div>
      )}

      {toastContainer}

      {showDevicesModal && (
        <Modal
          onBackdropClick={closeDevicesModal}
          className="w-full sm:max-w-4xl max-h-[92dvh] sm:max-h-[85vh] overflow-y-auto custom-scrollbar rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl border-b sm:border border-slate-200 dark:border-white/10"
        >
          <DevicesSetup onClose={closeDevicesModal} onViewDevice={handleViewDeviceFromModal} onOpenIpTerminal={onOpenIpTerminal} />
        </Modal>
      )}

      {showGroupManager && <GroupManager groups={groups} onClose={() => setShowGroupManager(false)} onChanged={fetchData} />}

      {pingDevice && (
        <PingDialog
          deviceId={pingDevice.id}
          deviceName={pingDevice.name}
          deviceIp={pingDevice.ip}
          onClose={() => setPingDevice(null)}
        />
      )}

      {confirmAction && (
        <ConfirmDialog
          title={t('dashboard.confirmTitle', {action: t(POWER_ACTION_KEYS[confirmAction.action])})}
          message={t(
            confirmAction.action === 'reboot'
              ? 'dashboard.msgReboot'
              : confirmAction.action === 'hibernate'
                ? 'dashboard.msgHibernate'
                : confirmAction.action === 'update'
                  ? 'dashboard.msgUpdate'
                  : 'dashboard.msgShutdown',
            {name: confirmAction.name},
          )}
          confirmLabel={t(POWER_ACTION_KEYS[confirmAction.action])}
          loading={!!actionLoading[`${confirmAction.id}-${confirmAction.action}`]}
          onConfirm={async () => {
            const success = await handleAction(confirmAction.id, confirmAction.action);
            if (success) setConfirmAction(null);
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}
