import { describe, expect, it } from 'vitest';
import {
  acknowledgeAll, advanceAge, applyLifecycleConfigPatch, assertTransition, buildHandoffPackage, buildMaintenancePrompt,
  canTransition, computeAgeScore, computeLevels, countRounds, decideLifecycleAction, DEFAULT_LIFECYCLE_CONFIG,
  emptyAlertState, extractFileRefs, formatReason, HANDOFF_BRIEFING_MARKER, handoffOutcome, handoffVisibleText,
  isHandoffExecuting, isHandoffOpen, latestContextPercent, lifeStageFor, MAINTENANCE_MARKER, maintenanceVisibleText,
  metricLevel, normalizeAlertState, normalizeLifecycleConfig, overallLevel, parseThresholdAssignments, planTransfers,
  reasonsFor, recoveryAction, renderHandoffBriefing, serializeLifecycleConfig, stageProgress,
  type BuildHandoffPackageInput, type LifecycleDecisionInput, type LifecycleMetrics
} from './lifecycle.js';

const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const metrics = (patch: Partial<LifecycleMetrics> = {}): LifecycleMetrics => ({
  rounds: 0, compactions: 0, events: 0, openNotes: 0, closedNotes: 0, archivedNotes: 0, uptimeDays: 0, computedAt: iso(0), ...patch
});

const decide = (patch: Partial<LifecycleDecisionInput> = {}) => decideLifecycleAction({
  catId: 'acat_1', stage: 'adult', metrics: metrics(), config: DEFAULT_LIFECYCLE_CONFIG, alerts: emptyAlertState('acat_1'),
  now: NOW, mainBusy: false, maintenanceActive: false, handoffOpen: false, ...patch
});

describe('lifecycle config', () => {
  it('fills defaults and drops a tidy threshold that is not below handoff', () => {
    expect(normalizeLifecycleConfig(undefined)).toEqual(DEFAULT_LIFECYCLE_CONFIG);
    expect(normalizeLifecycleConfig('garbage')).toEqual(DEFAULT_LIFECYCLE_CONFIG);
    const config = normalizeLifecycleConfig({ thresholds: { rounds: { tidy: 900, handoff: 600 } }, maxAutoRunsPerDay: -1, foldClosedAfterHours: 'x' });
    expect(config.thresholds.rounds).toEqual({ handoff: 600 });
    expect(config.maxAutoRunsPerDay).toBe(DEFAULT_LIFECYCLE_CONFIG.maxAutoRunsPerDay);
    expect(config.foldClosedAfterHours).toBe(DEFAULT_LIFECYCLE_CONFIG.foldClosedAfterHours);
    // 缺字段沿用默认值；显式 null 表示关掉这一档
    expect(normalizeLifecycleConfig({ thresholds: { uptimeDays: { tidy: 10 } } }).thresholds.uptimeDays).toEqual({ tidy: 10, handoff: 45 });
    const off = normalizeLifecycleConfig({ thresholds: { uptimeDays: { tidy: 14, handoff: null } } });
    expect(off.thresholds.uptimeDays).toEqual({ tidy: 14 });
    expect(off.thresholds.events).toEqual(DEFAULT_LIFECYCLE_CONFIG.thresholds.events);
  });

  it('keeps a disabled threshold disabled across a save and reload', () => {
    const patched = applyLifecycleConfigPatch(DEFAULT_LIFECYCLE_CONFIG, { set: { 'uptimeDays.handoff': null, 'rounds.tidy': 300 } });
    const reloaded = normalizeLifecycleConfig(JSON.parse(serializeLifecycleConfig(patched)));
    expect(reloaded).toEqual(patched);
    expect(reloaded.thresholds.uptimeDays).toEqual({ tidy: 14 });
    expect(reloaded.thresholds.openNotes).toEqual({ tidy: 15 });
  });

  it('validates patches loudly instead of silently ignoring bad input', () => {
    const next = applyLifecycleConfigPatch(DEFAULT_LIFECYCLE_CONFIG, { autoMaintenance: false, set: { 'rounds.tidy': 300, 'uptimeDays.handoff': null } });
    expect(next.autoMaintenance).toBe(false);
    expect(next.thresholds.rounds).toEqual({ tidy: 300, handoff: 600 });
    expect(next.thresholds.uptimeDays).toEqual({ tidy: 14 });
    // 原配置不被修改
    expect(DEFAULT_LIFECYCLE_CONFIG.thresholds.rounds.tidy).toBe(200);
    expect(() => applyLifecycleConfigPatch(DEFAULT_LIFECYCLE_CONFIG, { set: { 'bogus.tidy': 1 } })).toThrow('未知阈值');
    expect(() => applyLifecycleConfigPatch(DEFAULT_LIFECYCLE_CONFIG, { set: { 'rounds.later': 1 } })).toThrow('未知阈值');
    expect(() => applyLifecycleConfigPatch(DEFAULT_LIFECYCLE_CONFIG, { set: { 'rounds.tidy': 700 } })).toThrow('必须小于');
    expect(() => applyLifecycleConfigPatch(DEFAULT_LIFECYCLE_CONFIG, { set: { 'rounds.tidy': -5 } })).toThrow('正数');
    expect(() => applyLifecycleConfigPatch(DEFAULT_LIFECYCLE_CONFIG, { foldClosedAfterHours: -1 })).toThrow('foldClosedAfterHours');
    expect(() => applyLifecycleConfigPatch(DEFAULT_LIFECYCLE_CONFIG, { maxAutoRunsPerDay: 1.5 })).toThrow('maxAutoRunsPerDay');
  });

  it('parses CLI threshold assignments', () => {
    expect(parseThresholdAssignments(['rounds.tidy=300', 'events.handoff=30_000', 'contextPercent.tidy=80%', 'uptimeDays.handoff=off']))
      .toEqual({ 'rounds.tidy': 300, 'events.handoff': 30_000, 'contextPercent.tidy': 80, 'uptimeDays.handoff': null });
    expect(() => parseThresholdAssignments(['rounds.tidy'])).toThrow('格式');
    expect(() => parseThresholdAssignments(['rounds.tidy=lots'])).toThrow('数字或 off');
  });
});

describe('metric levels', () => {
  it('treats reaching a threshold as crossing it and ignores missing values', () => {
    expect(metricLevel(199, { tidy: 200, handoff: 600 })).toBe('ok');
    expect(metricLevel(200, { tidy: 200, handoff: 600 })).toBe('tidy');
    expect(metricLevel(600, { tidy: 200, handoff: 600 })).toBe('handoff');
    expect(metricLevel(undefined, { tidy: 1 })).toBe('ok');
    expect(metricLevel(10_000, {})).toBe('ok');
  });

  it('reports the worst level and the threshold that was crossed', () => {
    const sample = metrics({ rounds: 250, contextPercent: 92, closedNotes: 3 });
    const levels = computeLevels(sample, DEFAULT_LIFECYCLE_CONFIG);
    expect(levels).toMatchObject({ rounds: 'tidy', contextPercent: 'handoff', closedNotes: 'ok' });
    expect(overallLevel(levels)).toBe('handoff');
    expect(reasonsFor(sample, DEFAULT_LIFECYCLE_CONFIG, ['rounds', 'contextPercent', 'closedNotes'])).toEqual([
      { metric: 'rounds', level: 'tidy', value: 250, threshold: 200 },
      { metric: 'contextPercent', level: 'handoff', value: 92, threshold: 90 }
    ]);
    expect(formatReason({ metric: 'contextPercent', level: 'handoff', value: 92.4, threshold: 90 })).toBe('上下文用量 92%/90%');
    expect(overallLevel(computeLevels(metrics(), DEFAULT_LIFECYCLE_CONFIG))).toBe('ok');
  });
});

describe('cat aging', () => {
  it('ages by usage first; time alone never makes an old cat', () => {
    expect(computeAgeScore(metrics(), DEFAULT_LIFECYCLE_CONFIG)).toBe(0);
    // 只挂着不用：时间分最多 0.2×1.5 = 0.3，停在成年
    const idle = computeAgeScore(metrics({ uptimeDays: 1_000 }), DEFAULT_LIFECYCLE_CONFIG);
    expect(idle).toBe(0.3);
    expect(lifeStageFor(idle)).toBe('adult');
    expect(lifeStageFor(computeAgeScore(metrics({ rounds: 300 }), DEFAULT_LIFECYCLE_CONFIG))).toBe('adult');
    expect(lifeStageFor(computeAgeScore(metrics({ rounds: 300, uptimeDays: 45 }), DEFAULT_LIFECYCLE_CONFIG))).toBe('senior');
    // 任一用量到交接档 → 老年，与「该交接了」同步
    expect(lifeStageFor(computeAgeScore(metrics({ rounds: 600 }), DEFAULT_LIFECYCLE_CONFIG))).toBe('elder');
    expect(lifeStageFor(computeAgeScore(metrics({ contextPercent: 90 }), DEFAULT_LIFECYCLE_CONFIG))).toBe('elder');
    expect(lifeStageFor(computeAgeScore(metrics({ events: 60_000 }), DEFAULT_LIFECYCLE_CONFIG))).toBe('elder');
  });

  it('ages primarily by completed compactions and keeps events as a high cap only', () => {
    const score = (compactions: number) => computeAgeScore(metrics({ compactions }), DEFAULT_LIFECYCLE_CONFIG);
    expect(score(1)).toBe(0.181);
    expect(score(3)).toBe(0.45);
    expect(score(4)).toBe(0.571);
    expect(score(6)).toBe(0.8);
    expect(lifeStageFor(score(3))).toBe('senior');
    expect(lifeStageFor(score(4))).toBe('senior');
    expect(lifeStageFor(score(6))).toBe('elder');

    // 30k 段只到整理档，不进入 ageScore；到 60k 上限才作为病理体积保护。
    const belowCap = metrics({ events: 30_000 });
    expect(computeAgeScore(belowCap, DEFAULT_LIFECYCLE_CONFIG)).toBe(0);
    expect(computeLevels(belowCap, DEFAULT_LIFECYCLE_CONFIG).events).toBe('tidy');
    expect(computeAgeScore(metrics({ events: 60_000 }), DEFAULT_LIFECYCLE_CONFIG)).toBe(0.8);
  });

  it('never gets younger when context usage drops after compaction', () => {
    const first = advanceAge(0, 0.5);
    expect(first).toEqual({ peak: 0.5, stage: 'senior' });
    expect(advanceAge(first.peak, 0.1)).toEqual({ peak: 0.5, stage: 'senior' });
    expect(advanceAge(Number.NaN, 0.2)).toEqual({ peak: 0.2, stage: 'adult' });
  });

  it('reports progress toward the next stage', () => {
    expect(stageProgress(0)).toBe(0);
    expect(stageProgress(0.075)).toBeCloseTo(0.5);
    expect(stageProgress(0.3)).toBeCloseTo(0.5);
    expect(stageProgress(0.9)).toBe(1);
  });
});

describe('auto detection without spam', () => {
  it('opens one maintenance round per threshold and stays quiet afterwards', () => {
    const first = decide({ metrics: metrics({ closedNotes: 45 }) });
    expect(first.action).toBe('maintenance');
    expect(first.reasons).toEqual([{ metric: 'closedNotes', level: 'tidy', value: 45, threshold: 40 }]);
    expect(first.alerts.levels.closedNotes).toBe('tidy');
    expect(first.alerts.autoRuns).toEqual([iso(0)]);

    // 同一档：不再提醒（哪怕过了冷却）
    const again = decide({ metrics: metrics({ closedNotes: 48 }), alerts: first.alerts, now: NOW + 30 * HOUR });
    expect(again).toMatchObject({ action: 'none', reasons: [] });
    expect(again.blocked).toBeUndefined();
  });

  it('acts again only when a metric worsens to the next level', () => {
    const tidy = decide({ metrics: metrics({ rounds: 250 }) });
    expect(tidy.action).toBe('maintenance');
    const handoff = decide({ metrics: metrics({ rounds: 650 }), alerts: tidy.alerts, now: NOW + HOUR });
    expect(handoff.action).toBe('propose_handoff');
    expect(handoff.reasons).toEqual([{ metric: 'rounds', level: 'handoff', value: 650, threshold: 600 }]);
    expect(handoff.alerts.lastProposalAt).toBe(iso(HOUR));
    const quiet = decide({ metrics: metrics({ rounds: 700 }), alerts: handoff.alerts, now: NOW + 2 * HOUR });
    expect(quiet.action).toBe('none');
  });

  it('re-arms a metric after it drops back, so a later crossing alerts again', () => {
    const first = decide({ metrics: metrics({ closedNotes: 45 }) });
    const folded = decide({ metrics: metrics({ closedNotes: 2 }), alerts: first.alerts, now: NOW + HOUR });
    expect(folded.action).toBe('none');
    expect(folded.alerts.levels.closedNotes).toBe('ok');
    const later = decide({ metrics: metrics({ closedNotes: 41 }), alerts: folded.alerts, now: NOW + 13 * HOUR });
    expect(later.action).toBe('maintenance');
  });

  it('waits while busy without acknowledging, then runs when idle', () => {
    const busy = decide({ metrics: metrics({ openNotes: 20 }), mainBusy: true });
    expect(busy).toMatchObject({ action: 'none', blocked: 'busy' });
    expect(busy.alerts.levels.openNotes).toBeUndefined();
    expect(decide({ metrics: metrics({ openNotes: 20 }), alerts: busy.alerts }).action).toBe('maintenance');
  });

  it('respects the stage cooldown and the daily cap', () => {
    const recent = { ...emptyAlertState('acat_1'), autoRuns: [iso(-HOUR)] };
    expect(decide({ stage: 'kitten', metrics: metrics({ openNotes: 20 }), alerts: recent })).toMatchObject({ action: 'none', blocked: 'cooldown' });
    const older = { ...emptyAlertState('acat_1'), autoRuns: [iso(-7 * HOUR)] };
    expect(decide({ stage: 'elder', metrics: metrics({ openNotes: 20 }), alerts: older }).action).toBe('maintenance');
    const capped = { ...emptyAlertState('acat_1'), autoRuns: [iso(-13 * HOUR)] };
    const config = { ...DEFAULT_LIFECYCLE_CONFIG, maxAutoRunsPerDay: 1 };
    expect(decide({ metrics: metrics({ openNotes: 20 }), alerts: capped, config })).toMatchObject({ action: 'none', blocked: 'daily_cap' });
    // 超过 24 小时的记录不算进上限
    const stale = { ...emptyAlertState('acat_1'), autoRuns: [iso(-25 * HOUR)] };
    const result = decide({ metrics: metrics({ openNotes: 20 }), alerts: stale, config });
    expect(result.action).toBe('maintenance');
    expect(result.alerts.autoRuns).toEqual([iso(0)]);
  });

  it('acknowledges when disabled or already tidying, but not while a handoff proposal is open', () => {
    const disabled = decide({ metrics: metrics({ openNotes: 20 }), config: { ...DEFAULT_LIFECYCLE_CONFIG, autoMaintenance: false } });
    expect(disabled).toMatchObject({ action: 'none', blocked: 'disabled' });
    expect(disabled.alerts.levels.openNotes).toBe('tidy');
    const active = decide({ metrics: metrics({ openNotes: 20 }), maintenanceActive: true });
    expect(active).toMatchObject({ action: 'none', blocked: 'maintenance_active' });
    expect(active.alerts.levels.openNotes).toBe('tidy');
    const open = decide({ metrics: metrics({ openNotes: 20 }), handoffOpen: true });
    expect(open).toMatchObject({ action: 'none', blocked: 'handoff_open' });
    expect(open.alerts.levels.openNotes).toBeUndefined();
    // 已有提议时，新的交接档只记账，不重复提议
    const dup = decide({ metrics: metrics({ rounds: 650 }), handoffOpen: true });
    expect(dup).toMatchObject({ action: 'none', blocked: 'handoff_open' });
    expect(dup.alerts.levels.rounds).toBe('handoff');
  });

  it('treats a handoff-level metric as a tidy trigger when auto proposals are off', () => {
    const result = decide({ metrics: metrics({ rounds: 650 }), config: { ...DEFAULT_LIFECYCLE_CONFIG, autoProposeHandoff: false } });
    expect(result.action).toBe('maintenance');
  });

  it('starts fresh for a new cat', () => {
    const old = { ...emptyAlertState('acat_old'), levels: { closedNotes: 'tidy' as const }, autoRuns: [iso(-HOUR)] };
    const result = decide({ catId: 'acat_new', stage: 'kitten', metrics: metrics({ closedNotes: 45 }), alerts: old });
    expect(result.action).toBe('maintenance');
    expect(result.alerts.catId).toBe('acat_new');
  });

  it('only senior and elder cats ask again after a dismissal, on their own schedule', () => {
    const dismissed = { ...emptyAlertState('acat_1'), levels: { rounds: 'handoff' as const }, lastProposalAt: iso(-120 * HOUR), lastDismissedAt: iso(-96 * HOUR) };
    const remind = decide({ stage: 'elder', metrics: metrics({ rounds: 650 }), alerts: dismissed });
    expect(remind).toMatchObject({ action: 'propose_handoff', remind: true });
    expect(remind.alerts.lastProposalAt).toBe(iso(0));
    expect(decide({ stage: 'elder', metrics: metrics({ rounds: 650 }), alerts: { ...dismissed, lastDismissedAt: iso(-24 * HOUR) } }).action).toBe('none');
    expect(decide({ stage: 'adult', metrics: metrics({ rounds: 650 }), alerts: dismissed }).action).toBe('none');
    expect(decide({ stage: 'senior', metrics: metrics({ rounds: 650 }), alerts: dismissed }).action).toBe('none');
    expect(decide({ stage: 'senior', metrics: metrics({ rounds: 650 }), alerts: { ...dismissed, lastProposalAt: iso(-180 * HOUR), lastDismissedAt: iso(-170 * HOUR) } }).action).toBe('propose_handoff');
  });

  it('acknowledges everything after a manual run and survives corrupt alert state', () => {
    const acked = acknowledgeAll(emptyAlertState('acat_1'), 'acat_1', metrics({ closedNotes: 45, rounds: 650 }), DEFAULT_LIFECYCLE_CONFIG);
    expect(acked.levels).toMatchObject({ closedNotes: 'tidy', rounds: 'handoff', openNotes: 'ok' });
    expect(decide({ metrics: metrics({ closedNotes: 45, rounds: 650 }), alerts: acked }).action).toBe('none');
    expect(normalizeAlertState({ levels: { rounds: 'huge', bogus: 'tidy', events: 'tidy' }, autoRuns: [1, 'x'] }))
      .toEqual({ levels: { events: 'tidy' }, autoRuns: ['x'] });
  });
});

describe('handoff state machine', () => {
  it('walks the happy path in order and refuses shortcuts', () => {
    const path = ['proposed', 'confirmed', 'packing', 'spawning', 'transferring', 'switching', 'retiring', 'briefing', 'done'] as const;
    for (let index = 1; index < path.length; index++) expect(canTransition(path[index - 1]!, path[index]!)).toBe(true);
    expect(canTransition('proposed', 'done')).toBe(false);
    expect(canTransition('packing', 'switching')).toBe(false);
    // 提交点之后不能回滚：旧会话已经归档
    expect(canTransition('briefing', 'rolling_back')).toBe(false);
    expect(canTransition('done', 'proposed')).toBe(false);
    expect(canTransition('spawning', 'rolling_back')).toBe(true);
    expect(() => assertTransition('cancelled', 'confirmed')).toThrow('不能从 cancelled 变成 confirmed');
    expect(isHandoffOpen('proposed')).toBe(true);
    expect(isHandoffExecuting('proposed')).toBe(false);
    expect(isHandoffExecuting('switching')).toBe(true);
    expect(isHandoffOpen('rolled_back')).toBe(false);
  });

  it('recovers after a crash: roll back before the commit point, mark partial after it', () => {
    expect(recoveryAction('proposed')).toBe('none');
    expect(recoveryAction('spawning')).toBe('rollback');
    expect(recoveryAction('switching')).toBe('rollback');
    expect(recoveryAction('rolling_back')).toBe('rollback');
    expect(recoveryAction('retiring')).toBe('rollback');
    expect(recoveryAction('retiring', { predecessorArchived: true })).toBe('mark_partial');
    expect(recoveryAction('briefing')).toBe('mark_partial');
    expect(recoveryAction('done')).toBe('none');
  });

  it('derives success / partial failure / needs confirmation', () => {
    expect(handoffOutcome([{ status: 'transferred' }], true)).toBe('succeeded');
    expect(handoffOutcome([], true)).toBe('succeeded');
    expect(handoffOutcome([{ status: 'transferred' }, { status: 'needs_confirmation' }], true)).toBe('needs_confirmation');
    expect(handoffOutcome([{ status: 'failed' }, { status: 'needs_confirmation' }], true)).toBe('partial');
    expect(handoffOutcome([{ status: 'transferred' }], false)).toBe('partial');
  });
});

describe('note handoff plan', () => {
  it('transfers open work and flags what the user must confirm, skipping closed and archived notes', () => {
    const sessions = new Map<string, { archivedAt?: string; state: string } | undefined>([
      ['ses_live', { state: 'idle' }],
      ['ses_arch', { archivedAt: iso(0), state: 'stopped' }],
      ['ses_gone', undefined]
    ]);
    const plan = planTransfers({
      tasks: [
        { id: 't1', title: '修登录', state: 'running', plan: false, sessionId: 'ses_live' },
        { id: 't2', title: '计划卡', state: 'review', plan: true },
        { id: 't3', title: '等拍板', state: 'needs_user', plan: false, sessionId: 'ses_live' },
        { id: 't4', title: '会话没了', state: 'running', plan: false, sessionId: 'ses_gone' },
        { id: 't5', title: '会话归档', state: 'review', plan: false, sessionId: 'ses_arch' },
        { id: 't6', title: '做完了', state: 'closed', plan: false },
        { id: 't7', title: '归档了', state: 'closed', plan: false, archivedAt: iso(0) }
      ],
      watches: [
        { id: 'w1', name: 'CI', state: 'active', ownerSessionId: 'ses_main' },
        { id: 'w2', name: '暂停的', state: 'paused', ownerSessionId: 'ses_main' },
        { id: 'w3', name: '触发过', state: 'fired', ownerSessionId: 'ses_main' },
        { id: 'w4', name: '过期', state: 'expired', ownerSessionId: 'ses_main' }
      ],
      drafts: [
        { id: 'd1', channel: 'github_comment', target: 'github:o/r#1', state: 'pending' },
        { id: 'd2', channel: 'lark_reply', target: 'lark:x', state: 'sent' }
      ],
      sessions
    });
    expect(plan.map(item => [item.kind, item.itemId, item.status])).toEqual([
      ['task', 't1', 'transferred'],
      ['task', 't2', 'needs_confirmation'],
      ['task', 't3', 'needs_confirmation'],
      ['task', 't4', 'needs_confirmation'],
      ['task', 't5', 'needs_confirmation'],
      ['watch', 'w1', 'transferred'],
      ['watch', 'w2', 'transferred'],
      ['draft', 'd1', 'needs_confirmation']
    ]);
    expect(plan.find(item => item.itemId === 't4')?.detail).toContain('不存在');
    expect(plan.find(item => item.itemId === 't5')?.detail).toContain('已归档');
  });
});

describe('metric sources', () => {
  it('counts executed rounds but never the system rounds it opens itself', () => {
    const task = (status: string, origin?: string) => ({ status, ...(origin ? { origin } : {}), createdAt: iso(0), prompt: 'x' });
    expect(countRounds([
      task('completed'), task('completed', 'injected'), task('completed', 'maintenance'), task('failed', 'handoff'),
      task('queued'), task('cancelled'), task('running'), task('interrupted', 'emoji')
    ])).toBe(4);
  });

  it('reads the latest real context usage', () => {
    expect(latestContextPercent([
      { type: 'status', data: { state: 'usage', used: 50, size: 100 } },
      { type: 'status', data: { state: 'usage', used: 0, size: 100 } },
      { type: 'text', data: { text: 'hi' } }
    ])).toBe(50);
    expect(latestContextPercent([{ type: 'status', data: { state: 'usage', used: 180_000, size: 200_000 } }])).toBe(90);
    expect(latestContextPercent([{ type: 'status', data: { state: 'idle' } }])).toBeUndefined();
  });

  it('indexes file references from tools and user messages only, without noise', () => {
    const refs = extractFileRefs([
      { type: 'tool_call', timestamp: '2026-11-12T01:00:00.000Z', data: { input: { file_path: '/Users/codeax/workspace/agent-dock/README.md' } } },
      { type: 'tool_call', timestamp: '2026-11-12T02:00:00.000Z', data: { input: { command: 'cat /Users/codeax/workspace/agent-dock/README.md > /dev/null && /usr/bin/env true' } } },
      { type: 'text', timestamp: '2026-11-12T03:00:00.000Z', data: { role: 'user', text: '看看 /Users/codeax/notes/plan.md，谢谢' } },
      { type: 'text', timestamp: '2026-11-12T04:00:00.000Z', data: { role: 'user', origin: 'maintenance', text: '/Users/codeax/secret/ignored.md' } },
      { type: 'text', timestamp: '2026-11-12T05:00:00.000Z', data: { role: 'assistant', text: ' /Users/codeax/assistant/ignored.md' } }
    ]);
    expect(refs).toEqual([
      { path: '/Users/codeax/workspace/agent-dock/README.md', count: 2, lastSeenAt: '2026-11-12T02:00:00.000Z', sources: ['tool'] },
      { path: '/Users/codeax/notes/plan.md', count: 1, lastSeenAt: '2026-11-12T03:00:00.000Z', sources: ['message'] }
    ]);
    expect(extractFileRefs([
      { type: 'tool_call', timestamp: iso(0), data: { input: { path: '/a/b/c' } } },
      { type: 'tool_call', timestamp: iso(0), data: { input: { path: '/d/e/f' } } }
    ], 1)).toHaveLength(1);
  });
});

function packageInput(patch: Partial<BuildHandoffPackageInput> = {}): BuildHandoffPackageInput {
  const turns = Array.from({ length: 8 }, (_, index) => ({
    status: 'completed', createdAt: iso(index * HOUR), prompt: `第 ${index + 1} 个问题`, finalText: `第 ${index + 1} 个回答`
  }));
  return {
    handoffId: 'ahand_1', createdAt: iso(10 * HOUR), trigger: 'threshold',
    predecessor: {
      catId: 'acat_1', familyId: 'afam_1', generation: 1, sessionId: 'ses_old', name: '团子', adoptedAt: iso(-48 * HOUR),
      lifeStage: 'elder', agentId: 'claude', model: 'opus', cwd: '/Users/codeax/workspace/agent-dock'
    },
    successorName: '团子',
    metrics: metrics({ rounds: 650, events: 12_000, contextPercent: 91, openNotes: 2, closedNotes: 3, uptimeDays: 2 }),
    tasks: [
      ...turns,
      { status: 'completed', origin: 'maintenance', createdAt: iso(8.5 * HOUR), prompt: '🧹 整理轮次', finalText: '摘要' },
      { status: 'running', createdAt: iso(9 * HOUR), prompt: '还在跑' },
      { status: 'queued', createdAt: iso(9.5 * HOUR), prompt: '排队中' }
    ],
    openTasks: [
      { id: 'atask_open', title: '修登录超时', state: 'running', plan: false, round: 1, sessionId: 'ses_side', doneWhen: ['测试通过'], notes: '' },
      { id: 'atask_plan', title: '计划卡', state: 'review', plan: true, round: 0, doneWhen: ['用户点头'], notes: '先别动' },
      { id: 'atask_done', title: '做完了', state: 'closed', plan: false, round: 1, doneWhen: [], notes: '' },
      { id: 'atask_arch', title: '早归档了', state: 'closed', plan: false, round: 1, doneWhen: [], notes: '', archivedAt: iso(0) }
    ],
    watches: [
      { id: 'awatch_1', name: 'CI 变绿', state: 'active', command: 'gh run list', intervalSeconds: 60, mode: 'once' },
      { id: 'awatch_2', name: '旧的', state: 'expired', command: 'true', intervalSeconds: 60, mode: 'once' }
    ],
    drafts: [
      { id: 'adraft_1', channel: 'github_comment', target: 'github:o/r#1', body: 'LGTM '.repeat(100), state: 'pending' },
      { id: 'adraft_2', channel: 'lark_reply', target: 'lark:x', body: 'sent', state: 'sent' }
    ],
    fileRefs: [{ path: '/Users/codeax/workspace/agent-dock/README.md', count: 3, lastSeenAt: iso(0), sources: ['tool'] }],
    closedNotes: { archived: 1, batchId: 'aarch_1' },
    ancestors: [],
    ...patch
  };
}

describe('handoff package', () => {
  it('is pure data with the predecessor context the successor needs', () => {
    const pkg = buildHandoffPackage(packageInput());
    expect(buildHandoffPackage(packageInput())).toEqual(pkg);
    expect(pkg.successor).toEqual({ name: '团子', generation: 2 });
    expect(pkg.recentTurns.map(turn => turn.prompt)).toEqual(['第 3 个问题', '第 4 个问题', '第 5 个问题', '第 6 个问题', '第 7 个问题', '第 8 个问题']);
    expect(pkg.recentTurns.every(turn => turn.origin !== 'maintenance')).toBe(true);
    expect(pkg.openTasks.map(task => task.id)).toEqual(['atask_open', 'atask_plan']);
    expect(pkg.watches.map(watch => watch.id)).toEqual(['awatch_1']);
    expect(pkg.pendingDrafts.map(draft => draft.id)).toEqual(['adraft_1']);
    expect(pkg.pendingDrafts[0]!.preview.length).toBeLessThanOrEqual(161);
    expect(pkg.closedNotes).toEqual({ archived: 1, batchId: 'aarch_1' });
  });

  it('renders a briefing that is clearly not a user message and points at the archived predecessor', () => {
    const pkg = buildHandoffPackage(packageInput({
      letter: { runId: 'amaint_1', createdAt: iso(0), summary: '本代主线：修登录超时；等用户拍板发版。' },
      ancestors: [{ generation: 0, name: '始祖', sessionId: 'ses_root' }]
    }));
    const briefing = renderHandoffBriefing(pkg);
    expect(briefing.startsWith(HANDOFF_BRIEFING_MARKER)).toBe(true);
    expect(briefing).toContain('不是用户消息');
    expect(briefing).toContain('第 2 代主会话「团子」');
    expect(briefing).toContain('agent-dock session show ses_old');
    expect(briefing).toContain('不要派活');
    expect(briefing).toContain('atask_open');
    expect(briefing).toContain('awatch_1');
    expect(briefing).toContain('adraft_1');
    expect(briefing).toContain('本代主线：修登录超时');
    expect(briefing).toContain('ses_root');
    expect(briefing).toContain('批次 aarch_1');
    expect(briefing).toContain('退休时是老年猫');
    expect(handoffVisibleText(pkg)).toBe('🐾 交接说明 · 第 2 代团子接班（前任：第 1 代团子）');
    const kitten = renderHandoffBriefing(buildHandoffPackage(packageInput({ predecessor: { ...packageInput().predecessor, lifeStage: 'kitten' } })));
    expect(kitten).toContain('退休时是幼猫');
    expect(kitten).not.toContain('幼猫猫');
  });
});

describe('maintenance round prompt', () => {
  it('asks only for summaries and suggestions, never for dispatching or touching files', () => {
    const prompt = buildMaintenancePrompt({
      runId: 'amaint_1', trigger: 'auto', reasons: [{ metric: 'closedNotes', level: 'tidy', value: 45, threshold: 40 }],
      metrics: metrics({ closedNotes: 45 }), catName: '团子', generation: 2, stage: 'kitten',
      closedNotes: [{ id: 'atask_1', title: '修登录', outcome: 'accepted' }, { id: 'atask_2', title: '算了', outcome: 'cancelled' }],
      fileRefs: [{ path: '/Users/codeax/notes/plan.md', count: 2, lastSeenAt: iso(0), sources: ['message'] }],
      foldClosedAfterHours: 12
    });
    expect(prompt.startsWith(MAINTENANCE_MARKER)).toBe(true);
    expect(prompt).toContain('amaint_1');
    expect(prompt).toContain('不是用户消息');
    expect(prompt).toContain('不要 task start');
    expect(prompt).toContain('不要删除、移动或修改任何文件');
    expect(prompt).toContain('不要调用 agent-dock maintenance run');
    expect(prompt).toContain('关闭超过 12 小时');
    expect(prompt).toContain('[atask_2] 算了 · 已取消');
    expect(prompt).toContain('/Users/codeax/notes/plan.md');
    expect(prompt).toContain('现在是幼猫。');
    expect(maintenanceVisibleText('manual', [])).toBe('🧹 整理轮次 · 你让我收拾一下');
    // 主会话自己要求的整理不能写成「你让我」：那会冒充用户
    expect(maintenanceVisibleText('manual', [], 'main')).toBe('🧹 整理轮次 · 我自己收拾一下');
    expect(maintenanceVisibleText('auto', [{ metric: 'closedNotes', level: 'tidy', value: 45, threshold: 40 }])).toBe('🧹 整理轮次 · 已完成便签 45/40');
  });
});
