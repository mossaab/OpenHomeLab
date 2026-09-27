import { PendingDeviceAction } from './types';
import type { TFunc } from './i18n/index';

const ACTION_NAME_KEYS = {
  reboot: 'action.nameReboot',
  shutdown: 'action.nameShutdown',
  hibernate: 'action.nameHibernate',
  update: 'action.nameUpdate',
} as const;

export function pendingActionLabel(entry: PendingDeviceAction | null, t: TFunc): string | null {
  if (!entry) return null;
  const name = t(ACTION_NAME_KEYS[entry.action]);
  if (entry.status === 'pending') return t('action.pending', {action: name});
  if (entry.status === 'failed') {
    return t('action.failedOutput', {
      action: name,
      output: entry.output ? `: ${entry.output.slice(0, 300)}` : '',
    });
  }
  if (entry.action === 'shutdown') return t('action.shuttingDown');
  if (entry.action === 'hibernate') return t('action.hibernating');
  if (entry.action === 'update') return t('action.updatingAgent');
  return t('action.rebooting');
}

export function compareAgentVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
