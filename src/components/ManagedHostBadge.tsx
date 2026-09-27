import { ArrowUpRight } from 'lucide-react';
import type { ScannedHost } from '../types';
import { useI18n } from '../i18n';

export default function ManagedHostBadge({
  host,
  onOpen,
  compact = false,
}: {
  host: ScannedHost;
  onOpen: (id: number) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  if (!host.managed_device_id) {
    return compact ? null : (
      <span className="italic text-xs text-slate-500 dark:text-slate-600">{t('scanner.unknown')}</span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(host.managed_device_id as number)}
      title={t('scanner.openInDash', { name: host.managed_device_name ?? '' })}
      className={`shrink-0 inline-flex items-center gap-1 bg-indigo-100 dark:bg-indigo-500/15 border border-indigo-200 dark:border-indigo-500/30 px-2 py-1 rounded text-[10px] uppercase tracking-wider text-indigo-700 dark:text-indigo-300 hover:bg-indigo-200/70 dark:hover:bg-indigo-500/25 transition-colors ${
        compact ? 'max-w-[40%]' : ''
      }`}
    >
      <span className={compact ? 'truncate' : ''}>{host.managed_device_name || t('devsetup.alreadyAdded')}</span>
      <ArrowUpRight size={11} className="shrink-0" />
    </button>
  );
}
