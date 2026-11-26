import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { content, type Content, type Lang } from '../content';

const storageKey = 'agentdock-site:lang';

function initialLang(): Lang {
  try {
    const query = new URLSearchParams(window.location.search).get('lang');
    if (query === 'en' || query === 'zh') return query;
    const stored = localStorage.getItem(storageKey);
    if (stored === 'en' || stored === 'zh') return stored;
  } catch { /* 隐私模式：用默认中文 */ }
  return 'zh';
}

interface LangValue { lang: Lang; t: Content; setLang: (lang: Lang) => void; toggle: () => void }

const LangContext = createContext<LangValue | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try { localStorage.setItem(storageKey, next); } catch { /* ignore */ }
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('lang')) { url.searchParams.set('lang', next); window.history.replaceState(null, '', url); }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.title = content[lang].meta.title;
    document.querySelector('meta[name="description"]')?.setAttribute('content', content[lang].meta.description);
  }, [lang]);

  const value = useMemo<LangValue>(() => ({ lang, t: content[lang], setLang, toggle: () => setLang(lang === 'zh' ? 'en' : 'zh') }), [lang, setLang]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): LangValue {
  const value = useContext(LangContext);
  if (!value) throw new Error('useLang must be used inside <LangProvider>');
  return value;
}
