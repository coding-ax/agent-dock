import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import { Input } from 'antd';
import { api, type LlmFormat } from './api';
import { CompactSelect } from './CompactSelect';

// 与 Agent 表单同一套输入样式：原生 <select> 的高度/圆角/字体不受控，和旁边的输入框
// 放一起会明显不齐，所以下拉一律用 CompactSelect。
const labelClass = 'text-[11px] font-medium text-zinc-700';
const hintClass = 'mt-1 text-[10px] leading-4 text-zinc-400';
const buttonSecondary = 'flex h-9 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 text-[12px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40';

/** 表单草稿。apiKey 空串的语义是「沿用已存的那把」，所以它不参与「是否已配置」的判断。 */
interface EndpointDraft {
  format: LlmFormat;
  baseUrl: string;
  /** 只在用户真的输入了新密钥时才非空。 */
  apiKey: string;
  model: string;
}

const emptyDraft: EndpointDraft = { format: 'openai-chat', baseUrl: '', apiKey: '', model: '' };

/**
 * 模型端点配置：平台拿模型能力的唯一来源。
 *
 * 一个 Base URL + 一把 Key + 一种线格式 + 一个模型名，一次 HTTP 往返——不再为了用一次
 * 模型去冷启动一个完整 Agent 进程。格式的选项与 Base URL 示例由服务端下发，前端不抄一份。
 */
export function LlmEndpointPanel() {
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: ['llm'], queryFn: api.llm, refetchOnWindowFocus: false });
  const [draft, setDraft] = useState<EndpointDraft>(emptyDraft);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string }>();
  const [hydrated, setHydrated] = useState(false);
  // 试跑走流式：增量累积在这里实时渲染。用 ref 存中止函数，面板卸载时要把连接掐掉。
  const [streamed, setStreamed] = useState<string>();
  const [testing, setTesting] = useState(false);
  const abortRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => abortRef.current?.(), []);

  const saved = state.data;
  // 水合：把已存的端点填回表单，但密钥永远留空——服务端不回传它，用户想改再输。
  useEffect(() => {
    if (!saved || hydrated) return;
    setDraft({
      format: saved.format ?? 'openai-chat',
      baseUrl: saved.baseUrl ?? '',
      apiKey: '',
      model: saved.model ?? ''
    });
    setHydrated(true);
  }, [saved, hydrated]);

  const formats = saved?.formats ?? [];
  const activeFormat = formats.find(item => item.value === draft.format);
  const hasKey = Boolean(saved?.apiKeySet);

  const patch = (partial: Partial<EndpointDraft>) => { setDraft(current => ({ ...current, ...partial })); setFeedback(undefined); };

  const save = useMutation({
    mutationFn: async () => api.saveLlm({
      format: draft.format,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      // 空串不下发：服务端把它当作「沿用已存的密钥」。首次配置没密钥由服务端报 400。
      ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {})
    }),
    onSuccess: () => { setFeedback(undefined); setDraft(current => ({ ...current, apiKey: '' })); void queryClient.invalidateQueries({ queryKey: ['llm'] }); },
    onError: error => setFeedback({ ok: false, message: error instanceof Error ? error.message : String(error) })
  });
  const clear = useMutation({
    mutationFn: async () => api.clearLlm(),
    onSuccess: () => { setDraft(emptyDraft); setHydrated(false); setFeedback(undefined); void queryClient.invalidateQueries({ queryKey: ['llm'] }); },
    onError: error => setFeedback({ ok: false, message: error instanceof Error ? error.message : String(error) })
  });

  /**
   * 试跑。走流式把字实时显示出来——冷启动被换成一次 HTTP 往返之后，剩下的等待
   * 主要是模型自己的推理时间，边等边看比盯着转圈好。onDelta 是旁路，最终结果以 done 为准。
   */
  function runTest() {
    abortRef.current?.();
    setStreamed('');
    setFeedback(undefined);
    setTesting(true);
    abortRef.current = api.testLlmStream({
      onDelta: text => setStreamed(current => (current ?? '') + text),
      onDone: result => {
        setTesting(false);
        // 以 done 的完整文本为准：万一某个增量事件丢了，这里仍能拿到全文。
        setStreamed(result.text);
        setFeedback({ ok: true, message: result.truncated ? '试跑通过，但回答因长度上限被截断。' : '试跑通过。' });
      },
      onFailed: error => { setTesting(false); setStreamed(undefined); setFeedback({ ok: false, message: error.message }); }
    });
  }

  const canSave = Boolean(draft.baseUrl.trim() && draft.model.trim() && draft.format);

  return <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
    <div className="flex items-center gap-2">
      <span className="text-[13px] font-semibold text-zinc-800">模型端点</span>
      {saved?.configured
        ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">已配置</span>
        : <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] text-zinc-600">未配置</span>}
      {saved?.configured && <span className="ml-auto font-mono text-[10px] text-zinc-400">{saved.model}</span>}
    </div>
    <p className="mt-1.5 text-[11px] leading-5 text-zinc-500">
      平台要靠模型能力的功能（自动写描述、生成配置等）都走这里直连模型，一次 HTTP 往返。填好下面四项即可。
    </p>

    <div className="mt-4 grid grid-cols-2 gap-3">
      <div>
        <span className={labelClass}>格式</span>
        <CompactSelect options={formats.map(option => ({ value: option.value, label: option.label, meta: option.value }))} value={draft.format} placeholder="选择格式" disabledText="读取中…" onChange={value => patch({ format: value as LlmFormat })}/>
      </div>
      <div>
        <span className={labelClass}>模型</span>
        <Input size="large" className="mt-1.5 font-mono text-[12px]" value={draft.model} placeholder="例如 gpt-5 或 claude-fable-5" onChange={event => patch({ model: event.target.value })}/>
        <p className={hintClass}>填模型 id，不是显示名。</p>
      </div>
    </div>

    <div className="mt-3">
      <span className={labelClass}>Base URL</span>
      <Input size="large" className="mt-1.5 font-mono text-[12px]" value={draft.baseUrl} placeholder={activeFormat?.baseUrlPlaceholder ?? 'https://api.openai.com/v1'} onChange={event => patch({ baseUrl: event.target.value })}/>
      <p className={hintClass}>带不带 /v1 都可以，会自动补齐。</p>
    </div>

    <div className="mt-3">
      <span className={labelClass}>API Key</span>
      <Input.Password size="large" className="mt-1.5 font-mono text-[12px]" value={draft.apiKey} placeholder={hasKey ? '已保存，留空不修改' : 'sk-…'} autoComplete="off" onChange={event => patch({ apiKey: event.target.value })}/>
      <p className={hintClass}>明文存在本机数据库里，只在调用时发给你填的这个地址，不会下发给浏览器。</p>
    </div>

    <div className="mt-4 flex flex-wrap items-center gap-2">
      <button type="button" disabled={!canSave || save.isPending} onClick={() => save.mutate()} className="flex h-9 items-center gap-1.5 rounded-md bg-zinc-900 px-4 text-[12px] font-medium text-white hover:bg-zinc-800 disabled:opacity-40">{save.isPending && <LoaderCircle size={13} className="animate-spin"/>}保存</button>
      {saved?.configured && <>
        <button type="button" disabled={testing} onClick={runTest} className={buttonSecondary}>{testing ? <LoaderCircle size={13} className="animate-spin"/> : <RefreshCw size={13}/>}{testing ? '试跑中…' : '试跑'}</button>
        <button type="button" disabled={clear.isPending} onClick={() => clear.mutate()} className={`${buttonSecondary} ml-auto text-zinc-500`}><Trash2 size={13}/>清除</button>
      </>}
    </div>

    {/* 流式试跑的实时输出。空串也占位，让用户看到「已经在出了」而不是没反应。 */}
    {streamed !== undefined && <div className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
      <div className="text-[10px] font-medium text-zinc-400">模型输出{testing ? '（生成中…）' : ''}</div>
      <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-5 text-zinc-800">{streamed || (testing ? '…' : '（没有返回内容）')}</p>
    </div>}

    {feedback && <div className={`mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-[11px] leading-5 ${feedback.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}><AlertTriangle size={13} className="mt-0.5 shrink-0"/><span className="min-w-0 break-words">{feedback.message}</span></div>}
  </div>;
}
