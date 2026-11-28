import { StickyNote, X } from 'lucide-react';
import { HoverTooltip } from '../HoverTooltip';
import { Kitten } from './Kitten';
import { useAnchor } from './effects';
import { useCompanion, useCompanionNav } from './useCompanion';
import { useCompanionStore } from './companion-store';
import { HandoffFlag, StageChip } from './LifecycleBadges';
import { useBi } from '../i18n';

/**
 * 侧栏顶部的小猫卡片：主会话的常驻入口。
 * 认领后显示小猫、名字和此刻在忙什么；点卡片进主会话，点右边的便签按钮划出便签。
 * 没认领时是一张虚线邀请卡，小猫从卡片底边探出头。
 */
export function CompanionCard({ active }: { active: boolean }) {
  const L = useBi();
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
          <span className="block truncate text-[13.5px] font-semibold text-zinc-800">{L("认领一只小猫", "Adopt Companion")}</span>
          <span className="block truncate text-[12px] text-zinc-500">{L("帮你派活、盯进度、验收", "Delegate, track & review")}</span>
        </span>
      </button>
      <HoverTooltip content={L("不再提示（设置中心仍可认领）", "Dismiss (still available in Settings)")} side="top">
        <button type="button" aria-label={L("不再提示认领", "Dismiss adopt prompt")} onClick={() => useCompanionStore.getState().dismissInvite()} className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-md text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-200/70 hover:text-zinc-700 focus-visible:opacity-100 group-hover/invite:opacity-100 max-md:opacity-100"><X size={12}/></button>
      </HoverTooltip>
    </div>;
  }

  // 计划卡和草稿也要露出来，但只有真正卡住的事（needs_user）才报红。
  const attention = info.counts.needsUser + info.counts.planned + info.pendingDrafts;
  const alerting = info.counts.needsUser > 0;
  const attentionLabel = [
    info.counts.needsUser ? L(`${info.counts.needsUser} 件事等你拍板`, `${info.counts.needsUser} need your input`) : '',
    info.counts.planned ? L(`${info.counts.planned} 张计划等你点头`, `${info.counts.planned} plan(s) to approve`) : '',
    info.pendingDrafts ? L(`${info.pendingDrafts} 份草稿等你确认`, `${info.pendingDrafts} draft(s) to approve`) : ''
  ].filter(Boolean).join('，');
  const open = info.counts.open;
  return <div role="button" tabIndex={0} onClick={() => nav.openMain()} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); nav.openMain(); } }} data-active={active || undefined} aria-label={L(`${info.name}（主会话）：${info.status}`, `${info.name} (Main): ${info.status}`)} className="ui-companion-card ui-cat-hover-host cursor-pointer">
    <span ref={anchor} className="ui-companion-avatar"><Kitten variant="face" size={28} mood={info.mood} stage={info.stage} collar interactive={false}/></span>
    <span className="min-w-0 flex-1">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-[14px] font-semibold text-zinc-900">{info.name}</span>
        {info.lifecycle?.cat ? <StageChip lifecycle={info.lifecycle} role={L("主会话", "Main")} compact/> : <span className="shrink-0 rounded-full bg-zinc-200/70 px-1.5 text-[10.5px] font-medium leading-[17px] text-zinc-500">{L("主会话", "Main")}</span>}
        <HandoffFlag lifecycle={info.lifecycle} name={info.name} compact/>
      </span>
      <span className={`block truncate text-[12px] ${info.busy ? 'ui-shimmer-text' : 'text-zinc-500'}`}>{info.status}</span>
    </span>
    {attention > 0 && <HoverTooltip content={attentionLabel}>
      <button type="button" onClick={event => { event.stopPropagation(); useCompanionStore.getState().openDrawer({ filter: alerting || info.counts.planned > 0 ? 'needs_user' : 'all' }); }} className="ui-mini-badge shrink-0" data-tone={alerting ? 'needs' : undefined} aria-label={L(`查看 ${attention} 件待你处理的事`, `View ${attention} item(s) needing attention`)}>{attention}</button>
    </HoverTooltip>}
    <HoverTooltip content={L(`${info.name}的便签${open ? `（${open} 张进行中）` : ''}`, `${info.name}'s Notes${open ? ` (${open} active)` : ''}`)}>
      <button type="button" onClick={event => { event.stopPropagation(); useCompanionStore.getState().toggleDrawer(); }} aria-label={L(`${info.name}的便签`, `${info.name}'s Notes`)} className="relative grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-200/70 hover:text-zinc-900">
        <StickyNote size={15}/>
        {open > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-[15px] rounded-full bg-zinc-900 px-1 text-center text-[9.5px] font-semibold leading-[15px] text-white tabular-nums">{open > 99 ? '99+' : open}</span>}
      </button>
    </HoverTooltip>
  </div>;
}

/** 侧栏收起后的细条里的小猫按钮。 */
export function CompanionStripButton() {
  const L = useBi();
  const info = useCompanion();
  const nav = useCompanionNav();
  const inviteDismissed = useCompanionStore(store => store.inviteDismissed);
  if (!info.loaded || (!info.adopted && inviteDismissed)) return null;
  const attention = info.counts.needsUser + info.pendingDrafts;
  return <HoverTooltip content={info.adopted ? `${info.name} · ${info.status}` : L("认领一只小猫", "Adopt Companion")} side="right">
    <button type="button" onClick={() => (info.adopted ? nav.openMain() : nav.goAdopt())} aria-label={info.adopted ? L(`打开主会话（${info.name}）`, `Open Main Session (${info.name})`) : L("认领一只小猫", "Adopt Companion")} className="ui-cat-hover-host relative grid h-9 w-9 place-items-center rounded-lg text-zinc-700 hover:bg-white">
      <Kitten variant="face" size={24} mood={info.adopted ? info.mood : 'curious'} stage={info.adopted ? info.stage : undefined} collar={info.adopted} interactive={false}/>
      {attention > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full border-2 border-rail bg-red-500"/>}
    </button>
  </HoverTooltip>;
}
