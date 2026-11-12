import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Editor, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, parserCtx, prosePluginsCtx, rootCtx, schemaCtx } from '@milkdown/kit/core';
import { commonmark, linkSchema, wrapInBulletListInputRule, wrapInOrderedListInputRule } from '@milkdown/kit/preset/commonmark';
import { gfm, wrapInTaskListInputRule } from '@milkdown/kit/preset/gfm';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { history } from '@milkdown/kit/plugin/history';
import { indent } from '@milkdown/kit/plugin/indent';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { trailing } from '@milkdown/kit/plugin/trailing';
import { getMarkdown, replaceAll } from '@milkdown/kit/utils';
import { Plugin, Selection } from '@milkdown/kit/prose/state';
import { DOMParser, DOMSerializer } from '@milkdown/kit/prose/model';
import type { Ctx } from '@milkdown/kit/ctx';
import { linkedPasteToken, needsPasteSeparator, pastedLink } from './composer-paste';
import '@milkdown/kit/prose/view/style/prosemirror.css';

/**
 * 输入框里**不**启用「打字自动变成列表」的 input rule。
 *
 * 这个输入框的 Enter 已经绑定「发送」（见 Composer.keyboard），只有 Shift+Enter 才是换行。
 * 而 Milkdown 输入 `2. ` 会立刻把这一行包成有序列表，接着换行时列表项被拆开、编号
 * 重新计算，用户看到的就是「2. 3. 掉下去」。列表在这里没有编辑价值（一条消息里的编号
 * 用纯文本 `2. ` 表达即可，发给 Agent 后照样按 Markdown 渲染），干脆从源头上不让它变形。
 * 保留 # 标题、`**粗体**`、``` 围栏等其余 input rule；粘贴/外部 setValue 进来的
 * 列表 Markdown 仍会正常解析显示，只是不再因为「打字」而自动套列表结构。
 */
const disabledListInputRules = new Set([wrapInOrderedListInputRule, wrapInBulletListInputRule, wrapInTaskListInputRule]);
// 链接 mark 设成 inclusive:false：光标停在链接末尾继续打字时不会自动继承 link mark，
// 粘贴进来的新文字也不会被塞进上一枚链接里（这是「贴到链接后面」粘成一团的另一半原因）。
const exclusiveLinkSchema = linkSchema.extendSchema(base => ctx => ({ ...base(ctx), inclusive: false }));
const composerCommonmark = commonmark
  .filter(plugin => !disabledListInputRules.has(plugin as typeof wrapInOrderedListInputRule))
  // linkSchema 是 [schemaCtx, mark] 两个 plugin；extendSchema 返回的新版本同样是这两个，
  // 只在第一个位置整组换掉，第二个跳过，避免重复注册。
  .flatMap(plugin => plugin === linkSchema[0] ? exclusiveLinkSchema : plugin === linkSchema[1] ? [] : [plugin]);
const composerGfm = gfm.filter(plugin => plugin !== wrapInTaskListInputRule);

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

/**
 * 在光标处插入一段**已经算好分隔符**的文本。
 *
 * `setStoredMarks([])` 明确丢掉光标继承来的 mark：光标若停在上一枚链接的末尾，
 * 直接插入会带着 link mark 一起塞进那枚链接里（「贴到链接后面」粘成一团的另一半原因）。
 */
function insertTextAtCaret(ctx: Ctx, text: string): void {
  const view = ctx.get(editorViewCtx);
  const { state } = view;
  const tr = state.tr.setStoredMarks([]).insertText(text, state.selection.from, state.selection.to).scrollIntoView();
  view.dispatch(tr);
}

/** 把一段 Markdown 解析成 ProseMirror Slice（和 Milkdown clipboard 插件同样的路径）。 */
function markdownSlice(ctx: Ctx, markdown: string) {
  const doc = ctx.get(parserCtx)(markdown);
  const schema = ctx.get(schemaCtx);
  const dom = DOMSerializer.fromSchema(schema).serializeFragment(doc.content);
  return DOMParser.fromSchema(schema).parseSlice(dom);
}

function insertAtCaretIn(ctx: Ctx, text: string): void {
  const view = ctx.get(editorViewCtx);
  const { state } = view;
  const { from } = state.selection;
  const before = state.selection.$from.parent.isTextblock
    ? state.selection.$from.parent.textBetween(0, state.selection.$from.parentOffset, undefined, '\n')
    : '';
  insertTextAtCaret(ctx, before && !/\s$/.test(before) ? ` ${text}` : text);
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
      .use(composerCommonmark)
      .use(composerGfm)
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
      // 外部 value 可能在 create() 完成前就写进来了（例如新标签带着草稿挂载）。
      // 那次 props.value effect 会因为 ready=false 提前返回，这里补一次同步。
      const current = latest.current.value;
      if (created.action(getMarkdown()) !== current) {
        suppressing.current = true;
        created.action(replaceAll(current));
        created.action(caretToEnd);
        suppressing.current = false;
      }
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
    const clipboardData = event.clipboardData;
    if (!clipboardData) return;
    const items = Array.from(clipboardData.items);
    const files: File[] = [];
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (files.length) {
      event.preventDefault();
      event.stopPropagation();
      latest.current.onFiles(files);
      return;
    }
    // 只接管「剪贴板就是一条链接」的粘贴：Milkdown 默认会把复制来的 <a> 直接插到光标处，
    // 光标停在上一枚链接/正文末尾时就会粘成一团。这里改插一个独立的 Markdown 链接 token，
    // 并在与前文相连时补一个空格；解析成 Slice 走一次普通事务，markdownUpdated 照常回灌，
    // 不额外调 onChange（listener 有 200ms debounce，手动回灌会和它抢）。
    // 其余富文本/多行粘贴原样交给 Milkdown，避免改坏格式。
    const link = pastedLink(clipboardData.getData('text/plain'), clipboardData.getData('text/html'));
    if (!link || !editor.current) return;
    event.preventDefault();
    event.stopPropagation();
    const token = linkedPasteToken(link);
    editor.current.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const { $from } = state.selection;
      const before = $from.parent.isTextblock ? $from.parent.textBetween(0, $from.parentOffset, undefined, '\n') : '';
      const separator = needsPasteSeparator(before) ? ' ' : '';
      // 分隔空格不能用 `markdownSlice(' ' + token)`：remark 会裁掉段落行首空白，空格会被吃掉，
      // 链接又粘回前文。改成两次写入的同一事务：先插普通文本空格，再 replaceSelection 插解析好的
      // 链接 Slice；结尾再清一次 stored marks，保证后续输入不继承 link mark。
      const slice = markdownSlice(ctx, token);
      const tr = state.tr.setStoredMarks([]);
      if (separator) tr.insertText(separator, state.selection.from, state.selection.to);
      tr.replaceSelection(slice);
      tr.setStoredMarks([]);
      view.dispatch(tr.scrollIntoView());
    });
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
