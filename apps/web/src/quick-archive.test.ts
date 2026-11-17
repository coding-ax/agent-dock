import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createQuickArchiveController, type QuickArchiveSnapshot } from './quick-archive';

const setup = (archiveImpl?: (sessionId: string) => Promise<unknown>) => {
  const archive = vi.fn(archiveImpl ?? (async (_sessionId: string): Promise<unknown> => undefined));
  const states: QuickArchiveSnapshot[] = [];
  const controller = createQuickArchiveController({ archive, onChange: state => states.push(state) });
  return { controller, states, archive };
};

describe('quickArchiveController', () => {
  it('点菜单里的归档只打开确认框，不调用归档接口', () => {
    const { controller, states, archive } = setup();
    controller.open('s1');
    expect(controller.snapshot()).toEqual({ status: 'confirming', sessionId: 's1' });
    expect(states.at(-1)).toEqual({ status: 'confirming', sessionId: 's1' });
    expect(archive).not.toHaveBeenCalled();
  });

  it('取消关闭确认框，不调用归档接口', () => {
    const { controller, states, archive } = setup();
    controller.open('s1');
    controller.cancel();
    expect(controller.snapshot()).toEqual({ status: 'closed' });
    expect(states.at(-1)).toEqual({ status: 'closed' });
    expect(archive).not.toHaveBeenCalled();
  });

  it('确认后调用现有归档接口，成功后关闭确认框', async () => {
    const { controller, archive } = setup();
    controller.open('s1');
    await controller.confirm();
    expect(archive).toHaveBeenCalledTimes(1);
    expect(archive).toHaveBeenCalledWith('s1');
    expect(controller.snapshot()).toEqual({ status: 'closed' });
  });

  it('归档失败时保留确认框并带上失败原因，允许重试', async () => {
    const { controller, archive } = setup(async () => { throw new Error('停止会话失败，请稍后再试'); });
    controller.open('s1');
    await controller.confirm();
    expect(controller.snapshot()).toEqual({ status: 'error', sessionId: 's1', message: '停止会话失败，请稍后再试' });

    archive.mockResolvedValueOnce(undefined);
    await controller.confirm();
    expect(archive).toHaveBeenCalledTimes(2);
    expect(controller.snapshot()).toEqual({ status: 'closed' });
  });

  it('请求在飞时重复确认只发一次，且不能取消或换目标', async () => {
    let resolveArchive: (() => void) | undefined;
    const { controller, archive } = setup(() => new Promise<void>(resolve => { resolveArchive = resolve; }));
    controller.open('s1');

    const first = controller.confirm();
    const second = controller.confirm();
    controller.open('s2');
    controller.cancel();
    expect(archive).toHaveBeenCalledTimes(1);
    expect(controller.snapshot()).toEqual({ status: 'archiving', sessionId: 's1' });

    resolveArchive?.();
    await Promise.all([first, second]);
    expect(controller.snapshot()).toEqual({ status: 'closed' });
  });
});

describe('侧栏接线', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const app = readFileSync(join(here, 'App.tsx'), 'utf8');

  it('行内不再有归档/重命名按钮，右键菜单归档只负责打开确认框', () => {
    expect(app).not.toContain('SessionArchiveButton');
    expect(app).not.toContain('onArchiveRequest');
    expect(app).not.toContain('归档会话：');
    expect(app).not.toContain('aria-label="重命名会话');
    expect(app).toContain('onArchive={() => { setSessionMenu(undefined); quickArchiveController.open(session.id); }}');
    expect(app).toContain('onConfirm={() => void quickArchiveController.confirm()}');
    expect(app).toContain('onCancel={() => quickArchiveController.cancel()}');
  });

  it('确认框说明归档只是移入归档区、不删除记录', () => {
    expect(app).toContain('历史消息和执行记录都会保留，不会被删除');
    expect(app).toContain('「归档会话」中找回并查看');
    expect(app).toContain("error={quickArchive.status === 'error' ? quickArchive.message : undefined}");
  });

  it('普通行的时间不再为了 hover 图标淡出/消失', () => {
    expect(app).not.toContain('group-hover:opacity-0');
    expect(app).not.toContain('group-focus-visible:opacity-0');
  });
});
