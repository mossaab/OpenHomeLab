import { useState, useEffect } from 'react';
import { CheckCircle2, Loader2, Power } from 'lucide-react';
import { apiCall } from '../api';
import { AppSettings, POWER_OFF_ACTIONS, REBOOT_ACTIONS, HIBERNATE_ACTIONS } from '../types';
import { useI18n } from '../i18n';
import { useToast } from './Toast';

export default function PowerSettings({ onSaved }: { onSaved?: () => void }) {
  const { t } = useI18n();
  const [poweroffAction, setPoweroffAction] = useState('poweroff');
  const [rebootAction, setRebootAction] = useState('reboot');
  const [hibernateAction, setHibernateAction] = useState('systemctl hibernate');
  const [savingActions, setSavingActions] = useState(false);
  const { addToast, toastContainer } = useToast();

  useEffect(() => {
    apiCall<AppSettings>('/settings')
      .then((data) => {
        setPoweroffAction(data.poweroff_action);
        setRebootAction(data.reboot_action);
        setHibernateAction(data.hibernate_action);
      })
      .catch(console.error);
  }, []);

  const handleSaveActions = async () => {
    setSavingActions(true);
    try {
      await apiCall<AppSettings>('/settings', {
        method: 'PUT',
        body: JSON.stringify({ poweroff_action: poweroffAction, reboot_action: rebootAction, hibernate_action: hibernateAction })
      });
      addToast('success', t('settings.actionsSaved'));
      onSaved?.();
    } catch (e) {
      addToast('error', t('settings.saveFailed', { message: e instanceof Error ? e.message : t('common.unknownError') }));
    } finally {
      setSavingActions(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Power actions */}
      <section>
        <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-2">
          <Power size={14} /> {t('settings.powerActions')}
        </h4>
        <div className="glass border border-slate-200 dark:border-white/10 rounded-xl p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">{t('settings.powerOffCommand')}</label>
              <select
                value={poweroffAction}
                onChange={(e) => setPoweroffAction(e.target.value)}
                className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                {POWER_OFF_ACTIONS.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">{t('settings.rebootCommand')}</label>
              <select
                value={rebootAction}
                onChange={(e) => setRebootAction(e.target.value)}
                className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                {REBOOT_ACTIONS.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">{t('settings.hibernateCommand')}</label>
              <select
                value={hibernateAction}
                onChange={(e) => setHibernateAction(e.target.value)}
                className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                {HIBERNATE_ACTIONS.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-xs text-slate-500">{t('settings.actionsNote')}</p>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleSaveActions()}
              disabled={savingActions}
              className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-lg transition-colors text-sm"
            >
              {savingActions ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {t('settings.saveActions')}
            </button>
          </div>
        </div>
      </section>

      {toastContainer}
    </div>
  );
}
