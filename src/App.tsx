import { useState, useEffect, useRef, type FormEvent } from 'react';
import { apiCall } from './api';
import type { AppSettings, Theme } from './types';
import { Radar, Settings as SettingsIcon, Lock, User, Terminal as TerminalIcon, Github } from 'lucide-react';
import { useI18n } from './i18n/index';
import Dashboard from './components/Dashboard';
import NetworkScanner from './components/NetworkScanner';
import SetupWizard from './components/SetupWizard';
import LanguageSwitcher from './components/LanguageSwitcher';
import TerminalDialog, { type TermStatus } from './components/TerminalDialog';
import TerminalDock from './components/TerminalDock';
import SettingsModal from './components/SettingsModal';

type Tab = 'dashboard' | 'scanner';
type Route = { tab: Tab; deviceId: number | null };

function parseRoute(): Route {
  const segments = window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (segments[0] === 'scanner') return { tab: 'scanner', deviceId: null };
  if (segments[0] === 'dashboard' && segments[1] === 'device' && /^\d+$/.test(segments[2] ?? '')) {
    return { tab: 'dashboard', deviceId: Number(segments[2]) };
  }
  return { tab: 'dashboard', deviceId: null };
}

function routeToHash(tab: Tab, deviceId: number | null): string {
  if (tab === 'scanner') return '#/scanner';
  if (deviceId !== null) return `#/dashboard/device/${deviceId}`;
  return '#/dashboard';
}

interface TerminalSession {
  key: string;
  target: 'host' | 'device' | 'ip';
  deviceId?: number;
  ip?: string;
  deviceName?: string;
  profileId?: number | null;
  minimized: boolean;
  maximized: boolean;
}

const terminalKey = (target: 'host' | 'device' | 'ip', id?: number | string) =>
  target === 'host' ? 'host' : `${target}-${id}`;

const ICON_BTN = 'w-9 h-9 rounded-lg flex items-center justify-center border transition-colors';
const ICON_IDLE = `${ICON_BTN} glass border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-white/10`;
const ICON_ACTIVE = `${ICON_BTN} bg-slate-200/70 dark:bg-white/10 border-slate-300 dark:border-white/20 text-slate-900 dark:text-white`;

export default function App() {
  const {t} = useI18n();
  const [isSetup, setIsSetup] = useState<boolean | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem('theme');
    return stored === 'light' || stored === 'dark' || stored === 'terminal' || stored === 'monokai' ? stored : 'terminal';
  });

  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [terminalSessions, setTerminalSessions] = useState<TerminalSession[]>([]);
  const [terminalStatuses, setTerminalStatuses] = useState<Record<string, TermStatus>>({});
  const [settingsTick, setSettingsTick] = useState(0);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiCall('/setup/status')
      .then((data) => setIsSetup(data.isSetup))
      .catch((err) => console.error(err));

    if (localStorage.getItem('auth_token')) {
      setIsAuthenticated(true);
    }
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme !== 'light');
    document.documentElement.classList.toggle('terminal', theme === 'terminal');
    document.documentElement.classList.toggle('monokai', theme === 'monokai');
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    const onAuthExpired = () => setIsAuthenticated(false);
    window.addEventListener('openhomelab:auth-expired', onAuthExpired);
    return () => window.removeEventListener('openhomelab:auth-expired', onAuthExpired);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    apiCall<AppSettings>('/settings')
      .then(setAppSettings)
      .catch((err) => console.error(err));
  }, [isAuthenticated, settingsTick]);

  const openTerminal = (input: {
    target: 'host' | 'device' | 'ip';
    deviceId?: number;
    ip?: string;
    deviceName?: string;
    profileId?: number | null;
  }) => {
    const key = terminalKey(input.target, input.deviceId ?? input.ip);
    setTerminalSessions((prev) => {
      const existing = prev.find((s) => s.key === key);
      if (existing) return [...prev.filter((s) => s.key !== key), { ...existing, minimized: false }];
      return [...prev, { ...input, key, minimized: false, maximized: false }];
    });
  };

  const closeTerminal = (key: string) => {
    setTerminalSessions((prev) => prev.filter((s) => s.key !== key));
    setTerminalStatuses((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const minimizeTerminal = (key: string) => {
    setTerminalSessions((prev) => prev.map((s) => (s.key === key ? { ...s, minimized: true } : s)));
  };

  const toggleMaximizeTerminal = (key: string) => {
    setTerminalSessions((prev) => {
      const idx = prev.findIndex((s) => s.key === key);
      if (idx === -1) return prev;
      const next = prev.map((s) => (s.key === key ? { ...s, maximized: !s.maximized } : s));
      return [...next.filter((s) => s.key !== key), next[idx]];
    });
  };

  const bringTerminalToFront = (key: string) => {
    setTerminalSessions((prev) => {
      const idx = prev.findIndex((s) => s.key === key);
      if (idx === -1 || idx === prev.length - 1) return prev;
      const next = [...prev];
      const [session] = next.splice(idx, 1);
      next.push(session);
      return next;
    });
  };

  const activateTerminal = (key: string) => {
    setTerminalSessions((prev) => {
      const idx = prev.findIndex((s) => s.key === key);
      if (idx === -1) return prev;
      const session = prev[idx];
      if (!session.minimized && idx === prev.length - 1) return prev;
      return [...prev.filter((s) => s.key !== key), { ...session, minimized: false }];
    });
  };

  const reportTerminalStatus = (key: string) => (status: TermStatus) => {
    setTerminalStatuses((prev) => (prev[key] === status ? prev : { ...prev, [key]: status }));
  };

  const currentTab = route.tab;

  const agentIntervalS = appSettings?.agent_interval_seconds ?? 30;
  const uiRefreshMs = (appSettings?.ui_refresh_seconds ?? 30) * 1000;
  const agentStaleMs = Math.max(90_000, 3 * agentIntervalS * 1000);

  const navigate = (tab: Tab, deviceId: number | null = null) => {
    const hash = routeToHash(tab, deviceId);
    if (window.location.hash !== hash) {
      window.history.pushState(null, '', hash);
      setRoute(parseRoute());
    } else {
      setRoute({ tab, deviceId: tab === 'dashboard' && deviceId !== null ? deviceId : null });
    }
  };

  useEffect(() => {
    if (!userMenuOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [userMenuOpen]);

  const handleAction = async (e: FormEvent, endpoint: string) => {
    e.preventDefault();
    setError('');
    try {
      const { token } = await apiCall(endpoint, {
        method: 'POST',
        body: JSON.stringify({ password })
      });
      localStorage.setItem('auth_token', token);
      setIsAuthenticated(true);
    } catch (err: any) {
      setError(err.message || t('auth.errorOccurred'));
    }
  };

  const logout = () => {
    localStorage.removeItem('auth_token');
    setIsAuthenticated(false);
  };

  if (isSetup === null) {
    return (
      <div className="min-h-dvh bg-white dark:bg-slate-950 flex items-center justify-center text-slate-500 dark:text-slate-300">
        {t('app.loading')}
      </div>
    );
  }

  if (!isAuthenticated && !isSetup) {
    return <SetupWizard theme={theme} onThemeChange={setTheme} onFinish={() => setIsAuthenticated(true)} />;
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-dvh mesh-gradient flex flex-col items-center justify-center p-4 font-sans text-slate-900 dark:text-slate-100">
        <div className="relative w-full max-w-sm glass-card rounded-xl p-8 shadow-2xl">
          <div className="absolute top-4 end-4">
            <LanguageSwitcher />
          </div>
          <div className="flex justify-center mb-6">
            <img src="/logo.svg" alt="OpenHomeLab" className="w-16 h-16 rounded-2xl shadow-lg shadow-amber-500/30" />
          </div>
          <h1 className="text-2xl text-center text-slate-900 dark:text-slate-100 font-bold tracking-tight mb-2">
            {!isSetup ? t('auth.setupTitle') : t('auth.loginTitle')}
          </h1>
          <p className="text-slate-500 dark:text-slate-400 text-sm text-center mb-8">
            {!isSetup ? t('auth.setupSubtitle') : t('auth.loginSubtitle')}
          </p>

          <form onSubmit={(e) => handleAction(e, !isSetup ? '/setup' : '/login')} className="space-y-4">
            <div>
              <div className="relative">
                <Lock className="absolute start-3 top-2.5 text-slate-500" size={20} />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg ps-10 pe-4 py-2.5 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                  placeholder={t('auth.passwordPlaceholder')}
                  required
                />
              </div>
            </div>
            {error && <p className="text-red-600 dark:text-red-400 text-sm text-center">{error}</p>}
            <button
              type="submit"
              className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2.5 rounded-lg transition-colors"
            >
              {!isSetup ? t('auth.setButton') : t('auth.loginButton')}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="h-dvh mesh-gradient text-slate-900 dark:text-slate-100 font-sans flex flex-col text-sm overflow-hidden">
      {/* Top bar */}
      <header className="glass border-b border-slate-200 dark:border-white/10 px-4 md:px-6 h-12 flex items-center gap-3 flex-shrink-0 relative z-40">
        <button
          onClick={() => navigate('dashboard')}
          aria-label={t('nav.home')}
          className={`flex items-center gap-2.5 flex-shrink-0 rounded-lg px-2 h-9 transition-colors ${
            currentTab === 'dashboard'
              ? 'bg-slate-200/70 dark:bg-white/10'
              : 'hover:bg-slate-200/50 dark:hover:bg-white/5'
          }`}
        >
          <img src="/logo.svg" alt="OpenHomeLab" className="w-8 h-8 rounded-lg shadow-lg shadow-amber-500/30" />
          <span className="font-bold text-base tracking-tight whitespace-nowrap">OpenHomeLab</span>
        </button>

        {/* Actions */}
        <div className="flex items-center gap-2 ms-auto">
          <button
            onClick={() => navigate('scanner')}
            className={currentTab === 'scanner' ? ICON_ACTIVE : ICON_IDLE}
            title={t('nav.scanner')}
            aria-label={t('nav.scanner')}
          >
            <Radar size={18} />
          </button>
          <button
            onClick={() => openTerminal({ target: 'host' })}
            className={ICON_IDLE}
            title={t('nav.hostTerminal')}
            aria-label={t('nav.hostTerminal')}
          >
            <TerminalIcon size={18} />
          </button>

          {/* User menu */}
          <div ref={userMenuRef} className="relative">
            <button
              onClick={() => setUserMenuOpen((v) => !v)}
              className={userMenuOpen ? ICON_ACTIVE : ICON_IDLE}
              title={t('nav.account')}
              aria-label={t('nav.account')}
            >
              <User size={18} />
            </button>
            {userMenuOpen && (
              <div className="absolute end-0 top-full mt-2 w-56 glass-card rounded-xl shadow-2xl border border-slate-200 dark:border-white/10 overflow-hidden">
                <button
                  onClick={() => { setShowSettings(true); setUserMenuOpen(false); }}
                  className="flex items-center gap-3 w-full px-4 py-3 text-slate-500 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5 hover:text-slate-900 dark:hover:text-white transition-colors"
                >
                  <SettingsIcon size={16} /> {t('nav.settings')}
                </button>
                <div className="border-t border-slate-200 dark:border-white/10" />
                <button
                  onClick={() => { logout(); setUserMenuOpen(false); }}
                  className="flex items-center gap-3 w-full px-4 py-3 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 transition-colors"
                >
                  <Lock size={16} /> {t('nav.logout')}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto custom-scrollbar px-4 py-6 md:p-10 sm:pb-10">
        <div className="max-w-6xl mx-auto min-h-full">
          {currentTab === 'dashboard' && (
            <Dashboard
              settingsTick={settingsTick}
              onOpenSettings={() => setShowSettings(true)}
              onOpenTerminal={(deviceId, name, profileId) => openTerminal({ target: 'device', deviceId, deviceName: name, profileId })}
              selectedDeviceId={route.deviceId}
              onSelectDevice={(id) => navigate('dashboard', id)}
              refreshMs={uiRefreshMs}
              agentIntervalS={agentIntervalS}
              agentStaleMs={agentStaleMs}
              appSettings={appSettings}
              onAppSettingsChanged={() => setSettingsTick((t) => t + 1)}
            />
          )}
          {currentTab === 'scanner' && <NetworkScanner onOpenTerminal={openTerminal} />}
        </div>
      </main>

      {/* Footer */}
      <footer className="hidden md:flex items-center justify-end gap-4 h-10 px-6 flex-shrink-0 glass border-t border-slate-200 dark:border-white/10 relative z-30">
        <a
          href="https://github.com/mossaab/OpenHomeLab/releases"
          target="_blank"
          rel="noopener noreferrer"
          title={t('footer.releases')}
          aria-label={t('footer.releases')}
          className="text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap"
        >
          OpenHomeLab {__APP_VERSION__}
        </a>
        <a
          href="https://github.com/mossaab/OpenHomeLab"
          target="_blank"
          rel="noopener noreferrer"
          title={t('footer.github')}
          aria-label={t('footer.github')}
          className="text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
        >
          <Github size={16} />
        </a>
      </footer>

      {showSettings && (
        <SettingsModal
          theme={theme}
          onThemeChange={setTheme}
          onClose={() => setShowSettings(false)}
          onSaved={() => setSettingsTick((t) => t + 1)}
        />
      )}

      {terminalSessions.map((s, i) => (
        <TerminalDialog
          key={s.key}
          target={s.target}
          deviceId={s.deviceId}
          ip={s.ip}
          deviceName={s.deviceName}
          deviceProfileId={s.profileId ?? null}
          minimized={s.minimized}
          maximized={s.maximized}
          active={s.key === terminalSessions[terminalSessions.length - 1]?.key}
          zIndex={50 + i}
          onClose={() => closeTerminal(s.key)}
          onMinimize={() => minimizeTerminal(s.key)}
          onToggleMaximize={() => toggleMaximizeTerminal(s.key)}
          onFocusFront={() => bringTerminalToFront(s.key)}
          onStatusChange={reportTerminalStatus(s.key)}
        />
      ))}

      <TerminalDock
        items={terminalSessions.map((s) => ({
          key: s.key,
          title:
            s.target === 'host'
              ? t('nav.hostTerminal')
              : t('term.titleDevice', {name: s.deviceName ?? t('term.deviceFallback', {id: String(s.deviceId)})}),
          status: terminalStatuses[s.key] ?? 'connecting',
          minimized: s.minimized,
        }))}
        onActivate={activateTerminal}
        onClose={closeTerminal}
      />
    </div>
  );
}
