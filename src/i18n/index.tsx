import {createContext, useCallback, useContext, useEffect, useMemo, useState} from 'react';
import type {ReactNode} from 'react';
import {en} from './en';
export type {Dict} from './en';
import type {Dict} from './en';
import {fr} from './fr';
import {es} from './es';
import {ar} from './ar';

export const LANGS = [
  {code: 'en', label: 'English'},
  {code: 'fr', label: 'Français'},
  {code: 'es', label: 'Español'},
  {code: 'ar', label: 'العربية'},
] as const;

export type LangCode = (typeof LANGS)[number]['code'];

const DICTS: Record<LangCode, Dict> = {en, fr, es, ar};

const STORAGE_KEY = 'lang';

function readStoredLang(): LangCode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return LANGS.some((l) => l.code === v) ? (v as LangCode) : 'en';
  } catch {
    return 'en';
  }
}

export type TFunc = (key: keyof Dict, vars?: Record<string, string | number>) => string;

interface I18nContextValue {
  t: TFunc;
  lang: LangCode;
  setLang: (lang: LangCode) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({children}: {children: ReactNode}) {
  const [lang, setLangState] = useState<LangCode>(readStoredLang);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [lang]);

  const persist = useCallback((value: string) => {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      return;
    }
  }, []);

  const setLang = useCallback(
    (next: LangCode) => {
      setLangState(next);
      persist(next);
    },
    [persist],
  );

  const t = useCallback<TFunc>(
    (key, vars) => {
      let text = DICTS[lang][key] ?? en[key];
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          text = text.split(`{${name}}`).join(String(value));
        }
      }
      return text;
    },
    [lang],
  );

  const value = useMemo(() => ({t, lang, setLang}), [t, lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}
