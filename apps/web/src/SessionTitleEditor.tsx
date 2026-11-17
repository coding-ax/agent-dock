import { useEffect, useState } from 'react';
import { Input } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Session } from './api';

/**
 * 会话名的展示 + 就地编辑。
 *
 * 展示名和编辑输入框放在一个小组件里，因为它们必须共用同一份「编辑中」状态；
 * 拆开就要把状态提到 App 里，而 App 已经 700+ 行。来源标记不再占用行内图标位。
 *
 * 名字的三级来源见 `packages/agent-runtime/src/session-title.ts`：
 * 用户手改 > Agent 推来 > 首条 prompt 摘要。这里只负责呈现与提交，优先级全在服务端算，
 * 提交后把返回的会话**原样替换**进 `['sessions']` 缓存——本地自己拼一遍 title 就会
 * 和服务端的口径分叉（比如清空后到底回落到 Agent 名还是 prompt）。
 */
export function SessionTitleEditor({ session, label, nameClassName, editRequest }: {
  session: Session;
  /** 服务端算好的展示名（`session.title` 的最终形态，可能已回落到 Agent 名）。 */
  label: string;
  /** 展示态名字 span 的类名：行内不再预留操作图标位。 */
  nameClassName: string;
  /** 右键菜单「重命名会话」递增的请求号；变化时进入行内编辑。 */
  editRequest?: number;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const save = useMutation({
    mutationFn: (title: string | null) => api.setSessionTitle(session.id, title),
    onSuccess: result => {
      qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => item.id === result.id ? result : item));
      setEditing(false);
    },
    // 失败就留在编辑态、保留草稿：直接关掉输入框的话，用户只会看到名字自己弹回原样，
    // 既不知道失败了，也没法重试——而旁边的 2s 轮询还会顺势把旧名字盖回来。
    onError: () => setEditing(true)
  });

  const startEditing = () => {
    // 用 customTitle 预填，不是 label：label 可能是 Agent 起的名字，直接摆进输入框
    // 会让用户以为那是自己写的，一提交就把 Agent 的名字固化成了自定义名。
    setDraft(session.customTitle ?? '');
    setEditing(true);
  };
  useEffect(() => {
    if (!editRequest) return;
    setDraft(session.customTitle ?? '');
    setEditing(true);
  }, [editRequest, session.customTitle]);
  const cancel = () => { setEditing(false); save.reset(); };

  const commit = () => {
    // 已经有一发在飞就不再发：输入框 `disabled` 变 true 时浏览器会补一次 blur，
    // 没有这道闸就会再打一次同样的请求（Enter 提交 + 失焦提交叠在一起）。
    if (save.isPending) return;
    const next = draft.replace(/\s+/g, ' ').trim();
    // 没改动就别发请求：进出编辑态（含误触双击）不应该每次都写库、每次都推一条 SSE 事件。
    if (next === (session.customTitle ?? '')) return setEditing(false);
    // 成功才关输入框（见 onSuccess），失败要让用户看见并重试。
    save.mutate(next || null);
  };

  if (editing) {
    // 用 antd Input 而不是手搓 <input>：全站文本框都是 antd 的（AntdScope 里已把
    // 字号 12 / 圆角 6 / 边框色对齐 zinc 色板），手搓一个就只有骨架没有那套 hover、
    // focus 描边和禁用态，摆在会话行里一眼看出是野的。
    // `size="small"` 是 24px 高，正好卡进 20px 行高旁边，进出编辑态行不会跳一下。
    return <Input
      autoFocus
      size="small"
      value={draft}
      placeholder={label || '会话名'}
      maxLength={120}
      disabled={save.isPending}
      status={save.error ? 'error' : undefined}
      aria-label="会话名"
      // 编辑期间整行要「静音」：点输入框会冒泡到行的 onClick（跳走会话），
      // 按空格/Enter 会命中行的 onKeyDown（同样跳走），行本身还 draggable（选中文字变成拖拽）。
      onClick={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()}
      onDragStart={event => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Enter') { event.preventDefault(); commit(); }
        // Esc 取消：不提交、不动库，回到原名字。
        else if (event.key === 'Escape') { event.preventDefault(); cancel(); }
      }}
      onBlur={commit}
      onChange={event => setDraft(event.target.value)}
      className="min-w-0 flex-1 py-0 font-medium"
    />;
  }

  // 刻意不加原生 title：整行已经挂了 Radix 信息卡，再挂原生提示就会像之前那样
  // 同一行弹两个不同的气泡。改名入口只留在右键菜单和双击标题，行内不再堆图标。
  return <span
    className={nameClassName}
    onDoubleClick={event => { event.stopPropagation(); startEditing(); }}
  >{label}</span>;
}
