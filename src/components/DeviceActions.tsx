import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, DownloadCloud, Loader2, Moon, MoreVertical, Power, PowerOff, RotateCcw, Terminal as TerminalIcon } from 'lucide-react';
import { useI18n } from '../i18n';

interface DeviceActionsProps {
  isOnline: boolean | null;
  loading?: Record<string, boolean>;
  hasAgentToken?: number;
  agentOutdated?: boolean;
  disablePower?: number;
  disablePing?: number;
  disableTerminal?: number;
  disableAgentUpdate?: number;
  menuAlign?: 'start' | 'end';
  showWake?: boolean;
  showMenu?: boolean;
  onPing: () => void;
  onWake: () => void;
  onReboot: () => void;
  onShutdown: () => void;
  onHibernate: () => void;
  onUpdate: () => void;
  onTerminal?: () => void;
}

const BUTTON = 'flex items-center justify-center w-8 h-8 rounded-lg transition-colors disabled:opacity-50 disabled:pointer-events-none';

interface MenuItem {
  key: string;
  label: string;
  icon: ReactNode;
  iconClass: string;
  onClick: () => void;
  disabled?: boolean;
}

export default function DeviceActions({
  isOnline,
  loading = {},
  hasAgentToken,
  agentOutdated,
  disablePower,
  disablePing,
  disableTerminal,
  disableAgentUpdate,
  menuAlign = 'end',
  showWake = true,
  showMenu = true,
  onPing,
  onWake,
  onReboot,
  onShutdown,
  onHibernate,
  onUpdate,
  onTerminal,
}: DeviceActionsProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const offline = isOnline === false;

  const items: MenuItem[] = [];
  if (disablePing !== 1) {
    items.push({
      key: 'ping',
      label: t('action.namePing'),
      icon: <Activity size={15} />,
      iconClass: 'text-emerald-600 dark:text-emerald-400',
      onClick: onPing,
    });
  }
  if (onTerminal && isOnline === true && disableTerminal !== 1) {
    items.push({
      key: 'terminal',
      label: t('action.nameTerminal'),
      icon: <TerminalIcon size={15} />,
      iconClass: 'text-cyan-600 dark:text-cyan-400',
      onClick: onTerminal,
    });
  }
  if (hasAgentToken === 1 && disableAgentUpdate !== 1 && isOnline !== false) {
    items.push({
      key: 'update',
      label: agentOutdated ? t('action.updateOutdated') : t('action.nameUpdate'),
      icon: loading.update ? <Loader2 size={15} className="animate-spin" /> : <DownloadCloud size={15} />,
      iconClass: 'text-sky-600 dark:text-sky-400',
      onClick: onUpdate,
      disabled: !!loading.update,
    });
  }
  if (disablePower !== 1 && hasAgentToken === 1 && isOnline === true) {
    items.push(
      {
        key: 'reboot',
        label: t('action.nameReboot'),
        icon: <RotateCcw size={15} />,
        iconClass: 'text-amber-600 dark:text-amber-400',
        onClick: onReboot,
        disabled: !!loading.reboot,
      },
      {
        key: 'hibernate',
        label: t('action.nameHibernate'),
        icon: <Moon size={15} />,
        iconClass: 'text-violet-600 dark:text-violet-400',
        onClick: onHibernate,
        disabled: !!loading.hibernate,
      },
      {
        key: 'shutdown',
        label: t('action.nameShutdown'),
        icon: <PowerOff size={15} />,
        iconClass: 'text-rose-600 dark:text-rose-400',
        onClick: onShutdown,
        disabled: !!loading.shutdown,
      },
    );
  }

  const wakeButton =
    isOnline !== true && disablePower !== 1 ? (
      <button
        type="button"
        title={t('action.nameWake')}
        aria-label={t('action.nameWake')}
        disabled={!!loading.wake}
        onClick={(e) => {
          e.stopPropagation();
          onWake();
        }}
        className={
          offline
            ? `${BUTTON} bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/25`
            : `${BUTTON} glass text-slate-600 dark:text-slate-300 hover:bg-indigo-500/20`
        }
      >
        {loading.wake ? <Loader2 size={15} className="animate-spin" /> : <Power size={15} />}
      </button>
    ) : null;

  const visibleWake = showWake ? wakeButton : null;
  const visibleMenu = showMenu && items.length > 0;

  if (!visibleWake && !visibleMenu) return null;

  return (
    <div className="flex items-center gap-1 shrink-0">
      {visibleWake}
      {visibleMenu && (
        <div ref={menuRef} className="relative">
          <button
            type="button"
            title={t('action.menu')}
            aria-label={t('action.menu')}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={(e) => {
              e.stopPropagation();
              if (!open) {
                const rect = e.currentTarget.getBoundingClientRect();
                setOpenUp(window.innerHeight - rect.bottom < items.length * 40 + 16);
              }
              setOpen((v) => !v);
            }}
            className={`${BUTTON} glass text-slate-600 dark:text-slate-300 hover:bg-indigo-500/20`}
          >
            <MoreVertical size={15} />
          </button>
          {open && (
            <div
              role="menu"
              className={`absolute ${menuAlign === 'start' ? 'start-0' : 'end-0'} ${openUp ? 'bottom-full mb-2' : 'top-full mt-2'} z-20 w-48 glass-card rounded-xl shadow-2xl border border-slate-200 dark:border-white/10 overflow-hidden`}
            >
              {items.map((it) => (
                <button
                  key={it.key}
                  role="menuitem"
                  type="button"
                  disabled={it.disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    it.onClick();
                  }}
                  className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-slate-700 dark:text-slate-200 transition-colors hover:bg-slate-100 dark:hover:bg-white/5 disabled:opacity-50 disabled:pointer-events-none"
                >
                  <span className={`shrink-0 ${it.iconClass}`}>{it.icon}</span>
                  <span className="truncate">{it.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
