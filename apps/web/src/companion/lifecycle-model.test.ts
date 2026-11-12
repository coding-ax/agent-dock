import { describe, expect, it } from 'vitest';
import type { AssistantLifecycleLight, HandoffState, HandoffSummary, HandoffTransfer } from '../api';
import {
  agePercent, ceremonyPhase, ceremonySteps, diffLifecycle, formatMetricValue, formatReason, handoffInvite, isCeremonyFinal,
  isCeremonyRunning, isLineageSource, isSystemRoundOrigin, lifecycleBubble, nextStage, stageBadge, STAGE_FLOORS, stageCatLabel,
  systemRoundCopy, transferSummary
} from './lifecycle-model';

const summary = (patch: Partial<HandoffSummary> & { id: string; state: HandoffState }): HandoffSummary => ({
  outcome: null, trigger: 'user', reason: null, reasons: [], fromSessionId: 'ses_old', toSessionId: null, successorName: null,
  error: null, createdAt: '2026-11-12T08:00:00.000Z', confirmedAt: null, completedAt: null, ...patch
});

const light = (patch: Partial<AssistantLifecycleLight> = {}): AssistantLifecycleLight => ({
  cat: { id: 'acat_1', familyId: 'afam_1', generation: 1, name: '团子', lifeStage: 'adult', peakAgeScore: 0.3, rounds: 120, adoptedAt: '2026-11-01T08:00:00.000Z' },
  level: 'ok', handoff: null, lastHandoff: null, maintenance: null, ancestorSessionIds: [], ...patch
});

const transfer = (status: HandoffTransfer['status'], id: string = status): HandoffTransfer => ({
  id, handoffId: 'ahand_1', kind: 'task', itemId: `atask_${id}`, title: id, status, createdAt: '2026-11-12T08:00:00.000Z', updatedAt: '2026-11-12T08:00:00.000Z'
});

describe('cat aging copy', () => {
  it('labels stages, age bars and the next stage the same way as the server', () => {
    expect(stageCatLabel.kitten).toBe('幼猫');
    expect(stageCatLabel.senior).toBe('资深猫');
    expect(stageBadge({ generation: 2, lifeStage: 'senior' })).toBe('第 2 代 · 资深');
    expect(stageBadge(null)).toBe('');
    expect(STAGE_FLOORS).toEqual({ kitten: 0, adult: 0.15, senior: 0.45, elder: 0.8 });
    expect(agePercent(undefined)).toBe(0);
    expect(agePercent(0.456)).toBe(46);
    expect(agePercent(1.4)).toBe(100);
    expect(agePercent(Number.NaN)).toBe(0);
    expect(nextStage('kitten')).toBe('adult');
    expect(nextStage('elder')).toBeUndefined();
  });

  it('formats metrics and reasons with their units', () => {
    expect(formatMetricValue('contextPercent', 91.6)).toBe('92%');
    expect(formatMetricValue('uptimeDays', 14.26)).toBe('14.3 天');
    expect(formatMetricValue('rounds', 640)).toBe('640');
    expect(formatMetricValue('contextPercent', undefined)).toBe('—');
    expect(formatReason({ metric: 'closedNotes', level: 'tidy', value: 45, threshold: 40 })).toBe('已完成便签 45/40');
  });

  it('gets more direct about handing off as the cat ages', () => {
    expect(handoffInvite('elder', '团子')).toContain('有点累了');
    expect(handoffInvite('senior', '团子')).toContain('记忆有点沉');
    expect(handoffInvite(undefined, '团子')).toContain('该交接一下');
  });
});

describe('handoff ceremony', () => {
  it('maps every server state onto a ceremony scene', () => {
    const scenes: Record<HandoffState, string> = {
      proposed: 'invite', confirmed: 'farewell', packing: 'farewell', spawning: 'newborn', transferring: 'transfer', switching: 'transfer',
      retiring: 'closing', briefing: 'closing', done: 'done', rolling_back: 'rolled_back', rolled_back: 'rolled_back', cancelled: 'cancelled'
    };
    for (const [state, scene] of Object.entries(scenes)) expect(ceremonyPhase(state as HandoffState)).toBe(scene);
    expect(ceremonyPhase(undefined)).toBe('invite');
  });

  it('tells running from final states', () => {
    expect(isCeremonyRunning('spawning')).toBe(true);
    expect(isCeremonyRunning('rolling_back')).toBe(true);
    expect(isCeremonyRunning('proposed')).toBe(false);
    expect(isCeremonyRunning(undefined)).toBe(false);
    expect(isCeremonyFinal('done')).toBe(true);
    expect(isCeremonyFinal('rolled_back')).toBe(true);
    expect(isCeremonyFinal('cancelled')).toBe(true);
    expect(isCeremonyFinal('rolling_back')).toBe(false);
  });

  it('derives the paw progress from step records, including a failed step', () => {
    const running = ceremonySteps({ state: 'transferring', steps: [
      { step: 'packing', at: 't1', ok: true, detail: '交接包：2 件事项' },
      { step: 'spawning', at: 't2', ok: true }
    ] });
    expect(running.map(step => step.status)).toEqual(['done', 'done', 'active', 'pending', 'pending', 'pending']);
    expect(running[0]).toMatchObject({ label: '打包交接包', detail: '交接包：2 件事项' });

    const failed = ceremonySteps({ state: 'rolled_back', steps: [
      { step: 'packing', at: 't1', ok: true },
      { step: 'spawning', at: 't2', ok: false, detail: 'agent 起不来' }
    ] });
    expect(failed.map(step => step.status)).toEqual(['done', 'failed', 'pending', 'pending', 'pending', 'pending']);
    expect(failed[1]?.detail).toBe('agent 起不来');

    // 重发交接说明：先失败、后成功，以最后一次成功为准。
    const resent = ceremonySteps({ state: 'done', steps: [
      { step: 'briefing', at: 't1', ok: false, detail: '发送失败' },
      { step: 'briefing', at: 't2', ok: true, detail: '已重发' }
    ] });
    expect(resent[5]).toMatchObject({ status: 'done', detail: '已重发' });
    expect(ceremonySteps(undefined).every(step => step.status === 'pending')).toBe(true);
  });

  it('counts transfers by status for the success / partial / needs-confirmation summary', () => {
    expect(transferSummary([transfer('transferred', 'a'), transfer('transferred', 'b'), transfer('needs_confirmation'), transfer('failed'), transfer('reverted')]))
      .toEqual({ total: 5, transferred: 2, needsConfirmation: 1, failed: 1, reverted: 1 });
  });
});

describe('lifecycle reactions', () => {
  it('does not replay old events on the first load', () => {
    expect(diffLifecycle(undefined, light({ handoff: summary({ id: 'ahand_1', state: 'proposed' }) }))).toEqual([]);
    expect(diffLifecycle(light(), light())).toEqual([]);
  });

  it('bubbles a new handoff proposal once, with the ceremony as its action', () => {
    const proposed = light({ handoff: summary({ id: 'ahand_1', state: 'proposed' }) });
    expect(diffLifecycle(light(), proposed)).toEqual([{ kind: 'handoff_proposed', handoffId: 'ahand_1' }]);
    expect(diffLifecycle(proposed, proposed)).toEqual([]);
  });

  it('reports maintenance start and finish', () => {
    const running = light({ maintenance: { id: 'amaint_1', trigger: 'auto', createdAt: '2026-11-12T08:00:00.000Z', reasons: [] } });
    expect(diffLifecycle(light(), running)).toEqual([{ kind: 'maintenance_started', trigger: 'auto' }]);
    expect(diffLifecycle(running, light())).toEqual([{ kind: 'maintenance_finished' }]);
  });

  it('reports a finished or rolled back handoff, but not an old one seen again', () => {
    const before = light({ handoff: summary({ id: 'ahand_1', state: 'switching' }) });
    const done = summary({ id: 'ahand_1', state: 'done', outcome: 'needs_confirmation', completedAt: '2026-11-12T08:05:00.000Z' });
    expect(diffLifecycle(before, light({ lastHandoff: done }))).toEqual([{ kind: 'handoff_done', handoffId: 'ahand_1', outcome: 'needs_confirmation' }]);
    expect(diffLifecycle(light({ lastHandoff: done }), light({ lastHandoff: done }))).toEqual([]);

    const rolled = summary({ id: 'ahand_2', state: 'rolled_back', completedAt: '2026-11-12T09:00:00.000Z' });
    expect(diffLifecycle(light({ lastHandoff: done, handoff: summary({ id: 'ahand_2', state: 'spawning' }) }), light({ lastHandoff: rolled })))
      .toEqual([{ kind: 'handoff_rolled_back', handoffId: 'ahand_2' }]);
    const older = summary({ id: 'ahand_0', state: 'done', outcome: 'succeeded', completedAt: '2026-11-01T09:00:00.000Z' });
    expect(diffLifecycle(light({ lastHandoff: done }), light({ lastHandoff: older }))).toEqual([]);
  });

  it('notices the same cat growing up, but not a new generation starting as a kitten', () => {
    const adult = light();
    const senior = light({ cat: { ...adult.cat!, lifeStage: 'senior' } });
    expect(diffLifecycle(adult, senior)).toEqual([{ kind: 'aged', from: 'adult', to: 'senior' }]);
    expect(diffLifecycle(senior, adult)).toEqual([]);
    const successor = light({ cat: { ...adult.cat!, id: 'acat_2', generation: 2, lifeStage: 'kitten' } });
    expect(diffLifecycle(senior, successor)).toEqual([]);
  });

  it('turns events into short bubbles with a fitting tone', () => {
    expect(lifecycleBubble({ kind: 'handoff_proposed', handoffId: 'ahand_1' }, '团子', 'elder')).toEqual({ text: '团子有点累了，要不要交接给下一代？', tone: 'alert' });
    expect(lifecycleBubble({ kind: 'maintenance_started', trigger: 'manual' }, '团子').tone).toBe('muted');
    expect(lifecycleBubble({ kind: 'handoff_done', handoffId: 'h', outcome: 'succeeded' }, '豆豆')).toEqual({ text: '新猫豆豆接班啦，喵！', tone: 'success' });
    expect(lifecycleBubble({ kind: 'handoff_done', handoffId: 'h', outcome: 'partial' }, '豆豆').tone).toBe('alert');
    expect(lifecycleBubble({ kind: 'handoff_rolled_back', handoffId: 'h' }, '团子').text).toContain('旧主会话完好');
    expect(lifecycleBubble({ kind: 'aged', from: 'kitten', to: 'adult' }, '团子').text).toBe('团子长大了：现在是成年猫');
  });
});

describe('system rounds on the timeline', () => {
  it('recognises maintenance and handoff origins only', () => {
    expect(isSystemRoundOrigin('maintenance')).toBe(true);
    expect(isSystemRoundOrigin('handoff')).toBe(true);
    expect(isSystemRoundOrigin('injected')).toBe(false);
    expect(isSystemRoundOrigin(undefined)).toBe(false);
  });

  it('splits the visible prompt into a title and subtitle', () => {
    expect(systemRoundCopy('maintenance', '🧹 整理轮次 · 已完成便签 45/40')).toEqual({ title: '整理轮次', subtitle: '已完成便签 45/40' });
    expect(systemRoundCopy('handoff', '🐾 交接说明 · 第 2 代豆豆接班（前任：第 1 代团子）')).toEqual({ title: '交接说明', subtitle: '第 2 代豆豆接班（前任：第 1 代团子）' });
    expect(systemRoundCopy('maintenance', undefined)).toEqual({ title: '整理轮次', subtitle: '' });
  });

  it('keeps side sessions from earlier generations on the cat\'s note wall', () => {
    expect(isLineageSource('ses_main', 'ses_main')).toBe(true);
    expect(isLineageSource('ses_old', 'ses_main', ['ses_old'])).toBe(true);
    expect(isLineageSource('ses_other', 'ses_main', ['ses_old'])).toBe(false);
    expect(isLineageSource(undefined, 'ses_main')).toBe(false);
  });
});
