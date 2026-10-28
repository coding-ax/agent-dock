import { describe, expect, it } from 'vitest';

/**
 * useSyncFormFromRemote 的触发口径。hook 本身依赖 React，node 环境跑不了，
 * 这里把判定条件本身固化成用例——它正是出过 bug 的地方。
 */
const shouldHydrate = (source: unknown) => source != null;

// App.tsx 里传给 hook 的 source 表达式
const hydrationSource = (configLoaded: boolean, selectedAppId: string | null) =>
  configLoaded && selectedAppId !== null ? selectedAppId : null;

describe('lark config form hydration gate', () => {
  it('hydrates the form when switching to an existing bot', () => {
    expect(shouldHydrate(hydrationSource(true, 'cli_a'))).toBe(true);
  });

  it('hydrates when the user starts a new bot draft', () => {
    // 「新增机器人」用空串表示。按 truthy 判定会跳过灌入，
    // 表单残留上一个机器人的 App ID / 工作区，保存时可能覆盖错对象。
    expect(hydrationSource(true, '')).toBe('');
    expect(shouldHydrate(hydrationSource(true, ''))).toBe(true);
  });

  it('waits while the config request is still in flight', () => {
    expect(shouldHydrate(hydrationSource(false, null))).toBe(false);
    expect(shouldHydrate(hydrationSource(false, 'cli_a'))).toBe(false);
  });

  it('waits before the first selection is decided', () => {
    expect(shouldHydrate(hydrationSource(true, null))).toBe(false);
  });
});
