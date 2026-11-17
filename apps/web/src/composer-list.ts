import type { NodeType, ResolvedPos } from '@milkdown/kit/prose/model';
import type { EditorState, Transaction } from '@milkdown/kit/prose/state';
import { liftListItem, sinkListItem, splitListItem } from '@milkdown/kit/prose/schema-list';

/**
 * 光标是否位于列表项内（不要求直接父节点就是 list_item：列表项里可以再包段落）。
 * 输入框只有 Shift+Enter 才换行，所以列表续项也挂在 Shift+Enter 上，不能占用 Enter。
 */
export function listItemDepth($pos: ResolvedPos, listItemType: NodeType): number | undefined {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type === listItemType) return depth;
  }
  return undefined;
}

export function isInListItem(state: EditorState, listItemType: NodeType): boolean {
  return listItemDepth(state.selection.$from, listItemType) !== undefined;
}

function commandTransaction(
  state: EditorState,
  command: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean
): Transaction | null {
  let transaction: Transaction | undefined;
  const handled = command(state, tr => { transaction = tr; });
  return handled && transaction ? transaction : null;
}

/**
 * Shift+Enter 在列表项内续下一项。
 *
 * 空列表项再续项时退出列表，避免留下一个永远没有内容的列表项；这与常见 Markdown
 * 编辑器的「空项回车退出列表」一致。返回 null 表示当前不在列表里或无法拆分，
 * 调用方应把这次按键交回编辑器（普通段落里仍然是 hardbreak）。
 */
export function continueList(state: EditorState, listItemType: NodeType): Transaction | null {
  const { $from, empty } = state.selection;
  if (!empty || !listItemDepth($from, listItemType)) return null;
  if ($from.parent.content.size === 0) return commandTransaction(state, liftListItem(listItemType));
  return commandTransaction(state, splitListItem(listItemType));
}

/** Tab 增加一层，Shift+Tab 减少一层；不在列表里返回 null，保留原有的缩进/焦点行为。 */
export function indentListItem(state: EditorState, listItemType: NodeType, outdent: boolean): Transaction | null {
  if (!isInListItem(state, listItemType)) return null;
  return commandTransaction(state, outdent ? liftListItem(listItemType) : sinkListItem(listItemType));
}

/** 列表项开头手动输入的「2.」「-」「*」等标记；列表本身已经负责渲染这一层标记。 */
const MANUAL_LIST_MARKER = /^(?:\d+\.|[-+*])$/;

/**
 * 续项后用户往往还会手打「2. 」。列表项已经自带编号，再保留这串字就会出现
 * 「2. 2. 第二项」或第二行缩进更深。这里在输入空格时把重复标记删掉，
 * 让用户的第一行、第二行都落在同一个视觉层级。
 *
 * 首个「1. 」不在此处理：输入空格之前当前段落还不在列表项里，交给 Milkdown
 * 原有的 wrapping input rule 转成列表；后续续项才由这里去重。
 */
export function redundantListMarkerTransaction(
  state: EditorState,
  listItemType: NodeType,
  from: number,
  to: number,
  text: string
): Transaction | null {
  if (text !== ' ' || from !== to) return null;
  const { $from } = state.selection;
  if (!listItemDepth($from, listItemType) || !$from.parent.isTextblock) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\n');
  if (!MANUAL_LIST_MARKER.test(before)) return null;
  return state.tr.delete($from.start(), from);
}
