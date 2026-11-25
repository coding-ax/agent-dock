import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

describe('移动端主会话顶栏与响应式隐藏守卫', () => {
  it('companion.css / lifecycle.css 仅用 :where() 声明 display，不覆盖 Tailwind hidden 且不被 button preflight 吞掉视觉样式', () => {
    const companionCss = read('companion.css');
    const lifecycleCss = read('lifecycle.css');

    // companion.css 晚于 @tailwind utilities 加载，裸类上的 display 会压过 max-md:hidden / max-lg:hidden；
    // 同时视觉样式保留在常规类上，避免被 Tailwind preflight 的 button reset (0,0,1) 覆盖。
    expect(companionCss).toContain(':where(.ui-status-chip) { display: inline-flex; }');
    expect(companionCss).not.toMatch(/^\.ui-status-chip\s*\{[^}]*\bdisplay\s*:/m);

    expect(companionCss).toContain(':where(.ui-note-action) { display: inline-flex; }');
    expect(companionCss).not.toMatch(/^\.ui-note-action\s*\{[^}]*\bdisplay\s*:/m);

    expect(lifecycleCss).toContain(':where(.ui-stage-chip) { display: inline-flex; }');
    expect(lifecycleCss).not.toMatch(/^\.ui-stage-chip\s*\{[^}]*\bdisplay\s*:/m);

    expect(lifecycleCss).toContain(':where(.ui-handoff-flag) { display: inline-flex; }');
    expect(lifecycleCss).not.toMatch(/^\.ui-handoff-flag\s*\{[^}]*\bdisplay\s*:/m);
  });

  it('主会话顶栏在窄屏下隐藏状态胶囊与次要徽章，且标题容器裁切防溢出', () => {
    const header = read('CompanionHeader.tsx');

    expect(header).toContain('className="ui-status-chip max-md:hidden"');
    expect(header).toContain('<div className="min-w-0 flex-1 overflow-hidden">');
    expect(header).toContain('max-sm:hidden">主会话</span>');
    expect(header).toContain('max-sm:hidden"><StageChip lifecycle={info.lifecycle}/></span>');
  });

  it('普通会话顶栏标题容器同样具备 overflow-hidden 防窄屏溢出', () => {
    const sessionPane = read('../SessionPane.tsx');
    expect(sessionPane).toContain('<div className="min-w-0 flex-1 overflow-hidden">');
  });
});
