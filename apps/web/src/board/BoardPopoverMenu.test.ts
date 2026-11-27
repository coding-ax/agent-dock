import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeBoardPopoverPosition } from './BoardPopoverMenu';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('BoardPopoverMenu positioning & stacking regression guards', () => {
  it('aligns top-right board menu cleanly below the header trigger on desktop', () => {
    const pos = computeBoardPopoverPosition(
      { top: 8, bottom: 40, right: 1424 },
      { width: 208, height: 184 },
      { width: 1440, height: 900 }
    );
    expect(pos).toEqual({ top: 46, left: 1216, flipped: false });
    expect(pos.left + 208).toBeLessThanOrEqual(1440 - 8);
  });

  it('clamps horizontally inside a 390x844 mobile viewport without clipping', () => {
    const posRight = computeBoardPopoverPosition(
      { top: 8, bottom: 40, right: 386 },
      { width: 208, height: 184 },
      { width: 390, height: 844 }
    );
    expect(posRight.left).toBe(390 - 208 - 8);
    expect(posRight.left + 208).toBeLessThanOrEqual(390 - 8);
    expect(posRight.flipped).toBe(false);

    const posLeft = computeBoardPopoverPosition(
      { top: 8, bottom: 40, right: 80 },
      { width: 208, height: 184 },
      { width: 390, height: 844 }
    );
    expect(posLeft.left).toBe(8);
  });

  it('flips upward when opened near the bottom of the viewport', () => {
    const pos = computeBoardPopoverPosition(
      { top: 820, bottom: 844, right: 620 },
      { width: 192, height: 220 },
      { width: 1440, height: 900 }
    );
    expect(pos.flipped).toBe(true);
    expect(pos.top).toBe(820 - 6 - 220);
    expect(pos.left).toBe(620 - 192);
  });

  it('portals all board dropdown menus to document.body and lifts board header above columns', () => {
    const popoverSrc = read('./BoardPopoverMenu.tsx');
    const workspaceSrc = read('./BoardWorkspace.tsx');
    const columnSrc = read('./BoardColumn.tsx');
    const cardSrc = read('./BoardCard.tsx');

    // Portal 到 document.body，彻底隔离 header backdrop-blur 层叠上下文与列/卡容器 overflow 裁切。
    expect(popoverSrc).toContain('createPortal(');
    expect(popoverSrc).toContain('document.body');
    expect(popoverSrc).toContain('<ExitGate open={open} ms={150}>');

    // 看板顶栏带 relative z-30 且菜单通过 BoardPopoverMenu 渲染。
    expect(workspaceSrc).toMatch(/<header\s+className="relative z-30 [^"]*backdrop-blur-sm/);
    expect(workspaceSrc).toContain('<BoardPopoverMenu');
    expect(columnSrc).toContain('<BoardPopoverMenu');
    expect(cardSrc).toContain('<BoardPopoverMenu');
  });
});
