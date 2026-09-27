import { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { apiCall, ApiError } from '../api';
import { useI18n } from '../i18n';
import { useToast } from './Toast';

export default function SecuritySetup() {
  const { t } = useI18n();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const { addToast, toastContainer } = useToast();

  const submit = async () => {
    if (!current || !next) return;
    if (next !== confirm) {
      addToast('error', t('pwd.mismatch'));
      return;
    }
    setBusy(true);
    try {
      await apiCall('/change-password', {
        method: 'POST',
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      addToast('success', t('pwd.changed'));
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (e) {
      addToast('error', e instanceof ApiError ? e.message : t('pwd.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <section>
        <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-2">
          <KeyRound size={14} /> {t('pwd.title')}
        </h4>
        <div className="glass border border-slate-200 dark:border-white/10 rounded-xl p-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('pwd.currentPassword')}</label>
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              placeholder={t('pwd.phCurrent')}
              className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('pwd.newPassword')}</label>
              <input
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                placeholder={t('pwd.phNew')}
                className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('pwd.confirmNewPassword')}</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={t('pwd.phConfirm')}
                className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !current || !next}
              className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-lg transition-colors text-sm"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
              {busy ? t('pwd.changing') : t('nav.changePassword')}
            </button>
          </div>
        </div>
      </section>

      {toastContainer}
    </div>
  );
}
