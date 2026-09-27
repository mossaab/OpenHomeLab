import React from 'react';
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { apiCall, ApiError } from '../api';
import { AgentSnapshot, Device, DeviceInterface, Group, Profile } from '../types';
import {
  Plus,
  X,
  Wifi,
  Search,
  Copy,
  Loader2,
  CheckCircle2,
  RefreshCw,
  Server,
  LayoutDashboard,
  Eye
} from 'lucide-react';
import { motion } from 'motion/react';
import ConfirmDialog from './ConfirmDialog';
import Modal from './Modal';
import DeviceForm, { DeviceFormValues, EMPTY_DEVICE_FORM } from './DeviceForm';
import { deviceToPutBody } from '../devicePutBody';
import { useToast } from './Toast';
import { deviceTypeSpec } from '../deviceTypes';
import { useI18n } from '../i18n';

function StatusDot({ online }: { online: boolean }) {
  const { t } = useI18n();
  return (
    <span
      title={online ? t('common.online') : t('common.offline')}
      className={`h-2.5 w-2.5 rounded-full shrink-0 ${online ? 'status-online' : 'status-offline'}`}
    />
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-xs text-slate-500 dark:text-slate-400">{label}</span>
      <span className="text-xs font-mono text-slate-600 dark:text-slate-300">{children}</span>
    </div>
  );
}

function ProfileBadge({ name }: { name: string }) {
  return (
    <span className="bg-slate-100 dark:bg-white/10 border border-slate-200 dark:border-white/10 px-2 py-1 rounded text-[10px] uppercase tracking-wider text-indigo-600 dark:text-indigo-300">
      {name}
    </span>
  );
}

const pickWolInterface = (list: DeviceInterface[]): DeviceInterface | null => {
  const withIp = (i: DeviceInterface) => i.ips.length > 0;
  return list.find((i) => i.kind === 'eth' && withIp(i)) ?? list.find(withIp) ?? list[0] ?? null;
};

const SKELETON_COUNT = 5;

interface DevicesSetupProps {
  onClose: () => void;
  onViewDevice: (id: number) => void;
}

export default function DevicesSetup({ onClose, onViewDevice }: DevicesSetupProps) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [statusMap, setStatusMap] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [showModal, setShowModal] = useState(false);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [confirmUpdateAgents, setConfirmUpdateAgents] = useState(false);
  const [updatingAgents, setUpdatingAgents] = useState(false);
  const { addToast, toastContainer } = useToast();

  const [formData, setFormData] = useState<DeviceFormValues>(EMPTY_DEVICE_FORM);
  const [addMode, setAddMode] = useState<'agent' | 'manual'>('agent');
  const [claim, setClaim] = useState<{ claimId: number; token: string; expiresAt: number } | null>(null);
  const [creatingClaim, setCreatingClaim] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [agentSnapshot, setAgentSnapshot] = useState<AgentSnapshot | null>(null);
  const [wolIfaceName, setWolIfaceName] = useState<string | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const claimConsumedRef = useRef(false);
  const { t } = useI18n();

  const createClaim = useCallback(async () => {
    setCreatingClaim(true);
    setClaimError(null);
    try {
      const data = await apiCall<{ claim_id: number; token: string; expires_at: number }>('/devices/claim', {
        method: 'POST'
      });
      setClaim({ claimId: data.claim_id, token: data.token, expiresAt: data.expires_at });
    } catch (e) {
      setClaimError(e instanceof Error ? e.message : t('devsetup.createLinkFailed'));
    } finally {
      setCreatingClaim(false);
    }
  }, [t]);

  const fillFromSnapshot = useCallback((snap: AgentSnapshot, samples: number[]) => {
    const list = snap.interfaces ?? [];
    const iface = pickWolInterface(list);
    const avg = samples.length > 0 ? Math.round((samples.reduce((a, b) => a + b, 0) / samples.length) * 10) / 10 : null;
    setFormData({
      name: snap.hostname || '',
      hostname: snap.hostname || '',
      ip: iface?.ips[0] || '',
      mac: iface?.mac || '',
      type: 'pc',
      profile_id: '',
      group_id: '',
      broadcast_address: iface?.broadcast || '',
      base_power_w: avg !== null ? String(avg) : '',
      poweroff_action: '',
      reboot_action: '',
      hibernate_action: '',
      disable_power: false,
      disable_ping: false,
      disable_terminal: false,
      disable_agent_update: false
    });
    setWolIfaceName(iface?.name ?? null);
  }, []);

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      addToast('success', t('devsetup.copied'));
    } catch {
      addToast('error', t('devsetup.copyFailed'));
    }
  };

  const fetchData = async () => {
    try {
      const [devs, profs, grps] = await Promise.all([
        apiCall<Device[]>('/devices'),
        apiCall<Profile[]>('/profiles'),
        apiCall<Group[]>('/groups')
      ]);
      setDevices(devs);
      setProfiles(profs);
      setGroups(grps);
      try {
        setStatusMap(await apiCall<Record<number, boolean>>('/devices/status'));
      } catch (e) {
        console.error(e);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (!showModal) return;
    const tick = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [showModal]);

  useEffect(() => {
    if (!showModal || addMode !== 'agent' || !claim || agentSnapshot) return;
    const poll = setInterval(async () => {
      try {
        const data = await apiCall<{ installed: boolean; power_samples: number[]; snapshot: AgentSnapshot | null }>(
          `/devices/claims/${claim.claimId}/status`
        );
        if (data.installed && data.snapshot) {
          fillFromSnapshot(data.snapshot, data.power_samples ?? []);
          setAgentSnapshot(data.snapshot);
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          setClaimError(t('devsetup.linkExpired'));
        }
      }
    }, 3000);
    return () => clearInterval(poll);
  }, [showModal, addMode, claim, agentSnapshot, fillFromSnapshot, t]);

  const query = search.trim().toLowerCase();
  const visibleDevices = useMemo(
    () =>
      devices.filter(
        (d) =>
          !query ||
          d.name.toLowerCase().includes(query) ||
          d.ip.toLowerCase().includes(query) ||
          (d.mac ?? '').toLowerCase().includes(query) ||
          (d.hostname ?? '').toLowerCase().includes(query)
      ),
    [devices, query]
  );
  const activeCount = devices.filter((d) => d.active).length;

  const resetForm = () => {
    setFormData(EMPTY_DEVICE_FORM);
    setAddMode('agent');
    setClaim(null);
    setCreatingClaim(false);
    setClaimError(null);
    setAgentSnapshot(null);
    setWolIfaceName(null);
    claimConsumedRef.current = false;
  };

  const openAddModal = () => {
    resetForm();
    setShowModal(true);
    void createClaim();
  };

  const closeModal = () => {
    if (claim && !claimConsumedRef.current) {
      apiCall(`/devices/claims/${claim.claimId}`, { method: 'DELETE' }).catch(() => undefined);
    }
    setShowModal(false);
    resetForm();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {
      ...formData,
      profile_id: formData.profile_id ? parseInt(formData.profile_id) : null,
      group_id: formData.group_id ? parseInt(formData.group_id) : null,
      base_power_w: formData.base_power_w === '' ? null : Number(formData.base_power_w)
    };
    if (addMode === 'agent') {
      if (agentSnapshot?.interfaces?.length) body.interfaces = agentSnapshot.interfaces;
      if (claim) body.agent_token = claim.token;
    }

    try {
      await apiCall('/devices', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      if (addMode === 'agent' && claim) claimConsumedRef.current = true;
      addToast('success', t('devsetup.deviceAdded'));
      closeModal();
      fetchData();
    } catch (e: any) {
      addToast('error', t('devsetup.failedPrefix', { message: e.message }));
    }
  };

  const toggleActive = async (dev: Device) => {
    setTogglingId(dev.id);
    try {
      await apiCall(`/devices/${dev.id}`, {
        method: 'PUT',
        body: JSON.stringify(deviceToPutBody(dev, { active: dev.active ? 0 : 1 }))
      });
      fetchData();
    } catch (e: any) {
      addToast('error', t('devsetup.toggleFailed', { message: e.message }));
    } finally {
      setTogglingId(null);
    }
  };

  const handleUpdateAgents = async () => {
    setUpdatingAgents(true);
    try {
      const data = await apiCall<{ success: boolean; queued: number; up_to_date: number }>('/devices/agents/update', {
        method: 'POST'
      });
      if (data.queued > 0) {
        addToast(
          'success',
          t('devsetup.updatesQueued', { n: data.queued, plural: data.queued === 1 ? '' : 's' })
        );
      } else if (data.up_to_date > 0) {
        addToast('success', t('devsetup.allUpToDate'));
      } else {
        addToast('success', t('devsetup.noOnlineAgents'));
      }
    } catch (e: any) {
      addToast('error', t('devsetup.updateFailed', { message: e.message }));
    } finally {
      setUpdatingAgents(false);
      setConfirmUpdateAgents(false);
    }
  };

  const renderDashboardToggle = (dev: Device, size: 'sm' | 'lg') => {
    const busy = togglingId === dev.id;
    const onDashboard = !!dev.active;
    return (
      <button
        type="button"
        onClick={() => void toggleActive(dev)}
        disabled={busy}
        title={onDashboard ? t('devsetup.removeDashTitle') : t('devsetup.addDashTitle')}
        aria-label={
          onDashboard
            ? t('devsetup.removeDashAria', { name: dev.name })
            : t('devsetup.addDashAria', { name: dev.name })
        }
        className={`inline-flex items-center justify-center glass rounded-lg transition-colors disabled:opacity-50 ${
          size === 'lg' ? 'h-11 w-11' : 'p-2'
        } ${onDashboard ? 'text-emerald-600 dark:text-emerald-400 hover:bg-slate-200/70 dark:hover:bg-white/10' : 'text-slate-400 dark:text-slate-500 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-white/10'}`}
      >
        <LayoutDashboard size={size === 'lg' ? 20 : 18} />
      </button>
    );
  };

  const renderViewButton = (dev: Device, size: 'sm' | 'lg') => {
    return (
      <button
        type="button"
        onClick={() => onViewDevice(dev.id)}
        title={t('devsetup.viewDetails')}
        aria-label={t('devsetup.viewDetailsAria', { name: dev.name })}
        className={`inline-flex items-center justify-center glass rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-white/10 transition-colors ${
          size === 'lg' ? 'h-11 w-11' : 'p-2'
        }`}
      >
        <Eye size={size === 'lg' ? 20 : 18} />
      </button>
    );
  };

  const skeletonRows = (
    <>
      {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
        <tr key={i}>
          <td className="px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-slate-200 dark:bg-white/5 skeleton-shimmer" />
              <div className="flex-1 space-y-2 min-w-0">
                <div className="h-3.5 w-32 max-w-full rounded bg-slate-200 dark:bg-white/5 skeleton-shimmer" />
                <div className="h-3 w-24 max-w-full rounded bg-slate-100 dark:bg-white/[0.03] skeleton-shimmer" />
              </div>
            </div>
          </td>
          <td className="px-4 py-3">
            <div className="h-3 w-28 max-w-full rounded bg-slate-200 dark:bg-white/5 skeleton-shimmer" />
          </td>
          <td className="hidden lg:table-cell px-4 py-3">
            <div className="h-3 w-28 max-w-full rounded bg-slate-200 dark:bg-white/5 skeleton-shimmer" />
          </td>
          <td className="px-4 py-3">
            <div className="h-3 w-16 rounded bg-slate-200 dark:bg-white/5 skeleton-shimmer" />
          </td>
          <td className="px-4 py-3 text-end">
            <div className="ms-auto h-8 w-8 rounded-lg bg-slate-200 dark:bg-white/5 skeleton-shimmer" />
          </td>
        </tr>
      ))}
    </>
  );

  const skeletonCards = (
    <>
      {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
        <div key={i} className="p-4 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-slate-200 dark:bg-white/5 skeleton-shimmer" />
            <div className="flex-1 space-y-2 min-w-0">
              <div className="h-3.5 w-32 max-w-full rounded bg-slate-200 dark:bg-white/5 skeleton-shimmer" />
              <div className="h-3 w-24 max-w-full rounded bg-slate-100 dark:bg-white/[0.03] skeleton-shimmer" />
            </div>
          </div>
          <div className="space-y-2">
            <div className="h-3 w-full rounded bg-slate-100 dark:bg-white/[0.03] skeleton-shimmer" />
            <div className="h-3 w-5/6 rounded bg-slate-100 dark:bg-white/[0.03] skeleton-shimmer" />
          </div>
        </div>
      ))}
    </>
  );

  const agentReady = addMode === 'agent' && !!agentSnapshot;
  const modalInterfaces: DeviceInterface[] = agentSnapshot?.interfaces ?? [];
  const installCommand = claim
    ? `curl -fsS ${window.location.origin}/api/agent/install | sh -s -- ${window.location.origin} ${claim.token}`
    : '';

  const handleIfaceSelect = (iface: DeviceInterface) => {
    setWolIfaceName(iface.name);
    setFormData((prev) => ({
      ...prev,
      ip: iface.ips[0] || prev.ip,
      mac: iface.mac || prev.mac,
      broadcast_address: iface.broadcast || prev.broadcast_address
    }));
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight flex items-center gap-3">
            {t('devsetup.title')}
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-white/10 transition-colors"
              aria-label={t('devsetup.closePanel')}
            >
              <X size={20} />
            </button>
          </h2>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
            {t('devsetup.countLine', {
              total: devices.length,
              plural: devices.length === 1 ? '' : 's',
              active: activeCount
            })}
          </p>
        </div>
        <div className="flex items-center gap-3 w-full sm:w-auto flex-wrap">
          <div className="relative flex-1 sm:flex-none">
            <Search size={15} className="absolute start-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('devsetup.searchPlaceholder')}
              aria-label={t('devsetup.searchLabel')}
              className="w-full sm:w-56 bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg ps-9 pe-3 py-2 text-xs text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <button
            onClick={() => setConfirmUpdateAgents(true)}
            disabled={updatingAgents}
            className="flex items-center gap-2 bg-slate-200/70 dark:bg-white/10 hover:bg-slate-300/70 dark:hover:bg-white/15 text-slate-700 dark:text-slate-200 font-medium px-4 py-2.5 rounded-lg transition-colors text-sm disabled:opacity-60"
          >
            <RefreshCw size={16} className={updatingAgents ? 'animate-spin' : ''} />
            {t('devsetup.updateAgents')}
          </button>
          <button
            onClick={openAddModal}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-4 py-2.5 rounded-lg transition-colors text-sm"
          >
            <Plus size={18} />
            {t('devsetup.createDevice')}
          </button>
        </div>
      </div>

      {loading && devices.length === 0 ? (
        <div className="glass-card rounded-2xl overflow-hidden">
          <div className="hidden md:block">
            <table className="w-full text-start text-sm">
              <tbody className="divide-y divide-slate-200 dark:divide-white/10">{skeletonRows}</tbody>
            </table>
          </div>
          <div className="md:hidden divide-y divide-slate-200 dark:divide-white/10">{skeletonCards}</div>
        </div>
      ) : !loading && devices.length === 0 ? (
        <div className="text-center py-16 glass rounded-2xl border border-dashed border-slate-300 dark:border-white/20">
          <Server size={32} className="mx-auto mb-3 text-slate-400 opacity-50" />
          <p className="text-slate-500 dark:text-slate-400 mb-5">{t('devsetup.noDevicesYet')}</p>
          <button
            onClick={openAddModal}
            className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-4 py-2.5 rounded-lg transition-colors text-sm"
          >
            <Plus size={16} />
            {t('devsetup.addFirstDevice')}
          </button>
        </div>
      ) : visibleDevices.length === 0 ? (
        <div className="glass-card rounded-2xl overflow-hidden">
          <div className="px-6 py-14 text-center text-sm text-slate-500 dark:text-slate-400">
            {t('devsetup.noMatch', { query: search })}
          </div>
        </div>
      ) : (
        <div className="glass-card rounded-2xl">
          <div className="hidden md:block">
            <table className="w-full text-start text-sm">
              <thead className="bg-slate-100/70 dark:bg-white/5 border-b border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wider [&>tr>th:first-child]:rounded-ss-2xl [&>tr>th:last-child]:rounded-se-2xl">
                <tr>
                  <th className="px-4 py-3 font-medium">{t('devsetup.colDevice')}</th>
                  <th className="px-4 py-3 font-medium">{t('devsetup.colMac')}</th>
                  <th className="hidden lg:table-cell px-4 py-3 font-medium">{t('devsetup.colBroadcast')}</th>
                  <th className="px-4 py-3 font-medium">{t('devsetup.colProfile')}</th>
                  <th className="px-4 py-3 font-medium text-end">{t('devsetup.colActions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-white/10">
                {visibleDevices.map((dev, i) => {
                  const profile = profiles.find((p) => p.id === dev.profile_id);
                  const DevIcon = deviceTypeSpec(dev.type).icon;
                  return (
                    <motion.tr
                      key={dev.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: Math.min(i * 0.03, 0.25) }}
                      className="hover:bg-slate-100/60 dark:hover:bg-white/[0.04] transition-colors"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className={`shrink-0 ${
                              dev.active ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400 dark:text-slate-500'
                            }`}
                          >
                            <DevIcon size={18} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <StatusDot online={!!statusMap[dev.id]} />
                              <span
                                className={`font-semibold truncate ${
                                  dev.active ? 'text-slate-800 dark:text-slate-200' : 'text-slate-500 dark:text-slate-400'
                                }`}
                              >
                                {dev.name}
                              </span>
                            </div>
                            <div className="mt-0.5 text-xs font-mono text-slate-500 dark:text-slate-400">{dev.ip}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        {dev.mac || '-'}
                      </td>
                      <td className="hidden lg:table-cell px-4 py-3 font-mono text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        {dev.broadcast_address ? (
                          <span className="flex items-center gap-1.5">
                            <Wifi size={12} />
                            {dev.broadcast_address}
                          </span>
                        ) : (
                          <span className="italic text-slate-500 dark:text-slate-600">{t('common.auto')}</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {profile ? (
                          <ProfileBadge name={profile.name} />
                        ) : (
                          <span className="text-xs text-slate-500 dark:text-slate-600 italic">{t('common.none')}</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          {renderDashboardToggle(dev, 'sm')}
                          {renderViewButton(dev, 'sm')}
                        </div>
                      </td>
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="md:hidden divide-y divide-slate-200 dark:divide-white/10">
            {visibleDevices.map((dev, i) => {
              const profile = profiles.find((p) => p.id === dev.profile_id);
              const DevIcon = deviceTypeSpec(dev.type).icon;
              return (
                <motion.div
                  key={dev.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.04, 0.25) }}
                  className="p-4"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`shrink-0 ${
                        dev.active ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400 dark:text-slate-500'
                      }`}
                    >
                      <DevIcon size={18} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <StatusDot online={!!statusMap[dev.id]} />
                        <span
                          className={`font-semibold truncate ${
                            dev.active ? 'text-slate-800 dark:text-slate-200' : 'text-slate-500 dark:text-slate-400'
                          }`}
                        >
                          {dev.name}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs font-mono text-slate-500 dark:text-slate-400">{dev.ip}</div>
                    </div>
                  </div>
                  <div className="mt-3 pt-1 divide-y divide-slate-200/70 dark:divide-white/5">
                    <InfoRow label={t('devsetup.colMac')}>{dev.mac || '-'}</InfoRow>
                    <InfoRow label={t('devsetup.colBroadcast')}>
                      {dev.broadcast_address ? (
                        <span className="flex items-center gap-1.5">
                          <Wifi size={12} />
                          {dev.broadcast_address}
                        </span>
                      ) : (
                        <span className="italic text-slate-500 dark:text-slate-600">{t('common.auto')}</span>
                      )}
                    </InfoRow>
                    <InfoRow label={t('devsetup.colProfile')}>
                      {profile ? (
                        <ProfileBadge name={profile.name} />
                      ) : (
                        <span className="italic text-slate-500 dark:text-slate-600">{t('common.none')}</span>
                      )}
                    </InfoRow>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => void toggleActive(dev)}
                      disabled={togglingId === dev.id}
                      className={`flex-1 flex items-center justify-center gap-2 h-11 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
                        dev.active
                          ? 'bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 text-slate-700 dark:text-slate-300'
                          : 'bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20'
                      }`}
                    >
                      <LayoutDashboard size={16} />
                      {dev.active ? t('devsetup.removeDashTitle') : t('devsetup.addDashTitle')}
                    </button>
                    <button
                      type="button"
                      onClick={() => onViewDevice(dev.id)}
                      className="flex items-center justify-center gap-2 h-11 px-4 rounded-lg bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 text-sm font-medium text-slate-700 dark:text-slate-300 transition-colors"
                    >
                      <Eye size={16} />
                      {t('common.details')}
                    </button>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
      )}

      {showModal && (
        <Modal
          onBackdropClick={closeModal}
          className="w-full sm:max-w-lg max-h-[92dvh] sm:max-h-[85vh] overflow-y-auto custom-scrollbar rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl border-b sm:border border-slate-200 dark:border-white/10"
        >
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-medium text-slate-800 dark:text-slate-200 flex items-center gap-2">
                <Plus size={18} className="text-indigo-600 dark:text-indigo-400" /> {t('devsetup.modalTitle')}
              </h3>
              <button
                onClick={closeModal}
                className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-300 transition-colors p-1 rounded-lg hover:bg-slate-200/70 dark:hover:bg-white/10"
              >
                <X size={20} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-slate-100/80 dark:bg-white/5 mb-5">
              {(['agent', 'manual'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setAddMode(m)}
                  className={`px-3 py-2 rounded-lg text-start transition-colors ${
                    addMode === m
                      ? 'bg-white dark:bg-slate-800 shadow-sm'
                      : 'hover:bg-slate-200/40 dark:hover:bg-white/5'
                  }`}
                >
                  <span
                    className={`block text-xs font-semibold ${
                      addMode === m ? 'text-indigo-600 dark:text-indigo-300' : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {m === 'agent' ? t('devsetup.modeAgent') : t('devsetup.modeManual')}
                  </span>
                  <span className="block text-[10px] leading-tight text-slate-500 dark:text-slate-400 mt-0.5">
                    {m === 'agent' ? t('devsetup.modeAgentDesc') : t('devsetup.modeManualDesc')}
                  </span>
                </button>
              ))}
            </div>

            {addMode === 'agent' && !agentSnapshot && (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="min-w-[18px] h-[18px] rounded-full bg-indigo-600 text-white text-[10px] font-bold flex items-center justify-center">
                      1
                    </span>
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      {t('devsetup.step1Title')}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed ps-[26px]">
                    {t('devsetup.step1Desc')}
                  </p>
                </div>
                {creatingClaim && (
                  <div className="flex items-center gap-3 rounded-lg border border-slate-200 dark:border-white/10 px-4 py-6">
                    <Loader2 size={18} className="animate-spin text-indigo-500" />
                    <span className="text-sm text-slate-500 dark:text-slate-400">{t('devsetup.generatingLink')}</span>
                  </div>
                )}
                {claim && !creatingClaim && (
                  <>
                    <div className="flex gap-2">
                      <code className="flex-1 min-w-0 overflow-x-auto whitespace-nowrap bg-slate-900 text-slate-100 rounded-lg px-3 py-2.5 text-[11px] font-mono">
                        {installCommand}
                      </code>
                      <button
                        type="button"
                        onClick={() => handleCopy(installCommand)}
                        className="shrink-0 flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 rounded-lg text-xs transition-colors"
                      >
                        <Copy size={13} /> {t('common.copy')}
                      </button>
                    </div>
                    <div className="rounded-lg border border-dashed border-indigo-300 dark:border-indigo-500/40 bg-indigo-50/50 dark:bg-indigo-500/10 px-4 py-4">
                      <div className="flex items-center gap-2.5">
                        <span className="min-w-[18px] h-[18px] rounded-full bg-indigo-600 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
                          2
                        </span>
                        <Loader2 size={15} className="animate-spin text-indigo-500" />
                        <span className="text-xs font-medium text-indigo-700 dark:text-indigo-300">
                          {t('devsetup.waitingConnect')}
                        </span>
                      </div>
                      <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400 font-mono ps-[26px]">
                        {t('devsetup.expiresIn', { n: Math.max(0, Math.ceil((claim.expiresAt - nowTs) / 60000)) })}
                      </p>
                    </div>
                  </>
                )}
                {claimError && (
                  <div className="flex items-start gap-2.5 rounded-lg border border-rose-300/60 dark:border-rose-500/40 bg-rose-50/70 dark:bg-rose-500/10 px-4 py-3">
                    <span className="flex-1 text-xs text-rose-700 dark:text-rose-300">{claimError}</span>
                    <button
                      type="button"
                      onClick={() => createClaim()}
                      className="shrink-0 text-xs font-medium text-rose-700 dark:text-rose-300 hover:underline"
                    >
                      {t('common.retry')}
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  onClick={closeModal}
                  className="w-full bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 text-slate-700 dark:text-slate-300 font-medium px-4 py-2.5 rounded-lg transition-colors text-sm"
                >
                  {t('common.cancel')}
                </button>
              </div>
            )}

            {agentReady && (
              <div className="flex items-center gap-2.5 rounded-lg border border-emerald-300/60 dark:border-emerald-500/40 bg-emerald-50/70 dark:bg-emerald-500/10 px-3 py-2.5 mb-4">
                <CheckCircle2 size={15} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
                <span className="text-xs text-emerald-700 dark:text-emerald-300">
                  {t('devsetup.agentDetected', { name: agentSnapshot?.hostname || t('devsetup.deviceFallback') })}
                </span>
              </div>
            )}

            {(addMode === 'manual' || !!agentSnapshot) && (
              <DeviceForm
                values={formData}
                onChange={setFormData}
                profiles={profiles}
                groups={groups}
                interfaces={modalInterfaces}
                selectedIfaceName={wolIfaceName}
                onIfaceSelect={handleIfaceSelect}
                submitLabel={t('devsetup.addDeviceBtn')}
                onSubmit={(e) => void handleSubmit(e)}
                onCancel={closeModal}
              />
            )}
        </Modal>
      )}

      {confirmUpdateAgents && (
        <ConfirmDialog
          title={t('devsetup.updateAgents')}
          message={t('devsetup.confirmUpdatesMessage')}
          confirmLabel={t('common.update')}
          loading={updatingAgents}
          onConfirm={() => void handleUpdateAgents()}
          onCancel={() => setConfirmUpdateAgents(false)}
        />
      )}

      {toastContainer}
    </div>
  );
}
