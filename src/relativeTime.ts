import type { TFunc } from './i18n/index';

export function formatAgo(ts: number, t: TFunc): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return t('time.agoSeconds', {n: s});
  const m = Math.floor(s / 60);
  if (m < 60) return t('time.agoMinutes', {n: m});
  const h = Math.floor(m / 60);
  if (h < 24) return t('time.agoHours', {h, m: m % 60});
  const d = Math.floor(h / 24);
  return t('time.agoDays', {d, h: h % 24});
}
