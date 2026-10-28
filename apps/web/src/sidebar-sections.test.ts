import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTION_ORDER, normalizeSectionOrder, reorderSections, type SidebarSectionKey } from './sidebar-sections';

describe('normalizeSectionOrder', () => {
  it('默认顺序是最近在前', () => {
    expect(normalizeSectionOrder(DEFAULT_SECTION_ORDER)).toEqual(['recent', 'projects']);
  });

  it('丢掉未知项与重复项，补齐缺失的分区', () => {
    expect(normalizeSectionOrder(['projects', 'projects', 'bogus'])).toEqual(['projects', 'recent']);
    expect(normalizeSectionOrder(['projects', 'recent'])).toEqual(['projects', 'recent']);
  });

  it('非数组（旧值 / 手改 / null）回落到默认顺序，不抛错', () => {
    expect(normalizeSectionOrder(undefined)).toEqual(['recent', 'projects']);
    expect(normalizeSectionOrder('recent')).toEqual(['recent', 'projects']);
    expect(normalizeSectionOrder({ recent: 1 })).toEqual(['recent', 'projects']);
  });
});

describe('reorderSections', () => {
  it('两块互换', () => {
    expect(reorderSections(['recent', 'projects'], 'recent', 'projects')).toEqual(['projects', 'recent']);
    expect(reorderSections(['projects', 'recent'], 'projects', 'recent')).toEqual(['recent', 'projects']);
  });

  it('拖到自己身上不改变顺序', () => {
    expect(reorderSections(['recent', 'projects'], 'projects', 'projects')).toEqual(['recent', 'projects']);
  });

  it('脏输入先被归一化，且永远补齐两块', () => {
    expect(reorderSections(['bogus'] as unknown as SidebarSectionKey[], 'recent', 'projects')).toEqual(['projects', 'recent']);
    expect(reorderSections(['recent', 'projects'], 'nope' as never, 'projects')).toEqual(['recent', 'projects']);
  });
});
