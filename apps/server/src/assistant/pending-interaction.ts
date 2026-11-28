import {
  BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
  defaultOutputPluginRegistry,
  normalizeOutputPluginId,
  pickFinalAssistantText,
  RuntimeError,
  type AgentEvent,
  type AskUserQuestionAnswerItem,
  type AskUserQuestionItem,
  type AskUserQuestionSpec,
  type ConfirmActionDecision,
  type ConfirmActionRisk,
  type ConfirmActionSpec,
  type DeclarativeInteractionField,
  type DeclarativeOutputPluginSpec,
  type OutputPluginDefinition,
  type RepositoryBundle
} from '@agent-dock/agent-dock-shared';
import type { OutputPluginService, SubmitOutputPluginInteractionInput } from '../output-plugins/service.js';

export interface PendingSideInteraction {
  pluginId: string;
  pluginName: string;
  widgetId: string;
  title?: string;
  proseText: string;
  spec: unknown;
}

export interface AssistantQuickAnswer {
  questionId?: string;
  values?: string[];
  otherText?: string;
}

export interface AnswerTaskInteractionInput {
  widgetId?: string;
  pluginId?: string;
  title?: string;
  /** `builtin:ask-user-question` 完整作答列表。 */
  answers?: AskUserQuestionAnswerItem[];
  /** CLI 快捷作答列表（例如 `--answer q1=sqlite` 或 `--answer sqlite`）。 */
  quickAnswers?: AssistantQuickAnswer[];
  /** 单题询问卡快捷补充/理由。 */
  otherText?: string;
  /** `builtin:confirm-action` 专用决策。 */
  decision?: ConfirmActionDecision;
  decisionLabel?: string;
  risk?: ConfirmActionRisk;
  comment?: string;
  /** 声明式插件通用操作值/字段/备注。 */
  actionValue?: string;
  actionLabel?: string;
  fields?: DeclarativeInteractionField[];
  note?: string;
  /** 可选覆盖代答小猫名；默认读取当前 CompanionProfile.name。 */
  responderName?: string;
  responderSessionId?: string;
  mode?: 'queue' | 'interrupt';
}

function lastTurnEvents(events: AgentEvent[]): AgentEvent[] {
  let lastUserIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    const data = event.data as Record<string, unknown> | undefined;
    if (event.type === 'text' && data?.role === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  return lastUserIndex >= 0 ? events.slice(lastUserIndex + 1) : events;
}

function compactLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const chars = [...normalized];
  return chars.length <= maxChars ? normalized : `${chars.slice(0, maxChars).join('').trimEnd()}…`;
}

/**
 * 探测侧边会话最近一轮末尾是否存在「尚未作答」的交互卡片（AskUserQuestion / ConfirmAction / 声明式交互卡）。
 * 已作答（channelMappings 或交互回传任务中已有记录）时返回 undefined。
 */
export async function findPendingSessionInteraction(options: {
  sessionId: string;
  repos: RepositoryBundle;
  outputPlugins?: OutputPluginService;
  recentEvents?: AgentEvent[];
  expectedWidgetId?: string;
}): Promise<PendingSideInteraction | undefined> {
  const { sessionId, repos, outputPlugins } = options;
  const events = options.recentEvents ?? await repos.events.listRecent(sessionId, 500).catch(() => []);
  let rawText = pickFinalAssistantText(lastTurnEvents(events));
  if (!rawText) {
    const tasks = await repos.tasks.listBySession(sessionId).catch(() => []);
    for (let index = tasks.length - 1; index >= 0; index -= 1) {
      const candidate = tasks[index]!;
      if (candidate.status === 'completed' && candidate.finalText?.trim()) {
        rawText = candidate.finalText;
        break;
      }
      if (candidate.status === 'running' || candidate.status === 'queued') continue;
      if (candidate.finalText?.trim()) {
        rawText = candidate.finalText;
        break;
      }
    }
  }
  if (!rawText) return undefined;

  const session = await repos.sessions.get(sessionId).catch(() => undefined);
  const registry = outputPlugins?.registry ?? defaultOutputPluginRegistry;
  const enabledIds = outputPlugins
    ? await outputPlugins.enabledPluginIdsForSession(session).catch(() => undefined)
    : undefined;
  const parsed = registry.parseTrailingOutput(rawText, enabledIds);
  if (!parsed) return undefined;

  const plugin = registry.get(parsed.pluginId);
  if (!plugin || !plugin.capabilities.interactive) return undefined;

  const widgetId = plugin.getInstanceId(parsed.spec);
  if (options.expectedWidgetId && widgetId !== options.expectedWidgetId) return undefined;

  if (outputPlugins) {
    const submitted = await outputPlugins.getSubmittedInteraction(plugin.id, sessionId, widgetId).catch(() => undefined);
    if (submitted) return undefined;
  } else {
    const tasks = await repos.tasks.listBySession(sessionId).catch(() => []);
    if (plugin.interactionOrigin && plugin.parseInteraction && plugin.getInteractionInstanceId) {
      for (let index = tasks.length - 1; index >= 0; index -= 1) {
        const task = tasks[index]!;
        if (task.origin !== plugin.interactionOrigin) continue;
        if (task.status === 'cancelled' || task.status === 'failed') continue;
        const payload = plugin.parseInteraction(task.prompt);
        if (payload && plugin.getInteractionInstanceId(payload) === widgetId) return undefined;
      }
    }
  }

  const title = plugin.getTitle?.(parsed.spec);
  return {
    pluginId: plugin.id,
    pluginName: plugin.name,
    widgetId,
    ...(title ? { title } : {}),
    proseText: parsed.proseText,
    spec: parsed.spec
  };
}

/**
 * 将未答交互卡压缩成单行摘要，附进 `[review]` 督办信号中（不能含换行，兼容前端 `parseSupervisionDetail`）。
 */
export function formatPendingInteractionSignalSummary(
  pending: PendingSideInteraction,
  taskId?: string
): string {
  const titlePart = pending.title ? `「${compactLine(pending.title, 40)}」` : '';
  const taskArg = taskId || '<任务ID>';

  if (pending.pluginId === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID) {
    const spec = pending.spec as AskUserQuestionSpec;
    const questionsSummary = spec.questions.map((question, idx) => {
      const optionsText = question.options.map(option => (
        `${option.value}=${compactLine(option.label, 24)}${option.recommended ? '(推荐)' : ''}`
      )).join(' / ');
      const otherHint = question.allowOther ? '，可自定义' : '';
      const modeHint = question.multi ? '[多选]' : '';
      return `Q${idx + 1}(${question.id})${modeHint} ${compactLine(question.prompt, 60)}${optionsText ? ` [${optionsText}${otherHint}]` : ''}`;
    }).join('；');
    return `待答询问卡 widgetId=${pending.widgetId}${titlePart}：${questionsSummary}（代答：agent-dock task answer ${taskArg} --widget ${pending.widgetId} --answer <题号=选项值> [--other "说明"]）`;
  }

  if (pending.pluginId === BUILTIN_CONFIRM_ACTION_PLUGIN_ID) {
    const spec = pending.spec as ConfirmActionSpec;
    const summaryPart = spec.summary ? ` ${compactLine(spec.summary, 80)}` : '';
    const cmdPart = spec.command ? ` 命令=${compactLine(spec.command, 50)}` : '';
    return `待确认操作卡 widgetId=${pending.widgetId}${titlePart} [risk=${spec.risk}]：${summaryPart}${cmdPart} [confirm="${spec.confirmLabel}" / cancel="${spec.cancelLabel}"]（代答：agent-dock task answer ${taskArg} --widget ${pending.widgetId} --decision confirm|cancel [--comment "说明"]）`.replace(/：\s+/, '：');
  }

  const spec = pending.spec as DeclarativeOutputPluginSpec;
  const actionsText = spec.actions?.length
    ? ` 选项=[${spec.actions.map(action => `${action.value}=${compactLine(action.label, 20)}`).join(' / ')}]`
    : '';
  const summaryPart = spec.summary ? ` ${compactLine(spec.summary, 80)}` : '';
  return `待响应交互卡(${pending.pluginId}) widgetId=${pending.widgetId}${titlePart}：${summaryPart}${actionsText}（代答：agent-dock task answer ${taskArg} --widget ${pending.widgetId} --action <操作值> [--note "说明"]）`.replace(/：\s+/, '：');
}

function matchAskOption(question: AskUserQuestionItem, rawToken: string) {
  const token = rawToken.trim();
  if (!token) return undefined;
  const lower = token.toLowerCase();
  return question.options.find(option => option.value === token)
    ?? question.options.find(option => option.value.toLowerCase() === lower)
    ?? question.options.find(option => option.label === token)
    ?? question.options.find(option => option.label.toLowerCase() === lower);
}

function buildAskAnswersFromSpec(
  spec: AskUserQuestionSpec | undefined,
  input: AnswerTaskInteractionInput
): AskUserQuestionAnswerItem[] {
  if (input.answers?.length) {
    const questionById = new Map((spec?.questions ?? []).map(question => [question.id, question]));
    return input.answers.map(item => {
      const matchedQuestion = questionById.get(item.questionId)
        ?? (spec?.questions.length === 1 ? spec.questions[0] : undefined);
      const selectedValues: string[] = [];
      const selectedLabels: string[] = [];
      for (let idx = 0; idx < item.selectedValues.length; idx += 1) {
        const rawVal = item.selectedValues[idx]!.trim();
        if (!rawVal) continue;
        const opt = matchedQuestion ? matchAskOption(matchedQuestion, rawVal) : undefined;
        selectedValues.push(opt ? opt.value : rawVal);
        selectedLabels.push(item.selectedLabels[idx]?.trim() || opt?.label || rawVal);
      }
      if (!selectedLabels.length && item.selectedLabels.length) {
        for (const label of item.selectedLabels) {
          const trimmed = label.trim();
          if (trimmed) selectedLabels.push(trimmed);
        }
      }
      return {
        questionId: matchedQuestion?.id ?? item.questionId.trim(),
        prompt: item.prompt.trim() || matchedQuestion?.prompt || item.questionId.trim(),
        selectedValues,
        selectedLabels,
        ...(item.otherText?.trim() ? { otherText: item.otherText.trim() } : {})
      };
    });
  }

  const quickList = input.quickAnswers ?? [];
  const topOther = input.otherText?.trim() || undefined;
  if (!quickList.length && !topOther) {
    throw new RuntimeError('EMPTY_ASK_USER_QUESTION_ANSWER', '请通过 --answer、--other 或 --answers-json 提供代答内容', 400);
  }

  if (!spec) {
    // 没匹配到原卡片 spec 时，允许显式传入 `qId=val` 形式的快捷作答
    return quickList.length
      ? quickList.map((entry, idx) => {
          const qid = entry.questionId?.trim() || `q${idx + 1}`;
          const vals = (entry.values ?? []).map(v => v.trim()).filter(Boolean);
          const otherText = entry.otherText?.trim() || (idx === 0 ? topOther : undefined);
          return {
            questionId: qid,
            prompt: qid,
            selectedValues: vals,
            selectedLabels: vals,
            ...(otherText ? { otherText } : {})
          };
        })
      : [{
          questionId: 'q1',
          prompt: input.title?.trim() || '询问',
          selectedValues: [],
          selectedLabels: [],
          ...(topOther ? { otherText: topOther } : {})
        }];
  }

  const questionMap = new Map(spec.questions.map(question => [question.id, question]));
  const answerMap = new Map<string, { selectedValues: string[]; selectedLabels: string[]; otherParts: string[] }>();
  const ensureBucket = (questionId: string) => {
    let bucket = answerMap.get(questionId);
    if (!bucket) {
      bucket = { selectedValues: [], selectedLabels: [], otherParts: [] };
      answerMap.set(questionId, bucket);
    }
    return bucket;
  };

  for (let idx = 0; idx < quickList.length; idx += 1) {
    const entry = quickList[idx]!;
    let question: AskUserQuestionItem | undefined;
    if (entry.questionId?.trim()) {
      question = questionMap.get(entry.questionId.trim());
      if (!question) {
        throw new RuntimeError(
          'INVALID_ASK_QUESTION_ID',
          `未在询问卡「${spec.id}」中找到问题 ${entry.questionId.trim()}（可用：${spec.questions.map(q => q.id).join(', ')}）`,
          400
        );
      }
    } else if (spec.questions.length === 1) {
      question = spec.questions[0]!;
    } else if (spec.questions[idx]) {
      question = spec.questions[idx]!;
    } else {
      throw new RuntimeError(
        'AMBIGUOUS_ASK_ANSWER',
        `询问卡「${spec.id}」包含 ${spec.questions.length} 个问题，请使用 --answer <questionId>=<value> 指定题号`,
        400
      );
    }

    const bucket = ensureBucket(question.id);
    for (const token of entry.values ?? []) {
      const trimmed = token.trim();
      if (!trimmed) continue;
      const option = matchAskOption(question, trimmed);
      if (option) {
        if (!bucket.selectedValues.includes(option.value)) {
          bucket.selectedValues.push(option.value);
          bucket.selectedLabels.push(option.label);
        }
      } else if (question.allowOther) {
        bucket.otherParts.push(trimmed);
      } else {
        throw new RuntimeError(
          'INVALID_ASK_OPTION',
          `问题 ${question.id} 不支持选项「${trimmed}」（可选：${question.options.map(o => o.value).join(', ')}）`,
          400
        );
      }
    }
    if (entry.otherText?.trim()) {
      bucket.otherParts.push(entry.otherText.trim());
    }
  }

  if (topOther) {
    const targetQuestion = spec.questions.length === 1
      ? spec.questions[0]!
      : spec.questions.find(q => answerMap.has(q.id)) ?? spec.questions[0]!;
    ensureBucket(targetQuestion.id).otherParts.push(topOther);
  }

  const resolved: AskUserQuestionAnswerItem[] = [];
  for (const question of spec.questions) {
    const bucket = answerMap.get(question.id);
    if (!bucket) continue;
    const otherText = bucket.otherParts.join('；').trim() || undefined;
    if (!bucket.selectedValues.length && !otherText) continue;
    resolved.push({
      questionId: question.id,
      prompt: question.prompt,
      selectedValues: bucket.selectedValues,
      selectedLabels: bucket.selectedLabels,
      ...(otherText ? { otherText } : {})
    });
  }

  if (!resolved.length) {
    throw new RuntimeError('EMPTY_ASK_USER_QUESTION_ANSWER', '请至少选择或填写一项回答后再提交', 400);
  }
  return resolved;
}

/**
 * 将主会话 CLI / API 传入的代答参数归一化为 `OutputPluginService.submitInteraction` 所需的完整载荷。
 */
export function resolveAssistantAnswerSubmission(options: {
  sessionId: string;
  pending?: PendingSideInteraction;
  input: AnswerTaskInteractionInput;
  responderName: string;
  responderSessionId?: string;
  pluginLookup?: (pluginId: string) => OutputPluginDefinition | undefined;
}): SubmitOutputPluginInteractionInput {
  const { sessionId, pending, input, responderName, responderSessionId } = options;

  const inferredPluginId = input.pluginId?.trim()
    ? normalizeOutputPluginId(input.pluginId)
    : pending?.pluginId
      ?? (input.decision
        ? BUILTIN_CONFIRM_ACTION_PLUGIN_ID
        : BUILTIN_ASK_USER_QUESTION_PLUGIN_ID);

  const widgetId = input.widgetId?.trim() || pending?.widgetId;
  if (!widgetId) {
    throw new RuntimeError(
      'NO_PENDING_INTERACTION',
      '该侧边会话末尾没有待响应的交互卡片；若是自然语言提问请改用 agent-dock task append <任务ID> --text "..."',
      404
    );
  }

  const matchedPending = pending && pending.widgetId === widgetId && pending.pluginId === inferredPluginId
    ? pending
    : undefined;

  if (inferredPluginId === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID) {
    const spec = matchedPending?.spec as AskUserQuestionSpec | undefined;
    const answers = buildAskAnswersFromSpec(spec, input);
    return {
      pluginId: BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
      sessionId,
      instanceId: widgetId,
      title: input.title?.trim() || spec?.title,
      source: 'assistant',
      actedBy: responderName,
      responderName,
      responderSessionId,
      answers,
      mode: input.mode
    };
  }

  if (inferredPluginId === BUILTIN_CONFIRM_ACTION_PLUGIN_ID) {
    const spec = matchedPending?.spec as ConfirmActionSpec | undefined;
    const decision = input.decision
      ?? (input.actionValue === 'confirm' || input.actionValue === 'approve'
        ? 'confirm'
        : input.actionValue === 'cancel' || input.actionValue === 'reject'
          ? 'cancel'
          : undefined);
    if (!decision) {
      throw new RuntimeError('INVALID_CONFIRM_ACTION_DECISION', '操作确认卡代答需要指定 --decision confirm 或 cancel', 400);
    }
    const decisionLabel = input.decisionLabel?.trim()
      || input.actionLabel?.trim()
      || (spec ? (decision === 'confirm' ? spec.confirmLabel : spec.cancelLabel) : undefined)
      || (decision === 'confirm' ? '确认执行' : '取消');
    return {
      pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
      sessionId,
      instanceId: widgetId,
      title: input.title?.trim() || spec?.title,
      risk: input.risk ?? spec?.risk,
      decision,
      decisionLabel,
      comment: (input.comment ?? input.note ?? input.otherText)?.trim() || undefined,
      source: 'assistant',
      actedBy: responderName,
      responderName,
      responderSessionId,
      mode: input.mode
    };
  }

  const spec = matchedPending?.spec as DeclarativeOutputPluginSpec | undefined;
  const matchedAction = input.actionValue && spec?.actions?.length
    ? spec.actions.find(action => action.value === input.actionValue || action.label === input.actionValue)
    : undefined;
  const actionValue = matchedAction?.value ?? input.actionValue?.trim();
  const actionLabel = input.actionLabel?.trim() || matchedAction?.label || actionValue;
  return {
    pluginId: inferredPluginId,
    sessionId,
    instanceId: widgetId,
    title: input.title?.trim() || spec?.title,
    source: 'assistant',
    actedBy: responderName,
    responderName,
    responderSessionId,
    ...(actionValue ? { actionValue } : {}),
    ...(actionLabel ? { actionLabel } : {}),
    ...(input.fields ? { fields: input.fields } : {}),
    note: (input.note ?? input.comment ?? input.otherText)?.trim() || undefined,
    mode: input.mode
  };
}
