import type { Agent, AgentModelsResult, Project, Session } from './api';
import { readInitialAgentModels } from './model-cache';

export type PrefsStorage = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>;

/** 新建对话草稿栏（DraftComposer）的用户最近使用配置持久化键。 */
export const DRAFT_COMPOSER_PREFS_STORAGE_KEY = 'agentdock:draft-composer-prefs.v1';

const MAX_TRACKED_AGENTS = 50;
const MAX_TRACKED_MODELS_PER_AGENT = 50;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type AgentLastUsedPrefs = {
  /** 该 Agent 上次显式选择的模型 ID。 */
  model?: string;
  /** 该 Agent 上次显式选择的思考深度 ID（跨模型兜底）。 */
  reasoningEffort?: string;
  /** 该 Agent 下按模型分别记住的思考深度，避免切到支持档位不同的模型时互相覆盖。 */
  reasoningByModel?: Record<string, string>;
};

export type DraftComposerPrefs = {
  version: 1;
  /** 上次选择的 Agent ID。 */
  agentId?: string;
  /** 上次显式选择的工作目录（空/未设置表示跟随 Agent 默认目录）。 */
  cwd?: string;
  /** 按 Agent ID 隔离保存的模型与思考深度偏好。 */
  byAgent: Record<string, AgentLastUsedPrefs>;
};

export const EMPTY_DRAFT_COMPOSER_PREFS: DraftComposerPrefs = {
  version: 1,
  byAgent: {}
};

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '';
  if (/^[\\/]+$/.test(trimmed)) return '/';
  return trimmed.replace(/[\\/]+$/, '');
}

export function getBrowserPrefsStorage(): PrefsStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function normalizeReasoningByModel(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>);
  const normalized: Record<string, string> = {};
  let count = 0;
  for (const [modelId, effort] of entries) {
    if (count >= MAX_TRACKED_MODELS_PER_AGENT) break;
    const cleanModel = nonEmptyString(modelId);
    const cleanEffort = nonEmptyString(effort);
    if (!cleanModel || !cleanEffort || FORBIDDEN_KEYS.has(cleanModel)) continue;
    normalized[cleanModel] = cleanEffort;
    count++;
  }
  return count > 0 ? normalized : undefined;
}

function normalizeAgentPrefs(raw: unknown): AgentLastUsedPrefs | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const model = nonEmptyString(record.model);
  const reasoningEffort = nonEmptyString(record.reasoningEffort);
  const reasoningByModel = normalizeReasoningByModel(record.reasoningByModel);
  if (!model && !reasoningEffort && !reasoningByModel) return undefined;
  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(reasoningByModel ? { reasoningByModel } : {})
  };
}

/**
 * 归一化外部输入的偏好对象（localStorage 可能包含损坏数据、旧结构或手工改动）。
 * 始终返回干净合法的 DraftComposerPrefs，绝不抛错。
 */
export function normalizeDraftComposerPrefs(raw: unknown): DraftComposerPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { version: 1, byAgent: {} };
  }
  const record = raw as Record<string, unknown>;
  const agentId = nonEmptyString(record.agentId);
  const cwd = nonEmptyString(record.cwd);
  const byAgent: Record<string, AgentLastUsedPrefs> = {};

  if (record.byAgent && typeof record.byAgent === 'object' && !Array.isArray(record.byAgent)) {
    let count = 0;
    for (const [rawAgentId, value] of Object.entries(record.byAgent as Record<string, unknown>)) {
      if (count >= MAX_TRACKED_AGENTS) break;
      const cleanAgentId = nonEmptyString(rawAgentId);
      if (!cleanAgentId || FORBIDDEN_KEYS.has(cleanAgentId)) continue;
      const normalized = normalizeAgentPrefs(value);
      if (!normalized) continue;
      byAgent[cleanAgentId] = normalized;
      count++;
    }
  }

  return {
    version: 1,
    ...(agentId ? { agentId } : {}),
    ...(cwd ? { cwd } : {}),
    byAgent
  };
}

export function readDraftComposerPrefs(storage: PrefsStorage | undefined = getBrowserPrefsStorage()): DraftComposerPrefs {
  if (!storage) return { version: 1, byAgent: {} };
  try {
    const raw = storage.getItem(DRAFT_COMPOSER_PREFS_STORAGE_KEY);
    if (!raw) return { version: 1, byAgent: {} };
    return normalizeDraftComposerPrefs(JSON.parse(raw));
  } catch {
    return { version: 1, byAgent: {} };
  }
}

export function writeDraftComposerPrefs(
  prefs: DraftComposerPrefs,
  storage: PrefsStorage | undefined = getBrowserPrefsStorage()
): void {
  if (!storage) return;
  try {
    const normalized = normalizeDraftComposerPrefs(prefs);
    storage.setItem(DRAFT_COMPOSER_PREFS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    /* 隐私模式或配额已满时降级为仅本次会话内存态生效，不影响页面正常使用。 */
  }
}

function trimRecordTail<T>(record: Record<string, T>, maxEntries: number): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.length <= maxEntries) return record;
  const kept: Record<string, T> = {};
  for (const key of keys.slice(keys.length - maxEntries)) {
    kept[key] = record[key]!;
  }
  return kept;
}

export function withLastUsedAgent(prefs: DraftComposerPrefs, agentId: string): DraftComposerPrefs {
  const cleanAgentId = nonEmptyString(agentId);
  if (!cleanAgentId || FORBIDDEN_KEYS.has(cleanAgentId)) return prefs;
  return {
    ...prefs,
    version: 1,
    agentId: cleanAgentId
  };
}

export function withLastUsedWorkspace(
  prefs: DraftComposerPrefs,
  cwd: string,
  fallbackAgentId?: string
): DraftComposerPrefs {
  const cleanCwd = nonEmptyString(cwd);
  const nextAgentId = prefs.agentId ?? nonEmptyString(fallbackAgentId);
  const { cwd: _prevCwd, ...rest } = prefs;
  return {
    ...rest,
    version: 1,
    ...(nextAgentId ? { agentId: nextAgentId } : {}),
    ...(cleanCwd ? { cwd: cleanCwd } : {})
  };
}

export function withLastUsedModel(
  prefs: DraftComposerPrefs,
  agentId: string,
  model: string
): DraftComposerPrefs {
  const cleanAgentId = nonEmptyString(agentId);
  const cleanModel = nonEmptyString(model);
  if (!cleanAgentId || !cleanModel || FORBIDDEN_KEYS.has(cleanAgentId) || FORBIDDEN_KEYS.has(cleanModel)) {
    return prefs;
  }
  const existing = prefs.byAgent[cleanAgentId] ?? {};
  const nextByAgent = trimRecordTail(
    {
      ...prefs.byAgent,
      [cleanAgentId]: {
        ...existing,
        model: cleanModel
      }
    },
    MAX_TRACKED_AGENTS
  );
  return {
    ...prefs,
    version: 1,
    agentId: cleanAgentId,
    byAgent: nextByAgent
  };
}

export function withLastUsedReasoningEffort(
  prefs: DraftComposerPrefs,
  agentId: string,
  reasoningEffort: string,
  model?: string
): DraftComposerPrefs {
  const cleanAgentId = nonEmptyString(agentId);
  const cleanEffort = nonEmptyString(reasoningEffort);
  const cleanModel = nonEmptyString(model);
  if (!cleanAgentId || !cleanEffort || FORBIDDEN_KEYS.has(cleanAgentId)) return prefs;

  const existing = prefs.byAgent[cleanAgentId] ?? {};
  const nextReasoningByModel = cleanModel && !FORBIDDEN_KEYS.has(cleanModel)
    ? trimRecordTail({ ...(existing.reasoningByModel ?? {}), [cleanModel]: cleanEffort }, MAX_TRACKED_MODELS_PER_AGENT)
    : existing.reasoningByModel;

  const nextByAgent = trimRecordTail(
    {
      ...prefs.byAgent,
      [cleanAgentId]: {
        ...existing,
        reasoningEffort: cleanEffort,
        ...(nextReasoningByModel ? { reasoningByModel: nextReasoningByModel } : {})
      }
    },
    MAX_TRACKED_AGENTS
  );
  return {
    ...prefs,
    version: 1,
    agentId: cleanAgentId,
    byAgent: nextByAgent
  };
}

/**
 * 新建会话提交时巩固一次偏好：
 * - 始终记住本次提交所用的 Agent；
 * - 显式指定了工作目录 / 模型 / 思考深度时同步写入；
 * - 留空（跟随 Agent 默认）时不把动态默认值写死成覆盖项，保证后续改 Agent 默认配置仍可生效。
 */
export function withConfirmedDraftSubmission(
  prefs: DraftComposerPrefs,
  submission: {
    agentId: string;
    cwd?: string;
    model?: string;
    reasoningEffort?: string;
  }
): DraftComposerPrefs {
  let next = withLastUsedAgent(prefs, submission.agentId);
  next = withLastUsedWorkspace(next, submission.cwd ?? '', submission.agentId);
  if (submission.model?.trim()) {
    next = withLastUsedModel(next, submission.agentId, submission.model);
  }
  if (submission.reasoningEffort?.trim()) {
    next = withLastUsedReasoningEffort(next, submission.agentId, submission.reasoningEffort, submission.model);
  }
  return next;
}

/** 当远端模型目录明确证实某旧模型已下线/不可用时，只清掉该 Agent 下匹配的过期条目。 */
export function withoutStaleAgentModel(
  prefs: DraftComposerPrefs,
  agentId: string,
  staleModel: string
): DraftComposerPrefs {
  const cleanAgentId = nonEmptyString(agentId);
  const cleanModel = nonEmptyString(staleModel);
  if (!cleanAgentId || !cleanModel) return prefs;
  const existing = prefs.byAgent[cleanAgentId];
  if (!existing) return prefs;

  const hasMatchingModel = existing.model === cleanModel;
  const hasMatchingReasoning = Boolean(existing.reasoningByModel && Object.prototype.hasOwnProperty.call(existing.reasoningByModel, cleanModel));
  if (!hasMatchingModel && !hasMatchingReasoning) return prefs;

  const { model: _oldModel, reasoningByModel, ...restAgent } = existing;
  let nextReasoningByModel: Record<string, string> | undefined;
  if (reasoningByModel) {
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(reasoningByModel)) {
      if (key !== cleanModel) filtered[key] = value;
    }
    if (Object.keys(filtered).length > 0) nextReasoningByModel = filtered;
  }

  const nextEntry: AgentLastUsedPrefs = {
    ...restAgent,
    ...(!hasMatchingModel && existing.model ? { model: existing.model } : {}),
    ...(nextReasoningByModel ? { reasoningByModel: nextReasoningByModel } : {})
  };

  const nextByAgent = { ...prefs.byAgent };
  if (nextEntry.model || nextEntry.reasoningEffort || nextEntry.reasoningByModel) {
    nextByAgent[cleanAgentId] = nextEntry;
  } else {
    delete nextByAgent[cleanAgentId];
  }
  return { ...prefs, byAgent: nextByAgent };
}

/** 当某模型的远端思考深度目录明确证实该模型专存的旧值已失效时，只清掉该模型的过期思考深度。 */
export function withoutStaleAgentReasoning(
  prefs: DraftComposerPrefs,
  agentId: string,
  staleEffort: string,
  model?: string
): DraftComposerPrefs {
  const cleanAgentId = nonEmptyString(agentId);
  const cleanEffort = nonEmptyString(staleEffort);
  const cleanModel = nonEmptyString(model);
  if (!cleanAgentId || !cleanEffort) return prefs;
  const existing = prefs.byAgent[cleanAgentId];
  if (!existing) return prefs;

  let changed = false;
  let nextReasoningEffort = existing.reasoningEffort;
  let nextReasoningByModel = existing.reasoningByModel ? { ...existing.reasoningByModel } : undefined;

  if (cleanModel && nextReasoningByModel && nextReasoningByModel[cleanModel] === cleanEffort) {
    delete nextReasoningByModel[cleanModel];
    if (Object.keys(nextReasoningByModel).length === 0) nextReasoningByModel = undefined;
    changed = true;
  }
  // 只有在没有具体模型键（或该 Agent 自己就停在这个模型）时才清掉 Agent 级兜底思考深度，避免误伤其他模型。
  if ((!cleanModel || existing.model === cleanModel || !existing.model) && nextReasoningEffort === cleanEffort) {
    nextReasoningEffort = undefined;
    changed = true;
  }

  if (!changed) return prefs;

  const nextEntry: AgentLastUsedPrefs = {
    ...(existing.model ? { model: existing.model } : {}),
    ...(nextReasoningEffort ? { reasoningEffort: nextReasoningEffort } : {}),
    ...(nextReasoningByModel ? { reasoningByModel: nextReasoningByModel } : {})
  };
  const nextByAgent = { ...prefs.byAgent };
  if (nextEntry.model || nextEntry.reasoningEffort || nextEntry.reasoningByModel) {
    nextByAgent[cleanAgentId] = nextEntry;
  } else {
    delete nextByAgent[cleanAgentId];
  }
  return { ...prefs, byAgent: nextByAgent };
}

export function getPreferredAgentModel(prefs: DraftComposerPrefs, agentId: string): string {
  if (!agentId) return '';
  return prefs.byAgent[agentId]?.model ?? '';
}

export function getPreferredAgentReasoningEffort(
  prefs: DraftComposerPrefs,
  agentId: string,
  model?: string
): string {
  if (!agentId) return '';
  const entry = prefs.byAgent[agentId];
  if (!entry) return '';
  const cleanModel = nonEmptyString(model);
  if (cleanModel && entry.reasoningByModel?.[cleanModel]) {
    return entry.reasoningByModel[cleanModel]!;
  }
  return entry.reasoningEffort ?? '';
}

/**
 * 渲染期解析有效 Agent：
 * 1. 上次记住的 Agent 若仍在可用列表中，优先恢复；
 * 2. 否则回退到最近活跃会话的可用 Agent；
 * 3. 再退到可用列表第一个。
 */
export function resolveEffectiveAgentId(
  preferredAgentId: string | undefined,
  agents: ReadonlyArray<Pick<Agent, 'id' | 'disabled'>>,
  sessions: ReadonlyArray<Pick<Session, 'agentId' | 'archivedAt'>>
): string {
  const usable = agents.filter(agent => !agent.disabled);
  if (!usable.length) return '';
  const usableIds = new Set(usable.map(agent => agent.id));
  if (preferredAgentId && usableIds.has(preferredAgentId)) return preferredAgentId;
  const recentSessionAgent = sessions.find(session => !session.archivedAt && usableIds.has(session.agentId))?.agentId;
  return recentSessionAgent || usable[0]?.id || '';
}

/**
 * 渲染期解析有效工作目录：
 * - 若服务端已明确回报该目录不存在（projects 中 exists === false），优雅回退为空串（使用 Agent 默认目录）；
 * - 若目录是用户刚通过选择器/输入挑的新路径（尚未登记在 projects 中），正常保留。
 */
export function resolveEffectiveWorkspace(
  preferredCwd: string | undefined,
  projects?: ReadonlyArray<Pick<Project, 'cwd' | 'exists'>>
): string {
  const clean = nonEmptyString(preferredCwd);
  if (!clean) return '';
  if (projects?.length) {
    const normalized = normalizeWorkspacePath(clean);
    const matched = projects.find(project => normalizeWorkspacePath(project.cwd) === normalized);
    if (matched && !matched.exists) return '';
  }
  return clean;
}

/** 构建工作目录下拉候选项：当前有效目录 + Agent 默认目录 + 存在的已登记项目 + 历史会话目录（去重并过滤已确认失效目录）。 */
export function buildWorkspaceOptions(input: {
  currentWorkspace?: string;
  defaultWorkspace?: string;
  projects?: ReadonlyArray<Pick<Project, 'cwd' | 'exists'>>;
  sessions: ReadonlyArray<Pick<Session, 'cwd'>>;
  limit?: number;
}): string[] {
  const missing = new Set(
    (input.projects ?? [])
      .filter(project => !project.exists)
      .map(project => normalizeWorkspacePath(project.cwd))
      .filter(Boolean)
  );
  const existingProjects = (input.projects ?? [])
    .filter(project => project.exists)
    .map(project => project.cwd);

  const seen = new Set<string>();
  const list: string[] = [];
  const candidates = [
    input.currentWorkspace,
    input.defaultWorkspace,
    ...existingProjects,
    ...input.sessions.map(session => session.cwd)
  ];
  for (const rawPath of candidates) {
    const clean = nonEmptyString(rawPath);
    if (!clean) continue;
    const normalized = normalizeWorkspacePath(clean);
    if (!normalized || seen.has(normalized)) continue;
    if (missing.has(normalized) && normalized !== normalizeWorkspacePath(input.defaultWorkspace ?? '')) continue;
    seen.add(normalized);
    list.push(clean);
  }
  return list.slice(0, input.limit ?? 30);
}

/**
 * 渲染期解析有效模型：
 * - 目录尚未加载或处于跨模型 placeholder 阶段时保留已记住的值；
 * - 目录加载出非空模型列表且不包含该模型时，优雅回退为空串（由调用方展示 Agent 默认模型）。
 */
export function resolveEffectiveModel(
  preferredModel: string | undefined,
  catalog: AgentModelsResult | undefined,
  options: { isPlaceholderData?: boolean } = {}
): string {
  const clean = nonEmptyString(preferredModel);
  if (!clean) return '';
  if (!catalog || options.isPlaceholderData) return clean;
  if (catalog.models.length === 0) return clean;
  return catalog.models.some(item => item.id === clean) ? clean : '';
}

/**
 * 渲染期解析有效思考深度：
 * - 目录尚未加载、处于 placeholder 阶段或等待精确模型目录刷新时保留已记住的值；
 * - 精确目录加载完成后：
 *   - 若有可选列表且不包含已选值 → 回退为空串（展示该模型默认思考深度）；
 *   - 若无告警的 ACP 目录明确返回空列表（当前模型不支持思考深度）→ 回退为空串，不传过期值。
 */
export function resolveEffectiveReasoningEffort(
  preferredReasoningEffort: string | undefined,
  catalog: AgentModelsResult | undefined,
  options: { isPlaceholderData?: boolean; awaitingExactCatalog?: boolean } = {}
): string {
  const clean = nonEmptyString(preferredReasoningEffort);
  if (!clean) return '';
  if (!catalog || options.isPlaceholderData || options.awaitingExactCatalog) return clean;
  if (catalog.reasoningEfforts.length > 0) {
    return catalog.reasoningEfforts.some(item => item.id === clean) ? clean : '';
  }
  if (!catalog.warning && catalog.source === 'acp') {
    return '';
  }
  return clean;
}

/**
 * 项目视图快捷新建会话（侧栏工作区/Agent 分组上的「+」）复用该 Agent 上次使用的模型与思考深度：
 * 仅在本地模型目录缓存能够验证其有效性时附带，防止已下线旧模型导致快捷创建失败。
 */
export function resolveQuickCreateSessionOptions(
  agentId: string,
  cwd: string,
  prefs: DraftComposerPrefs = readDraftComposerPrefs(),
  cachedModels?: AgentModelsResult
): { agentId: string; cwd: string; model?: string; reasoningEffort?: string } {
  const preferredModel = getPreferredAgentModel(prefs, agentId);
  const catalog = cachedModels ?? readInitialAgentModels(agentId, preferredModel || undefined);
  if (!catalog || catalog.warning) return { agentId, cwd };

  const model = preferredModel && catalog.models.some(item => item.id === preferredModel)
    ? preferredModel
    : undefined;
  const targetModelForReasoning = model ?? catalog.defaultModel;
  const preferredReasoning = getPreferredAgentReasoningEffort(prefs, agentId, targetModelForReasoning);
  const reasoningEffort = preferredReasoning && catalog.reasoningEfforts.some(item => item.id === preferredReasoning)
    ? preferredReasoning
    : undefined;

  return {
    agentId,
    cwd,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {})
  };
}
