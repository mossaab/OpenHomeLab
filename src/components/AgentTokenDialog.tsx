import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Copy, KeyRound, Loader2, Server, X, DownloadCloud, RefreshCw, Monitor } from 'lucide-react';
import { apiCall } from '../api';
import { compareAgentVersions } from '../actionLabel';
import { formatAgo } from '../relativeTime';
import { Device } from '../types';
import Modal from './Modal';
import ConfirmDialog from './ConfirmDialog';
import { useToast } from './Toast';
import { useI18n } from '../i18n';

const STATE_CLS: Record<'online' | 'stale' | 'none', string> = {
  online: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
  stale: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/20',
  none: 'bg-slate-100/70 dark:bg-white/5 text-slate-500 border-slate-200 dark:border-white/10',
};

const STATE_KEY = {
  online: 'atoken.stateOnline',
  stale: 'atoken.stateStale',
  none: 'atoken.stateNone',
} as const;

export default function AgentTokenDialog({
  device,
  agentState,
  lastSeen,
  reportedVersion,
  servedVersion,
  onClose,
  onUpdated,
}: {
  device: Device;
  agentState: 'none' | 'online' | 'stale';
  lastSeen: number | null;
  reportedVersion: string | null;
  servedVersion: string | null;
  onClose: () => void;
  onUpdated?: () => void;
}) {
  const { t } = useI18n();
  const [token, setToken] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [confirmReinstall, setConfirmReinstall] = useState(false);
  const [reinstalling, setReinstalling] = useState(false);
  const [reinstallFailed, setReinstallFailed] = useState(false);
  const { addToast, toastContainer } = useToast();

  const serverUrl = window.location.origin;
  const installCommand = token ? `curl -fsS ${serverUrl}/api/agent/install | sh -s -- ${serverUrl} ${token}` : '';
  const outdated = !!reportedVersion && !!servedVersion && compareAgentVersions(reportedVersion, servedVersion) < 0;

  const handleCopy = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      addToast('success', t('atoken.copiedToast'));
    } catch {
      addToast('error', t('atoken.copyFailedToast'));
    }
  };

  const handleRotate = async () => {
    setRotating(true);
    try {
      const data = await apiCall<{ token: string }>(`/devices/${device.id}/agent/token`, { method: 'POST' });
      setToken(data.token);
      setReinstallFailed(false);
      addToast('success', device.has_agent_token ? t('atoken.rotatedToast') : t('atoken.generatedToast'));
      onUpdated?.();
    } catch (e) {
      addToast('error', t('atoken.rotateFailed', { message: e instanceof Error ? e.message : t('common.unknownError') }));
    } finally {
      setRotating(false);
    }
  };

  const handleUpdate = async () => {
    setUpdating(true);
    try {
      await apiCall(`/devices/${device.id}/command`, { method: 'POST', body: JSON.stringify({ action: 'update' }) });
      addToast('success', t('action.updateQueued'));
      setConfirmUpdate(false);
      onUpdated?.();
    } catch (e) {
      addToast('error', t('atoken.updateFailed', { message: e instanceof Error ? e.message : t('common.unknownError') }));
    } finally {
      setUpdating(false);
    }
  };

  const handleReinstall = async () => {
    setReinstalling(true);
    try {
      await apiCall(`/devices/${device.id}/agent/reinstall`, { method: 'POST' });
      addToast('success', t('atoken.reinstalledToast'));
      setConfirmReinstall(false);
      onUpdated?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('common.unknownError');
      addToast('error', t('atoken.reinstallFailed', { message: msg }));
      setReinstallFailed(true);
    } finally {
      setReinstalling(false);
    }
  };

  return (
    <>
      <Modal onBackdropClick={onClose} className="w-full sm:max-w-lg max-h-[92dvh] sm:max-h-[85vh] overflow-y-auto custom-scrollbar rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl border-b sm:border border-slate-200 dark:border-white/10">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-medium text-slate-800 dark:text-slate-200 flex items-center gap-2 min-w-0">
            <KeyRound size={18} className="text-indigo-600 dark:text-indigo-400 shrink-0" />
            <span className="truncate">{t('atoken.title', { name: device.name })}</span>
          </h3>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-300 transition-colors p-1 rounded-lg hover:bg-slate-200/70 dark:hover:bg-white/10"
            aria-label={t('atoken.closeDialog')}
          >
            <X size={20} />
          </button>
        </div>

        <div className="space-y-5">
          <section className="glass border border-slate-200 dark:border-white/10 rounded-xl p-4 space-y-3">
            <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-2">
              <Server size={14} /> {t('atoken.onMachine')}
            </h4>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="text-slate-500 mb-1">{t('atoken.status')}</div>
                <span className={`inline-flex px-2.5 py-1 rounded-md text-xs font-bold border ${STATE_CLS[agentState]}`}>
                  {t(STATE_KEY[agentState])}
                </span>
              </div>
              <div>
                <div className="text-slate-500 mb-1">{t('atoken.version')}</div>
                {reportedVersion ? (
                  <div className="font-mono text-slate-800 dark:text-slate-200">
                    v{reportedVersion}
                    {outdated && servedVersion && (
                      <span className="ms-2 text-[10px] font-bold uppercase text-amber-600 dark:text-amber-400">
                        {t('atoken.serverVersion', { v: servedVersion })}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="text-slate-500">{servedVersion ? t('atoken.serverVersion', { v: servedVersion }) : t('atoken.unknown')}</div>
                )}
              </div>
              <div>
                <div className="text-slate-500 mb-1">{t('atoken.lastSeen')}</div>
                <div className="text-slate-800 dark:text-slate-200">{lastSeen ? formatAgo(lastSeen, t) : t('atoken.never')}</div>
              </div>
              <div>
                <div className="text-slate-500 mb-1">{t('atoken.os')}</div>
                <div className="text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                  {device.os_name || device.os_family ? (
                    <>
                      <Monitor size={12} className="text-slate-400" />
                      {device.os_name ?? device.os_family}
                    </>
                  ) : (
                    t('atoken.unknown')
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="glass border border-slate-200 dark:border-white/10 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-2">
                <KeyRound size={14} /> {t('atoken.tokenSection')}
              </h4>
              <span
                className={`px-2.5 py-1 rounded-md text-xs font-bold ${
                  device.has_agent_token
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                    : 'bg-slate-100/70 dark:bg-white/5 text-slate-500 border border-slate-200 dark:border-white/10'
                }`}
              >
                {device.has_agent_token ? t('atoken.tokenActive') : t('atoken.noToken')}
              </span>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => void handleRotate()}
                disabled={rotating}
                className="flex items-center gap-2 px-3 py-1.5 glass hover:bg-indigo-500/20 rounded-lg text-xs font-bold text-indigo-600 dark:text-indigo-400 transition-colors disabled:opacity-50"
              >
                {rotating ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
                {device.has_agent_token ? t('atoken.rotate') : t('atoken.generate')}
              </button>
              <button
                onClick={() => setConfirmUpdate(true)}
                disabled={agentState !== 'online' || updating}
                title={agentState !== 'online' ? t('atoken.updateTitle') : undefined}
                className="flex items-center gap-2 px-3 py-1.5 glass hover:bg-indigo-500/20 rounded-lg text-xs font-bold text-indigo-600 dark:text-indigo-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <DownloadCloud size={14} /> {t('atoken.updateOnMachine')}
              </button>
              <button
                onClick={() => setConfirmReinstall(true)}
                disabled={!device.profile_id || reinstalling}
                title={!device.profile_id ? t('atoken.reinstallTitle') : undefined}
                className="flex items-center gap-2 px-3 py-1.5 glass hover:bg-indigo-500/20 rounded-lg text-xs font-bold text-indigo-600 dark:text-indigo-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RefreshCw size={14} /> {t('atoken.reinstallViaSsh')}
              </button>
            </div>
            {agentState !== 'online' && (
              <p className="text-xs text-slate-500">{t('atoken.updateHint')}</p>
            )}
            {!device.profile_id && (
              <p className="text-xs text-slate-500">{t('atoken.reinstallHint')}</p>
            )}
            {reinstallFailed && !token && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-rose-500/20 bg-rose-500/[0.06] px-3 py-2.5">
                <p className="text-xs text-rose-700 dark:text-rose-300">
                  {t('atoken.reinstallFailedBanner')}
                </p>
                <button
                  onClick={() => void handleRotate()}
                  disabled={rotating}
                  className="shrink-0 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/20 text-xs font-bold text-rose-700 dark:text-rose-300 transition-colors disabled:opacity-50"
                >
                  {rotating ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
                  {t('atoken.getNewCommand')}
                </button>
              </div>
            )}

            <AnimatePresence>
              {token && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <p className="text-xs text-amber-600 dark:text-amber-400/90 mb-2">
                    {t('atoken.commandOnceNote')}
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 bg-black/40 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-xs text-emerald-300 font-mono overflow-x-auto whitespace-nowrap">
                      {installCommand}
                    </code>
                    <button
                      onClick={() => void handleCopy(installCommand)}
                      className="p-2.5 glass hover:bg-slate-200/70 dark:hover:bg-white/10 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 transition-colors shrink-0"
                      title={t('atoken.copyCommand')}
                    >
                      <Copy size={16} />
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        </div>
      </Modal>

      {confirmUpdate && (
        <ConfirmDialog
          title={t('atoken.updateConfirmTitle', { name: device.name })}
          message={t('atoken.updateConfirmMessage')}
          confirmLabel={t('common.update')}
          loading={updating}
          onConfirm={() => void handleUpdate()}
          onCancel={() => setConfirmUpdate(false)}
        />
      )}
      {confirmReinstall && (
        <ConfirmDialog
          title={t('atoken.reinstallConfirmTitle', { name: device.name })}
          message={t('atoken.reinstallConfirmMessage')}
          confirmLabel={t('atoken.reinstallConfirmBtn')}
          loading={reinstalling}
          onConfirm={() => void handleReinstall()}
          onCancel={() => setConfirmReinstall(false)}
        />
      )}
      {toastContainer}
    </>
  );
}
