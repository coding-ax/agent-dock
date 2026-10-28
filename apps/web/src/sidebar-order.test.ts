import { describe, expect, it } from 'vitest';
import { EMPTY_ITEM_ORDER, applyOrder, moveInList, normalizeItemOrder } from './sidebar-order';

describe('normalizeItemOrder', () => {
  it('丢非字符串、非数组、非对象，保留合法形状', () => {
    expect(normalizeItemOrder({ workspaces: ['/a', 1, null], agents: { '/a': ['codex', 2] }, sessions: 'nope' }))
      .toEqual({ workspaces: ['/a'], agents: { '/a': ['codex'] }, sessions: {} });
  });

  it('脏值（null / 数组 / 字符串）一律回落成空顺序，不抛错', () => {
    expect(normalizeItemOrder(undefined)).toEqual(EMPTY_ITEM_ORDER);
    expect(normalizeItemOrder(['/a'])).toEqual(EMPTY_ITEM_ORDER);
    expect(normalizeItemOrder('oops')).toEqual(EMPTY_ITEM_ORDER);
  });
});

describe('moveInList', () => {
  it('按目标原下标插入', () => {
    expect(moveInList(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(moveInList(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
  });

  it('拖自己、或 id 不在列表里都原样返回', () => {
    expect(moveInList(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']);
    expect(moveInList(['a', 'b'], 'z', 'a')).toEqual(['a', 'b']);
    expect(moveInList(['a', 'b'], 'a', 'z')).toEqual(['a', 'b']);
  });
});

describe('applyOrder', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const keyOf = (item: { id: string }) => item.id;

  it('没排过就保持默认序', () => {
    expect(applyOrder(items, undefined, keyOf)).toEqual(items);
    expect(applyOrder(items, [], keyOf)).toEqual(items);
  });

  it('排过的按保存顺序，未排过的新项按默认序放到最前', () => {
    // 保存了 b、a 的顺序；c 是新项（默认序里排最后，但新项要浮到最前）
    expect(applyOrder(items, ['b', 'a'], keyOf).map(item => item.id)).toEqual(['c', 'b', 'a']);
  });

  it('保存的 id 全部失效时退回默认序，而不是清空列表', () => {
    expect(applyOrder(items, ['gone'], keyOf)).toEqual(items);
  });
});

