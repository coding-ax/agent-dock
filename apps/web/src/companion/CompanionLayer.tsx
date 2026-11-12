import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AssistantLifecycleLight } from '../api';
import { CompanionEdge, type CompanionView } from './CompanionEdge';
import { HandoffCeremony } from './HandoffCeremony';
import { StickyDrawer } from './StickyDrawer';
import { companionBubble, diffTasks, isMainBusy, noteTone, snapshotTasks, type TaskSnapshot } from './companion-model';
import { anchorElement, anchorRect, bump, burst, flyNote } from './effects';
import { diffLifecycle, lifecycleBubble } from './lifecycle-model';
import { useCompanion } from './useCompanion';
import { useCompanionStore } from './companion-store';

/** 便签从哪只猫身上飞出来：当前看得见的那只（主会话头像 > 首页大猫 > 右缘 > 侧栏）。 */
const KITTEN_ANCHORS = ['kitten-header', 'kitten-hero', 'kitten-edge', 'kitten-card'];

/**
 * 小猫对外界的反应：对比两次轮询之间的便签变化，冒气泡、飞便签、撒星星；
 * 主会话在用户看别处时回完话，也冒个气泡叫一声。只在 App 里挂一次。
 */
function useCompanionReactions(view: CompanionView) {
  const info = useCompanion();
  const previous = useRef<Map<string, TaskSnapshot> | undefined>(undefined);
  const mainState = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!info.loaded || !info.adopted) { previous.current = info.loaded ? snapshotTasks(info.tasks) : undefined; return; }
    const events = diffTasks(previous.current, info.tasks);
    previous.current = snapshotTasks(info.tasks);
    if (!events.length) return;
    const store = useCompanionStore.getState();
    events.forEach((event, index) => {
      const bubble = companionBubble(event);
      store.say(bubble.text, bubble.tone, { kind: 'note', taskId: event.task.id });
      store.markRecent(event.kind);
      if (event.kind === 'dispatched' || event.kind === 'planned') {
        // 几张一起派出时错开一点，像一张张贴上去。
        window.setTimeout(() => {
          const from = anchorRect(KITTEN_ANCHORS);
          const to = anchorRect(['notes-edge']);
          if (from && to) void flyNote(from, to, noteTone(event.task)).then(() => bump(anchorElement('notes-edge')));
          else bump(anchorElement('notes-edge'));
        }, index * 220);
      }
      if (event.kind === 'accepted') {
        const rect = anchorRect(['notes-edge', ...KITTEN_ANCHORS]);
        if (rect) burst(rect, 'sparkles', 8);
      }
      if (event.kind === 'review' || event.kind === 'needs_user') bump(anchorElement('notes-edge'), 0.7);
    });
  }, [info.loaded, info.adopted, info.tasks]);

  // 主会话从忙变闲：用户此刻不在看主会话，就冒个气泡说回完了。
  const state = info.mainSession?.state;
  useEffect(() => {
    const before = mainState.current;
    mainState.current = state;
    if (!before || before === state) return;
    const store = useCompanionStore.getState();
    store.touch();
    if (view === 'main') return;
    if (state === 'waiting_for_permission') store.say(`${info.name}需要你授权一下`, 'alert', { kind: 'main' });
    else if (state === 'failed') store.say(`${info.name}好像遇到了点麻烦`, 'alert', { kind: 'main' });
    else if (isMainBusy(before) && state === 'idle') store.say(`${info.name}回复你啦，喵～`, 'info', { kind: 'main' });
  }, [state, view, info.name]);
}

/**
 * 小猫的一生：交接提议冒泡（点开就是交接仪式）、整理轮次开始/结束、交接完成或回滚、长大一个阶段。
 * 第一次拿到数据不算变化，刷新页面不会把旧事重播一遍；仪式弹窗开着时它自己会讲，不再冒泡。
 */
function useLifecycleReactions() {
  const info = useCompanion();
  const qc = useQueryClient();
  const previous = useRef<AssistantLifecycleLight | undefined>(undefined);
  const lifecycle = info.lifecycle;

  useEffect(() => {
    const before = previous.current;
    previous.current = lifecycle;
    if (!info.adopted || !lifecycle) return;
    const events = diffLifecycle(before, lifecycle);
    if (!events.length) return;
    const store = useCompanionStore.getState();
    for (const event of events) {
      if (event.kind === 'maintenance_finished' || event.kind === 'handoff_done' || event.kind === 'handoff_rolled_back') {
        void qc.invalidateQueries({ queryKey: ['assistant-lifecycle'] });
        void qc.invalidateQueries({ queryKey: ['assistant-notes-archive'] });
      }
      if (store.ceremony && event.kind !== 'aged' && event.kind !== 'maintenance_started' && event.kind !== 'maintenance_finished') continue;
      const bubble = lifecycleBubble(event, info.name, lifecycle.cat?.lifeStage);
      const action = event.kind === 'handoff_proposed' ? { kind: 'handoff' as const, handoffId: event.handoffId }
        : event.kind === 'handoff_done' || event.kind === 'handoff_rolled_back' || event.kind === 'maintenance_finished' ? { kind: 'main' as const }
          : undefined;
      store.say(bubble.text, bubble.tone, action);
      if (event.kind === 'aged' || event.kind === 'handoff_done') {
        const rect = anchorRect(KITTEN_ANCHORS);
        if (rect) burst(rect, event.kind === 'aged' ? 'sparkles' : 'hearts', 8);
      }
    }
  }, [info.adopted, info.name, lifecycle, qc]);
}

export function CompanionLayer({ view }: { view: CompanionView }) {
  useCompanionReactions(view);
  useLifecycleReactions();
  return <>
    <CompanionEdge view={view}/>
    <StickyDrawer/>
    <HandoffCeremony/>
  </>;
}
