import { useState, useEffect, useCallback } from 'react';
import { Zap, CheckCircle2, Loader2, Timer, AlertTriangle } from 'lucide-react';
import { apiCall } from '../api';
import { AppSettings } from '../types';
import { useI18n } from '../i18n';
import { useToast } from './Toast';

export default function MonitoringSettings({ onClose, onSaved }: { onClose?: () => void; onSaved?: () => void }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [costInput, setCostInput] = useState('');
  const [currencyInput, setCurrencyInput] = useState('€');
  const [savingCost, setSavingCost] = useState(false);
  const [agentIntervalInput, setAgentIntervalInput] = useState('');
  const [uiRefreshInput, setUiRefreshInput] = useState('');
  const [savingRefresh, setSavingRefresh] = useState(false);
  const [statsAll, setStatsAll] = useState<Record<string, { agent_interval?: number | null }>>({});
  const { addToast, toastContainer } = useToast();

  const loadStatsAll = useCallback(async () => {
    try {
      const data = await apiCall<Record<string, { agent_interval?: number | null }>>('/devices/stats/all');
      setStatsAll(data);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    loadStatsAll();
    apiCall<AppSettings>('/settings')
      .then((data) => {
        setSettings(data);
        setCostInput(data.cost_per_kwh === null ? '' : String(data.cost_per_kwh));
        setCurrencyInput(data.currency);
        setAgentIntervalInput(data.agent_interval_seconds !== undefined ? String(data.agent_interval_seconds) : '');
        setUiRefreshInput(data.ui_refresh_seconds !== undefined ? String(data.ui_refresh_seconds) : '');
      })
      .catch(console.error);
  }, [loadStatsAll]);

  const handleSaveCost = async () => {
    setSavingCost(true);
    try {
      const body: Record<string, unknown> = { currency: currencyInput.trim() };
      if (costInput.trim() === '') {
        body.cost_per_kwh = null;
      } else {
        const rate = Number.parseFloat(costInput);
        if (!Number.isFinite(rate) || rate < 0) {
          addToast('error', t('settings.invalidCost'));
          return;
        }
        body.cost_per_kwh = rate;
      }
      const data = await apiCall<AppSettings>('/settings', { method: 'PUT', body: JSON.stringify(body) });
      setSettings(data);
      addToast('success', t('settings.costSaved'));
      onSaved?.();
    } catch (e) {
      addToast('error', t('settings.saveFailed', { message: e instanceof Error ? e.message : t('common.unknownError') }));
    } finally {
      setSavingCost(false);
    }
  };

  const handleSaveRefresh = async () => {
    setSavingRefresh(true);
    try {
      const agentIntervalS = Number.parseInt(agentIntervalInput, 10);
      const uiRefreshS = Number.parseInt(uiRefreshInput, 10);
      if (!Number.isInteger(agentIntervalS) || agentIntervalS < 5 || agentIntervalS > 3600) {
        addToast('error', t('settings.invalidAgentInterval'));
        return;
      }
      if (!Number.isInteger(uiRefreshS) || uiRefreshS < 5 || uiRefreshS > 3600) {
        addToast('error', t('settings.invalidWebRefresh'));
        return;
      }
      const body: Record<string, unknown> = { agent_interval_seconds: agentIntervalS, ui_refresh_seconds: uiRefreshS };
      const data = await apiCall<AppSettings>('/settings', { method: 'PUT', body: JSON.stringify(body) });
      setSettings(data);
      addToast('success', t('settings.refreshSaved'));
      loadStatsAll();
      onSaved?.();
    } catch (e) {
      addToast('error', t('settings.saveFailed', { message: e instanceof Error ? e.message : t('common.unknownError') }));
    } finally {
      setSavingRefresh(false);
    }
  };

  const configuredAgentInterval = settings?.agent_interval_seconds;
  const outdatedAgents =
    configuredAgentInterval === undefined
      ? 0
      : Object.values(statsAll)
          .filter(
            (s: { agent_interval?: number | null }) =>
              s.agent_interval !== undefined && s.agent_interval !== null && s.agent_interval !== configuredAgentInterval
          )
          .length;

  return (
    <div className="space-y-8">
      {/* Data refresh */}
      <section>
        <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-2">
          <Timer size={14} /> {t('settings.dataRefresh')}
        </h4>
        <div className="glass border border-slate-200 dark:border-white/10 rounded-xl p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('settings.agentIntervalLabel')}</label>
              <input
                type="number"
                min={5}
                max={3600}
                step={1}
                value={agentIntervalInput}
                onChange={(e) => setAgentIntervalInput(e.target.value)}
                placeholder="30"
                className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('settings.webRefreshLabel')}</label>
              <input
                type="number"
                min={5}
                max={3600}
                step={1}
                value={uiRefreshInput}
                onChange={(e) => setUiRefreshInput(e.target.value)}
                placeholder="30"
                className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          </div>
          {outdatedAgents > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
              <AlertTriangle size={12} />
              {t('settings.staleAgentsWarning', { n: outdatedAgents, plural: outdatedAgents > 1 ? 's' : '' })}
            </p>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSaveRefresh}
              disabled={savingRefresh}
              className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-lg transition-colors text-sm"
            >
              {savingRefresh ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {t('settings.saveRefreshIntervals')}
            </button>
          </div>
        </div>
      </section>

      {/* Electricity cost */}
      <section className="pb-1">
        <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-2">
          <Zap size={14} /> {t('settings.electricityCost')}
        </h4>
        <div className="glass border border-slate-200 dark:border-white/10 rounded-xl p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px] gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('settings.costPerKwh')}</label>
              <input
                type="number"
                min={0}
                step={0.01}
                value={costInput}
                onChange={(e) => setCostInput(e.target.value)}
                placeholder="0.25"
                className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('settings.currency')}</label>
              <input
                type="text"
                maxLength={8}
                value={currencyInput}
                onChange={(e) => setCurrencyInput(e.target.value)}
                placeholder="€"
                className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          </div>
          {settings?.cost_per_kwh === null && (
            <p className="text-xs text-slate-500 flex items-center gap-1.5">{t('settings.noRateConfigured')}</p>
          )}
          <div className="flex justify-end gap-3">
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                disabled={savingCost}
                className="bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 text-slate-700 dark:text-slate-300 font-medium px-4 py-2 rounded-lg transition-colors text-sm"
              >
                {t('common.close')}
              </button>
            )}
            <button
              type="button"
              onClick={handleSaveCost}
              disabled={savingCost}
              className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-lg transition-colors text-sm"
            >
              {savingCost ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {t('settings.saveCost')}
            </button>
          </div>
        </div>
      </section>

      {toastContainer}
    </div>
  );
}
