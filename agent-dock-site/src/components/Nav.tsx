import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Menu, Moon, Sun, X } from 'lucide-react';
import { useLang } from '../lib/i18n';
import { setTheme, useTheme } from '../lib/theme';
import { LINKS } from '../content';
import { GithubIcon, KittenMark, Wordmark } from './ui';

function useScrolled(threshold = 8) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [threshold]);
  return scrolled;
}

/** 滚动高亮当前所在的章节。 */
function useActiveSection(ids: string[]) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const nodes = ids.map(id => document.getElementById(id)).filter((node): node is HTMLElement => Boolean(node));
    if (!nodes.length || typeof IntersectionObserver === 'undefined') return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0);
      const best = [...visible.entries()].sort((a, b) => b[1] - a[1])[0];
      setActive(best && best[1] > 0 ? best[0] : null);
    }, { rootMargin: '-35% 0px -55% 0px', threshold: [0, 0.01, 0.2, 0.5, 1] });
    nodes.forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [ids.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  return active;
}

export function Nav() {
  const { t, toggle } = useLang();
  const theme = useTheme();
  const scrolled = useScrolled();
  const [open, setOpen] = useState(false);
  const active = useActiveSection(t.nav.links.map(link => link.id));

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = overflow; window.removeEventListener('keydown', onKey); };
  }, [open]);

  const themeButton = (
    <button
      type="button"
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      aria-label={theme === 'dark' ? t.nav.themeLight : t.nav.themeDark}
      title={theme === 'dark' ? t.nav.themeLight : t.nav.themeDark}
      className="grid h-9 w-9 place-items-center rounded-full text-zinc-600 transition-colors hover:bg-zinc-900/[.06] hover:text-zinc-900"
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={theme} initial={{ rotate: -90, opacity: 0, scale: 0.6 }} animate={{ rotate: 0, opacity: 1, scale: 1 }} exit={{ rotate: 90, opacity: 0, scale: 0.6 }} transition={{ duration: 0.22 }}>
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </motion.span>
      </AnimatePresence>
    </button>
  );

  const langButton = (
    <button
      type="button"
      onClick={toggle}
      aria-label={t.nav.langLabel}
      title={t.nav.langLabel}
      className="h-9 min-w-9 rounded-full px-2.5 font-dock text-[12.5px] font-medium text-zinc-600 transition-colors hover:bg-zinc-900/[.06] hover:text-zinc-900"
    >
      {t.nav.lang}
    </button>
  );

  return (
    <header className="fixed inset-x-0 top-0 z-50" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <div className={`absolute inset-0 -z-10 transition-[background-color,border-color,backdrop-filter] duration-300 ${scrolled || open ? 'border-b border-line bg-page/75 backdrop-blur-xl backdrop-saturate-150' : 'border-b border-transparent'}`} />
      <nav className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-3 px-5 sm:px-8" aria-label="Primary">
        <a href="#top" className="flex shrink-0 items-center gap-2.5 rounded-lg" aria-label="AgentDock" onClick={() => setOpen(false)}>
          <KittenMark size={30} />
          <Wordmark height={14} />
        </a>

        <ul className="hidden items-center gap-1 lg:flex">
          {t.nav.links.map(link => (
            <li key={link.id}>
              <a
                href={`#${link.id}`}
                className={`relative rounded-full px-3 py-2 font-dock text-[13px] transition-colors ${active === link.id ? 'text-zinc-900' : 'text-zinc-500 hover:text-zinc-900'}`}
              >
                {active === link.id && <motion.span layoutId="nav-active" className="absolute inset-0 -z-10 rounded-full bg-zinc-900/[.06]" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-1">
          <a href={LINKS.github} target="_blank" rel="noreferrer noopener" className="hidden h-9 items-center gap-2 rounded-full px-3 font-dock text-[13px] text-zinc-600 transition-colors hover:bg-zinc-900/[.06] hover:text-zinc-900 sm:flex" aria-label="GitHub">
            <GithubIcon size={16} />
            <span className="hidden xl:inline">{t.nav.github}</span>
          </a>
          {langButton}
          {themeButton}
          <a href="#start" className="ml-1.5 hidden h-9 items-center gap-1.5 rounded-full bg-zinc-900 px-4 font-dock text-[13px] font-medium text-white transition-[transform,box-shadow] hover:-translate-y-px hover:shadow-[0_0_0_4px_rgb(var(--brand)/.18)] sm:inline-flex">
            {t.nav.cta}
            <ArrowRight size={14} />
          </a>
          <button
            type="button"
            onClick={() => setOpen(value => !value)}
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? t.nav.close : t.nav.menu}
            className="grid h-9 w-9 place-items-center rounded-full text-zinc-700 transition-colors hover:bg-zinc-900/[.06] lg:hidden"
          >
            {open ? <X size={19} /> : <Menu size={19} />}
          </button>
        </div>
      </nav>

      <AnimatePresence>
        {open && (
          <motion.div
            id="mobile-menu"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
            className="border-b border-line bg-page/95 backdrop-blur-xl lg:hidden"
            style={{ height: 'calc(100dvh - 64px - env(safe-area-inset-top))' }}
          >
            <ul className="mx-auto flex max-w-[1200px] flex-col px-5 pt-3 sm:px-8">
              {t.nav.links.map((link, index) => (
                <motion.li key={link.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.03 * index }}>
                  <a href={`#${link.id}`} onClick={() => setOpen(false)} className="flex items-center justify-between border-b border-line py-4 font-display text-[22px] font-semibold tracking-[-0.02em] text-zinc-900">
                    {link.label}
                    <ArrowRight size={18} className="text-zinc-400" />
                  </a>
                </motion.li>
              ))}
            </ul>
            <div className="mx-auto mt-6 flex max-w-[1200px] flex-col gap-3 px-5 sm:px-8">
              <a href="#start" onClick={() => setOpen(false)} className="flex h-12 items-center justify-center gap-2 rounded-full bg-zinc-900 font-dock text-[14px] font-medium text-white">
                {t.nav.cta}<ArrowRight size={15} />
              </a>
              <a href={LINKS.github} target="_blank" rel="noreferrer noopener" className="flex h-12 items-center justify-center gap-2 rounded-full border border-zinc-300 font-dock text-[14px] font-medium text-zinc-900">
                <GithubIcon size={16} />GitHub
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
