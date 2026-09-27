import { useState, useEffect } from 'react';
import { CheckCircle2, Loader2, LayoutGrid, Palette, Globe } from 'lucide-react';
import { apiCall } from '../api';
import { AppSettings, CardSize, DashboardView, Theme } from '../types';
import { useI18n } from '../i18n';
import type { Dict } from '../i18n/en';
import { useToast } from './Toast';
import { LanguageOptions } from './LanguageSwitcher';

const THEME_OPTIONS: { value: Theme; labelKey: keyof Dict }[] = [
  { value: 'dark', labelKey: 'settings.themeGlassDark' },
  { value: 'light', labelKey: 'settings.themeGlassLight' },
  { value: 'terminal', labelKey: 'settings.themeTerminal' },
  { value: 'monokai', labelKey: 'settings.themeMonokai' },
];

export default function AppearanceSettings({
  theme,
  onThemeChange,
  onSaved,
}: {
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  onSaved?: () => void;
}) {
  const { t } = useI18n();
  const [dashboardView, setDashboardView] = useState<DashboardView>('grid');
  const [cardSize, setCardSize] = useState<CardSize>('normal');
  const [savingDisplay, setSavingDisplay] = useState(false);
  const { addToast, toastContainer } = useToast();

  useEffect(() => {
    apiCall<AppSettings>('/settings')
      .then((data) => {
        setDashboardView(data.dashboard_view ?? 'grid');
        setCardSize(data.dashboard_card_size ?? 'normal');
      })
      .catch(console.error);
  }, []);

  const handleSaveDisplay = async () => {
    setSavingDisplay(true);
    try {
      await apiCall<AppSettings>('/settings', {
        method: 'PUT',
        body: JSON.stringify({ dashboard_view: dashboardView, dashboard_card_size: cardSize })
      });
      addToast('success', t('settings.displaySaved'));
      onSaved?.();
    } catch (e) {
      addToast('error', t('settings.saveFailed', { message: e instanceof Error ? e.message : t('common.unknownError') }));
    } finally {
      setSavingDisplay(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Theme */}
      <section>
        <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-2">
          <Palette size={14} /> {t('settings.themeTitle')}
        </h4>
        <div className="glass border border-slate-200 dark:border-white/10 rounded-xl p-4 space-y-3">
          <div className="flex flex-wrap gap-2">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => onThemeChange(opt.value)}
                aria-pressed={theme === opt.value}
                className={`px-4 py-2 rounded-lg border text-[11px] font-bold uppercase tracking-wider transition-colors ${
                  theme === opt.value
                    ? 'border-indigo-300/60 dark:border-indigo-500/40 bg-slate-200/80 dark:bg-white/10 text-slate-900 dark:text-white'
                    : 'border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/5 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500">{t('settings.themeNote')}</p>
        </div>
      </section>

      {/* Language */}
      <section>
        <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-2">
          <Globe size={14} /> {t('settings.languageTitle')}
        </h4>
        <div className="glass border border-slate-200 dark:border-white/10 rounded-xl overflow-hidden">
          <LanguageOptions />
        </div>
        <p className="text-xs text-slate-500 mt-2">{t('settings.languageNote')}</p>
      </section>

      {/* Dashboard display */}
      <section>
        <h4 className="text-xs uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-2">
          <LayoutGrid size={14} /> {t('settings.dashboardDisplay')}
        </h4>
        <div className="glass border border-slate-200 dark:border-white/10 rounded-xl p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">{t('settings.viewLabel')}</label>
              <div className="flex items-center glass border border-slate-200 dark:border-white/10 rounded-lg p-0.5 w-fit">
                {([
                  ['grid', 'settings.viewGrid'],
                  ['list', 'settings.viewList'],
                ] as const).map(([v, lk]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setDashboardView(v)}
                    className={`px-3 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-wider transition-colors ${
                      dashboardView === v ? 'bg-slate-200/80 dark:bg-white/10 text-slate-900 dark:text-white' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                    }`}
                  >
                    {t(lk)}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">{t('settings.cardSizeGrid')}</label>
              <div className="flex items-center glass border border-slate-200 dark:border-white/10 rounded-lg p-0.5 w-fit">
                {([
                  ['normal', 'settings.cardNormal'],
                  ['compact', 'settings.cardCompact'],
                  ['minimal', 'settings.cardMinimal'],
                ] as const).map(([s, lk]) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setCardSize(s)}
                    className={`px-3 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-wider transition-colors ${
                      cardSize === s ? 'bg-slate-200/80 dark:bg-white/10 text-slate-900 dark:text-white' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                    }`}
                  >
                    {t(lk)}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <p className="text-xs text-slate-500">{t('settings.storedOnServerNote')}</p>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleSaveDisplay()}
              disabled={savingDisplay}
              className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-lg transition-colors text-sm"
            >
              {savingDisplay ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {t('settings.saveDisplay')}
            </button>
          </div>
        </div>
      </section>

      {toastContainer}
    </div>
  );
}
