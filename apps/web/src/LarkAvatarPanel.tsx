import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Switch } from 'antd';
import { QRCodeSVG } from 'qrcode.react';
import {
  AlertTriangle, ArrowLeft, Bot, Check, CheckCircle2, ChevronRight, CircleAlert, Database, FolderOpen, Hash, LoaderCircle, MessageCircle,
  Pause, Play, RefreshCw, Search, Send, Settings2, ShieldCheck, Sparkles, Trash2, UserRound, Users, Wifi, X
} from 'lucide-react';
import { CompactSelect } from './CompactSelect';
import { AiFieldHeader, AiTextAssistControl, AiUndoCapsule, useAiFlash } from './AiTextAssist';
import { ReactionEmojiPicker } from './ReactionEmojiPicker';
import { reactionEmojiIsCustom, reactionEmojiPayload } from './lark-avatar-emoji';
import { reactionOutcomeLabel, reactionSourceStatus, reactionStateLabel } from './lark-avatar-reaction-diagnostics';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from './model-cache';
import { SuggestedValueInput } from './SuggestedValueInput';
import { SlidingSegmented } from './ui-controls';
import { useToast } from './Toast';
import {
  DEFAULT_LARK_AVATAR_REACTION_TRIGGER_EMOJI,
  DEFAULT_LARK_AVATAR_REPLY_FORWARD_MODE,
  LARK_AVATAR_REACTION_ROUTE_OPTIONS,
  LARK_AVATAR_REPLY_FORWARD_OPTIONS,
  LARK_AVATAR_REPLY_FORWARD_SUMMARY,
  buildLarkAvatarAgentOptions,
  describeLarkAvatarReplyForwardMode,
  normalizeLarkAvatarReactionRoute,
  normalizeLarkAvatarReplyForwardMode,
  resolveFallbackAgentId,
  resolveSaveAgentId
} from './lark-avatar-config-form';
import {
  DEFAULT_INBOX_CLEANUP_WARN_THRESHOLD,
  DEFAULT_INBOX_MAX_ITEMS,
  MAX_CONFIGURABLE_INBOX_ITEMS,
  evaluateCleanupReminder,
  formatCleanupSuccessMessage,
  formatRetentionSummary,
  parseRetentionInput,
  resolveQuickKeepLatest
} from './lark-avatar-retention';
import { withSavedOption } from './lark-config-form';
import {
  api,
  type LarkAvatarConfigRecord,
  type LarkAvatarChatSummary,
  type LarkAvatarDraft,
  type LarkAvatarInboxItem,
  type LarkAvatarLoginSnapshot,
  type LarkAvatarReactionRoute,
  type LarkAvatarRegion,
  type LarkAvatarReplyForwardMode,
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

const input = 'mt-1.5 h-9 w-full rounded-lg border border-zinc-300 bg-white px-3 text-[12px] text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-500';
const field = 'text-[12px] font-medium text-zinc-700';
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

function Segmented<T extends string>({ value, onChange, options, className = '', ariaLabel }: {
  value: T;
  onChange(value: T): void;
  options: Array<{ value: T; label: string }>;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <SlidingSegmented
      value={value}
      onChange={onChange}
      options={options}
      ariaLabel={ariaLabel}
      size="md"
      className={`h-9 w-full ${className}`}
      itemClassName="px-2.5"
    />
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
  return <div className="rounded-xl border border-zinc-200 bg-white px-3.5 py-3 sm:px-4"><p className="text-[11px] text-zinc-500">{label}</p><p className="mt-1 text-[22px] font-semibold leading-none text-zinc-900 sm:text-[24px]">{value}</p>{hint && <p className="mt-1 truncate text-[11px] text-zinc-400">{hint}</p>}</div>;
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
  const draftFlash = useAiFlash();
  if (draft.state === 'sent') {
    const agentReply = Boolean(draft.itemId);
    return (
      <div className="mb-4 flex items-end justify-end gap-2 sm:mb-5 sm:gap-2.5">
        <div className="min-w-0 max-w-[85%] text-right sm:max-w-[78%]">
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
    return <div className="mb-4 max-w-[85%] rounded-lg border border-dashed border-zinc-200 px-3 py-2 text-[11px] text-zinc-400 sm:mb-5 sm:max-w-[78%]">已丢弃草稿：{draft.body || '（空）'}</div>;
  }
  return (
    <div className="mb-4 max-w-[85%] rounded-xl border border-zinc-200 bg-zinc-50/70 p-3 sm:mb-5 sm:max-w-[78%]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-600"><Sparkles size={12}/>Agent 回复</span>
        <div className="flex items-center gap-1.5">
          {draft.lastError && <span className="max-w-[180px] truncate text-[10px] text-red-600">{draft.lastError}</span>}
          <AiTextAssistControl
            mode="message_polish"
            variant="pill"
            size="xs"
            popoverSide="top"
            popoverAlign="end"
            value={body}
            onChange={onBody}
            onFlash={draftFlash.triggerFlash}
            resetKey={draft.id}
            context={() => ({
              field: '飞书 AI 替身待发送草稿',
              purpose: '润色或补全即将以本人身份发送到飞书聊天的回复正文，语气自然专业'
            })}
            testId={`lark-avatar-draft-ai-${draft.id}`}
          />
        </div>
      </div>
      <textarea className={`${input} mt-2 min-h-20 resize-y bg-white ${draftFlash.flashClass}`} value={body} placeholder="AI 没有生成正文，可以手动补充。" onChange={event => onBody(event.target.value)}/>
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
  const [mobileChatView, setMobileChatView] = useState<'list' | 'detail'>('list');
  const [showConnect, setShowConnect] = useState(false);
  const [region, setRegion] = useState<LarkAvatarRegion>('feishu');
  const [cookie, setCookie] = useState('');
  const [triggerPrefix, setTriggerPrefix] = useState('/ai');
  const [contextMessages, setContextMessages] = useState(10);
  const [contextScope, setContextScope] = useState<'anchor' | 'chat'>('anchor');
  const [replyInTopic, setReplyInTopic] = useState(true);
  const [replyMode, setReplyMode] = useState<'direct' | 'quote' | 'thread'>('direct');
  const [replyForwardMode, setReplyForwardMode] = useState<LarkAvatarReplyForwardMode>(DEFAULT_LARK_AVATAR_REPLY_FORWARD_MODE);
  const [emojiReactions, setEmojiReactions] = useState(false);
  const [reactionTriggerEnabled, setReactionTriggerEnabled] = useState(false);
  const [reactionTriggerEmoji, setReactionTriggerEmoji] = useState('');
  const [reactionTriggerRoute, setReactionTriggerRoute] = useState<LarkAvatarReactionRoute>('main');
  const [reactionTriggerIgnoreBots, setReactionTriggerIgnoreBots] = useState(true);
  const [replySignature, setReplySignature] = useState('');
  const [agentTimeoutSeconds, setAgentTimeoutSeconds] = useState(7_200);
  const [listenMode, setListenMode] = useState<'all' | 'selected'>('all');
  const [listenChats, setListenChats] = useState<string[]>([]);
  const [manualChatIds, setManualChatIds] = useState('');
  const [chatSearch, setChatSearch] = useState('');
  const [inboxMaxItemsInput, setInboxMaxItemsInput] = useState(String(DEFAULT_INBOX_MAX_ITEMS));
  const [inboxCleanupWarnThresholdInput, setInboxCleanupWarnThresholdInput] = useState(String(DEFAULT_INBOX_CLEANUP_WARN_THRESHOLD));
  const [cleanupReminderDismissed, setCleanupReminderDismissed] = useState(false);
  const [bannerCleanupConfirmOpen, setBannerCleanupConfirmOpen] = useState(false);
  const [settingsCleanupConfirm, setSettingsCleanupConfirm] = useState<{ keepLatest: number } | null>(null);
  const [agentId, setAgentId] = useState('');
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [selectedKey, setSelectedKey] = useState<string>();
  const [search, setSearch] = useState('');
  const [composer, setComposer] = useState('');
  const [composerSendEpoch, setComposerSendEpoch] = useState(0);
  const [composerUndo, setComposerUndo] = useState<{ canUndo: boolean; undoDepth: number; lastLabel?: string; undoing: boolean; undo: () => void; clearUndo: () => void }>();
  const composerFlash = useAiFlash();
  const signatureFlash = useAiFlash();
  const [draftBodies, setDraftBodies] = useState<Record<string, string>>({});
  // 排障区每 10 秒自动刷新，只有时间戳变化时很难看出手动刷新有没有生效；
  // 这里给按钮加一次性反馈（刷新中 / 已刷新 / 刷新失败），并保持按钮宽度不变。
  const [refreshState, setRefreshState] = useState<'idle' | 'refreshing' | 'done' | 'failed'>('idle');
  const refreshFeedbackTimer = useRef<number | null>(null);
  const toast = useToast();
  const messagesRef = useRef<HTMLDivElement>(null);
  const retentionSectionRef = useRef<HTMLElement>(null);
  const thresholdInputRef = useRef<HTMLInputElement>(null);
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
  const reactionDiagnostics = useQuery({
    queryKey: ['lark-avatar-reaction-diagnostics'],
    queryFn: () => api.larkAvatarReactionDiagnostics(8),
    enabled: sessionReady && tab === 'settings',
    staleTime: 5_000,
    refetchInterval: tab === 'settings' ? 10_000 : false,
    retry: false
  });
  useEffect(() => () => {
    if (refreshFeedbackTimer.current !== null) window.clearTimeout(refreshFeedbackTimer.current);
  }, []);
  const refreshDiagnostics = async () => {
    if (refreshFeedbackTimer.current !== null) window.clearTimeout(refreshFeedbackTimer.current);
    setRefreshState('refreshing');
    try {
      const result = await reactionDiagnostics.refetch();
      setRefreshState(result.isError ? 'failed' : 'done');
    } catch {
      setRefreshState('failed');
    }
    refreshFeedbackTimer.current = window.setTimeout(() => {
      refreshFeedbackTimer.current = null;
      setRefreshState('idle');
    }, 2_000);
  };

  useEffect(() => {
    if (!config.data) return;
    setRegion(config.data.config.region);
    setTriggerPrefix(config.data.config.triggerPrefix);
    setContextMessages(config.data.config.contextMessages);
    setContextScope(config.data.config.contextScope);
    setReplyInTopic(config.data.config.replyInTopic);
    setReplyMode(config.data.config.replyMode);
    setReplyForwardMode(normalizeLarkAvatarReplyForwardMode(config.data.config.replyForwardMode));
    setEmojiReactions(config.data.config.emojiReactions);
    setReactionTriggerEnabled(config.data.config.reactionTriggerEnabled ?? false);
    setReactionTriggerEmoji(config.data.config.reactionTriggerEmoji ?? '');
    setReactionTriggerRoute(normalizeLarkAvatarReactionRoute(config.data.config.reactionTriggerRoute));
    setReactionTriggerIgnoreBots(config.data.config.reactionTriggerIgnoreBots ?? true);
    setReplySignature(config.data.config.replySignature);
    setAgentTimeoutSeconds(config.data.config.agentTimeoutSeconds);
    setListenChats(config.data.config.listenChats);
    setManualChatIds(config.data.config.listenChats.join(', '));
    setListenMode(config.data.config.listenChats.length ? 'selected' : 'all');
    setInboxMaxItemsInput(String(config.data.config.inboxMaxItems ?? DEFAULT_INBOX_MAX_ITEMS));
    setInboxCleanupWarnThresholdInput(String(config.data.config.inboxCleanupWarnThreshold ?? DEFAULT_INBOX_CLEANUP_WARN_THRESHOLD));
    setAgentId(config.data.config.agentId);
    setModel(config.data.config.model);
    setReasoningEffort(config.data.config.reasoningEffort);
    setWorkspace(config.data.config.workspace);
  }, [config.data?.id, config.data?.updatedAt, connected]);

  useEffect(() => {
    const fallbackAgentId = resolveFallbackAgentId({
      currentAgentId: agentId,
      savedAgentId: config.data?.config.agentId,
      configPending: config.isPending,
      agents: agents.data
    });
    if (fallbackAgentId && fallbackAgentId !== agentId) setAgentId(fallbackAgentId);
  }, [agentId, agents.data, config.data?.config.agentId, config.isPending]);

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
    void qc.invalidateQueries({ queryKey: ['lark-avatar-reaction-diagnostics'] });
  };

  const parsedInboxMaxItems = parseRetentionInput(inboxMaxItemsInput, '记录保留上限', '0 表示不限制');
  const parsedCleanupThreshold = parseRetentionInput(inboxCleanupWarnThresholdInput, '清理提醒阈值', '0 表示关闭提醒');
  const retentionInputError = !parsedInboxMaxItems.ok
    ? parsedInboxMaxItems.error
    : !parsedCleanupThreshold.ok
      ? parsedCleanupThreshold.error
      : undefined;

  const saveConfig = useMutation({
    mutationFn: () => {
      if (!parsedInboxMaxItems.ok) return Promise.reject(new Error(parsedInboxMaxItems.error));
      if (!parsedCleanupThreshold.ok) return Promise.reject(new Error(parsedCleanupThreshold.error));
      return api.saveLarkAvatarConfig({
        region,
        triggerPrefix,
        contextMessages,
        contextScope,
        replyInTopic,
        replyMode,
        replyForwardMode,
        emojiReactions,
        reactionTriggerEnabled,
        ...reactionEmojiPayload(reactionTriggerEmoji),
        reactionTriggerRoute,
        reactionTriggerIgnoreBots,
        replySignature,
        agentTimeoutSeconds,
        listenChats: listenMode === 'all' ? [] : splitList(manualChatIds),
        inboxMaxItems: parsedInboxMaxItems.value,
        inboxCleanupWarnThreshold: parsedCleanupThreshold.value,
        allowedSenders: [],
        agentId: resolveSaveAgentId(agentId, config.data?.config.agentId),
        model,
        reasoningEffort,
        workspace
      });
    },
    onSuccess: () => {
      setCleanupReminderDismissed(false);
      setBannerCleanupConfirmOpen(false);
      toast.show('配置已保存，新规则已生效', 'info');
      invalidate();
    }
  });
  const cleanupInbox = useMutation({
    mutationFn: (keepLatest: number) => api.cleanupLarkAvatarInbox({ keepLatest }),
    onSuccess: result => {
      setBannerCleanupConfirmOpen(false);
      setSettingsCleanupConfirm(null);
      toast.show(formatCleanupSuccessMessage(result), 'info');
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
    onSuccess: () => { setComposer(''); setComposerSendEpoch(n => n + 1); invalidate(); }
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
  const agentOptions = buildLarkAvatarAgentOptions(agents.data, agentId);
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
  const activeReplyForwardMeta = describeLarkAvatarReplyForwardMode(replyForwardMode);
  const savedReplyForwardMeta = describeLarkAvatarReplyForwardMode(
    normalizeLarkAvatarReplyForwardMode(config.data?.config.replyForwardMode)
  );
  const currentInboxCount = status.data?.retention?.inboxCount ?? status.data?.counts.inbox ?? items.length;
  const savedInboxMaxItems = status.data?.retention?.inboxMaxItems ?? config.data?.config.inboxMaxItems ?? DEFAULT_INBOX_MAX_ITEMS;
  const savedCleanupWarnThreshold = status.data?.retention?.inboxCleanupWarnThreshold ?? config.data?.config.inboxCleanupWarnThreshold ?? DEFAULT_INBOX_CLEANUP_WARN_THRESHOLD;
  const cleanupReminder = evaluateCleanupReminder({
    inboxCount: currentInboxCount,
    warnThreshold: savedCleanupWarnThreshold,
    dismissed: cleanupReminderDismissed
  });
  const quickKeepLatest = resolveQuickKeepLatest({
    inboxCount: currentInboxCount,
    inboxMaxItems: savedInboxMaxItems,
    warnThreshold: savedCleanupWarnThreshold
  });
  const openThresholdSettings = () => {
    setTab('settings');
    setBannerCleanupConfirmOpen(false);
    window.requestAnimationFrame(() => {
      retentionSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      thresholdInputRef.current?.focus();
    });
  };
  const actionError = [saveConfig.error, cleanupInbox.error, disconnect.error, poll.error, setListening.error, sendDraft.error, discardDraft.error, manualSend.error, importCookie.error, pickWorkspace.error].map(errorText).find(Boolean);
  const openTab = (next: Tab) => {
    setTab(next);
    if (next === 'chats') setMobileChatView('list');
  };
  const selectConversation = (conversation: Conversation) => {
    setSelectedKey(conversation.key);
    setTab('chats');
    setMobileChatView('detail');
  };
  const inMobileChatDetail = tab === 'chats' && mobileChatView === 'detail' && Boolean(selected);

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
      <div className={`${inMobileChatDetail ? 'hidden sm:block' : 'block'} shrink-0 border-b border-zinc-100 px-3.5 py-2.5 sm:px-5 sm:py-3`}>
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar name={status.data?.account?.name} src={status.data?.account?.avatarUrl} size={38}/>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-[14px] font-semibold text-zinc-900">{status.data?.account?.name || '飞书账号'}</h3><StatusPill connected={status.data?.connected} state={status.data?.state} listening={status.data?.listening}/></div>
              <p className="mt-0.5 truncate text-[11px] text-zinc-500">{status.data?.account?.email || status.data?.account?.userId || `${status.data?.region === 'lark' ? 'Lark' : '飞书'} WebSocket`}</p>
            </div>
          </div>
          <div className="grid w-full grid-cols-3 gap-1.5 sm:flex sm:w-auto sm:items-center sm:gap-2">
            <Button size="small" className="!h-8 !w-full sm:!h-auto sm:!w-auto" icon={<RefreshCw size={12}/>} loading={poll.isPending} disabled={!listening} onClick={() => poll.mutate()}>立即同步</Button>
            <Button size="small" className="!h-8 !w-full sm:!h-auto sm:!w-auto" icon={listening ? <Pause size={12}/> : <Play size={12}/>} loading={setListening.isPending} onClick={() => setListening.mutate(!listening)}>{listening ? '暂停监听' : '恢复监听'}</Button>
            <Button size="small" className="!h-8 !w-full sm:!h-auto sm:!w-auto" onClick={() => openTab('settings')}>连接设置</Button>
          </div>
        </div>
        <div className="mt-2.5 grid grid-cols-3 gap-1 rounded-xl bg-zinc-100 p-1 sm:mt-3 sm:flex sm:w-auto sm:items-center sm:gap-1 sm:rounded-none sm:bg-transparent sm:p-0">
          {([
            ['overview', '概览'],
            ['chats', '会话'],
            ['settings', '设置']
          ] as const).map(([value, label]) => <button key={value} type="button" onClick={() => openTab(value)} className={`relative flex items-center justify-center rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors ${tab === value ? 'bg-white text-zinc-900 shadow-sm sm:bg-zinc-100 sm:shadow-none' : 'text-zinc-500 hover:text-zinc-800 sm:hover:bg-zinc-50'}`}>{label}{value === 'chats' && pendingDrafts.length > 0 && <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">{pendingDrafts.length}</span>}</button>)}
        </div>
      </div>

      {actionError && <p className="shrink-0 border-b border-red-100 bg-red-50 px-3.5 py-2 text-[12px] text-red-700 sm:px-5">{actionError}</p>}
      {!listening && !inMobileChatDetail && <div className="flex shrink-0 items-start gap-2 border-b border-amber-100 bg-amber-50 px-3.5 py-2 text-[12px] text-amber-800 sm:items-center sm:px-5"><Pause size={13} className="mt-0.5 shrink-0 sm:mt-0"/><span>监听已暂停，不会接收新消息或触发 Agent；登录凭证仍保留，可随时恢复。</span></div>}
      {listening && !inMobileChatDetail && status.data?.state === 'connecting' && <p className="shrink-0 border-b border-amber-100 bg-amber-50 px-3.5 py-2 text-[12px] text-amber-800 sm:px-5">WebSocket 正在重连{status.data.lastError ? `：${status.data.lastError}` : '…'}</p>}
      {cleanupReminder.shouldShow && tab !== 'settings' && !inMobileChatDetail && (
        <div
          role="status"
          data-testid="lark-avatar-cleanup-reminder"
          className="border-b border-amber-200 bg-amber-50/80 px-4 py-3 text-[12px] text-amber-900 sm:px-5"
        >
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-2.5">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600"/>
              <div className="min-w-0">
                <p className="font-medium leading-5 text-amber-900">
                  当前已保留 {cleanupReminder.inboxCount} 条消息记录，已超过清理提醒阈值（{cleanupReminder.warnThreshold} 条）
                </p>
                <p className="mt-0.5 text-[11px] leading-4 text-amber-800">
                  记录过多会增加本地加载与存储开销；清理仅删除展示记录，不会重复触发已处理消息。
                </p>
              </div>
            </div>
            {!bannerCleanupConfirmOpen ? (
              <div className="flex shrink-0 flex-wrap items-center gap-2 pl-6 sm:pl-0">
                <button
                  type="button"
                  onClick={() => setBannerCleanupConfirmOpen(true)}
                  className="inline-flex h-7 items-center gap-1 rounded-lg bg-zinc-900 px-2.5 text-[11px] font-medium text-white transition-opacity hover:opacity-90"
                >
                  <Trash2 size={12}/>立即清理
                </button>
                <button
                  type="button"
                  onClick={openThresholdSettings}
                  className="inline-flex h-7 items-center rounded-lg border border-amber-200 bg-white px-2.5 text-[11px] font-medium text-amber-900 transition-colors hover:bg-amber-100/70"
                >
                  调整阈值
                </button>
                <button
                  type="button"
                  onClick={() => { setCleanupReminderDismissed(true); setBannerCleanupConfirmOpen(false); }}
                  className="inline-flex h-7 items-center rounded-lg px-2 text-[11px] text-amber-800 transition-colors hover:bg-amber-100/70"
                >
                  暂不处理
                </button>
              </div>
            ) : (
              <div className="flex shrink-0 flex-wrap items-center gap-2 pl-6 sm:pl-0">
                {quickKeepLatest > 0 && (
                  <Button
                    size="small"
                    type="primary"
                    loading={cleanupInbox.isPending && cleanupInbox.variables === quickKeepLatest}
                    disabled={cleanupInbox.isPending}
                    onClick={() => cleanupInbox.mutate(quickKeepLatest)}
                    className="!rounded-lg !bg-zinc-900"
                  >
                    保留最近 {quickKeepLatest} 条
                  </Button>
                )}
                <Button
                  size="small"
                  danger
                  loading={cleanupInbox.isPending && cleanupInbox.variables === 0}
                  disabled={cleanupInbox.isPending}
                  onClick={() => cleanupInbox.mutate(0)}
                >
                  清空全部（{cleanupReminder.inboxCount} 条）
                </Button>
                <Button
                  size="small"
                  disabled={cleanupInbox.isPending}
                  onClick={() => setBannerCleanupConfirmOpen(false)}
                >
                  取消
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'overview' && (
        <div className="min-h-0 flex-1 overflow-y-auto p-3.5 sm:p-5">
          {!listening && <div className="mb-3.5 flex items-start gap-2.5 rounded-xl border border-amber-200/70 bg-amber-50/70 px-3.5 py-3 text-[12px] leading-5 text-amber-900 sm:mb-4 sm:px-4"><Pause size={15} className="mt-0.5 shrink-0"/><div><p className="font-medium">当前处于暂停状态</p><p className="mt-0.5 text-amber-800">新的飞书消息不会被读取，也不会触发 Agent。点击上方「恢复监听」后会重新连接 WebSocket 并继续定时补拉。</p></div></div>}
          <div className="mb-3.5 rounded-xl border border-sky-100 bg-sky-50/60 px-3.5 py-3 text-[12px] leading-5 text-sky-900 sm:mb-4 sm:px-4">
            在飞书聊天里发送 <code className="rounded bg-white/80 px-1 py-0.5 font-mono text-[11px]">{triggerPrefix} 你的问题</code>，
            会自动带上最近 {contextMessages} 条聊天记录（文字消息，含本条触发消息）发起 Agent 轮次；当前转发策略为「{savedReplyForwardMeta.label}」（{savedReplyForwardMeta.shortHint}），可在「设置」页随时切换三档转发策略。后台每 {status.data?.syncIntervalSeconds ?? 30} 秒补拉一次群聊。
          </div>
          <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
            <Stat label="收到消息" value={currentInboxCount} hint={formatRetentionSummary(savedInboxMaxItems)}/>
            <Stat label="会话" value={conversations.length}/>
            <Stat label="AI 触发" value={triggerCount} hint={`${triggerPrefix} 前缀`}/>
            <Stat label="已发送" value={sentDrafts.length} hint={pendingDrafts.length ? `${pendingDrafts.length} 条待补发` : '全部已送达'}/>
          </div>
          <div className="mt-4 grid gap-4 sm:mt-5 sm:gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,.65fr)]">
            <section className={`${section} overflow-hidden`}>
              <div className="flex items-center justify-between border-b border-zinc-100 px-3.5 py-3 sm:px-4"><h3 className="text-[13px] font-semibold text-zinc-900">最近会话</h3><button type="button" onClick={() => openTab('chats')} className="text-[11px] text-zinc-500 hover:text-zinc-900">全部会话</button></div>
              {conversations.length ? <div className="divide-y divide-zinc-100">{conversations.slice(0, 6).map(conversation => <button key={conversation.key} type="button" onClick={() => selectConversation(conversation)} className="flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-zinc-50 sm:px-4"><Avatar name={conversation.title} src={conversation.avatarUrl} fallbackSrc={conversation.avatarFallbackUrl} size={32}/><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className="truncate text-[12px] font-medium text-zinc-800">{conversation.title}</span><span className="shrink-0 text-[10px] text-zinc-400">{timeLabel(conversation.latestAt)}</span></div><p className="mt-0.5 truncate text-[11px] text-zinc-500">{conversation.latestText || '暂无消息'}</p></div><ChevronRight size={14} className="shrink-0 text-zinc-300 sm:hidden"/></button>)}</div> : <div className="px-4 py-10 text-center text-[12px] text-zinc-400">还没有收到消息</div>}
            </section>
            <section className={`${section} overflow-hidden`}>
              <div className="border-b border-zinc-100 px-3.5 py-3 sm:px-4"><h3 className="text-[13px] font-semibold text-zinc-900">最近发送</h3></div>
              {sentDrafts.length ? <div className="divide-y divide-zinc-100">{sentDrafts.slice(0, 5).map(draft => {
                const conversation = conversations.find(item => item.drafts.some(value => value.id === draft.id));
                return <button key={draft.id} type="button" onClick={() => { if (conversation) selectConversation(conversation); }} className="block w-full px-3.5 py-3 text-left hover:bg-zinc-50 sm:px-4"><div className="flex items-center justify-between gap-2"><span className="truncate text-[11px] font-medium text-zinc-700">{conversation?.title || draft.target}</span><span className="shrink-0 text-[10px] text-zinc-400">{timeLabel(draft.updatedAt)}</span></div><p className="mt-1 line-clamp-2 text-[11px] leading-4 text-zinc-500">{draft.body || '等待补充正文'}</p></button>;
              })}</div> : <div className="px-4 py-10 text-center text-[12px] text-zinc-400">还没有发送记录</div>}
            </section>
          </div>
        </div>
      )}

      {tab === 'chats' && (
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <aside
            data-testid="lark-avatar-chat-list"
            className={`${mobileChatView === 'detail' && selected ? 'hidden sm:flex' : 'flex'} min-h-0 flex-1 flex-col sm:w-[270px] sm:flex-none sm:border-r sm:border-zinc-100`}
          >
            <div className="shrink-0 p-3"><div className="relative"><Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400"/><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索会话" className="h-9 w-full rounded-lg bg-zinc-100 pl-8 pr-3 text-[12px] text-zinc-800 outline-none placeholder:text-zinc-400 sm:h-8"/></div></div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-2">
              {filtered.map(conversation => <button key={conversation.key} type="button" data-testid={`chat-list-item-${conversation.chatId}`} onClick={() => { setSelectedKey(conversation.key); setMobileChatView('detail'); }} className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-3 text-left transition-colors sm:items-start sm:rounded-lg sm:py-2.5 ${conversation.key === selectedKey ? 'bg-zinc-100' : 'hover:bg-zinc-50'}`}><Avatar name={conversation.title} src={conversation.avatarUrl} fallbackSrc={conversation.avatarFallbackUrl} size={36}/><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className="truncate text-[13px] font-medium text-zinc-800 sm:text-[12px]">{conversation.title}</span><span className="shrink-0 text-[10px] text-zinc-400 sm:text-[9px]">{timeLabel(conversation.latestAt)}</span></div><p className="mt-0.5 truncate text-[12px] text-zinc-500 sm:text-[11px]">{conversation.latestText || '暂无消息'}</p>{conversation.drafts.some(draft => draft.state === 'pending' || draft.state === 'failed') && <span className="mt-1 inline-flex items-center gap-1 text-[10px] text-amber-700"><Sparkles size={10}/>有回复待补发</span>}</div><ChevronRight size={15} className="shrink-0 text-zinc-300 sm:hidden"/></button>)}
              {!filtered.length && <p className="px-3 py-10 text-center text-[12px] text-zinc-400 sm:text-[11px]">{search ? '没有匹配的会话' : '还没有会话'}</p>}
            </div>
          </aside>
          <section
            data-testid="lark-avatar-chat-detail"
            className={`${mobileChatView === 'detail' && selected ? 'flex' : 'hidden sm:flex'} min-h-0 min-w-0 flex-1 flex-col`}
          >
            {selected ? <>
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2.5 sm:px-4 sm:py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    data-testid="mobile-chat-back"
                    aria-label="返回会话列表"
                    onClick={() => setMobileChatView('list')}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 sm:hidden"
                  >
                    <ArrowLeft size={16}/>
                  </button>
                  <Avatar name={selected.title} src={selected.avatarUrl} fallbackSrc={selected.avatarFallbackUrl} size={30}/>
                  <div className="min-w-0">
                    <h3 className="truncate text-[13px] font-semibold text-zinc-900">{selected.title}</h3>
                    <p className="truncate text-[10px] text-zinc-400">{selected.chatType === 'p2p' ? '私聊' : selected.chatType === 'group' ? '群聊' : selected.chatType || '飞书会话'} · {selected.items.length} 条消息{selected.drafts.length ? ` · ${selected.drafts.length} 条回复` : ''}</p>
                  </div>
                </div>
                <span className="hidden shrink-0 text-[10px] text-zinc-400 sm:inline">{pendingDrafts.filter(draft => selected.drafts.some(value => value.id === draft.id)).length} 条待补发</span>
              </div>
              <div ref={messagesRef} className="min-h-0 flex-1 overflow-y-auto bg-zinc-50/40 px-3.5 py-3.5 sm:px-5 sm:py-4">
                {selectedTimeline.length ? <>
                  {selectedTimeline.map(entry => {
                    if (entry.kind === 'draft') {
                      const draft = entry.draft;
                      return <div key={draft.id}><DraftBlock draft={draft} body={draftBodies[draft.id] ?? draft.body} onBody={value => setDraftBodies(previous => ({ ...previous, [draft.id]: value }))} onSend={() => sendDraft.mutate(draft)} onDiscard={() => discardDraft.mutate(draft.id)} sending={sendDraft.isPending && sendDraft.variables?.id === draft.id} discarding={discardDraft.isPending && discardDraft.variables === draft.id} accountName={status.data?.account?.name} accountAvatarUrl={status.data?.account?.avatarUrl}/></div>;
                    }
                    const item = entry.item;
                    const isTrigger = item.title.trim().startsWith(triggerPrefix);
                    const own = Boolean(item.senderId && item.senderId === status.data?.account?.userId);
                    return <div key={item.id} className={`mb-4 flex items-start gap-2 sm:mb-5 sm:gap-2.5 ${own ? 'flex-row-reverse' : ''}`}>
                      <Avatar name={item.senderName || selected.title} src={item.senderAvatarUrl} size={28}/>
                      <div className={`min-w-0 max-w-[85%] sm:max-w-[78%] ${own ? 'text-right' : ''}`}>
                        <div className={`mb-1 flex flex-wrap items-center gap-1.5 sm:gap-2 ${own ? 'justify-end' : ''}`}><span className="text-[11px] font-medium text-zinc-700">{item.senderName || selected.title}</span><span className="text-[10px] text-zinc-400">{fullTime(item.occurredAt)}</span>{isTrigger && <span className="rounded-full bg-sky-50 px-1.5 py-0.5 text-[9px] font-medium text-sky-700">Agent 触发</span>}</div>
                        <div className={`inline-block whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-left text-[13px] leading-5 sm:px-3.5 sm:py-2.5 ${own ? 'rounded-tr-md bg-sky-600 text-white' : 'rounded-tl-md border border-zinc-200 bg-white text-zinc-800'}`}>{item.title || item.summary}</div>
                      </div>
                    </div>;
                  })}
                </> : <div className="grid h-full place-items-center text-center"><div><MessageCircle size={26} className="mx-auto text-zinc-300"/><p className="mt-2 text-[12px] text-zinc-400">这个会话还没有消息</p></div></div>}
              </div>
              <div className="shrink-0 border-t border-zinc-100 p-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:p-3">
                {composerUndo?.canUndo && (
                  <div className="mb-1.5 flex justify-end">
                    <AiUndoCapsule
                      undoDepth={composerUndo.undoDepth}
                      lastLabel={composerUndo.lastLabel}
                      undoing={composerUndo.undoing}
                      onUndo={composerUndo.undo}
                      onDismiss={composerUndo.clearUndo}
                    />
                  </div>
                )}
                <div className={`flex items-end gap-1.5 rounded-xl border border-zinc-200 bg-white p-2 focus-within:border-zinc-400 ${composerFlash.flashClass}`}>
                  <textarea value={composer} onChange={event => setComposer(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (composer.trim() && !manualSend.isPending) manualSend.mutate({ conversation: selected, body: composer }); } }} rows={1} placeholder={`发送给 ${selected.title}…`} className="max-h-28 min-h-8 flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] leading-5 text-zinc-800 outline-none placeholder:text-zinc-400 sm:text-[12px]"/>
                  <AiTextAssistControl
                    mode="message_polish"
                    variant="icon"
                    size="sm"
                    popoverSide="top"
                    popoverAlign="end"
                    value={composer}
                    onChange={setComposer}
                    onFlash={composerFlash.triggerFlash}
                    hideInlineUndo
                    onUndoStateChange={setComposerUndo}
                    resetKey={`${selected.key}:${composerSendEpoch}`}
                    disabled={manualSend.isPending}
                    ariaLabel="AI 润色飞书消息"
                    context={() => ({
                      field: '飞书聊天回复输入框',
                      purpose: '以本人身份发送给飞书私聊或群聊的自然得体消息',
                      groupName: selected.title,
                      recentMessages: selected.items.slice(-6).map(item => ({
                        role: item.senderName || '成员',
                        text: item.title || item.summary || ''
                      })).filter(entry => entry.text.trim())
                    })}
                    testId="lark-avatar-composer-ai"
                  />
                  <button type="button" aria-label="发送消息" disabled={!composer.trim() || manualSend.isPending} onClick={() => manualSend.mutate({ conversation: selected, body: composer })} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-zinc-900 text-white transition-opacity hover:bg-zinc-800 disabled:opacity-30 sm:h-8 sm:w-8"><Send size={13}/></button>
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
                <label className="flex flex-col"><span className={field}>Agent</span><CompactSelect options={agentOptions} value={agentId} placeholder="选择 Agent" disabledText="没有可用 Agent" popupWidth={380} onChange={value => { setAgentId(value); setModel(''); setReasoningEffort(''); }}/></label>
                <label className="flex flex-col"><span className={field}>默认模型</span><CompactSelect options={modelOptions} value={model} placeholder="选择模型" disabledText="暂无可用模型" disabled={!models.data?.models.length} popupWidth={380} onChange={setModel}/></label>
                <label className="flex flex-col"><span className={field}>推理强度</span><CompactSelect options={reasoningOptions} value={reasoningEffort} placeholder="选择推理强度" disabledText="当前 Agent 未提供推理强度" disabled={!models.data?.reasoningEfforts.length} popupWidth={300} onChange={setReasoningEffort}/></label>
                <div className="flex flex-col">
                  <span className={field}>工作目录</span>
                  <div className="mt-1.5 flex items-start gap-2">
                    <div className="min-w-0 flex-1"><SuggestedValueInput size="compact" wrapperClassName="" value={workspace} onChange={setWorkspace} label="工作目录" placeholder="留空使用默认工作目录" suggestion={selectedAgent?.cwd || capabilities.data?.workingDirectory} suggestionLabel="使用 Agent 默认工作目录"/></div>
                    <button type="button" disabled={!capabilities.data?.directoryPicker || pickWorkspace.isPending} onClick={() => pickWorkspace.mutate()} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 text-[12px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40">{pickWorkspace.isPending ? <LoaderCircle size={12} className="animate-spin"/> : <FolderOpen size={12}/>}选择</button>
                  </div>
                </div>
                <label className="flex flex-col"><span className={field}>单轮超时（秒）</span><input className={`${input} tabular-nums`} type="number" min={0} max={86400} value={agentTimeoutSeconds} onChange={event => setAgentTimeoutSeconds(Math.min(86_400, Math.max(0, Number(event.target.value) || 0)))}/><p className="mt-1.5 text-[11px] leading-4 text-zinc-400">0 表示不限制；超时后会结束本轮。</p></label>
                <div className="flex flex-col">
                  <span className={field}>Agent 记忆范围</span>
                  <Segmented<'anchor' | 'chat'> ariaLabel="Agent 记忆范围" className="mt-1.5" value={contextScope} onChange={setContextScope} options={[{ value: 'anchor', label: '按话题隔离' }, { value: 'chat', label: '整个会话共享' }]}/>
                  <p className="mt-1.5 text-[11px] leading-4 text-zinc-400">{contextScope === 'anchor' ? '每个飞书话题各自独立维护 Agent 记忆，互不串线。' : '同一聊天内的不同话题共用同一段 Agent 记忆。'}</p>
                </div>
              </div>
              <p className="mt-3 text-[11px] leading-5 text-zinc-400">{models.isFetching ? '正在读取 Agent 能力…' : models.data?.warning || '修改 Agent 配置后，下一次 /ai 触发会创建对应的新会话。'}</p>
            </section>

            <section className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(24,24,27,.03)] sm:p-5">
              <div className="flex items-start gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-zinc-100 text-zinc-600"><Users size={15}/></span>
                <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-[14px] font-semibold text-zinc-900">消息监听</h3><span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-500">{listenMode === 'all' ? '全部会话' : `已选 ${listenChats.length} 个`}</span></div><p className="mt-1 text-[11px] leading-5 text-zinc-500">决定读取哪些会话的消息和上下文。默认监听账号可见的全部会话。</p></div>
              </div>
              <Segmented<'all' | 'selected'> ariaLabel="消息监听范围" className="mt-4" value={listenMode} onChange={setListenMode} options={[{ value: 'all', label: '全部会话' }, { value: 'selected', label: '指定会话' }]}/>
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
              <p className="mt-3 text-[10px] leading-4 text-zinc-400">图片不会下载，只保存占位摘要；消息记录保留条数与清理提醒可在下方「消息记录保留与清理」中自定义。</p>
            </section>

            <section ref={retentionSectionRef} data-testid="lark-avatar-retention-section" className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(24,24,27,.03)] sm:p-5">
              <div className="flex items-start gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-zinc-100 text-zinc-600"><Database size={15}/></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[14px] font-semibold text-zinc-900">消息记录保留与清理</h3>
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-500">当前 {currentInboxCount} 条</span>
                    {savedCleanupWarnThreshold > 0 && currentInboxCount > savedCleanupWarnThreshold && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">已超提醒阈值</span>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] leading-5 text-zinc-500">自定义本地最近消息面板的保留上限（支持设为 0 不限制），并设置打开面板时的超阈值清理提醒。</p>
                </div>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col">
                  <span className={field}>记录保留上限（条，0 表示不限制）</span>
                  <input
                    data-testid="inbox-max-items-input"
                    aria-invalid={!parsedInboxMaxItems.ok}
                    className={`${input} tabular-nums`}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={MAX_CONFIGURABLE_INBOX_ITEMS}
                    step={1}
                    value={inboxMaxItemsInput}
                    onChange={event => setInboxMaxItemsInput(event.target.value)}
                  />
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {([['60', '默认 60'], ['200', '200 条'], ['500', '500 条'], ['0', '不限制 (0)']] as const).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setInboxMaxItemsInput(val)}
                        className={`inline-flex h-6 items-center rounded-md px-2 text-[11px] font-medium transition-colors ${inboxMaxItemsInput.trim() === val ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 hover:text-zinc-900'}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {!parsedInboxMaxItems.ok
                    ? <p className="mt-1.5 text-[11px] leading-4 text-red-600">{parsedInboxMaxItems.error}</p>
                    : <p className="mt-1.5 text-[11px] leading-4 text-zinc-400">默认 60 条；设为 0 表示不限制，写入新消息时不再自动淘汰旧记录。调小非零上限保存后会立即裁剪超出的最旧记录。</p>}
                </label>
                <label className="flex flex-col">
                  <span className={field}>超过多少条时打开提醒清理</span>
                  <input
                    ref={thresholdInputRef}
                    data-testid="inbox-cleanup-threshold-input"
                    aria-invalid={!parsedCleanupThreshold.ok}
                    className={`${input} tabular-nums`}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={MAX_CONFIGURABLE_INBOX_ITEMS}
                    step={1}
                    value={inboxCleanupWarnThresholdInput}
                    onChange={event => setInboxCleanupWarnThresholdInput(event.target.value)}
                  />
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {([['100', '100 条'], ['200', '默认 200'], ['500', '500 条'], ['0', '关闭提醒 (0)']] as const).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setInboxCleanupWarnThresholdInput(val)}
                        className={`inline-flex h-6 items-center rounded-md px-2 text-[11px] font-medium transition-colors ${inboxCleanupWarnThresholdInput.trim() === val ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 hover:text-zinc-900'}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {!parsedCleanupThreshold.ok
                    ? <p className="mt-1.5 text-[11px] leading-4 text-red-600">{parsedCleanupThreshold.error}</p>
                    : <p className="mt-1.5 text-[11px] leading-4 text-zinc-400">默认 200 条；打开飞书替身时，若本地已保留消息数超过该条数将展示清理提醒；设为 0 表示关闭提醒。</p>}
                </label>
              </div>
              <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50/70 px-3.5 py-3">
                <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-[12px] font-medium text-zinc-800">
                      当前本地共 {currentInboxCount} 条消息记录 · {formatRetentionSummary(savedInboxMaxItems)}
                    </p>
                    <p className="mt-0.5 text-[10px] leading-4 text-zinc-500">
                      {savedCleanupWarnThreshold > 0 ? `打开提醒阈值：超过 ${savedCleanupWarnThreshold} 条时提醒。` : '已关闭打开清理提醒。'}清理仅删除展示记录，不影响已处理消息去重；回复记录最多保留 80 条（待发送的会保留）。
                    </p>
                  </div>
                  {!settingsCleanupConfirm ? (
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {quickKeepLatest > 0 && (
                        <Button
                          size="small"
                          disabled={cleanupInbox.isPending}
                          onClick={() => setSettingsCleanupConfirm({ keepLatest: quickKeepLatest })}
                        >
                          保留最近 {quickKeepLatest} 条
                        </Button>
                      )}
                      <Button
                        size="small"
                        danger
                        icon={<Trash2 size={12}/>}
                        disabled={currentInboxCount === 0 || cleanupInbox.isPending}
                        onClick={() => setSettingsCleanupConfirm({ keepLatest: 0 })}
                      >
                        清空消息记录
                      </Button>
                    </div>
                  ) : (
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <span className="text-[11px] font-medium text-amber-800">
                        {settingsCleanupConfirm.keepLatest === 0
                          ? `确认清空全部 ${currentInboxCount} 条？`
                          : `确认删除更早的 ${Math.max(0, currentInboxCount - settingsCleanupConfirm.keepLatest)} 条？`}
                      </span>
                      <Button
                        size="small"
                        type="primary"
                        danger={settingsCleanupConfirm.keepLatest === 0}
                        loading={cleanupInbox.isPending}
                        onClick={() => cleanupInbox.mutate(settingsCleanupConfirm.keepLatest)}
                        className={settingsCleanupConfirm.keepLatest === 0 ? '' : '!rounded-lg !bg-zinc-900'}
                      >
                        确认清理
                      </Button>
                      <Button
                        size="small"
                        disabled={cleanupInbox.isPending}
                        onClick={() => setSettingsCleanupConfirm(null)}
                      >
                        取消
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(24,24,27,.03)] sm:p-5">
              <div className="flex items-start gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-zinc-100 text-zinc-600"><MessageCircle size={15}/></span>
                <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-[14px] font-semibold text-zinc-900">回复方式</h3><span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-700">转发策略与位置</span></div><p className="mt-1 text-[11px] leading-5 text-zinc-500">控制 Agent 回复是否转发到飞书，以及回复发到主会话、原话题、引用或新话题。</p></div>
              </div>
              <div className="mt-4 space-y-3">
                <div className="rounded-xl border border-zinc-200 px-3.5 py-3" data-testid="reply-forward-mode-section">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="text-[13px] font-medium text-zinc-900">飞书回复转发策略</p>
                      {activeReplyForwardMeta.badge && (
                        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${replyForwardMode === 'none' ? 'bg-emerald-50 text-emerald-700' : 'bg-zinc-100 text-zinc-600'}`}>
                          {activeReplyForwardMeta.badge}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] leading-5 text-zinc-500">选择 /ai 触发后 Agent 文本如何发回当前飞书会话。</p>
                  </div>
                  <div
                    role="radiogroup"
                    aria-label="飞书回复转发策略"
                    data-testid="reply-forward-mode-group"
                    className="mt-3 grid grid-cols-1 items-stretch gap-2 sm:grid-cols-3"
                  >
                    {LARK_AVATAR_REPLY_FORWARD_OPTIONS.map(option => {
                      const active = replyForwardMode === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          data-testid={`reply-forward-mode-${option.value}`}
                          onClick={() => setReplyForwardMode(option.value)}
                          className={`flex h-full flex-col justify-between rounded-xl border px-3 py-2.5 text-left transition-colors ${active ? 'border-zinc-900 bg-zinc-50/90 shadow-[0_1px_2px_rgba(24,24,27,.06)] ring-1 ring-zinc-900/10' : 'border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50/50'}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                              <span className={`text-[12px] font-semibold leading-5 ${active ? 'text-zinc-900' : 'text-zinc-700'}`}>{option.label}</span>
                              {option.badge && (
                                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none ${option.value === 'none' ? 'bg-emerald-50 text-emerald-700' : 'bg-zinc-100 text-zinc-500'}`}>
                                  {option.badge}
                                </span>
                              )}
                            </span>
                            <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border transition-colors ${active ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-300 text-transparent'}`}>
                              <Check size={10}/>
                            </span>
                          </div>
                          <p className="mt-1.5 text-[11px] leading-4 text-zinc-500">{option.cardSummary}</p>
                        </button>
                      );
                    })}
                  </div>
                  <p
                    data-testid="reply-forward-mode-description"
                    className={`mt-2.5 rounded-lg px-3 py-2 text-[11px] leading-5 ${replyForwardMode === 'none' ? 'bg-emerald-50/70 text-emerald-800' : 'bg-zinc-50 text-zinc-600'}`}
                  >
                    {activeReplyForwardMeta.description}
                  </p>
                  <p className="mt-1.5 text-[11px] leading-4 text-zinc-400">
                    {LARK_AVATAR_REPLY_FORWARD_SUMMARY}
                  </p>
                </div>
                {replyForwardMode === 'none' && (
                  <p className="rounded-xl border border-amber-200/70 bg-amber-50/60 px-3.5 py-2 text-[11px] leading-5 text-amber-800">
                    当前已选择「不在飞书回复」，下方回复位置与署名设置会继续保留，仅在重新开启飞书回复后生效。
                  </p>
                )}
                <div className="rounded-xl border border-zinc-200 px-3.5 py-3">
                  <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <div className="min-w-0"><p className="text-[13px] font-medium text-zinc-900">话题内的消息</p><p className="mt-0.5 text-[11px] leading-5 text-zinc-500">回复到原话题，或发到外面的主会话。</p></div>
                    <div className="w-full shrink-0 sm:w-[220px]"><Segmented<'in' | 'out'> ariaLabel="话题内的消息回复位置" value={replyInTopic ? 'in' : 'out'} onChange={value => setReplyInTopic(value === 'in')} options={[{ value: 'in', label: '话题内' }, { value: 'out', label: '主会话' }]}/></div>
                  </div>
                </div>
                <div className="rounded-xl border border-zinc-200 px-3.5 py-3">
                  <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <div className="min-w-0"><p className="text-[13px] font-medium text-zinc-900">主会话的消息</p><p className="mt-0.5 text-[11px] leading-5 text-zinc-500">单聊和普通群都支持直接发送、引用回复或开话题回复。</p></div>
                    <div className="w-full shrink-0 sm:w-[280px]"><Segmented<'direct' | 'quote' | 'thread'> ariaLabel="主会话的消息回复方式" value={replyMode} onChange={setReplyMode} options={[{ value: 'direct', label: '直接发送' }, { value: 'quote', label: '引用回复' }, { value: 'thread', label: '开话题回复' }]}/></div>
                  </div>
                </div>
                <div className="rounded-xl border border-zinc-200 px-3.5 py-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1"><p className="text-[13px] font-medium text-zinc-900">随机表情回应</p><p className="mt-0.5 text-[11px] leading-5 text-zinc-500">触发后先在原消息上加 2–3 个随机飞书表情，再开始生成回复；加表情失败的原因会显示在下方排障卡片。</p></div>
                    <Switch size="small" className="shrink-0" aria-label="随机表情回应" checked={emojiReactions} onChange={setEmojiReactions}/>
                  </div>
                </div>
                <div className="flex flex-col rounded-xl border border-zinc-200 px-3.5 py-3">
                  <AiFieldHeader
                    label={<span className="text-[13px] font-medium text-zinc-900">回复署名（可选）</span>}
                    htmlFor="lark-avatar-reply-signature"
                    assist={
                      <AiTextAssistControl
                        mode="description_polish"
                        variant="pill"
                        size="xs"
                        popoverSide="top"
                        popoverAlign="end"
                        value={replySignature}
                        onChange={setReplySignature}
                        onFlash={signatureFlash.triggerFlash}
                        context={() => ({
                          field: '飞书 AI 替身回复署名',
                          purpose: '附在飞书 AI 替身自动回复消息末尾的简短得体署名，例如「—— 🤖 数字分身」，单行且不超过 36 字',
                          maxChars: 36,
                          ...(status.data?.account?.name ? { extra: `飞书账号：${status.data.account.name}` } : {})
                        })}
                        testId="lark-avatar-signature-ai"
                      />
                    }
                  />
                  <input id="lark-avatar-reply-signature" className={`${input} ${signatureFlash.flashClass}`} value={replySignature} maxLength={100} onChange={event => setReplySignature(event.target.value)} placeholder="例如：—— 🤖 数字分身"/>
                  <p className="mt-1.5 text-[11px] leading-4 text-zinc-400">加在 Agent 发出的每条消息末尾；手动发送的消息不加。</p>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(24,24,27,.03)] sm:p-5">
              <div className="flex items-start gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-zinc-100 text-zinc-600"><UserRound size={15}/></span>
                <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-[14px] font-semibold text-zinc-900">触发规则</h3><span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-700">仅本人可触发</span></div><p className="mt-1 text-[11px] leading-5 text-zinc-500">只有你本人发送匹配前缀的消息才会发起 Agent 轮次；其他人的消息只作为上下文，即使发送相同前缀也不会触发。</p></div>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col"><span className={field}>触发前缀</span><input className={`${input} font-mono`} value={triggerPrefix} placeholder="/ai" onChange={event => setTriggerPrefix(event.target.value)}/><p className="mt-1.5 text-[11px] leading-4 text-zinc-400">你发送该前缀开头的消息即触发 Agent 轮次。</p></label>
                <label className="flex flex-col">
                  <span className={field}>每轮注入条数（1–50）</span>
                  <input className={`${input} tabular-nums`} type="number" min={1} max={50} value={contextMessages} onChange={event => setContextMessages(Number(event.target.value) || 10)}/>
                  <p className="mt-1.5 text-[11px] leading-4 text-zinc-400">每次触发时，附上最近 N 条文字消息（含本条触发消息）给 Agent；不是 Agent 的记忆条数，也不影响最近消息面板的保留上限。</p>
                </label>
              </div>
              <div className="mt-3 rounded-xl bg-zinc-50 px-3.5 py-2.5 text-[11px] leading-5 text-zinc-500">你发送 <code className="rounded bg-white px-1 py-0.5 font-mono text-zinc-700">{triggerPrefix} 你的问题</code> 即触发；{activeReplyForwardMeta.shortHint}。</div>
            </section>

            <section className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(24,24,27,.03)] sm:p-5">
              <div className="flex items-start gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-zinc-100 text-zinc-600"><Sparkles size={15}/></span>
                <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-[14px] font-semibold text-zinc-900">表情触发</h3><span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">Beta</span></div><p className="mt-1 text-[11px] leading-5 text-zinc-500">在飞书消息上添加一个指定表情，就会以这条消息为上下文开启一轮 Agent。和上面的「随机表情回应」是两个方向：那个是替身发出反馈，这个是替你发起任务。</p></div>
              </div>
              <div className="mt-4 space-y-3">
                <div className="rounded-xl border border-zinc-200 px-3.5 py-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1"><p className="text-[13px] font-medium text-zinc-900">启用表情触发</p><p className="mt-0.5 text-[11px] leading-5 text-zinc-500">关闭时不因 reaction 开轮次；事件仍会到达，排障卡片会显示「表情触发未启用」，随机表情回应不受影响。</p></div>
                    <Switch size="small" className="shrink-0" aria-label="启用表情触发" checked={reactionTriggerEnabled} onChange={checked => { setReactionTriggerEnabled(checked); if (checked && !reactionTriggerEmoji.trim()) setReactionTriggerEmoji(DEFAULT_LARK_AVATAR_REACTION_TRIGGER_EMOJI); }}/>
                  </div>
                </div>
                <div className="rounded-xl border border-zinc-200 px-3.5 py-3">
                  <span className="block text-[13px] font-medium text-zinc-900">触发 emoji</span>
                  <ReactionEmojiPicker value={reactionTriggerEmoji} onChange={setReactionTriggerEmoji}/>
                  {reactionEmojiIsCustom(reactionTriggerEmoji) && <p className="mt-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] leading-4 text-amber-700">当前值 <code className="font-mono">{reactionTriggerEmoji.trim()}</code> 不在常用集合里，保存会继续保留；也可以从列表里换一个。</p>}
                  <p className="mt-1.5 text-[11px] leading-4 text-zinc-400">从常用飞书表情里选一个；开启表情触发时若为空会自动预填 OK，也可自由更换。</p>
                </div>
                <div className="rounded-xl border border-zinc-200 px-3.5 py-3">
                  <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-zinc-900">默认路由</p>
                      <p className="mt-0.5 text-[11px] leading-5 text-zinc-500">主会话：派活到主会话；独立轮次：新开独立会话；先询问：卡片确认。</p>
                    </div>
                    <div className="w-full shrink-0 sm:w-[260px]">
                      <Segmented<LarkAvatarReactionRoute> ariaLabel="表情触发默认路由" value={reactionTriggerRoute} onChange={setReactionTriggerRoute} options={LARK_AVATAR_REACTION_ROUTE_OPTIONS}/>
                    </div>
                  </div>
                </div>
                <div className="rounded-xl border border-zinc-200 px-3.5 py-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1"><p className="text-[13px] font-medium text-zinc-900">忽略机器人添加的表情</p><p className="mt-0.5 text-[11px] leading-5 text-zinc-500">其他机器人/应用加的表情不触发；替身自己加的反馈表情始终排除。</p></div>
                    <Switch size="small" className="shrink-0" aria-label="忽略机器人添加的表情" checked={reactionTriggerIgnoreBots} onChange={setReactionTriggerIgnoreBots}/>
                  </div>
                </div>
                {reactionTriggerEnabled && !reactionTriggerEmoji.trim() && <p className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-[11px] leading-5 text-amber-700">还没有填触发 emoji，保存后也不会触发。</p>}
                <div className="rounded-xl bg-zinc-50 px-3.5 py-2.5 text-[11px] leading-5 text-zinc-500">
                  reaction 事件由已配置的飞书机器人投递：机器人需要在目标会话里，并有消息读取权限；飞书只有 reaction 事件，没有 Pin 事件。
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(24,24,27,.03)] sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-zinc-100 text-zinc-600"><CircleAlert size={15}/></span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[14px] font-semibold text-zinc-900">表情触发排障</h3>
                    <p className="mt-1 text-[11px] leading-5 text-zinc-500">最近一次 reaction 事件和触发账本。事件到了但没开轮次时，这里会写清楚是没启用、emoji 不匹配、被去重，还是权限/主会话问题。</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void refreshDiagnostics()}
                  disabled={refreshState === 'refreshing'}
                  title={refreshState === 'failed'
                    ? `刷新失败：${errorText(reactionDiagnostics.error) || '请稍后重试'}`
                    : reactionDiagnostics.dataUpdatedAt
                      ? `上次更新 ${fullTime(new Date(reactionDiagnostics.dataUpdatedAt).toISOString())}`
                      : '刷新排障数据'}
                  className={`inline-flex h-8 min-w-[84px] shrink-0 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[11px] transition-colors disabled:opacity-40 ${refreshState === 'failed' ? 'text-red-600 hover:bg-red-50' : 'text-zinc-500 hover:bg-zinc-100'}`}>
                  <RefreshCw size={12} className={refreshState === 'refreshing' ? 'animate-spin' : ''}/>
                  {refreshState === 'refreshing' ? '刷新中' : refreshState === 'failed' ? '刷新失败' : refreshState === 'done' ? '已刷新' : '刷新'}
                </button>
              </div>
              {reactionDiagnostics.isError && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[10px] leading-4 text-red-700">排障数据读取失败：{errorText(reactionDiagnostics.error) || '请稍后重试'}</p>}
              <div className="mt-4 space-y-2">
                {(() => {
                  const source = reactionSourceStatus(reactionDiagnostics.data?.source);
                  return <div className={`rounded-xl border px-3.5 py-2.5 ${source.ok ? 'border-emerald-200 bg-emerald-50/50' : 'border-amber-200 bg-amber-50/50'}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className={`text-[11px] font-medium ${source.ok ? 'text-emerald-800' : 'text-amber-800'}`}>{source.label}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] ${source.ok ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>事件通道</span>
                    </div>
                    <p className={`mt-1 break-all text-[10px] leading-4 ${source.ok ? 'text-emerald-700/80' : 'text-amber-700'}`}>{source.detail}</p>
                  </div>;
                })()}
                {reactionDiagnostics.data?.lastOutboundReaction && (() => {
                  const out = reactionDiagnostics.data.lastOutboundReaction!;
                  const ok = out.failed.length === 0;
                  return <div className={`rounded-xl border px-3.5 py-2.5 ${ok ? 'border-zinc-200' : 'border-red-200 bg-red-50/40'}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className={`text-[11px] font-medium ${ok ? 'text-zinc-700' : 'text-red-700'}`}>随机表情回应：成功 {out.succeeded.length}/{out.picked.length}</span>
                      <span className="text-[10px] text-zinc-400">{fullTime(out.at)}</span>
                    </div>
                    <p className="mt-1 break-all font-mono text-[10px] leading-4 text-zinc-500">{out.messageId} · {out.picked.join(', ')}</p>
                    {out.failed.length > 0 && <p className="mt-1 break-words text-[10px] leading-4 text-red-700">{out.failed.map(item => `${item.emoji}: ${item.error}`).join('；')}</p>}
                  </div>;
                })()}
                {reactionDiagnostics.data?.lastEvent ? (() => {
                  const event = reactionDiagnostics.data.lastEvent;
                  return <div className="rounded-xl border border-zinc-200 px-3.5 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[12px] font-medium text-zinc-800">{reactionOutcomeLabel(event.outcome)}</span>
                      <span className="text-[10px] text-zinc-400">{fullTime(event.at)}</span>
                    </div>
                    <p className="mt-1 break-all font-mono text-[10px] leading-4 text-zinc-500">{event.emojiType} · {event.operatorType ?? 'unknown'}/{event.operatorId ?? '?'} · {event.messageId}</p>
                    {event.detail && <p className="mt-1 break-words text-[10px] leading-4 text-amber-700">原因：{event.detail}</p>}
                    {(event.sessionId || event.taskId) && <p className="mt-1 break-all font-mono text-[10px] leading-4 text-zinc-400">{event.sessionId ? `session=${event.sessionId}` : ''} {event.taskId ? `task=${event.taskId}` : ''}</p>}
                  </div>;
                })() : <div className="rounded-xl border border-dashed border-zinc-200 px-3.5 py-3 text-[11px] leading-5 text-zinc-500">
                  {(reactionDiagnostics.data?.triggers?.length ?? 0) > 0
                    ? '本次进程启动后还没有收到新的 reaction 事件；下面是之前持久化的触发账本。'
                    : '还没有收到 reaction 事件。'}
                  {' '}若已在飞书加过表情：确认机器人已加入该会话、应用已订阅 <code className="rounded bg-zinc-100 px-1 font-mono text-[10px]">im.message.reaction.created_v1</code>、且替身监听没有暂停。
                </div>}
                {(reactionDiagnostics.data?.triggers?.length ?? 0) > 0 && <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-left text-[11px]">
                      <thead>
                        <tr className="border-b border-zinc-200/80 bg-zinc-50/80 text-[11px] font-medium text-zinc-500">
                          <th className="whitespace-nowrap px-3 py-2 font-medium">表情 · 路由</th>
                          <th className="px-3 py-2 font-medium">消息与说明</th>
                          <th className="whitespace-nowrap px-3 py-2 text-right font-medium">状态</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-100">
                        {reactionDiagnostics.data!.triggers.slice(0, 5).map(trigger => (
                          <tr key={trigger.key} className="transition-colors hover:bg-zinc-50/80">
                            <td className="whitespace-nowrap px-3 py-2 align-middle">
                              <div className="font-medium text-zinc-800">{trigger.emoji}</div>
                              <div className="text-[10px] text-zinc-400">{trigger.route} · {trigger.operatorType ?? 'unknown'}</div>
                            </td>
                            <td className="max-w-[320px] px-3 py-2 align-middle">
                              <div className="truncate font-mono text-[10px] text-zinc-600">{trigger.messageId}</div>
                              {trigger.reason && <div className="mt-0.5 truncate text-[10px] text-zinc-400">{trigger.reason}</div>}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-right align-middle">
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${trigger.state === 'dispatched' ? 'bg-emerald-50 text-emerald-700' : trigger.state === 'failed' ? 'bg-red-50 text-red-700' : trigger.state === 'ignored' ? 'bg-zinc-100 text-zinc-500' : 'bg-amber-50 text-amber-700'}`}>{reactionStateLabel(trigger.state)}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>}
              </div>
            </section>

            <section className="flex items-start gap-2.5 rounded-2xl border border-amber-200/70 bg-amber-50/60 p-4">
              <CircleAlert size={15} className="mt-0.5 shrink-0 text-amber-600"/>
              <div><h3 className="text-[12px] font-semibold text-amber-900">使用风险</h3><p className="mt-1 text-[11px] leading-5 text-amber-800">替身以你的飞书身份读取和发送消息，Agent 输出会直接发出。请只监听可信会话，并确认 Agent 的权限边界。</p></div>
            </section>

            </div>
          </div>
          <div className="shrink-0 border-t border-zinc-200/80 bg-white px-3.5 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:px-4 sm:py-3">
            <div className="mx-auto flex max-w-[820px] flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <p className={`text-[11px] ${retentionInputError ? 'text-red-600' : 'text-zinc-500'}`}>
                {retentionInputError || '修改后点击保存，新规则立即生效。'}
              </p>
              <Button type="primary" loading={saveConfig.isPending} disabled={Boolean(retentionInputError)} onClick={() => saveConfig.mutate()} className="!h-9 !w-full !rounded-lg !bg-zinc-900 sm:!h-auto sm:!w-auto">保存配置</Button>
            </div>
          </div>
        </div>
      )}
      {createPortal(toast.toast, document.body)}
    </div>
  );
}
