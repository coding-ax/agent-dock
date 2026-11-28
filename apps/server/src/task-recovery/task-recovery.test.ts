import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TASK_RECOVERY_ORIGIN,
  type AgentConfig,
  type RepositoryBundle,
  type Session,
  type TaskRecord,
  type TaskRecoveryRecord
} from '@agent-dock/agent-dock-shared';
import { AgentDockRuntime, type AgentDriver } from '@agent-dock/agent-dock-runtime';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import { buildApp } from '../app.js';
import { saveLarkConfig } from '../lark/config.js';
import { larkHandoverChannel } from '../lark/handover-binding.js';
import {
  buildTaskRecoveryConfirmCard,
  buildTaskRecoveryResolvedCard,
  isTaskRecoveryCardAction,
  LARK_TASK_RECOVERY_DECIDE_ACTION,
  parseTaskRecoveryCardAction
} from './lark-card.js';
import {
  readTaskRecoveryConfig,
  saveTaskRecoveryConfig,
  TaskRecoveryService,
  type TaskRecoveryLarkPort
} from './service.js';

const mockAgent: AgentConfig = {
  id: 'mock',
  name: 'Mock Agent',
  command: 'mock',
  args: [],
  protocol: 'acp',
  env: {},
  permissionMode: 'full-trust',
  timeout: 60,
  capabilities: { pause: false, resume: true },
  builtin: true
};

const cleanupCallbacks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupCallbacks.length) {
    const fn = cleanupCallbacks.pop();
    try { await fn?.(); } catch { /* ignore */ }
  }
});

function createRuntimeHarness(options: {
  repos?: RepositoryBundle;
  onSend?: (prompt: string, sessionId: string) => void;
} = {}) {
  const repos = options.repos ?? createRepositories(':memory:');
  if (!options.repos) cleanupCallbacks.push(() => repos.close());
  const sentPrompts: Array<{ sessionId: string; prompt: string }> = [];
  const runtime = new AgentDockRuntime(repos, {
    driverFactory: (_agent, _protocol, onEvent, _onExit, sessionId): AgentDriver => ({
      start: async () => undefined,
      send: async prompt => {
        sentPrompts.push({ sessionId, prompt });
        options.onSend?.(prompt, sessionId);
        onEvent({ type: 'text', data: { text: '已核对工作区并完成断点续跑。' } });
        onEvent({ type: 'completed', data: { stopReason: 'end_turn' } });
      },
      interrupt: async () => undefined,
      resume: async () => undefined,
      stop: async () => undefined
    })
  });
  cleanupCallbacks.push(() => runtime.shutdown());
  return { repos, runtime, sentPrompts };
}

async function seedSessionWithTask(
  repos: RepositoryBundle,
  input: {
    sessionId: string;
    taskId: string;
    prompt: string;
    sessionState?: Session['state'];
    interruptIntent?: Session['interruptIntent'];
    taskStatus?: string;
    taskOrigin?: string | null;
    source?: string;
    sourceId?: string;
    archivedAt?: string;
    timestamp: string;
  }
) {
  await repos.sessions.save({
    id: input.sessionId,
    agentId: 'mock',
    state: input.sessionState ?? 'running_tool',
    ...(input.interruptIntent ? { interruptIntent: input.interruptIntent } : {}),
    cwd: '/tmp/workspace',
    permissionMode: 'full-trust',
    protocol: 'acp',
    ...(input.source ? { source: input.source } : {}),
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    ...(input.archivedAt ? { archivedAt: input.archivedAt } : {}),
    runId: 'run_prev',
    createdAt: input.timestamp,
    updatedAt: input.timestamp
  });
  await repos.tasks.save({
    id: input.taskId,
    sessionId: input.sessionId,
    prompt: input.prompt,
    status: input.taskStatus ?? 'running',
    ...(input.taskOrigin !== undefined ? { origin: input.taskOrigin } : {}),
    createdAt: input.timestamp,
    updatedAt: input.timestamp
  });
}

describe('TaskRecoveryService — cold-start audit, guardrails, auto & confirm modes', () => {
  it('audits daemon-restart interrupted ordinary sessions while strictly excluding user_stopped, completed, assistant-managed, ephemeral, and system turns', async () => {
    const baseMs = Date.now();
    const recentIso = new Date(baseMs - 3 * 60_000).toISOString();
    const { repos, runtime, sentPrompts } = createRuntimeHarness();

    // 1) Ordinary Web session interrupted mid-run -> SHOULD auto-recover
    await seedSessionWithTask(repos, {
      sessionId: 'ses_web',
      taskId: 'task_web',
      prompt: '修复支付模块超时问题并跑测试',
      timestamp: recentIso
    });
    // 2) Ordinary Lark group session -> SHOULD auto-recover
    await seedSessionWithTask(repos, {
      sessionId: 'ses_lark_group',
      taskId: 'task_lark_group',
      prompt: '检查线上告警日志',
      source: 'lark',
      sourceId: 'cli_bot:oc_group_1:group',
      timestamp: recentIso
    });
    // 3) Ordinary non-kitten scheduled task -> SHOULD auto-recover
    await seedSessionWithTask(repos, {
      sessionId: 'ses_schedule',
      taskId: 'task_schedule',
      prompt: '[AgentDock 定时任务 sch_1 · 巡检] 检查依赖更新',
      taskOrigin: 'schedule',
      timestamp: recentIso
    });
    // 4) User-stopped session (already interrupted with intent=user) -> MUST EXCLUDE
    await seedSessionWithTask(repos, {
      sessionId: 'ses_user_stopped',
      taskId: 'task_user_stopped',
      prompt: '用户主动停掉的任务',
      sessionState: 'interrupted',
      interruptIntent: 'user',
      taskStatus: 'interrupted',
      timestamp: recentIso
    });
    // 5) Session in interrupting state at crash time -> MUST EXCLUDE as user_stopped
    await seedSessionWithTask(repos, {
      sessionId: 'ses_interrupting',
      taskId: 'task_interrupting',
      prompt: '正在取消中的任务',
      sessionState: 'interrupting',
      taskStatus: 'running',
      timestamp: recentIso
    });
    // 6) Completed task -> MUST EXCLUDE
    await seedSessionWithTask(repos, {
      sessionId: 'ses_completed',
      taskId: 'task_completed',
      prompt: '已完成的任务',
      sessionState: 'completed',
      taskStatus: 'completed',
      timestamp: recentIso
    });
    // 7) Main kitten session -> MUST EXCLUDE
    await seedSessionWithTask(repos, {
      sessionId: 'ses_kitten_main',
      taskId: 'task_kitten_main',
      prompt: '主小猫任务',
      source: 'assistant-main',
      timestamp: recentIso
    });
    // 8) Kitten-supervised side task session -> MUST EXCLUDE
    await seedSessionWithTask(repos, {
      sessionId: 'ses_kitten_side',
      taskId: 'task_kitten_side',
      prompt: '小猫派出的侧边事项',
      source: 'side-chat',
      sourceId: 'ses_kitten_main',
      timestamp: recentIso
    });
    // 9) Ephemeral lark-avatar session -> MUST EXCLUDE
    await seedSessionWithTask(repos, {
      sessionId: 'ses_avatar',
      taskId: 'task_avatar',
      prompt: '替身分析',
      source: 'lark-avatar',
      timestamp: recentIso
    });
    // 10) System origin injected turn -> MUST EXCLUDE
    await seedSessionWithTask(repos, {
      sessionId: 'ses_system_turn',
      taskId: 'task_system_turn',
      prompt: '📋 督办',
      taskOrigin: 'injected',
      timestamp: recentIso
    });

    await runtime.initialize([mockAgent]);

    const service = new TaskRecoveryService({
      repos,
      runtime,
      nowMs: () => baseMs,
      initialDelayMs: 0,
      staggerUnitMs: 1,
      isAssistantManaged: session => session.id === 'ses_kitten_side' || session.source === 'assistant-main'
    });
    cleanupCallbacks.push(() => service.close());

    const summary = await service.auditStartupInterruptions();
    expect(summary.scheduled).toBe(3);

    await vi.waitFor(async () => {
      const resumed = await service.listRecords({ status: 'resumed' });
      expect(resumed).toHaveLength(3);
    });
    await service.flushPending();

    const resumedSessions = new Set((await service.listRecords({ status: 'resumed' })).map(r => r.sessionId));
    expect(resumedSessions).toEqual(new Set(['ses_web', 'ses_lark_group', 'ses_schedule']));

    // Verify excluded tasks were never dispatched
    expect(sentPrompts.map(item => item.sessionId).sort()).toEqual(['ses_lark_group', 'ses_schedule', 'ses_web']);

    // Verify checkpoint self-inspection prompt guardrails
    const webPrompt = sentPrompts.find(item => item.sessionId === 'ses_web')?.prompt ?? '';
    expect(webPrompt).toContain('[AgentDock 系统断点续跑指令]');
    expect(webPrompt).toContain('严禁重复执行已完成且带有外部副作用的操作');
    expect(webPrompt).toContain('修复支付模块超时问题并跑测试');

    // Verify recovery task origin is TASK_RECOVERY_ORIGIN
    const webTasks = await runtime.getTasks('ses_web');
    const recoveryTask = webTasks.find(t => t.origin === TASK_RECOVERY_ORIGIN);
    expect(recoveryTask).toBeDefined();
    expect(recoveryTask?.prompt).toContain('🔄 断点续跑');

    // Verify skip reasons recorded cleanly
    const interruptRecord = await repos.taskRecoveries.getByInterruptedTaskId('task_interrupting');
    expect(interruptRecord).toMatchObject({ status: 'skipped', skipReason: 'user_stopped' });
    const kittenSideRecord = await repos.taskRecoveries.getByInterruptedTaskId('task_kitten_side');
    expect(kittenSideRecord).toMatchObject({ status: 'skipped', skipReason: 'assistant_managed' });
    const kittenMainRecord = await repos.taskRecoveries.getByInterruptedTaskId('task_kitten_main');
    expect(kittenMainRecord).toMatchObject({ status: 'skipped', skipReason: 'assistant_managed' });
    const avatarRecord = await repos.taskRecoveries.getByInterruptedTaskId('task_avatar');
    expect(avatarRecord).toMatchObject({ status: 'skipped', skipReason: 'ephemeral_session' });
    const sysRecord = await repos.taskRecoveries.getByInterruptedTaskId('task_system_turn');
    expect(sysRecord).toMatchObject({ status: 'skipped', skipReason: 'system_origin' });
    // User-stopped & completed were never even touched
    expect(await repos.taskRecoveries.getByInterruptedTaskId('task_user_stopped')).toBeUndefined();
    expect(await repos.taskRecoveries.getByInterruptedTaskId('task_completed')).toBeUndefined();
  });

  it('enforces 15-minute staleness window guardrail and skips old crashed tasks', async () => {
    const baseMs = Date.now();
    const staleIso = new Date(baseMs - 20 * 60_000).toISOString(); // 20 min ago (> 15 min)
    const freshIso = new Date(baseMs - 5 * 60_000).toISOString();  // 5 min ago (<= 15 min)
    const { repos, runtime, sentPrompts } = createRuntimeHarness();

    await seedSessionWithTask(repos, { sessionId: 'ses_stale', taskId: 'task_stale', prompt: '陈旧任务', timestamp: staleIso });
    await seedSessionWithTask(repos, { sessionId: 'ses_fresh', taskId: 'task_fresh', prompt: '新鲜任务', timestamp: freshIso });
    await runtime.initialize([mockAgent]);

    const service = new TaskRecoveryService({
      repos,
      runtime,
      nowMs: () => baseMs,
      initialDelayMs: 0,
      staggerUnitMs: 0
    });
    cleanupCallbacks.push(() => service.close());

    const summary = await service.auditStartupInterruptions();
    expect(summary.scheduled).toBe(1);
    expect(summary.skipped).toBe(1);

    await vi.waitFor(() => expect(sentPrompts).toHaveLength(1));
    expect(sentPrompts[0]?.sessionId).toBe('ses_fresh');
    expect(await repos.taskRecoveries.getByInterruptedTaskId('task_stale')).toMatchObject({
      status: 'skipped',
      skipReason: 'stale'
    });
  });

  it('enforces max 1 auto-recovery attempt anti-crash-loop guardrail across consecutive restarts', async () => {
    const boot1Ms = Date.now();
    const { repos } = createRuntimeHarness();

    // Boot #1: original task interrupted -> auto-recovers into recoveryTaskId
    await seedSessionWithTask(repos, {
      sessionId: 'ses_loop',
      taskId: 'task_orig',
      prompt: '可能触发崩溃的任务',
      timestamp: new Date(boot1Ms - 60_000).toISOString()
    });

    const dispatched: Array<{ id: string; origin?: string }> = [];
    let releaseSend: (() => void) | undefined;
    const runtime1 = new AgentDockRuntime(repos, {
      driverFactory: (): AgentDriver => ({
        start: async () => undefined,
        // Keep the recovery turn running until simulated crash #2 finishes!
        send: async () => new Promise<void>(resolve => { releaseSend = resolve; }),
        interrupt: async () => { releaseSend?.(); },
        resume: async () => undefined,
        stop: async () => { releaseSend?.(); }
      })
    });
    cleanupCallbacks.push(() => { releaseSend?.(); return runtime1.shutdown(); });
    await runtime1.initialize([mockAgent]);

    const service1 = new TaskRecoveryService({
      repos,
      runtime: runtime1,
      nowMs: () => boot1Ms,
      initialDelayMs: 0,
      staggerUnitMs: 0
    });
    cleanupCallbacks.push(() => service1.close());

    await service1.auditStartupInterruptions();
    await vi.waitFor(async () => {
      const rec = await repos.taskRecoveries.getByInterruptedTaskId('task_orig');
      expect(rec?.status).toBe('resumed');
      expect(rec?.recoveryTaskId).toBeTruthy();
    });
    const rec1 = (await repos.taskRecoveries.getByInterruptedTaskId('task_orig'))!;
    expect(rec1.attemptCount).toBe(1);
    const recoveryTaskId = rec1.recoveryTaskId!;

    // Wait until runtime1 marks recovery task running in SQLite
    await vi.waitFor(async () => {
      const tasks = await repos.tasks.listBySession('ses_loop');
      expect(tasks.find(t => t.id === recoveryTaskId)?.status).toBe('running');
    });
    await service1.close();

    // Boot #2: simulate abrupt crash (daemon restarted while recoveryTaskId was still running in SQLite!)
    // Release runtime1 cleanly AFTER re-seeding SQLite state or before runtime2 boots:
    // Actually releaseSend without letting runtime1 overwrite status:
    const snapshotTasks = await repos.tasks.listBySession('ses_loop');
    const runningRecoveryTask = snapshotTasks.find(t => t.id === recoveryTaskId)!;
    releaseSend?.();
    await runtime1.shutdown();
    // Restore exact pre-crash DB state (task running, session thinking) as if SIGKILL hit daemon
    await repos.tasks.save({ ...runningRecoveryTask, status: 'running' });
    const preCrashSession = (await repos.sessions.get('ses_loop'))!;
    await repos.sessions.save({ ...preCrashSession, state: 'thinking', interruptIntent: undefined });

    const boot2Ms = boot1Ms + 2 * 60_000;
    const runtime2 = new AgentDockRuntime(repos, {
      driverFactory: (): AgentDriver => ({
        start: async () => undefined,
        send: async () => { dispatched.push({ id: 'should_not_run' }); },
        interrupt: async () => undefined,
        resume: async () => undefined,
        stop: async () => undefined
      })
    });
    cleanupCallbacks.push(() => runtime2.shutdown());
    await runtime2.initialize([mockAgent]);

    const service2 = new TaskRecoveryService({
      repos,
      runtime: runtime2,
      nowMs: () => boot2Ms,
      initialDelayMs: 0,
      staggerUnitMs: 0
    });
    cleanupCallbacks.push(() => service2.close());

    const summary2 = await service2.auditStartupInterruptions();
    expect(summary2.scheduled).toBe(0);
    expect(summary2.skipped).toBe(1);
    await service2.flushPending();

    const rec2 = await repos.taskRecoveries.getByInterruptedTaskId(recoveryTaskId);
    expect(rec2).toMatchObject({
      rootTaskId: 'task_orig',
      status: 'skipped',
      skipReason: 'max_attempts',
      attemptCount: 1
    });
    expect(dispatched).toHaveLength(0);
  });

  it('staggers multiple auto-recovery launches and aborts if user already sent a newer message during stagger wait', async () => {
    const baseMs = Date.now();
    const recentIso = new Date(baseMs - 60_000).toISOString();
    const { repos, runtime } = createRuntimeHarness();

    await seedSessionWithTask(repos, { sessionId: 'ses_a', taskId: 'task_a', prompt: '任务 A', timestamp: recentIso });
    await seedSessionWithTask(repos, { sessionId: 'ses_b', taskId: 'task_b', prompt: '任务 B', timestamp: new Date(baseMs - 90_000).toISOString() });
    await runtime.initialize([mockAgent]);

    await saveTaskRecoveryConfig(repos, { mode: 'auto', staggerSeconds: 2 });
    const dispatchTimes: Array<{ sessionId: string; at: number }> = [];
    const origDispatch = runtime.dispatch.bind(runtime);
    vi.spyOn(runtime, 'dispatch').mockImplementation(async (...args) => {
      dispatchTimes.push({ sessionId: args[0], at: Date.now() });
      return origDispatch(...args);
    });

    const service = new TaskRecoveryService({
      repos,
      runtime,
      nowMs: () => baseMs,
      initialDelayMs: 10,
      staggerUnitMs: 25 // 2s * 25ms = 50ms stagger for fast deterministic test
    });
    cleanupCallbacks.push(() => service.close());

    await service.auditStartupInterruptions();

    // Simulate user sending a brand-new turn to ses_b while ses_b is waiting in stagger delay
    const newerTurnIso = new Date(Math.max(baseMs, Date.now()) + 5_000).toISOString();
    await repos.tasks.save({
      id: 'task_user_new',
      sessionId: 'ses_b',
      prompt: '不用续跑了，改做这件事',
      status: 'completed',
      createdAt: newerTurnIso,
      updatedAt: newerTurnIso
    });

    await vi.waitFor(async () => {
      const recA = await repos.taskRecoveries.getByInterruptedTaskId('task_a');
      const recB = await repos.taskRecoveries.getByInterruptedTaskId('task_b');
      expect(recA?.status).toBe('resumed');
      expect(recB?.status).toBe('skipped');
    });

    expect(await repos.taskRecoveries.getByInterruptedTaskId('task_b')).toMatchObject({
      status: 'skipped',
      skipReason: 'superseded'
    });
    expect(dispatchTimes.map(d => d.sessionId)).toEqual(['ses_a']);
  });

  it('respects mode=off without dispatching or sending confirmation cards', async () => {
    const baseMs = Date.now();
    const { repos, runtime, sentPrompts } = createRuntimeHarness();
    await saveTaskRecoveryConfig(repos, { mode: 'off' });
    await seedSessionWithTask(repos, {
      sessionId: 'ses_off',
      taskId: 'task_off',
      prompt: '关闭模式下不恢复',
      timestamp: new Date(baseMs - 30_000).toISOString()
    });
    await runtime.initialize([mockAgent]);

    const sendConfirmCard = vi.fn();
    const service = new TaskRecoveryService({
      repos,
      runtime,
      nowMs: () => baseMs,
      larkPort: { sendConfirmCard, updateCard: vi.fn() }
    });
    cleanupCallbacks.push(() => service.close());

    const summary = await service.auditStartupInterruptions();
    expect(summary).toMatchObject({ scanned: 1, scheduled: 0, pendingConfirm: 0, skipped: 1 });
    expect(sendConfirmCard).not.toHaveBeenCalled();
    expect(sentPrompts).toHaveLength(0);
    expect(await repos.taskRecoveries.getByInterruptedTaskId('task_off')).toMatchObject({
      mode: 'off',
      status: 'skipped',
      skipReason: 'mode_off'
    });
  });

  it('supports confirm mode with Web + Lark dual-end idempotent locking, in-place Lark card lock, and dismiss flow', async () => {
    const baseMs = Date.now();
    const recentIso = new Date(baseMs - 2 * 60_000).toISOString();
    const { repos, runtime, sentPrompts } = createRuntimeHarness();
    await saveTaskRecoveryConfig(repos, { mode: 'confirm' });

    await seedSessionWithTask(repos, {
      sessionId: 'ses_confirm_resume',
      taskId: 'task_confirm_resume',
      prompt: '部署验收环境并跑 smoke test',
      source: 'lark',
      sourceId: 'cli_bot:oc_chat_1:group',
      timestamp: recentIso
    });
    await seedSessionWithTask(repos, {
      sessionId: 'ses_confirm_dismiss',
      taskId: 'task_confirm_dismiss',
      prompt: '生成临时报表',
      source: 'lark',
      sourceId: 'cli_bot:oc_chat_2:p2p',
      timestamp: recentIso
    });
    await runtime.initialize([mockAgent]);

    const sentCards: TaskRecoveryRecord[] = [];
    const updatedCards: TaskRecoveryRecord[] = [];
    const larkPort: TaskRecoveryLarkPort = {
      sendConfirmCard: async record => {
        sentCards.push(record);
        return {
          appId: 'cli_bot',
          chatId: record.sessionId === 'ses_confirm_resume' ? 'oc_chat_1' : 'oc_chat_2',
          messageId: `om_card_${record.id}`,
          cardId: `recc_${record.id}`
        };
      },
      updateCard: async record => {
        updatedCards.push(record);
      }
    };

    const service = new TaskRecoveryService({
      repos,
      runtime,
      larkPort,
      postCallbackLarkSyncDelayMs: 20,
      nowMs: () => baseMs
    });
    cleanupCallbacks.push(() => service.close());

    const changeEvents: TaskRecoveryRecord[] = [];
    service.onChange(record => changeEvents.push(record));

    const summary = await service.auditStartupInterruptions();
    expect(summary.pendingConfirm).toBe(2);
    expect(sentCards).toHaveLength(2);
    expect(sentPrompts).toHaveLength(0);

    // Re-running audit after restart must NOT duplicate pending_confirm cards
    const summaryAgain = await service.auditStartupInterruptions();
    expect(summaryAgain.pendingConfirm).toBe(0);
    expect(sentCards).toHaveLength(2);

    const recResume = (await repos.taskRecoveries.getByInterruptedTaskId('task_confirm_resume'))!;
    const recDismiss = (await repos.taskRecoveries.getByInterruptedTaskId('task_confirm_dismiss'))!;
    expect(recResume.larkMessageId).toBe(`om_card_${recResume.id}`);

    // 1) Dual-end race: Web & Lark click resume concurrently -> ONLY ONE dispatch wins!
    const [webResult, larkToast] = await Promise.all([
      service.decide({ recoveryId: recResume.id, sessionId: recResume.sessionId, decision: 'resume', source: 'web' }),
      service.handleLarkCardAction({
        value: { action: LARK_TASK_RECOVERY_DECIDE_ACTION, recovery_id: recResume.id, decision: 'resume' },
        operatorOpenId: 'ou_alice',
        operatorName: '暮雪离歌'
      })
    ]);

    const winners = [!webResult.alreadyDecided, larkToast?.type === 'success'].filter(Boolean);
    expect(winners).toHaveLength(1);
    await vi.waitFor(() => expect(sentPrompts).toHaveLength(1));
    expect(sentPrompts[0]?.sessionId).toBe('ses_confirm_resume');
    expect((larkToast?.card as any)?.schema).toBe('2.0');
    expect((larkToast?.card as any)?.config?.update_multi).toBe(true);
    expect((larkToast?.card as any)?.header?.template).toBe('green');
    await vi.waitFor(() => {
      expect(updatedCards.some(card => card.id === recResume.id && card.status === 'resumed')).toBe(true);
    });

    // Duplicate click on Lark returns info toast + locked card without dispatching again
    const dupToast = await service.handleLarkCardAction({
      value: { action: LARK_TASK_RECOVERY_DECIDE_ACTION, recovery_id: recResume.id, decision: 'resume' },
      operatorOpenId: 'ou_bob'
    });
    expect(dupToast).toMatchObject({
      type: 'info',
      content: expect.stringContaining('无需重复操作'),
      card: expect.objectContaining({ schema: '2.0', header: expect.objectContaining({ template: 'green' }) })
    });
    expect(sentPrompts).toHaveLength(1);

    // 2) Dismiss from Lark -> locks record as dismissed, returns sync locked grey card without premature PATCH, then runs deferred PATCH fallback
    const dismissToast = await service.handleLarkCardAction({
      value: { action: LARK_TASK_RECOVERY_DECIDE_ACTION, recovery_id: recDismiss.id, decision: 'dismiss' },
      operatorOpenId: 'ou_alice',
      operatorName: '暮雪离歌'
    });
    expect(dismissToast).toMatchObject({
      type: 'info',
      content: expect.stringContaining('已放弃'),
      card: expect.objectContaining({
        schema: '2.0',
        config: expect.objectContaining({ update_multi: true }),
        header: expect.objectContaining({ template: 'grey' })
      })
    });
    const dismissedRecord = await repos.taskRecoveries.get(recDismiss.id);
    expect(dismissedRecord).toMatchObject({
      status: 'dismissed',
      decidedSource: 'lark',
      decidedBy: '暮雪离歌',
      recoveryTaskId: null
    });
    // 同步回调返回瞬间不抢先 PATCH，随后由延迟兜底更新卡片
    expect(updatedCards.some(card => card.id === recDismiss.id && card.status === 'dismissed')).toBe(false);
    await vi.waitFor(() => {
      expect(updatedCards.some(card => card.id === recDismiss.id && card.status === 'dismissed')).toBe(true);
    });
    expect(changeEvents.some(e => e.id === recDismiss.id && e.status === 'dismissed')).toBe(true);
    expect(sentPrompts).toHaveLength(1);
  });

  it('exposes config, records, and session recovery decision REST endpoints cleanly', async () => {
    const baseMs = Date.now();
    const { repos, runtime } = createRuntimeHarness();
    await runtime.initialize([mockAgent]);

    const service = new TaskRecoveryService({ repos, runtime, nowMs: () => baseMs });
    cleanupCallbacks.push(() => service.close());

    const app = await buildApp(runtime, { taskRecovery: service });
    cleanupCallbacks.push(() => app.close());

    // Default config is auto / 15m / 1 attempt / 3s stagger
    const get1 = await app.inject({ method: 'GET', url: '/api/task-recovery/config' });
    expect(get1.statusCode).toBe(200);
    expect(get1.json().config).toEqual({ mode: 'auto', windowMinutes: 15, maxAutoAttempts: 1, staggerSeconds: 3 });

    // Reject invalid mode
    const bad = await app.inject({ method: 'PUT', url: '/api/task-recovery/config', payload: { mode: 'bogus' } });
    expect(bad.statusCode).toBe(400);

    // Update to confirm / 30m
    const put = await app.inject({
      method: 'PUT',
      url: '/api/task-recovery/config',
      payload: { mode: 'confirm', windowMinutes: 30, maxAutoAttempts: 1, staggerSeconds: 5 }
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().config).toEqual({ mode: 'confirm', windowMinutes: 30, maxAutoAttempts: 1, staggerSeconds: 5 });
    expect(await readTaskRecoveryConfig(repos)).toEqual({ mode: 'confirm', windowMinutes: 30, maxAutoAttempts: 1, staggerSeconds: 5 });

    // Seed an interrupted session and run audit
    await seedSessionWithTask(repos, {
      sessionId: 'ses_api',
      taskId: 'task_api',
      prompt: '检查发布脚本',
      sessionState: 'interrupted',
      interruptIntent: 'daemon_restart',
      taskStatus: 'interrupted',
      timestamp: new Date(baseMs - 60_000).toISOString()
    });
    await service.auditStartupInterruptions();

    const sessionList = await app.inject({ method: 'GET', url: '/api/sessions/ses_api/recoveries' });
    expect(sessionList.statusCode).toBe(200);
    expect(sessionList.json().items).toHaveLength(1);
    const recoveryId = sessionList.json().items[0].id as string;

    // Invalid decision -> 400
    const badDecide = await app.inject({
      method: 'POST',
      url: `/api/sessions/ses_api/recoveries/${recoveryId}/decide`,
      payload: { decision: 'unknown' }
    });
    expect(badDecide.statusCode).toBe(400);

    // Valid web resume -> 200 and dispatches recovery task
    const decideRes = await app.inject({
      method: 'POST',
      url: `/api/sessions/ses_api/recoveries/${recoveryId}/decide`,
      payload: { decision: 'resume' }
    });
    expect(decideRes.statusCode).toBe(200);
    expect(decideRes.json()).toMatchObject({
      alreadyDecided: false,
      record: { id: recoveryId, status: 'resumed', decidedSource: 'web' }
    });
    expect(decideRes.json().dispatchedTaskId).toBeTruthy();

    // Global records list reflects resumed record
    const allRecords = await app.inject({ method: 'GET', url: '/api/task-recovery/records?limit=10' });
    expect(allRecords.statusCode).toBe(200);
    expect(allRecords.json().items[0]).toMatchObject({ id: recoveryId, status: 'resumed' });
  });

  it('renders Feishu Schema 2.0 confirm and resolved cards and parses callback payloads accurately', () => {
    const record: TaskRecoveryRecord = {
      id: 'rec_card_1',
      sessionId: 'ses_1',
      interruptedTaskId: 'task_1',
      rootTaskId: 'task_1',
      originalPrompt: '修复线上鉴权漏洞并验证单测',
      originalOrigin: null,
      interruptReason: 'daemon_restart',
      interruptedAt: '2026-11-28T06:58:00.000Z',
      detectedAt: '2026-11-28T07:00:00.000Z',
      mode: 'confirm',
      status: 'pending_confirm',
      skipReason: null,
      attemptCount: 0,
      recoveryTaskId: null,
      decidedSource: null,
      decidedBy: null,
      decidedAt: null,
      larkAppId: 'cli_bot',
      larkChatId: 'oc_chat',
      larkMessageId: 'om_1',
      larkCardId: 'recc_1',
      createdAt: '2026-11-28T07:00:00.000Z',
      updatedAt: '2026-11-28T07:00:00.000Z'
    };

    const confirmCard = buildTaskRecoveryConfirmCard({ record, cardId: 'recc_1', webBaseUrl: 'https://dock.example.com' });
    expect(confirmCard).toMatchObject({
      schema: '2.0',
      header: { template: 'orange', title: { content: '任务因服务重启中断' } }
    });
    const elements = (confirmCard.body as { elements: Array<Record<string, unknown>> }).elements;
    const buttons = elements.filter(el => el.tag === 'button');
    expect(buttons).toHaveLength(2);
    const resumePayload = ((buttons[0]!.behaviors as Array<{ value: unknown }>)[0]!).value;
    expect(isTaskRecoveryCardAction(resumePayload)).toBe(true);
    expect(parseTaskRecoveryCardAction(resumePayload)).toEqual({
      recoveryId: 'rec_card_1',
      cardId: 'recc_1',
      decision: 'resume'
    });
    expect(isTaskRecoveryCardAction({ action: 'other_action' })).toBe(false);

    const resolvedResumed = buildTaskRecoveryResolvedCard({
      record: { ...record, status: 'resumed', decidedSource: 'lark', decidedBy: '暮雪离歌', decidedAt: '2026-11-28T07:01:00.000Z' }
    });
    expect(resolvedResumed).toMatchObject({
      schema: '2.0',
      header: { template: 'green', title: { content: '已确认继续执行' } }
    });
    const resolvedButtons = ((resolvedResumed.body as { elements: Array<Record<string, unknown>> }).elements).filter(el => el.tag === 'button');
    expect(resolvedButtons).toHaveLength(0);

    const resolvedDismissed = buildTaskRecoveryResolvedCard({
      record: { ...record, status: 'dismissed', decidedSource: 'web', decidedAt: '2026-11-28T07:01:00.000Z' }
    });
    expect(resolvedDismissed).toMatchObject({
      schema: '2.0',
      header: { template: 'grey', title: { content: '已放弃断点续跑' } }
    });
  });

  it('wires registerLarkRoutes session binding lookup to send and lock Feishu Schema 2.0 confirm cards for handover and native Lark sessions', async () => {
    const baseMs = Date.now();
    const recentIso = new Date(baseMs - 60_000).toISOString();
    const { repos, runtime } = createRuntimeHarness();
    await runtime.initialize([mockAgent]);
    await saveTaskRecoveryConfig(repos, { mode: 'confirm' });

    const bot = await saveLarkConfig(repos.config, undefined, {
      appId: 'cli_rec_bot',
      appSecret: 'secret_rec_bot',
      name: '恢复测试机器人',
      webBaseUrl: 'https://dock.example.com',
      listening: false
    });
    const appId = bot[0]!.appId;

    await seedSessionWithTask(repos, {
      sessionId: 'ses_ho_lark',
      taskId: 'task_ho_lark',
      prompt: '更新数据库索引迁移脚本',
      sessionState: 'interrupted',
      interruptIntent: 'daemon_restart',
      taskStatus: 'interrupted',
      timestamp: recentIso
    });
    await repos.channelMappings.save({
      id: `${larkHandoverChannel(appId)}:oc_ho_chat`,
      channel: larkHandoverChannel(appId),
      externalId: 'oc_ho_chat',
      sessionId: 'ses_ho_lark',
      extra: JSON.stringify({ appId, chatId: 'oc_ho_chat', sessionId: 'ses_ho_lark', name: '普通托管群' }),
      createdAt: recentIso
    });

    const sentInteractive: Array<{ chatId?: string; card: Record<string, unknown> }> = [];
    const updatedInteractive: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    const mockFetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't_mock_token', expire: 7200 }), { status: 200 });
      }
      if (url.includes('/im/v1/messages') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}')) as { receive_id?: string; content?: string };
        sentInteractive.push({ chatId: body.receive_id, card: JSON.parse(body.content ?? '{}') as Record<string, unknown> });
        return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_ho_confirm_1', chat_id: body.receive_id } }), { status: 200 });
      }
      if (url.includes('/im/v1/messages/om_ho_confirm_1') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body ?? '{}')) as { content?: string };
        updatedInteractive.push({ messageId: 'om_ho_confirm_1', card: JSON.parse(body.content ?? '{}') as Record<string, unknown> });
        return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_ho_confirm_1' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const service = new TaskRecoveryService({ repos, runtime, nowMs: () => baseMs });
    cleanupCallbacks.push(() => service.close());

    const app = await buildApp(runtime, {
      taskRecovery: service,
      lark: {
        config: repos.config,
        cardMappings: repos.channelMappings,
        runtime,
        fetcher: mockFetcher,
        listeningDisabled: false,
        listener: {
          listening: false,
          activeAppIds: [],
          sync: vi.fn(async () => undefined),
          stop: vi.fn(async () => undefined)
        }
      }
    });
    cleanupCallbacks.push(() => app.close());

    const summary = await service.auditStartupInterruptions();
    expect(summary.pendingConfirm).toBe(1);
    expect(sentInteractive).toHaveLength(1);
    expect(sentInteractive[0]).toMatchObject({
      chatId: 'oc_ho_chat',
      card: { schema: '2.0', header: { template: 'orange', title: { content: '任务因服务重启中断' } } }
    });

    // Clicking confirm from Web locks the Feishu card in-place to green read-only state
    const rec = (await repos.taskRecoveries.getByInterruptedTaskId('task_ho_lark'))!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/ses_ho_lark/recoveries/${rec.id}/decide`,
      payload: { decision: 'resume' }
    });
    expect(res.statusCode).toBe(200);
    expect(updatedInteractive).toHaveLength(1);
    expect(updatedInteractive[0]).toMatchObject({
      messageId: 'om_ho_confirm_1',
      card: { schema: '2.0', header: { template: 'green', title: { content: '已确认继续执行' } } }
    });
  });
});
