import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Disclosure } from './Disclosure';
import { HoverTooltip, TooltipProvider } from './HoverTooltip';
import { SlidingSegmented } from './ui-controls';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

function extractKeyframesBlock(css: string, name: string): string {
  const start = css.indexOf(`@keyframes ${name}`);
  if (start < 0) return '';
  let depth = 0;
  let seenOpen = false;
  for (let i = start; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') { depth++; seenOpen = true; }
    else if (ch === '}') {
      depth--;
      if (seenOpen && depth === 0) return css.slice(start, i + 1);
    }
  }
  return css.slice(start);
}

describe('unified motion design system', () => {
  it('defines standard easing curves and duration ladder tokens in motion.css and loads it from main.tsx', () => {
    const motionCss = read('./motion.css');
    const mainTsx = read('./main.tsx');

    for (const token of [
      '--ease-out-expo',
      '--ease-spring',
      '--ease-swift',
      '--dur-fast: 120ms',
      '--dur-base: 180ms',
      '--dur-panel: 240ms',
      '--dur-spring: 320ms'
    ]) {
      expect(motionCss).toContain(token);
    }

    const indexImport = mainTsx.indexOf("import './index.css'");
    const motionImport = mainTsx.indexOf("import './motion.css'");
    expect(indexImport).toBeGreaterThanOrEqual(0);
    expect(motionImport).toBeGreaterThan(indexImport);
  });

  it('enforces prefers-reduced-motion: reduce across all interactive stylesheets', () => {
    for (const file of [
      './motion.css',
      './index.css',
      './board/board.css',
      './companion/companion.css',
      './lark-regex-trigger.css'
    ]) {
      expect(read(file)).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    }
  });

  it('keeps continuous animations strictly GPU-composited and bans layout-thrashing rules', () => {
    const motionCss = read('./motion.css');
    const boardCss = read('./board/board.css');
    const companionCss = read('./companion/companion.css');
    const regexCss = read('./lark-regex-trigger.css');

    // No permanent will-change declarations across stylesheets
    for (const css of [motionCss, boardCss, regexCss]) {
      expect(css).not.toMatch(/\bwill-change\s*:/);
    }

    // Entrance animations in motion.css use fill-mode: backwards (never both) so long timelines release compositor layers once settled
    expect(motionCss).not.toMatch(/animation:[^;]*\bboth\b/);

    // Running status rings use pseudo-element transform/opacity instead of box-shadow repaint
    expect(extractKeyframesBlock(motionCss, 'ui-live-ring-pulse')).not.toContain('box-shadow');
    expect(extractKeyframesBlock(companionCss, 'ui-edge-ring')).not.toContain('box-shadow');
    expect(extractKeyframesBlock(companionCss, 'ui-edge-ring-red')).not.toContain('box-shadow');

    // Board running bar breathe uses pure opacity instead of filter repaint
    const barBreathe = extractKeyframesBlock(boardCss, 'ui-board-bar-breathe');
    expect(barBreathe).toContain('opacity');
    expect(barBreathe).not.toContain('filter');

    // Board lanes do not animate layout width
    const laneRule = boardCss.match(/\.ui-board-lane\s*\{[^}]*\}/)?.[0] ?? '';
    expect(laneRule).not.toMatch(/transition:[^;]*\bwidth\b/);

    // Regex message rows do not animate margin-bottom (spacing lives on .ui-regex-msg-inner)
    const regexWrapRule = regexCss.match(/\.ui-regex-msg-wrap\s*\{[^}]*\}/)?.[0] ?? '';
    expect(regexWrapRule).not.toContain('margin-bottom');
    const regexMarkIn = extractKeyframesBlock(regexCss, 'ui-regex-mark-in');
    expect(regexMarkIn).not.toContain('background-color');
  });

  it('keeps Radix tooltip positioning transform untouched by animating inner .ui-tooltip-surface', () => {
    const motionCss = read('./motion.css');
    const tooltipTsx = read('./HoverTooltip.tsx');

    expect(tooltipTsx).toContain('ui-tooltip-surface');
    expect(motionCss).toMatch(/\[data-side="top"\]\s*>\s*\.ui-tooltip-surface/);
    expect(motionCss).toMatch(/\[data-side="bottom"\]\s*>\s*\.ui-tooltip-surface/);
    // Outer .ui-tooltip must not apply a transform keyframe that clashes with Radix popper inline transform
    expect(motionCss).not.toMatch(/\.ui-tooltip\s*\{[^}]*animation:\s*ui-tooltip-from-/);

    const html = renderToStaticMarkup(
      createElement(TooltipProvider, {
        children: createElement(HoverTooltip, {
          content: '测试提示',
          children: createElement('button', { type: 'button' }, '按钮')
        })
      })
    );
    expect(html).toContain('按钮');
  });
});

describe('core motion primitives rendering', () => {
  it('Disclosure preserves smooth grid-template-rows + opacity transition for both open and closed states', () => {
    const closedHtml = renderToStaticMarkup(createElement(Disclosure, { open: false, children: createElement('div', null, '细节内容') }));
    expect(closedHtml).toContain('transition-[grid-template-rows,opacity]');
    expect(closedHtml).toContain('grid-rows-[0fr]');
    expect(closedHtml).toContain('opacity-0');
    expect(closedHtml).toContain('ui-disclosure-content');

    const openHtml = renderToStaticMarkup(createElement(Disclosure, { open: true, children: createElement('div', null, '细节内容') }));
    expect(openHtml).toContain('grid-rows-[1fr]');
    expect(openHtml).toContain('opacity-100');
    expect(openHtml).toContain('data-open="true"');
  });

  it('SlidingSegmented renders GPU translateX thumb and proper ARIA roles', () => {
    const html = renderToStaticMarkup(
      createElement(TooltipProvider, {
        children: createElement(SlidingSegmented<'a' | 'b'>, {
          ariaLabel: '视图模式',
          role: 'tablist',
          value: 'b',
          onChange: () => {},
          options: [
            { value: 'a', label: '选项一' },
            { value: 'b', label: '选项二' }
          ]
        })
      })
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('ui-segmented-thumb');
    expect(html).toContain('translateX(100%)');
  });

  it('wires ExitGate and unified motion primitives across dialogs, drawers, and popovers', () => {
    expect(read('./board/BoardModals.tsx')).toContain('<ExitGate');
    expect(read('./board/BoardWorkspace.tsx')).toContain('<ExitGate');
    expect(read('./AiTextAssist.tsx')).toContain('<ExitGate');
    expect(read('./PromptTemplates.tsx')).toContain('<ExitGate');
    expect(read('./SessionPane.tsx')).toContain('ui-fab-in');
    expect(read('./Composer.tsx')).toContain('ui-queue-panel');
    expect(read('./Composer.tsx')).toContain('ui-chip-loading');
    expect(read('./Composer.tsx')).toContain('ui-chip-saved');
    expect(read('./App.tsx')).toContain('ui-mobile-scrim');

    const motionCss = read('./motion.css');
    const chipShimmer = extractKeyframesBlock(motionCss, 'ui-chip-shimmer');
    expect(chipShimmer).toContain('transform');
    expect(chipShimmer).not.toContain('box-shadow');
    expect(motionCss).toMatch(/\.ui-chip-loading::after\s*\{\s*display:\s*none;/);
  });
});
