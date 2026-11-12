import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Switch } from 'antd';
import { QRCodeSVG } from 'qrcode.react';
import {
  ArrowLeft, Bot, Check, CheckCircle2, CircleAlert, FolderOpen, Hash, LoaderCircle, MessageCircle,
  Pause, Play, RefreshCw, Search, Send, Settings2, ShieldCheck, Sparkles, UserRound, Users, Wifi, X
} from 'lucide-react';
import { CompactSelect } from './CompactSelect';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from './model-cache';
import { SuggestedValueInput } from './SuggestedValueInput';
import { useToast } from './Toast';
import { withSavedOption } from './lark-config-form';
import {
  api,
  type LarkAvatarConfigRecord,
  type LarkAvatarChatSummary,
  type LarkAvatarDraft,
  type LarkAvatarInboxItem,
  type LarkAvatarLoginSnapshot,
  type LarkAvatarRegion,
  type LarkAvatarStatus
} from './api';

type Tab = 'overview' | 'chats' | 'settings';
type Conversation = {
  key: string;
  threadKey: string;
  chatId: string;
  title: string;
  chatType: string;
  avatarUrl?: string;
  avatarFallbackUrl?: string;
  items: LarkAvatarInboxItem[];
  drafts: LarkAvatarDraft[];
  latestAt: string;
  latestText: string;
};
type ChatOption = LarkAvatarChatSummary & { avatarFallbackUrl?: string };

const input = 'mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-[12px] text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-500';
const field = 'text-[12px] font-medium text-zinc-600';
const section = 'rounded-xl border border-zinc-200 bg-white';
const splitList = (value: string) => value.split(/[\s,，]+/).map(item => item.trim()).filter(Boolean);
const errorText = (error: unknown) => error instanceof Error ? error.message : error ? String(error) : '';
const initial = (name?: string) => (name?.trim()?.[0] ?? '?').toUpperCase();
const timeLabel = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
};
const fullTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const chatTypeText = (type: LarkAvatarChatSummary['type']) =>
  type === 'group' ? '群聊' : type === 'topic' ? '话题群' : type === 'p2p' ? '私聊' : '飞书会话';

function Avatar({ name, src, fallbackSrc, size = 32 }: { name?: string; src?: string; fallbackSrc?: string; size?: number }) {
  const sources = [src, fallbackSrc].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
  const [sourceIndex, setSourceIndex] = useState(0);
  useEffect(() => setSourceIndex(0), [src, fallbackSrc]);
  const source = sources[sourceIndex];
  if (source) {
    return <img src={source} alt={name ?? ''} loading="lazy" referrerPolicy="no-referrer" onError={() => setSourceIndex(index => index + 1)} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  return <span className="grid shrink-0 place-items-center rounded-full bg-zinc-900 font-semibold text-white" style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.36)) }}>{initial(name)}</span>;
}

function Segmented<T extends string>({ value, onChange, options }: {
  value: T;
  onChange(value: T): void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="mt-1.5 grid gap-1 rounded-xl bg-zinc-100 p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors ${value === option.value ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function StatusPill({ connected, state, listening = true }: { connected?: boolean; state?: string; listening?: boolean }) {
  const paused = !listening && state !== 'expired';
  const expired = state === 'expired';
  const connecting = state === 'connecting';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${paused ? 'bg-amber-50 text-amber-700' : connected ? 'bg-emerald-50 text-emerald-700' : expired ? 'bg-amber-50 text-amber-700' : connecting ? 'bg-sky-50 text-sky-700' : 'bg-zinc-100 text-zinc-500'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${paused ? 'bg-amber-500' : connected ? 'bg-emerald-500' : expired ? 'bg-amber-500' : connecting ? 'bg-sky-500 animate-pulse' : 'bg-zinc-400'}`}/>
      {paused ? '已暂停' : connected ? '运行中' : expired ? '会话已失效' : connecting ? '正在重连' : '未连接'}
    </span>
  );
}

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3"><p className="text-[11px] text-zinc-500">{label}</p><p className="mt-1 text-[24px] font-semibold leading-none text-zinc-900">{value}</p>{hint && <p className="mt-1 text-[11px] text-zinc-400">{hint}</p>}</div>;
}

function ConnectView({
  config,
  status,
  open,
  setOpen,
  region,
  login,
  starting,
  error,
  cookie,
  setCookie,
  importing,
  onOpen,
  onStart,
  onRegion,
  onCancel,
  onCookieImport
}: {
  config?: LarkAvatarConfigRecord | null;
  status?: LarkAvatarStatus;
  open: boolean;
  setOpen(value: boolean): void;
  region: LarkAvatarRegion;
  login?: LarkAvatarLoginSnapshot;
  starting: boolean;
  error?: unknown;
  cookie: string;
  setCookie(value: string): void;
  importing: boolean;
  onOpen(): void;
  onStart(): void;
  onRegion(value: LarkAvatarRegion): void;
  onCancel(): void;
  onCookieImport(): void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const message = errorText(error) || login?.message;
  const waiting = login?.state === 'waiting' || login?.state === 'scanned';
  const success = login?.state === 'success';
  const failed = login?.state === 'failed';

  if (!open) {
    return (
      <div className="flex h-full items-center justify-center overflow-y-auto p-6">
        <div className="w-full max-w-[620px] text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-zinc-900 text-white shadow-sm"><Wifi size={25}/></div>
          <h2 className="mt-5 text-[22px] font-semibold tracking-tight text-zinc-900">连接你的飞书账号</h2>
          <p className="mx-auto mt-2 max-w-[520px] text-[13px] leading-6 text-zinc-500">直接扫码登录飞书网页端。消息通过本人身份的 WebSocket 常驻接收，并定时补拉群聊；收到触发词后 Agent 会结合上下文直接以你的身份回复。</p>
          <div className="mt-6 grid gap-2 text-left sm:grid-cols-3">
            {[
              ['1', '手机扫码', '用飞书或 Lark App 扫码确认'],
              ['2', '持续监听', 'WebSocket + 30 秒群聊补拉'],
              ['3', 'Agent 直接回复', '所有 AgentText 自动发回聊天']
            ].map(([step, title, hint]) => <div key={step} className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3"><span className="grid h-6 w-6 place-items-center rounded-full bg-white text-[11px] font-semibold text-zinc-700 shadow-sm">{step}</span><p className="mt-2 text-[12px] font-medium text-zinc-800">{title}</p><p className="mt-0.5 text-[11px] leading-4 text-zinc-500">{hint}</p></div>)}
          </div>
          {status?.lastError && <p className="mx-auto mt-4 max-w-[520px] rounded-lg bg-red-50 px-3 py-2 text-left text-[12px] text-red-700">{status.lastError}</p>}
          {config?.account && <p className="mt-5 text-[11px] text-zinc-400">上次连接 <span className="text-zinc-600">{config.account.name}</span>{config.account.userId ? ` · ${config.account.userId}` : ''}</p>}
          <Button type="primary" size="large" className="mt-6 !h-10 !rounded-lg !bg-zinc-900 !px-5 !text-[13px]" onClick={onOpen}>{config?.account ? '重新扫码连接' : '扫码连接'}</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-5">
      <button type="button" onClick={() => setOpen(false)} className="inline-flex items-center gap-1.5 text-[12px] text-zinc-500 hover:text-zinc-900"><ArrowLeft size={13}/>返回</button>
      <div className="mx-auto mt-4 max-w-[860px]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="text-[20px] font-semibold text-zinc-900">{status?.connected ? '重新连接账号' : '扫码连接飞书账号'}</h2><p className="mt-1 text-[12px] leading-5 text-zinc-500">不需要 App ID、App Secret，也不需要创建机器人。</p></div>
          <StatusPill connected={status?.connected} state={status?.state} listening={status?.listening}/>
        </div>

        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className={`${section} flex flex-col items-center p-5 text-center`}>
            <div className="flex w-full items-center justify-between">
              <h3 className="text-[13px] font-semibold text-zinc-900">手机扫码登录</h3>
              <div className="flex rounded-lg bg-zinc-100 p-0.5">
                {(['feishu', 'lark'] as const).map(value => <button key={value} type="button" onClick={() => onRegion(value)} disabled={starting} className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${region === value ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'}`}>{value === 'feishu' ? '飞书' : 'Lark'}</button>)}
              </div>
            </div>
            <div className="mt-4 grid h-[196px] w-[196px] place-items-center rounded-2xl bg-white p-2 ring-1 ring-zinc-200">
              {success ? <div className="text-center"><CheckCircle2 size={42} className="mx-auto text-emerald-500"/><p className="mt-2 text-[12px] font-medium text-zinc-800">登录成功</p></div>
                : waiting && login?.qrContent ? <QRCodeSVG value={login.qrContent} size={180} marginSize={2} title={`${region === 'feishu' ? '飞书' : 'Lark'}登录二维码`}/>
                : starting || login?.state === 'starting' ? <div className="text-center text-zinc-400"><LoaderCircle size={30} className="mx-auto animate-spin"/><p className="mt-2 text-[11px]">正在获取二维码</p></div>
                : <div className="text-center text-zinc-400"><CircleAlert size={30} className="mx-auto"/><p className="mt-2 max-w-[150px] text-[11px] leading-4">{failed ? '二维码获取失败' : '等待生成二维码'}</p></div>}
            </div>
            <p className={`mt-3 text-[12px] leading-5 ${failed ? 'text-red-600' : 'text-zinc-600'}`}>{message || (waiting ? '打开飞书 App，扫一扫二维码' : '正在准备登录…')}</p>
            <p className="mt-1 text-[10px] text-zinc-400">{login?.attempt ? `第 ${login.attempt} / 6 次` : '扫码后请在手机上确认'}{login?.state === 'scanned' ? ' · 已扫码' : ''}</p>
            <div className="mt-3 flex gap-2">
              <Button size="small" loading={starting} onClick={onStart}>{failed || success ? '重新生成' : '刷新二维码'}</Button>
              <Button size="small" onClick={onCancel}>取消</Button>
            </div>
          </div>

          <div className="space-y-3">
            <div className={`${section} p-4`}>
              <div className="flex items-center gap-2"><ShieldCheck size={15} className="text-zinc-500"/><h3 className="text-[13px] font-semibold text-zinc-900">登录后会发生什么</h3></div>
              <ul className="mt-3 space-y-2 text-[11px] leading-5 text-zinc-500">
                <li>· 凭证只保存在本机 SQLite，不会下发给浏览器。</li>
                <li>· 以你的本人身份建立长连接，不经过机器人。</li>
                <li>· Agent 的文本输出会直接以你的身份发回当前聊天。</li>
                <li>· 会话失效时状态会变为「会话已失效」，重新扫码即可。</li>
              </ul>
            </div>
            <div className={`${section} p-4`}>
              <button type="button" onClick={() => setAdvanced(value => !value)} className="flex w-full items-center justify-between text-left"><span className="text-[12px] font-medium text-zinc-700">高级：导入 Cookie</span><span className="text-[11px] text-zinc-400">{advanced ? '收起' : '展开'}</span></button>
              {advanced && <div className="mt-3">
                <p className="text-[11px] leading-5 text-zinc-500">扫码不可用时，可从已登录的飞书网页复制完整 Cookie。必须包含 <code className="rounded bg-zinc-100 px-1">session</code>。</p>
                <textarea value={cookie} onChange={event => setCookie(event.target.value)} placeholder="session=...; passport_web_did=...; swp_csrf_token=..." className={`${input} min-h-20 resize-y`}/>
                <Button size="small" className="mt-2" loading={importing} disabled={!cookie.trim()} onClick={onCookieImport}>导入 Cookie</Button>
              </div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DraftBlock({
  draft,
  body,
  onBody,
  onSend,
  onDiscard,
  sending,
  discarding,
  accountName,
  accountAvatarUrl
}: {
  draft: LarkAvatarDraft;
  body: string;
  onBody(value: string): void;
  onSend(): void;
  onDiscard(): void;
  sending: boolean;
  discarding: boolean;
  accountName?: string;
  accountAvatarUrl?: string;
}) {
  if (draft.state === 'sent') {
    const agentReply = Boolean(draft.itemId);
    return (
      <div className="mb-5 flex items-end justify-end gap-2.5">
        <div className="min-w-0 max-w-[78%] text-right">
          <div className="mb-1 flex flex-wrap items-center justify-end gap-2">
            <span className="text-[11px] font-medium text-zinc-700">{agentReply ? 'AI 替身' : accountName || '你'}</span>
            <span className="text-[10px] text-zinc-400">{fullTime(draft.sentAt ?? draft.updatedAt)}</span>
            <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700">已发送</span>
          </div>
          <div className="inline-block whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-sky-600 px-3.5 py-2.5 text-left text-[13px] leading-5 text-white">{draft.body}</div>
        </div>
        {agentReply
          ? <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-sky-600 text-white"><Sparkles size={13}/></span>
          : <Avatar name={accountName} src={accountAvatarUrl} size={28}/>}
      </div>
    );
  }
  if (draft.state === 'discarded') {
    return <div className="mb-5 max-w-[78%] rounded-lg border border-dashed border-zinc-200 px-3 py-2 text-[11px] text-zinc-400">已丢弃草稿：{draft.body || '（空）'}</div>;
  }
  return (
    <div className="mb-5 max-w-[78%] rounded-xl border border-zinc-200 bg-zinc-50/70 p-3">
      <div className="flex items-center justify-between gap-2"><span className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-600"><Sparkles size={12}/>Agent 回复</span>{draft.lastError && <span className="truncate text-[10px] text-red-600">{draft.lastError}</span>}</div>
      <textarea className={`${input} mt-2 min-h-20 resize-y bg-white`} value={body} placeholder="AI 没有生成正文，可以手动补充。" onChange={event => onBody(event.target.value)}/>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="small" type="primary" disabled={!body.trim()} loading={sending} onClick={onSend}>确认发送</Button>
        <Button size="small" danger loading={discarding} onClick={onDiscard}>丢弃</Button>
      </div>
    </div>
  );
}

export function LarkAvatarPanel() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['lark-avatar-status'], queryFn: api.larkAvatarStatus, refetchInterval: 5_000 });
  const config = useQuery({ queryKey: ['lark-avatar-config'], queryFn: api.larkAvatarConfig });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api.agents() });
  const capabilities = useQuery({ queryKey: ['system-capabilities'], queryFn: api.systemCapabilities });
  const connected = Boolean(status.data?.connected);
  const sessionReady = Boolean(status.data?.configured) && status.data?.state !== 'expired';
  const inbox = useQuery({ queryKey: ['lark-avatar-inbox'], queryFn: () => api.larkAvatarInbox(), refetchInterval: 5_000, enabled: sessionReady });
  const drafts = useQuery({ queryKey: ['lark-avatar-drafts'], queryFn: () => api.larkAvatarDrafts(), refetchInterval: 5_000, enabled: sessionReady });
  const [tab, setTab] = useState<Tab>('overview');
  const [showConnect, setShowConnect] = useState(false);
  const [region, setRegion] = useState<LarkAvatarRegion>('feishu');
  const [cookie, setCookie] = useState('');
  const [triggerPrefix, setTriggerPrefix] = useState('/ai');
  const [contextMessages, setContextMessages] = useState(10);
  const [contextScope, setContextScope] = useState<'anchor' | 'chat'>('anchor');
  const [replyInTopic, setReplyInTopic] = useState(true);
  const [replyMode, setReplyMode] = useState<'direct' | 'quote' | 'thread'>('direct');
  const [emojiReactions, setEmojiReactions] = useState(false);
  const [replySignature, setReplySignature] = useState('');
  const [agentTimeoutSeconds, setAgentTimeoutSeconds] = useState(7_200);
  const [listenMode, setListenMode] = useState<'all' | 'selected'>('all');
  const [listenChats, setListenChats] = useState<string[]>([]);
  const [manualChatIds, setManualChatIds] = useState('');
  const [chatSearch, setChatSearch] = useState('');
  const [agentId, setAgentId] = useState('');
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [selectedKey, setSelectedKey] = useState<string>();
  const [search, setSearch] = useState('');
  const [composer, setComposer] = useState('');
  const [draftBodies, setDraftBodies] = useState<Record<string, string>>({});
  const toast = useToast();
  const messagesRef = useRef<HTMLDivElement>(null);
  const autoOpened = useRef(false);
  const models = useQuery({
    queryKey: agentModelsQueryKey(agentId, model || undefined),
    queryFn: () => loadAgentModels(agentId, model || undefined),
    enabled: Boolean(agentId),
    initialData: () => readCachedAgentModels(agentId, model || undefined),
    initialDataUpdatedAt: 0,
    refetchOnMount: 'always',
    staleTime: 5 * 60_000
  });
  const availableChats = useQuery({
    queryKey: ['lark-avatar-chats'],
    queryFn: api.larkAvatarChats,
    enabled: sessionReady && tab === 'settings',
    staleTime: 20_000,
    refetchOnMount: 'always'
  });

  useEffect(() => {
    if (!config.data) return;
    setRegion(config.data.config.region);
    setTriggerPrefix(config.data.config.triggerPrefix);
    setContextMessages(config.data.config.contextMessages);
    setContextScope(config.data.config.contextScope);
    setReplyInTopic(config.data.config.replyInTopic);
    setReplyMode(config.data.config.replyMode);
    setEmojiReactions(config.data.config.emojiReactions);
    setReplySignature(config.data.config.replySignature);
    setAgentTimeoutSeconds(config.data.config.agentTimeoutSeconds);
    setListenChats(config.data.config.listenChats);
    setManualChatIds(config.data.config.listenChats.join(', '));
    setListenMode(config.data.config.listenChats.length ? 'selected' : 'all');
    setAgentId(config.data.config.agentId);
    setModel(config.data.config.model);
    setReasoningEffort(config.data.config.reasoningEffort);
    setWorkspace(config.data.config.workspace);
  }, [config.data?.id, config.data?.updatedAt, connected]);

  useEffect(() => {
    if (!agentId && agents.data?.length) setAgentId(agents.data[0]!.id);
  }, [agentId, agents.data]);

  useEffect(() => {
    if (connected) {
      setShowConnect(false);
      setTab(current => current === 'overview' ? current : 'overview');
    }
  }, [connected]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['lark-avatar-status'] });
    void qc.invalidateQueries({ queryKey: ['lark-avatar-config'] });
    void qc.invalidateQueries({ queryKey: ['lark-avatar-inbox'] });
    void qc.invalidateQueries({ queryKey: ['lark-avatar-drafts'] });
  };

  const saveConfig = useMutation({
    mutationFn: () => api.saveLarkAvatarConfig({
      region,
      triggerPrefix,
      contextMessages,
      contextScope,
      replyInTopic,
      replyMode,
      emojiReactions,
      replySignature,
      agentTimeoutSeconds,
      listenChats: listenMode === 'all' ? [] : splitList(manualChatIds),
      allowedSenders: [],
      agentId,
      model,
      reasoningEffort,
      workspace
    }),
    onSuccess: () => {
      toast.show('配置已保存，下一次触发生效', 'info');
      invalidate();
    }
  });
  const pickWorkspace = useMutation({ mutationFn: api.selectDirectory, onSuccess: result => setWorkspace(result.path) });
  const startLogin = useMutation({
    mutationFn: (value: LarkAvatarRegion) => api.startLarkAvatarLogin(value),
    onSuccess: snapshot => qc.setQueryData(['lark-avatar-login'], snapshot)
  });
  const cancelLogin = useMutation({
    mutationFn: api.cancelLarkAvatarLogin,
    onSuccess: snapshot => { qc.setQueryData(['lark-avatar-login'], snapshot); setShowConnect(false); }
  });
  const importCookie = useMutation({
    mutationFn: () => api.importLarkAvatarCookie({ cookie, region }),
    onSuccess: () => { setCookie(''); setShowConnect(false); setTab('overview'); invalidate(); }
  });
  const disconnect = useMutation({ mutationFn: api.disconnectLarkAvatar, onSuccess: () => { setShowConnect(false); invalidate(); } });
  const poll = useMutation({ mutationFn: api.pollLarkAvatar, onSuccess: invalidate });
  const setListening = useMutation({
    mutationFn: (enabled: boolean) => api.setLarkAvatarListening(enabled),
    onSuccess: invalidate
  });
  const loginStatus = useQuery({
    queryKey: ['lark-avatar-login'],
    queryFn: api.pollLarkAvatarLogin,
    enabled: showConnect && !connected,
    refetchInterval: showConnect && !connected ? 2_000 : false,
    retry: false
  });
  useEffect(() => {
    if (loginStatus.data?.state !== 'success') return;
    setShowConnect(false);
    setTab('overview');
    invalidate();
  }, [loginStatus.data?.state]);
  useEffect(() => {
    if (autoOpened.current || status.isPending || config.isPending) return;
    autoOpened.current = true;
    if (status.data?.configured && status.data.state !== 'expired') return;
    const selected = config.data?.config.region ?? 'feishu';
    setRegion(selected);
    setShowConnect(true);
    startLogin.mutate(selected);
  }, [status.isPending, config.isPending, status.data?.configured, status.data?.state]);
  const sendDraft = useMutation({
    mutationFn: (draft: LarkAvatarDraft) => api.sendLarkAvatarDraft(draft.id, draftBodies[draft.id] ?? draft.body),
    onSuccess: sent => { setDraftBodies(previous => { const next = { ...previous }; delete next[sent.id]; return next; }); invalidate(); }
  });
  const discardDraft = useMutation({
    mutationFn: (id: string) => api.discardLarkAvatarDraft(id),
    onSuccess: discarded => { setDraftBodies(previous => { const next = { ...previous }; delete next[discarded.id]; return next; }); invalidate(); }
  });
  const manualSend = useMutation({
    mutationFn: async ({ conversation, body }: { conversation: Conversation; body: string }) => {
      const draft = await api.createLarkAvatarDraft({ target: conversation.chatId, body, threadKey: conversation.threadKey });
      return api.sendLarkAvatarDraft(draft.id);
    },
    onSuccess: () => { setComposer(''); invalidate(); }
  });

  const items = inbox.data ?? [];
  const draftList = drafts.data ?? [];
  const itemById = useMemo(() => new Map(items.map(item => [item.id, item])), [items]);
  const conversations = useMemo(() => {
    const map = new Map<string, Conversation>();
    const ensure = (key: string, seed: { threadKey?: string; chatId?: string; title?: string; chatType?: string; avatarUrl?: string; avatarFallbackUrl?: string; at: string; text: string }) => {
      let conversation = map.get(key);
      if (!conversation) {
        conversation = {
          key,
          threadKey: seed.threadKey ?? seed.chatId ?? key,
          chatId: seed.chatId ?? '',
          title: seed.title ?? seed.chatId ?? '飞书会话',
          chatType: seed.chatType ?? '',
          ...(seed.avatarUrl ? { avatarUrl: seed.avatarUrl } : {}),
          ...(seed.avatarFallbackUrl ? { avatarFallbackUrl: seed.avatarFallbackUrl } : {}),
          items: [],
          drafts: [],
          latestAt: seed.at,
          latestText: seed.text
        };
        map.set(key, conversation);
      }
      if (seed.avatarUrl && !conversation.avatarUrl) conversation.avatarUrl = seed.avatarUrl;
      if (seed.avatarFallbackUrl) conversation.avatarFallbackUrl = seed.avatarFallbackUrl;
      if (seed.at > conversation.latestAt) { conversation.latestAt = seed.at; conversation.latestText = seed.text; }
      return conversation;
    };
    for (const item of items) {
      const key = item.threadKey || `chat:${item.chatId}`;
      const conversation = ensure(key, {
        threadKey: item.threadKey, chatId: item.chatId,
        title: item.chatName || item.senderName || item.chatId,
        chatType: item.chatType,
        avatarUrl: item.chatAvatarUrl || (item.chatType === 'p2p' ? item.senderAvatarUrl : undefined),
        // 群头像加载失败时退回群首字母；成员头像只适合私聊，不能拿来冒充群头像。
        avatarFallbackUrl: item.chatType === 'p2p' ? item.senderAvatarUrl : undefined,
        at: item.occurredAt, text: item.title
      });
      conversation.items.push(item);
    }
    for (const draft of draftList) {
      const item = draft.itemId ? itemById.get(draft.itemId) : undefined;
      const key = draft.threadKey || item?.threadKey || `chat:${draft.target}`;
      const conversation = ensure(key, {
        threadKey: draft.threadKey, chatId: item?.chatId || draft.target,
        title: item?.chatName || item?.senderName || draft.target,
        chatType: item?.chatType,
        avatarUrl: item?.chatAvatarUrl || (item?.chatType === 'p2p' ? item.senderAvatarUrl : undefined),
        avatarFallbackUrl: item?.chatType === 'p2p' ? item.senderAvatarUrl : undefined,
        at: draft.updatedAt, text: draft.body
      });
      conversation.drafts.push(draft);
    }
    for (const conversation of map.values()) {
      conversation.items.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
      conversation.drafts.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }
    return [...map.values()].sort((left, right) => right.latestAt.localeCompare(left.latestAt));
  }, [draftList, itemById, items]);

  useEffect(() => {
    if (!conversations.length) { setSelectedKey(undefined); return; }
    if (!selectedKey || !conversations.some(conversation => conversation.key === selectedKey)) setSelectedKey(conversations[0]!.key);
  }, [conversations, selectedKey]);

  const filtered = conversations.filter(conversation => {
    const query = search.trim().toLowerCase();
    return !query || conversation.title.toLowerCase().includes(query) || conversation.latestText.toLowerCase().includes(query);
  });
  const selected = conversations.find(conversation => conversation.key === selectedKey);
  const pendingDrafts = draftList.filter(draft => draft.state === 'pending' || draft.state === 'failed');
  const sentDrafts = draftList.filter(draft => draft.state === 'sent');
  const triggerCount = items.filter(item => item.title.trim().startsWith(triggerPrefix)).length;
  const selectedAgent = agents.data?.find(agent => agent.id === agentId);
  const agentOptions = (agents.data ?? []).map(agent => ({ value: agent.id, label: agent.name, agentId: agent.id }));
  const modelOptions = [
    { value: '', label: models.data?.defaultModel ? `Agent 默认（${models.data.defaultModel}）` : 'Agent 默认模型' },
    ...withSavedOption(models.data?.models ?? [], model).map(option => ({ value: option.id, label: option.name }))
  ];
  const reasoningOptions = [
    { value: '', label: models.data?.defaultReasoningEffort ? `Agent 默认（${models.data.defaultReasoningEffort}）` : 'Agent 默认强度' },
    ...withSavedOption(models.data?.reasoningEfforts ?? [], reasoningEffort).map(option => ({ value: option.id, label: option.name }))
  ];
  const chatOptions = useMemo(() => {
    const map = new Map<string, ChatOption>();
    for (const item of items) {
      if (!item.chatId) continue;
      const current = map.get(item.chatId);
      const type = item.chatType === 'p2p' || item.chatType === 'group' || item.chatType === 'topic'
        ? item.chatType
        : current?.type ?? 'unknown';
      const avatarUrl = item.chatAvatarUrl || current?.avatarUrl || (type === 'p2p' ? item.senderAvatarUrl : undefined);
      const avatarFallbackUrl = type === 'p2p' ? item.senderAvatarUrl || current?.avatarFallbackUrl : undefined;
      map.set(item.chatId, {
        id: item.chatId,
        name: item.chatName || current?.name || item.senderName || item.chatId,
        type,
        ...(avatarUrl ? { avatarUrl } : {}),
        ...(avatarFallbackUrl ? { avatarFallbackUrl } : {}),
        ...(current?.memberCount ? { memberCount: current.memberCount } : {}),
        ...(item.occurredAt ? { lastMessageAt: item.occurredAt } : current?.lastMessageAt ? { lastMessageAt: current.lastMessageAt } : {})
      });
    }
    for (const chat of availableChats.data ?? []) {
      const current = map.get(chat.id);
      map.set(chat.id, {
        ...(current ?? {}),
        ...chat,
        ...(current?.avatarFallbackUrl ? { avatarFallbackUrl: current.avatarFallbackUrl } : {})
      });
    }
    for (const id of listenChats) {
      if (!map.has(id)) map.set(id, { id, name: id, type: 'unknown' });
    }
    return [...map.values()].sort((left, right) =>
      (left.type === 'group' || left.type === 'topic' ? 0 : 1) - (right.type === 'group' || right.type === 'topic' ? 0 : 1)
      || (right.lastMessageAt ?? '').localeCompare(left.lastMessageAt ?? '')
      || left.name.localeCompare(right.name, 'zh-CN')
    );
  }, [availableChats.data, items, listenChats]);
  const filteredChatOptions = chatOptions.filter(chat => {
    const query = chatSearch.trim().toLowerCase();
    return !query || chat.name.toLowerCase().includes(query) || chat.id.toLowerCase().includes(query);
  });
  const selectChats = (next: string[]) => {
    setListenChats(next);
    setManualChatIds(next.join(', '));
  };
  const toggleChat = (id: string) => {
    selectChats(listenChats.includes(id) ? listenChats.filter(value => value !== id) : [...listenChats, id]);
  };
  const selectedTimeline = selected ? [
    ...selected.items.map(item => ({ kind: 'item' as const, at: item.occurredAt, item })),
    ...selected.drafts.map(draft => ({
      kind: 'draft' as const,
      at: draft.state === 'sent' ? draft.sentAt ?? draft.updatedAt : draft.createdAt,
      draft
    }))
  ].sort((left, right) => left.at.localeCompare(right.at)) : [];

  useEffect(() => {
    if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [selectedKey, selected?.items.length, selected?.drafts.length]);

  const listening = status.data?.listening !== false;
  const actionError = [saveConfig.error, disconnect.error, poll.error, setListening.error, sendDraft.error, discardDraft.error, manualSend.error, importCookie.error, pickWorkspace.error].map(errorText).find(Boolean);
  const selectConversation = (conversation: Conversation) => { setSelectedKey(conversation.key); setTab('chats'); };

  if (config.isPending || status.isPending) {
    return <div className="grid h-full place-items-center text-[12px] text-zinc-500">正在读取飞书替身状态…</div>;
  }

  if (!sessionReady || showConnect) {
    return <ConnectView
      config={config.data}
      status={status.data}
      open={showConnect}
      setOpen={setShowConnect}
      region={region}
      login={loginStatus.data}
      starting={startLogin.isPending}
      error={startLogin.error ?? importCookie.error}
      cookie={cookie}
      setCookie={setCookie}
      importing={importCookie.isPending}
      onOpen={() => { setShowConnect(true); startLogin.mutate(region); }}
      onStart={() => startLogin.mutate(region)}
      onRegion={value => { setRegion(value); startLogin.mutate(value); }}
      onCancel={() => cancelLogin.mutate()}
      onCookieImport={() => importCookie.mutate()}
    />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-zinc-100 px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar name={status.data?.account?.name} src={status.data?.account?.avatarUrl} size={40}/>
            <div className="min-w-0">
              <div className="flex items-center gap-2"><h3 className="truncate text-[14px] font-semibold text-zinc-900">{status.data?.account?.name || '飞书账号'}</h3><StatusPill connected={status.data?.connected} state={status.data?.state} listening={status.data?.listening}/></div>
              <p className="mt-0.5 truncate text-[11px] text-zinc-500">{status.data?.account?.email || status.data?.account?.userId || `${status.data?.region === 'lark' ? 'Lark' : '飞书'} WebSocket`}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="small" icon={<RefreshCw size={12}/>} loading={poll.isPending} disabled={!listening} onClick={() => poll.mutate()}>立即同步</Button>
            <Button size="small" icon={listening ? <Pause size={12}/> : <Play size={12}/>} loading={setListening.isPending} onClick={() => setListening.mutate(!listening)}>{listening ? '暂停监听' : '恢复监听'}</Button>
            <Button size="small" onClick={() => setTab('settings')}>连接设置</Button>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-1">
          {([
            ['overview', '概览'],
            ['chats', '会话'],
            ['settings', '设置']
          ] as const).map(([value, label]) => <button key={value} type="button" onClick={() => setTab(value)} className={`relative rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors ${tab === value ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-500 hover:bg-zinc-50 hover:text-zinc-800'}`}>{label}{value === 'chats' && pendingDrafts.length > 0 && <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">{pendingDrafts.length}</span>}</button>)}
        </div>
      </div>

      {actionError && <p className="border-b border-red-100 bg-red-50 px-5 py-2 text-[12px] text-red-700">{actionError}</p>}
      {!listening && <div className="flex flex-wrap items-center gap-2 border-b border-amber-100 bg-amber-50 px-5 py-2 text-[12px] text-amber-800"><Pause size={13}/><span>监听已暂停，不会接收新消息或触发 Agent；登录凭证仍保留，可随时恢复。</span></div>}
      {listening && status.data?.state === 'connecting' && <p className="border-b border-amber-100 bg-amber-50 px-5 py-2 text-[12px] text-amber-800">WebSocket 正在重连{status.data.lastError ? `：${status.data.lastError}` : '…'}</p>}

      {tab === 'overview' && (
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {!listening && <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-amber-200/70 bg-amber-50/70 px-4 py-3 text-[12px] leading-5 text-amber-900"><Pause size={15} className="mt-0.5 shrink-0"/><div><p className="font-medium">当前处于暂停状态</p><p className="mt-0.5 text-amber-800">新的飞书消息不会被读取，也不会触发 Agent。点击右上角「恢复监听」后会重新连接 WebSocket 并继续定时补拉。</p></div></div>}
          <div className="mb-4 rounded-xl border border-sky-100 bg-sky-50/60 px-4 py-3 text-[12px] leading-5 text-sky-900">
            在飞书聊天里发送 <code className="rounded bg-white/80 px-1 py-0.5 font-mono text-[11px]">{triggerPrefix} 你的问题</code>，
            会自动带上最近 {contextMessages} 条聊天记录（文字消息，含本条触发消息）发起 Agent 轮次；Agent 的所有文本输出会直接以你的身份发回当前聊天。后台每 {status.data?.syncIntervalSeconds ?? 30} 秒补拉一次群聊，避免只依赖 WebSocket 推送。
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="收到消息" value={items.length}/>
            <Stat label="会话" value={conversations.length}/>
            <Stat label="AI 触发" value={triggerCount} hint={`${triggerPrefix} 前缀`}/>
            <Stat label="已发送" value={sentDrafts.length} hint={pendingDrafts.length ? `${pendingDrafts.length} 条待补发` : '全部已送达'}/>
          </div>
          <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,.65fr)]">
            <section className={`${section} overflow-hidden`}>
              <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3"><h3 className="text-[13px] font-semibold text-zinc-900">最近会话</h3><button type="button" onClick={() => setTab('chats')} className="text-[11px] text-zinc-500 hover:text-zinc-900">全部会话</button></div>
              {conversations.length ? <div className="divide-y divide-zinc-100">{conversations.slice(0, 6).map(conversation => <button key={conversation.key} type="button" onClick={() => selectConversation(conversation)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50"><Avatar name={conversation.title} src={conversation.avatarUrl} fallbackSrc={conversation.avatarFallbackUrl} size={30}/><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className="truncate text-[12px] font-medium text-zinc-800">{conversation.title}</span><span className="shrink-0 text-[10px] text-zinc-400">{timeLabel(conversation.latestAt)}</span></div><p className="mt-0.5 truncate text-[11px] text-zinc-500">{conversation.latestText || '暂无消息'}</p></div></button>)}</div> : <div className="px-4 py-10 text-center text-[12px] text-zinc-400">还没有收到消息</div>}
            </section>
            <section className={`${section} overflow-hidden`}>
              <div className="border-b border-zinc-100 px-4 py-3"><h3 className="text-[13px] font-semibold text-zinc-900">最近发送</h3></div>
              {sentDrafts.length ? <div className="divide-y divide-zinc-100">{sentDrafts.slice(0, 5).map(draft => {
                const conversation = conversations.find(item => item.drafts.some(value => value.id === draft.id));
                return <button key={draft.id} type="button" onClick={() => { if (conversation) selectConversation(conversation); }} className="block w-full px-4 py-3 text-left hover:bg-zinc-50"><div className="flex items-center justify-between gap-2"><span className="text-[11px] font-medium text-zinc-700">{conversation?.title || draft.target}</span><span className="text-[10px] text-zinc-400">{timeLabel(draft.updatedAt)}</span></div><p className="mt-1 line-clamp-2 text-[11px] leading-4 text-zinc-500">{draft.body || '等待补充正文'}</p></button>;
              })}</div> : <div className="px-4 py-10 text-center text-[12px] text-zinc-400">还没有发送记录</div>}
            </section>
          </div>
        </div>
      )}

      {tab === 'chats' && (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[270px] shrink-0 flex-col border-r border-zinc-100">
            <div className="p-3"><div className="relative"><Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400"/><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索会话" className="h-8 w-full rounded-lg bg-zinc-100 pl-8 pr-3 text-[12px] text-zinc-800 outline-none placeholder:text-zinc-400"/></div></div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {filtered.map(conversation => <button key={conversation.key} type="button" onClick={() => setSelectedKey(conversation.key)} className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2.5 text-left ${conversation.key === selectedKey ? 'bg-zinc-100' : 'hover:bg-zinc-50'}`}><Avatar name={conversation.title} src={conversation.avatarUrl} fallbackSrc={conversation.avatarFallbackUrl} size={32}/><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className="truncate text-[12px] font-medium text-zinc-800">{conversation.title}</span><span className="shrink-0 text-[9px] text-zinc-400">{timeLabel(conversation.latestAt)}</span></div><p className="mt-0.5 truncate text-[11px] text-zinc-500">{conversation.latestText || '暂无消息'}</p>{conversation.drafts.some(draft => draft.state === 'pending' || draft.state === 'failed') && <span className="mt-1 inline-flex items-center gap-1 text-[10px] text-amber-700"><Sparkles size={10}/>有回复待补发</span>}</div></button>)}
              {!filtered.length && <p className="px-3 py-8 text-center text-[11px] text-zinc-400">{search ? '没有匹配的会话' : '还没有会话'}</p>}
            </div>
          </aside>
          <section className="flex min-w-0 flex-1 flex-col">
            {selected ? <>
              <div className="flex items-center justify-between gap-3 border-b border-zinc-100 px-4 py-3"><div className="flex min-w-0 items-center gap-2.5"><Avatar name={selected.title} src={selected.avatarUrl} fallbackSrc={selected.avatarFallbackUrl} size={30}/><div className="min-w-0"><h3 className="truncate text-[13px] font-semibold text-zinc-900">{selected.title}</h3><p className="text-[10px] text-zinc-400">{selected.chatType === 'p2p' ? '私聊' : selected.chatType === 'group' ? '群聊' : selected.chatType || '飞书会话'} · {selected.items.length} 条消息{selected.drafts.length ? ` · ${selected.drafts.length} 条回复` : ''}</p></div></div><span className="text-[10px] text-zinc-400">{pendingDrafts.filter(draft => selected.drafts.some(value => value.id === draft.id)).length} 条待补发</span></div>
              <div ref={messagesRef} className="min-h-0 flex-1 overflow-y-auto bg-zinc-50/40 px-5 py-4">
                {selectedTimeline.length ? <>
                  {selectedTimeline.map(entry => {
                    if (entry.kind === 'draft') {
                      const draft = entry.draft;
                      return <div key={draft.id}><DraftBlock draft={draft} body={draftBodies[draft.id] ?? draft.body} onBody={value => setDraftBodies(previous => ({ ...previous, [draft.id]: value }))} onSend={() => sendDraft.mutate(draft)} onDiscard={() => discardDraft.mutate(draft.id)} sending={sendDraft.isPending && sendDraft.variables?.id === draft.id} discarding={discardDraft.isPending && discardDraft.variables === draft.id} accountName={status.data?.account?.name} accountAvatarUrl={status.data?.account?.avatarUrl}/></div>;
                    }
                    const item = entry.item;
                    const isTrigger = item.title.trim().startsWith(triggerPrefix);
                    const own = Boolean(item.senderId && item.senderId === status.data?.account?.userId);
                    return <div key={item.id} className={`mb-5 flex items-start gap-2.5 ${own ? 'flex-row-reverse' : ''}`}>
                      <Avatar name={item.senderName || selected.title} src={item.senderAvatarUrl} size={28}/>
                      <div className={`min-w-0 max-w-[78%] ${own ? 'text-right' : ''}`}>
                        <div className={`mb-1 flex flex-wrap items-center gap-2 ${own ? 'justify-end' : ''}`}><span className="text-[11px] font-medium text-zinc-700">{item.senderName || selected.title}</span><span className="text-[10px] text-zinc-400">{fullTime(item.occurredAt)}</span>{isTrigger && <span className="rounded-full bg-sky-50 px-1.5 py-0.5 text-[9px] font-medium text-sky-700">Agent 触发</span>}</div>
                        <div className={`inline-block whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-left text-[13px] leading-5 ${own ? 'rounded-tr-md bg-sky-600 text-white' : 'rounded-tl-md border border-zinc-200 bg-white text-zinc-800'}`}>{item.title || item.summary}</div>
                      </div>
                    </div>;
                  })}
                </> : <div className="grid h-full place-items-center text-center"><div><MessageCircle size={26} className="mx-auto text-zinc-300"/><p className="mt-2 text-[12px] text-zinc-400">这个会话还没有消息</p></div></div>}
              </div>
              <div className="border-t border-zinc-100 p-3">
                <div className="flex items-end gap-2 rounded-xl border border-zinc-200 bg-white p-2 focus-within:border-zinc-400">
                  <textarea value={composer} onChange={event => setComposer(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (composer.trim() && !manualSend.isPending) manualSend.mutate({ conversation: selected, body: composer }); } }} rows={1} placeholder={`发送给 ${selected.title}，Enter 发送，Shift+Enter 换行`} className="max-h-28 min-h-8 flex-1 resize-none bg-transparent px-2 py-1.5 text-[12px] leading-5 text-zinc-800 outline-none placeholder:text-zinc-400"/>
                  <button type="button" aria-label="发送消息" disabled={!composer.trim() || manualSend.isPending} onClick={() => manualSend.mutate({ conversation: selected, body: composer })} className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-zinc-900 text-white transition-opacity hover:bg-zinc-800 disabled:opacity-30"><Send size={13}/></button>
                </div>
              </div>
            </> : <div className="grid h-full place-items-center text-center"><div><MessageCircle size={28} className="mx-auto text-zinc-300"/><p className="mt-2 text-[12px] text-zinc-400">选择左侧会话查看消息</p></div></div>}
          </section>
        </div>
      )}

      {tab === 'settings' && (
        <div className="flex min-h-0 flex-1 flex-col bg-zinc-50/60">
          <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
            <div className="mx-auto max-w-[820px] space-y-4">
            <section className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(24,24,27,.03)] sm:p-5">
              <div className="flex items-start gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-zinc-100 text-zinc-600"><Settings2 size={15}/></span>
                <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-[14px] font-semibold text-zinc-900">账号与连接</h3><StatusPill connected={status.data?.connected} state={status.data?.state} listening={status.data?.listening}/></div><p className="mt-1 text-[11px] leading-5 text-zinc-500">{listening ? '本人身份常驻在线，WebSocket 接收消息并定时补拉群聊。' : '监听已暂停，WebSocket 和定时补拉均已停止；登录凭证仍保留在本机。'}</p></div>
              </div>
              <div className="mt-4 grid gap-x-6 gap-y-3 rounded-xl bg-zinc-50/80 px-4 py-3 sm:grid-cols-2">
                <div><span className={field}>当前账号</span><p className="mt-1 text-[12px] font-medium text-zinc-800">{status.data?.account?.name || '飞书账号'}</p></div>
                <div><span className={field}>用户 ID</span><p className="mt-1 truncate font-mono text-[11px] text-zinc-600">{status.data?.account?.userId || '—'}</p></div>
                <div><span className={field}>区域</span><p className="mt-1 text-[12px] text-zinc-700">{status.data?.region === 'lark' ? 'Lark 国际版' : '飞书中国版'}</p></div>
                <div><span className={field}>同步</span><p className="mt-1 text-[12px] text-zinc-700">每 {status.data?.syncIntervalSeconds ?? 30} 秒补拉</p><p className="mt-0.5 text-[10px] text-zinc-400">{status.data?.lastSyncedAt ? `最近 ${fullTime(status.data.lastSyncedAt)}` : '等待首次同步'}</p></div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2"><Button size="small" icon={listening ? <Pause size={12}/> : <Play size={12}/>} loading={setListening.isPending} onClick={() => setListening.mutate(!listening)}>{listening ? '暂停监听' : '恢复监听'}</Button><Button size="small" onClick={() => { setShowConnect(true); startLogin.mutate(region); }}>重新扫码</Button><Button size="small" danger loading={disconnect.isPending} onClick={() => disconnect.mutate()}>断开账号</Button><span className="ml-auto text-[10px] text-zinc-400">凭证仅保存在本机 SQLite</span></div>
            </section>

            <section className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(24,24,27,.03)] sm:p-5">
              <div className="flex items-start gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-zinc-100 text-zinc-600"><Bot size={15}/></span>
                <div><h3 className="text-[14px] font-semibold text-zinc-900">Agent 配置</h3><p className="mt-1 text-[11px] leading-5 text-zinc-500">选择处理 /ai 轮次的 Agent、模型和运行目录。</p></div>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="block"><span className={field}>Agent</span><CompactSelect options={agentOptions} value={agentId} placeholder="选择 Agent" disabledText="没有可用 Agent" popupWidth={380} onChange={value => { setAgentId(value); setModel(''); setReasoningEffort(''); }}/></label>
                <label className="block"><span className={field}>默认模型</span><CompactSelect options={modelOptions} value={model} placeholder="选择模型" disabledText="暂无可用模型" disabled={!models.data?.models.length} popupWidth={380} onChange={setModel}/></label>
                <label className="block"><span className={field}>推理强度</span><CompactSelect options={reasoningOptions} value={reasoningEffort} placeholder="选择推理强度" disabledText="当前 Agent 未提供推理强度" disabled={!models.data?.reasoningEfforts.length} popupWidth={300} onChange={setReasoningEffort}/></label>
                <div className="block">
                  <span className={field}>工作目录</span>
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="min-w-0 flex-1"><SuggestedValueInput value={workspace} onChange={setWorkspace} label="工作目录" placeholder="留空使用默认工作目录" suggestion={selectedAgent?.cwd || capabilities.data?.workingDirectory} suggestionLabel="使用 Agent 默认工作目录"/></div>
                    <Button size="small" icon={<FolderOpen size={12}/>} loading={pickWorkspace.isPending} disabled={!capabilities.data?.directoryPicker} onClick={() => pickWorkspace.mutate()}>选择</Button>
                  </div>
                </div>
                <label className="block"><span className={field}>单轮超时（秒）</span><input className={input} type="number" min={0} max={86400} value={agentTimeoutSeconds} onChange={event => setAgentTimeoutSeconds(Math.min(86_400, Math.max(0, Number(event.target.value) || 0)))}/><p className="mt-1 text-[10px] leading-4 text-zinc-400">0 表示不限制；超时后会结束本轮。</p></label>
                <div className="block">
                  <span className={field}>Agent 记忆范围</span>
                  <Segmented<'anchor' | 'chat'> value={contextScope} onChange={setContextScope} options={[{ value: 'anchor', label: '按话题隔离' }, { value: 'chat', label: '整个会话共享' }]}/>
                  <p className="mt-1 text-[10px] leading-4 text-zinc-400">按话题隔离：每个飞书话题有独立的 Agent 会话；整个会话共享：同一聊天里的不同话题共用一段记忆。</p>
                </div>
              </div>
              <p className="mt-3 text-[11px] leading-5 text-zinc-400">{models.isFetching ? '正在读取 Agent 能力…' : models.data?.warning || '修改 Agent 配置后，下一次 /ai 触发会创建对应的新会话。'}</p>
            </section>

            <section className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(24,24,27,.03)] sm:p-5">
              <div className="flex items-start gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-zinc-100 text-zinc-600"><Users size={15}/></span>
                <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-[14px] font-semibold text-zinc-900">消息监听</h3><span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-500">{listenMode === 'all' ? '全部会话' : `已选 ${listenChats.length} 个`}</span></div><p className="mt-1 text-[11px] leading-5 text-zinc-500">决定读取哪些会话的消息和上下文。默认监听账号可见的全部会话。</p></div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-1 rounded-xl bg-zinc-100 p-1">
                {([['all', '全部会话'], ['selected', '指定会话']] as const).map(([value, label]) => <button key={value} type="button" onClick={() => setListenMode(value)} className={`rounded-lg px-3 py-2 text-[12px] font-medium transition-colors ${listenMode === value ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'}`}>{label}</button>)}
              </div>
              {listenMode === 'all' ? (
                <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-emerald-100 bg-emerald-50/60 px-3.5 py-3 text-emerald-900"><Wifi size={15} className="mt-0.5 shrink-0"/><div><p className="text-[12px] font-medium">正在监听全部会话</p><p className="mt-0.5 text-[11px] leading-5 text-emerald-700">群聊和私聊都会进入上下文，并在每次触发时读取最近消息。</p></div></div>
              ) : (
                <div className="mt-3 space-y-3">
                  {listenChats.length > 0 && <div className="flex flex-wrap gap-1.5">{listenChats.map(id => {
                    const chat = chatOptions.find(item => item.id === id);
                    return <span key={id} className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 py-1 pl-2 pr-1 text-[11px] text-zinc-700"><span className="max-w-[240px] truncate">{chat && chat.type !== 'unknown' ? chat.name : id}</span><button type="button" aria-label={`移除 ${chat?.name || id}`} onClick={() => toggleChat(id)} className="grid h-4 w-4 place-items-center rounded text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"><X size={10}/></button></span>;
                  })}</div>}
                  <div className="overflow-hidden rounded-xl border border-zinc-200">
                    <div className="flex items-center gap-2 border-b border-zinc-100 bg-zinc-50/70 p-2">
                      <div className="relative min-w-0 flex-1"><Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400"/><input value={chatSearch} onChange={event => setChatSearch(event.target.value)} placeholder="搜索群名或 Chat ID" className="h-8 w-full rounded-lg border border-zinc-200 bg-white pl-8 pr-3 text-[12px] text-zinc-800 outline-none placeholder:text-zinc-400 focus:border-zinc-400"/></div>
                      <button type="button" disabled={availableChats.isFetching} onClick={() => void availableChats.refetch()} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-200 disabled:opacity-40" aria-label="刷新会话列表"><RefreshCw size={13} className={availableChats.isFetching ? 'animate-spin' : ''}/></button>
                    </div>
                    <div className="max-h-[230px] overflow-y-auto p-1.5">
                      {filteredChatOptions.map(chat => {
                        const checked = listenChats.includes(chat.id);
                        return <button key={chat.id} type="button" onClick={() => toggleChat(chat.id)} className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${checked ? 'bg-zinc-100' : 'hover:bg-zinc-50'}`}><Avatar name={chat.name} src={chat.avatarUrl} fallbackSrc={chat.avatarFallbackUrl} size={30}/><div className="min-w-0 flex-1"><p className="truncate text-[12px] font-medium text-zinc-800">{chat.name}</p><p className="truncate text-[10px] text-zinc-400">{chatTypeText(chat.type)}{chat.memberCount ? ` · ${chat.memberCount} 人` : ''} · {chat.id}</p></div><span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${checked ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-300 text-transparent'}`}><Check size={11}/></span></button>;
                      })}
                      {!filteredChatOptions.length && <div className="px-3 py-8 text-center text-[11px] text-zinc-400">{availableChats.isFetching ? '正在读取飞书会话…' : chatSearch ? '没有匹配的会话' : '暂无可选会话，可使用下方手动输入'}</div>}
                    </div>
                  </div>
                  <details className="group rounded-xl border border-zinc-200 px-3 py-2">
                    <summary className="flex cursor-pointer list-none items-center justify-between text-[11px] font-medium text-zinc-500"><span className="inline-flex items-center gap-1.5"><Hash size={12}/>手动输入 Chat ID</span><span className="text-[10px] text-zinc-400 group-open:hidden">展开</span><span className="hidden text-[10px] text-zinc-400 group-open:inline">收起</span></summary>
                    <input className={`${input} font-mono`} value={manualChatIds} placeholder="oc_1, oc_2" onChange={event => setManualChatIds(event.target.value)} onBlur={() => setListenChats(splitList(manualChatIds))}/>
                    <p className="mt-1 text-[10px] leading-4 text-zinc-400">留空并切到「全部会话」可监听所有会话。</p>
                  </details>
                </div>
              )}
              <p className="mt-3 text-[10px] leading-4 text-zinc-400">最近消息面板最多保留 60 条消息，写入新消息时立即丢弃最旧记录；回复记录最多保留 80 条，待发送的会保留。图片不会下载，只保存占位摘要。</p>
            </section>

            <section className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(24,24,27,.03)] sm:p-5">
              <div className="flex items-start gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-zinc-100 text-zinc-600"><MessageCircle size={15}/></span>
                <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-[14px] font-semibold text-zinc-900">回复方式</h3><span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-700">发送位置</span></div><p className="mt-1 text-[11px] leading-5 text-zinc-500">控制 Agent 的回复发到主会话、原话题，还是以引用或新话题发送。</p></div>
              </div>
              <div className="mt-4 space-y-3">
                <div className="rounded-xl border border-zinc-200 px-3.5 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0"><p className="text-[12px] font-medium text-zinc-800">话题内的消息</p><p className="mt-0.5 text-[11px] leading-5 text-zinc-500">回复到原话题，或发到外面的主会话。</p></div>
                    <div className="w-[210px] shrink-0"><Segmented<'in' | 'out'> value={replyInTopic ? 'in' : 'out'} onChange={value => setReplyInTopic(value === 'in')} options={[{ value: 'in', label: '话题内' }, { value: 'out', label: '主会话' }]}/></div>
                  </div>
                </div>
                <div className="rounded-xl border border-zinc-200 px-3.5 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0"><p className="text-[12px] font-medium text-zinc-800">主会话的消息</p><p className="mt-0.5 text-[11px] leading-5 text-zinc-500">私聊不支持话题，选择「开话题回复」时按引用发送。</p></div>
                    <div className="w-[300px] shrink-0"><Segmented<'direct' | 'quote' | 'thread'> value={replyMode} onChange={setReplyMode} options={[{ value: 'direct', label: '直接发送' }, { value: 'quote', label: '引用回复' }, { value: 'thread', label: '开话题回复' }]}/></div>
                  </div>
                </div>
                <div className="rounded-xl border border-zinc-200 px-3.5 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0"><p className="text-[12px] font-medium text-zinc-800">随机表情回应</p><p className="mt-0.5 text-[11px] leading-5 text-zinc-500">触发后先在原消息上加 2–3 个随机飞书表情，再开始生成回复。</p></div>
                    <Switch size="small" aria-label="随机表情回应" checked={emojiReactions} onChange={setEmojiReactions}/>
                  </div>
                </div>
                <label className="block rounded-xl border border-zinc-200 px-3.5 py-3">
                  <span className="text-[12px] font-medium text-zinc-800">回复署名（可选）</span>
                  <input className={input} value={replySignature} maxLength={100} onChange={event => setReplySignature(event.target.value)} placeholder="例如：—— 🤖 数字分身"/>
                  <p className="mt-1 text-[10px] leading-4 text-zinc-400">加在 Agent 发出的每条消息末尾；手动发送的消息不加。</p>
                </label>
              </div>
            </section>

            <section className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(24,24,27,.03)] sm:p-5">
              <div className="flex items-start gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-zinc-100 text-zinc-600"><UserRound size={15}/></span>
                <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-[14px] font-semibold text-zinc-900">触发规则</h3><span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-700">仅本人可触发</span></div><p className="mt-1 text-[11px] leading-5 text-zinc-500">只有你本人发送匹配前缀的消息才会发起 Agent 轮次；其他人的消息只作为上下文，即使发送相同前缀也不会触发。</p></div>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="block"><span className={field}>触发前缀</span><input className={input} value={triggerPrefix} placeholder="/ai" onChange={event => setTriggerPrefix(event.target.value)}/></label>
                <label className="block">
                  <span className={field}>每轮注入条数（1–50）</span>
                  <input className={input} type="number" min={1} max={50} value={contextMessages} onChange={event => setContextMessages(Number(event.target.value) || 10)}/>
                  <p className="mt-1 text-[10px] leading-4 text-zinc-400">每次触发时，附上最近 N 条文字消息（含本条触发消息）给 Agent；不是 Agent 的记忆条数，也不影响最近消息面板的保留上限。</p>
                </label>
              </div>
              <div className="mt-3 rounded-xl bg-zinc-50 px-3.5 py-2.5 text-[11px] leading-5 text-zinc-500">你发送 <code className="rounded bg-white px-1 py-0.5 font-mono text-zinc-700">{triggerPrefix} 你的问题</code> 即触发；所有 AgentText 会直接以你的身份发回原会话。</div>
            </section>

            <section className="flex items-start gap-2.5 rounded-2xl border border-amber-200/70 bg-amber-50/60 p-4">
              <CircleAlert size={15} className="mt-0.5 shrink-0 text-amber-600"/>
              <div><h3 className="text-[12px] font-semibold text-amber-900">使用风险</h3><p className="mt-1 text-[11px] leading-5 text-amber-800">替身以你的飞书身份读取和发送消息，Agent 输出会直接发出。请只监听可信会话，并确认 Agent 的权限边界。</p></div>
            </section>

            </div>
          </div>
          <div className="shrink-0 border-t border-zinc-200/80 bg-white px-4 py-3">
            <div className="mx-auto flex max-w-[820px] flex-wrap items-center justify-between gap-3">
              <p className="text-[11px] text-zinc-500">修改后点击保存，后续消息立即使用新规则。</p>
              <Button type="primary" onClick={() => saveConfig.mutate()} className="!rounded-lg !bg-zinc-900">保存配置</Button>
            </div>
          </div>
        </div>
      )}
      {createPortal(toast.toast, document.body)}
    </div>
  );
}
