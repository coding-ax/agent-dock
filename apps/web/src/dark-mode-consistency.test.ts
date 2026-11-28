import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 暗色模式一致性守卫。
 *
 * 全站暗色模式通过 :root[data-theme="dark"] 反转 CSS 变量（white / zinc / red / amber / orange / emerald / blue / sky）。
 * 如果组件里误用了未接入主题变量的 Tailwind 色系（如 violet / purple / indigo / slate / neutral / gray 等），
 * 暗色下背景会保持刺眼浅色或文字吞成深底深字（如交接说明卡片曾出现的 violet-50 / violet-700 事故）。
 */
const sourceDir = dirname(fileURLToPath(import.meta.url));
const webDir = dirname(sourceDir);

function collectFiles(dir: string, exts: string[]): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, exts));
    } else if (exts.some(ext => entry.name.endsWith(ext)) && !entry.name.includes('.test.')) {
      results.push(full);
    }
  }
  return results;
}

const unmappedTailwindColor = /\b(?:bg|text|border|ring|from|via|to|divide|decoration|outline)-(?:violet|purple|indigo|fuchsia|pink|rose|teal|cyan|green|lime|yellow|slate|gray|neutral|stone)-[0-9]+\b/g;

describe('暗色模式一致性', () => {
  it('tsx 源码不使用未接入主题变量的 Tailwind 色系', () => {
    const offenders: string[] = [];
    for (const file of collectFiles(sourceDir, ['.tsx', '.ts'])) {
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(unmappedTailwindColor)) {
        const line = content.slice(0, match.index).split('\n').length;
        offenders.push(`${relative(sourceDir, file)}:${line} (${match[0]})`);
      }
    }
    expect(offenders, `以下位置使用了未映射暗色变量的 Tailwind 色系，请改为语义 token 或在 CSS 中提供 html[data-theme="dark"] 适配：${offenders.join(', ')}`).toEqual([]);
  });

  it('tailwind.config.js 将 dark: 变体绑定到 [data-theme="dark"]', () => {
    const config = readFileSync(join(webDir, 'tailwind.config.js'), 'utf8');
    expect(config).toContain('[data-theme="dark"]');
  });

  it('lifecycle.css 对系统轮次卡片、交接按钮、阶段徽标和年龄条提供暗色模式覆盖', () => {
    const css = readFileSync(join(sourceDir, 'companion', 'lifecycle.css'), 'utf8');
    expect(css).toContain('html[data-theme="dark"] .ui-system-round');
    expect(css).toContain('html[data-theme="dark"] .ui-system-round[data-kind="handoff"]');
    expect(css).toContain('html[data-theme="dark"] .ui-system-badge');
    expect(css).toContain('html[data-theme="dark"] .ui-handoff-link');
    expect(css).toContain('html[data-theme="dark"] .ui-stage-chip[data-stage="elder"]');
    expect(css).toContain('html[data-theme="dark"] .ui-age-bar');
  });

  it('index.css 在暗色下覆盖 900/950 语义色与高饱和按钮上的纯白字', () => {
    const css = readFileSync(join(sourceDir, 'index.css'), 'utf8');
    expect(css).toContain('.text-red-950');
    expect(css).toContain('.text-emerald-900');
    expect(css).toContain('.text-sky-900');
    expect(css).toContain('.bg-sky-600.text-white');
    expect(css).toContain('.bg-blue-600.text-white');
    expect(css).toContain('html[data-theme="dark"] .ui-kitten-badge');
    expect(css).toContain('html[data-theme="dark"] .ui-kitten-card');
    expect(css).toContain('html[data-theme="dark"] .ui-kitten-reply-bubble');
  });

  it('rich-markdown.css 为 Callout、高亮与按键提供暗色模式覆盖', () => {
    const richCss = readFileSync(join(sourceDir, 'rich-markdown', 'rich-markdown.css'), 'utf8');
    expect(richCss).toContain('html[data-theme="dark"] .ui-md-mark');
    expect(richCss).toContain('html[data-theme="dark"] .ui-md-kbd');
    expect(richCss).toContain('html[data-theme="dark"] .ui-rich-callout');
    expect(richCss).toContain('html[data-theme="dark"] .ui-rich-callout[data-callout="important"]');
  });
});
