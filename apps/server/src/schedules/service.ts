import { makeId, RuntimeError, type ScheduleDelivery, type ScheduleRecord, type ScheduleRepository, type ScheduleRunRecord, type ScheduleSessionTemplate, type Session, type SessionRepository, type StartSessionInput, type TaskRecord } from '@agent-dock/agent-dock-shared';
import { assertValidTimezone, busySessionStates, followingRun, initialNextRun, isRecurring, localTimezone, schedulePrompt, unfinishedTaskStatuses } from './rules.js';

/** 调度器用到的 runtime 能力；单测里可以直接给假实现。 */
export interface ScheduleRuntime {
  getSession(id: string): Promise<Session | undefined>;
  getTasks(sessionId: string): Promise<TaskRecord[]>;
  start(input: StartSessionInput): Promise<Session>;
  dispatch(id: string, prompt: string, mode?: 'queue' | 'interrupt'): Promise<{ id: string; status: string }>;
  archive(id: string): Promise<unknown>;
}

export interface ScheduleLog { info(message: string): void; warn(message: string): void }

/**
 * 两种创建方式：
 * - 给 sessionId：Agent 在会话里注册、或会话标题栏入口。new_session 从该会话拷贝模板并挂在它下面；
 * - 给 template：Web 全局入口直接选 Agent / 目录 / 模型，只用于 new_session，生出的是独立会话。
 * append 只能给 sessionId。
 */
export interface CreateScheduleInput {
  name?: string;
  sessionId?: string;
  template?: ScheduleSessionTemplate;
  delivery?: ScheduleDelivery;
  cron?: string;
  runAt?: string;
  intervalMinutes?: number;
  timezone?: string;
  prompt: string;
  createdBySessionId?: string;
}

export interface ScheduleServiceOptions {
  /** 扫描间隔；分钟级 cron 的触发误差不超过这个值。 */
  intervalMs?: number;
  /** new_session 模式每个任务保留的未归档会话数，更早的自动归档。 */
  keepSessions?: number;
  clock?: () => Date;
  log?: ScheduleLog;
}

export const scheduleSessionSource = 'side-chat';

/** 定时任务新建的会话：告诉 Agent 它从哪里来、结果怎么回传。走会话级 systemPrompt，不进时间线。 */
export function buildScheduleSessionSeed(schedule: Pick<ScheduleRecord, 'id' | 'name' | 'sessionId'>): string {
  const parent = schedule.sessionId;
  return [
    `你是定时任务 ${schedule.id}（${schedule.name}）本次触发新建的会话${parent ? `，挂在来源会话 ${parent} 下` : ''}。历史不共享，每次触发都是全新的会话。`,
    '接下来的消息由定时器自动发送，用户未必在线：直接把活做完，不要等待确认。',
    ...(parent ? [
      `- 需要来源会话的上下文：\`agent-dock session show ${parent}\``,
      `- 结果需要告诉来源会话时：\`agent-dock session send ${parent} "消息"\``
    ] : []),
    '- 不要在这个会话里再注册新的定时任务，除非定时任务内容明确要求。'
  ].join('\n');
}

const scheduleId = () => makeId('sch');

/**
 * 定时任务的应用服务：注册/管理 + 后台扫描投递。
 *
 * 并发安全靠存储层，不靠进程内状态：
 * - `claim` 是对 nextRunAt 的条件更新，同一个触发点只有一方能抢到；
 * - `addRun` 对 (scheduleId, fireAt) 唯一，即使抢占后进程崩溃重来，也不会把同一次触发投递两遍。
 * 抢占先于投递：崩在两者之间只会丢一次触发，不会重复执行。对「定时发 prompt」来说丢一次比发两次好。
 */
export class ScheduleService {
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;
  private readonly clock: () => Date;

  constructor(
    private readonly schedules: ScheduleRepository,
    private readonly sessions: SessionRepository,
    private readonly runtime: ScheduleRuntime,
    private readonly options: ScheduleServiceOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs ?? 15_000);
    this.timer.unref?.();
    void this.tick();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking;
  }

  list() { return this.schedules.list(); }

  async get(id: string) {
    const schedule = await this.schedules.get(id);
    if (!schedule) throw new RuntimeError('SCHEDULE_NOT_FOUND', `定时任务不存在：${id}`, 404);
    return schedule;
  }

  async runs(id: string, limit?: number) { await this.get(id); return this.schedules.listRuns(id, limit); }

  /** 最近执行（跨任务）；给 sessionId 时只看绑在这个会话上的任务。 */
  async recentRuns(limit = 50, sessionId?: string) {
    if (!sessionId) return this.schedules.listRecentRuns(limit);
    const ids = (await this.schedules.list()).filter(item => item.sessionId === sessionId).map(item => item.id);
    return this.schedules.listRecentRuns(limit, ids);
  }

  async create(input: CreateScheduleInput): Promise<ScheduleRecord> {
    const prompt = input.prompt?.trim();
    if (!prompt) throw new RuntimeError('INVALID_SCHEDULE', '定时任务内容不能为空', 400);
    const delivery = input.delivery ?? 'new_session';
    if (delivery !== 'append' && delivery !== 'new_session') throw new RuntimeError('INVALID_SCHEDULE', `未知的投递方式：${String(delivery)}`, 400);
    const sessionId = input.sessionId?.trim();
    if (!sessionId && delivery === 'append') throw new RuntimeError('INVALID_SCHEDULE', '追加到会话必须指定会话', 400);
    const session = sessionId ? await this.sessions.get(sessionId) : undefined;
    if (sessionId && !session) throw new RuntimeError('SESSION_NOT_FOUND', `会话不存在：${sessionId}`, 404);
    if (session?.archivedAt) throw new RuntimeError('SESSION_ARCHIVED', `会话已归档：${sessionId}`, 409);
    // 模板在注册时定下：之后改了来源会话的模型或目录，定时任务仍按注册时的配置跑。显式传入的优先。
    const template = delivery === 'new_session' ? normalizeTemplate(input.template) ?? (session ? templateFrom(session) : undefined) : undefined;
    if (delivery === 'new_session' && !template) throw new RuntimeError('INVALID_SCHEDULE', '每次新开会话需要指定 Agent 和工作目录，或绑定一个会话', 400);
    const timezone = input.timezone?.trim() || localTimezone();
    assertValidTimezone(timezone);
    const cron = input.cron?.trim() || null;
    const runAt = input.runAt?.trim() || null;
    const intervalMinutes = input.intervalMinutes ?? null;
    const at = this.clock();
    const nextRunAt = initialNextRun({ cron, runAt, intervalMinutes, timezone }, at);
    const stamp = at.toISOString();
    const schedule: ScheduleRecord = {
      id: scheduleId(),
      name: input.name?.trim() || prompt.replace(/\s+/g, ' ').slice(0, 40),
      sessionId: session?.id ?? null,
      delivery,
      sessionTemplate: template ? JSON.stringify(template) : null,
      cron, runAt, intervalMinutes, timezone, prompt,
      enabled: true,
      nextRunAt, lastRunAt: null, lastStatus: null, runCount: 0,
      createdBySessionId: input.createdBySessionId ?? null,
      extra: null,
      createdAt: stamp, updatedAt: stamp
    };
    await this.schedules.save(schedule);
    return schedule;
  }

  async pause(id: string) {
    const schedule = await this.get(id);
    if (!schedule.enabled) return schedule;
    const paused = { ...schedule, enabled: false, nextRunAt: null, updatedAt: this.clock().toISOString() };
    await this.schedules.save(paused);
    return paused;
  }

  async resume(id: string) {
    const schedule = await this.get(id);
    if (schedule.enabled) return schedule;
    if (!isRecurring(schedule) && schedule.lastRunAt) throw new RuntimeError('INVALID_SCHEDULE', '单次任务已经执行过，不能恢复；请重新注册。', 409);
    const at = this.clock();
    const resumed = { ...schedule, enabled: true, nextRunAt: initialNextRun(schedule, at), updatedAt: at.toISOString() };
    await this.schedules.save(resumed);
    return resumed;
  }

  async remove(id: string) { await this.get(id); await this.schedules.delete(id); return { deleted: true, id }; }

  /** 手动触发一次：不动 nextRunAt，用当前时刻当 fireAt 记一条执行记录。 */
  async runNow(id: string) {
    const schedule = await this.get(id);
    return this.deliver(schedule, this.clock(), true);
  }

  /** 扫描一次到期任务。重入保护：上一轮没扫完时跳过，避免同一进程内自己和自己抢。 */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.scanDue().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }

  private async scanDue() {
    const at = this.clock();
    let due: ScheduleRecord[];
    try { due = await this.schedules.listDue(at.toISOString()); }
    catch (error) { this.options.log?.warn(`定时任务扫描失败：${error instanceof Error ? error.message : String(error)}`); return; }
    for (const schedule of due) {
      try { await this.fire(schedule, at); }
      catch (error) { this.options.log?.warn(`定时任务 ${schedule.id} 触发异常：${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  private async fire(schedule: ScheduleRecord, at: Date) {
    const expected = schedule.nextRunAt!;
    const fireAt = new Date(expected);
    let next: string | null;
    try { next = followingRun(schedule, fireAt, at); }
    catch (error) {
      // cron 在注册后变得不可解析（依赖升级等）：停用并记录，而不是每 15 秒报一次错。
      if (!(await this.schedules.claim(schedule.id, expected, null, at.toISOString()))) return;
      const reason = error instanceof Error ? error.message : String(error);
      await this.schedules.addRun({ id: makeId('schrun'), scheduleId: schedule.id, fireAt: fireAt.toISOString(), status: 'failed', reason, sessionId: null, taskId: null, createdAt: at.toISOString() });
      await this.disable(schedule.id, reason);
      return;
    }
    if (!(await this.schedules.claim(schedule.id, expected, next, at.toISOString()))) return;
    await this.deliver({ ...schedule, nextRunAt: next }, fireAt, false);
  }

  private async deliver(schedule: ScheduleRecord, fireAt: Date, manual: boolean): Promise<ScheduleRunRecord> {
    const run: ScheduleRunRecord = { id: makeId('schrun'), scheduleId: schedule.id, fireAt: fireAt.toISOString(), status: 'skipped', reason: null, sessionId: null, taskId: null, createdAt: this.clock().toISOString() };
    if (!(await this.schedules.addRun(run))) return run;
    let outcome: Pick<ScheduleRunRecord, 'status' | 'reason' | 'sessionId' | 'taskId'>;
    try { outcome = await this.attempt(schedule); }
    catch (error) { outcome = { status: 'failed', reason: error instanceof Error ? error.message : String(error), sessionId: null, taskId: null }; }
    const finished = { ...run, ...outcome };
    await this.schedules.updateRun(finished);
    await this.finish(schedule, fireAt, outcome, manual);
    // 本次记录写入后再清理：刚建的会话要计入保留名额。
    if (schedule.delivery === 'new_session' && finished.status === 'delivered') await this.pruneSessions(schedule);
    this.options.log?.info(`定时任务 ${schedule.id} ${finished.status}${finished.reason ? `：${finished.reason}` : ''}`);
    return finished;
  }

  private async attempt(schedule: ScheduleRecord): Promise<Pick<ScheduleRunRecord, 'status' | 'reason' | 'sessionId' | 'taskId'>> {
    // 没绑定会话的 new_session 任务不依赖任何已有会话；绑定了的，来源会话没了就停用。
    const source = schedule.sessionId ? await this.runtime.getSession(schedule.sessionId) : undefined;
    if (schedule.sessionId && (!source || source.archivedAt)) {
      await this.disable(schedule.id, '来源会话不存在或已归档');
      return { status: 'failed', reason: '来源会话不存在或已归档，定时任务已停用', sessionId: schedule.sessionId, taskId: null };
    }
    const previous = await this.unfinishedPrevious(schedule);
    if (previous) return { status: 'skipped', reason: `上一次触发的任务还未结束（${previous}）`, sessionId: null, taskId: null };
    const prompt = schedulePrompt(schedule, schedule.runCount + 1);
    if (schedule.delivery === 'append') {
      if (!source) return { status: 'failed', reason: '追加模式没有绑定会话', sessionId: null, taskId: null };
      if (busySessionStates.has(source.state)) return { status: 'skipped', reason: `目标会话正忙（${source.state}）`, sessionId: source.id, taskId: null };
      const task = await this.runtime.dispatch(source.id, prompt);
      return { status: 'delivered', reason: null, sessionId: source.id, taskId: task.id };
    }
    const template = parseTemplate(schedule);
    const created = await this.runtime.start({
      agentId: template.agentId, cwd: template.cwd,
      ...(template.model ? { model: template.model } : {}),
      ...(template.reasoningEffort ? { reasoningEffort: template.reasoningEffort } : {}),
      systemPrompt: buildScheduleSessionSeed(schedule),
      ...(schedule.sessionId ? { source: scheduleSessionSource, sourceId: schedule.sessionId } : {})
    });
    const task = await this.runtime.dispatch(created.id, prompt);
    return { status: 'delivered', reason: null, sessionId: created.id, taskId: task.id };
  }

  /** 上一条已投递的任务若仍在排队/执行，返回它的状态。 */
  private async unfinishedPrevious(schedule: ScheduleRecord): Promise<string | undefined> {
    const last = (await this.schedules.listRuns(schedule.id, 10)).find(run => run.status === 'delivered' && run.sessionId && run.taskId);
    if (!last) return undefined;
    const task = (await this.runtime.getTasks(last.sessionId!)).find(item => item.id === last.taskId);
    return task && unfinishedTaskStatuses.has(task.status) ? task.status : undefined;
  }

  /** new_session 模式只保留最近 keepSessions 个未归档会话，更早的归档（不删除，仍可查看）。 */
  private async pruneSessions(schedule: ScheduleRecord) {
    const keep = this.options.keepSessions ?? 20;
    const runs = await this.schedules.listRuns(schedule.id, keep + 50);
    const sessionIds = [...new Set(runs.filter(run => run.status === 'delivered' && run.sessionId && run.sessionId !== schedule.sessionId).map(run => run.sessionId!))];
    for (const id of sessionIds.slice(keep)) {
      const session = await this.runtime.getSession(id);
      if (!session || session.archivedAt || busySessionStates.has(session.state)) continue;
      try { await this.runtime.archive(id); }
      catch (error) { this.options.log?.warn(`归档定时任务会话 ${id} 失败：${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  private async disable(id: string, reason: string) {
    const current = await this.schedules.get(id);
    if (!current?.enabled) return;
    await this.schedules.save({ ...current, enabled: false, nextRunAt: null, lastStatus: 'failed', updatedAt: this.clock().toISOString() });
    this.options.log?.warn(`定时任务 ${id} 已停用：${reason}`);
  }

  /** 回写汇总字段。重新读一次再写：投递期间可能已被暂停或删除。 */
  private async finish(schedule: ScheduleRecord, fireAt: Date, outcome: Pick<ScheduleRunRecord, 'status'>, manual: boolean) {
    const current = await this.schedules.get(schedule.id);
    if (!current) return;
    const stamp = this.clock().toISOString();
    // 单次任务由定时器触发后结束（nextRunAt 已在抢占时置空）；手动触发不影响它的计划。
    const completedOnce = !manual && !isRecurring(current);
    await this.schedules.save({
      ...current,
      lastRunAt: fireAt.toISOString(),
      lastStatus: outcome.status,
      runCount: current.runCount + (outcome.status === 'delivered' ? 1 : 0),
      ...(completedOnce ? { enabled: false, nextRunAt: null } : {}),
      updatedAt: stamp
    });
  }
}

function templateFrom(session: Session): ScheduleSessionTemplate {
  return { agentId: session.agentId, cwd: session.cwd, ...(session.model ? { model: session.model } : {}), ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}) };
}

function normalizeTemplate(input?: Partial<ScheduleSessionTemplate>): ScheduleSessionTemplate | undefined {
  const agentId = input?.agentId?.trim();
  const cwd = input?.cwd?.trim();
  if (!agentId && !cwd) return undefined;
  if (!agentId || !cwd) throw new RuntimeError('INVALID_SCHEDULE', '新开会话需要同时指定 Agent 和工作目录', 400);
  const model = input?.model?.trim();
  const reasoningEffort = input?.reasoningEffort?.trim();
  return { agentId, cwd, ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) };
}

function parseTemplate(schedule: ScheduleRecord): ScheduleSessionTemplate {
  try {
    const value = JSON.parse(schedule.sessionTemplate ?? '') as Partial<ScheduleSessionTemplate>;
    if (typeof value.agentId === 'string' && typeof value.cwd === 'string') return value as ScheduleSessionTemplate;
  } catch { /* 落到下面的错误 */ }
  throw new RuntimeError('INVALID_SCHEDULE', `定时任务 ${schedule.id} 缺少新建会话所需的配置`, 500);
}
