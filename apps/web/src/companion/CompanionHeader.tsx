import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dices, PencilLine } from 'lucide-react';
import { api, type AssistantState } from '../api';
import { AgentIcon } from '../AgentIcon';
import { HoverTooltip } from '../HoverTooltip';
import { Kitten } from './Kitten';
import { greeting, pickKittenName } from './companion-model';
import { KITTEN_TRANSITION_NAME, useAnchor } from './effects';
import { useCompanion } from './useCompanion';
import { useCompanionStore } from './companion-store';
import { StageChip } from './LifecycleBadges';
import { bi, useBi } from '../i18n';

const selectMainId = (state: AssistantState) => state.mainSessionId;

/**
 * 只关心「主会话是哪个」：SessionPane 用它判断自己是不是小猫。用 select 只订阅这一个字段，
 * 便签每次轮询变化时不会把整条时间线拖着重渲染。轮询由 App 里的 useAssistantState 负责。
 */
export function useMainSessionId(): string | undefined {
  return useQuery({ queryKey: ['assistant-state'], queryFn: api.assistantState, retry: false, staleTime: 5_000, select: selectMainId }).data ?? undefined;
}

/**
 * 主会话的精简标题栏左半边：小猫头像、可直接改的名字、单枚克制徽章，以及 Agent（含 Token/额度聚合入口）与此刻状态。
 * 便签统一归侧栏与便签抽屉承载，退休/交接等低频主会话操作收纳进「更多」菜单，不再在顶栏重复占空。
 */
export function CompanionHeader({ agentId, agentName, agentSlot }: { agentId: string; agentName?: string; agentSlot?: ReactNode }) {
  const L = useBi();
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
    <HoverTooltip content={`${info.name} · ${info.moodMeta.label}：${info.moodMeta.hint}`} hoverOnly>
      <span ref={anchor} className="shrink-0">
        <Kitten variant="face" size={32} mood={info.mood} stage={info.stage} collar track celebrateKey={celebrateNonce} viewTransitionName={KITTEN_TRANSITION_NAME} label={`${info.name}：${info.status}`}/>
      </span>
    </HoverTooltip>
    <div className="min-w-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 items-center gap-1.5">
        {editing
          ? <span className="flex items-center gap-1">
            <input ref={input} value={draft} maxLength={16} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter') { event.preventDefault(); commit(); } if (event.key === 'Escape') { event.preventDefault(); setEditing(false); } }} aria-label={L("小猫的名字", "Companion name")} className="h-7 w-32 rounded-md border border-zinc-300 bg-white px-2 text-[14px] font-semibold text-zinc-900 outline-none focus:border-zinc-500"/>
            <HoverTooltip content={L("随机换一个名字", "Randomize name")}>
              <button type="button" onPointerDown={event => event.preventDefault()} onClick={() => setDraft(current => pickKittenName(current.trim() || info.name))} aria-label={L("换一个名字", "Randomize name")} className="ui-dice grid h-7 w-7 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"><Dices size={14}/></button>
            </HoverTooltip>
          </span>
          : <HoverTooltip content={L("点击给它改个名字", "Click to rename")} hoverOnly>
            <button type="button" onClick={() => { setDraft(info.name); setEditing(true); }} aria-label={L(`给 ${info.name} 改名`, `Rename ${info.name}`)} className="ui-companion-head-name group/name flex min-w-0 items-center gap-1 text-[14px] font-semibold leading-tight text-zinc-900">
              <span className="truncate">{rename.isPending ? rename.variables : info.name}</span>
              <PencilLine size={12} className="shrink-0 text-zinc-400 opacity-0 transition-opacity group-hover/name:opacity-100 max-sm:hidden"/>
            </button>
          </HoverTooltip>}
        <span className="inline-flex shrink-0 max-sm:hidden">
          {info.lifecycle?.cat
            ? <StageChip lifecycle={info.lifecycle} role={L("主会话", "Main")} compact/>
            : <span className="rounded-full bg-zinc-100 px-1.5 text-[10.5px] font-medium leading-[17px] text-zinc-500">{L("主会话", "Main")}</span>}
        </span>
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-zinc-500">
        {agentSlot ?? <>
          <AgentIcon agentId={agentId} agentName={agentName} size={13}/>
          <span className="min-w-0 truncate max-sm:hidden">{agentName ?? agentId}</span>
        </>}
        <span className="shrink-0 text-zinc-300">·</span>
        <span className={`min-w-0 truncate ${info.busy ? 'ui-shimmer-text' : ''}`}>{info.status}</span>
      </div>
      {rename.error && <div className="text-[11px] text-red-600">{rename.error.message}</div>}
    </div>
  </div>;
}

/** 主会话还没聊过时的空状态：小猫自我介绍，给几个开场白。 */
export function CompanionWelcome({ onPick }: { onPick(text: string): void }) {
  const L = useBi();
  const info = useCompanion();
  const suggestions = [
    L("帮我把今天要做的事理一理", "Organize today's tasks"),
    L("盯一下 CI，挂了提醒我", "Watch CI and alert me on failure"),
    L("把这个需求拆成几张便签派出去", "Break this spec into side tasks"),
    L("看看还有哪些便签没验收", "Check notes awaiting review")
  ];
  return <div className="ui-empty-state flex flex-col items-center justify-center text-center">
    <div className="ui-speech">{greeting()}{L("～我是", "~ I'm ")}<b className="font-semibold">{info.name}</b>{L("，你的主会话。", ", your Main Session.")}</div>
    <Kitten size={84} mood={info.mood === 'sleepy' ? 'idle' : info.mood} stage={info.stage} collar track typingAware label={info.name}/>
    <h2 className="mt-4 text-[18px] font-semibold tracking-tight text-zinc-800">{L("说说今天要做什么", "What are we working on today?")}</h2>
    <p className="mt-2 max-w-sm text-[13px] leading-6 text-zinc-500">{L("我来拆成一张张便签派给侧边会话去做，做完帮你验收；进度随时在侧栏便签里看。", "I'll split work into sticky-note side sessions and review the results; track everything in the drawer.")}</p>
    <div className="mt-6 flex max-w-md flex-wrap justify-center gap-2">
      {suggestions.map(text => <button key={text} type="button" onClick={() => onPick(text)} className="ui-companion-welcome-tip">{text}</button>)}
    </div>
  </div>;
}
