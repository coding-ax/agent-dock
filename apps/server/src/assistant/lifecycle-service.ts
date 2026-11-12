import type { AgentDockRuntime } from '@agent-dock/agent-dock-runtime';
import { makeId, now, RuntimeError, type RepositoryBundle, type Session, type TaskRecord } from '@agent-dock/agent-dock-shared';
import type { AssistantStore } from './store.js';
import type { AssistantTask, CompanionProfile } from './types.js';
import {
  acknowledgeAll, advanceAge, applyLifecycleConfigPatch, assertTransition, buildHandoffPackage, buildMaintenancePrompt,
  computeAgeScore, computeLevels, countRounds, decideLifecycleAction, emptyAlertState, extractFileRefs, handoffOutcome,
  handoffVisibleText, isHandoffExecuting, isHandoffOpen, latestContextPercent, lifecycleMetricKeys, maintenanceVisibleText,
  normalizeAlertState, normalizeLifecycleConfig, overallLevel, planTransfers, reasonsFor, recoveryAction, renderHandoffBriefing, serializeLifecycleConfig,
  STAGE_POLICY, stageCatLabel, stageLabel, stageProgress,
  type ArchiveBatch, type ArchiveSource, type CatRecord, type HandoffRecord, type HandoffStep, type HandoffStepRecord,
  type HandoffTrigger, type LifecycleAlertState, type LifecycleConfig, type LifecycleConfigPatch, type LifecycleMetrics,
  type MaintenanceRun, type MetricReason, type TransferRecord
} from './lifecycle.js';

const CONFIG_KEY = 'assistant.lifecycle.config';
const ALERTS_KEY = 'assistant.lifecycle.alerts';
const METRICS_TTL_MS = 60_000;
const DAY_MS = 86_400_000;
const BUSY_STATES = new Set(['starting', 'thinking', 'running_tool', 'waiting_for_permission', 'interrupting']);
const FINISHED_TASK_STATES = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
/** 系统轮次：整理与交接说明。进行中时 Agent 不能派活。 */
const SYSTEM_ORIGINS = new Set(['maintenance', 'handoff']);

export interface LifecycleLogger { info(message: string): void; warn(message: string): void }

/** AssistantService 提供给生命周期的最小接口：主会话指针、小猫档案、会话命名。 */
export interface LifecycleHost {
  mainSessionId(): string | undefined;
  /** 只改主会话指针（含快照重置、提示词刷新），不碰血缘。 */
  switchMainPointer(sessionId: string): Promise<void>;
  companionProfile(): Promise<CompanionProfile | undefined>;
  saveCompanionProfile(profile: CompanionProfile): void;
  nameSession(sessionId: string, title: string): Promise<void>;
  mainSystemPrompt(): string;
  normalizeName(value: unknown): string | undefined;
}

export interface AssistantLifecycleOptions {
  store: AssistantStore;
  runtime: AgentDockRuntime;
  repos: RepositoryBundle;
  log: LifecycleLogger;
  host: LifecycleHost;
}

export interface CollectedMetrics { cat: CatRecord; metrics: LifecycleMetrics; ageScore: number }

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const conflict = (code: string, message: string) => new RuntimeError(code, message, 409);

/**
 * 小猫的一生：指标、整理轮次、交接仪式、归档区。
 * 纯逻辑在 lifecycle.ts；这里负责读库、发系统轮次、改主会话指针，以及失败回滚和重启恢复。
 */
export class AssistantLifecycle {
  private readonly store: AssistantStore;
  private readonly runtime: AgentDockRuntime;
  private readonly repos: RepositoryBundle;
  private readonly log: LifecycleLogger;
  private readonly host: LifecycleHost;
  private metricsCache?: { sessionId: string; at: number; value: CollectedMetrics };
  private execution?: Promise<void>;
  private executingHandoffId?: string;
  private unsubscribe?: () => void;
  private stopped = false;

  constructor(options: AssistantLifecycleOptions) {
    this.store = options.store;
    this.runtime = options.runtime;
    this.repos = options.repos;
    this.log = options.log;
    this.host = options.host;
  }

  /** 启动时收拾上次没收完的摊子：交接提交点之前的回滚，整理轮次标成中断。 */
  async initialize() {
    const open = this.store.openHandoff();
    if (open) {
      const predecessor = open.state === 'retiring' ? await this.repos.sessions.get(open.fromSessionId) : undefined;
      const action = recoveryAction(open.state, { predecessorArchived: Boolean(predecessor?.archivedAt) });
      if (action === 'rollback') await this.rollbackHandoff(open.id, 'daemon 重启时交接还没完成，已自动回滚');
      else if (action === 'mark_partial') this.finishHandoff(open.id, false, `交接说明未确认送达（daemon 重启），可用 agent-dock main handoff resend ${open.id} 重发`);
    }
    const run = this.store.activeMaintenanceRun();
    if (run) await this.checkMaintenanceCompletion(true);
    await this.ensureCat();
  }

  start() {
    if (this.unsubscribe) return;
    this.unsubscribe = this.runtime.onStatus(event => {
      // 主会话一轮结束：轮次、事件、上下文都变了。丢掉缓存，年纪和阈值检测不用等缓存过期。
      if (event.sessionId === this.host.mainSessionId() && !BUSY_STATES.has(event.state)) this.metricsCache = undefined;
      const run = this.store.activeMaintenanceRun();
      if (run && run.sessionId === event.sessionId && !BUSY_STATES.has(event.state)) void this.checkMaintenanceCompletion();
    });
  }

  close() {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** 测试用：等进行中的交接执行完。 */
  async settle() { await this.execution; }

  // ---------------------------------------------------------------- 配置

  getConfig(): LifecycleConfig {
    const raw = this.store.getSetting(CONFIG_KEY);
    try { return normalizeLifecycleConfig(raw ? JSON.parse(raw) : undefined); } catch { return normalizeLifecycleConfig(undefined); }
  }

  updateConfig(patch: LifecycleConfigPatch): LifecycleConfig {
    let next: LifecycleConfig;
    try { next = applyLifecycleConfigPatch(this.getConfig(), patch); }
    catch (error) { throw new RuntimeError('INVALID_LIFECYCLE_CONFIG', errorMessage(error), 400); }
    this.store.setSetting(CONFIG_KEY, serializeLifecycleConfig(next));
    this.metricsCache = undefined;
    return next;
  }

  private readAlerts(): LifecycleAlertState {
    const raw = this.store.getSetting(ALERTS_KEY);
    try { return normalizeAlertState(raw ? JSON.parse(raw) : undefined); } catch { return emptyAlertState(); }
  }

  private writeAlerts(alerts: LifecycleAlertState) { this.store.setSetting(ALERTS_KEY, JSON.stringify(alerts)); }

  // ---------------------------------------------------------------- 血缘

  /**
   * 当前主会话对应的那只猫。老版本升级上来没有血缘记录时懒创建第 1 代；
   * 主会话被 `main set` 换成别的会话时，旧猫标 released（交接进行中除外：那由仪式自己处理）。
   */
  async ensureCat(): Promise<CatRecord | undefined> {
    const mainId = this.host.mainSessionId();
    if (!mainId) return undefined;
    const existing = this.store.findCatBySession(mainId, ['active']);
    if (!this.executingHandoffId) this.releaseOtherCats(mainId, 'replaced');
    if (existing) return existing;
    const session = await this.repos.sessions.get(mainId);
    if (!session) return undefined;
    const profile = await this.host.companionProfile();
    const stamp = now();
    const cat: CatRecord = {
      id: makeId('acat'), familyId: makeId('afam'), generation: 1, sessionId: mainId,
      name: profile?.name ?? session.customTitle ?? '小A同学',
      agentId: session.agentId,
      ...(session.model ? { model: session.model } : {}),
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      cwd: session.cwd,
      state: 'active', lifeStage: 'kitten', peakAgeScore: 0, rounds: 0,
      adoptedAt: profile?.adoptedAt ?? session.createdAt,
      createdAt: stamp, updatedAt: stamp
    };
    this.store.saveCat(cat);
    this.writeAlerts(emptyAlertState(cat.id));
    this.metricsCache = undefined;
    return cat;
  }

  private releaseOtherCats(mainId: string | undefined, reason: string) {
    for (const cat of this.store.listCats()) {
      if (cat.state !== 'active' || cat.sessionId === mainId) continue;
      cat.state = 'released';
      cat.retiredAt = now();
      cat.retiredReason = reason;
      this.store.saveCat(cat);
    }
  }

  /** 交接仪式执行中不允许换主会话、解除主会话：仪式自己会改指针，并发改会互相踩。 */
  assertIdle() {
    if (this.executingHandoffId) throw conflict('HANDOFF_IN_PROGRESS', '交接仪式进行中，等它结束再操作主会话');
  }

  /** 让它休息（解除主会话）：猫的记录留着，标成 released。 */
  releaseActiveCat(reason = 'released') {
    this.assertIdle();
    this.releaseOtherCats(undefined, reason);
    this.metricsCache = undefined;
  }

  renameActiveCat(name: string) {
    const mainId = this.host.mainSessionId();
    const cat = mainId ? this.store.findCatBySession(mainId, ['active']) : undefined;
    if (!cat) return;
    cat.name = name;
    this.store.saveCat(cat);
  }

  /** 当前这只猫所在的血缘，从第 1 代排起；也带上更早认领过、已休息的猫。 */
  lineage(): CatRecord[] {
    return this.store.listCats().sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /** 当前血缘里所有前任的主会话 id：网页据此把旧猫派出的侧边会话也认作便签。 */
  ancestorSessionIds(cat?: CatRecord): string[] {
    if (!cat) return [];
    return this.store.listCats().filter(item => item.familyId === cat.familyId && item.generation < cat.generation).map(item => item.sessionId);
  }

  // ---------------------------------------------------------------- 指标

  async collectMetrics(force = false): Promise<CollectedMetrics | undefined> {
    const mainId = this.host.mainSessionId();
    if (!mainId) return undefined;
    const cached = this.metricsCache;
    if (!force && cached && cached.sessionId === mainId && Date.now() - cached.at < METRICS_TTL_MS) return cached.value;
    const cat = await this.ensureCat();
    if (!cat) return undefined;
    const config = this.getConfig();
    const [tasks, events, recent] = await Promise.all([
      this.runtime.getTasks(mainId),
      this.repos.events.countBySession(mainId),
      this.repos.events.listRecent(mainId, 400)
    ]);
    const notes = this.store.listTasks();
    const metrics: LifecycleMetrics = {
      rounds: countRounds(tasks),
      events,
      ...withContext(latestContextPercent([...recent].sort((left, right) => left.sequence - right.sequence))),
      openNotes: notes.filter(task => task.state !== 'closed').length,
      // 用户亲手取出的便签不算「待整理」：自动折叠不会再收它们，计进来只会让档位永远降不下去。
      closedNotes: notes.filter(task => task.state === 'closed' && !task.archivedAt && !task.restoredAt).length,
      archivedNotes: notes.filter(task => task.archivedAt).length,
      uptimeDays: Math.max(0, (Date.now() - Date.parse(cat.adoptedAt)) / DAY_MS) || 0,
      computedAt: now()
    };
    const ageScore = computeAgeScore(metrics, config);
    const { peak, stage } = advanceAge(cat.peakAgeScore, ageScore);
    if (peak !== cat.peakAgeScore || stage !== cat.lifeStage || metrics.rounds !== cat.rounds) {
      cat.peakAgeScore = peak;
      cat.lifeStage = stage;
      cat.rounds = metrics.rounds;
      this.store.saveCat(cat);
    }
    const value = { cat, metrics, ageScore };
    this.metricsCache = { sessionId: mainId, at: Date.now(), value };
    return value;
  }

  // ---------------------------------------------------------------- 视图

  async overview() {
    const collected = await this.collectMetrics();
    const config = this.getConfig();
    const cat = collected?.cat;
    const levels = collected ? computeLevels(collected.metrics, config) : undefined;
    const open = this.store.openHandoff();
    const predecessor = cat?.predecessorId ? this.store.getCat(cat.predecessorId) : undefined;
    return {
      cat: cat ? { ...cat, stageLabel: stageLabel[cat.lifeStage], ageScore: collected!.ageScore, stageProgress: stageProgress(cat.peakAgeScore) } : null,
      predecessor: predecessor ?? null,
      metrics: collected?.metrics ?? null,
      levels: levels ?? null,
      level: levels ? overallLevel(levels) : 'ok',
      reasons: collected ? reasonsFor(collected.metrics, config, [...lifecycleMetricKeys]) : [],
      config,
      alerts: this.readAlerts(),
      policy: cat ? STAGE_POLICY[cat.lifeStage] : null,
      handoff: open ? this.handoffView(open) : null,
      handoffs: this.store.listHandoffs(10).map(record => this.handoffSummary(record)),
      maintenance: this.runView(this.store.activeMaintenanceRun()),
      maintenanceRuns: this.store.listMaintenanceRuns(10).map(run => this.runView(run)!),
      lineage: this.lineage(),
      ancestorSessionIds: this.ancestorSessionIds(cat)
    };
  }

  /** 整理记录带上它折叠出来的批次（张数、是否已撤销），时间线卡片据此显示「撤销折叠」。 */
  private runView(run: MaintenanceRun | undefined) {
    if (!run) return null;
    const batch = run.archiveBatchId ? this.store.getArchiveBatch(run.archiveBatchId) : undefined;
    return { ...run, batch: batch ? { count: batch.taskIds.length, ...(batch.undoneAt ? { undoneAt: batch.undoneAt } : {}) } : null };
  }

  /** `/api/assistant/state` 里带的轻量版：网页每几秒轮询一次，只用缓存过的指标。 */
  async light() {
    const collected = await this.collectMetrics().catch(() => undefined);
    const cat = collected?.cat;
    const open = this.store.openHandoff();
    const latest = this.store.listHandoffs(1)[0];
    const active = this.store.activeMaintenanceRun();
    const predecessor = cat?.predecessorId ? this.store.getCat(cat.predecessorId) : undefined;
    return {
      cat: cat ? {
        id: cat.id, familyId: cat.familyId, generation: cat.generation, name: cat.name, lifeStage: cat.lifeStage,
        peakAgeScore: cat.peakAgeScore, rounds: cat.rounds, adoptedAt: cat.adoptedAt,
        ...(predecessor ? { predecessor: { name: predecessor.name, generation: predecessor.generation, sessionId: predecessor.sessionId } } : {})
      } : null,
      level: collected ? overallLevel(computeLevels(collected.metrics, this.getConfig())) : 'ok',
      handoff: open ? this.handoffSummary(open) : null,
      lastHandoff: latest && !isHandoffOpen(latest.state) ? this.handoffSummary(latest) : null,
      maintenance: active ? { id: active.id, trigger: active.trigger, createdAt: active.createdAt, reasons: active.reasons } : null,
      ancestorSessionIds: this.ancestorSessionIds(cat)
    };
  }

  /** 进快照：主会话知道自己第几代、几岁、前任是谁。变化很少，基本不占上下文。 */
  async snapshotLine(): Promise<string> {
    const cat = await this.ensureCat();
    if (!cat) return '';
    const predecessor = cat.predecessorId ? this.store.getCat(cat.predecessorId) : undefined;
    const open = this.store.openHandoff();
    return [
      `你的身份：第 ${cat.generation} 代 · ${stageCatLabel[cat.lifeStage]}（${STAGE_POLICY[cat.lifeStage].selfDescription}）`,
      predecessor ? `前任：第 ${predecessor.generation} 代${predecessor.name}（${predecessor.sessionId}，已归档只读）` : '',
      open?.state === 'proposed' ? '用户面前有一张交接提议等确认；确认只能由用户在网页或终端完成' : ''
    ].filter(Boolean).join('；');
  }

  handoffSummary(record: HandoffRecord) {
    return {
      id: record.id, state: record.state, outcome: record.outcome ?? null, trigger: record.trigger, reason: record.reason ?? null,
      reasons: record.reasons, fromSessionId: record.fromSessionId, toSessionId: record.toSessionId ?? null,
      successorName: record.successorName ?? null, error: record.error ?? null,
      createdAt: record.createdAt, confirmedAt: record.confirmedAt ?? null, completedAt: record.completedAt ?? null
    };
  }

  handoffView(record: HandoffRecord) {
    const fromCat = this.store.getCat(record.fromCatId);
    const toCat = record.toCatId ? this.store.getCat(record.toCatId) : undefined;
    return {
      ...this.handoffSummary(record),
      steps: record.steps,
      archiveBatchId: record.archiveBatchId ?? null,
      briefingTaskId: record.briefingTaskId ?? null,
      metrics: record.metrics,
      fromCat: fromCat ?? null,
      toCat: toCat ?? null,
      transfers: this.store.listTransfers(record.id),
      package: record.package ?? null
    };
  }

  // ---------------------------------------------------------------- 自动检测

  /** 30 秒扫描的一部分：先收尾整理轮次，再按档位决定要不要整理或提议交接。 */
  async scan() {
    if (this.stopped) return;
    await this.checkMaintenanceCompletion();
    if (this.executingHandoffId || this.store.openHandoff() && isHandoffExecuting(this.store.openHandoff()!.state)) return;
    const mainId = this.host.mainSessionId();
    if (!mainId) return;
    const collected = await this.collectMetrics();
    if (!collected) return;
    const decision = decideLifecycleAction({
      catId: collected.cat.id,
      stage: collected.cat.lifeStage,
      metrics: collected.metrics,
      config: this.getConfig(),
      alerts: this.readAlerts(),
      now: Date.now(),
      mainBusy: await this.isMainBusy(mainId),
      maintenanceActive: Boolean(this.store.activeMaintenanceRun()),
      handoffOpen: Boolean(this.store.openHandoff())
    });
    this.writeAlerts(decision.alerts);
    if (decision.action === 'maintenance') {
      await this.runMaintenance({ trigger: 'auto', reasons: decision.reasons }).catch(error => this.log.warn(`自动整理没开起来：${errorMessage(error)}`));
    } else if (decision.action === 'propose_handoff') {
      await this.proposeHandoff({ trigger: 'threshold', reasons: decision.reasons, ...(decision.remind ? { reason: '又过了一阵，老猫还是有点累，再问一次要不要交接' } : {}) })
        .catch(error => this.log.warn(`交接提议没生成：${errorMessage(error)}`));
    }
  }

  private async isMainBusy(mainId: string): Promise<boolean> {
    const session = await this.repos.sessions.get(mainId);
    if (!session || BUSY_STATES.has(session.state)) return true;
    const tasks = await this.runtime.getTasks(mainId);
    return tasks.some(task => task.status === 'queued' || task.status === 'running');
  }

  // ---------------------------------------------------------------- 整理轮次

  /**
   * 系统轮次（整理 / 交接说明）进行中时，Agent 发起的派活一律拒绝：
   * 整理轮次只汇总和提建议，绝不能再派出侧边会话，也不能自己再开一轮整理。
   */
  async assertNoSystemRound(from: string | undefined, action: string) {
    const mainId = this.host.mainSessionId();
    if (!from || !mainId || from !== mainId) return;
    const tasks = await this.runtime.getTasks(mainId);
    const running = tasks.find(task => task.status === 'running');
    if (running && SYSTEM_ORIGINS.has(running.origin ?? '')) {
      throw conflict('SYSTEM_ROUND_ACTIVE', `${running.origin === 'maintenance' ? '整理轮次' : '交接说明轮次'}里不能${action}；这一轮只汇总和提建议，派活等用户下一条消息。`);
    }
  }

  async runMaintenance(input: { trigger: 'auto' | 'manual'; reason?: string; reasons?: MetricReason[]; from?: string }): Promise<MaintenanceRun> {
    const mainId = this.host.mainSessionId();
    if (!mainId) throw new RuntimeError('INVALID_ASSISTANT_INPUT', '还没有指定主会话', 400);
    await this.assertNoSystemRound(input.from, '再开一轮整理');
    const active = this.store.activeMaintenanceRun();
    if (active) return active;
    const open = this.store.openHandoff();
    if (open && isHandoffExecuting(open.state)) throw conflict('HANDOFF_IN_PROGRESS', '交接仪式进行中，结束后再整理');
    const collected = await this.collectMetrics(true);
    if (!collected) throw new RuntimeError('INVALID_ASSISTANT_INPUT', '主会话不存在', 400);
    const config = this.getConfig();
    const reasons = input.reasons ?? reasonsFor(collected.metrics, config, [...lifecycleMetricKeys]);
    const closedNotes = this.store.listTasks()
      .filter(task => task.state === 'closed' && !task.archivedAt)
      .map(task => ({ id: task.id, title: task.title, ...(task.closedAt ? { closedAt: task.closedAt } : {}), ...(task.outcome ? { outcome: task.outcome } : {}), ...(task.cwd ? { cwd: task.cwd } : {}) }));
    const fileRefs = extractFileRefs(await this.repos.events.listRecent(mainId, 1_000));
    const stamp = now();
    const run: MaintenanceRun = {
      id: makeId('amaint'), trigger: input.trigger, state: 'running',
      ...(input.reason?.trim() ? { reason: input.reason.trim().slice(0, 300) } : {}),
      reasons, sessionId: mainId, catId: collected.cat.id, createdAt: stamp, updatedAt: stamp
    };
    this.store.saveMaintenanceRun(run);
    // 带 from 的只能是主会话自己（路由已校验）；用户在网页或终端发起时没有 from。
    const requester = input.from ? 'main' : 'user';
    try {
      const task = await this.runtime.dispatch(mainId, maintenanceVisibleText(input.trigger, reasons, requester), 'queue', buildMaintenancePrompt({
        runId: run.id, trigger: input.trigger, requester, ...(run.reason ? { reason: run.reason } : {}), reasons, metrics: collected.metrics,
        catName: collected.cat.name, generation: collected.cat.generation, stage: collected.cat.lifeStage,
        closedNotes, fileRefs, foldClosedAfterHours: config.foldClosedAfterHours
      }), undefined, 'maintenance');
      run.runtimeTaskId = task.id;
      this.store.saveMaintenanceRun(run);
    } catch (error) {
      run.state = 'failed';
      run.error = errorMessage(error);
      run.completedAt = now();
      this.store.saveMaintenanceRun(run);
      throw error;
    }
    if (input.trigger === 'manual') this.writeAlerts(acknowledgeAll(this.readAlerts(), collected.cat.id, collected.metrics, config));
    return run;
  }

  /**
   * 整理轮次结束：取最终回复当摘要，再把关闭够久的便签折叠进归档区（可撤销）。
   * 由主会话的状态事件触发，30 秒扫描兜底；重复调用幂等。
   */
  async checkMaintenanceCompletion(afterRestart = false) {
    const run = this.store.activeMaintenanceRun();
    if (!run) return;
    // 刚落库、dispatch 还没返回任务 id 的那一小段：别把它误判成「没有执行」。
    if (!run.runtimeTaskId && !afterRestart && Date.now() - Date.parse(run.createdAt) < 120_000) return;
    const session = await this.repos.sessions.get(run.sessionId);
    const tasks = await this.runtime.getTasks(run.sessionId);
    const task = run.runtimeTaskId ? tasks.find(item => item.id === run.runtimeTaskId) : undefined;
    if (task && !FINISHED_TASK_STATES.has(task.status) && !(afterRestart && task.status === 'running')) {
      if (session && !session.archivedAt && session.state !== 'stopped' && session.state !== 'failed') return;
    }
    if (task?.status === 'completed') {
      run.state = 'completed';
      run.summary = (task.finalText ?? '').trim().slice(0, 8_000) || undefined;
      const config = this.getConfig();
      const batch = this.archiveNotes({
        closedBeforeHours: config.foldClosedAfterHours, source: 'maintenance', runId: run.id,
        reason: `整理轮次 ${run.id} 自动折叠`
      });
      if (batch) run.archiveBatchId = batch.id;
    } else {
      run.state = task?.status === 'interrupted' || afterRestart ? 'interrupted' : 'failed';
      run.error = task ? `整理轮次${task.status === 'interrupted' ? '被打断' : task.status === 'cancelled' ? '被取消' : '失败'}` : '整理轮次没有执行（主会话已不可用或 daemon 重启）';
    }
    run.completedAt = now();
    this.store.saveMaintenanceRun(run);
    this.metricsCache = undefined;
  }

  latestLetter(catId: string): { runId: string; createdAt: string; summary: string } | undefined {
    const run = this.store.listMaintenanceRuns(50).find(item => item.catId === catId && item.state === 'completed' && item.summary);
    return run ? { runId: run.id, createdAt: run.completedAt ?? run.createdAt, summary: run.summary! } : undefined;
  }

  // ---------------------------------------------------------------- 归档区

  /** 只折叠已关闭的便签；返回本次的批次，没有可折叠的返回 undefined。 */
  archiveNotes(input: { taskIds?: string[]; closedBeforeHours?: number; reason?: string; source: ArchiveSource; runId?: string; handoffId?: string; batchId?: string }): ArchiveBatch | undefined {
    const all = this.store.listTasks();
    if (input.taskIds?.length) {
      const missing = input.taskIds.filter(id => !all.some(task => task.id === id));
      if (missing.length) throw new RuntimeError('TASK_NOT_FOUND', `事项不存在：${missing.join(', ')}`, 404);
      const open = all.filter(task => input.taskIds!.includes(task.id) && task.state !== 'closed');
      if (open.length) throw new RuntimeError('INVALID_ASSISTANT_INPUT', `只能归档已关闭的便签；还没关闭：${open.map(task => task.id).join(', ')}`, 400);
    }
    const cutoff = input.closedBeforeHours === undefined ? undefined : Date.now() - input.closedBeforeHours * 3_600_000;
    // 撤销要算数：用户取出过的便签，整理轮次和交接都不再自动折叠；用户自己 notes archive 时照常折叠。
    const automatic = input.source !== 'manual';
    const candidates = all.filter(task => task.state === 'closed' && !task.archivedAt
      && !(automatic && task.restoredAt)
      && (!input.taskIds?.length || input.taskIds.includes(task.id))
      && (cutoff === undefined || Date.parse(task.closedAt ?? task.updatedAt) <= cutoff));
    if (!candidates.length) return undefined;
    const batch: ArchiveBatch = {
      id: input.batchId ?? makeId('aarch'), source: input.source,
      ...(input.reason?.trim() ? { reason: input.reason.trim().slice(0, 300) } : {}),
      ...(input.handoffId ? { handoffId: input.handoffId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      taskIds: [], createdAt: now()
    };
    this.store.transaction(() => {
      batch.taskIds = this.store.archiveTasks(candidates.map(task => task.id), batch.id, batch.createdAt);
      if (batch.taskIds.length) this.store.saveArchiveBatch(batch);
    });
    this.metricsCache = undefined;
    return batch.taskIds.length ? batch : undefined;
  }

  /**
   * 从归档区取出。by=user（默认）记下 restoredAt：之后的自动折叠不再收这些便签；
   * by=system 是交接回滚把便签放回原处，不代表用户的意思。
   */
  unarchiveNotes(input: { batchId?: string; taskIds?: string[] }, by: 'user' | 'system' = 'user'): { restored: string[]; batch?: ArchiveBatch } {
    const restoredAt = by === 'user' ? now() : undefined;
    if (input.batchId) {
      const batch = this.store.getArchiveBatch(input.batchId);
      if (!batch) throw new RuntimeError('ARCHIVE_BATCH_NOT_FOUND', `归档批次不存在：${input.batchId}`, 404);
      const restored = this.store.transaction(() => {
        const ids = this.store.unarchiveTasks(batch.taskIds, restoredAt);
        batch.undoneAt = batch.undoneAt ?? now();
        this.store.saveArchiveBatch(batch);
        return ids;
      });
      this.metricsCache = undefined;
      return { restored, batch };
    }
    if (!input.taskIds?.length) throw new RuntimeError('INVALID_ASSISTANT_INPUT', 'batchId 或 taskIds 至少给一个', 400);
    const restored = this.store.unarchiveTasks(input.taskIds, restoredAt);
    this.metricsCache = undefined;
    return { restored };
  }

  archiveView() {
    const tasks = this.store.listTasks().filter(task => task.archivedAt);
    return { batches: this.store.listArchiveBatches(), tasks };
  }

  // ---------------------------------------------------------------- 交接仪式

  getHandoff(id: string) {
    const record = this.store.getHandoff(id);
    if (!record) throw new RuntimeError('HANDOFF_NOT_FOUND', `交接不存在：${id}`, 404);
    return this.handoffView(record);
  }

  listHandoffs() { return this.store.listHandoffs(50).map(record => this.handoffSummary(record)); }

  /** 提议交接。同一时刻只有一单：已有未结束的直接返回它（幂等）。 */
  async proposeHandoff(input: { trigger: HandoffTrigger; reason?: string; name?: string; reasons?: MetricReason[] }): Promise<HandoffRecord> {
    const open = this.store.openHandoff();
    if (open) return open;
    const mainId = this.host.mainSessionId();
    if (!mainId) throw new RuntimeError('INVALID_ASSISTANT_INPUT', '还没有指定主会话', 400);
    const collected = await this.collectMetrics(true);
    if (!collected) throw new RuntimeError('INVALID_ASSISTANT_INPUT', '主会话不存在', 400);
    const config = this.getConfig();
    const name = input.name === undefined ? undefined : this.host.normalizeName(input.name);
    const stamp = now();
    const record: HandoffRecord = {
      id: makeId('ahand'), state: 'proposed', trigger: input.trigger,
      ...(input.reason?.trim() ? { reason: input.reason.trim().slice(0, 300) } : {}),
      fromCatId: collected.cat.id, fromSessionId: mainId,
      successorName: name ?? collected.cat.name,
      metrics: collected.metrics,
      reasons: input.reasons ?? reasonsFor(collected.metrics, config, [...lifecycleMetricKeys]).filter(reason => reason.level === 'handoff'),
      steps: [], createdAt: stamp, updatedAt: stamp
    };
    this.store.saveHandoff(record);
    if (input.trigger === 'threshold') this.writeAlerts({ ...this.readAlerts(), lastProposalAt: stamp });
    return record;
  }

  /** 婉拒提议（「再陪我一阵」）。资深/老年猫过一阵会再问一次。 */
  cancelHandoff(id: string) {
    const record = this.store.getHandoff(id);
    if (!record) throw new RuntimeError('HANDOFF_NOT_FOUND', `交接不存在：${id}`, 404);
    if (record.state === 'cancelled') return this.handoffView(record);
    if (record.state !== 'proposed') throw conflict('HANDOFF_NOT_CANCELLABLE', record.state === 'done' ? '交接已经完成，不能取消' : '交接已经开始执行，不能取消；失败会自动回滚');
    if (!this.store.compareAndSetHandoffState(id, 'proposed', 'cancelled')) return this.getHandoff(id);
    const fresh = this.store.getHandoff(id)!;
    fresh.completedAt = now();
    this.store.saveHandoff(fresh);
    this.writeAlerts({ ...this.readAlerts(), lastDismissedAt: now() });
    return this.handoffView(fresh);
  }

  /**
   * 用户确认后开始执行。仪式在后台跑（新建会话可能要十几秒），立即返回当前进度；
   * 网页和 CLI 轮询 `GET /handoff/:id` 看步骤。重复确认只返回进度，不会执行两次。
   */
  async confirmHandoff(id: string, input: { name?: string } = {}) {
    const record = this.store.getHandoff(id);
    if (!record) throw new RuntimeError('HANDOFF_NOT_FOUND', `交接不存在：${id}`, 404);
    if (record.state !== 'proposed') {
      if (record.state === 'cancelled') throw conflict('HANDOFF_CANCELLED', '这张交接提议已经取消了，重新发起一次吧');
      return this.handoffView(record);
    }
    const mainId = this.host.mainSessionId();
    if (mainId !== record.fromSessionId) {
      if (this.store.compareAndSetHandoffState(id, 'proposed', 'cancelled')) this.appendStep(id, { step: 'recovery', at: now(), ok: false, detail: '主会话已经换了，这张提议作废' });
      throw conflict('HANDOFF_STALE', '主会话已经换了，这张交接提议作废了');
    }
    if (await this.isMainBusy(mainId)) throw conflict('MAIN_BUSY', '主会话正在忙（这一轮还没结束或有排队消息），等它停下来再交接');
    const name = input.name === undefined ? undefined : this.host.normalizeName(input.name);
    if (!this.store.compareAndSetHandoffState(id, 'proposed', 'confirmed')) return this.getHandoff(id);
    const confirmed = this.store.getHandoff(id)!;
    confirmed.confirmedAt = now();
    if (name) confirmed.successorName = name;
    this.store.saveHandoff(confirmed);
    this.executingHandoffId = id;
    this.execution = this.executeHandoff(id)
      .catch(error => this.log.warn(`交接执行异常：${errorMessage(error)}`))
      .finally(() => { this.executingHandoffId = undefined; this.metricsCache = undefined; });
    return this.getHandoff(id);
  }

  private appendStep(id: string, step: HandoffStepRecord) {
    const record = this.store.getHandoff(id);
    if (!record) return;
    record.steps = [...record.steps, step];
    this.store.saveHandoff(record);
  }

  private advance(id: string, step: HandoffStep, mutate?: (record: HandoffRecord) => void) {
    const record = this.store.getHandoff(id)!;
    assertTransition(record.state, step);
    record.state = step;
    mutate?.(record);
    this.store.saveHandoff(record);
    return record;
  }

  private markStep(id: string, step: HandoffStep, detail?: string) {
    this.appendStep(id, { step, at: now(), ok: true, ...(detail ? { detail } : {}) });
  }

  private async executeHandoff(id: string) {
    let current: HandoffStep = 'packing';
    let committed = false;
    try {
      // ---- packing：交接包是纯数据，先落库，后面每一步都按它走
      const record = this.advance(id, 'packing');
      const fromCat = this.store.getCat(record.fromCatId);
      const fromSession = await this.repos.sessions.get(record.fromSessionId);
      if (!fromCat || !fromSession) throw new Error('旧主会话或它的血缘记录不存在');
      if (fromSession.archivedAt) throw new Error('旧主会话已经归档了');
      const collected = await this.collectMetrics(true);
      const metrics = collected?.metrics ?? record.metrics as LifecycleMetrics;
      const notes = this.store.listTasks();
      const closedCount = notes.filter(task => task.state === 'closed' && !task.archivedAt).length;
      const batchId = makeId('aarch');
      const runtimeTasks = await this.runtime.getTasks(fromSession.id);
      const fileRefs = extractFileRefs(await this.repos.events.listRecent(fromSession.id, 1_000));
      const successorName = record.successorName ?? fromCat.name;
      const ancestors = this.store.listCats()
        .filter(cat => cat.familyId === fromCat.familyId && cat.generation < fromCat.generation)
        .sort((left, right) => left.generation - right.generation)
        .map(cat => ({ generation: cat.generation, name: cat.name, sessionId: cat.sessionId }));
      const letter = this.latestLetter(fromCat.id);
      const pkg = buildHandoffPackage({
        handoffId: id, createdAt: now(), trigger: record.trigger, ...(record.reason ? { reason: record.reason } : {}),
        predecessor: {
          catId: fromCat.id, familyId: fromCat.familyId, generation: fromCat.generation, sessionId: fromSession.id, name: fromCat.name,
          adoptedAt: fromCat.adoptedAt, lifeStage: collected?.cat.lifeStage ?? fromCat.lifeStage, agentId: fromSession.agentId,
          ...(fromSession.model ? { model: fromSession.model } : {}),
          ...(fromSession.reasoningEffort ? { reasoningEffort: fromSession.reasoningEffort } : {}),
          cwd: fromSession.cwd
        },
        successorName, metrics, ...(letter ? { letter } : {}),
        tasks: runtimeTasks, openTasks: notes, watches: this.store.listWatches(), drafts: this.store.listDrafts(), fileRefs,
        closedNotes: { archived: closedCount, ...(closedCount ? { batchId } : {}) }, ancestors
      });
      this.store.saveHandoff({ ...this.store.getHandoff(id)!, package: pkg, metrics });
      this.markStep(id, 'packing', `交接包：${pkg.openTasks.length} 件事项、${pkg.watches.length} 个 watch、${pkg.pendingDrafts.length} 份草稿`);

      // ---- spawning：继承 Agent / 模型 / 思考深度 / 目录 / 名字
      current = 'spawning';
      this.advance(id, 'spawning');
      const session = await this.runtime.start({
        agentId: fromSession.agentId, cwd: fromSession.cwd,
        ...(fromSession.model ? { model: fromSession.model } : {}),
        ...(fromSession.reasoningEffort ? { reasoningEffort: fromSession.reasoningEffort } : {}),
        source: 'assistant-main', systemPrompt: this.host.mainSystemPrompt()
      });
      this.store.saveHandoff({ ...this.store.getHandoff(id)!, toSessionId: session.id });
      await this.host.nameSession(session.id, successorName);
      this.markStep(id, 'spawning', `新主会话 ${session.id}`);

      // ---- transferring：便签交接，每条单独记账；已关闭的折叠进归档区
      current = 'transferring';
      this.advance(id, 'transferring');
      await this.transferItems(id, session.id);
      const batch = closedCount ? this.archiveNotes({ source: 'handoff', handoffId: id, batchId, reason: `交接 ${id}：已完成便签折叠进归档区` }) : undefined;
      if (batch) this.store.saveHandoff({ ...this.store.getHandoff(id)!, archiveBatchId: batch.id });
      const transfers = this.store.listTransfers(id);
      this.markStep(id, 'transferring', `转交 ${transfers.length} 条，归档 ${batch?.taskIds.length ?? 0} 张已完成便签`);

      // ---- switching：主会话指针换成新猫，新猫从幼猫开始
      current = 'switching';
      this.advance(id, 'switching');
      const stamp = now();
      const newCat: CatRecord = {
        id: makeId('acat'), familyId: fromCat.familyId, generation: fromCat.generation + 1, sessionId: session.id, name: successorName,
        agentId: session.agentId, ...(session.model ? { model: session.model } : {}),
        ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}), cwd: session.cwd,
        state: 'active', lifeStage: 'kitten', peakAgeScore: 0, rounds: 0, adoptedAt: stamp,
        predecessorId: fromCat.id, handoffId: id, createdAt: stamp, updatedAt: stamp
      };
      this.store.saveCat(newCat);
      this.store.saveHandoff({ ...this.store.getHandoff(id)!, toCatId: newCat.id });
      await this.host.switchMainPointer(session.id);
      this.host.saveCompanionProfile({ name: successorName, adoptedAt: stamp });
      this.writeAlerts(emptyAlertState(newCat.id));
      this.metricsCache = undefined;
      this.markStep(id, 'switching', `第 ${newCat.generation} 代${successorName}接班`);

      // ---- retiring（提交点）：先把旧猫的记录写好，最后一个动作才是归档旧会话
      current = 'retiring';
      this.advance(id, 'retiring');
      const retired = this.store.getCat(fromCat.id)!;
      retired.state = 'retired';
      retired.retiredAt = now();
      retired.retiredReason = record.reason ?? (record.trigger === 'threshold' ? '指标到了交接档' : '用户发起交接');
      retired.successorId = newCat.id;
      retired.handoffId = id;
      retired.rounds = metrics.rounds;
      if (collected) { retired.lifeStage = collected.cat.lifeStage; retired.peakAgeScore = collected.cat.peakAgeScore; }
      this.store.saveCat(retired);
      await this.runtime.archive(fromSession.id);
      committed = true;
      this.markStep(id, 'retiring', `旧主会话 ${fromSession.id} 已归档（只读，记录全部保留）`);
    } catch (error) {
      try { this.appendStep(id, { step: current, at: now(), ok: false, detail: errorMessage(error) }); } catch { /* 记账失败不影响回滚 */ }
      // 旧会话已经归档就过了提交点：不能再把指针改回一个只读会话，继续发交接说明。
      if (!committed) { await this.rollbackHandoff(id, `${current} 失败：${errorMessage(error)}`); return; }
    }
    await this.deliverBriefing(id);
  }

  private async transferItems(id: string, toSessionId: string) {
    const watches = this.store.listWatches();
    const sessions = new Map<string, { archivedAt?: string; state: string } | undefined>();
    const tasks = this.store.listTasks();
    for (const task of tasks) {
      if (!task.sessionId || task.state === 'closed' || sessions.has(task.sessionId)) continue;
      const session = await this.repos.sessions.get(task.sessionId);
      sessions.set(task.sessionId, session ? { ...(session.archivedAt ? { archivedAt: session.archivedAt } : {}), state: session.state } : undefined);
    }
    const plan = planTransfers({ tasks, watches, drafts: this.store.listDrafts(), sessions });
    for (const item of plan) {
      const existing = this.store.getTransfer(id, item.kind, item.itemId);
      if (existing && existing.status !== 'failed' && existing.status !== 'reverted') continue;
      const stamp = now();
      const record: TransferRecord = {
        id: existing?.id ?? makeId('atransfer'), handoffId: id, kind: item.kind, itemId: item.itemId, title: item.title,
        status: item.status, detail: item.detail, createdAt: existing?.createdAt ?? stamp, updatedAt: stamp
      };
      try {
        if (item.kind === 'watch') {
          const watch = this.store.getWatch(item.itemId);
          if (!watch) throw new Error('watch 已被删除');
          record.previous = { ownerSessionId: existing?.previous?.ownerSessionId ?? watch.ownerSessionId };
          if (!this.store.setWatchOwner(watch.id, toSessionId)) throw new Error('watch 已被删除');
        }
      } catch (error) {
        record.status = 'failed';
        record.detail = `转交失败：${errorMessage(error)}`;
      }
      this.store.saveTransfer(record);
    }
  }

  /** 交接说明轮次：`origin=handoff`，不是用户消息，也不会触发派活。 */
  private async deliverBriefing(id: string) {
    const record = this.store.getHandoff(id);
    if (!record?.toSessionId || !record.package) { this.finishHandoff(id, false, '没有交接包或新主会话，交接说明没发出去'); return; }
    try {
      this.advance(id, 'briefing');
      const task = await this.runtime.dispatch(record.toSessionId, handoffVisibleText(record.package), 'queue', renderHandoffBriefing(record.package), undefined, 'handoff');
      this.store.saveHandoff({ ...this.store.getHandoff(id)!, briefingTaskId: task.id });
      this.markStep(id, 'briefing', `交接说明已送达新主会话（${task.id}）`);
      this.finishHandoff(id, true);
    } catch (error) {
      this.appendStep(id, { step: 'briefing', at: now(), ok: false, detail: errorMessage(error) });
      this.finishHandoff(id, false, `交接说明没送达：${errorMessage(error)}。可用 agent-dock main handoff resend ${id} 重发`);
    }
  }

  private finishHandoff(id: string, briefingDelivered: boolean, error?: string) {
    const record = this.store.getHandoff(id);
    if (!record) return;
    if (record.state !== 'briefing' && record.state !== 'retiring' && record.state !== 'done') return;
    record.state = 'done';
    record.outcome = handoffOutcome(this.store.listTransfers(id), briefingDelivered);
    record.completedAt = record.completedAt ?? now();
    if (error) record.error = error;
    else delete record.error;
    this.store.saveHandoff(record);
  }

  /** 交接已完成但交接说明没送达时重发；已送达的不会重复发。 */
  async resendBriefing(id: string) {
    const record = this.store.getHandoff(id);
    if (!record) throw new RuntimeError('HANDOFF_NOT_FOUND', `交接不存在：${id}`, 404);
    if (record.state !== 'done' || !record.toSessionId || !record.package) throw conflict('HANDOFF_NOT_RESENDABLE', '只有已完成的交接可以重发交接说明');
    if (record.briefingTaskId) return this.handoffView(record);
    const task = await this.runtime.dispatch(record.toSessionId, handoffVisibleText(record.package), 'queue', renderHandoffBriefing(record.package), undefined, 'handoff');
    const fresh = this.store.getHandoff(id)!;
    fresh.briefingTaskId = task.id;
    fresh.steps = [...fresh.steps, { step: 'briefing', at: now(), ok: true, detail: `重发交接说明（${task.id}）` }];
    fresh.outcome = handoffOutcome(this.store.listTransfers(id), true);
    delete fresh.error;
    this.store.saveHandoff(fresh);
    return this.handoffView(fresh);
  }

  /**
   * 回滚：旧主会话在提交点之前从不归档，所以只需要把指针改回、transfer 复原、
   * 归档批次撤销、新会话归档留档。每一步单独兜底，任何一步失败都不影响其余步骤。
   */
  private async rollbackHandoff(id: string, reason: string) {
    const record = this.store.getHandoff(id);
    if (!record || record.state === 'rolled_back') return;
    if (record.state !== 'rolling_back') {
      record.state = 'rolling_back';
      record.error = reason;
      this.store.saveHandoff(record);
    }
    const problems: string[] = [];
    const attempt = async (label: string, work: () => unknown) => {
      try { await work(); } catch (error) { problems.push(`${label}：${errorMessage(error)}`); }
    };
    const fromCat = this.store.getCat(record.fromCatId);
    await attempt('主会话指针', async () => {
      if (this.host.mainSessionId() !== record.fromSessionId) await this.host.switchMainPointer(record.fromSessionId);
      if (fromCat) this.host.saveCompanionProfile({ name: fromCat.name, adoptedAt: fromCat.adoptedAt });
    });
    await attempt('血缘', () => {
      if (record.toCatId) {
        const cat = this.store.getCat(record.toCatId);
        if (cat && cat.state === 'active') { cat.state = 'aborted'; cat.retiredAt = now(); cat.retiredReason = '交接回滚'; this.store.saveCat(cat); }
      }
      if (fromCat && fromCat.state !== 'active') {
        fromCat.state = 'active';
        delete fromCat.retiredAt; delete fromCat.retiredReason; delete fromCat.successorId; delete fromCat.handoffId;
        this.store.saveCat(fromCat);
      }
      // 档位记录在换指针时已经切给新猫了：切回旧猫，并按交接时的指标记账，
      // 免得回滚完立刻又冒出一张一模一样的提议。
      if (fromCat && this.readAlerts().catId !== fromCat.id) {
        this.writeAlerts(acknowledgeAll(emptyAlertState(fromCat.id), fromCat.id, record.metrics as LifecycleMetrics, this.getConfig()));
      }
    });
    await attempt('便签交接', () => {
      for (const transfer of this.store.listTransfers(id)) {
        if (transfer.status === 'reverted') continue;
        if (transfer.kind === 'watch' && typeof transfer.previous?.ownerSessionId === 'string') {
          this.store.setWatchOwner(transfer.itemId, transfer.previous.ownerSessionId);
        }
        transfer.status = 'reverted';
        transfer.detail = `已回滚${transfer.detail ? `（原：${transfer.detail}）` : ''}`;
        this.store.saveTransfer(transfer);
      }
    });
    await attempt('归档区', () => {
      if (record.archiveBatchId) this.unarchiveNotes({ batchId: record.archiveBatchId }, 'system');
    });
    await attempt('新主会话', async () => {
      if (!record.toSessionId) return;
      await this.host.nameSession(record.toSessionId, `交接失败 · ${record.successorName ?? '新猫'}`);
      await this.runtime.archive(record.toSessionId);
    });
    await attempt('旧主会话', async () => {
      // 正常情况下旧会话没被动过；万一归档的 stop 已经执行而写库失败，重新拉起它。
      const session = await this.repos.sessions.get(record.fromSessionId);
      if (session && !session.archivedAt && session.state === 'stopped') await this.runtime.restart(record.fromSessionId);
      if (session?.archivedAt) problems.push('旧主会话已经被归档（只读保留），需要手动处理');
    });
    const fresh = this.store.getHandoff(id)!;
    fresh.state = 'rolled_back';
    fresh.completedAt = now();
    fresh.error = problems.length ? `${reason}；回滚时有问题：${problems.join('；')}` : `${reason}；已回滚，旧主会话完好`;
    fresh.steps = [...fresh.steps, { step: 'rollback', at: now(), ok: !problems.length, detail: problems.join('；') || '已回滚' }];
    this.store.saveHandoff(fresh);
    this.metricsCache = undefined;
  }
}

function withContext(percent: number | undefined): { contextPercent?: number } {
  return percent === undefined ? {} : { contextPercent: percent };
}

export type LifecycleOverview = Awaited<ReturnType<AssistantLifecycle['overview']>>;
export type LifecycleLight = Awaited<ReturnType<AssistantLifecycle['light']>>;
export type { AssistantTask, Session, TaskRecord };
