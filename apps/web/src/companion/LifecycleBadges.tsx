import { Hourglass } from 'lucide-react';
import type { AssistantLifecycleLight } from '../api';
import { HoverTooltip } from '../HoverTooltip';
import { generationLabel, handoffInvite, stageBlurb, stageLabel } from './lifecycle-model';
import { useCompanionStore } from './companion-store';

/**
 * 「第 2 代 · 资深」：主会话标题栏用完整写法；侧栏卡片地方窄，compact 只写阶段（「资深」），代数放进提示。
 * 旧服务端没有血缘时只显示 role。
 */
export function StageChip({ lifecycle, role, compact = false }: { lifecycle?: AssistantLifecycleLight; role?: string; compact?: boolean }) {
  const cat = lifecycle?.cat;
  if (!cat) return role ? <span className="ui-stage-chip">{role}</span> : null;
  const predecessor = cat.predecessor ? `；前任是第 ${cat.predecessor.generation} 代${cat.predecessor.name}` : '';
  return <HoverTooltip content={`${role ? `${role} · ` : ''}${generationLabel(cat.generation)}${stageLabel[cat.lifeStage]}：${stageBlurb[cat.lifeStage]}${predecessor}`}>
    <span className="ui-stage-chip" data-stage={cat.lifeStage}>{compact ? stageLabel[cat.lifeStage] : `${generationLabel(cat.generation)} · ${stageLabel[cat.lifeStage]}`}</span>
  </HoverTooltip>;
}

/** 有交接提议摆在用户面前：角标「该交接了」，点开交接仪式。compact 只留沙漏图标（侧栏卡片）。 */
export function HandoffFlag({ lifecycle, name, compact = false }: { lifecycle?: AssistantLifecycleLight; name: string; compact?: boolean }) {
  const handoff = lifecycle?.handoff;
  if (!handoff || handoff.state !== 'proposed') return null;
  return <HoverTooltip content={handoffInvite(lifecycle?.cat?.lifeStage, name)}>
    <button type="button" className="ui-handoff-flag" data-compact={compact || undefined} onClick={event => { event.stopPropagation(); useCompanionStore.getState().openCeremony(handoff.id); }} onKeyDown={event => event.stopPropagation()} aria-label="该交接了：打开交接仪式">
      <Hourglass size={10}/>{compact ? null : '该交接了'}
    </button>
  </HoverTooltip>;
}
