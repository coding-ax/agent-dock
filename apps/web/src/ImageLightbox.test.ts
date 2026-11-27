import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { clampLightboxIndex, resolveLightboxSlides } from './ImageLightbox';

const sourceDir = dirname(fileURLToPath(import.meta.url));

describe('ImageLightbox helpers', () => {
  it('resolves slides array when present, falling back to single src/alt', () => {
    expect(resolveLightboxSlides([{ src: '/a.png', alt: 'A' }, { src: '/b.png' }], '/ignored.png', 'X')).toEqual([
      { src: '/a.png', alt: 'A' },
      { src: '/b.png' }
    ]);
    expect(resolveLightboxSlides([], '/single.png', 'shot.png')).toEqual([
      { src: '/single.png', alt: 'shot.png' }
    ]);
    expect(resolveLightboxSlides(undefined, undefined, undefined)).toEqual([]);
  });

  it('clamps active index safely within slide bounds', () => {
    expect(clampLightboxIndex(0, 0)).toBe(0);
    expect(clampLightboxIndex(-3, 4)).toBe(0);
    expect(clampLightboxIndex(1.9, 4)).toBe(1);
    expect(clampLightboxIndex(99, 4)).toBe(3);
    expect(clampLightboxIndex(Number.NaN, 4)).toBe(0);
  });
});

describe('ImageLightbox 样式与交互回归守卫', () => {
  const tsx = readFileSync(join(sourceDir, 'ImageLightbox.tsx'), 'utf8');
  const css = readFileSync(join(sourceDir, 'ImageLightbox.css'), 'utf8');
  const indexCss = readFileSync(join(sourceDir, 'index.css'), 'utf8');

  it('ImageLightbox.css 紧跟 yarl 默认样式懒加载，且主样式表不再残留 !important 补丁', () => {
    const yarlImportIdx = tsx.indexOf("import 'yet-another-react-lightbox/styles.css';");
    const customImportIdx = tsx.indexOf("import './ImageLightbox.css';");
    expect(yarlImportIdx).toBeGreaterThan(-1);
    expect(customImportIdx).toBeGreaterThan(yarlImportIdx);
    expect(indexCss).not.toContain('.yarl__button:hover');
  });

  it('重置 yarl 按钮与左右切换按钮的 padding 为 0 并用 flex 居中，杜绝 40×48 椭圆畸变与图标偏移', () => {
    expect(css).toContain('--yarl__navigation_button_padding: 0;');
    expect(css).toContain('--yarl__button_padding: 0;');
    expect(css).toContain('--yarl__button_filter: none;');
    expect(css).toMatch(/\.ad-lightbox \.yarl__button\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s);
    expect(css).toMatch(/\.ad-lightbox \.yarl__button\s*\{[^}]*padding:\s*0;[^}]*filter:\s*none;/s);
    expect(css).toMatch(/\.ad-lightbox \.yarl__navigation_prev,\s*\.ad-lightbox \.yarl__navigation_next\s*\{[^}]*width:\s*40px;[^}]*height:\s*40px;[^}]*padding:\s*0;/s);
  });

  it('左右切换按钮留出安全视口边距，按压态保留 translateY(-50%) 不跳动', () => {
    expect(css).toMatch(/\.ad-lightbox \.yarl__navigation_prev\s*\{\s*left:\s*max\(20px,\s*env\(safe-area-inset-left\)\);/);
    expect(css).toMatch(/\.ad-lightbox \.yarl__navigation_next\s*\{\s*right:\s*max\(20px,\s*env\(safe-area-inset-right\)\);/);
    expect(css).toContain('transform: translateY(-50%) scale(0.94);');
    expect(css).toContain('@media (max-width: 639px)');
    expect(css).toContain('html[data-theme="dark"] .ad-lightbox .yarl__container');
  });

  it('单图预览隐藏左右切换箭头，并支持点击遮罩关闭且使用 Lucide 图标', () => {
    expect(tsx).toContain('buttonPrev: hasMultiple ? undefined : () => null');
    expect(tsx).toContain('buttonNext: hasMultiple ? undefined : () => null');
    expect(tsx).toContain('closeOnBackdropClick: true');
    expect(tsx).toContain("from 'lucide-react'");
    // 不再用 inline styles.button 硬写 width/height 触发与 yarl 默认 padding 的冲突
    expect(tsx).not.toMatch(/styles=\{\{[\s\S]*button:/);
  });
});
