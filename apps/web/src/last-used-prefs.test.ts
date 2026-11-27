import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ComposerEditor', () => ({
  ComposerEditor: () => createElement('div', { 'data-testid': 'mock-composer-editor' })
}));
vi.mock('./AiTextAssist', () => ({
  AiTextAssistControl: () => null,
  AiUndoCapsule: () => null,
  useAiFlash: () => ({ flashClass: '', triggerFlash: () => undefined })
}));
vi.mock('./PromptTemplates', () => ({
  PromptTemplates: () => null
}));

import type { Agent, AgentModelsResult, Project, Session } from './api';
import { DraftComposer } from './DraftComposer';
import { TooltipProvider } from './HoverTooltip';
import { agentModelsQueryKey, writeCachedAgentModels } from './model-cache';
import {
  buildWorkspaceOptions,
  DRAFT_COMPOSER_PREFS_STORAGE_KEY,
  EMPTY_DRAFT_COMPOSER_PREFS,
  getPreferredAgentModel,
  getPreferredAgentReasoningEffort,
  normalizeDraftComposerPrefs,
  readDraftComposerPrefs,
  resolveEffectiveAgentId,
  resolveEffectiveModel,
  resolveEffectiveReasoningEffort,
  resolveEffectiveWorkspace,
  resolveQuickCreateSessionOptions,
  withConfirmedDraftSubmission,
  withLastUsedAgent,
  withLastUsedModel,
  withLastUsedReasoningEffort,
  withLastUsedWorkspace,
  withoutStaleAgentModel,
  withoutStaleAgentReasoning,
  writeDraftComposerPrefs,
  type PrefsStorage
} from './last-used-prefs';

function createMemoryStorage(): PrefsStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: key => { data.delete(key); }
  };
}

function makeAgent(id: string, name: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name,
    command: id,
    args: [],
    protocol: 'acp',
    env: {},
    permissionMode: 'full-trust',
    timeout: 600,
    capabilities: { pause: false, resume: true },
    builtin: true,
    ...overrides
  };
}

function makeSession(id: string, agentId: string, cwd: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    agentId,
    state: 'idle',
    cwd,
    runId: `run_${id}`,
    createdAt: '2026-11-27T01:00:00.000Z',
    updatedAt: '2026-11-27T01:00:00.000Z',
    ...overrides
  };
}

function makeProject(cwd: string, exists: boolean): Project {
  return {
    id: `proj_${cwd}`,
    name: cwd.split('/').pop() || cwd,
    cwd,
    exists,
    createdAt: '2026-11-27T01:00:00.000Z',
    updatedAt: '2026-11-27T01:00:00.000Z'
  };
}

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

describe('last-used-prefs storage and normalization', () => {
  it('round-trips agent, workspace, per-agent model and per-model reasoning effort', () => {
    const storage = createMemoryStorage();
    let prefs = readDraftComposerPrefs(storage);
    expect(prefs).toEqual(EMPTY_DRAFT_COMPOSER_PREFS);

    prefs = withLastUsedAgent(prefs, 'codex');
    prefs = withLastUsedWorkspace(prefs, '/Users/dev/workspace/agent-dock', 'codex');
    prefs = withLastUsedModel(prefs, 'codex', 'ferry-gpt-6.1-sol-max');
    prefs = withLastUsedReasoningEffort(prefs, 'codex', 'xhigh', 'ferry-gpt-6.1-sol-max');
    writeDraftComposerPrefs(prefs, storage);

    const restored = readDraftComposerPrefs(storage);
    expect(restored).toEqual({
      version: 1,
      agentId: 'codex',
      cwd: '/Users/dev/workspace/agent-dock',
      byAgent: {
        codex: {
          model: 'ferry-gpt-6.1-sol-max',
          reasoningEffort: 'xhigh',
          reasoningByModel: {
            'ferry-gpt-6.1-sol-max': 'xhigh'
          }
        }
      }
    });
  });

  it('clears saved workspace when user explicitly switches back to Agent default directory', () => {
    const storage = createMemoryStorage();
    let prefs = withLastUsedWorkspace(EMPTY_DRAFT_COMPOSER_PREFS, '/Users/dev/project-a', 'codex');
    writeDraftComposerPrefs(prefs, storage);
    expect(readDraftComposerPrefs(storage).cwd).toBe('/Users/dev/project-a');

    prefs = withLastUsedWorkspace(readDraftComposerPrefs(storage), '', 'codex');
    writeDraftComposerPrefs(prefs, storage);
    expect(readDraftComposerPrefs(storage).cwd).toBeUndefined();
    expect(readDraftComposerPrefs(storage).agentId).toBe('codex');
  });

  it('safely degrades on corrupted JSON, unexpected types, prototype pollution keys, and storage errors', () => {
    const storage = createMemoryStorage();
    storage.setItem(DRAFT_COMPOSER_PREFS_STORAGE_KEY, '{broken-json');
    expect(readDraftComposerPrefs(storage)).toEqual(EMPTY_DRAFT_COMPOSER_PREFS);

    storage.setItem(DRAFT_COMPOSER_PREFS_STORAGE_KEY, JSON.stringify(['not', 'an', 'object']));
    expect(readDraftComposerPrefs(storage)).toEqual(EMPTY_DRAFT_COMPOSER_PREFS);

    const polluted = normalizeDraftComposerPrefs(JSON.parse(
      '{"agentId":"  codex  ","cwd":"  ","byAgent":{"__proto__":{"model":"evil"},"codex":{"model":"gpt-6.1","reasoningByModel":{"constructor":"bad","gpt-6.1":"xhigh"}}}}'
    ));
    expect(polluted).toEqual({
      version: 1,
      agentId: 'codex',
      byAgent: {
        codex: {
          model: 'gpt-6.1',
          reasoningByModel: { 'gpt-6.1': 'xhigh' }
        }
      }
    });
    expect(Object.prototype.hasOwnProperty.call(polluted.byAgent, '__proto__')).toBe(false);

    const failingStorage: PrefsStorage = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); }
    };
    expect(readDraftComposerPrefs(failingStorage)).toEqual(EMPTY_DRAFT_COMPOSER_PREFS);
    expect(() => writeDraftComposerPrefs(polluted, failingStorage)).not.toThrow();
  });
});

describe('multi-agent and multi-model isolation', () => {
  it('remembers separate model and reasoning effort per Agent without cross-contamination', () => {
    let prefs = EMPTY_DRAFT_COMPOSER_PREFS;
    prefs = withLastUsedAgent(prefs, 'codex');
    prefs = withLastUsedModel(prefs, 'codex', 'gpt-6.1');
    prefs = withLastUsedReasoningEffort(prefs, 'codex', 'xhigh', 'gpt-6.1');

    prefs = withLastUsedAgent(prefs, 'claude');
    prefs = withLastUsedModel(prefs, 'claude', 'claude-opus-4-5');
    prefs = withLastUsedReasoningEffort(prefs, 'claude', 'high', 'claude-opus-4-5');

    // 切回 Codex 时应完整恢复 Codex 自己的模型与思考深度，不被 Claude 踩脏。
    prefs = withLastUsedAgent(prefs, 'codex');
    expect(prefs.agentId).toBe('codex');
    expect(getPreferredAgentModel(prefs, 'codex')).toBe('gpt-6.1');
    expect(getPreferredAgentReasoningEffort(prefs, 'codex', 'gpt-6.1')).toBe('xhigh');

    // 再切回 Claude 同样完整保留。
    prefs = withLastUsedAgent(prefs, 'claude');
    expect(getPreferredAgentModel(prefs, 'claude')).toBe('claude-opus-4-5');
    expect(getPreferredAgentReasoningEffort(prefs, 'claude', 'claude-opus-4-5')).toBe('high');
  });

  it('tracks reasoning effort per model within the same Agent and restores on switch-back', () => {
    let prefs = EMPTY_DRAFT_COMPOSER_PREFS;
    prefs = withLastUsedModel(prefs, 'codex', 'gpt-6.1');
    prefs = withLastUsedReasoningEffort(prefs, 'codex', 'xhigh', 'gpt-6.1');

    prefs = withLastUsedModel(prefs, 'codex', 'gpt-5-mini');
    prefs = withLastUsedReasoningEffort(prefs, 'codex', 'low', 'gpt-5-mini');

    expect(getPreferredAgentReasoningEffort(prefs, 'codex', 'gpt-5-mini')).toBe('low');
    expect(getPreferredAgentReasoningEffort(prefs, 'codex', 'gpt-6.1')).toBe('xhigh');

    // 若切到一个只支持 low/medium 的新模型，按 stale cleanup 清理该模型不会破坏 gpt-6.1 已保存的 xhigh。
    prefs = withLastUsedModel(prefs, 'codex', 'gpt-5-nano');
    prefs = withoutStaleAgentReasoning(prefs, 'codex', 'low', 'gpt-5-nano');
    expect(getPreferredAgentReasoningEffort(prefs, 'codex', 'gpt-6.1')).toBe('xhigh');
  });

  it('confirms submission without freezing unset Agent defaults as permanent overrides', () => {
    const confirmedDefault = withConfirmedDraftSubmission(EMPTY_DRAFT_COMPOSER_PREFS, {
      agentId: 'codex',
      cwd: '',
      model: '',
      reasoningEffort: ''
    });
    expect(confirmedDefault).toEqual({
      version: 1,
      agentId: 'codex',
      byAgent: {}
    });

    const confirmedExplicit = withConfirmedDraftSubmission(confirmedDefault, {
      agentId: 'codex',
      cwd: '/Users/dev/repo',
      model: 'gpt-6.1',
      reasoningEffort: 'xhigh'
    });
    expect(confirmedExplicit).toEqual({
      version: 1,
      agentId: 'codex',
      cwd: '/Users/dev/repo',
      byAgent: {
        codex: {
          model: 'gpt-6.1',
          reasoningEffort: 'xhigh',
          reasoningByModel: { 'gpt-6.1': 'xhigh' }
        }
      }
    });
  });
});

describe('stale / deleted configuration graceful fallback', () => {
  it('falls back to active session agent or first enabled agent when saved Agent is deleted or disabled', () => {
    const agents = [
      makeAgent('claude', 'Claude'),
      makeAgent('codex', 'Codex'),
      makeAgent('gemini', 'Gemini', { disabled: true })
    ];
    const sessions = [makeSession('ses_1', 'codex', '/Users/dev/repo')];

    expect(resolveEffectiveAgentId('claude', agents, sessions)).toBe('claude');
    expect(resolveEffectiveAgentId('deleted-agent', agents, sessions)).toBe('codex');
    expect(resolveEffectiveAgentId('gemini', agents, sessions)).toBe('codex');
    expect(resolveEffectiveAgentId('deleted-agent', agents, [])).toBe('claude');
    expect(resolveEffectiveAgentId('codex', [], sessions)).toBe('');
  });

  it('falls back to Agent default workspace when saved directory is reported missing by projects API', () => {
    const projects = [
      makeProject('/Users/dev/alive-repo', true),
      makeProject('/Users/dev/deleted-repo', false)
    ];

    expect(resolveEffectiveWorkspace('/Users/dev/alive-repo', projects)).toBe('/Users/dev/alive-repo');
    expect(resolveEffectiveWorkspace('/Users/dev/deleted-repo', projects)).toBe('');
    // 末尾斜杠差异同样能识别到目录已失效。
    expect(resolveEffectiveWorkspace('/Users/dev/deleted-repo/', projects)).toBe('');
    // 新挑选、尚未建会话登记到 projects 的目录应保留，不能误清空。
    expect(resolveEffectiveWorkspace('/Users/dev/brand-new-folder', projects)).toBe('/Users/dev/brand-new-folder');
  });

  it('builds deduplicated workspace options excluding confirmed missing directories', () => {
    const options = buildWorkspaceOptions({
      currentWorkspace: '/Users/dev/brand-new-folder',
      defaultWorkspace: '/Users/dev/default-dir',
      projects: [
        makeProject('/Users/dev/alive-repo', true),
        makeProject('/Users/dev/deleted-repo', false)
      ],
      sessions: [
        makeSession('ses_1', 'codex', '/Users/dev/deleted-repo'),
        makeSession('ses_2', 'codex', '/Users/dev/alive-repo/')
      ]
    });

    expect(options).toEqual([
      '/Users/dev/brand-new-folder',
      '/Users/dev/default-dir',
      '/Users/dev/alive-repo'
    ]);
  });

  it('falls back to default model when saved model is removed, and prunes only the stale model', () => {
    const catalog: AgentModelsResult = {
      models: [
        { id: 'gpt-5.4', name: 'GPT-5.4' },
        { id: 'gpt-6.1', name: 'GPT-6.1' }
      ],
      defaultModel: 'gpt-5.4',
      reasoningEfforts: [
        { id: 'medium', name: 'medium' },
        { id: 'high', name: 'high' }
      ],
      defaultReasoningEffort: 'medium',
      source: 'acp'
    };

    expect(resolveEffectiveModel('gpt-6.1', catalog)).toBe('gpt-6.1');
    expect(resolveEffectiveModel('retired-model', catalog)).toBe('');
    // 加载中或 placeholder 阶段保持记忆值，不闪回默认。
    expect(resolveEffectiveModel('retired-model', undefined)).toBe('retired-model');
    expect(resolveEffectiveModel('retired-model', catalog, { isPlaceholderData: true })).toBe('retired-model');

    let prefs = withLastUsedModel(EMPTY_DRAFT_COMPOSER_PREFS, 'codex', 'retired-model');
    prefs = withLastUsedReasoningEffort(prefs, 'codex', 'xhigh', 'retired-model');
    prefs = withLastUsedModel(prefs, 'claude', 'claude-opus-4-5');
    const cleaned = withoutStaleAgentModel(prefs, 'codex', 'retired-model');

    expect(getPreferredAgentModel(cleaned, 'codex')).toBe('');
    expect(cleaned.byAgent.codex?.reasoningByModel?.['retired-model']).toBeUndefined();
    expect(getPreferredAgentModel(cleaned, 'claude')).toBe('claude-opus-4-5');
  });

  it('falls back to default reasoning effort when saved value is unsupported or model offers no reasoning options', () => {
    const catalogWithEfforts: AgentModelsResult = {
      models: [{ id: 'gpt-5-mini', name: 'GPT-5 Mini' }],
      defaultModel: 'gpt-5-mini',
      reasoningEfforts: [
        { id: 'low', name: 'low' },
        { id: 'medium', name: 'medium' }
      ],
      defaultReasoningEffort: 'medium',
      source: 'acp'
    };
    const catalogWithoutEfforts: AgentModelsResult = {
      models: [{ id: 'fast-model', name: 'Fast' }],
      defaultModel: 'fast-model',
      reasoningEfforts: [],
      source: 'acp'
    };
    const warningCatalog: AgentModelsResult = {
      models: [],
      reasoningEfforts: [],
      source: 'agent',
      warning: '读取超时'
    };

    expect(resolveEffectiveReasoningEffort('low', catalogWithEfforts)).toBe('low');
    expect(resolveEffectiveReasoningEffort('xhigh', catalogWithEfforts)).toBe('');
    expect(resolveEffectiveReasoningEffort('xhigh', catalogWithoutEfforts)).toBe('');
    // 探测占位或临时降级告警时保留原选择，不误删用户偏好。
    expect(resolveEffectiveReasoningEffort('xhigh', catalogWithEfforts, { isPlaceholderData: true })).toBe('xhigh');
    expect(resolveEffectiveReasoningEffort('xhigh', catalogWithEfforts, { awaitingExactCatalog: true })).toBe('xhigh');
    expect(resolveEffectiveReasoningEffort('xhigh', warningCatalog)).toBe('xhigh');
  });

  it('only attaches validated cached model/reasoning for sidebar quickCreate', () => {
    const storage = createMemoryStorage();
    let prefs = withLastUsedModel(EMPTY_DRAFT_COMPOSER_PREFS, 'codex', 'gpt-6.1');
    prefs = withLastUsedReasoningEffort(prefs, 'codex', 'xhigh', 'gpt-6.1');

    const validCatalog: AgentModelsResult = {
      models: [{ id: 'gpt-6.1', name: 'GPT-6.1' }],
      defaultModel: 'gpt-6.1',
      reasoningEfforts: [{ id: 'high', name: 'high' }, { id: 'xhigh', name: 'xhigh' }],
      defaultReasoningEffort: 'high',
      source: 'acp'
    };
    expect(resolveQuickCreateSessionOptions('codex', '/Users/dev/repo', prefs, validCatalog)).toEqual({
      agentId: 'codex',
      cwd: '/Users/dev/repo',
      model: 'gpt-6.1',
      reasoningEffort: 'xhigh'
    });

    const staleCatalog: AgentModelsResult = {
      models: [{ id: 'gpt-5', name: 'GPT-5' }],
      defaultModel: 'gpt-5',
      reasoningEfforts: [{ id: 'medium', name: 'medium' }],
      defaultReasoningEffort: 'medium',
      source: 'acp'
    };
    expect(resolveQuickCreateSessionOptions('codex', '/Users/dev/repo', prefs, staleCatalog)).toEqual({
      agentId: 'codex',
      cwd: '/Users/dev/repo'
    });

    // 无本地缓存时不冒险附带未验证的 model。
    expect(resolveQuickCreateSessionOptions('unknown-agent', '/Users/dev/repo', prefs, undefined)).toEqual({
      agentId: 'unknown-agent',
      cwd: '/Users/dev/repo'
    });
    expect(storage.data.size).toBe(0);
  });
});

describe('DraftComposer SSR hydration and fallback rendering', () => {
  function renderDraftComposerWithStorage(options: {
    storage: PrefsStorage;
    agents: Agent[];
    sessions?: Session[];
    projects?: Project[];
    modelCatalogs?: Array<{ agentId: string; model?: string; result: AgentModelsResult }>;
  }) {
    (globalThis as { window?: unknown }).window = {
      localStorage: options.storage,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      clearTimeout: () => undefined
    };

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['system-capabilities'], {
      workingDirectory: '/Users/dev/default-workspace',
      homeDirectory: '/Users/dev',
      directoryPicker: false
    });
    if (options.projects) {
      qc.setQueryData(['projects'], options.projects);
    }
    for (const entry of options.modelCatalogs ?? []) {
      writeCachedAgentModels(entry.agentId, entry.model, entry.result, options.storage);
      qc.setQueryData(agentModelsQueryKey(entry.agentId, entry.model), entry.result);
    }

    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          TooltipProvider,
          null,
          createElement(DraftComposer, {
            agents: options.agents,
            sessions: options.sessions ?? [],
            onCreated: () => undefined
          })
        )
      )
    );
  }

  it('restores last-used Agent, workspace, model, and reasoning effort immediately on remount', () => {
    const storage = createMemoryStorage();
    let prefs = withLastUsedAgent(EMPTY_DRAFT_COMPOSER_PREFS, 'codex');
    prefs = withLastUsedWorkspace(prefs, '/Users/dev/workspace/agent-dock', 'codex');
    prefs = withLastUsedModel(prefs, 'codex', 'ferry-gpt-6.1');
    prefs = withLastUsedReasoningEffort(prefs, 'codex', 'xhigh', 'ferry-gpt-6.1');
    writeDraftComposerPrefs(prefs, storage);

    const html = renderDraftComposerWithStorage({
      storage,
      agents: [
        makeAgent('claude', 'Claude', { cwd: '/Users/dev/claude-default' }),
        makeAgent('codex', 'Codex', { cwd: '/Users/dev/codex-default' })
      ],
      sessions: [makeSession('ses_recent', 'claude', '/Users/dev/other-project')],
      projects: [makeProject('/Users/dev/workspace/agent-dock', true)],
      modelCatalogs: [
        {
          agentId: 'codex',
          model: 'ferry-gpt-6.1',
          result: {
            models: [
              { id: 'gpt-5', name: 'GPT-5' },
              { id: 'ferry-gpt-6.1', name: 'Ferry GPT-6.1-Sol Max 1M' }
            ],
            defaultModel: 'gpt-5',
            reasoningEfforts: [
              { id: 'medium', name: 'medium' },
              { id: 'xhigh', name: 'xhigh' }
            ],
            defaultReasoningEffort: 'medium',
            source: 'acp'
          }
        }
      ]
    });

    expect(html).toContain('>Codex<');
    expect(html).toContain('>agent-dock<');
    expect(html).toContain('Ferry GPT-6.1-Sol Max 1M');
    expect(html).toContain('>xhigh<');
    expect(html).not.toContain('codex-default');
  });

  it('gracefully falls back when saved Agent, workspace, model, and reasoning effort are all stale', () => {
    const storage = createMemoryStorage();
    writeDraftComposerPrefs({
      version: 1,
      agentId: 'removed-agent',
      cwd: '/Users/dev/deleted-workspace',
      byAgent: {
        'removed-agent': { model: 'dead-model', reasoningEffort: 'dead-effort' },
        claude: {
          model: 'retired-claude-model',
          reasoningEffort: 'removed-effort',
          reasoningByModel: { 'retired-claude-model': 'removed-effort' }
        }
      }
    }, storage);

    const html = renderDraftComposerWithStorage({
      storage,
      agents: [makeAgent('claude', 'Claude', { cwd: '/Users/dev/healthy-workspace' })],
      projects: [makeProject('/Users/dev/deleted-workspace', false)],
      modelCatalogs: [
        {
          agentId: 'claude',
          model: 'retired-claude-model',
          result: {
            models: [{ id: 'claude-sonnet-4-5', name: 'Sonnet 4.5' }],
            defaultModel: 'claude-sonnet-4-5',
            reasoningEfforts: [{ id: 'high', name: '高' }],
            defaultReasoningEffort: 'high',
            source: 'acp'
          }
        }
      ]
    });

    expect(html).toContain('>Claude<');
    expect(html).toContain('>healthy-workspace<');
    expect(html).toContain('Sonnet 4.5');
    expect(html).toContain('>高<');
    expect(html).not.toContain('deleted-workspace');
    expect(html).not.toContain('retired-claude-model');
    expect(html).not.toContain('removed-effort');
  });
});
