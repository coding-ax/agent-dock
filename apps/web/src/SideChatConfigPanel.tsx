import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, MessagesSquare, RefreshCw, RotateCcw } from 'lucide-react';
import { Input, Segmented, Switch } from 'antd';
import { api, type SideChatConfig } from './api';
import { CompactSelect } from './CompactSelect';
import { Spinner } from './Loaders';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from './model-cache';
import { DEFAULT_SIDE_CHAT_CONFIG, DEFAULT_SIDE_CHAT_TRIGGER_PREFIX } from './side-chat-config';

const labelClass = 'text-[12px] font-medium text-zinc-700';
const hintClass = 'mt-1 text-[12px] leading-5 text-zinc-400';
const buttonSecondary = 'flex h-9 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 text-[12px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40';

/**
 * 侧边对话配置面板。
 *
 * 副屏「侧边聊天」入口、快捷键（⌘⇧S）与会话输入框里的 `/btw` 命令共用此配置。
 */
export function SideChatConfigPanel() {
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: ['side-chat-config'], queryFn: api.sideChatConfig, refetchOnWindowFocus: false });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api.agents(false), refetchOnWindowFocus: false });

  const [draft, setDraft] = useState<SideChatConfig>(DEFAULT_SIDE_CHAT_CONFIG);
  const [hydrated, setHydrated] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string }>();

  useEffect(() => {
    if (!state.data || hydrated) return;
    setDraft(state.data.config);
    setHydrated(true);
  }, [state.data, hydrated]);

  const availableAgents = useMemo(() => (agents.data ?? []).filter(agent => !agent.disabled), [agents.data]);
  const selectedAgentId = draft.targetMode === 'custom_agent' ? (draft.agentId || availableAgents[0]?.id || '') : '';

  const models = useQuery({
    queryKey: agentModelsQueryKey(selectedAgentId, draft.model),
    queryFn: () => loadAgentModels(selectedAgentId, draft.model, false),
    enabled: Boolean(selectedAgentId),
    initialData: () => selectedAgentId ? readCachedAgentModels(selectedAgentId, draft.model) : undefined,
    initialDataUpdatedAt: 0,
    staleTime: 60_000,
    refetchOnWindowFocus: false
  });

  const refreshModels = useMutation({
    mutationFn: () => loadAgentModels(selectedAgentId, draft.model, true),
    onSuccess: result => {
      queryClient.setQueryData(agentModelsQueryKey(selectedAgentId, draft.model), result);
    }
  });

  const patch = (partial: Partial<SideChatConfig>) => {
    setDraft(current => ({ ...current, ...partial }));
    setFeedback(undefined);
  };

  const normalizedTrigger = draft.triggerPrefix.trim() || DEFAULT_SIDE_CHAT_TRIGGER_PREFIX;
  const payload: SideChatConfig = draft.targetMode === 'custom_agent'
    ? {
        targetMode: 'custom_agent',
        agentId: selectedAgentId || undefined,
        model: draft.model?.trim() || undefined,
        reasoningEffort: draft.reasoningEffort?.trim() || undefined,
        openMode: draft.openMode,
        btwEnabled: draft.btwEnabled,
        triggerPrefix: normalizedTrigger,
        btwSessionReuse: draft.btwSessionReuse
      }
    : {
        targetMode: 'follow_current',
        openMode: draft.openMode,
        btwEnabled: draft.btwEnabled,
        triggerPrefix: normalizedTrigger,
        btwSessionReuse: draft.btwSessionReuse
      };

  const canSubmit = payload.targetMode === 'follow_current' || Boolean(payload.agentId);

  const save = useMutation({
    mutationFn: () => api.saveSideChatConfig(payload),
    onSuccess: result => {
      setDraft(result.config);
      queryClient.setQueryData(['side-chat-config'], result);
      setFeedback({ ok: true, message: '侧边对话配置已保存，副屏入口与 /btw 将立即复用此配置。' });
    },
    onError: error => setFeedback({ ok: false, message: error instanceof Error ? error.message : String(error) })
  });

  const reset = useMutation({
    mutationFn: () => api.resetSideChatConfig(),
    onSuccess: result => {
      setDraft(result.config);
      queryClient.setQueryData(['side-chat-config'], result);
      setFeedback({ ok: true, message: '已恢复为默认侧边对话配置。' });
    },
    onError: error => setFeedback({ ok: false, message: error instanceof Error ? error.message : String(error) })
  });

  const modelOptions = useMemo(() => {
    const items = (models.data?.models ?? []).map(item => ({
      value: item.id,
      label: item.name,
      ...(item.name !== item.id ? { meta: item.id } : {})
    }));
    if (draft.model && !items.some(item => item.value === draft.model)) {
      items.unshift({ value: draft.model, label: draft.model, meta: '当前配置' });
    }
    return [
      { value: '', label: models.data?.defaultModel ? `跟随 Agent 默认（${models.data.defaultModel}）` : '跟随 Agent 默认模型' },
      ...items
    ];
  }, [models.data?.models, models.data?.defaultModel, draft.model]);

  const reasoningOptions = useMemo(() => {
    const items = (models.data?.reasoningEfforts ?? []).map(item => ({ value: item.id, label: item.name }));
    if (draft.reasoningEffort && !items.some(item => item.value === draft.reasoningEffort)) {
      items.unshift({ value: draft.reasoningEffort, label: `${draft.reasoningEffort}（当前配置）` });
    }
    return [
      { value: '', label: models.data?.defaultReasoningEffort ? `跟随默认（${models.data.defaultReasoningEffort}）` : '跟随默认思考深度' },
      ...items
    ];
  }, [models.data?.reasoningEfforts, models.data?.defaultReasoningEffort, draft.reasoningEffort]);

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div className="mx-auto max-w-2xl space-y-5">
        <div className="rounded-xl border border-zinc-200 bg-zinc-50/70 px-4 py-3">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-zinc-900">
            <MessagesSquare size={15} className="text-zinc-600"/>
            <span>侧边对话与 /btw 共享配置</span>
          </div>
          <p className="mt-1 text-[12px] leading-5 text-zinc-500">
            配置打开侧边聊天时的默认 Agent、模型、思考深度和打开方式。默认情况下，在任意会话输入框里输入 <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-zinc-700 ring-1 ring-zinc-200">/btw &lt;问题&gt;</code> 会直接复用这里的侧边对话配置。
          </p>
        </div>

        {state.isLoading ? <div className="flex items-center gap-2 py-6 text-[12px] text-zinc-400"><Spinner size={13}/>正在读取配置…</div> : <>
          {/* 1. Agent 与模型策略 */}
          <section className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4">
            <div>
              <div className={labelClass}>侧边对话使用的 Agent</div>
              <p className={hintClass}>选择侧边对话是跟随当前主会话，还是固定由指定 Agent 承接。</p>
            </div>
            <Segmented
              value={draft.targetMode}
              onChange={value => {
                const nextMode = value as SideChatConfig['targetMode'];
                patch({
                  targetMode: nextMode,
                  ...(nextMode === 'custom_agent' && !draft.agentId && availableAgents[0] ? { agentId: availableAgents[0].id } : {})
                });
              }}
              options={[
                { value: 'follow_current', label: '跟随当前会话' },
                { value: 'custom_agent', label: '指定独立 Agent' }
              ]}
            />

            {draft.targetMode === 'follow_current' ? (
              <p className="rounded-lg bg-zinc-50 px-3 py-2 text-[12px] leading-5 text-zinc-500">
                新建侧边对话时，自动沿用当前会话的 Agent、工作目录、模型与思考深度。
              </p>
            ) : (
              <div className="space-y-3 pt-1">
                <div>
                  <label className={labelClass}>目标 Agent</label>
                  <CompactSelect
                    value={selectedAgentId}
                    onChange={nextAgentId => patch({ agentId: nextAgentId, model: undefined, reasoningEffort: undefined })}
                    options={availableAgents.map(agent => ({ value: agent.id, label: agent.name, agentId: agent.id }))}
                    placeholder="请选择 Agent"
                    disabledText="没有可用 Agent"
                  />
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <div className="flex items-center justify-between">
                      <label className={labelClass}>模型（可选）</label>
                      {selectedAgentId && (
                        <button
                          type="button"
                          disabled={refreshModels.isPending || models.isFetching}
                          onClick={() => refreshModels.mutate()}
                          className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-700 disabled:opacity-40"
                        >
                          <RefreshCw size={11} className={refreshModels.isPending || models.isFetching ? 'animate-spin' : ''}/>
                          刷新模型
                        </button>
                      )}
                    </div>
                    <CompactSelect
                      value={draft.model ?? ''}
                      onChange={value => patch({ model: value || undefined })}
                      options={modelOptions}
                      placeholder="跟随 Agent 默认模型"
                      disabledText="暂无可选模型"
                    />
                  </div>

                  <div>
                    <label className={labelClass}>思考深度（可选）</label>
                    <CompactSelect
                      value={draft.reasoningEffort ?? ''}
                      onChange={value => patch({ reasoningEffort: value || undefined })}
                      options={reasoningOptions}
                      placeholder="跟随默认思考深度"
                      disabledText="暂无可选深度"
                    />
                  </div>
                </div>
                <p className={hintClass}>工作目录仍自动跟随当前主会话，便于就地查看同一项目代码；若指定 Agent 后续被停用，会自动回退到当前会话的 Agent。</p>
              </div>
            )}
          </section>

          {/* 2. 打开方式 */}
          <section className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4">
            <div>
              <div className={labelClass}>打开方式</div>
              <p className={hintClass}>决定发起侧边对话后在界面上如何呈现。</p>
            </div>
            <Segmented
              value={draft.openMode}
              onChange={value => patch({ openMode: value as SideChatConfig['openMode'] })}
              options={[
                { value: 'side_pane', label: '右侧副屏并排打开' },
                { value: 'switch_session', label: '直接切换到侧边会话' }
              ]}
            />
          </section>

          {/* 3. 飞书机器人与网页端快捷触发 */}
          <section className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className={labelClass}>快捷触发侧边对话（飞书机器人 + 网页端共用）</div>
                <p className={hintClass}>
                  开启后，在飞书机器人中（如 <code className="font-mono text-zinc-600">@机器人 {normalizedTrigger} 你的问题</code>）或网页端输入框发送命中触发前缀的消息，将直接按上方配置开启侧边对话，不阻塞也不污染主会话。飞书端默认在原消息下以话题回复（<code className="font-mono text-zinc-600">reply_in_thread</code>），该话题内后续追问自动续聊同一侧边会话。
                </p>
              </div>
              <Switch
                aria-label="启用侧边对话快捷触发"
                checked={draft.btwEnabled}
                onChange={checked => patch({ btwEnabled: checked })}
              />
            </div>

            {draft.btwEnabled && (
              <div className="space-y-3 border-t border-zinc-100 pt-3">
                <div>
                  <div className="flex items-center justify-between">
                    <label className={labelClass}>触发前缀</label>
                    <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                      <span>常用：</span>
                      {['/btw', 'btw:'].map(preset => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => patch({ triggerPrefix: preset })}
                          className={`rounded border px-1.5 py-0.5 font-mono transition-colors ${draft.triggerPrefix.trim() === preset ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-200 bg-zinc-50 text-zinc-600 hover:border-zinc-300'}`}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  </div>
                  <Input
                    size="large"
                    className="mt-1.5 font-mono text-[12px]"
                    maxLength={32}
                    value={draft.triggerPrefix}
                    placeholder="默认 /btw，也可自定义如 btw:"
                    aria-label="侧边对话触发前缀"
                    onChange={event => patch({ triggerPrefix: event.target.value })}
                  />
                  <p className={hintClass}>留空时自动回退为 <code className="font-mono text-zinc-600">/btw</code>；大小写不敏感。</p>
                </div>

                <div>
                  <div className={labelClass}>网页端触发时的会话复用方式</div>
                  <div className="mt-2">
                    <Segmented
                      value={draft.btwSessionReuse}
                      onChange={value => patch({ btwSessionReuse: value as SideChatConfig['btwSessionReuse'] })}
                      options={[
                        { value: 'new_session', label: '每次新建侧边会话' },
                        { value: 'reuse_latest', label: '优先复用最近侧边会话' }
                      ]}
                    />
                  </div>
                  <p className={hintClass}>
                    {draft.btwSessionReuse === 'reuse_latest'
                      ? '若当前主会话已有活跃的侧边会话（优先副屏已打开的标签），网页端触发会直接续聊；飞书端始终按话题独立绑定。'
                      : '每次触发都会新建一个干净的独立侧边会话，适合互不干扰的旁枝提问。'}
                  </p>
                </div>
              </div>
            )}
          </section>

          {feedback && (
            <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[12px] leading-5 ${feedback.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>
              {feedback.ok ? <Check size={13} className="mt-0.5 shrink-0"/> : <AlertTriangle size={13} className="mt-0.5 shrink-0"/>}
              <span>{feedback.message}</span>
            </div>
          )}
        </>}
      </div>
    </div>

    <div className="sticky bottom-0 flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-t border-zinc-100 bg-white px-5 py-2">
      <button
        type="button"
        disabled={reset.isPending || save.isPending}
        onClick={() => reset.mutate()}
        className={buttonSecondary}
      >
        {reset.isPending ? <Spinner size={13}/> : <RotateCcw size={13}/>}
        恢复默认
      </button>
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          disabled={!canSubmit || save.isPending}
          onClick={() => save.mutate()}
          className="flex h-9 items-center gap-1.5 rounded-md bg-zinc-900 px-4 text-[12px] font-medium text-white hover:bg-zinc-800 disabled:opacity-40"
        >
          {save.isPending && <Spinner size={13}/>}
          保存配置
        </button>
      </div>
    </div>
  </div>;
}
