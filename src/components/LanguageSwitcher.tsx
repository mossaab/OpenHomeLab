import {useEffect, useRef, useState} from 'react';
import {Check, Globe} from 'lucide-react';
import {LANGS, useI18n} from '../i18n/index';

export function LanguageOptions({onSelect}: {onSelect?: () => void}) {
  const {lang, setLang} = useI18n();
  return (
    <div className="py-1">
      {LANGS.map((l) => (
        <button
          key={l.code}
          onClick={() => {
            setLang(l.code);
            onSelect?.();
          }}
          className={`flex items-center justify-between gap-3 w-full px-4 py-2.5 text-sm transition-colors ${
            lang === l.code
              ? 'font-medium text-slate-900 dark:text-white bg-slate-100/70 dark:bg-white/5'
              : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5'
          }`}
        >
          <span>{l.label}</span>
          {lang === l.code && <Check size={14} className="text-indigo-600 dark:text-indigo-400" />}
        </button>
      ))}
    </div>
  );
}

const BTN =
  'w-9 h-9 rounded-lg flex items-center justify-center border transition-colors glass border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-white/10';

export default function LanguageSwitcher() {
  const {t, lang} = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  const current = LANGS.find((l) => l.code === lang);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} className={BTN} title={t('nav.language')} aria-label={t('nav.language')}>
        <Globe size={18} />
      </button>
      {open && (
        <div className="absolute end-0 top-full mt-2 w-44 glass-card rounded-xl shadow-2xl border border-slate-200 dark:border-white/10 overflow-hidden">
          {current && <div className="px-4 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">{t('nav.language')}</div>}
          <LanguageOptions onSelect={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
