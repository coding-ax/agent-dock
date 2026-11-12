import { StickyNote, X } from 'lucide-react';
import { HoverTooltip } from '../HoverTooltip';
import { Kitten } from './Kitten';
import { useAnchor } from './effects';
import { useCompanion, useCompanionNav } from './useCompanion';
import { useCompanionStore } from './companion-store';
import { HandoffFlag, StageChip } from './LifecycleBadges';

/**
 * 侧栏顶部的小猫卡片：主会话的常驻入口。
 * 认领后显示小猫、名字和此刻在忙什么；点卡片进主会话，点右边的便签按钮划出便签。
 * 没认领时是一张虚线邀请卡，小猫从卡片底边探出头。
 */
export function CompanionCard({ active }: { active: boolean }) {
  const info = useCompanion();
  const nav = useCompanionNav();
  const inviteDismissed = useCompanionStore(store => store.inviteDismissed);
  const anchor = useAnchor<HTMLSpanElement>('kitten-card');
  if (!info.loaded) return null;

  if (!info.adopted) {
    if (inviteDismissed) return null;
    return <div className="group/invite relative">
      <button type="button" onClick={nav.goAdopt} className="ui-companion-invite ui-cat-hover-host">
        <span className="grid h-[38px] w-[38px] shrink-0 place-items-end justify-center overflow-hidden"><Kitten variant="face" size={34} mood="curious" interactive={false}/></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold text-zinc-800">认领一只小猫</span>
          <span className="block truncate text-[12px] text-zinc-500">帮你派活、盯进度、验收</span>
        </span>
      </button>
      <button type="button" aria-label="不再提示认领" title="不再提示（设置里仍可认领）" onClick={() => useCompanionStore.getState().dismissInvite()} className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-md text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-200/70 hover:text-zinc-700 focus-visible:opacity-100 group-hover/invite:opacity-100 max-md:opacity-100"><X size={12}/></button>
    </div>;
  }

  // 计划卡和草稿也要露出来，但只有真正卡住的事（needs_user）才报红。
  const attention = info.counts.needsUser + info.counts.planned + info.pendingDrafts;
  const alerting = info.counts.needsUser > 0;
  const attentionLabel = [
    info.counts.needsUser ? `${info.counts.needsUser} 件事等你拍板` : '',
    info.counts.planned ? `${info.counts.planned} 张计划等你点头` : '',
    info.pendingDrafts ? `${info.pendingDrafts} 份草稿等你确认` : ''
  ].filter(Boolean).join('，');
  const open = info.counts.open;
  return <div role="button" tabIndex={0} onClick={() => nav.openMain()} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); nav.openMain(); } }} data-active={active || undefined} aria-label={`${info.name}（主会话）：${info.status}`} className="ui-companion-card ui-cat-hover-host cursor-pointer">
    <span ref={anchor} className="ui-companion-avatar"><Kitten variant="face" size={28} mood={info.mood} stage={info.stage} collar interactive={false}/></span>
    <span className="min-w-0 flex-1">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-[14px] font-semibold text-zinc-900">{info.name}</span>
        {info.lifecycle?.cat ? <StageChip lifecycle={info.lifecycle} role="主会话" compact/> : <span className="shrink-0 rounded-full bg-zinc-200/70 px-1.5 text-[10.5px] font-medium leading-[17px] text-zinc-500">主会话</span>}
        <HandoffFlag lifecycle={info.lifecycle} name={info.name} compact/>
      </span>
      <span className={`block truncate text-[12px] ${info.busy ? 'ui-shimmer-text' : 'text-zinc-500'}`}>{info.status}</span>
    </span>
    {attention > 0 && <HoverTooltip content={attentionLabel}>
      <button type="button" onClick={event => { event.stopPropagation(); useCompanionStore.getState().openDrawer({ filter: alerting || info.counts.planned > 0 ? 'needs_user' : 'all' }); }} className="ui-mini-badge shrink-0" data-tone={alerting ? 'needs' : undefined} aria-label={`查看 ${attention} 件待你处理的事`}>{attention}</button>
    </HoverTooltip>}
    <HoverTooltip content={`${info.name}的便签${open ? `（${open} 张进行中）` : ''}`}>
      <button type="button" onClick={event => { event.stopPropagation(); useCompanionStore.getState().toggleDrawer(); }} aria-label={`${info.name}的便签`} className="relative grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-200/70 hover:text-zinc-900">
        <StickyNote size={15}/>
        {open > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-[15px] rounded-full bg-zinc-900 px-1 text-center text-[9.5px] font-semibold leading-[15px] text-white tabular-nums">{open > 99 ? '99+' : open}</span>}
      </button>
    </HoverTooltip>
  </div>;
}

/** 侧栏收起后的细条里的小猫按钮。 */
export function CompanionStripButton() {
  const info = useCompanion();
  const nav = useCompanionNav();
  const inviteDismissed = useCompanionStore(store => store.inviteDismissed);
  if (!info.loaded || (!info.adopted && inviteDismissed)) return null;
  const attention = info.counts.needsUser + info.pendingDrafts;
  return <HoverTooltip content={info.adopted ? `${info.name} · ${info.status}` : '认领一只小猫'}>
    <button type="button" onClick={() => (info.adopted ? nav.openMain() : nav.goAdopt())} aria-label={info.adopted ? `打开主会话（${info.name}）` : '认领一只小猫'} className="ui-cat-hover-host relative grid h-9 w-9 place-items-center rounded-lg text-zinc-700 hover:bg-white">
      <Kitten variant="face" size={24} mood={info.adopted ? info.mood : 'curious'} stage={info.adopted ? info.stage : undefined} collar={info.adopted} interactive={false}/>
      {attention > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full border-2 border-rail bg-red-500"/>}
    </button>
  </HoverTooltip>;
}
