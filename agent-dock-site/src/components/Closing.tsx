import { Download, Moon, Star, Sun } from 'lucide-react';
import { useLang } from '../lib/i18n';
import { setTheme, useTheme } from '../lib/theme';
import { LINKS, VERSION } from '../content';
import { GithubIcon, Kitten, KittenMark, Phrases, Reveal, Wordmark } from './ui';
import { InstallCommand } from './Hero';

export function FinalCta() {
  const { t, lang } = useLang();
  return (
    <section className="relative isolate overflow-hidden py-28 sm:py-36">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <div className="dot-grid fade-mask-radial absolute inset-0" />
        <div className="glow-breathe absolute left-1/2 top-1/2 h-[560px] w-[980px] max-w-[150vw] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(var(--glow)/.2),transparent)]" />
        {[['18%', '30%', '3s', '0s'], ['80%', '26%', '2.7s', '-1.2s'], ['28%', '78%', '3.4s', '-2s'], ['72%', '74%', '3.1s', '-0.6s']].map(([left, top, dur, delay], index) => (
          <span key={index} className="twinkle absolute h-[5px] w-[5px] bg-brand" style={{ left, top, ['--dur' as string]: dur, ['--delay' as string]: delay }} />
        ))}
      </div>
      <div className="mx-auto flex max-w-[900px] flex-col items-center px-5 text-center sm:px-8">
        <Reveal><Kitten mood="sparkle" size={150} /></Reveal>
        <Reveal delay={0.05}>
          <h2 className={`mt-6 text-balance font-display font-semibold text-zinc-900 ${lang === 'zh' ? 'text-[34px] leading-[1.18] tracking-[-0.03em] sm:text-[52px] lg:text-[60px]' : 'text-[38px] leading-[1.05] tracking-[-0.04em] sm:text-[56px] lg:text-[66px]'}`}>
            <Phrases text={t.cta.title} />
          </h2>
        </Reveal>
        <Reveal delay={0.1}><p className="mt-5 max-w-xl text-pretty text-[16px] leading-[1.8] text-zinc-500 sm:text-[18px]">{t.cta.sub}</p></Reveal>
        <Reveal delay={0.15} className="mt-9 flex w-full flex-col items-center gap-4">
          <InstallCommand />
          <div className="flex w-full flex-col items-stretch justify-center gap-3 sm:w-auto sm:flex-row">
            <a href={LINKS.github} target="_blank" rel="noreferrer noopener" className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-zinc-900 px-6 font-dock text-[14px] font-medium text-white transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-[0_0_0_5px_rgb(var(--brand)/.18)]">
              <Star size={16} />{t.cta.github}
            </a>
            <a href={LINKS.releases} target="_blank" rel="noreferrer noopener" className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-zinc-300 bg-card/60 px-6 font-dock text-[14px] font-medium text-zinc-900 backdrop-blur transition-colors hover:bg-zinc-100">
              <Download size={16} />{t.cta.desktop}
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export function Footer() {
  const { t, toggle } = useLang();
  const theme = useTheme();
  return (
    <footer className="border-t border-line bg-page" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="mx-auto grid max-w-[1200px] grid-cols-3 gap-x-4 gap-y-10 px-5 py-14 sm:px-8 md:grid-cols-[minmax(0,1.3fr)_repeat(3,minmax(0,1fr))] md:gap-10">
        <div className="col-span-3 md:col-span-1">
          <a href="#top" className="inline-flex items-center gap-2.5" aria-label="AgentDock">
            <KittenMark size={34} />
            <Wordmark height={15} />
          </a>
          <p className="mt-4 max-w-[300px] text-[14px] leading-[1.75] text-zinc-500"><Phrases text={t.footer.tagline} /></p>
          <div className="mt-5 flex items-center gap-2">
            <a href={LINKS.github} target="_blank" rel="noreferrer noopener" aria-label="GitHub" className="grid h-9 w-9 place-items-center rounded-full border border-line text-zinc-600 transition-colors hover:border-zinc-300 hover:text-zinc-900"><GithubIcon size={16} /></a>
            <button type="button" onClick={toggle} aria-label={t.nav.langLabel} className="h-9 rounded-full border border-line px-3 font-dock text-[12px] text-zinc-600 transition-colors hover:border-zinc-300 hover:text-zinc-900">{t.nav.lang}</button>
            <button type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? t.nav.themeLight : t.nav.themeDark} className="grid h-9 w-9 place-items-center rounded-full border border-line text-zinc-600 transition-colors hover:border-zinc-300 hover:text-zinc-900">
              {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </div>
        </div>
        {t.footer.groups.map(group => (
          <div key={group.title}>
            <h3 className="font-dock text-[12px] font-medium uppercase tracking-[.12em] text-zinc-400">{group.title}</h3>
            <ul className="mt-4 space-y-2.5">
              {group.links.map(link => (
                <li key={link.label}>
                  <a href={link.href} {...(link.href.startsWith('#') ? {} : { target: '_blank', rel: 'noreferrer noopener' })} className="text-[14px] text-zinc-600 transition-colors hover:text-zinc-900">{link.label}</a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-line">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-2 px-5 py-6 font-dock text-[12px] text-zinc-400 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <span>
            <span className="inline-block">© 2026 AgentDock · v{VERSION}</span>
            <span className="hidden sm:inline"> · </span>
            <span className="block sm:inline">{t.footer.rights}</span>
          </span>
          <span>{t.footer.made}</span>
        </div>
      </div>
    </footer>
  );
}
