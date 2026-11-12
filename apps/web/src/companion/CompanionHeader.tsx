import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dices, PencilLine, StickyNote } from 'lucide-react';
import { api, type AssistantState } from '../api';
import { AgentIcon } from '../AgentIcon';
import { Kitten } from './Kitten';
import { greeting, pickKittenName, type NoteFilter } from './companion-model';
import { KITTEN_TRANSITION_NAME, useAnchor } from './effects';
import { useCompanion } from './useCompanion';
import { useCompanionStore } from './companion-store';
import { HandoffFlag, StageChip } from './LifecycleBadges';

const selectMainId = (state: AssistantState) => state.mainSessionId;

/**
 * 只关心「主会话是哪个」：SessionPane 用它判断自己是不是小猫。用 select 只订阅这一个字段，
 * 便签每次轮询变化时不会把整条时间线拖着重渲染。轮询由 App 里的 useAssistantState 负责。
 */
export function useMainSessionId(): string | undefined {
  return useQuery({ queryKey: ['assistant-state'], queryFn: api.assistantState, retry: false, staleTime: 5_000, select: selectMainId }).data ?? undefined;
}

function StatChip({ filter, swatch, label, count }: { filter: NoteFilter; swatch: string; label: string; count: number }) {
  if (!count) return null;
  return <button type="button" onClick={() => useCompanionStore.getState().openDrawer({ filter })} className="ui-status-chip max-md:hidden">
    <span className={`ui-note-swatch ${swatch}`}/>{count} {label}
  </button>;
}

/**
 * 主会话的标题栏左半边：小猫头像（首页的大猫会形变到这里）、可以直接改的名字、此刻在忙什么。
 * 右边的便签计数由 CompanionHeaderNotes 放进标题栏的操作区。
 */
export function CompanionHeader({ agentId, agentName }: { agentId: string; agentName?: string }) {
  const info = useCompanion();
  const qc = useQueryClient();
  const anchor = useAnchor<HTMLSpanElement>('kitten-header');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const rename = useMutation({
    mutationFn: (name: string) => api.assistantRenameCompanion(name),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['assistant-state'] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      useCompanionStore.getState().celebrate();
    }
  });
  useEffect(() => { if (editing) requestAnimationFrame(() => input.current?.select()); }, [editing]);
  const commit = () => {
    const name = draft.trim();
    setEditing(false);
    if (name && name !== info.name) rename.mutate(name);
  };
  const celebrateNonce = useCompanionStore(store => store.celebrateNonce);

  return <div className="flex min-w-0 flex-1 items-center gap-2.5">
    <span ref={anchor} className="shrink-0">
      <Kitten variant="face" size={36} mood={info.mood} stage={info.stage} collar track celebrateKey={celebrateNonce} viewTransitionName={KITTEN_TRANSITION_NAME} label={`${info.name}：${info.status}`}/>
    </span>
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5">
        {editing
          ? <span className="flex items-center gap-1">
            <input ref={input} value={draft} maxLength={16} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter') { event.preventDefault(); commit(); } if (event.key === 'Escape') { event.preventDefault(); setEditing(false); } }} aria-label="小猫的名字" className="h-7 w-32 rounded-md border border-zinc-300 bg-white px-2 text-[14px] font-semibold text-zinc-900 outline-none focus:border-zinc-500"/>
            <button type="button" onPointerDown={event => event.preventDefault()} onClick={() => setDraft(current => pickKittenName(current.trim() || info.name))} aria-label="换一个名字" title="随机换一个名字" className="ui-dice grid h-7 w-7 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"><Dices size={14}/></button>
          </span>
          : <button type="button" onClick={() => { setDraft(info.name); setEditing(true); }} title="给它改个名字" className="ui-companion-head-name group/name flex min-w-0 items-center gap-1 text-[14px] font-semibold text-zinc-900">
            <span className="truncate">{rename.isPending ? rename.variables : info.name}</span>
            <PencilLine size={12} className="shrink-0 text-zinc-400 opacity-0 transition-opacity group-hover/name:opacity-100"/>
          </button>}
        <span className="shrink-0 rounded-full bg-zinc-100 px-1.5 text-[10.5px] font-medium leading-[17px] text-zinc-500">主会话</span>
        <StageChip lifecycle={info.lifecycle}/>
        <HandoffFlag lifecycle={info.lifecycle} name={info.name}/>
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-zinc-500">
        <span className={`min-w-0 truncate ${info.busy ? 'ui-shimmer-text' : ''}`}>{info.status}</span>
        <span className="shrink-0 text-zinc-300">·</span>
        <AgentIcon agentId={agentId} agentName={agentName} size={12}/>
        <span className="min-w-0 truncate max-sm:hidden">{agentName ?? agentId}</span>
      </div>
      {rename.error && <div className="text-[11px] text-red-600">{rename.error.message}</div>}
    </div>
  </div>;
}

/** 主会话标题栏右侧：各状态的便签数（点了按状态打开抽屉）+ 便签按钮。 */
export function CompanionHeaderNotes() {
  const info = useCompanion();
  const open = info.counts.open;
  return <div className="mr-1 flex shrink-0 items-center gap-1">
    <StatChip filter="needs_user" swatch="ui-note-paper-needs" label="需要你" count={info.counts.needsUser + info.counts.planned}/>
    <StatChip filter="review" swatch="ui-note-paper-review" label="待验收" count={info.counts.review}/>
    <StatChip filter="running" swatch="ui-note-paper-running" label="进行中" count={info.counts.running}/>
    <button type="button" onClick={() => useCompanionStore.getState().toggleDrawer()} aria-label={`${info.name}的便签`} title={`${info.name}的便签`} className="relative flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900">
      <StickyNote size={15}/><span className="max-sm:hidden">便签</span>
      {open > 0 && <span className="min-w-[16px] rounded-full bg-zinc-900 px-1 text-center text-[10px] font-semibold leading-4 text-white tabular-nums">{open}</span>}
    </button>
  </div>;
}

const SUGGESTIONS = ['帮我把今天要做的事理一理', '盯一下 CI，挂了提醒我', '把这个需求拆成几张便签派出去', '看看还有哪些便签没验收'];

/** 主会话还没聊过时的空状态：小猫自我介绍，给几个开场白。 */
export function CompanionWelcome({ onPick }: { onPick(text: string): void }) {
  const info = useCompanion();
  return <div className="ui-empty-state flex flex-col items-center justify-center text-center">
    <div className="ui-speech">{greeting()}～我是<b className="font-semibold">{info.name}</b>，你的主会话。</div>
    <Kitten size={84} mood={info.mood === 'sleepy' ? 'idle' : info.mood} stage={info.stage} collar track typingAware label={info.name}/>
    <h2 className="mt-4 text-[18px] font-semibold tracking-tight text-zinc-800">说说今天要做什么</h2>
    <p className="mt-2 max-w-sm text-[13px] leading-6 text-zinc-500">我来拆成一张张便签派给侧边会话去做，做完帮你验收；进度随时在右边的便签里看。</p>
    <div className="mt-6 flex max-w-md flex-wrap justify-center gap-2">
      {SUGGESTIONS.map(text => <button key={text} type="button" onClick={() => onPick(text)} className="ui-companion-welcome-tip">{text}</button>)}
    </div>
  </div>;
}
