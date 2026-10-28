import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 提示一致性守卫。
 *
 * 应用里有两套提示：自己的 HoverTooltip（样式统一、120ms、贴边翻转、可键盘聚焦）和原生
 * title（约 1 秒延迟、样式跟随系统、无法限宽）。图标按钮上等着原生提示等于没有提示——
 * 用户不敢点自己认不出的图标，这正是之前反馈的问题。
 *
 * 这条测试盯住「别再有图标按钮退回原生 title」。它扫源码而不是渲染组件：这类约定一旦
 * 破了不会有任何报错，只会在别人机器上表现为「hover 没反应」。
 */
const sourceDir = dirname(fileURLToPath(import.meta.url));
const files = [
  'ui-controls.tsx',
  'App.tsx',
  'PaneHost.tsx',
  'SessionPane.tsx',
  'TerminalPanel.tsx',
  'FileExplorerPanel.tsx',
  'Composer.tsx'
];

const read = (name: string) => readFileSync(join(sourceDir, name), 'utf8');

/** 只关心「按钮类」元素上的 title；truncate 用的 title（文本溢出显示全文）不算。 */
const buttonTitlePattern = /<(?:button|span)[^>]*\b(?:role="button"|aria-label=)[^>]*\btitle="/g;

describe('提示一致性', () => {
  it('图标按钮不再用原生 title 承载提示', () => {
    const offenders: string[] = [];
    for (const name of files) {
      const source = read(name);
      for (const match of source.matchAll(buttonTitlePattern)) {
        // 取所在行，便于报错时定位。
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${name}:${line}`);
      }
    }
    expect(offenders, `这些按钮还在用原生 title，应改用 HoverTooltip：${offenders.join(', ')}`).toEqual([]);
  });

  it('IconButton 内部走 HoverTooltip —— 它是绝大多数图标按钮的来源', () => {
    const source = read('ui-controls.tsx');
    expect(source).toContain("import { HoverTooltip } from './HoverTooltip'");
    expect(source).toContain('<HoverTooltip content={label}>');
    // 不能同时留着原生 title，否则浏览器会弹第二个提示（两个提示叠在一起更糟）。
    expect(source).not.toMatch(/<button[^>]*\btitle=\{label\}/);
  });
});
