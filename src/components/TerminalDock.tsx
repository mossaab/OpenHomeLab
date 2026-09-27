import { Terminal as TerminalIcon, X } from 'lucide-react';
import type { TermStatus } from './TerminalDialog';
import { useI18n } from '../i18n/index';

export interface TerminalDockItem {
  key: string;
  title: string;
  status: TermStatus;
  minimized: boolean;
}

interface TerminalDockProps {
  items: TerminalDockItem[];
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
}

function statusDotClass(status: TermStatus): string {
  if (status === 'open') return 'bg-emerald-500';
  if (status === 'error') return 'bg-rose-500';
  return 'bg-sky-500 animate-pulse';
}

export default function TerminalDock({ items, onActivate, onClose }: TerminalDockProps) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <div className="fixed inset-x-0 bottom-[env(safe-area-inset-bottom)] md:bottom-0 z-[100] glass border-t border-slate-200 dark:border-white/10 px-3 py-2 flex items-center gap-2 overflow-x-auto custom-scrollbar">
      <TerminalIcon size={14} className="text-cyan-600 dark:text-cyan-400 shrink-0" />
      {items.map((item) => (
        <div key={item.key} className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => onActivate(item.key)}
            title={item.minimized ? t('dock.restore', {title: item.title}) : item.title}
            className={`flex items-center gap-2 ps-2.5 pe-3 py-1.5 rounded-lg border text-xs font-medium max-w-[200px] transition-colors ${
              item.minimized
                ? 'border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-white/10'
                : 'border-cyan-500/40 bg-cyan-500/10 text-slate-900 dark:text-white'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDotClass(item.status)}`} />
            <span className="truncate">{item.title}</span>
          </button>
          <button
            onClick={() => onClose(item.key)}
            aria-label={t('common.close')}
            title={t('common.close')}
            className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-white/10 transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
