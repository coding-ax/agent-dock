import { KeyboardEvent, lazy, Suspense, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, Check, CheckCircle2, ExternalLink, Eye, EyeOff, FolderOpen, Info, Plus, RefreshCw, Regex, Trash2, Wrench, X } from 'lucide-react';
import { Input, InputNumber, Switch } from 'antd';
import { defaultLarkTraceLimit, validateHighRiskPattern } from '@agent-dock/agent-dock-shared';
import { api, type Agent, type LarkTurnSyncConfig } from './api';
import { BotAvatar } from './AgentIcon';
import { AiFieldHeader, AiTextAssistControl, useAiFlash } from './AiTextAssist';
import { CompactSelect } from './CompactSelect';
import { DeferredMount, DeferredSkeleton } from './DeferredMount';
import { ExitGate } from './ExitGate';
import { DEFAULT_LARK_TURN_SYNC, DEFAULT_NEW_LARK_BOT_FORM, canSaveHardGate, canToggleHardGate, normalizeLarkTurnSyncForm, resolveReasoningEffort, withSavedOption } from './lark-config-form';
import { LarkRegistrationDialog } from './LarkRegistrationDialog';
import { LarkTurnSyncControls, summarizeLarkTurnSync } from './LarkTurnSyncControls';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from './model-cache';
import { SuggestedValueInput } from './SuggestedValueInput';
import { ConfirmDialog, IconButton, SettingRow, SlidingSegmented } from './ui-controls';
import { useSyncFormFromRemote } from './useSyncFormFromRemote';
import { WebBaseUrlInput } from './WebBaseUrlInput';
import { useBi } from './i18n';

const PromptEditor = lazy(() => import('./PromptEditor'));

const parseMemberNames = (value: string) => [...new Set(value.split(/[\n,，]/).map(item => item.trim()).filter(Boolean))];

function RowSegmented({ options, value, onChange, ariaLabel }: { options: Array<{ value: string; label: string }>; value: string; onChange(value: string): void; ariaLabel?: string }) {
  return <SlidingSegmented
    ariaLabel={ariaLabel}
    value={value}
    onChange={onChange}
    options={options}
    size="md"
    className="h-9 w-full shrink-0 min-[520px]:inline-grid min-[520px]:w-auto"
  />;
}

function AgentSelect({ agents, value, disabled, size = 'default', popupWidth, onChange }: { agents: Agent[]; value: string; disabled?: boolean; size?: 'default' | 'sm'; popupWidth?: number | false; onChange(value: string): void }) {
  const L = useBi();
  return <CompactSelect size={size} popupWidth={popupWidth} options={agents.map(agent => ({ value: agent.id, label: agent.name, meta: agent.version, agentId: agent.id }))} value={value} placeholder={L("选择 Agent", "Select Agent")} disabledText={L("未扫描到可用 Agent", "No available Agents detected")} disabled={disabled} onChange={onChange}/>;
}

function MemberNameTagInput({ value, placeholder, onChange }: { value: string[]; placeholder: string; onChange(value: string[]): void }) {
  const L = useBi();
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = (raw = draft) => {
    const additions = parseMemberNames(raw);
    if (additions.length) onChange([...new Set([...value, ...additions])]);
    setDraft('');
  };
  const remove = (name: string) => onChange(value.filter(item => item !== name));
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' || event.key === ',' || event.key === '，') { event.preventDefault(); commit(); }
    else if (event.key === 'Backspace' && !draft && value.length) remove(value[value.length - 1]!);
  };
  return <div role="group" aria-label={L("成员真实姓名", "Member full name")} onClick={() => inputRef.current?.focus()} className="mt-2 flex min-h-11 cursor-text flex-wrap items-center gap-x-2 gap-y-2 rounded-lg border border-zinc-300 bg-zinc-50/70 p-2 ui-field-within focus-within:bg-white">
    {value.map(item => <span key={item} title={item} className="flex h-7 max-w-full items-center rounded-md border border-zinc-200 bg-white pl-2.5 pr-1 text-[12px] font-medium text-zinc-700 shadow-[0_1px_1px_rgba(24,24,27,.04)]">
      <span className="min-w-0 truncate">{item}</span>
      <button type="button" aria-label={L(`移除 ${item}`, `Remove ${item}`)} onPointerDown={event => event.preventDefault()} onClick={() => remove(item)} className="ml-1.5 grid h-5 w-5 shrink-0 place-items-center rounded text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300"><X size={11}/></button>
    </span>)}
    <input ref={inputRef} aria-label={L("输入成员真实姓名", "Enter member full name")} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown} onBlur={() => commit()} onPaste={event => { const text = event.clipboardData.getData('text'); if (/[\n,，]/.test(text)) { event.preventDefault(); commit(`${draft}\n${text}`); } }} placeholder={value.length ? L("继续添加成员…", "Add another member…") : placeholder} className="h-7 min-w-36 flex-[1_0_9rem] border-0 bg-transparent px-1 text-[12px] text-zinc-800 outline-none placeholder:text-zinc-400"/>
  </div>;
}

export interface LarkConfigPanelProps {
  agents: Agent[];
  onClose(): void;
  onOpenRegexTriggers?(): void;
  embedded?: boolean;
}

export function LarkConfigPanel({ agents, onClose, onOpenRegexTriggers, embedded = false }: LarkConfigPanelProps) {
  const L = useBi();
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ['lark-config'], queryFn: api.larkConfig });
  const capabilities = useQuery({ queryKey: ['system-capabilities'], queryFn: api.systemCapabilities });
  const [confirmation, setConfirmation] = useState<'incomplete' | 'discard' | 'delete'>();
  const [savedBanner, setSavedBanner] = useState<string>();
  const hydratedSelection = useRef<string | null>(null);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [webBaseUrl, setWebBaseUrl] = useState('');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [restrictUsers, setRestrictUsers] = useState(false);
  const [allowedUserNames, setAllowedUserNames] = useState<string[]>([]);
  const [allowedBotNames, setAllowedBotNames] = useState<string[]>([]);
  const [peerBotsAllowed, setPeerBotsAllowed] = useState<boolean>(DEFAULT_NEW_LARK_BOT_FORM.peerBotsAllowed);
  const [defaultAgentId, setDefaultAgentId] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [defaultReasoningEffort, setDefaultReasoningEffort] = useState('');
  const [preInjectPrompt, setPreInjectPrompt] = useState('');
  const [groupToolsEnabled, setGroupToolsEnabled] = useState<boolean>(DEFAULT_NEW_LARK_BOT_FORM.groupToolsEnabled);
  const [groupToolsAllowSend, setGroupToolsAllowSend] = useState<boolean>(DEFAULT_NEW_LARK_BOT_FORM.groupToolsAllowSend);
  const [groupSessionScope, setGroupSessionScope] = useState<'user' | 'chat'>(DEFAULT_NEW_LARK_BOT_FORM.groupSessionScope);
  const [highRiskAllowedUserNames, setHighRiskAllowedUserNames] = useState<string[]>([]);
  const [highRiskPattern, setHighRiskPattern] = useState('');
  const [gateEnabled, setGateEnabled] = useState<boolean>(DEFAULT_NEW_LARK_BOT_FORM.gateEnabled);
  const [hardGateEnabled, setHardGateEnabled] = useState(false);
  const [hookTrustConfirmed, setHookTrustConfirmed] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [listening, setListening] = useState<boolean>(DEFAULT_NEW_LARK_BOT_FORM.listening);
  const [pushIntervalMs, setPushIntervalMs] = useState<number>(DEFAULT_NEW_LARK_BOT_FORM.pushIntervalMs);
  const [traceLimit, setTraceLimit] = useState(String(defaultLarkTraceLimit));
  const [quietReply, setQuietReply] = useState<boolean>(DEFAULT_NEW_LARK_BOT_FORM.quietReply);
  const [turnSync, setTurnSync] = useState<LarkTurnSyncConfig>(DEFAULT_LARK_TURN_SYNC);

  const current = config.data?.bots.find(bot => bot.appId === selectedAppId);
  const defaultWorkspace = agents.find(agent => agent.id === defaultAgentId)?.cwd || capabilities.data?.workingDirectory;
  const agentSelectionSaved = Boolean(current?.setupComplete && current.defaultAgentId === defaultAgentId);
  const defaultAgentLocked = Boolean(hardGateEnabled || current?.hardGateEnabled);
  const highRiskPatternValidation = useMemo(() => validateHighRiskPattern(highRiskPattern), [highRiskPattern]);
  const highRiskFlash = useAiFlash();
  const hookStatus = useQuery({ queryKey: ['lark-hook-status', current?.appId, defaultAgentId], queryFn: () => api.larkHookStatus(current!.appId), enabled: Boolean(agentSelectionSaved && gateEnabled && step === 2) });
  const agentOptions = useQuery({ queryKey: agentModelsQueryKey(defaultAgentId, defaultModel), queryFn: () => loadAgentModels(defaultAgentId, defaultModel || undefined), enabled: Boolean(defaultAgentId), initialData: () => readCachedAgentModels(defaultAgentId, defaultModel || undefined), initialDataUpdatedAt: 0, refetchOnMount: 'always', staleTime: 5 * 60_000 });
  const refreshAgentOptions = useMutation({
    mutationFn: (input: { agentId: string; model?: string }) => loadAgentModels(input.agentId, input.model, true),
    onSuccess: (data, input) => qc.setQueryData(agentModelsQueryKey(input.agentId, input.model), data)
  });
  const hardGateFormState = { enabled: hardGateEnabled, persisted: Boolean(current?.hardGateEnabled), agentSelectionSaved, hookInstalled: Boolean(hookStatus.data?.installed) };
  const hardGateReadyToSave = canSaveHardGate(hardGateFormState);
  const hardGateCanToggle = canToggleHardGate(hardGateFormState);
  const hardGateHookMissing = Boolean(hardGateEnabled && current?.hardGateEnabled && hookStatus.isSuccess && !hookStatus.data.installed);
  const legacyHighRiskNeedsMigration = Boolean(gateEnabled && current?.highRiskAllowedEmails.length && !highRiskAllowedUserNames.length);
  const effectiveDefaultReasoningEffort = resolveReasoningEffort(defaultReasoningEffort, agentOptions.data?.warning ? undefined : agentOptions.data, agentOptions.isFetching);
  const promptAiContext = [
    L(`机器人名称：${name.trim() || appId.trim() || '未命名'}`, `Bot: ${name.trim() || appId.trim() || 'Untitled'}`),
    L(`Agent：${agents.find(agent => agent.id === defaultAgentId)?.name ?? (defaultAgentId || '未选择')}`, `Agent: ${agents.find(agent => agent.id === defaultAgentId)?.name ?? (defaultAgentId || 'None')}`),
    L(`工作区：${workspace.trim() || '使用 Agent 默认工作目录'}`, `Workspace: ${workspace.trim() || 'Agent default'}`),
    L(`群协作工具：${groupToolsEnabled ? (groupToolsAllowSend ? '已开启（可读写）' : '已开启（只读）') : '未开启'}`, `Group tools: ${groupToolsEnabled ? (groupToolsAllowSend ? 'Read & Write' : 'Read-only') : 'Off'}`),
    L(`回复模式：${quietReply ? '静默回复（最终答案由服务端自动发送）' : 'Trace 卡片'}`, `Reply mode: ${quietReply ? 'Quiet Reply' : 'Trace Card'}`),
    L(`非飞书轮次同步：${summarizeLarkTurnSync(turnSync)}`, `Non-Lark turn sync: ${summarizeLarkTurnSync(turnSync)}`)
  ].join('\n');

  useSyncFormFromRemote(config.data, () => {
    if (selectedAppId !== null) return;
    const firstBot = config.data!.bots[0];
    setSelectedAppId(firstBot?.appId ?? '');
    setStep(firstBot && !firstBot.setupComplete ? 2 : 1);
  });

  useSyncFormFromRemote(config.data && selectedAppId !== null ? selectedAppId : null, () => {
    if (selectedAppId === null) return;
    if (hydratedSelection.current === selectedAppId) return;
    hydratedSelection.current = selectedAppId;
    setSavedBanner(undefined);
    const bot = config.data!.bots.find(item => item.appId === selectedAppId);
    setName(bot?.name ?? ''); setWorkspace(bot?.workspace ?? ''); setWebBaseUrl(bot?.webBaseUrl ?? ''); setAppId(bot?.appId ?? ''); setAppSecret(''); setRestrictUsers(Boolean(bot?.allowedUsers.length || bot?.allowedEmails.length || bot?.allowedUserNames?.length)); setAllowedUserNames(bot?.allowedUserNames?.length ? bot.allowedUserNames : (bot?.allowedUsers ?? []).map(user => user.name)); setAllowedBotNames(bot?.allowedBotNames?.length ? bot.allowedBotNames : (bot?.allowedBots ?? []).map(b => b.name)); setPeerBotsAllowed(bot?.peerBotsAllowed !== false);
    setDefaultAgentId(agents.some(agent => agent.id === bot?.defaultAgentId) ? bot?.defaultAgentId ?? '' : agents[0]?.id ?? '');
    setDefaultModel(bot?.defaultModel ?? ''); setDefaultReasoningEffort(bot?.defaultReasoningEffort ?? ''); setListening(bot ? bot.listening : DEFAULT_NEW_LARK_BOT_FORM.listening); setPushIntervalMs(bot?.pushIntervalMs ?? DEFAULT_NEW_LARK_BOT_FORM.pushIntervalMs); setTraceLimit((bot?.traceLimit ?? defaultLarkTraceLimit).toString()); setQuietReply(bot ? bot.quietReply : DEFAULT_NEW_LARK_BOT_FORM.quietReply); setTurnSync(bot?.turnSync ? normalizeLarkTurnSyncForm(bot.turnSync) : DEFAULT_LARK_TURN_SYNC);
    setPreInjectPrompt(bot?.preInjectPrompt ?? ''); setGroupToolsEnabled(bot ? bot.groupToolsEnabled : DEFAULT_NEW_LARK_BOT_FORM.groupToolsEnabled); setGroupToolsAllowSend(bot ? bot.groupToolsAllowSend : DEFAULT_NEW_LARK_BOT_FORM.groupToolsAllowSend); setGroupSessionScope(bot ? bot.groupSessionScope : DEFAULT_NEW_LARK_BOT_FORM.groupSessionScope); setHighRiskAllowedUserNames(bot?.highRiskAllowedUserNames?.length ? bot.highRiskAllowedUserNames : (bot?.highRiskAllowedUsers ?? []).map(user => user.name)); setHighRiskPattern(bot?.highRiskPattern ?? ''); setGateEnabled(bot ? bot.gateEnabled : DEFAULT_NEW_LARK_BOT_FORM.gateEnabled); setHardGateEnabled(bot?.hardGateEnabled ?? false); setHookTrustConfirmed(bot?.hookTrustConfirmed ?? false);
  });

  const inspect = useMutation({ mutationFn: () => api.inspectLarkBot({ appId: appId.trim(), appSecret: appSecret.trim() }), onSuccess: result => setName(result.appName) });
  const save = useMutation({
    mutationFn: async () => {
      const larkSaved = await api.saveLarkConfig({ stage: 'lark', ...(current ? { originalAppId: current.appId } : {}), appId: appId.trim(), ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}), workspace: workspace.trim(), webBaseUrl: webBaseUrl.trim(), allowedUserNames: restrictUsers ? allowedUserNames : [], allowedEmails: [], allowedBotNames: peerBotsAllowed ? [] : allowedBotNames, peerBotsAllowed, listening, pushIntervalMs, traceLimit: Number(traceLimit), quietReply, turnSync });
      qc.setQueryData(['lark-config'], larkSaved);
      return api.saveLarkConfig({ stage: 'agent', originalAppId: appId.trim(), defaultAgentId, defaultModel, defaultReasoningEffort: effectiveDefaultReasoningEffort, preInjectPrompt, groupToolsEnabled, groupToolsAllowSend, groupSessionScope, highRiskAllowedUserNames, highRiskAllowedEmails: [], highRiskPattern, gateEnabled, softGateEnabled: gateEnabled, hardGateEnabled, hookTrustConfirmed });
    },
    onSuccess: data => {
      qc.setQueryData(['lark-config'], data);
      const savedId = appId.trim();
      setSelectedAppId(savedId);
      setAppSecret('');
      void qc.invalidateQueries({ queryKey: ['lark-hook-status', savedId] });
      if (embedded) {
        setSavedBanner(L("飞书机器人配置已保存并生效", "Lark bot configuration saved and active"));
      } else {
        onClose();
      }
    }
  });
  const installHook = useMutation({
    mutationFn: async () => {
      const saved = await api.saveLarkConfig({ stage: 'agent', originalAppId: current!.appId, defaultAgentId, defaultModel, defaultReasoningEffort: effectiveDefaultReasoningEffort, preInjectPrompt, listening, groupToolsEnabled, groupToolsAllowSend, groupSessionScope, highRiskAllowedUserNames, highRiskAllowedEmails: [], highRiskPattern, gateEnabled: true, softGateEnabled: true, hardGateEnabled: false, hookTrustConfirmed: false });
      qc.setQueryData(['lark-config'], saved);
      return api.installLarkHook(current!.appId, highRiskPattern);
    },
    onSuccess: result => { qc.setQueryData(['lark-hook-status', current!.appId, defaultAgentId], result); setGateEnabled(true); setHardGateEnabled(false); setHookTrustConfirmed(true); void qc.invalidateQueries({ queryKey: ['lark-config'] }); }
  });
  const remove = useMutation({ mutationFn: () => api.deleteLarkConfig(current!.appId), onSuccess: data => { qc.setQueryData(['lark-config'], data); const firstBot = data.bots[0]; setSelectedAppId(firstBot?.appId ?? ''); setStep(firstBot && !firstBot.setupComplete ? 2 : 1); setConfirmation(undefined); } });
  const pickWorkspace = useMutation({ mutationFn: api.selectDirectory, onSuccess: result => setWorkspace(result.path) });
  const agentCapabilitiesPending = step === 2 && Boolean(defaultAgentId) && !agentOptions.data && (agentOptions.isLoading || agentOptions.isFetching);
  const agentCapabilitiesReady = step !== 2 || Boolean(agentOptions.data);
  const larkStageValid = Boolean(appId.trim() && (current || appSecret.trim()) && (!restrictUsers || allowedUserNames.length) && (peerBotsAllowed || allowedBotNames.length) && (quietReply || (Number.isInteger(pushIntervalMs) && pushIntervalMs >= 500 && pushIntervalMs <= 20000)));
  const agentStageValid = Boolean(defaultAgentId && agentCapabilitiesReady && (!gateEnabled || highRiskPatternValidation.valid) && !legacyHighRiskNeedsMigration && hardGateReadyToSave);
  const advancesToAgentStep = step === 1 && !current?.setupComplete;
  const canSave = advancesToAgentStep ? larkStageValid : larkStageValid && agentStageValid;
  const larkCredentialsReady = Boolean(current || (appId.trim() && appSecret.trim()));
  const formError = refreshAgentOptions.error ?? save.error ?? remove.error ?? pickWorkspace.error ?? inspect.error ?? installHook.error ?? (agentOptions.data ? undefined : agentOptions.error) ?? config.error;
  const permissionSettingsUrl = /^cli_[\w-]+$/.test(appId.trim()) ? `https://open.larkoffice.com/app/${encodeURIComponent(appId.trim())}/auth` : undefined;
  const permissionRelatedError = Boolean(formError && /权限|permission|通讯录|邮箱|open[_ ]?id|资源点|visible range/i.test(formError.message));
  const requestClose = () => {
    const incompleteDraft = Boolean(current && !current.setupComplete);
    const unsavedNewBot = !current && selectedAppId === '' && Boolean(appId.trim() || appSecret.trim() || workspace.trim());
    if (incompleteDraft || unsavedNewBot) { setConfirmation(incompleteDraft ? 'incomplete' : 'discard'); return; }
    onClose();
  };

  const formContent = (
    <form
      onSubmit={event => { event.preventDefault(); if (!canSave) return; setSavedBanner(undefined); if (advancesToAgentStep) setStep(2); else save.mutate(); }}
      className={embedded
        ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
        : 'ui-dialog flex h-[100dvh] w-full max-w-none flex-col overflow-hidden rounded-none border-0 border-zinc-200 bg-white shadow-[0_20px_64px_rgba(24,24,27,.18)] sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:max-w-[640px] sm:rounded-[14px] sm:border'}
    >
      {embedded ? (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-4 py-2.5 sm:px-5">
          <p className="min-w-0 text-[12px] text-zinc-500">{L("每个飞书机器人拥有独立工作区、成员白名单与 Agent 门禁", "Each Lark bot has its own workspace, allowlist, and safety gates")}</p>
          <div className="flex flex-wrap items-center gap-1">
            <a href="https://open.larkoffice.com/app" target="_blank" rel="noreferrer" className="flex h-7 items-center gap-1 whitespace-nowrap rounded-lg px-2 text-[12px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900">{L("飞书开发者后台", "Lark Open Platform")}<ExternalLink size={11}/></a>
            <a href="https://open.larkoffice.com/page/launcher?from=backend_oneclick" target="_blank" rel="noreferrer" className="flex h-7 items-center gap-1 whitespace-nowrap rounded-lg px-2 text-[12px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900">{L("快速创建", "Quick Create")}<ExternalLink size={11}/></a>
            <button type="button" onClick={() => setRegistrationOpen(true)} disabled={!config.data || save.isPending} className="ui-press flex h-7 items-center gap-1 whitespace-nowrap rounded-lg border border-zinc-200 bg-white px-2.5 text-[12px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-40"><Plus size={12}/>{L("扫码创建机器人", "Scan QR to Create Bot")}</button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-y-2 border-b border-zinc-100 px-3.5 py-2.5 sm:px-4 sm:py-3">
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold text-zinc-900">{L("飞书机器人", "Lark Bots")}</h2>
            <p className="mt-0.5 truncate text-[12px] text-zinc-500">{L("每个机器人拥有独立工作区和会话", "Each bot has its own workspace and sessions")}</p>
          </div>
          <div className="col-span-2 row-start-2 flex min-w-0 flex-wrap items-center justify-start gap-1 sm:justify-end sm:gap-0.5">
            {onOpenRegexTriggers && <button type="button" onClick={onOpenRegexTriggers} className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-zinc-200 bg-zinc-50 px-2 text-[12px] font-medium text-zinc-700 transition-colors hover:bg-zinc-100 hover:text-zinc-900 sm:px-2.5"><Regex size={12}/>{L("群聊正则唤起", "Group Regex Triggers")}</button>}
            <a href="https://open.larkoffice.com/app" target="_blank" rel="noreferrer" className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[12px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50 sm:px-2.5">{L("飞书开发者后台", "Lark Open Platform")}<ExternalLink size={12}/></a>
            <a href="https://open.larkoffice.com/page/launcher?from=backend_oneclick" target="_blank" rel="noreferrer" className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[12px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50 sm:px-2.5">{L("快速创建机器人", "Quick Create Bot")}<ExternalLink size={12}/></a>
            <button type="button" onClick={() => setRegistrationOpen(true)} disabled={!config.data || save.isPending} className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[12px] font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40 sm:px-2.5">{L("扫码创建机器人", "Scan QR to Create Bot")}<Plus size={12}/></button>
          </div>
          <span className="col-start-2 row-start-1 ml-1"><IconButton label={L("关闭", "Close")} onClick={requestClose}><X size={15}/></IconButton></span>
        </div>
      )}
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-100 bg-zinc-50/70 px-3 py-2 no-scrollbar sm:px-4">
        {config.data?.bots.map(bot => <button key={bot.appId} type="button" onClick={() => { setSelectedAppId(bot.appId); setStep(bot.setupComplete ? 1 : 2); }} className={`flex h-8 max-w-[250px] shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium transition-colors ${selectedAppId === bot.appId ? 'bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200' : 'text-zinc-500 hover:bg-white/70 hover:text-zinc-800'}`}>{bot.avatarUrl ? <BotAvatar url={bot.avatarUrl} size={13} className="h-[13px] w-[13px] shrink-0 rounded-sm object-cover"/> : <Bot size={13} className="shrink-0"/>}<span title={bot.name} className="min-w-0 max-w-32 truncate">{bot.tabLabel}</span>{bot.setupComplete ? <span title={L("配置完成", "Configured")} className="flex shrink-0 items-center gap-0.5 rounded bg-emerald-50 px-1 py-0.5 text-[12px] font-medium text-emerald-700"><Check size={9}/>{L("已配置", "Configured")}</span> : <span className="shrink-0 rounded bg-amber-100 px-1 py-0.5 text-[12px] text-amber-700">{L("待配置", "Setup Needed")}</span>}{bot.activeListening && <span title={L("长连接已连接", "Long-connection active")} className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"/>}</button>)}
        <button type="button" onClick={() => { setSelectedAppId(''); setStep(1); }} className={`flex h-8 shrink-0 items-center gap-1 rounded-lg px-2.5 text-[12px] font-medium ${selectedAppId === '' ? 'bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200' : 'text-zinc-500 hover:bg-white/70 hover:text-zinc-800'}`}><Plus size={13}/>{L("新增机器人", "Add Bot")}</button>
      </div>
      <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-4 py-4 sm:px-5">
        <DeferredMount placeholder={<div className="min-h-[320px]"><DeferredSkeleton/></div>}>
        {config.isLoading ? <div className="space-y-2.5"><div className="h-9 ui-skeleton rounded-md bg-zinc-100"/><div className="h-9 ui-skeleton rounded-md bg-zinc-100"/><div className="h-9 ui-skeleton rounded-md bg-zinc-100"/></div> : <>
          <SlidingSegmented
            ariaLabel={L("飞书配置步骤", "Lark setup steps")}
            value={String(step)}
            onChange={next => setStep(next === '2' ? 2 : 1)}
            size="md"
            className="mb-1"
            itemClassName="h-8 py-2"
            options={[
              {
                value: '1',
                label: <><span className={`inline-grid h-4 w-4 place-items-center rounded-full text-[11px] font-semibold transition-colors ${step === 1 ? 'bg-zinc-900 text-white' : 'bg-zinc-200 text-zinc-600'}`}>1</span>{L("飞书与白名单", "Lark & Access")}</>
              },
              {
                value: '2',
                disabled: !current && !larkStageValid,
                label: <><span className={`inline-grid h-4 w-4 place-items-center rounded-full text-[11px] font-semibold transition-colors ${step === 2 ? 'bg-zinc-900 text-white' : 'bg-zinc-200 text-zinc-600'}`}>2</span>{L("Agent 与门禁", "Agent & Gates")}</>
              }
            ]}
          />
          <p className="-mt-1 text-[12px] leading-4 text-zinc-400">{step === 1 ? L("点「下一步」继续配置 Agent，最后点「保存」才会一次性生效；指定成员和机器人的姓名在实际使用时再校验。", "Click Next to configure Agent settings, then Save to apply. Member and bot names are resolved on demand.") : L("Agent 配置不影响长连接；收到消息时才会校验运行配置。", "Agent settings don't interrupt long-connection; runtime checks occur when messages arrive.")}</p>
          {step === 1 ? <>
          <div className="grid gap-3 sm:grid-cols-2"><label className="block"><span className="text-[12px] font-medium text-zinc-700">{L("机器人名称", "Bot Name")}</span><Input size="large" value={name} readOnly variant="filled" placeholder={L("校验凭证后自动识别", "Auto-detected after verifying credentials")} className="mt-1.5 font-mono text-[12px]"/></label><label className="block"><span className="text-[12px] font-medium text-zinc-700">App ID</span><Input size="large" value={appId} onChange={event => { setAppId(event.target.value); setName(''); }} placeholder="cli_xxx" autoComplete="off" className="mt-1.5 font-mono text-[12px]"/></label></div>
          <label className="block"><span className="flex items-center text-[12px] font-medium text-zinc-700">App Secret{current && <span className="ml-2 font-normal text-zinc-400">{L("留空不修改", "Leave blank to keep unchanged")}</span>}</span><Input.Password size="large" value={appSecret} onChange={event => setAppSecret(event.target.value)} visibilityToggle={{ visible: showSecret, onVisibleChange: setShowSecret }} iconRender={visible => visible ? <EyeOff size={13}/> : <Eye size={13}/>} placeholder={current ? L("已保存", "Saved") : L("输入 App Secret", "Enter App Secret")} autoComplete="new-password" className="mt-1.5 font-mono text-[12px]"/></label>
          <div><span className="text-[12px] font-medium text-zinc-700">{L("工作区", "Workspace")} <span className="font-normal text-zinc-400">{L("可选", "Optional")}</span></span><div className="flex items-start gap-2"><div className="min-w-0 flex-1"><SuggestedValueInput value={workspace} onChange={setWorkspace} label={L("工作区", "Workspace")} placeholder={L("留空使用默认工作目录", "Leave blank for default workspace")} suggestion={defaultWorkspace} suggestionLabel={L("使用默认工作目录", "Use default workspace")}/></div><button type="button" disabled={!capabilities.data?.directoryPicker || pickWorkspace.isPending} onClick={() => pickWorkspace.mutate()} className="mt-1.5 flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 text-[12px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"><FolderOpen size={13}/>{capabilities.data?.directoryPicker ? L("选择", "Browse") : L("仅支持 Mac", "macOS only")}</button></div><p className="mt-1 text-[12px] leading-4 text-zinc-400">{L("留空时使用所选 Agent 的默认工作目录；路径位于 AgentDock 服务所在机器。", "Uses the Agent's default directory if empty (path on the AgentDock host).")}</p></div>
          <div className="block"><span className="text-[12px] font-medium text-zinc-700">{L("Web 访问地址", "Web Base URL")} <span className="font-normal text-zinc-400">{L("可选", "Optional")}</span></span><WebBaseUrlInput value={webBaseUrl} onChange={setWebBaseUrl}/><p className="mt-1 text-[12px] leading-4 text-zinc-400">{L("配置后，飞书卡片底部会显示“查看详情”链接，指向该域名下的会话 Trace 页面。", "Adds a \"View Details\" link at the bottom of Lark cards pointing to this host.")}</p></div>
          {!current && <button type="button" disabled={!appId.trim() || !appSecret.trim() || inspect.isPending} onClick={() => inspect.mutate()} className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white text-[12px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40">{inspect.isPending ? <RefreshCw size={12} className="animate-spin"/> : <Bot size={12}/>}{L("校验凭证并识别机器人名称", "Verify credentials and detect bot name")}</button>}
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <SettingRow title={L("可使用机器人的成员", "Allowed Users")} description={L("输入飞书真实姓名；收到消息时再解析为稳定的 open_id，不读取邮箱。", "Enter full Lark names; resolved to stable open_id on arrival without reading emails.")}>
              <RowSegmented ariaLabel={L("可使用机器人的成员", "Allowed Users")} value={restrictUsers ? 'restricted' : 'all'} onChange={value => setRestrictUsers(value === 'restricted')} options={[{ value: 'all', label: L("所有人", "Everyone") }, { value: 'restricted', label: L("指定成员", "Specific Members") }]}/>
            </SettingRow>
            {restrictUsers && <div className="border-t border-zinc-100 px-4 pb-3.5 pt-3">
              {Boolean(current?.allowedEmails.length && !current.allowedUsers.length) && <div className="mb-2 border-l-2 border-amber-400 bg-amber-50 px-2.5 py-2 text-[12px] leading-5 text-amber-800">{L("检测到旧邮箱白名单。请重新填写真实姓名；保存后改用姓名白名单，使用时解析 open_id，停止查询通讯录。", "Legacy email allowlist detected. Re-enter full names to migrate to name-based open_id resolution.")}</div>}
              <div><div className="text-[12px] font-medium text-zinc-500">{L("成员真实姓名", "Member full name")}</div><MemberNameTagInput value={allowedUserNames} onChange={setAllowedUserNames} placeholder={L("输入姓名后按 Enter", "Type name and press Enter")}/><p className="mt-1 text-[12px] leading-5 text-zinc-400">{L("支持 Enter、逗号或粘贴多行生成标签。保存时不查询群成员；使用时精确匹配，找不到或重名时拒绝访问。", "Press Enter, comma, or paste lines to add tags. Exact match enforced at runtime.")}</p></div>
            </div>}
          </div>
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <SettingRow title={L("可调用机器人的其他机器人", "Allowed Peer Bots")} description={L("输入机器人名称；收到调用时再在群成员中解析 open_id。", "Enter bot names; resolved in group members when invoked.")}>
              <RowSegmented ariaLabel={L("可调用机器人的其他机器人", "Allowed Peer Bots")} value={peerBotsAllowed ? 'all' : 'restricted'} onChange={value => setPeerBotsAllowed(value === 'all')} options={[{ value: 'all', label: L("所有机器人", "All Bots") }, { value: 'restricted', label: L("指定机器人", "Specific Bots") }]}/>
            </SettingRow>
            {!peerBotsAllowed && <div className="border-t border-zinc-100 px-4 pb-3.5 pt-3">
              <div><div className="text-[12px] font-medium text-zinc-500">{L("机器人名称", "Bot Name")}</div><MemberNameTagInput value={allowedBotNames} onChange={setAllowedBotNames} placeholder={L("输入机器人名称后按 Enter", "Type bot name and press Enter")}/></div>
            </div>}
          </div>
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <div className="px-4 py-3">
              <div className="text-[14px] font-medium text-zinc-900">{L("Trace 卡片", "Trace Card")}</div>
              <div className="mt-0.5 text-[12px] leading-5 text-zinc-500">{L("控制任务过程中推送的 trace 卡片如何渲染与刷新。", "Control how live trace cards render and refresh during execution.")}</div>
            </div>
            <SettingRow inline title={L("静默回复（不显示 trace 卡片）", "Quiet Reply (hide trace cards)")} description={L("不发送 trace 卡片，任务结束时由服务自动把最终回复以文本发送到会话；Agent 会被提示如何在本模式下 @ 他人。", "Skips live trace cards and sends only the final plain reply when done.")}>
              <Switch size="small" checked={quietReply} onChange={() => setQuietReply(value => !value)}/>
            </SettingRow>
            {!quietReply && <>
              <SettingRow title={L("飞书推送间隔", "Push Interval")} description={L("500-20000 ms；心跳消息的最短间隔。", "500–20000 ms; minimum interval between card updates.")}>
                <InputNumber<number> size="middle" min={500} max={20000} step={100} value={pushIntervalMs} onChange={value => setPushIntervalMs(value ?? 1000)} suffix="ms" className="!w-full min-[520px]:!w-40 font-mono"/>
              </SettingRow>
              <SettingRow title={L("Trace 阶段上限", "Trace Step Limit")} description={L(`默认 ${defaultLarkTraceLimit}；心跳渲染时最多保留最近 N 个执行阶段，超过飞书 24KB / 180 组件限制时仍会自动裁剪较早记录。`, `Default ${defaultLarkTraceLimit}; keeps the last N execution steps while auto-trimming under Lark's 24KB / 180 element limit.`)}>
                <InputNumber size="middle" min={1} max={200} step={1} precision={0} value={traceLimit === '' ? null : Number(traceLimit)} onChange={value => setTraceLimit(value == null ? '' : String(value))} className="!w-full min-[520px]:!w-40 font-mono"/>
              </SettingRow>
            </>}
          </div>
          <LarkTurnSyncControls value={turnSync} onChange={setTurnSync} variant="settings"/>
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <SettingRow inline className={config.data?.listeningDisabled || !larkCredentialsReady ? 'opacity-50' : ''} title={L("监听飞书消息", "Listen for Lark Messages")} description={config.data?.listeningDisabled ? L("本次启动已通过 --no-lark-listen 禁用，保存值不受影响", "Disabled by --no-lark-listen for this run; saved preference is preserved") : !larkCredentialsReady ? L("请先填写飞书凭证", "Enter Lark credentials first") : current?.activeListening ? L("长连接已连接", "Long-connection active") : !current?.setupComplete ? L("可先监听；收到消息时再校验 Agent 运行配置", "Can start listening now; Agent settings are validated when messages arrive") : L("使用长连接接收机器人消息", "Receive bot messages over WebSocket long-connection")}>
              <Switch size="small" checked={listening && !config.data?.listeningDisabled} disabled={config.data?.listeningDisabled || !larkCredentialsReady} onChange={() => setListening(value => !value)}/>
            </SettingRow>
          </div>
          </> : <>
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <SettingRow title={L("默认 Agent", "Default Agent")} description={defaultAgentLocked ? L("硬门禁已开启，保存关闭后解锁。", "Locked while Hard Gate is active; disable Hard Gate and save to change.") : L("飞书会话默认使用的 Agent。", "Default Agent for Lark sessions.")}>
              <div className="w-full min-[520px]:w-64"><AgentSelect size="sm" popupWidth={360} agents={agents} value={defaultAgentId} disabled={defaultAgentLocked} onChange={value => { setDefaultAgentId(value); setDefaultModel(''); setDefaultReasoningEffort(''); setHardGateEnabled(false); setHookTrustConfirmed(false); }}/></div>
            </SettingRow>
            <SettingRow title={L("默认模型", "Default Model")} description={!agentOptions.isFetching && !agentOptions.data?.models.length ? L("暂未取得可选模型，保留当前配置；可尝试重新读取。", "Could not fetch model list; keeping current value. Try refreshing.") : L("由 Agent 提供，可覆盖 Agent 默认模型。", "Provided by Agent; overrides Agent default model.")}>
              <div className="w-full min-[520px]:w-64"><CompactSelect size="sm" popupWidth={380} options={[{ value: '', label: agentOptions.data?.defaultModel ? L(`Agent 默认 (${agentOptions.data.defaultModel})`, `Agent Default (${agentOptions.data.defaultModel})`) : L("使用 Agent 默认模型", "Use Agent Default Model") }, ...withSavedOption(agentOptions.data?.models ?? [], defaultModel).map(item => ({ value: item.id, label: item.name, meta: item.name === item.id ? undefined : item.id }))]} value={defaultModel} placeholder={L("选择默认模型", "Select default model")} disabled={!agentOptions.data?.models.length} disabledText="" onChange={value => { setDefaultModel(value); setDefaultReasoningEffort(''); }}/></div>
            </SettingRow>
            <SettingRow title={L("推理强度", "Reasoning Effort")} description={!agentOptions.isFetching && !agentOptions.data?.reasoningEfforts.length ? L("该 Agent / 模型暂未提供可选强度，保留当前配置。", "No reasoning options reported; keeping current value.") : L("由 Agent / 模型提供。", "Provided by Agent / model.")}>
              <div className="w-full min-[520px]:w-64"><CompactSelect size="sm" popupWidth={300} options={[{ value: '', label: agentOptions.data?.defaultReasoningEffort ? L(`Agent 默认 (${agentOptions.data.defaultReasoningEffort})`, `Agent Default (${agentOptions.data.defaultReasoningEffort})`) : L("使用 Agent 默认强度", "Use Agent Default Effort") }, ...withSavedOption(agentOptions.data?.reasoningEfforts ?? [], effectiveDefaultReasoningEffort).map(item => ({ value: item.id, label: item.name }))]} value={effectiveDefaultReasoningEffort} placeholder={L("选择推理强度", "Select reasoning effort")} disabled={!agentOptions.data?.reasoningEfforts.length} disabledText="" onChange={setDefaultReasoningEffort}/></div>
            </SettingRow>
            <div className="flex items-center justify-between gap-2 border-t border-zinc-100 px-4 py-2 text-[12px] text-zinc-400">
              <span>{agentOptions.isFetching || refreshAgentOptions.isPending ? L("正在读取 Agent 配置…", "Loading Agent capabilities…") : L("模型与推理强度由 Agent 提供", "Models and reasoning options come from the Agent")}</span>
              <button type="button" disabled={!defaultAgentId || agentOptions.isFetching || refreshAgentOptions.isPending} onClick={() => refreshAgentOptions.mutate({ agentId: defaultAgentId, model: defaultModel || undefined })} className="flex h-7 items-center gap-1 rounded px-1.5 text-[12px] text-zinc-500 hover:bg-zinc-100 disabled:opacity-40"><RefreshCw size={12}/>{L("重新读取", "Refresh")}</button>
            </div>
            {(agentOptions.data?.warning || agentOptions.isError || refreshAgentOptions.isError) && <p role="status" className="mx-4 mb-3 border-l-2 border-amber-300 bg-amber-50 px-2 py-1.5 text-[12px] leading-5 text-amber-800">{agentOptions.data?.warning ?? L("Agent 配置请求失败，请检查服务连接后重新读取。", "Failed to load Agent config; check server connection and refresh.")}</p>}
          </div>
          <div><span className="text-[12px] font-medium text-zinc-700">{L("预注入 Prompt", "Pre-injected Prompt")} <span className="font-normal text-zinc-400">{L("可选，Markdown", "Optional, Markdown")}</span></span><Suspense fallback={<div className="mt-1.5 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-[12px] text-zinc-400">{L("正在加载编辑器…", "Loading editor…")}</div>}><PromptEditor value={preInjectPrompt} onChange={setPreInjectPrompt} aiContext={promptAiContext} resetKey={selectedAppId ?? ''}/></Suspense><p className="mt-1 text-[12px] leading-5 text-zinc-400">{L("每轮飞书对话都会在用户请求前隐式注入，不会在 Agent 聊天记录中重复显示为用户消息。", "Implicitly prepended to every Lark turn without duplicating in user chat history.")}</p></div>
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <SettingRow title={L("群聊主流消息的会话范围", "Main Group Thread Scope")} description={groupSessionScope === 'chat' ? L("普通群主流消息全群共享同一上下文（默认）；话题内消息始终按话题隔离。", "Main chat shares one context across the group (default); threads stay isolated.") : L("普通群主流消息按发送人各自隔离上下文；话题内消息始终按话题隔离。", "Main chat isolates context per sender; threads stay isolated.")}>
              <RowSegmented ariaLabel={L("群聊主流消息的会话范围", "Main Group Thread Scope")} value={groupSessionScope} onChange={v => setGroupSessionScope(v as 'user' | 'chat')} options={[{ value: 'chat', label: L("全群共享", "Shared Group") }, { value: 'user', label: L("按人隔离", "Per Sender") }]}/>
            </SettingRow>
            <SettingRow inline title={L("启用 Agent 群协作工具", "Enable Group Collaboration Tools")} description={L("允许 Agent 在当前飞书群发现其他已配置 Agent，并读取增量消息。", "Allows the Agent to discover peer bots and read incremental group messages.")}>
              <Switch size="small" checked={groupToolsEnabled} onChange={() => { const next = !groupToolsEnabled; setGroupToolsEnabled(next); if (!next) setGroupToolsAllowSend(false); }}/>
            </SettingRow>
            {groupToolsEnabled && <SettingRow inline title={L("允许 Agent 发消息与 @交接", "Allow Sending Messages & @Handovers")} description={L("关闭后仅保留 self、peers、messages 和 wait 只读能力。", "When off, restricts tools to read-only self, peers, messages, and wait.")}>
              <Switch size="small" checked={groupToolsAllowSend} onChange={() => setGroupToolsAllowSend(value => !value)}/>
            </SettingRow>}
            <div className="flex items-start gap-1.5 border-t border-zinc-100 px-4 py-3 text-[12px] leading-5 text-zinc-500"><Info size={14} className="mt-0.5 shrink-0"/><span>{L("缺少群成员、消息或发消息权限时，Agent 会停止对应操作并给出管理员授权链接；不会索要 App Secret。", "If permissions are missing, the Agent halts and displays an admin auth link without asking for App Secret.")}</span></div>
          </div>
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <SettingRow inline title={L("启用高危操作门禁", "Enable High-Risk Safety Gate")} description={L("启用后强制开启软门禁，并可继续配置 Hook 硬门禁。", "Enforces Soft Gate and optionally enables Hook-based Hard Gate.")}>
              <Switch size="small" checked={gateEnabled} onChange={() => { const next = !gateEnabled; setGateEnabled(next); if (!next) setHardGateEnabled(false); }}/>
            </SettingRow>
          </div>
          {gateEnabled && <div className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-3">
            <div className="px-1 text-[14px] font-medium text-zinc-900">{L("高危操作门禁", "High-Risk Operation Gate")}</div>
            <p className="mt-1 px-1 text-[12px] leading-5 text-zinc-500">{L("不在允许名单内的发送人会收到软门禁 Prompt；开启硬门禁后，再通过 ACP 权限层和 Agent 原生工具调用 Hook 拦截。", "Users outside the high-risk allowlist receive soft-gate guardrails; Hard Gate blocks via ACP & native hooks.")}</p>
            <div className="mt-3"><div className="text-[12px] font-medium text-zinc-700">{L("允许执行高危操作的成员", "High-Risk Allowed Users")} <span className="font-normal text-zinc-400">{L("留空则继承普通成员名单", "Leave empty to inherit regular allowlist")}</span></div><p className="mt-0.5 text-[12px] leading-5 text-zinc-500">{L("输入真实姓名，保存时解析为 open_id。", "Enter full names; resolved to open_id on save.")}</p>
              {legacyHighRiskNeedsMigration && <div className="mt-2 border-l-2 border-amber-400 bg-amber-50 px-2.5 py-2 text-[12px] leading-5 text-amber-800">{L("检测到旧高危邮箱名单。请重新选择成员后再保存，避免意外扩大高危权限。", "Legacy email list detected. Re-select allowed users before saving.")}</div>}
              <MemberNameTagInput value={highRiskAllowedUserNames} onChange={setHighRiskAllowedUserNames} placeholder={L("输入姓名后按 Enter", "Type name and press Enter")}/>
            </div>
            <div className="mt-3 block">
              <AiFieldHeader
                label={L("高危操作正则表达式", "High-Risk Regex Pattern")}
                htmlFor="lark-high-risk-pattern"
                assist={
                  <AiTextAssistControl
                    mode="regex_generate"
                    variant="pill"
                    size="xs"
                    popoverSide="top"
                    popoverAlign="end"
                    value={highRiskPattern}
                    onChange={setHighRiskPattern}
                    onFlash={highRiskFlash.triggerFlash}
                    resetKey={selectedAppId ?? ''}
                    context={() => ({
                      field: L("飞书机器人高危操作拦截正则", "High-risk command regex for Lark bot"),
                      purpose: L("匹配需要拦截或二次确认的高危命令/操作（例如 rm -rf、git push --force、DROP TABLE、生产发布等）", "Matches destructive commands to block or guard (e.g., rm -rf, git push --force, DROP TABLE)"),
                      botContext: promptAiContext
                    })}
                    testId="lark-high-risk-regex-ai"
                  />
                }
              />
              <div className={`mt-1.5 rounded-lg ${highRiskFlash.flashClass}`}>
                <Input.TextArea id="lark-high-risk-pattern" value={highRiskPattern} onChange={event => setHighRiskPattern(event.target.value)} autoSize={{ minRows: 4, maxRows: 10 }} status={highRiskPatternValidation.valid ? undefined : 'error'} className="font-mono text-[12px] leading-5"/>
              </div>
              {!highRiskPatternValidation.valid && <p className="mt-1.5 flex items-start gap-1 text-[12px] leading-5 text-red-600"><AlertTriangle size={12} className="mt-0.5 shrink-0"/>{highRiskPatternValidation.error}</p>}
            </div>
            <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200 bg-white">
              <SettingRow inline title={L("软门禁", "Soft Gate")} description={L("门禁启用后固定开启，隐式注入禁止绕过的安全 Prompt。", "Always active when gating is enabled; injects strict safety rules.")}>
                <Switch size="small" checked disabled/>
              </SettingRow>
              <SettingRow inline className={!hookStatus.data?.installed && !hardGateEnabled ? 'opacity-60' : ''} title={L("硬门禁", "Hard Gate")} description={hookStatus.data?.installed ? L("Hook 已配置，可以开启硬门禁。", "Hook configured — Hard Gate is ready to enable.") : agentSelectionSaved ? hookStatus.data?.reason ?? L("请先检测并配置 Hook。", "Detect and configure Hook first.") : L("点击下方按钮会先保存当前默认 Agent，再检测并配置 Hook。", "Saves the default Agent first, then detects and installs the Hook.")}>
                <Switch size="small" checked={hardGateEnabled} disabled={!hardGateCanToggle} onChange={() => setHardGateEnabled(value => !value)}/>
              </SettingRow>
            </div>
            {hardGateHookMissing && <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[12px] leading-5 text-amber-800">{L("已保存的硬门禁 Hook 当前未检测到。其他设置仍可保存；如需恢复硬门禁，请先关闭上方开关，再重新检测并配置 Hook。", "Saved Hard Gate hook was not detected. Toggle off above and re-run detection to restore it.")}</div>}
            <button type="button" disabled={!current || hardGateEnabled || installHook.isPending || legacyHighRiskNeedsMigration || !workspace.trim() || !highRiskPatternValidation.valid || hookStatus.data?.supported === false} onClick={() => installHook.mutate()} className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white text-[12px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"><Wrench size={13}/>{installHook.isPending ? L("正在检测并配置 Hook", "Detecting & configuring Hook") : hookStatus.data?.installed ? L("重新检测并配置 Hook", "Re-detect & Configure Hook") : L("检测并配置 Hook", "Detect & Configure Hook")}</button>
            {hookStatus.data?.supported === false && <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[12px] leading-5 text-amber-800">{hookStatus.data.reason}</div>}
            {hookStatus.data?.trustInstructions && <div className="mt-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-[12px] leading-5 text-zinc-500">{hookStatus.data.trustInstructions}</div>}
          </div>}
          </>}
        </>}
        </DeferredMount>
        {savedBanner && <div role="status" className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] font-medium text-emerald-800"><CheckCircle2 size={14} className="shrink-0 text-emerald-600"/><span>{savedBanner}</span></div>}
        {formError && <div className="rounded-md border border-red-100 bg-red-50 px-2.5 py-2 text-[12px] leading-4 text-red-700"><div>{formError.message}</div>{permissionRelatedError && permissionSettingsUrl && <a href={permissionSettingsUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 font-medium text-red-800 underline decoration-red-300 underline-offset-2 hover:text-red-950">{L("打开当前机器人的权限配置", "Open bot permission settings")}<ExternalLink size={11}/></a>}</div>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-zinc-100 bg-white px-3.5 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:flex-nowrap sm:px-5 sm:py-3">
        {current ? <button type="button" onClick={() => { remove.reset(); setConfirmation('delete'); }} className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-medium text-red-600 hover:bg-red-50"><Trash2 size={13}/>{L("删除配置", "Delete Bot")}</button> : <span className="hidden text-[12px] text-zinc-400 sm:inline">{L("App ID 将作为唯一主键，不能重复配置", "App ID must be unique and cannot be duplicated")}</span>}
        <div className="ml-auto flex items-center gap-1.5">
          {step === 2 && <button type="button" onClick={() => setStep(1)} className="rounded-md px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100">{L("上一步", "Back")}</button>}
          {!embedded && <button type="button" onClick={requestClose} className="rounded-md px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100">{step === 2 && current && !current.setupComplete ? L("稍后完成", "Finish Later") : L("取消", "Cancel")}</button>}
          <button type="submit" disabled={!canSave || save.isPending} className="min-w-20 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-35">{save.isPending ? L("保存中", "Saving") : agentCapabilitiesPending ? L("读取模型中", "Loading models") : advancesToAgentStep ? L("下一步", "Next") : L("保存", "Save")}</button>
        </div>
      </div>
    </form>
  );

  return <>
    <ExitGate open={registrationOpen}>
      <LarkRegistrationDialog
        onClose={() => { setRegistrationOpen(false); void qc.invalidateQueries({ queryKey: ['lark-config'] }); }}
        onComplete={result => {
          qc.setQueryData(['lark-config'], result.config);
          setSelectedAppId(result.appId);
          setStep(1);
          setRegistrationOpen(false);
        }}
      />
    </ExitGate>
    {embedded ? formContent : (
      <div inert={registrationOpen} aria-hidden={registrationOpen || undefined} className="ui-overlay ui-overlay-sheet fixed inset-0 z-[60] grid place-items-center bg-zinc-950/25 p-0 sm:p-4" onMouseDown={event => { if (event.currentTarget === event.target) requestClose(); }}>
        {formContent}
      </div>
    )}
    <ConfirmDialog
      open={Boolean(confirmation)}
      tone={confirmation === 'delete' ? 'danger' : 'warning'}
      title={confirmation === 'delete' ? L("删除机器人配置？", "Delete bot configuration?") : confirmation === 'incomplete' ? L("稍后再完成配置？", "Finish setup later?") : L("放弃未保存的配置？", "Discard unsaved changes?")}
      description={confirmation === 'delete' ? L(`将删除“${current?.name ?? '当前机器人'}”的凭证、监听和门禁配置。已有会话记录不会删除。`, `Delete credentials, listener, and gate config for "${current?.name ?? 'this bot'}"? Existing session history is preserved.`) : confirmation === 'incomplete' ? L("Agent 配置尚未完成。若已开启监听，机器人仍会接收消息，并提示发送人补充运行配置。", "Agent setup is incomplete. If listening is enabled, incoming messages will prompt for configuration.") : L("当前填写的机器人信息尚未保存，关闭后需要重新填写。", "Unsaved bot settings will be lost if you close now.")}
      confirmLabel={confirmation === 'delete' ? L("确认删除", "Delete") : confirmation === 'incomplete' ? L("稍后完成", "Finish Later") : L("放弃修改", "Discard")}
      busy={confirmation === 'delete' && remove.isPending}
      error={confirmation === 'delete' && remove.error ? remove.error.message : undefined}
      onCancel={() => { if (!remove.isPending) setConfirmation(undefined); }}
      onConfirm={() => { if (confirmation === 'delete') remove.mutate(); else { setConfirmation(undefined); onClose(); } }}
    />
  </>;
}

export function LarkConfigModal(props: Omit<LarkConfigPanelProps, 'embedded'>) {
  return <LarkConfigPanel {...props} embedded={false}/>;
}
