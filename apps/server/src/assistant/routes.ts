import type { FastifyInstance } from 'fastify';
import { RuntimeError } from '@agent-dock/agent-dock-shared';
import type { AssistantService } from './service.js';
import type { DraftRecord, QuietHours, TaskCheck } from './types.js';
import { registerLifecycleRoutes } from './lifecycle-routes.js';

type TaskBody = {
  title?: string; notes?: string; doneWhen?: string[]; expectMinutes?: number;
  agentId?: string; cwd?: string; model?: string; reasoningEffort?: string; plan?: boolean;
};

const bad = (message: string) => new RuntimeError('INVALID_ASSISTANT_INPUT', message, 400);

const emojiSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
  : undefined;

/** 与网页端同一条规则：空串关闭，否则必须正好是一个 emoji。 */
function normalizeSilentEmoji(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw bad('静默触发表情必须是单个 emoji');
  const text = value.trim();
  if (!text) return '';
  const graphemes = emojiSegmenter
    ? [...emojiSegmenter.segment(text)].map(part => part.segment)
    : Array.from(text);
  const emojiLike = /\p{Extended_Pictographic}/u.test(text)
    || /^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test(text)
    || /\u20E3/u.test(text);
  if (graphemes.length !== 1 || !emojiLike) throw bad('静默触发表情必须是单个 emoji');
  return text;
}

/** CLI 传了 from 就必须是主会话；网页调用不带 from，由本地 Web 凭证保护。 */
function assertMain(assistant: AssistantService, from?: string) {
  const main = assistant.mainSessionId;
  if (!main) throw bad('还没有指定主会话');
  if (from && from !== main) throw new RuntimeError('FORBIDDEN', '只有主会话能执行这个操作', 403);
  return main;
}

/** CLI 传了 from 才要求它必须是主会话；网页设置不强依赖「已经认领小猫」。 */
function assertSettingsCaller(assistant: AssistantService, from?: string) {
  if (!from) return;
  const main = assistant.mainSessionId;
  if (!main) throw bad('还没有指定主会话');
  if (from !== main) throw new RuntimeError('FORBIDDEN', '只有主会话能执行这个操作', 403);
}

export function registerAssistantRoutes(app: FastifyInstance, assistant: AssistantService) {
  app.get('/api/assistant/main', async () => ({
    sessionId: assistant.mainSessionId ?? null,
    session: (await assistant.getMainSession()) ?? null
  }));

  app.put<{ Body: { sessionId?: string; agentId?: string; cwd?: string; model?: string; reasoningEffort?: string; name?: string; from?: string } }>('/api/assistant/main', async request => {
    const body = request.body ?? {};
    if (body.from && assistant.mainSessionId && body.from !== assistant.mainSessionId) {
      throw new RuntimeError('FORBIDDEN', '只有主会话能更换主会话', 403);
    }
    if (body.sessionId?.trim()) {
      const session = await assistant.setMainSession(body.sessionId.trim());
      const companion = body.name?.trim() ? await assistant.renameCompanion(body.name) : await assistant.getCompanion();
      return { session: (await assistant.getMainSession()) ?? session, companion: companion ?? null };
    }
    if (body.agentId?.trim()) {
      const session = await assistant.createMainSession({
        agentId: body.agentId.trim(),
        ...(body.cwd?.trim() ? { cwd: body.cwd.trim() } : {}),
        ...(body.model?.trim() ? { model: body.model.trim() } : {}),
        ...(body.reasoningEffort?.trim() ? { reasoningEffort: body.reasoningEffort.trim() } : {}),
        ...(body.name?.trim() ? { name: body.name } : {})
      });
      return { session, companion: (await assistant.getCompanion()) ?? null };
    }
    throw bad('sessionId 或 agentId 必填');
  });

  // 给小猫改名：同时改主会话标题，下一轮快照把新名字告诉主会话。
  app.put<{ Body: { name?: string; from?: string } }>('/api/assistant/companion', async request => {
    assertMain(assistant, request.body?.from);
    if (!request.body?.name?.trim()) throw bad('name 必填');
    return { companion: await assistant.renameCompanion(request.body.name) };
  });

  app.delete<{ Body: { from?: string } }>('/api/assistant/main', async request => {
    if (request.body?.from && assistant.mainSessionId && request.body.from !== assistant.mainSessionId) {
      throw new RuntimeError('FORBIDDEN', '只有主会话能清除主会话', 403);
    }
    await assistant.clearMainSession();
    return { ok: true };
  });

  app.get('/api/assistant/settings', async () => ({
    mainSessionId: assistant.mainSessionId ?? null,
    quietHours: assistant.getQuietHours(),
    silentEmoji: assistant.getSilentEmoji()
  }));

  app.put<{ Body: { quietHours?: Partial<QuietHours>; silentEmoji?: string | null; from?: string } }>('/api/assistant/settings', async request => {
    assertSettingsCaller(assistant, request.body?.from);
    const body = request.body ?? {};
    const hasQuietHours = body.quietHours !== undefined;
    const hasSilentEmoji = Object.hasOwn(body, 'silentEmoji');
    if (!hasQuietHours && !hasSilentEmoji) throw bad('quietHours 或 silentEmoji 至少填一个');
    const quietHours = hasQuietHours
      ? assistant.setQuietHours({
        enabled: body.quietHours?.enabled === true,
        start: body.quietHours?.start ?? '23:00',
        end: body.quietHours?.end ?? '08:00'
      })
      : assistant.getQuietHours();
    const silentEmoji = hasSilentEmoji
      ? assistant.setSilentEmoji(normalizeSilentEmoji(body.silentEmoji))
      : assistant.getSilentEmoji();
    return { quietHours, silentEmoji };
  });

  app.get('/api/assistant/state', async () => ({
    mainSessionId: assistant.mainSessionId ?? null,
    mainSession: (await assistant.getMainSession()) ?? null,
    companion: (await assistant.getCompanion()) ?? null,
    quietHours: assistant.getQuietHours(),
    silentEmoji: assistant.getSilentEmoji(),
    tasks: assistant.listTasks(),
    watches: assistant.listWatches(),
    drafts: assistant.listDrafts(),
    // 小猫的代数、阶段、交接提议、进行中的整理：网页不用再多轮询一个接口。
    lifecycle: await assistant.lifecycle.light()
  }));

  app.get('/api/assistant/tasks', async () => ({ tasks: assistant.listTasks() }));

  app.get<{ Params: { id: string } }>('/api/assistant/tasks/:id', async (request, reply) => {
    const task = assistant.getTask(request.params.id);
    if (!task) return reply.code(404).send({ error: { code: 'TASK_NOT_FOUND', message: '事项不存在' } });
    return { task, reviews: assistant.listReviews(task.id) };
  });

  app.post<{ Body: TaskBody & { from?: string } }>('/api/assistant/tasks', async request => {
    assertMain(assistant, request.body?.from);
    await assistant.lifecycle.assertNoSystemRound(request.body?.from, request.body?.plan === true ? '记计划卡' : '派活');
    const body = request.body ?? {};
    const title = body.title?.trim();
    if (!title) throw bad('title 必填');
    const doneWhen = (body.doneWhen ?? []).map(item => item.trim()).filter(Boolean);
    if (!doneWhen.length) throw bad('至少写一条验收标准');
    const input = {
      title,
      ...(body.notes?.trim() ? { notes: body.notes.trim() } : {}),
      doneWhen,
      ...(body.expectMinutes === undefined ? {} : { expectMinutes: body.expectMinutes }),
      ...(body.agentId?.trim() ? { agentId: body.agentId.trim() } : {}),
      ...(body.cwd?.trim() ? { cwd: body.cwd.trim() } : {}),
      ...(body.model?.trim() ? { model: body.model.trim() } : {}),
      ...(body.reasoningEffort?.trim() ? { reasoningEffort: body.reasoningEffort.trim() } : {})
    };
    return body.plan === true ? { task: assistant.planTask(input) } : { task: await assistant.startTask(input) };
  });

  app.post<{ Params: { id: string }; Body: { from?: string } }>('/api/assistant/tasks/:id/start', async request => {
    assertMain(assistant, request.body?.from);
    await assistant.lifecycle.assertNoSystemRound(request.body?.from, '让计划卡开工');
    return { task: await assistant.startPlannedTask(request.params.id) };
  });

  app.post<{ Params: { id: string }; Body: { verdict?: string; checks?: TaskCheck[]; note?: string; from?: string } }>('/api/assistant/tasks/:id/review', async request => {
    assertMain(assistant, request.body?.from);
    const verdict = request.body?.verdict;
    if (verdict !== 'accepted' && verdict !== 'rework' && verdict !== 'needs_user' && verdict !== 'cancelled') {
      throw bad('verdict 必须是 accepted / rework / needs_user / cancelled');
    }
    return { task: await assistant.reviewTask(request.params.id, verdict, request.body?.checks ?? [], request.body?.note) };
  });

  app.post<{ Params: { id: string }; Body: { reason?: string; from?: string } }>('/api/assistant/tasks/:id/cancel', async request => {
    assertMain(assistant, request.body?.from);
    return { task: await assistant.cancelTask(request.params.id, request.body?.reason) };
  });

  app.post<{ Body: { from?: string; kind?: string; text?: string; evidence?: string } }>('/api/assistant/report', async request => {
    const from = request.body?.from;
    if (!from) throw bad('from 必填（侧边会话 ID）');
    const kind = request.body?.kind;
    if (kind !== 'done' && kind !== 'question' && kind !== 'blocked') throw bad('kind 必须是 done / question / blocked');
    const text = request.body?.text?.trim();
    if (!text) throw bad('text 必填');
    return { task: await assistant.reportTask(from, kind, text, request.body?.evidence) };
  });

  app.get('/api/assistant/watches', async () => ({ watches: assistant.listWatches() }));

  app.post<{ Body: {
    name?: string; command?: string; cwd?: string; every?: string; timeout?: string;
    mode?: 'once' | 'repeat'; cooldown?: string; expires?: string; from?: string;
  } }>('/api/assistant/watches', async request => {
    assertMain(assistant, request.body?.from);
    await assistant.lifecycle.assertNoSystemRound(request.body?.from, '加 watch');
    const body = request.body ?? {};
    const name = body.name?.trim();
    const command = body.command?.trim();
    if (!name) throw bad('name 必填');
    if (!command) throw bad('command 必填');
    const owner = assistant.mainSessionId;
    if (!owner) throw bad('还没有指定主会话');
    return { watch: assistant.addWatch({
      ownerSessionId: owner, name, command,
      ...(body.cwd?.trim() ? { cwd: body.cwd.trim() } : {}),
      every: body.every?.trim() || '60s',
      ...(body.timeout ? { timeout: body.timeout } : {}),
      ...(body.mode ? { mode: body.mode } : {}),
      ...(body.cooldown ? { cooldown: body.cooldown } : {}),
      ...(body.expires ? { expires: body.expires } : {})
    }) };
  });

  app.post<{ Params: { id: string }; Body: { from?: string } }>('/api/assistant/watches/:id/pause', async request => {
    assertMain(assistant, request.body?.from);
    return { watch: assistant.pauseWatch(request.params.id) };
  });
  app.post<{ Params: { id: string }; Body: { from?: string } }>('/api/assistant/watches/:id/resume', async request => {
    assertMain(assistant, request.body?.from);
    return { watch: assistant.resumeWatch(request.params.id) };
  });
  app.post<{ Params: { id: string }; Body: { from?: string } }>('/api/assistant/watches/:id/run', async request => {
    assertMain(assistant, request.body?.from);
    return { watch: await assistant.runWatchNow(request.params.id) };
  });
  app.delete<{ Params: { id: string }; Body: { from?: string } }>('/api/assistant/watches/:id', async request => {
    assertMain(assistant, request.body?.from);
    return assistant.removeWatch(request.params.id);
  });

  app.get('/api/assistant/drafts', async () => ({ drafts: assistant.listDrafts() }));

  app.post<{ Body: { channel?: DraftRecord['channel']; target?: string; body?: string; payload?: Record<string, unknown>; taskId?: string; from?: string } }>('/api/assistant/drafts', async request => {
    assertMain(assistant, request.body?.from);
    const body = request.body ?? {};
    if (body.channel !== 'github_comment' && body.channel !== 'lark_reply') throw bad('channel 必须是 github_comment 或 lark_reply');
    if (!body.target?.trim()) throw bad('target 必填');
    if (!body.body?.trim()) throw bad('body 必填');
    return { draft: assistant.createDraft({
      channel: body.channel, target: body.target.trim(), body: body.body,
      ...(body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? { payload: body.payload } : {}),
      ...(body.taskId ? { taskId: body.taskId } : {}),
      ...(assistant.mainSessionId ? { createdBy: assistant.mainSessionId } : {})
    }) };
  });

  app.post<{ Params: { id: string }; Body: { from?: string } }>('/api/assistant/drafts/:id/send', async request => {
    assertMain(assistant, request.body?.from);
    return { draft: await assistant.sendDraft(request.params.id) };
  });
  app.post<{ Params: { id: string }; Body: { from?: string } }>('/api/assistant/drafts/:id/discard', async request => {
    assertMain(assistant, request.body?.from);
    return { draft: assistant.discardDraft(request.params.id) };
  });

  app.post<{ Body: { text?: string; ask?: boolean; urgent?: boolean; from?: string } }>('/api/assistant/notify', async request => {
    assertMain(assistant, request.body?.from);
    // 系统轮次（整理 / 交接说明）不打扰用户；真要紧的 --urgent 仍放行。
    if (request.body?.urgent !== true) await assistant.lifecycle.assertNoSystemRound(request.body?.from, '发通知');
    const text = request.body?.text?.trim();
    if (!text) throw bad('text 必填');
    return await assistant.notify({ text, ask: request.body?.ask === true, urgent: request.body?.urgent === true });
  });

  // 给测试和脚本用：立刻跑一轮扫描，不必等 30 秒。
  app.post('/api/assistant/scan', async () => { await assistant.scan(); return { ok: true }; });

  registerLifecycleRoutes(app, assistant);
}
