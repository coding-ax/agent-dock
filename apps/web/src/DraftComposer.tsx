import { DockMascot } from './DockMascot';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { PawPrint } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  DEFAULT_ASK_USER_QUESTION_CONFIG,
  mergeSessionOutputPluginsPatch,
  type OutputPluginCatalogItem,
  type OutputPluginsGlobalConfig
} from '@agent-dock/agent-dock-shared';
import { api, type Agent, type Session } from './api';
import { Composer, type ComposerOutputPluginItem } from './Composer';
import { openAppDialog } from './dialog-store';
import {
  buildEffectiveGlobalPluginsConfig,
  buildFallbackOutputPluginCatalogItems,
  buildSessionOutputPluginItems
} from './output-plugins/useOutputPlugins';
import { PromptTemplates } from './PromptTemplates';
import { translateUnmodifiedBuiltinPrompt } from './prompt-templates';
import type { ComposerEditorHandle } from './ComposerEditor';
import { buildPrompt, getModelReadiness, referenceFromUpload, uploadSessionFile, type ComposerReference } from './composer-utils';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels, readInitialAgentModels } from './model-cache';
import {
  buildWorkspaceOptions,
  DRAFT_COMPOSER_PREFS_STORAGE_KEY,
  getPreferredAgentModel,
  getPreferredAgentReasoningEffort,
  readDraftComposerPrefs,
  resolveEffectiveAgentId,
  resolveEffectiveModel,
  resolveEffectiveReasoningEffort,
  resolveEffectiveWorkspace,
  withConfirmedDraftSubmission,
  withDraftOutputPluginOverride,
  withLastUsedAgent,
  withLastUsedModel,
  withLastUsedReasoningEffort,
  withLastUsedWorkspace,
  withoutDraftOutputPluginOverrides,
  withoutStaleAgentModel,
  withoutStaleAgentReasoning,
  writeDraftComposerPrefs,
  type DraftComposerPrefs
} from './last-used-prefs';
import { createClientMessageId } from './client-message-id';
import { clearSessionDraft, getBrowserDraftStorage, MAX_DRAFT_CHARS, saveSessionDraft } from './session-drafts';
import { useSessionDraftWriter } from './use-session-draft';
import { useBi, useLocale } from './i18n';

/**
 * 空态草稿 Composer：还不存在 Session 时，把输入框、Agent、工作目录、模型、思考强度和
 * 附件都收在这一个 Composer 里。提交时才 api.create → 上传暂存附件 → api.send。
 *
 * 附件为什么不能当场传：/api/sessions/:id/uploads 需要 sessionId。草稿态先建一枚本地引用
 * chip 占位（图片用 objectURL 预览），create 成功后再逐件上传、换成真实路径再拼 prompt。
 */
export function DraftComposer({ agents, sessions, onCreated, editorRef, hero, collapsed = false, companion, askUserQuestionXmlEnabled = DEFAULT_ASK_USER_QUESTION_CONFIG.askUserQuestionXmlEnabled, outputPluginItems, outputPluginsGlobalConfig }: {
  agents: Agent[];
  editorRef?: RefObject<ComposerEditorHandle | null>;
  sessions: Session[];
  onCreated(session: Session): void;
  /** 替换默认的小猫 + 标题（首页舞台用）。 */
  hero?: ReactNode;
  /** 收起输入框（认领小猫时把注意力让给认领卡片）。 */
  collapsed?: boolean;
  /** 交给小猫：消息直接发进主会话，不新建会话；Agent / 目录 / 模型选择换成一枚锁定的小猫标签。 */
  companion?: { sessionId: string; agentId: string; name: string; onSent(): void };
  /** 全局默认 XML 询问卡片开关；未传时按默认开启处理（向后兼容）。 */
  askUserQuestionXmlEnabled?: boolean;
  /** 服务端下发的全部可用纯 XML 交互插件列表。 */
  outputPluginItems?: OutputPluginCatalogItem[];
  /** 全局默认插件开关配置。 */
  outputPluginsGlobalConfig?: OutputPluginsGlobalConfig;
}) {
  const L = useBi();
  const locale = useLocale();
  const prevLocaleRef = useRef(locale);
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState('');
  const [references, setReferences] = useState<ComposerReference[]>([]);
  const [prefs, setPrefs] = useState<DraftComposerPrefs>(() => readDraftComposerPrefs());
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const updatePrefs = (updater: (current: DraftComposerPrefs) => DraftComposerPrefs) => {
    const next = updater(prefsRef.current);
    if (next === prefsRef.current) return;
    prefsRef.current = next;
    writeDraftComposerPrefs(next);
    setPrefs(next);
  };
  const [rejectedProbeKeys, setRejectedProbeKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [modelJustSwitched, setModelJustSwitched] = useState(false);
  const [reasoningJustSwitched, setReasoningJustSwitched] = useState(false);
  const [askJustSwitched, setAskJustSwitched] = useState(false);
  const [switchingCompanionAsk, setSwitchingCompanionAsk] = useState(false);
  const modelSavedTimerRef = useRef<number | undefined>(undefined);
  const reasoningSavedTimerRef = useRef<number | undefined>(undefined);
  const askSavedTimerRef = useRef<number | undefined>(undefined);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  useEffect(() => () => {
    window.clearTimeout(modelSavedTimerRef.current);
    window.clearTimeout(reasoningSavedTimerRef.current);
    window.clearTimeout(askSavedTimerRef.current);
  }, []);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== DRAFT_COMPOSER_PREFS_STORAGE_KEY) return;
      const latest = readDraftComposerPrefs();
      prefsRef.current = latest;
      setPrefs(latest);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const stashed = useRef(new Map<string, File>());
  const objectUrls = useRef(new Set<string>());
  const seq = useRef(0);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const readLiveDraft = () => editorRef?.current?.getValue() ?? promptRef.current;
  const draftWriter = useSessionDraftWriter(companion?.sessionId, prompt, { skipEmptyValue: creating });

  // agents 异步到达：优先恢复上次选中的可用 Agent，失效时渲染期兜底到最近活跃会话的 Agent，
  // 再退到可用列表第一个，避免多渲染一帧非法值。
  const usableAgents = useMemo(() => agents.filter(agent => !agent.disabled), [agents]);
  const effectiveAgentId = resolveEffectiveAgentId(prefs.agentId, usableAgents, sessions);
  const selectedAgent = usableAgents.find(agent => agent.id === effectiveAgentId);
  const capabilities = useQuery({ queryKey: ['system-capabilities'], queryFn: api.systemCapabilities });
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, staleTime: 30_000 });
  const defaultWorkspace = selectedAgent?.cwd || capabilities.data?.workingDirectory;
  const effectiveCwd = resolveEffectiveWorkspace(prefs.cwd, projects.data);
  // 工作目录下拉的候选：当前有效目录 + Agent 默认目录 + 存在的项目目录 + 最近用过的会话目录，按顺序去重。
  const workspaceOptions = useMemo(() => buildWorkspaceOptions({
    currentWorkspace: effectiveCwd,
    defaultWorkspace,
    projects: projects.data,
    sessions
  }), [effectiveCwd, defaultWorkspace, projects.data, sessions]);

  const homeDirectory = capabilities.data?.homeDirectory;
  const preferredModel = getPreferredAgentModel(prefs, effectiveAgentId);
  const probeKey = effectiveAgentId && preferredModel ? `${effectiveAgentId}\0${preferredModel}` : '';
  const queryModel = probeKey && rejectedProbeKeys.has(probeKey) ? '' : preferredModel;

  const models = useQuery({
    queryKey: agentModelsQueryKey(effectiveAgentId, queryModel),
    queryFn: () => loadAgentModels(effectiveAgentId, queryModel || undefined),
    enabled: Boolean(effectiveAgentId),
    initialData: () => readInitialAgentModels(effectiveAgentId, queryModel || undefined),
    initialDataUpdatedAt: 0,
    // 同一 Agent 切换模型时沿用上一份目录避免下拉闪空；切换到不同 Agent 时不跨 Agent 复用，立即可见加载态或新 Agent 本地缓存。
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey?.[1] === effectiveAgentId ? previous : undefined),
    refetchOnMount: true,
    staleTime: 60_000
  });
  const effectiveModel = resolveEffectiveModel(queryModel, models.data, {
    isPlaceholderData: models.isPlaceholderData
  });
  const activeModelForReasoning = effectiveModel || models.data?.defaultModel || '';
  const preferredReasoningEffort = getPreferredAgentReasoningEffort(prefs, effectiveAgentId, activeModelForReasoning || undefined);
  const awaitingExactCatalog = Boolean(
    queryModel
    && models.dataUpdatedAt === 0
    && models.isFetching
    && !readCachedAgentModels(effectiveAgentId, queryModel)
  );
  const effectiveReasoningEffort = resolveEffectiveReasoningEffort(preferredReasoningEffort, models.data, {
    isPlaceholderData: models.isPlaceholderData,
    awaitingExactCatalog
  });

  // 服务端模型目录返回后自愈过期偏好：
  // - 确认已下线的模型从该 Agent 的记忆中清理；
  // - 若带旧模型探测直接报错或返回空告警目录，则自动不带 model 重试一次，避免卡死。
  useEffect(() => {
    if (!effectiveAgentId || !preferredModel || models.isFetching || models.isPlaceholderData) return;
    if (models.data && models.dataUpdatedAt > 0 && !models.data.warning && models.data.models.length > 0) {
      if (!models.data.models.some(item => item.id === preferredModel)) {
        updatePrefs(current => withoutStaleAgentModel(current, effectiveAgentId, preferredModel));
      }
      return;
    }
    if (probeKey && !rejectedProbeKeys.has(probeKey) && (models.isError || (models.data?.warning && models.data.models.length === 0))) {
      setRejectedProbeKeys(current => {
        if (current.has(probeKey)) return current;
        const next = new Set(current);
        next.add(probeKey);
        return next;
      });
    }
  }, [effectiveAgentId, preferredModel, probeKey, rejectedProbeKeys, models.data, models.dataUpdatedAt, models.isError, models.isFetching, models.isPlaceholderData]);

  useEffect(() => {
    if (!effectiveAgentId || !preferredReasoningEffort || effectiveReasoningEffort || models.isFetching || models.isPlaceholderData || awaitingExactCatalog) return;
    if (models.data && models.dataUpdatedAt > 0 && !models.data.warning) {
      updatePrefs(current => withoutStaleAgentReasoning(current, effectiveAgentId, preferredReasoningEffort, activeModelForReasoning || undefined));
    }
  }, [effectiveAgentId, preferredReasoningEffort, effectiveReasoningEffort, activeModelForReasoning, awaitingExactCatalog, models.data, models.dataUpdatedAt, models.isFetching, models.isPlaceholderData]);

  const skills = useQuery({ queryKey: ['skills', effectiveCwd], queryFn: () => api.skills(effectiveCwd || undefined), staleTime: 60_000 });
  const refreshModels = useMutation({
    mutationFn: () => loadAgentModels(effectiveAgentId, queryModel || undefined, true),
    onSuccess: result => qc.setQueryData(agentModelsQueryKey(effectiveAgentId, queryModel || undefined), result),
    onError: err => setError(err instanceof Error ? err.message : String(err))
  });
  const pickDirectory = useMutation({
    mutationFn: api.selectDirectory,
    onSuccess: result => updatePrefs(current => withLastUsedWorkspace(current, result.path, effectiveAgentId)),
    onError: err => setError(err instanceof Error ? err.message : String(err))
  });

  const modelReadiness = getModelReadiness({
    loaded: models.data !== undefined,
    loading: models.data === undefined && (models.isPending || models.isFetching || refreshModels.isPending),
    switching: false,
    failed: models.data === undefined && models.isError
  });

  const attach = async (file: File | Blob): Promise<ComposerReference> => {
    const id = `draft-${++seq.current}`;
    const name = 'name' in file ? file.name : L("（未命名文件）", "(Untitled file)");
    const isImage = file.type.startsWith('image/');
    if (file instanceof File) stashed.current.set(id, file);
    const url = isImage ? URL.createObjectURL(file) : undefined;
    if (url) objectUrls.current.add(url);
    return { id, kind: isImage ? 'image' : 'file', label: name, value: id, ...(url ? { url } : {}) };
  };

  const clearAttachments = () => {
    for (const url of objectUrls.current) URL.revokeObjectURL(url);
    objectUrls.current.clear();
    stashed.current.clear();
  };

  const lastTemplateInsertRef = useRef<{ raw: string; editorText: string } | null>(null);

  useEffect(() => {
    const prevLocale = prevLocaleRef.current;
    prevLocaleRef.current = locale;
    if (prevLocale === locale) return;
    const live = readLiveDraft();
    const lastInsert = lastTemplateInsertRef.current;
    const candidate = lastInsert && live === lastInsert.editorText ? lastInsert.raw : live;
    const translated = translateUnmodifiedBuiltinPrompt(candidate, prevLocale, locale);
    if (!translated) return;
    if (editorRef?.current) {
      editorRef.current.setValue(translated);
      lastTemplateInsertRef.current = { raw: translated, editorText: editorRef.current.getValue() };
    } else {
      setPrompt(translated);
      lastTemplateInsertRef.current = { raw: translated, editorText: translated };
    }
  }, [locale]);

  const useTemplate = (text: string) => {
    if (editorRef?.current) {
      editorRef.current.setValue(text);
      lastTemplateInsertRef.current = { raw: text, editorText: editorRef.current.getValue() };
    } else {
      setPrompt(text);
      lastTemplateInsertRef.current = { raw: text, editorText: text };
    }
    // 填入后把焦点送回编辑器，用户可以直接改内容或按 Enter 发送。
    requestAnimationFrame(() => editorRef?.current?.focus());
  };

  const sendToCompanion = (target: NonNullable<typeof companion>, draftPrompt: string) => {
    const draftReferences = references;
    const clientMessageId = createClientMessageId();
    setCreating(true);
    void (async () => {
      try {
        const uploaded = await Promise.all(draftReferences.map(async reference => {
          const file = stashed.current.get(reference.id);
          if (!file) return reference;
          const result = await uploadSessionFile(target.sessionId, file);
          return referenceFromUpload(result, file.type.startsWith('image/'));
        }));
        const message = buildPrompt(draftPrompt, uploaded);
        if (message) await api.send(target.sessionId, message, 'queue', undefined, clientMessageId);
        void qc.invalidateQueries({ queryKey: ['sessions'] });
        void qc.invalidateQueries({ queryKey: ['tasks', target.sessionId] });
        // 组件可能紧接着卸载：先让 pending 写入失效，别让卸载时的 flush 把已发送内容写回来。
        draftWriter.cancel();
        const draftStorage = getBrowserDraftStorage();
        const liveDraft = readLiveDraft();
        const keptNewDraft = Boolean(liveDraft.trim()) && liveDraft !== draftPrompt;
        if (keptNewDraft) {
          saveSessionDraft(draftStorage, target.sessionId, liveDraft);
          setPrompt(liveDraft);
        } else {
          clearSessionDraft(draftStorage, target.sessionId);
          // 同 SessionPane：prompt 可能本来就是空串，必须直接清编辑器。
          editorRef?.current?.setValue('');
          setPrompt('');
        }
        setReferences([]);
        clearAttachments();
        target.onSent();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setCreating(false);
      }
    })();
  };

  const companionSession = companion ? sessions.find(item => item.id === companion.sessionId) : undefined;
  const effectivePluginCatalog = useMemo<OutputPluginCatalogItem[]>(
    () => (outputPluginItems?.length ? outputPluginItems : buildFallbackOutputPluginCatalogItems()),
    [outputPluginItems]
  );
  const effectiveGlobalPluginsConfig = useMemo<OutputPluginsGlobalConfig>(
    () => buildEffectiveGlobalPluginsConfig(effectivePluginCatalog, outputPluginsGlobalConfig, askUserQuestionXmlEnabled),
    [effectivePluginCatalog, outputPluginsGlobalConfig, askUserQuestionXmlEnabled]
  );

  const draftOutputPluginOverrides: Record<string, boolean | null> = useMemo(() => {
    if (companion) {
      return companionSession?.outputPlugins ?? (
        typeof companionSession?.askUserQuestionEnabled === 'boolean'
          ? { [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: companionSession.askUserQuestionEnabled }
          : {}
      );
    }
    return prefs.outputPlugins ?? (
      typeof prefs.askUserQuestionEnabled === 'boolean'
        ? { [BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]: prefs.askUserQuestionEnabled }
        : {}
    );
  }, [companion, companionSession?.outputPlugins, companionSession?.askUserQuestionEnabled, prefs.outputPlugins, prefs.askUserQuestionEnabled]);

  const composerOutputPlugins = useMemo<ComposerOutputPluginItem[]>(
    () => buildSessionOutputPluginItems(
      effectivePluginCatalog,
      effectiveGlobalPluginsConfig,
      draftOutputPluginOverrides,
      companion ? companionSession?.askUserQuestionEnabled : prefs.askUserQuestionEnabled
    ),
    [effectivePluginCatalog, effectiveGlobalPluginsConfig, draftOutputPluginOverrides, companion, companionSession?.askUserQuestionEnabled, prefs.askUserQuestionEnabled]
  );

  const [switchingCompanionPluginId, setSwitchingCompanionPluginId] = useState<string>();

  const handleSetDraftOutputPlugin = (pluginId: string, next: boolean | null) => {
    setAskJustSwitched(true);
    window.clearTimeout(askSavedTimerRef.current);
    askSavedTimerRef.current = window.setTimeout(() => setAskJustSwitched(false), 900);
    if (companion) {
      const previousSession = qc.getQueryData<Session[]>(['sessions'])?.find(item => item.id === companion.sessionId) ?? companionSession;
      const merged = mergeSessionOutputPluginsPatch(
        previousSession?.outputPlugins,
        { [pluginId]: next },
        previousSession?.askUserQuestionEnabled
      );
      const nextAsk = typeof merged[BUILTIN_ASK_USER_QUESTION_PLUGIN_ID] === 'boolean'
        ? merged[BUILTIN_ASK_USER_QUESTION_PLUGIN_ID]
        : null;
      setSwitchingCompanionPluginId(pluginId);
      setSwitchingCompanionAsk(true);
      qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => (
        item.id === companion.sessionId
          ? { ...item, outputPlugins: Object.keys(merged).length ? merged : undefined, askUserQuestionEnabled: nextAsk }
          : item
      )));
      void api.setSessionOutputPlugins(companion.sessionId, { [pluginId]: next }).then(updated => {
        setSwitchingCompanionPluginId(undefined);
        setSwitchingCompanionAsk(false);
        qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => (
          item.id === updated.id ? updated : item
        )));
      }).catch(err => {
        setSwitchingCompanionPluginId(undefined);
        setSwitchingCompanionAsk(false);
        setAskJustSwitched(false);
        qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => (
          item.id === companion.sessionId && previousSession ? previousSession : item
        )));
        setError(err instanceof Error ? err.message : String(err));
      });
      return;
    }
    const targetPlugin = composerOutputPlugins.find(item => item.id === pluginId);
    // 切回与全局默认一致或显式 null 时移除覆写，自动恢复跟随全局默认。
    const effectiveOverride = next === null || (targetPlugin && next === targetPlugin.globalEnabled) ? undefined : next;
    updatePrefs(current => withDraftOutputPluginOverride(current, pluginId, effectiveOverride));
  };

  const handleResetAllDraftOutputPlugins = () => {
    setAskJustSwitched(true);
    window.clearTimeout(askSavedTimerRef.current);
    askSavedTimerRef.current = window.setTimeout(() => setAskJustSwitched(false), 900);
    if (companion) {
      const resetPatch: Record<string, null> = {};
      for (const item of composerOutputPlugins) {
        if (item.override !== null) resetPatch[item.id] = null;
      }
      if (!Object.keys(resetPatch).length) return;
      const previousSession = companionSession;
      setSwitchingCompanionAsk(true);
      qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => (
        item.id === companion.sessionId ? { ...item, outputPlugins: undefined, askUserQuestionEnabled: null } : item
      )));
      void api.setSessionOutputPlugins(companion.sessionId, resetPatch).then(updated => {
        setSwitchingCompanionAsk(false);
        qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => (
          item.id === updated.id ? updated : item
        )));
      }).catch(err => {
        setSwitchingCompanionAsk(false);
        qc.setQueryData<Session[]>(['sessions'], current => current?.map(item => (
          item.id === companion.sessionId && previousSession ? previousSession : item
        )));
        setError(err instanceof Error ? err.message : String(err));
      });
      return;
    }
    updatePrefs(current => withoutDraftOutputPluginOverrides(current));
  };

  const submit = (submittedValue: string) => {
    if (creating) return;
    setError(undefined);
    if (companion) { sendToCompanion(companion, submittedValue); return; }
    if (!effectiveAgentId) return;
    const draftPrompt = submittedValue;
    const draftReferences = references;
    const clientMessageId = createClientMessageId();
    // 提交时同步巩固本次生效的草稿配置，确保即使沿用推断出的 Agent 或刚恢复的配置也被可靠记住。
    updatePrefs(current => withConfirmedDraftSubmission(current, {
      agentId: effectiveAgentId,
      cwd: effectiveCwd,
      model: effectiveModel,
      reasoningEffort: effectiveReasoningEffort
    }));
    setCreating(true);
    void (async () => {
      let session: Session | undefined;
      try {
        const cleanDraftOverrides: Record<string, boolean> = {};
        for (const [k, v] of Object.entries(draftOutputPluginOverrides)) {
          if (typeof v === 'boolean') cleanDraftOverrides[k] = v;
        }
        const askExplicit = cleanDraftOverrides[BUILTIN_ASK_USER_QUESTION_PLUGIN_ID];
        session = await api.create({
          agentId: effectiveAgentId,
          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
          ...(effectiveModel ? { model: effectiveModel } : {}),
          ...(effectiveReasoningEffort ? { reasoningEffort: effectiveReasoningEffort } : {}),
          ...(systemPrompt.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
          ...(Object.keys(cleanDraftOverrides).length ? { outputPlugins: cleanDraftOverrides } : {}),
          ...(typeof askExplicit === 'boolean' ? { askUserQuestionEnabled: askExplicit } : {})
        });
        // create 后立刻按真实 sessionId 落草稿：后续上传/发送失败切进会话时还能恢复输入。
        if (draftPrompt) saveSessionDraft(getBrowserDraftStorage(), session.id, draftPrompt);
        // create 之后附件才有归属会话：逐件上传，把占位 value 换成真实路径。
        const uploaded = await Promise.all(draftReferences.map(async reference => {
          const file = stashed.current.get(reference.id);
          if (!file) return reference;
          const result = await uploadSessionFile(session!.id, file);
          return referenceFromUpload(result, file.type.startsWith('image/'));
        }));
        const message = buildPrompt(draftPrompt, uploaded);
        if (message) await api.send(session.id, message, 'queue', undefined, clientMessageId);
        void qc.invalidateQueries({ queryKey: ['sessions'] });
        void qc.invalidateQueries({ queryKey: ['tasks', session.id] });
        draftWriter.cancel();
        const draftStorage = getBrowserDraftStorage();
        const liveDraft = readLiveDraft();
        const keptNewDraft = Boolean(liveDraft.trim()) && liveDraft !== draftPrompt;
        if (keptNewDraft) {
          saveSessionDraft(draftStorage, session.id, liveDraft);
          setPrompt(liveDraft);
        } else {
          clearSessionDraft(draftStorage, session.id);
          editorRef?.current?.setValue('');
          setPrompt('');
        }
        setReferences([]);
        setSystemPrompt('');
        clearAttachments();
        onCreated(session);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        // 会话已建好但上传/发送失败：先切过去，避免用户丢掉草稿又看不到会话。
        if (session) {
          // 失败保留草稿；用户在请求期间又改了输入，就保存最新内容。
          saveSessionDraft(getBrowserDraftStorage(), session.id, readLiveDraft());
          void qc.invalidateQueries({ queryKey: ['sessions'] });
          onCreated(session);
        }
      } finally {
        setCreating(false);
      }
    })();
  };

  // my-auto：内容比视口矮时垂直居中；比视口高时自动退化为 0，滚动容器不会把顶部的吉祥物裁掉。
  // min-w-0：这一层是页面横向 flex 的子项，默认 min-width:auto 会被认领卡片里的长路径撑出视口。
  return <div className="relative my-auto w-full min-w-0 max-w-[720px]">
    {hero ?? <div className="flex flex-col items-center text-center">
      <DockMascot size={88}/>
      <h1 className="ui-empty-state ui-hero-title mt-4 text-[22px] font-semibold tracking-[-.02em]">{L("有什么要做的？", "What would you like to build?")}</h1>
    </div>}
    <div className="ui-collapse" data-collapsed={collapsed || undefined} aria-hidden={collapsed || undefined} inert={collapsed}><div className="min-w-0">
    <div className="mt-6">
    <Composer
      draft
      {...(companion ? {
        placeholder: <><span className="hidden sm:inline">{L("跟", "Ask ")}{companion.name}{L("说说要做什么，Enter 发送；它会派侧边会话去办", " what to do (Enter to send; it will dispatch side sessions)")}</span><span className="sm:hidden">{L("跟", "Ask ")}{companion.name}{L("说说要做什么", " what to do")}</span></>,
        sendLabel: L(`交给${companion.name}`, `Send to ${companion.name}`),
        lockedTarget: <span title={L(`消息会发进主会话，由${companion.name}安排`, `Sent to main session for ${companion.name} to coordinate`)} className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-zinc-100 px-2.5 text-[12px] font-medium text-zinc-700"><PawPrint size={12}/>{companion.name}  {L("· 主会话", "· Main")}</span>
      } : {})}
      editorRef={editorRef}
      sessionId=""
      state="idle"
      value={prompt}
      references={references}
      sending={creating}
      mode="queue"
      queuedTasks={[]}
      skills={skills.data ?? []}
      models={models.data?.models ?? []}
      reasoningEfforts={models.data?.reasoningEfforts ?? []}
      currentModel={effectiveModel || models.data?.defaultModel}
      currentReasoningEffort={effectiveReasoningEffort || models.data?.defaultReasoningEffort}
      context={{}}
      advertisedCommands={[]}
      modelReadiness={modelReadiness}
      switchingModel={false}
      switchingReasoningEffort={false}
      modelJustSwitched={modelJustSwitched}
      reasoningJustSwitched={reasoningJustSwitched}
      refreshingModels={models.isFetching || refreshModels.isPending}
      agents={usableAgents}
      currentAgentId={companion?.agentId ?? effectiveAgentId}
      onAgentChange={id => {
        updatePrefs(current => withLastUsedAgent(current, id));
        setModelJustSwitched(false);
        setReasoningJustSwitched(false);
      }}
      workspace={effectiveCwd}
      onWorkspaceChange={next => updatePrefs(current => withLastUsedWorkspace(current, next, effectiveAgentId))}
      workspaceSuggestion={defaultWorkspace}
      homeDirectory={homeDirectory}
      workspaceOptions={workspaceOptions}
      directoryPickerAvailable={capabilities.data?.directoryPicker}
      pickingDirectory={pickDirectory.isPending}
      onPickDirectory={() => pickDirectory.mutate()}
      onAttachFile={attach}
      {...(!companion ? { systemPrompt, onSystemPromptChange: setSystemPrompt } : {})}
      outputPlugins={composerOutputPlugins}
      outputPluginsScope={companion ? 'companion' : 'draft'}
      outputPluginsScopeName={companion?.name}
      switchingOutputPluginId={switchingCompanionPluginId}
      switchingAskUserQuestion={switchingCompanionAsk}
      outputPluginsJustSwitched={askJustSwitched}
      onSetOutputPlugin={handleSetDraftOutputPlugin}
      onResetAllOutputPlugins={handleResetAllDraftOutputPlugins}
      onOpenOutputPluginsCenter={() => openAppDialog('output-plugins')}
      aiContext={() => ({
        field: companion ? L(`发给主小猫「${companion.name}」的指令`, `Instructions for ${companion.name}`) : L("新建会话首条消息", "First message for new session"),
        ...(selectedAgent?.name ? { agentName: selectedAgent.name } : {}),
        ...(effectiveCwd || defaultWorkspace ? { cwd: effectiveCwd || defaultWorkspace } : {}),
        ...(effectiveModel || models.data?.defaultModel ? { model: effectiveModel || models.data?.defaultModel } : {}),
        ...(systemPrompt.trim() ? { extra: L(`会话 System Prompt 摘要：${systemPrompt.trim().slice(0, 300)}`, `Session System Prompt: ${systemPrompt.trim().slice(0, 300)}`) } : {})
      })}
      onChange={setPrompt}
      onReferencesChange={setReferences}
      onModeChange={() => undefined}
      onSubmit={submit}
      onInterrupt={() => undefined}
      onCancelQueued={() => undefined}
      onSteerQueued={() => undefined}
      onEditQueued={() => undefined}
      onModelChange={next => {
        if (effectiveAgentId) {
          const key = `${effectiveAgentId}\0${next}`;
          setRejectedProbeKeys(current => {
            if (!current.has(key)) return current;
            const copy = new Set(current);
            copy.delete(key);
            return copy;
          });
          updatePrefs(current => withLastUsedModel(current, effectiveAgentId, next));
        }
        setModelJustSwitched(true);
        window.clearTimeout(modelSavedTimerRef.current);
        modelSavedTimerRef.current = window.setTimeout(() => setModelJustSwitched(false), 1200);
      }}
      onReasoningEffortChange={next => {
        if (effectiveAgentId) {
          updatePrefs(current => withLastUsedReasoningEffort(current, effectiveAgentId, next, activeModelForReasoning || undefined));
        }
        setReasoningJustSwitched(true);
        window.clearTimeout(reasoningSavedTimerRef.current);
        reasoningSavedTimerRef.current = window.setTimeout(() => setReasoningJustSwitched(false), 1200);
      }}
      onRefreshModels={() => refreshModels.mutate()}
    />
    </div>
    {!companion && <PromptTemplates onUse={useTemplate}/>}
    {prompt.length > MAX_DRAFT_CHARS && <p role="status" className="mt-2 text-center text-[12px] text-amber-600">{L("草稿超过", "Draft exceeds ")} {MAX_DRAFT_CHARS.toLocaleString()}  {L("字符，超出部分不会保存，刷新后会丢失。", " chars; the excess will not be saved across refresh.")}</p>}
    {error && <p role="alert" className="mt-2 text-center text-[12px] text-red-600">{error}</p>}
    {references.length > 0 && <p className="mt-2 text-center text-[12px] text-zinc-400">{references.length}  {L("个附件会在", " attachment(s) will upload after ")}{companion ? L("发送", "sending") : L("会话创建", "session creation")}{L("后上传", "")}</p>}
    </div></div>
  </div>;
}
