import { useState } from 'react';
import { Globe, Lock, Palette, LayoutGrid, KeyRound, Zap, Loader2, Check, ArrowLeft, ArrowRight } from 'lucide-react';
import { apiCall } from '../api';
import type { Theme, DashboardView, CardSize } from '../types';
import { POWER_OFF_ACTIONS, REBOOT_ACTIONS, HIBERNATE_ACTIONS } from '../types';
import { DEFAULT_POWER_OFF_ACTION, DEFAULT_REBOOT_ACTION, DEFAULT_HIBERNATE_ACTION } from '../powerActions';
import { useI18n } from '../i18n/index';
import type { Dict } from '../i18n/en';
import { LanguageOptions } from './LanguageSwitcher';

type StepId = 'language' | 'password' | 'theme' | 'dashboard' | 'ssh' | 'power';

const STEPS: { id: StepId; icon: typeof Globe }[] = [
  { id: 'language', icon: Globe },
  { id: 'password', icon: Lock },
  { id: 'theme', icon: Palette },
  { id: 'dashboard', icon: LayoutGrid },
  { id: 'ssh', icon: KeyRound },
  { id: 'power', icon: Zap },
];

const THEME_OPTIONS: { value: Theme; labelKey: keyof Dict; box: string; sample: string }[] = [
  { value: 'dark', labelKey: 'settings.themeGlassDark', box: 'bg-slate-900 border-white/15', sample: 'text-slate-100' },
  { value: 'light', labelKey: 'settings.themeGlassLight', box: 'bg-white border-slate-300', sample: 'text-slate-800' },
  { value: 'terminal', labelKey: 'settings.themeTerminal', box: 'bg-stone-950 border-amber-500/40', sample: 'text-amber-400 font-mono' },
  { value: 'monokai', labelKey: 'settings.themeMonokai', box: 'bg-[#272822] border-emerald-500/50', sample: 'text-lime-300' },
];

const MOCK_DEVICES = [
  { name: 'Router', ip: '192.168.1.1', online: true, watts: 12 },
  { name: 'NAS', ip: '192.168.1.10', online: true, watts: 45 },
  { name: 'Gaming PC', ip: '192.168.1.42', online: false, watts: 0 },
  { name: 'Camera', ip: '192.168.1.7', online: true, watts: 5 },
];

function StatusDot({ online }: { online: boolean }) {
  return (
    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${online ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`} />
  );
}

function DemoDashboard({ view, cardSize }: { view: DashboardView; cardSize: CardSize }) {
  if (view === 'list') {
    return (
      <div className="space-y-1">
        {MOCK_DEVICES.map((d) => (
          <div
            key={d.name}
            className={`flex items-center gap-2 rounded-md border border-slate-200 dark:border-white/10 px-3 ${
              cardSize === 'normal' ? 'py-2.5' : cardSize === 'compact' ? 'py-2' : 'py-1'
            }`}
          >
            <StatusDot online={d.online} />
            <span className={`font-medium text-slate-800 dark:text-slate-200 ${cardSize === 'minimal' ? 'text-[11px]' : 'text-xs'}`}>
              {d.name}
            </span>
            <span className="hidden sm:inline text-[11px] font-mono text-slate-400 dark:text-slate-500">{d.ip}</span>
            <span className="ms-auto text-[11px] text-slate-500 dark:text-slate-400">{d.online ? `${d.watts} W` : '—'}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={`grid gap-1.5 ${cardSize === 'normal' ? 'grid-cols-2' : 'grid-cols-4'}`}>
      {MOCK_DEVICES.map((d) => (
        <div
          key={d.name}
          className={`rounded-md border border-slate-200 dark:border-white/10 ${cardSize === 'normal' ? 'p-3 space-y-1' : 'p-2 space-y-0.5'}`}
        >
          <div className="flex items-center gap-1.5">
            <StatusDot online={d.online} />
            <span className={`truncate font-medium text-slate-800 dark:text-slate-200 ${cardSize === 'normal' ? 'text-xs' : 'text-[11px]'}`}>
              {d.name}
            </span>
          </div>
          {cardSize !== 'minimal' && (
            <>
              <p className="text-[11px] font-mono text-slate-400 dark:text-slate-500">{d.ip}</p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">{d.online ? `${d.watts} W` : '—'}</p>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

const INPUT_CLS =
  'w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500';
const LABEL_CLS = 'block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5';
const SEG_BTN = (active: boolean) =>
  `px-3 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-wider transition-colors ${
    active ? 'bg-slate-200/80 dark:bg-white/10 text-slate-900 dark:text-white' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
  }`;

export default function SetupWizard({ theme, onThemeChange, onFinish }: { theme: Theme; onThemeChange: (t: Theme) => void; onFinish: () => void }) {
  const { t } = useI18n();
  const [stepIndex, setStepIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const [view, setView] = useState<DashboardView>('grid');
  const [cardSize, setCardSize] = useState<CardSize>('normal');

  const [addProfile, setAddProfile] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profile, setProfile] = useState({ name: '', username: 'root', auth_type: 'password' as 'password' | 'key', password: '', private_key: '' });

  const [poweroffAction, setPoweroffAction] = useState(DEFAULT_POWER_OFF_ACTION);
  const [rebootAction, setRebootAction] = useState(DEFAULT_REBOOT_ACTION);
  const [hibernateAction, setHibernateAction] = useState(DEFAULT_HIBERNATE_ACTION);
  const [costInput, setCostInput] = useState('');
  const [currencyInput, setCurrencyInput] = useState('€');

  const step = STEPS[stepIndex].id;
  const isLast = stepIndex === STEPS.length - 1;
  const canGoBack = stepIndex === 1 || stepIndex >= 3;
  const canSkip = stepIndex >= 2 && !isLast;

  const errMessage = (e: unknown) => (e instanceof Error && e.message ? e.message : t('common.unknownError'));

  const validateProfile = () => {
    if (!profile.name.trim() || !profile.username.trim()) {
      setError(t('wizard.requiredField'));
      return false;
    }
    if ((profile.auth_type === 'password' && !profile.password) || (profile.auth_type === 'key' && !profile.private_key)) {
      setError(t('wizard.requiredField'));
      return false;
    }
    return true;
  };

  const persistCurrentStep = async () => {
    if (step === 'dashboard') {
      try {
        await apiCall('/settings', { method: 'PUT', body: JSON.stringify({ dashboard_view: view, dashboard_card_size: cardSize }) });
        return true;
      } catch (e) {
        setError(errMessage(e));
        return false;
      }
    }
    if (step === 'ssh' && addProfile && !profileSaved) {
      if (!validateProfile()) return false;
      try {
        const body: Record<string, unknown> = {
          name: profile.name.trim(),
          username: profile.username.trim(),
          auth_type: profile.auth_type,
        };
        if (profile.auth_type === 'password') body.password = profile.password;
        else body.private_key = profile.private_key;
        await apiCall('/profiles', { method: 'POST', body: JSON.stringify(body) });
        setProfileSaved(true);
        return true;
      } catch (e) {
        setError(errMessage(e));
        return false;
      }
    }
    return true;
  };

  const skipRest = async () => {
    if (busy) return;
    setBusy(true);
    if (await persistCurrentStep()) onFinish();
    setBusy(false);
  };

  const goNext = async () => {
    if (busy) return;
    setError('');
    if (step === 'password') {
      if (password.length < 8) {
        setError(t('wizard.passwordTooShort'));
        return;
      }
      if (password !== confirm) {
        setError(t('wizard.passwordMismatch'));
        return;
      }
      setBusy(true);
      try {
        const { token } = await apiCall('/setup', { method: 'POST', body: JSON.stringify({ password }) });
        localStorage.setItem('auth_token', token);
        setStepIndex(2);
      } catch (e) {
        setError(errMessage(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (step === 'dashboard' || step === 'ssh') {
      setBusy(true);
      if (await persistCurrentStep()) setStepIndex(stepIndex + 1);
      setBusy(false);
      return;
    }
    if (step === 'power') {
      let cost: number | null = null;
      if (costInput.trim() !== '') {
        const parsed = Number.parseFloat(costInput);
        if (!Number.isFinite(parsed) || parsed < 0) {
          setError(t('settings.invalidCost'));
          return;
        }
        cost = parsed;
      }
      setBusy(true);
      try {
        await apiCall('/settings', {
          method: 'PUT',
          body: JSON.stringify({
            poweroff_action: poweroffAction,
            reboot_action: rebootAction,
            hibernate_action: hibernateAction,
            cost_per_kwh: cost,
            currency: currencyInput.trim(),
          }),
        });
        onFinish();
      } catch (e) {
        setError(errMessage(e));
        setBusy(false);
      }
      return;
    }
    setStepIndex(stepIndex + 1);
  };

  const goBack = () => {
    if (canGoBack && !busy) {
      setError('');
      setStepIndex((i) => i - 1);
    }
  };

  return (
    <div className="min-h-dvh mesh-gradient flex items-center justify-center p-4 text-slate-900 dark:text-slate-100">
      <div className="w-full max-w-2xl glass-card rounded-2xl shadow-2xl border border-slate-200 dark:border-white/10 p-6 md:p-8">
        <div className="flex items-center gap-4 mb-6">
          <img src="/logo.svg" alt="OpenHomeLab" className="w-12 h-12 rounded-xl shadow-lg shadow-amber-500/30" />
          <div>
            <h1 className="text-xl font-bold tracking-tight">{t('wizard.title')}</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('wizard.subtitle')}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 mb-6">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            const state = i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'todo';
            return (
              <div
                key={s.id}
                className={`w-8 h-8 rounded-lg flex items-center justify-center border ${
                  state === 'current'
                    ? 'border-indigo-400 bg-indigo-500/15 text-indigo-600 dark:text-indigo-300'
                    : state === 'done'
                      ? 'bg-indigo-600 border-indigo-600 text-white'
                      : 'border-slate-200 dark:border-white/10 text-slate-400 dark:text-slate-500'
                }`}
              >
                {state === 'done' ? <Check size={15} /> : <Icon size={15} />}
              </div>
            );
          })}
          <span className="ms-auto text-xs text-slate-500 dark:text-slate-400">{t('wizard.stepOf', { n: stepIndex + 1, m: STEPS.length })}</span>
        </div>

        <div className="min-h-[280px]">
          {step === 'language' && (
            <div>
              <h2 className="font-semibold text-base mb-1">{t('wizard.languageTitle')}</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">{t('wizard.languageSubtitle')}</p>
              <div className="glass border border-slate-200 dark:border-white/10 rounded-xl overflow-hidden max-w-xs">
                <LanguageOptions />
              </div>
            </div>
          )}

          {step === 'password' && (
            <div>
              <h2 className="font-semibold text-base mb-1">{t('wizard.passwordTitle')}</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">{t('wizard.passwordSubtitle')}</p>
              <div className="space-y-3 max-w-sm">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void goNext()}
                  placeholder={t('auth.passwordPlaceholder')}
                  className={INPUT_CLS}
                />
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void goNext()}
                  placeholder={t('wizard.confirmPassword')}
                  className={INPUT_CLS}
                />
              </div>
            </div>
          )}

          {step === 'theme' && (
            <div>
              <h2 className="font-semibold text-base mb-1">{t('wizard.themeTitle')}</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">{t('wizard.themeSubtitle')}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {THEME_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => onThemeChange(opt.value)}
                    aria-pressed={theme === opt.value}
                    className={`rounded-xl border p-2 transition-colors text-start ${
                      theme === opt.value ? 'border-indigo-400 ring-2 ring-indigo-500/40' : 'border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/25'
                    }`}
                  >
                    <div className={`rounded-lg border px-3 py-2.5 mb-2 ${opt.box}`}>
                      <p className={`text-[11px] font-medium ${opt.sample}`}>{'>'} openhomelab</p>
                      <p className={`text-[10px] opacity-80 ${opt.sample}`}>{'3/4 online · 62 W'}</p>
                    </div>
                    <span className="block text-xs font-medium text-slate-700 dark:text-slate-300">{t(opt.labelKey)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 'dashboard' && (
            <div>
              <h2 className="font-semibold text-base mb-1">{t('wizard.dashboardTitle')}</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">{t('wizard.dashboardSubtitle')}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                <div>
                  <span className={LABEL_CLS}>{t('settings.viewLabel')}</span>
                  <div className="flex items-center glass border border-slate-200 dark:border-white/10 rounded-lg p-0.5 w-fit">
                    {([['grid', 'settings.viewGrid'], ['list', 'settings.viewList']] as const).map(([v, lk]) => (
                      <button key={v} type="button" onClick={() => setView(v)} className={SEG_BTN(view === v)}>
                        {t(lk)}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <span className={LABEL_CLS}>{t('settings.cardSizeGrid')}</span>
                  <div className="flex items-center glass border border-slate-200 dark:border-white/10 rounded-lg p-0.5 w-fit">
                    {([['normal', 'settings.cardNormal'], ['compact', 'settings.cardCompact'], ['minimal', 'settings.cardMinimal']] as const).map(
                      ([s, lk]) => (
                        <button key={s} type="button" onClick={() => setCardSize(s)} className={SEG_BTN(cardSize === s)}>
                          {t(lk)}
                        </button>
                      )
                    )}
                  </div>
                </div>
              </div>
              <span className={LABEL_CLS}>{t('wizard.previewDemo')}</span>
              <div className="glass border border-slate-200 dark:border-white/10 rounded-xl p-3">
                <DemoDashboard view={view} cardSize={cardSize} />
              </div>
            </div>
          )}

          {step === 'ssh' && (
            <div>
              <h2 className="font-semibold text-base mb-1">{t('wizard.sshTitle')}</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">{t('wizard.sshSubtitle')}</p>
              <label className="flex items-center gap-2.5 text-sm cursor-pointer select-none mb-4">
                <input
                  type="checkbox"
                  checked={addProfile}
                  onChange={(e) => setAddProfile(e.target.checked)}
                  className="w-4 h-4 rounded accent-indigo-600"
                />
                {t('wizard.addProfileNow')}
              </label>
              {addProfile && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-lg">
                  <div>
                    <label className={LABEL_CLS}>{t('profiles.name')}</label>
                    <input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} placeholder={t('profiles.namePlaceholder')} className={INPUT_CLS} />
                  </div>
                  <div>
                    <label className={LABEL_CLS}>{t('profiles.username')}</label>
                    <input value={profile.username} onChange={(e) => setProfile({ ...profile, username: e.target.value })} placeholder={t('profiles.usernamePlaceholder')} className={INPUT_CLS} />
                  </div>
                  <div>
                    <label className={LABEL_CLS}>{t('profiles.method')}</label>
                    <select
                      value={profile.auth_type}
                      onChange={(e) => setProfile({ ...profile, auth_type: e.target.value as 'password' | 'key' })}
                      className={`${INPUT_CLS} [&>option]:bg-white dark:[&>option]:bg-slate-900`}
                    >
                      <option value="password">{t('profiles.authPassword')}</option>
                      <option value="key">{t('profiles.authKey')}</option>
                    </select>
                  </div>
                  {profile.auth_type === 'password' ? (
                    <div>
                      <label className={LABEL_CLS}>{t('profiles.password')}</label>
                      <input type="password" value={profile.password} onChange={(e) => setProfile({ ...profile, password: e.target.value })} className={INPUT_CLS} />
                    </div>
                  ) : (
                    <div className="sm:col-span-2">
                      <label className={LABEL_CLS}>{t('profiles.privateKey')}</label>
                      <textarea rows={3} value={profile.private_key} onChange={(e) => setProfile({ ...profile, private_key: e.target.value })} placeholder={'-----BEGIN RSA PRIVATE KEY-----...'} className={`${INPUT_CLS} font-mono text-xs`} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {step === 'power' && (
            <div>
              <h2 className="font-semibold text-base mb-1">{t('wizard.powerTitle')}</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">{t('wizard.powerSubtitle')}</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                <div>
                  <label className={LABEL_CLS}>{t('settings.powerOffCommand')}</label>
                  <select value={poweroffAction} onChange={(e) => setPoweroffAction(e.target.value)} className={INPUT_CLS}>
                    {POWER_OFF_ACTIONS.map((a) => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={LABEL_CLS}>{t('settings.rebootCommand')}</label>
                  <select value={rebootAction} onChange={(e) => setRebootAction(e.target.value)} className={INPUT_CLS}>
                    {REBOOT_ACTIONS.map((a) => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={LABEL_CLS}>{t('settings.hibernateCommand')}</label>
                  <select value={hibernateAction} onChange={(e) => setHibernateAction(e.target.value)} className={INPUT_CLS}>
                    {HIBERNATE_ACTIONS.map((a) => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px] gap-3 max-w-md">
                <div>
                  <label className={LABEL_CLS}>{t('settings.costPerKwh')}</label>
                  <input type="number" min={0} step={0.01} value={costInput} onChange={(e) => setCostInput(e.target.value)} placeholder="0.25" className={INPUT_CLS} />
                </div>
                <div>
                  <label className={LABEL_CLS}>{t('settings.currency')}</label>
                  <input type="text" maxLength={8} value={currencyInput} onChange={(e) => setCurrencyInput(e.target.value)} placeholder="€" className={INPUT_CLS} />
                </div>
              </div>
            </div>
          )}
        </div>

        {error && <p className="text-red-600 dark:text-red-400 text-sm mt-3">{error}</p>}

        <div className="flex items-center gap-3 mt-6">
          {canGoBack && (
            <button type="button" onClick={goBack} disabled={busy} className="flex items-center gap-2 bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 text-slate-700 dark:text-slate-300 font-medium px-4 py-2 rounded-lg transition-colors text-sm disabled:opacity-50">
              <ArrowLeft size={16} />
              {t('wizard.back')}
            </button>
          )}
          <div className="ms-auto flex items-center gap-3">
            {canSkip && (
              <button type="button" onClick={() => void skipRest()} disabled={busy} className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors disabled:opacity-50">
                {t('wizard.skip')}
              </button>
            )}
            <button
              type="button"
              onClick={() => void goNext()}
              disabled={busy}
              className="flex items-center justify-center gap-2 min-w-[130px] bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-lg transition-colors text-sm"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : isLast ? t('wizard.finish') : t('wizard.next')}
              {!isLast && !busy && <ArrowRight size={16} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
