import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 全局 loading 守卫。
 *
 * 顶部扫描条曾经在 opacity-0 时仍持续播放循环动画，页面空闲时也无法静止；
 * 而且它和会话顶栏共用 .ui-topbar，给顶栏加上了背景色与无限动画。
 * 这类问题不会让构建失败，用源码级别的回归测试盯住两个约束。
 */
const sourceDir = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(sourceDir, name), 'utf8');

describe('全局 loading 语言', () => {
  it('不再挂载顶部循环进度条', () => {
    expect(read('App.tsx')).not.toContain('TopProgressBar');
    expect(read('Loaders.tsx')).not.toContain('TopProgressBar');
    expect(read('Loaders.tsx')).not.toContain('useIsFetching');
    expect(read('index.css')).not.toContain('@keyframes ui-topbar');
    expect(read('index.css')).not.toContain('.ui-topbar');
  });

  it('会话顶栏使用独立类名并保留移动端安全区尺寸', () => {
    expect(read('SessionPane.tsx')).toContain('ui-session-topbar');
    const css = read('index.css');
    expect(css).toContain('.ui-session-topbar');
    expect(css).toContain('height: calc(52px + env(safe-area-inset-top))');
    expect(css).toContain('padding-top: env(safe-area-inset-top)');
  });
});
