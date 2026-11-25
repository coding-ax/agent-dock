import { describe, expect, it } from 'vitest';
import {
  composeQuotedMessage,
  computeSelectionPopoverPosition,
  formatQuoteBlock,
  normalizeQuotedText,
  resolveAssistantSelection
} from './selection-quote';

describe('selection quote formatting', () => {
  it('normalizes line endings, trims surrounding whitespace, and collapses excessive blank lines', () => {
    expect(normalizeQuotedText('  第一行\r\n\r\n\r\n第二行  \n')).toBe('第一行\n\n第二行');
    expect(normalizeQuotedText('   \n\t  ')).toBe('');
  });

  it('formats single-line and multi-paragraph quotes as a contiguous markdown blockquote', () => {
    expect(formatQuoteBlock('关键结论如下')).toBe('> 关键结论如下');
    expect(formatQuoteBlock('第一段\n\n第二段')).toBe('> 第一段\n>\n> 第二段');
    expect(formatQuoteBlock('   ')).toBe('');
  });

  it('composes quoted text before the user reply', () => {
    expect(composeQuotedMessage('需要排查缓存失效', '帮我展开讲讲这一步'))
      .toBe('> 需要排查缓存失效\n\n帮我展开讲讲这一步');
    expect(composeQuotedMessage(undefined, '普通消息')).toBe('普通消息');
    expect(composeQuotedMessage('仅引用', '   ')).toBe('> 仅引用');
  });
});

describe('selection popover positioning', () => {
  const viewport = { width: 1200, height: 800 };
  const popoverSize = { width: 96, height: 34 };

  it('places the popover centered above the selection when space permits', () => {
    const pos = computeSelectionPopoverPosition({
      selectionRect: { top: 240, bottom: 262, left: 400, right: 520, width: 120, height: 22 },
      popoverSize,
      viewport,
      bounds: { top: 52, bottom: 720, left: 0, right: 1200 }
    });
    expect(pos).toEqual({ left: 412, top: 198, placement: 'top' });
  });

  it('flips below the selection when above space is insufficient relative to container top bounds', () => {
    const pos = computeSelectionPopoverPosition({
      selectionRect: { top: 64, bottom: 86, left: 400, right: 520, width: 120, height: 22 },
      popoverSize,
      viewport,
      bounds: { top: 52, bottom: 720, left: 0, right: 1200 }
    });
    expect(pos).toEqual({ left: 412, top: 94, placement: 'bottom' });
  });

  it('clamps horizontally inside the viewport on narrow or edge selections', () => {
    const leftEdge = computeSelectionPopoverPosition({
      selectionRect: { top: 200, bottom: 220, left: 4, right: 34, width: 30, height: 20 },
      popoverSize,
      viewport: { width: 375, height: 667 }
    });
    expect(leftEdge.left).toBe(12);

    const rightEdge = computeSelectionPopoverPosition({
      selectionRect: { top: 200, bottom: 220, left: 340, right: 372, width: 32, height: 20 },
      popoverSize,
      viewport: { width: 375, height: 667 }
    });
    expect(rightEdge.left).toBe(375 - 96 - 12);
  });
});

describe('resolveAssistantSelection', () => {
  function makeMockNode({ insideContainer, insideAssistant }: { insideContainer: boolean; insideAssistant: boolean }) {
    const assistantEl = insideAssistant ? ({ __assistant: true } as unknown as Element) : null;
    const parentEl = {
      closest: (selector: string) => (selector === '[data-assistant-output]' ? assistantEl : null)
    } as unknown as Element;
    const textNode = {
      nodeType: 3,
      parentElement: parentEl
    } as unknown as Node;
    const container = {
      contains: (node: Node | null) => {
        if (!insideContainer) return false;
        return node === parentEl || node === assistantEl;
      },
      getBoundingClientRect: () => ({ top: 52, bottom: 700, left: 0, right: 900, width: 900, height: 648 })
    } as unknown as HTMLElement;
    return { textNode, container };
  }

  function makeSelection(text: string, node: Node, rect = { top: 200, bottom: 220, left: 100, right: 260, width: 160, height: 20 }, collapsed = false) {
    return {
      isCollapsed: collapsed,
      rangeCount: 1,
      toString: () => text,
      getRangeAt: () => ({
        startContainer: node,
        endContainer: node,
        getBoundingClientRect: () => rect
      })
    } as unknown as Selection;
  }

  it('returns target when selection is inside assistant output within container', () => {
    const { textNode, container } = makeMockNode({ insideContainer: true, insideAssistant: true });
    const result = resolveAssistantSelection(makeSelection('  Agent 回答片段  ', textNode), container);
    expect(result).toEqual({
      text: 'Agent 回答片段',
      rect: { top: 200, bottom: 220, left: 100, right: 260, width: 160, height: 20 }
    });
  });

  it('returns null when selection is outside assistant output (e.g. user bubble)', () => {
    const { textNode, container } = makeMockNode({ insideContainer: true, insideAssistant: false });
    expect(resolveAssistantSelection(makeSelection('用户自己的消息', textNode), container)).toBeNull();
  });

  it('returns null when selection is collapsed, blank, outside container, or scrolled out of view', () => {
    const { textNode, container } = makeMockNode({ insideContainer: true, insideAssistant: true });
    expect(resolveAssistantSelection(makeSelection('text', textNode, undefined, true), container)).toBeNull();
    expect(resolveAssistantSelection(makeSelection('   \n  ', textNode), container)).toBeNull();
    expect(resolveAssistantSelection(makeSelection('scrolled out', textNode, { top: -40, bottom: 10, left: 100, right: 200, width: 100, height: 50 }), container)).toBeNull();

    const outside = makeMockNode({ insideContainer: false, insideAssistant: true });
    expect(resolveAssistantSelection(makeSelection('other pane', outside.textNode), outside.container)).toBeNull();
  });
});
