import { describe, expect, it } from 'vitest';
import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { continueList, indentListItem, isInListItem, redundantListMarkerTransaction } from './composer-list';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    ordered_list: { content: 'list_item+', group: 'block', attrs: { order: { default: 1 } } },
    bullet_list: { content: 'list_item+', group: 'block' },
    list_item: { content: 'paragraph block*', defining: true }
  }
});

const listItemType = schema.nodes.list_item!;

const paragraph = (text = '') => schema.node('paragraph', null, text ? [schema.text(text)] : []);
const item = (text = '') => schema.node('list_item', null, [paragraph(text)]);
const ordered = (...items: PMNode[]) => schema.node('ordered_list', { order: 1 }, items);
const bullet = (...items: PMNode[]) => schema.node('bullet_list', null, items);
const doc = (...blocks: PMNode[]) => schema.node('doc', null, blocks);

function cursorAfter(node: PMNode, needle: string): EditorState {
  let position: number | undefined;
  node.descendants((child, pos) => {
    if (position !== undefined) return false;
    if (child.isText && child.text?.includes(needle)) {
      position = pos + child.text.indexOf(needle) + needle.length;
      return false;
    }
    return true;
  });
  if (position === undefined) throw new Error(`找不到文本：${needle}`);
  return EditorState.create({ doc: node, selection: TextSelection.create(node, position) });
}

describe('composer 列表编辑', () => {
  it('Shift+Enter 在有序列表里续出同级的下一项', () => {
    const state = cursorAfter(doc(ordered(item('第一项'))), '第一项');
    const transaction = continueList(state, listItemType);
    expect(transaction).not.toBeNull();

    const next = state.apply(transaction!);
    const list = next.doc.child(0);
    expect(list.type.name).toBe('ordered_list');
    expect(list.childCount).toBe(2);
    expect(list.child(0).textContent).toBe('第一项');
    expect(list.child(1).textContent).toBe('');
  });

  it('Shift+Enter 在无序列表里续出同级的下一项', () => {
    const state = cursorAfter(doc(bullet(item('第一项'))), '第一项');
    const transaction = continueList(state, listItemType);
    expect(transaction).not.toBeNull();

    const next = state.apply(transaction!);
    const list = next.doc.child(0);
    expect(list.type.name).toBe('bullet_list');
    expect(list.childCount).toBe(2);
    expect(list.child(0).textContent).toBe('第一项');
    expect(list.child(1).textContent).toBe('');
  });

  it('Tab 把第二项下沉为子列表，Shift+Tab 再抬回同级', () => {
    const state = cursorAfter(doc(ordered(item('第一项'), item('第二项'))), '第二项');
    const sink = indentListItem(state, listItemType, false);
    expect(sink).not.toBeNull();

    const nested = state.apply(sink!);
    const list = nested.doc.child(0);
    expect(list.childCount).toBe(1);
    expect(list.child(0).textContent).toBe('第一项第二项');
    expect(list.child(0).child(1).type.name).toBe('ordered_list');
    expect(list.child(0).child(1).child(0).textContent).toBe('第二项');

    const lift = indentListItem(nested, listItemType, true);
    expect(lift).not.toBeNull();
    const flat = nested.apply(lift!);
    expect(flat.doc.child(0).childCount).toBe(2);
    expect(flat.doc.child(0).child(1).textContent).toBe('第二项');
  });

  it('续项后手打的「2.」会删掉，不再叠在列表自带的编号上', () => {
    const state = cursorAfter(doc(ordered(item('2.'))), '2.');
    expect(isInListItem(state, listItemType)).toBe(true);

    const transaction = redundantListMarkerTransaction(state, listItemType, state.selection.from, state.selection.to, ' ');
    expect(transaction).not.toBeNull();
    const next = state.apply(transaction!);
    expect(next.doc.child(0).child(0).textContent).toBe('');
    expect(next.doc.child(0).childCount).toBe(1);
  });

  it('续项后手打的「-」同样会删掉', () => {
    const state = cursorAfter(doc(bullet(item('-'))), '-');
    const transaction = redundantListMarkerTransaction(state, listItemType, state.selection.from, state.selection.to, ' ');
    expect(transaction).not.toBeNull();
    expect(state.apply(transaction!).doc.child(0).child(0).textContent).toBe('');
  });

  it('普通段落开头的「1.」仍留给 Milkdown 的自动列表规则处理', () => {
    const state = cursorAfter(doc(paragraph('1.')), '1.');
    expect(isInListItem(state, listItemType)).toBe(false);
    expect(redundantListMarkerTransaction(state, listItemType, state.selection.from, state.selection.to, ' ')).toBeNull();
  });
});
