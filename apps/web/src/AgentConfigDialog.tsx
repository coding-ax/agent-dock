import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, LoaderCircle, Plug, Plus, RefreshCw, X } from 'lucide-react';
import { Input, Segmented } from 'antd';
import { api, type Agent } from './api';
import { ConfirmDialog } from './ui-controls';
import { useModalFocusTrap } from './useModalFocusTrap';
import { agentToDraft, canSave, draftToPayload, newAgentDraft, uniqueAgentId, validateDraft, type AgentFormDraft, type FormError } from './agent-config-form';
import { LlmEndpointPanel } from './LlmEndpointPanel';
import { AgentIcon } from './AgentIcon';
import { AgentUsagePanel } from './AgentUsagePanel';

const labelClass = 'text-[11px] font-medium text-zinc-700';

function FieldError({ message }: { message?: string }) {
  return message ? <p className="mt-1 text-[10px] leading-4 text-red-600">{message}</p> : null;
}

/** 只读展示一行：内置 Agent 的参数是扫描出来的，不给编辑，所以按读的方式呈现。 */
function ReadOnlyField({ label, value, mono = false, hint }: { label: string; value?: string; mono?: boolean; hint?: string }) {
  return <div>
    <span className={labelClass}>{label}</span>
    <div className={`mt-1 flex h-9 items-center rounded-md border border-zinc-200 bg-zinc-50 px-2.5 text-[12px] ${mono ? 'font-mono' : ''} ${value ? 'text-zinc-700' : 'text-zinc-400'}`}>
      <span className="min-w-0 flex-1 truncate" title={value}>{value || hint || '—'}</span>
    </div>
  </div>;
}

type SettingsTab = 'llm' | 'agents';

export function AgentConfigDialog({ onClose }: { onClose(): void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap({ panel: panelRef, initial: panelRef, dismissible: true, onDismiss: () => requestClose() });
  const queryClient = useQueryClient();
  // 配置面板需要看到停用的内置项（置灰）：仅 master token 生效，会话令牌拿到的仍是过滤后列表。
  const agents = useQuery({ queryKey: ['agents-admin'], queryFn: () => api.agents(true), refetchOnWindowFocus: false });
  // 模型端点是平台拿模型能力的唯一来源，默认落在这一页：它是先要配好的那一半。
  const [tab, setTab] = useState<SettingsTab>('llm');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [draft, setDraft] = useState<AgentFormDraft>(newAgentDraft());
  const [dirty, setDirty] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [probeResult, setProbeResult] = useState<string>();
  const [probeOk, setProbeOk] = useState(false);

  const sorted = useMemo(() => {
    const list = agents.data ?? [];
    return [...list].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
  }, [agents.data]);
  const selected: Agent | undefined = selectedId ? sorted.find(agent => agent.id === selectedId) : undefined;
  // 内置 Agent 的参数由扫描得出（command / args 来自 acpx 注册表，version 来自 --version，
  // 协议由 probeAgent 在启动时算），用户改它们只会在下次启动被 mergeDiscoveredAgent 覆盖，
  // 或者更糟——把 args 里的启动入口改成空数组。所以内置一律只读，只留启用/停用。
  const readOnly = Boolean(selected?.builtin) && !isNew;

  // 水合：切换选中 agent 时从远端行重建草稿；新建态用空模板。
  useEffect(() => {
    if (isNew) { setDraft(newAgentDraft()); setDirty(false); return; }
    if (selected) { setDraft(agentToDraft(selected)); setDirty(false); }
  }, [isNew, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const errors = useMemo(() => dirty ? validateDraft(draft) : [], [draft, dirty]);
  const errorByField = useMemo(() => new Map<FormError['field'], string>(errors.map(error => [error.field, error.message])), [errors]);
  const valid = canSave(draft);

  const patch = (partial: Partial<AgentFormDraft>) => { setDraft(current => ({ ...current, ...partial })); setDirty(true); setProbeResult(undefined); };

  // 新建时 id 从名称派生；撞上已有 id 就加后缀，不静默顶掉同名的另一个自定义 Agent。
  const resolveNewId = () => uniqueAgentId(draft.name, (agents.data ?? []).map(agent => agent.id));

  const save = useMutation({
    mutationFn: async () => isNew
      ? api.createAgent({ id: resolveNewId(), ...draftToPayload(draft) })
      : api.updateAgent(selected!.id, draftToPayload(draft)),
    onSuccess: agent => {
      setDirty(false);
      setIsNew(false);
      setSelectedId(agent.id);
      void queryClient.invalidateQueries({ queryKey: ['agents-admin'] });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
    }
  });
  const remove = useMutation({
    mutationFn: async () => api.deleteAgent(selected!.id),
    onSuccess: () => {
      setDirty(false);
      setIsNew(false);
      setSelectedId(null);
      setDeleteConfirm(false);
      void queryClient.invalidateQueries({ queryKey: ['agents-admin'] });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
    }
  });
  const probe = useMutation({
    mutationFn: async () => {
      // 先落盘再探测，模型发现接口读的是库内配置。
      const saved = isNew ? await api.createAgent({ id: resolveNewId(), ...draftToPayload(draft) }) : await api.updateAgent(selected!.id, draftToPayload(draft));
      const models = await api.agentModels(saved.id, undefined, true);
      return { saved, models };
    },
    onSuccess: ({ saved, models }) => {
      setProbeOk(true);
      // 这个按钮对新自定义 Agent 的真正价值是「验证这个 CLI 起不起得来」，所以把有没有
      // 发现模型说清楚；只说数量的话，0 个模型看起来像成功。
      setProbeResult(models.models.length
        ? `已保存，探测到 ${models.models.length} 个模型${models.defaultModel ? `，默认 ${models.defaultModel}` : ''}${models.warning ? `；${models.warning}` : ''}`
        : `已保存，但这个 Agent 没有报告可用模型${models.warning ? `；${models.warning}` : '。它仍可启动，模型可在新建会话时选择。'}`);
      setDirty(false);
      setIsNew(false);
      setSelectedId(saved.id);
      void queryClient.invalidateQueries({ queryKey: ['agents-admin'] });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: error => { setProbeOk(false); setProbeResult(error instanceof Error ? error.message : String(error)); }
  });
  // 内置 Agent 的启停走专用入口：PUT /api/agents/:id 有意忽略 disabled（防表单锁死），
  // 所以停用后不能靠它启回来。
  const toggleDisabled = useMutation({
    mutationFn: async (disabled: boolean) => api.setAgentDisabled(selected!.id, disabled),
    onSuccess: () => {
      setDeleteConfirm(false);
      void queryClient.invalidateQueries({ queryKey: ['agents-admin'] });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
    }
  });

  function requestClose() {
    if ((dirty || save.isPending || toggleDisabled.isPending) && !closeConfirm) { setCloseConfirm(true); return; }
    onClose();
  }

  const builtins = sorted.filter(agent => agent.builtin);
  const customs = sorted.filter(agent => !agent.builtin);

  return <div className="ui-overlay fixed inset-0 z-40 grid place-items-center bg-zinc-950/30 p-4 backdrop-blur-[2px]">
    <div ref={panelRef} className="ui-dialog flex h-[86dvh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(24,24,27,.2)]">
      <div className="flex h-12 shrink-0 items-center border-b border-zinc-100 px-4">
        <div className="flex items-center gap-2 text-[14px] font-semibold text-zinc-900"><Bot size={16}/>Agent 设置</div>
        <Segmented<typeof tab> className="ml-4" value={tab} onChange={setTab} options={[{ value: 'llm', label: '模型端点', icon: <Plug size={12}/> }, { value: 'agents', label: 'Agent', icon: <Bot size={12}/> }]}/>
        <button type="button" onClick={requestClose} aria-label="关闭" className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"><X size={16}/></button>
      </div>

      {tab === 'llm'
        ? <LlmEndpointPanel/>
        : <div className="grid min-h-0 flex-1 grid-cols-[220px_1fr]">
          <div className="min-h-0 overflow-y-auto border-r border-zinc-100 bg-zinc-50/60 p-2">
            <button type="button" onClick={() => { setIsNew(true); setSelectedId(null); }} className={`mb-2 flex h-9 w-full items-center gap-2 rounded-lg border border-dashed border-zinc-300 px-3 text-[12px] font-medium ${isNew ? 'border-zinc-800 bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-white'}`}><Plus size={14}/>自定义 Agent</button>
            <AgentGroup label="内置" agents={builtins} selectedId={isNew ? null : selectedId} onSelect={id => { setIsNew(false); setSelectedId(id); }}/>
            <AgentGroup label="自定义" agents={customs} selectedId={isNew ? null : selectedId} onSelect={id => { setIsNew(false); setSelectedId(id); }}/>
            {agents.isLoading && <div className="flex items-center gap-2 px-2 py-2 text-[11px] text-zinc-400"><LoaderCircle size={12} className="animate-spin"/>读取中…</div>}
            {agents.error && <div className="px-2 py-2 text-[11px] text-red-600">{agents.error instanceof Error ? agents.error.message : '读取失败（会话链接无权打开 Agent 设置，请用 master 地址）'}</div>}
          </div>
          <div className="min-h-0 overflow-y-auto px-5 py-4">
            {(isNew || selected) ? <div className="space-y-4">
              {readOnly
                ? <>
                  <div className="flex items-center gap-2"><AgentIcon agentId={selected!.id} agentName={selected!.name} size={16}/><div className="min-w-0 flex-1"><ReadOnlyField label="名称" value={selected!.name}/></div></div>
                  <ReadOnlyField label="启动命令" value={[selected!.command, ...(selected!.args ?? [])].join(' ')} mono/>
                  <ReadOnlyField label="工作目录" value={selected!.cwd} mono hint="跟随会话"/>
                  {['codex', 'claude', 'cursor'].includes(selected!.id) && <AgentUsagePanel agentId={selected!.id as 'codex' | 'claude' | 'cursor'}/>}
                  <p className="text-[11px] leading-5 text-zinc-400">内置 Agent 的参数由扫描得出（命令、参数、协议、版本），不需要也不能在这里修改；升级客户端后会自动刷新。你只能停用或重新启用它。</p>
                </>
                : <>
                  <div><span className={labelClass}>名称</span><Input size="large" className="mt-1 text-[12px]" value={draft.name} placeholder="例如 DeepSeek Harness" onChange={event => patch({ name: event.target.value })}/><FieldError message={errorByField.get('name')}/></div>
                  <div><span className={labelClass}>启动命令</span><Input size="large" className="mt-1 font-mono text-[12px]" value={draft.command} placeholder="例如 /usr/local/bin/dsh" onChange={event => patch({ command: event.target.value })}/><FieldError message={errorByField.get('command')}/></div>
                  <div><span className={labelClass}>工作目录（可选）</span><Input size="large" className="mt-1 font-mono text-[12px]" value={draft.cwd} placeholder="留空跟随会话" onChange={event => patch({ cwd: event.target.value })}/></div>
                  <p className="text-[11px] leading-5 text-zinc-400">协议、超时、参数、环境变量、模型等由 Agent 自己或运行时决定，不需要在这里配置。模型可在新建会话时选择。</p>
                </>}
              {probeResult && <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[11px] leading-5 ${probeOk ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}><AlertTriangle size={13} className="mt-0.5 shrink-0"/>{probeResult}</div>}
              {save.error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">{save.error instanceof Error ? save.error.message : '保存失败'}</div>}
              {toggleDisabled.error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">{toggleDisabled.error instanceof Error ? toggleDisabled.error.message : '操作失败'}</div>}
            </div> : <div className="grid min-h-[320px] place-items-center text-[12px] text-zinc-400">从左侧选择 Agent，或新建一个自定义 Agent。</div>}
          </div>
        </div>}

      {tab === 'agents' && (isNew || selected) && <div className="sticky bottom-0 flex h-14 shrink-0 items-center gap-2 border-t border-zinc-100 bg-white px-4">
        {readOnly
          ? <button type="button" disabled={toggleDisabled.isPending} onClick={() => setDeleteConfirm(true)} className={`flex h-9 items-center rounded-md border px-3 text-[12px] font-medium disabled:opacity-40 ${selected!.disabled ? 'border-zinc-300 text-zinc-700 hover:bg-zinc-50' : 'border-red-200 text-red-600 hover:bg-red-50'}`}>{selected!.disabled ? '重新启用' : '停用（内置）'}</button>
          : <button type="button" disabled={remove.isPending || save.isPending} onClick={() => setDeleteConfirm(true)} className="flex h-9 items-center rounded-md border border-red-200 px-3 text-[12px] font-medium text-red-600 hover:bg-red-50 disabled:opacity-40">删除</button>}
        <span className="text-[10px] text-zinc-400">{selected?.version ? `版本 ${selected.version}` : ''}{selected ? `　${selected.id}` : ''}</span>
        <div className="ml-auto flex items-center gap-2">
          {!readOnly && <>
            <button type="button" disabled={!valid || probe.isPending} onClick={() => probe.mutate()} className="flex h-9 items-center gap-1.5 rounded-md border border-zinc-300 px-3 text-[12px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40">{probe.isPending ? <LoaderCircle size={13} className="animate-spin"/> : <RefreshCw size={13}/>}保存并探测模型</button>
            <button type="button" onClick={requestClose} className="flex h-9 items-center rounded-md border border-zinc-300 px-4 text-[12px] font-medium text-zinc-700 hover:bg-zinc-50">取消</button>
            <button type="button" disabled={!valid || save.isPending} onClick={() => save.mutate()} className="flex h-9 items-center gap-1.5 rounded-md bg-zinc-900 px-4 text-[12px] font-medium text-white hover:bg-zinc-800 disabled:opacity-40">{save.isPending && <LoaderCircle size={13} className="animate-spin"/>}保存</button>
          </>}
          {readOnly && <button type="button" onClick={requestClose} className="flex h-9 items-center rounded-md border border-zinc-300 px-4 text-[12px] font-medium text-zinc-700 hover:bg-zinc-50">关闭</button>}
        </div>
      </div>}
      <ConfirmDialog open={closeConfirm} title="放弃未保存的修改？" description="当前 Agent 配置尚未保存，关闭后修改将丢失。" confirmLabel="放弃修改" tone="danger" busy={false} onCancel={() => setCloseConfirm(false)} onConfirm={onClose}/>
      {readOnly
        ? <ConfirmDialog open={deleteConfirm} tone={selected?.disabled ? undefined : 'danger'} title={selected?.disabled ? '重新启用此内置 Agent？' : '停用此内置 Agent？'} description={selected?.disabled ? '启用后可以在新建会话时再次选择它。' : '停用后新建会话将无法选择它，配置保留在数据库中；下次启动不会自动复活。'} confirmLabel={selected?.disabled ? '重新启用' : '停用'} busy={toggleDisabled.isPending} error={toggleDisabled.error instanceof Error ? toggleDisabled.error.message : undefined} onCancel={() => setDeleteConfirm(false)} onConfirm={() => toggleDisabled.mutate(!selected?.disabled)}/>
        : <ConfirmDialog open={deleteConfirm} tone="danger" title="删除此自定义 Agent？" description="删除后不可恢复，已有历史会话保留但无法再启动该 Agent。" confirmLabel="删除" busy={remove.isPending} error={remove.error instanceof Error ? remove.error.message : undefined} onCancel={() => setDeleteConfirm(false)} onConfirm={() => remove.mutate()}/>}
    </div>
  </div>;
}


function AgentGroup({ label, agents, selectedId, onSelect }: { label: string; agents: Agent[]; selectedId: string | null; onSelect(id: string): void }) {
  if (!agents.length) return null;
  return <div className="mb-2">
    <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">{label}</div>
    {agents.map(agent => <button key={agent.id} type="button" onClick={() => onSelect(agent.id)} title={agent.id} className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors ${selectedId === agent.id ? 'bg-zinc-900 text-white' : agent.disabled ? 'text-zinc-300' : 'text-zinc-700 hover:bg-white'}`}>
      <AgentIcon agentId={agent.id} agentName={agent.name} size={13} onDark={selectedId === agent.id}/>
      <span className="min-w-0 flex-1 truncate">{agent.name}</span>
      {agent.disabled && <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] ${selectedId === agent.id ? 'bg-white/20 text-white/80' : 'bg-zinc-200 text-zinc-500'}`}>停用</span>}
    </button>)}
  </div>;
}
