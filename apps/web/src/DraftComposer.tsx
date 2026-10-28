import { useMemo, useRef, useState, type RefObject } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Agent, type Session } from './api';
import { Composer } from './Composer';
import { buildPrompt, getModelReadiness, referenceFromUpload, uploadSessionFile, type ComposerReference } from './composer-utils';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from './model-cache';

/**
 * 空态草稿 Composer：还不存在 Session 时，把输入框、Agent、工作目录、模型、思考强度和
 * 附件都收在这一个 Composer 里。提交时才 api.create → 上传暂存附件 → api.send。
 *
 * 附件为什么不能当场传：/api/sessions/:id/uploads 需要 sessionId。草稿态先建一枚本地引用
 * chip 占位（图片用 objectURL 预览），create 成功后再逐件上传、换成真实路径再拼 prompt。
 */
export function DraftComposer({ agents, sessions, onCreated, textareaRef }: {
  agents: Agent[];
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  sessions: Session[];
  onCreated(session: Session): void;
}) {
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState('');
  const [references, setReferences] = useState<ComposerReference[]>([]);
  const [agentId, setAgentId] = useState('');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const stashed = useRef(new Map<string, File>());
  const objectUrls = useRef(new Set<string>());
  const seq = useRef(0);

  // agents 异步到达：agentId 初值可能为空或已失效，渲染期兜底到最近使用过的 Agent，
  // 再退到列表第一个。与 App 的 effectiveAgentId 同思路，避免多渲染一帧非法值。
  const effectiveAgentId = agents.some(agent => agent.id === agentId)
    ? agentId
    : sessions.find(session => !session.archivedAt && agents.some(agent => agent.id === session.agentId))?.agentId || agents[0]?.id || '';
  const selectedAgent = agents.find(agent => agent.id === effectiveAgentId);
  const capabilities = useQuery({ queryKey: ['system-capabilities'], queryFn: api.systemCapabilities });
  const defaultWorkspace = selectedAgent?.cwd || capabilities.data?.workingDirectory;
  // 工作目录下拉的候选：Agent 默认目录 + 最近用过的会话目录，按使用顺序去重。
  const workspaceOptions = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const path of [defaultWorkspace, ...sessions.map(session => session.cwd)]) {
      if (!path || seen.has(path)) continue;
      seen.add(path);
      list.push(path);
    }
    return list.slice(0, 30);
  }, [defaultWorkspace, sessions]);

  const models = useQuery({
    queryKey: agentModelsQueryKey(effectiveAgentId, model),
    queryFn: () => loadAgentModels(effectiveAgentId, model || undefined),
    enabled: Boolean(effectiveAgentId),
    initialData: () => readCachedAgentModels(effectiveAgentId, model || undefined),
    initialDataUpdatedAt: 0,
    refetchOnMount: 'always',
    staleTime: 60_000
  });
  const skills = useQuery({ queryKey: ['skills', cwd], queryFn: () => api.skills(cwd || undefined), staleTime: 60_000 });
  const refreshModels = useMutation({
    mutationFn: () => loadAgentModels(effectiveAgentId, model || undefined, true),
    onSuccess: result => qc.setQueryData(agentModelsQueryKey(effectiveAgentId, model || undefined), result),
    onError: err => setError(err instanceof Error ? err.message : String(err))
  });
  const pickDirectory = useMutation({ mutationFn: api.selectDirectory, onSuccess: result => setCwd(result.path), onError: err => setError(err instanceof Error ? err.message : String(err)) });

  const modelReadiness = getModelReadiness({
    loaded: models.data !== undefined,
    loading: models.data === undefined && (models.isPending || models.isFetching || refreshModels.isPending),
    switching: false,
    failed: models.data === undefined && models.isError
  });

  const attach = async (file: File | Blob): Promise<ComposerReference> => {
    const id = `draft-${++seq.current}`;
    const name = 'name' in file ? file.name : '（未命名文件）';
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

  const submit = () => {
    if (creating || !effectiveAgentId) return;
    setError(undefined);
    const draftPrompt = prompt;
    const draftReferences = references;
    setCreating(true);
    void (async () => {
      let session: Session | undefined;
      try {
        session = await api.create({
          agentId: effectiveAgentId,
          ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {})
        });
        // create 之后附件才有归属会话：逐件上传，把占位 value 换成真实路径。
        const uploaded = await Promise.all(draftReferences.map(async reference => {
          const file = stashed.current.get(reference.id);
          if (!file) return reference;
          const result = await uploadSessionFile(session!.id, file);
          return referenceFromUpload(result, file.type.startsWith('image/'));
        }));
        const message = buildPrompt(draftPrompt, uploaded);
        if (message) await api.send(session.id, message, 'queue');
        void qc.invalidateQueries({ queryKey: ['sessions'] });
        void qc.invalidateQueries({ queryKey: ['tasks', session.id] });
        setPrompt('');
        setReferences([]);
        clearAttachments();
        onCreated(session);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        // 会话已建好但上传/发送失败：先切过去，避免用户丢掉草稿又看不到会话。
        if (session) {
          void qc.invalidateQueries({ queryKey: ['sessions'] });
          onCreated(session);
        }
      } finally {
        setCreating(false);
      }
    })();
  };

  return <div className="w-full max-w-[820px]">
    <div className="mb-5 text-center sm:mb-7">
      <img src="/agent-dock.svg" alt="" aria-hidden="true" className="mx-auto h-12 w-12"/>
      <h1 className="mt-5 text-xl font-semibold tracking-[-.03em]">选择 Agent，开始工作</h1>
      <p className="mt-2 text-sm leading-6 text-zinc-500">在同一个工作台中运行 Codex、Claude、Cursor、Pi、Trae 或自定义 ACP Agent。</p>
    </div>
    <Composer
      draft
      textareaRef={textareaRef}
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
      currentModel={model || models.data?.defaultModel}
      currentReasoningEffort={reasoningEffort || models.data?.defaultReasoningEffort}
      context={{}}
      advertisedCommands={[]}
      modelReadiness={modelReadiness}
      switchingModel={false}
      switchingReasoningEffort={false}
      refreshingModels={models.isFetching || refreshModels.isPending}
      agents={agents}
      currentAgentId={effectiveAgentId}
      onAgentChange={id => { setAgentId(id); setModel(''); setReasoningEffort(''); }}
      workspace={cwd}
      onWorkspaceChange={setCwd}
      workspaceSuggestion={defaultWorkspace}
      workspaceOptions={workspaceOptions}
      directoryPickerAvailable={capabilities.data?.directoryPicker}
      pickingDirectory={pickDirectory.isPending}
      onPickDirectory={() => pickDirectory.mutate()}
      onAttachFile={attach}
      onChange={setPrompt}
      onReferencesChange={setReferences}
      onModeChange={() => undefined}
      onSubmit={submit}
      onInterrupt={() => undefined}
      onCancelQueued={() => undefined}
      onSteerQueued={() => undefined}
      onEditQueued={() => undefined}
      onModelChange={setModel}
      onReasoningEffortChange={setReasoningEffort}
      onRefreshModels={() => refreshModels.mutate()}
    />
    {error && <p role="alert" className="mt-2 text-center text-[11px] text-red-600">{error}</p>}
    {references.length > 0 && <p className="mt-2 text-center text-[10px] text-zinc-400">{references.length} 个附件会在会话创建后上传</p>}
  </div>;
}
