import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Editor, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, prosePluginsCtx, rootCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { history } from '@milkdown/kit/plugin/history';
import { indent } from '@milkdown/kit/plugin/indent';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { trailing } from '@milkdown/kit/plugin/trailing';
import { getMarkdown, replaceAll } from '@milkdown/kit/utils';
import { Plugin, Selection } from '@milkdown/kit/prose/state';
import type { Ctx } from '@milkdown/kit/ctx';
import '@milkdown/kit/prose/view/style/prosemirror.css';

/**
 * 消息输入框的 Markdown 实时编辑。
 *
 * 用 Milkdown（ProseMirror + remark）做真正的所见即所得：正文里不再出现 `#`、`**`、
 * 反引号这些语法标记，输入 `**粗体**`、`# 标题` 时由 input rule 当场变成对应格式，
 * 光标移动也不会把源码「露」出来。发送的仍然是 Markdown（getMarkdown），消息区
 * 照旧用 MarkdownContent 渲染。
 *
 * 没选 Milkdown Crepe 那一层：它的斜杠菜单/顶部工具栏会和本组件已有的 `/` 命令面板、
 * 底栏冲突，而 ProseMirror 的编辑语义与 GFM 支持在 core preset 里已经完整。
 */
export interface ComposerEditorHandle {
  focus(): void;
  /** 光标前当前文本块的纯文本，用于 `/` 查询（不要拿它当 Markdown 偏移）。 */
  textBeforeCaret(): string;
  /** 若光标前是 `/查询`，用 text 就地替换查询部分（保留前导空白），返回是否命中。 */
  replaceSlashWith(text: string): boolean;
  /** 在光标处插入文本；前一个字符不是空白时自动补一个空格。 */
  insertAtCaret(text: string): void;
  getValue(): string;
  setValue(value: string): void;
}

interface ComposerEditorProps {
  value: string;
  /** 可以传带响应式断点的节点，小屏用更短的提示，避免占位文字压住工具栏。 */
  placeholder: ReactNode;
  ariaLabel: string;
  onChange(value: string): void;
  /** 光标前当前文本块的纯文本；`/` 面板用它判断查询词。 */
  onCaretChange(before: string): void;
  /** 返回 true 表示已处理（Enter 发送、命令面板选择等），编辑器会阻止默认行为。 */
  onKeydown(event: KeyboardEvent): boolean;
  onFiles(files: File[]): void;
}

/** 空文档 = 只剩一个空段落；只有图片没有文字时不算空，不该盖住占位提示。 */
function isEmptyDoc(doc: { childCount: number; firstChild: { type: { name: string }; content: { size: number } } | null }): boolean {
  return doc.childCount === 0 || (doc.childCount === 1 && doc.firstChild?.type.name === 'paragraph' && doc.firstChild.content.size === 0);
}

function textBeforeCaret(ctx: Ctx): string {
  const { selection } = ctx.get(editorViewCtx).state;
  const { $from } = selection;
  if (!$from.parent.isTextblock) return '';
  // leafText 传 \n：Shift+Enter 插入的 hardbreak 在草稿里应算作空白，而不是被吞掉。
  return $from.parent.textBetween(0, $from.parentOffset, undefined, '\n');
}

function replaceSlashIn(ctx: Ctx, text: string): boolean {
  const view = ctx.get(editorViewCtx);
  const { state } = view;
  const { selection } = state;
  const { $from } = selection;
  if (!$from.parent.isTextblock) return false;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\n');
  const match = before.match(/(?:^|\s)\/[^\s/]*$/);
  if (!match) return false;
  // 只删 `/query`，保留前面用来分隔的空白（与旧的 textarea 实现一致）。
  const slash = match[0].startsWith('/') ? match[0] : match[0].slice(1);
  const end = selection.from;
  view.dispatch(state.tr.insertText(text, end - slash.length, end).scrollIntoView());
  return true;
}

function insertAtCaretIn(ctx: Ctx, text: string): void {
  const view = ctx.get(editorViewCtx);
  const { state } = view;
  const { from } = state.selection;
  const before = state.selection.$from.parent.isTextblock
    ? state.selection.$from.parent.textBetween(0, state.selection.$from.parentOffset, undefined, '\n')
    : '';
  view.dispatch(state.tr.insertText(before && !/\s$/.test(before) ? ` ${text}` : text, from).scrollIntoView());
}

function caretToEnd(ctx: Ctx): void {
  const view = ctx.get(editorViewCtx);
  view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)).scrollIntoView());
}

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(function ComposerEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const latest = useRef(props);
  latest.current = props;
  // 外部写入（发送后清空、选择命令）期间屏蔽 markdownUpdated，避免自己触发一轮 onChange。
  const suppressing = useRef(false);
  const ready = useRef(false);
  const [empty, setEmpty] = useState(() => !props.value.trim());

  useLayoutEffect(() => {
    const hostElement = host.current;
    if (!hostElement) return;
    // 这个标记必须是每次 effect 自己的局部变量：StrictMode 会 mount→unmount→mount，
    // 若共用 ref，第一次 create() 在重新挂载之后才 resolve，会把「已取消」覆盖成 false，
    // 于是两个编辑器实例都留在 DOM 里。
    let cancelled = false;
    const instance = Editor.make()
      .config(ctx => {
        ctx.set(rootCtx, hostElement);
        ctx.set(defaultValueCtx, latest.current.value);
        // ProseMirror 的根节点是 contenteditable；无障碍名和移动端键盘行为都挂在这里。
        ctx.set(editorViewOptionsCtx, {
          attributes: {
            'aria-label': latest.current.ariaLabel,
            'aria-multiline': 'true',
            spellcheck: 'true'
          }
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(listener)
      .use(history)
      .use(clipboard)
      .use(indent)
      .use(trailing)
      .config(ctx => {
        const manager = ctx.get(listenerCtx);
        manager.markdownUpdated((_ctx, markdown) => {
          if (suppressing.current || cancelled) return;
          latest.current.onChange(markdown);
        });
        manager.updated(ctx => {
          if (cancelled) return;
          latest.current.onCaretChange(textBeforeCaret(ctx));
        });
        manager.selectionUpdated(ctx => {
          if (cancelled) return;
          latest.current.onCaretChange(textBeforeCaret(ctx));
        });
        manager.mounted(ctx => {
          if (cancelled) return;
          ready.current = true;
          setEmpty(isEmptyDoc(ctx.get(editorViewCtx).state.doc));
          latest.current.onCaretChange(textBeforeCaret(ctx));
        });
        // listener 插件的 updated 默认有 200ms debounce，输入后占位符会慢半拍才消失；
        // 这里用 ProseMirror 的同步更新钩子，每次文档事务立即同步空状态。
        const emptyTracker = new Plugin({
          view: view => ({
            update: (nextView, prevState) => {
              if (cancelled || prevState.doc.eq(nextView.state.doc)) return;
              setEmpty(isEmptyDoc(nextView.state.doc));
            }
          })
        });
        ctx.update(prosePluginsCtx, plugins => [...plugins, emptyTracker]);
      });

    void instance.create().then(created => {
      if (cancelled) { void created.destroy(); return; }
      editor.current = created;
    });

    return () => {
      cancelled = true;
      ready.current = false;
      const created = editor.current;
      editor.current = null;
      // create() 还没 resolve 时由上面的 then 负责销毁。
      if (created) void created.destroy();
    };
  }, []);

  // 外部值变化（发送后清空、退回队列、选择命令）同步进编辑器。自己触发的 onChange 不回灌。
  useEffect(() => {
    const instance = editor.current;
    if (!instance || !ready.current) return;
    if (instance.action(getMarkdown()) === props.value) return;
    suppressing.current = true;
    instance.action(replaceAll(props.value));
    instance.action(caretToEnd);
    suppressing.current = false;
  }, [props.value]);

  useImperativeHandle(ref, () => ({
    focus: () => { editor.current?.action(ctx => ctx.get(editorViewCtx).focus()); },
    textBeforeCaret: () => editor.current?.action(textBeforeCaret) ?? latest.current.value,
    replaceSlashWith: text => editor.current?.action(ctx => replaceSlashIn(ctx, text)) ?? false,
    insertAtCaret: text => { editor.current?.action(ctx => insertAtCaretIn(ctx, text)); },
    getValue: () => editor.current?.action(getMarkdown()) ?? latest.current.value,
    setValue: value => {
      const instance = editor.current;
      if (!instance) { latest.current.onChange(value); return; }
      suppressing.current = true;
      instance.action(replaceAll(value));
      instance.action(caretToEnd);
      suppressing.current = false;
      // markdownUpdated 被屏蔽了，这里显式回灌一次，父级的受控 value 才能跟上。
      latest.current.onChange(value);
    }
  }), []);

  return <div ref={host} className="composer-editor" onKeyDownCapture={event => {
    // 捕获阶段先于 ProseMirror 的 keymap：Enter 发送、Shift+Enter 换行（交给编辑器）。
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (!latest.current.onKeydown(event.nativeEvent)) return;
    event.preventDefault();
    event.stopPropagation();
  }} onPasteCapture={event => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    latest.current.onFiles(files);
  }} onDropCapture={event => {
    const files = event.dataTransfer?.files;
    if (!files?.length) return;
    event.preventDefault();
    event.stopPropagation();
    latest.current.onFiles(Array.from(files));
  }} onDragOverCapture={event => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
  }}>
    {empty && <div className="composer-editor-placeholder" aria-hidden="true">{props.placeholder}</div>}
  </div>;
});
