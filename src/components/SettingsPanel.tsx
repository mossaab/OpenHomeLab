import { useState } from 'react';
import { Settings2, Terminal, Download, Plug, Palette, Zap, Power, KeyRound } from 'lucide-react';
import { useI18n } from '../i18n';
import type { Dict } from '../i18n/en';
import type { Theme } from '../types';
import AppearanceSettings from './AppearanceSettings';
import MonitoringSettings from './MonitoringSettings';
import PowerSettings from './PowerSettings';
import ProfilesSetup from './ProfilesSetup';
import SecuritySetup from './SecuritySetup';
import DataImportExport from './DataImportExport';
import ApiTokensSetup from './ApiTokensSetup';

type SettingsTab = 'appearance' | 'monitoring' | 'power' | 'security' | 'profiles' | 'api' | 'data';

const SETTINGS_TABS: { id: SettingsTab; labelKey: keyof Dict; icon: typeof Settings2 }[] = [
  { id: 'appearance', labelKey: 'settings.tabAppearance', icon: Palette },
  { id: 'monitoring', labelKey: 'settings.tabMonitoring', icon: Zap },
  { id: 'power', labelKey: 'settings.tabPower', icon: Power },
  { id: 'security', labelKey: 'settings.tabSecurity', icon: KeyRound },
  { id: 'profiles', labelKey: 'settings.tabProfiles', icon: Terminal },
  { id: 'api', labelKey: 'settings.tabTokens', icon: Plug },
  { id: 'data', labelKey: 'settings.tabData', icon: Download },
];

export default function SettingsPanel({ theme, onThemeChange, onClose, onSaved }: { theme: Theme; onThemeChange: (t: Theme) => void; onClose?: () => void; onSaved?: () => void }) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance');

  return (
    <div className="flex flex-col md:flex-row h-full min-h-0">
      <nav className="grid grid-cols-2 md:grid-cols-1 content-start gap-1 p-3 border-b md:border-b-0 md:border-e border-slate-200 dark:border-white/10 shrink-0 md:w-52">
        {SETTINGS_TABS.map((tab, i) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors ${i === SETTINGS_TABS.length - 1 ? 'col-span-2 md:col-span-1' : ''} ${
                activeTab === tab.id
                  ? 'border-slate-200 dark:border-white/10 bg-slate-100 dark:bg-white/10 text-white'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/5 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Icon size={16} className="shrink-0" />
              <span className="font-medium">{t(tab.labelKey)}</span>
            </button>
          );
        })}
      </nav>

      <div className="overflow-y-auto custom-scrollbar px-4 md:px-6 py-5 flex-1 min-h-0">
        {activeTab === 'appearance' && <AppearanceSettings theme={theme} onThemeChange={onThemeChange} onSaved={onSaved} />}
        {activeTab === 'monitoring' && <MonitoringSettings onClose={onClose} onSaved={onSaved} />}
        {activeTab === 'power' && <PowerSettings onSaved={onSaved} />}
        {activeTab === 'security' && <SecuritySetup />}
        {activeTab === 'profiles' && <ProfilesSetup embedded />}
        {activeTab === 'api' && <ApiTokensSetup />}
        {activeTab === 'data' && <DataImportExport embedded />}
      </div>
    </div>
  );
}
