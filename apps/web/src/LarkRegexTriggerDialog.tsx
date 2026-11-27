import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useMemoizedFn } from 'ahooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Switch } from 'antd';
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  CornerDownRight,
  ExternalLink,
  Filter,
  Hash,
  Info,
  LoaderCircle,
  MessageSquare,
  MessagesSquare,
  Play,
  Plus,
  RefreshCw,
  Regex,
  Search,
  Sparkles,
  Trash2,
  X,
  Zap
} from 'lucide-react';
import {
  api,
  type LarkBotChatItem,
  type LarkBotConfig,
  type LarkPreviewChatMessage,
  type LarkRegexBackfillItemResult,
  type LarkRegexMatchSpan,
  type LarkRegexPromptTemplate,
  type LarkRegexReplyMode,
  type LarkRegexTriggerHit,
  type LarkRegexTriggerRule
} from './api';
import { AiTextAssistControl, LLM_UNCONFIGURED_TOOLTIP, useAiFlash } from './AiTextAssist';
import { CompactSelect } from './CompactSelect';
import { HoverTooltip } from './HoverTooltip';
import { IconButton, SlidingSegmented } from './ui-controls';
import { useToast } from './Toast';
import {
  computeBackfillSelectionStats,
  DEFAULT_REGEX_QUICK_PROMPTS,
  FALLBACK_PROMPT_TEMPLATES,
  FALLBACK_TEMPLATE_VARIABLES,
  formatLarkMessageClock,
  insertVariableAtCursor,
  normalizeRegexFlagSet,
  splitTextByMatchSpans,
  toggleRegexFlag
} from './lark-regex-trigger-utils';
import './lark-regex-trigger.css';

interface LarkRegexTriggerDialogProps {
  onClose(): void;
  onOpenSession(sessionId: string): void;
  onOpenLarkSettings(): void;
  onOpenLlmSettings?: () => void;
}

type PreviewFilterMode = 'all' | 'matched';
type MobilePaneTab = 'config' | 'preview';

const FLAG_OPTIONS: ReadonlyArray<{ flag: 'i' | 'm' | 's'; label: string; tip: string }> = [
  { flag: 'i', label: 'i', tip: '忽略大小写（默认开启）' },
  { flag: 'm', label: 'm', tip: '多行模式：^ 和 $ 匹配每行首尾' },
  { flag: 's', label: 's', tip: '单行模式：点号 . 同时匹配换行符' }
];

const initialLetter = (name?: string) => (name?.trim()?.[0] ?? '?').toUpperCase();

function CircleAvatar({ name, src, isBot = false, size = 28 }: { name?: string; src?: string; isBot?: boolean; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (src && !broken) {
    return (
      <img
        src={src}
        alt={name ?? ''}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="shrink-0 rounded-full object-cover ring-1 ring-zinc-200/80"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full font-semibold ${
        isBot ? 'bg-sky-50 text-sky-700 ring-1 ring-sky-200' : 'bg-zinc-900 text-white'
      }`}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)) }}
    >
      {isBot ? <Bot size={Math.max(12, Math.round(size * 0.5))} /> : initialLetter(name)}
    </span>
  );
}

function ChatBubbleSkeletons() {
  const widths = ['w-[74%]', 'w-[58%]', 'w-[84%]', 'w-[62%]', 'w-[70%]'];
  return (
    <div className="space-y-4 px-1 py-1" aria-label="正在加载群聊消息" role="status">
      {widths.map((widthClass, idx) => (
        <div
          key={idx}
          className="ui-regex-skeleton-row flex items-start gap-2.5"
          style={{ animationDelay: `${idx * 45}ms` }}
        >
          <div className="ui-skeleton h-7 w-7 shrink-0 rounded-full bg-zinc-200/80" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-center gap-2">
              <div className="ui-skeleton h-3 w-16 rounded bg-zinc-200/80" />
              <div className="ui-skeleton h-2.5 w-12 rounded bg-zinc-200/60" />
            </div>
            <div className={`ui-skeleton h-14 ${widthClass} rounded-2xl rounded-tl-md bg-zinc-200/70`} />
          </div>
        </div>
      ))}
    </div>
  );
}

function HighlightedMessageText({ text, spans }: { text: string; spans: readonly LarkRegexMatchSpan[] }) {
  const segments = useMemo(() => splitTextByMatchSpans(text, spans), [text, spans]);
  return (
    <>
      {segments.map((segment, index) => (
        segment.matched
          ? <mark key={index} className="ui-regex-mark">{segment.text}</mark>
          : <span key={index}>{segment.text}</span>
      ))}
    </>
  );
}

const EMPTY_SPANS: readonly LarkRegexMatchSpan[] = [];

interface LarkRegexMessageRowProps {
  msg: LarkPreviewChatMessage;
  matched: boolean;
  spans: readonly LarkRegexMatchSpan[];
  skippedBot: boolean;
  collapsed: boolean;
  hasValidActiveRegex: boolean;
  isChecked: boolean;
  isBusy: boolean;
  triggered: boolean;
  hitSessionId?: string;
  failedReason?: string;
  botReady: boolean;
  onToggleSelect: (messageId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onBackfillOne: (msg: LarkPreviewChatMessage, force: boolean) => void;
}

const LarkRegexMessageRow = memo(function LarkRegexMessageRow({
  msg,
  matched,
  spans,
  skippedBot,
  collapsed,
  hasValidActiveRegex,
  isChecked,
  isBusy,
  triggered,
  hitSessionId,
  failedReason,
  botReady,
  onToggleSelect,
  onOpenSession,
  onBackfillOne
}: LarkRegexMessageRowProps) {
  const isBotMsg = msg.senderType === 'app' || msg.senderType === 'bot';
  const timeStr = formatLarkMessageClock(msg.createdAt, msg.createTime);

  return (
    <div
      className="ui-regex-msg-wrap"
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-hidden={collapsed || undefined}
    >
      <div className="ui-regex-msg-inner">
        <div className="ui-regex-msg-card flex items-start gap-2 sm:gap-2.5">
          {/* 命中消息勾选框（用于批量补偿） */}
          <div className="mt-1.5 flex w-5 shrink-0 justify-center">
            {matched ? (
              <HoverTooltip content={triggered ? '已补偿过（单条卡片仍可点重新补偿）' : isChecked ? '取消勾选' : '勾选纳入批量补偿'}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={isChecked}
                  aria-label={`勾选消息 ${msg.messageId}`}
                  onClick={() => onToggleSelect(msg.messageId)}
                  className={`ui-press grid h-4 w-4 place-items-center rounded border transition-colors ${
                    isChecked
                      ? 'border-sky-600 bg-sky-600 text-white'
                      : triggered
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-600'
                        : 'border-zinc-300 bg-white text-transparent hover:border-zinc-500'
                  }`}
                >
                  <Check key={isChecked ? 'on' : 'off'} size={10} className={isChecked ? 'ui-icon-pop' : ''} />
                </button>
              </HoverTooltip>
            ) : (
              <span className="h-4 w-4" />
            )}
          </div>

          <CircleAvatar name={msg.senderName} isBot={isBotMsg} size={28} />

          <div className="min-w-0 flex-1">
            {/* 发送人与状态徽标行 */}
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              <span className="max-w-[160px] truncate text-[11px] font-medium text-zinc-700">
                {msg.senderName}
              </span>
              {isBotMsg && (
                <span className="rounded-full bg-sky-50 px-1.5 py-0.2 text-[9px] font-medium text-sky-700">
                  机器人
                </span>
              )}
              {msg.threadId && (
                <span className="inline-flex items-center gap-0.5 rounded-full bg-zinc-100 px-1.5 py-0.2 text-[9px] text-zinc-500">
                  <Hash size={8} />话题
                </span>
              )}
              {timeStr && <span className="text-[10px] tabular-nums text-zinc-400">{timeStr}</span>}
              {matched && (
                <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.2 text-[10px] font-semibold text-amber-800">
                  命中 {spans.length || 1} 处
                </span>
              )}
              {skippedBot && (
                <span className="rounded-full bg-zinc-100 px-1.5 py-0.2 text-[10px] text-zinc-400">
                  已忽略机器人消息
                </span>
              )}
              {triggered && (
                hitSessionId ? (
                  <button
                    type="button"
                    onClick={() => onOpenSession(hitSessionId)}
                    className="ui-press inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-200/80 transition-colors hover:bg-emerald-100"
                  >
                    <CheckCircle2 size={10} />
                    <span>已唤起 · 查看会话</span>
                    <ExternalLink size={9} />
                  </button>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                    <CheckCircle2 size={10} />
                    已唤起
                  </span>
                )
              )}
            </div>

            {/* 飞书风格消息气泡 + 命中精确子串高亮 */}
            <div className="flex flex-col items-start gap-1.5">
              <div
                className={`ui-regex-bubble max-w-full whitespace-pre-wrap break-words rounded-2xl rounded-tl-md border px-3 py-2 text-[13px] leading-5 sm:max-w-[88%] sm:px-3.5 sm:py-2.5 ${
                  matched
                    ? 'bg-white text-zinc-900'
                    : hasValidActiveRegex
                      ? 'border-zinc-200/80 bg-white/80 text-zinc-500 opacity-75'
                      : 'border-zinc-200 bg-white text-zinc-800'
                }`}
                data-matched={matched ? 'true' : 'false'}
                data-selected={isChecked ? 'true' : 'false'}
              >
                {matched && spans.length > 0 ? (
                  <HighlightedMessageText text={msg.text} spans={spans} />
                ) : (
                  msg.text || <span className="text-zinc-400">（空消息）</span>
                )}
              </div>

              {/* 悬停/触屏单条一键补偿按钮 */}
              {matched && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    disabled={isBusy || !botReady}
                    data-busy={isBusy ? 'true' : 'false'}
                    data-active={triggered ? 'false' : 'true'}
                    onClick={() => onBackfillOne(msg, triggered)}
                    className={`ui-regex-hover-action ui-press inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border px-2.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                      triggered
                        ? 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900'
                        : 'border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-800'
                    }`}
                  >
                    {isBusy ? (
                      <>
                        <LoaderCircle size={11} className="animate-spin" />
                        <span>唤起中…</span>
                      </>
                    ) : triggered ? (
                      <>
                        <RefreshCw size={10} />
                        <span>重新补偿</span>
                      </>
                    ) : (
                      <>
                        <Play size={10} />
                        <span>发起一轮补偿</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>

            {failedReason && (
              <p className="mt-1 flex items-center gap-1 text-[11px] text-red-600">
                <AlertTriangle size={11} className="shrink-0" />
                <span>{failedReason}</span>
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

export function LarkRegexTriggerDialog({
  onClose,
  onOpenSession,
  onOpenLarkSettings
}: LarkRegexTriggerDialogProps) {
  const qc = useQueryClient();
  const toast = useToast();

  // 基础数据：机器人列表 & 已保存规则 + 模板
  const larkConfig = useQuery({
    queryKey: ['lark-config'],
    queryFn: api.larkConfig,
    refetchOnWindowFocus: false
  });
  const triggersQuery = useQuery({
    queryKey: ['lark-regex-triggers'],
    queryFn: api.larkRegexTriggers,
    refetchOnWindowFocus: false
  });

  const bots = larkConfig.data?.bots ?? [];
  const rules = triggersQuery.data?.rules ?? [];
  const templates = triggersQuery.data?.templates?.length ? triggersQuery.data.templates : FALLBACK_PROMPT_TEMPLATES;
  const variables = triggersQuery.data?.variables?.length ? triggersQuery.data.variables : FALLBACK_TEMPLATE_VARIABLES;

  // 当前编辑状态
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [ruleName, setRuleName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [ignoreBotMessages, setIgnoreBotMessages] = useState(true);
  const [botId, setBotId] = useState('');
  const [chatId, setChatId] = useState('');
  const [chatName, setChatName] = useState('');
  const [chatSearch, setChatSearch] = useState('');
  const [pattern, setPattern] = useState('');
  const [flags, setFlags] = useState('i');
  const [replyMode, setReplyMode] = useState<LarkRegexReplyMode>('thread');
  const [promptTemplate, setPromptTemplate] = useState(FALLBACK_PROMPT_TEMPLATES[0]!.promptTemplate);
  const [presetId, setPresetId] = useState<string | undefined>(FALLBACK_PROMPT_TEMPLATES[0]!.id);
  const [aiRegexExplanation, setAiRegexExplanation] = useState<string | undefined>();
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 预览与补偿状态
  const [filterMode, setFilterMode] = useState<PreviewFilterMode>('all');
  const [mobilePane, setMobilePane] = useState<MobilePaneTab>('config');
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(() => new Set());
  const [localBackfillResults, setLocalBackfillResults] = useState<Record<string, LarkRegexBackfillItemResult>>({});
  const [busyMessageIds, setBusyMessageIds] = useState<Set<string>>(() => new Set());
  const [savedNotice, setSavedNotice] = useState(false);

  // 高亮闪烁与撤销辅助
  const regexFlash = useAiFlash();
  const promptFlash = useAiFlash();
  const prevFlagsStackRef = useRef<string[]>([]);
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const savedNoticeTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (savedNoticeTimerRef.current !== null) window.clearTimeout(savedNoticeTimerRef.current);
  }, []);

  // ESC 关闭弹窗
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const hydrateFromRule = (rule: LarkRegexTriggerRule) => {
    setSelectedRuleId(rule.id);
    setRuleName(rule.name);
    setEnabled(rule.enabled);
    setIgnoreBotMessages(rule.ignoreBotMessages);
    setBotId(rule.botId);
    setChatId(rule.chatId);
    setChatName(rule.chatName);
    setPattern(rule.pattern);
    setFlags(rule.flags || 'i');
    setReplyMode(rule.replyMode);
    setPromptTemplate(rule.promptTemplate);
    setPresetId(rule.presetId);
    setAiRegexExplanation(undefined);
    setConfirmDelete(false);
    setSelectedMessageIds(new Set());
    setLocalBackfillResults({});
    prevFlagsStackRef.current = [];
  };

  const resetToNewRule = (defaultBotId?: string) => {
    const firstTemplate = templates[0] ?? FALLBACK_PROMPT_TEMPLATES[0]!;
    setSelectedRuleId(null);
    setRuleName('');
    setEnabled(true);
    setIgnoreBotMessages(true);
    setBotId(defaultBotId ?? bots[0]?.appId ?? '');
    setChatId('');
    setChatName('');
    setPattern('');
    setFlags('i');
    setReplyMode('thread');
    setPromptTemplate(firstTemplate.promptTemplate);
    setPresetId(firstTemplate.id);
    setAiRegexExplanation(undefined);
    setConfirmDelete(false);
    setSelectedMessageIds(new Set());
    setLocalBackfillResults({});
    prevFlagsStackRef.current = [];
  };

  // 初次加载完成时：若有已保存规则自动选中首条，否则默认选中第一个机器人
  useEffect(() => {
    if (initialized) return;
    if (larkConfig.isLoading || triggersQuery.isLoading) return;
    setInitialized(true);
    if (rules.length > 0) {
      hydrateFromRule(rules[0]!);
    } else if (bots.length > 0) {
      setBotId(bots[0]!.appId);
    }
  }, [initialized, larkConfig.isLoading, triggersQuery.isLoading, rules, bots]);

  const selectedBot: LarkBotConfig | undefined = useMemo(
    () => bots.find(item => item.appId === botId),
    [bots, botId]
  );

  // 拉取选中机器人所在群聊列表
  const chatsQuery = useQuery({
    queryKey: ['lark-bot-chats', botId],
    queryFn: () => api.larkBotChats(botId, { all: true }),
    enabled: Boolean(botId),
    staleTime: 20_000,
    retry: false,
    refetchOnWindowFocus: false
  });

  const chats = chatsQuery.data?.items ?? [];
  const filteredChats = useMemo(() => {
    const q = chatSearch.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter(item =>
      item.name.toLowerCase().includes(q)
      || item.chatId.toLowerCase().includes(q)
      || (item.description ?? '').toLowerCase().includes(q)
    );
  }, [chats, chatSearch]);

  const selectedChat: LarkBotChatItem | undefined = useMemo(
    () => chats.find(item => item.chatId === chatId),
    [chats, chatId]
  );
  const resolvedChatName = selectedChat?.name || chatName || chatId;

  // 拉取选中群聊最近消息
  const messagesQuery = useQuery({
    queryKey: ['lark-bot-chat-messages', botId, chatId, selectedRuleId ?? 'draft'],
    queryFn: () => api.larkBotChatMessages(botId, chatId, { limit: 50 }),
    enabled: Boolean(botId && chatId),
    retry: false,
    refetchOnWindowFocus: false
  });

  const messages = messagesQuery.data?.items ?? [];
  const serverHitsByMessageId = messagesQuery.data?.hitsByMessageId ?? {};

  // 消息切换/加载后自动滚动到最新底部（像聊天记录一样）
  const prevLoadedChatRef = useRef('');
  useEffect(() => {
    const key = `${botId}:${chatId}:${messages.length}`;
    if (!messages.length || prevLoadedChatRef.current === key) return;
    prevLoadedChatRef.current = key;
    const container = messagesScrollRef.current;
    if (container) {
      window.requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    }
  }, [botId, chatId, messages.length]);

  // 服务端防抖实时预匹配（带 ReDoS 校验 + 精确高亮区间）
  const [previewState, setPreviewState] = useState<{
    loading: boolean;
    valid: boolean;
    error?: string;
    matchedCount: number;
    resultsById: Map<string, { matched: boolean; matches: LarkRegexMatchSpan[]; skippedBot?: boolean }>;
  }>({
    loading: false,
    valid: true,
    matchedCount: 0,
    resultsById: new Map()
  });

  useEffect(() => {
    const trimmed = pattern.trim();
    if (!trimmed) {
      setPreviewState({ loading: false, valid: true, matchedCount: 0, resultsById: new Map() });
      return;
    }
    const controller = new AbortController();
    setPreviewState(prev => ({ ...prev, loading: true }));
    const timer = window.setTimeout(() => {
      void api.previewLarkRegexTrigger(
        {
          pattern,
          flags,
          ignoreBotMessages,
          messages: messages.map(item => ({
            messageId: item.messageId,
            text: item.text,
            senderType: item.senderType
          }))
        },
        { signal: controller.signal }
      ).then(res => {
        if (controller.signal.aborted) return;
        const map = new Map<string, { matched: boolean; matches: LarkRegexMatchSpan[]; skippedBot?: boolean }>();
        for (const item of res.results) {
          map.set(item.messageId, {
            matched: item.matched,
            matches: item.matches,
            ...(item.skippedBot ? { skippedBot: true } : {})
          });
        }
        setPreviewState({
          loading: false,
          valid: res.valid,
          error: res.error,
          matchedCount: res.matchedCount,
          resultsById: map
        });
      }).catch(error => {
        if (controller.signal.aborted) return;
        setPreviewState(prev => ({
          ...prev,
          loading: false,
          valid: false,
          error: error instanceof Error ? error.message : '正则预匹配校验失败'
        }));
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [pattern, flags, ignoreBotMessages, messages]);

  // 计算命中统计与勾选状态
  const localTriggeredIds = useMemo(() => {
    const set = new Set<string>();
    for (const [id, result] of Object.entries(localBackfillResults)) {
      if (result.status === 'triggered' || result.alreadyTriggered) set.add(id);
    }
    return set;
  }, [localBackfillResults]);

  const selectionStats = useMemo(
    () => computeBackfillSelectionStats(
      messages,
      previewState.resultsById,
      serverHitsByMessageId,
      localTriggeredIds,
      selectedMessageIds
    ),
    [messages, previewState.resultsById, serverHitsByMessageId, localTriggeredIds, selectedMessageIds]
  );

  // 当正则改变导致部分已选消息不再命中时，自动剔除失效勾选
  useEffect(() => {
    setSelectedMessageIds(current => {
      if (!current.size) return current;
      const validSet = new Set(selectionStats.matchedIds);
      let changed = false;
      const next = new Set<string>();
      for (const id of current) {
        if (validSet.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : current;
    });
  }, [selectionStats.matchedIds]);

  // 规则 CRUD Mutations
  const saveRule = useMutation({
    mutationFn: async () => {
      const payload = {
        name: ruleName.trim() || `${resolvedChatName || '群聊'} 正则唤起`,
        enabled,
        botId,
        chatId,
        chatName: resolvedChatName,
        pattern,
        flags: normalizeRegexFlagSet(flags),
        replyMode,
        promptTemplate,
        presetId: presetId ?? null,
        ignoreBotMessages
      };
      if (selectedRuleId) {
        return api.updateLarkRegexTrigger(selectedRuleId, payload);
      }
      return api.createLarkRegexTrigger(payload);
    },
    onSuccess: ({ rule }) => {
      setSelectedRuleId(rule.id);
      setRuleName(rule.name);
      setSavedNotice(true);
      if (savedNoticeTimerRef.current !== null) window.clearTimeout(savedNoticeTimerRef.current);
      savedNoticeTimerRef.current = window.setTimeout(() => setSavedNotice(false), 2200);
      toast.show(selectedRuleId ? `已更新规则「${rule.name}」` : `已保存规则「${rule.name}」`, 'success');
      void qc.invalidateQueries({ queryKey: ['lark-regex-triggers'] });
    },
    onError: error => {
      toast.show(error instanceof Error ? error.message : '保存规则失败', 'error');
    }
  });

  const toggleRuleEnabled = useMutation({
    mutationFn: ({ id, nextEnabled }: { id: string; nextEnabled: boolean }) =>
      api.updateLarkRegexTrigger(id, { enabled: nextEnabled }),
    onSuccess: ({ rule }) => {
      if (rule.id === selectedRuleId) setEnabled(rule.enabled);
      void qc.invalidateQueries({ queryKey: ['lark-regex-triggers'] });
      toast.show(rule.enabled ? `已启用「${rule.name}」` : `已暂停「${rule.name}」`, 'info');
    },
    onError: error => {
      toast.show(error instanceof Error ? error.message : '切换启停失败', 'error');
    }
  });

  const deleteRule = useMutation({
    mutationFn: (id: string) => api.deleteLarkRegexTrigger(id),
    onSuccess: ({ id }) => {
      setConfirmDelete(false);
      toast.show('已删除正则监听规则', 'info');
      void qc.invalidateQueries({ queryKey: ['lark-regex-triggers'] });
      const remaining = rules.filter(item => item.id !== id);
      if (remaining.length > 0) hydrateFromRule(remaining[0]!);
      else resetToNewRule(botId || bots[0]?.appId);
    },
    onError: error => {
      toast.show(error instanceof Error ? error.message : '删除规则失败', 'error');
    }
  });

  // 历史命中补偿 Mutation（支持单条与批量）
  const runBackfill = async (targetMessages: LarkPreviewChatMessage[], force = false) => {
    if (!targetMessages.length || !botId || !chatId || !pattern.trim() || !previewState.valid) return;
    if (selectedBot && !selectedBot.setupComplete) {
      toast.show('该机器人尚未配置默认 Agent，请先前往「飞书设置」完成配置', 'error');
      return;
    }
    const targetIds = targetMessages.map(item => item.messageId);
    setBusyMessageIds(prev => {
      const next = new Set(prev);
      for (const id of targetIds) next.add(id);
      return next;
    });
    try {
      const res = await api.backfillLarkRegexTrigger({
        ...(selectedRuleId ? { ruleId: selectedRuleId } : {}),
        ruleName: ruleName.trim() || `${resolvedChatName || '群聊'} 历史补偿`,
        botId,
        chatId,
        chatName: resolvedChatName,
        pattern,
        flags: normalizeRegexFlagSet(flags),
        replyMode,
        promptTemplate,
        ignoreBotMessages,
        force,
        messages: targetMessages.map(item => ({
          messageId: item.messageId,
          text: item.text,
          ...(item.senderId ? { senderId: item.senderId } : {}),
          senderName: item.senderName,
          senderType: item.senderType,
          ...(item.threadId ? { threadId: item.threadId } : {}),
          ...(item.rootId ? { rootId: item.rootId } : {}),
          ...(item.parentId ? { parentId: item.parentId } : {}),
          msgType: item.msgType,
          createTime: item.createTime,
          createdAt: item.createdAt
        }))
      });
      setLocalBackfillResults(prev => {
        const next = { ...prev };
        for (const item of res.results) {
          next[item.messageId] = item;
        }
        return next;
      });
      setSelectedMessageIds(prev => {
        const next = new Set(prev);
        for (const item of res.results) {
          if (item.status === 'triggered' || item.alreadyTriggered) next.delete(item.messageId);
        }
        return next;
      });
      void qc.invalidateQueries({ queryKey: ['lark-regex-triggers'] });
      void qc.invalidateQueries({ queryKey: ['lark-bot-chat-messages', botId, chatId] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      if (res.triggeredCount > 0 && res.failedCount === 0) {
        toast.show(
          res.triggeredCount === 1
            ? `已由「${selectedBot?.name || botId}」发起 1 轮补偿`
            : `已发起 ${res.triggeredCount} 轮历史命中补偿${res.skippedCount ? `（跳过 ${res.skippedCount} 条已补偿）` : ''}`,
          'success'
        );
      } else if (res.failedCount > 0) {
        const firstReason = res.results.find(item => item.status === 'failed')?.reason;
        toast.show(firstReason || `部分补偿失败（成功 ${res.triggeredCount} / 失败 ${res.failedCount}）`, 'error');
      } else if (res.skippedCount > 0) {
        toast.show('所选消息均已触发过补偿，已自动幂等跳过', 'info');
      }
    } catch (error) {
      toast.show(error instanceof Error ? error.message : '发起历史补偿失败', 'error');
    } finally {
      setBusyMessageIds(prev => {
        const next = new Set(prev);
        for (const id of targetIds) next.delete(id);
        return next;
      });
    }
  };

  const handleApplyTemplate = (template: LarkRegexPromptTemplate) => {
    setPresetId(template.id);
    setPromptTemplate(template.promptTemplate);
    promptFlash.triggerFlash();
  };

  const handleInsertVariable = (token: string) => {
    const el = promptTextareaRef.current;
    const { nextValue, nextCursor } = insertVariableAtCursor(
      promptTemplate,
      token,
      el?.selectionStart,
      el?.selectionEnd
    );
    setPromptTemplate(nextValue);
    window.requestAnimationFrame(() => {
      if (promptTextareaRef.current) {
        promptTextareaRef.current.focus();
        promptTextareaRef.current.setSelectionRange(nextCursor, nextCursor);
      }
    });
  };

  const botOptions = useMemo(
    () => bots.map(bot => ({
      value: bot.appId,
      label: bot.name || bot.appId,
      meta: `${bot.defaultAgentId || '未配 Agent'} · ${bot.activeListening ? '监听中' : bot.listening ? '已开启监听' : '未监听'}`
    })),
    [bots]
  );

  const sampleMessagesForAi = useMemo(
    () => messages.filter(item => item.text.trim()).slice(-10).map(item => `${item.senderName}: ${item.text.slice(0, 140)}`),
    [messages]
  );

  const botSummaryForAi = selectedBot
    ? `机器人：${selectedBot.name}（Agent: ${selectedBot.defaultAgentId || '未配置'}，工作区: ${selectedBot.workspace || '默认'}，回复方式: ${replyMode === 'thread' ? '话题内唤起' : '主线程唤起'}）`
    : undefined;

  const canSaveRule = Boolean(botId && chatId && pattern.trim() && previewState.valid && !saveRule.isPending);
  const hasValidActiveRegex = Boolean(pattern.trim() && previewState.valid);

  const getMessageHitInfo = (messageId: string): {
    triggered: boolean;
    sessionId?: string;
    failedReason?: string;
    triggerType?: 'realtime' | 'backfill';
  } => {
    const local = localBackfillResults[messageId];
    if (local) {
      if (local.status === 'triggered' || local.alreadyTriggered) {
        return { triggered: true, sessionId: local.sessionId, triggerType: 'backfill' };
      }
      if (local.status === 'failed') {
        return { triggered: false, failedReason: local.reason };
      }
    }
    const history = serverHitsByMessageId[messageId];
    const latestTriggered = history?.slice().reverse().find((hit: LarkRegexTriggerHit) => hit.status === 'triggered');
    if (latestTriggered) {
      return {
        triggered: true,
        sessionId: latestTriggered.sessionId,
        triggerType: latestTriggered.triggerType
      };
    }
    return { triggered: false };
  };

  const toggleSelectMessage = useMemoizedFn((messageId: string) => {
    setSelectedMessageIds(prev => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  });

  const handleOpenSessionStable = useMemoizedFn((sessionId: string) => onOpenSession(sessionId));
  const handleBackfillOne = useMemoizedFn((msg: LarkPreviewChatMessage, force: boolean) => {
    void runBackfill([msg], force);
  });

  const handleToggleSelectAllUncompensated = () => {
    const targetIds = selectionStats.uncompensatedMatchedIds;
    if (!targetIds.length) return;
    const allSelected = targetIds.every(id => selectedMessageIds.has(id));
    setSelectedMessageIds(prev => {
      const next = new Set(prev);
      if (allSelected) {
        for (const id of targetIds) next.delete(id);
      } else {
        for (const id of targetIds) next.add(id);
      }
      return next;
    });
  };

  const activePreset = templates.find(item => item.id === presetId);
  const visibleMatchedCount = previewState.matchedCount;
  const anyBatchBusy = selectionStats.matchedIds.some(id => busyMessageIds.has(id));

  return (
    <div
      className="ui-overlay ui-overlay-sheet fixed inset-0 z-50 grid place-items-center bg-zinc-950/35 p-0 sm:p-4"
      onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="飞书群聊正则唤起"
        className="ui-dialog flex h-[100dvh] w-full max-w-none flex-col overflow-hidden rounded-none border-0 border-zinc-200 bg-white shadow-[0_24px_72px_rgba(12,13,16,.2)] sm:h-[min(860px,calc(100dvh-2rem))] sm:max-w-[1180px] sm:rounded-[16px] sm:border"
      >
        {/* 顶部标题栏 */}
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-200/80 px-3.5 py-2.5 sm:px-5 sm:py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-zinc-900 text-white shadow-sm">
              <Regex size={15} />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-[15px] font-semibold tracking-tight text-zinc-900 sm:text-[16px]">
                  飞书群聊正则唤起
                </h2>
                <span className="hidden rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 sm:inline-flex">
                  {rules.filter(r => r.enabled).length} 条生效中
                </span>
              </div>
              <p className="truncate text-[11px] text-zinc-500">
                实时匹配群消息自动唤起，支持话题 / 主线程模式、实时高亮筛选与历史命中补偿
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => resetToNewRule(botId || bots[0]?.appId)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 text-[12px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
            >
              <Plus size={13} />
              <span className="hidden sm:inline">新建规则</span>
            </button>
            <IconButton label="关闭群聊正则唤起" onClick={onClose}>
              <X size={16} />
            </IconButton>
          </div>
        </header>

        {/* 已保存规则横向切换条 */}
        {rules.length > 0 && (
          <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-zinc-100 bg-zinc-50/70 px-3.5 py-2 no-scrollbar sm:px-5">
            {rules.map(rule => {
              const active = selectedRuleId === rule.id;
              return (
                <div
                  key={rule.id}
                  className={`group flex shrink-0 items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[12px] transition-all ${
                    active
                      ? 'border-zinc-300 bg-white text-zinc-900 shadow-sm'
                      : 'border-transparent bg-transparent text-zinc-600 hover:border-zinc-200/80 hover:bg-white/75 hover:text-zinc-900'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => hydrateFromRule(rule)}
                    className="flex items-center gap-1.5 text-left"
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        rule.enabled ? 'bg-emerald-500 ui-status-pulse' : 'bg-zinc-300'
                      }`}
                    />
                    <span className="max-w-[130px] truncate font-medium">{rule.name}</span>
                    <span className="hidden max-w-[96px] truncate rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 sm:inline">
                      {rule.chatName}
                    </span>
                    <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-500">
                      {rule.hitCount ?? 0} 次
                    </span>
                  </button>
                  <HoverTooltip content={rule.enabled ? '点击暂停规则' : '点击启用规则'}>
                    <span className="inline-flex items-center pl-0.5">
                      <Switch
                        size="small"
                        checked={rule.enabled}
                        loading={toggleRuleEnabled.isPending && toggleRuleEnabled.variables?.id === rule.id}
                        onChange={checked => toggleRuleEnabled.mutate({ id: rule.id, nextEnabled: checked })}
                      />
                    </span>
                  </HoverTooltip>
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => resetToNewRule(botId || bots[0]?.appId)}
              className={`inline-flex shrink-0 items-center gap-1 rounded-xl border border-dashed px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                selectedRuleId === null
                  ? 'border-zinc-400 bg-white text-zinc-900 shadow-sm'
                  : 'border-zinc-300 text-zinc-500 hover:border-zinc-400 hover:bg-white hover:text-zinc-800'
              }`}
            >
              <Plus size={12} />
              新建规则
            </button>
          </div>
        )}

        {/* 移动端单栏分段切换条（390px 零溢出） */}
        <div className="shrink-0 border-b border-zinc-100 bg-white px-3.5 py-2 lg:hidden">
          <SlidingSegmented
            role="tablist"
            ariaLabel="视图切换"
            size="md"
            itemClassName="h-8"
            value={mobilePane}
            onChange={setMobilePane}
            options={[
              {
                value: 'config' as const,
                label: (
                  <>
                    <Regex size={13} />
                    <span>规则配置</span>
                  </>
                )
              },
              {
                value: 'preview' as const,
                label: (
                  <>
                    <MessagesSquare size={13} />
                    <span>消息预览与补偿</span>
                    {hasValidActiveRegex && (
                      <span
                        key={visibleMatchedCount}
                        className={`ui-regex-count-pop rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                          visibleMatchedCount > 0 ? 'bg-amber-100 text-amber-800' : 'bg-zinc-200 text-zinc-600'
                        }`}
                      >
                        {visibleMatchedCount}
                      </span>
                    )}
                  </>
                )
              }
            ]}
          />
        </div>

        {/* 主体双栏工作台 */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* 左栏：规则配置区 */}
          <aside
            className={`${
              mobilePane === 'config' ? 'flex' : 'hidden lg:flex'
            } min-h-0 w-full shrink-0 flex-col border-zinc-200/80 bg-zinc-50/40 lg:w-[468px] lg:border-r xl:w-[496px]`}
          >
            <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-3.5 py-3.5 sm:px-4 sm:py-4">
              {/* 若尚未配置任何飞书机器人 */}
              {!larkConfig.isLoading && bots.length === 0 ? (
                <div className="rounded-2xl border border-zinc-200 bg-white p-6 text-center shadow-sm">
                  <div className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-zinc-100 text-zinc-600">
                    <Bot size={20} />
                  </div>
                  <h3 className="mt-3 text-[14px] font-semibold text-zinc-900">还没有配置飞书机器人</h3>
                  <p className="mt-1 text-[12px] leading-5 text-zinc-500">
                    群聊正则唤起会复用机器人的凭证、默认 Agent、模型与安全门禁配置。请先添加一个飞书机器人。
                  </p>
                  <button
                    type="button"
                    onClick={onOpenLarkSettings}
                    className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-lg bg-zinc-900 px-4 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
                  >
                    前往飞书设置
                  </button>
                </div>
              ) : (
                <>
                  {/* 第 1 步：选择机器人与目标群聊 */}
                  <section className="rounded-2xl border border-zinc-200/90 bg-white p-3.5 shadow-[0_1px_2px_rgba(24,24,27,.03)]">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-zinc-900 text-[11px] font-semibold text-white">1</span>
                        <h3 className="text-[13px] font-semibold text-zinc-900">选择机器人与所在群聊</h3>
                      </div>
                      <label className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-600">
                        <span>{enabled ? '监听启用' : '已暂停'}</span>
                        <Switch size="small" checked={enabled} onChange={setEnabled} />
                      </label>
                    </div>

                    <div className="mt-3 space-y-3">
                      <label className="block">
                        <span className="text-[11px] font-medium text-zinc-600">规则名称</span>
                        <input
                          type="text"
                          value={ruleName}
                          onChange={event => setRuleName(event.target.value)}
                          placeholder={resolvedChatName ? `${resolvedChatName} 告警监听` : '例如：核心交易群 P0 告警排查'}
                          className="ui-field mt-1 h-9 w-full rounded-lg border border-zinc-300 bg-white px-3 text-[12px] text-zinc-900 placeholder:text-zinc-400"
                        />
                      </label>

                      <div>
                        <span className="text-[11px] font-medium text-zinc-600">飞书机器人</span>
                        <div className="mt-1">
                          <CompactSelect
                            size="sm"
                            popupWidth={380}
                            options={botOptions}
                            value={botId}
                            placeholder="选择飞书机器人"
                            disabledText="暂无可用机器人"
                            onChange={nextBotId => {
                              setBotId(nextBotId);
                              setChatId('');
                              setChatName('');
                              setChatSearch('');
                              setSelectedMessageIds(new Set());
                              setLocalBackfillResults({});
                            }}
                          />
                        </div>
                        {selectedBot && !selectedBot.setupComplete && (
                          <div className="mt-2 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/80 px-2.5 py-2 text-[11px] leading-4 text-amber-800">
                            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                            <div className="min-w-0 flex-1">
                              该机器人尚未配置默认 Agent，发起轮次前需先完成配置。
                              <button
                                type="button"
                                onClick={onOpenLarkSettings}
                                className="ml-1 font-semibold underline underline-offset-2"
                              >
                                去完善
                              </button>
                            </div>
                          </div>
                        )}
                        {selectedBot && selectedBot.setupComplete && (
                          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-400">
                            <span>Agent: <strong className="font-medium text-zinc-600">{selectedBot.defaultAgentId}</strong></span>
                            {selectedBot.defaultModel && <span>· 模型: {selectedBot.defaultModel}</span>}
                            <span>· {selectedBot.quietReply ? '静默文本回复' : 'Trace 流式卡片'}</span>
                          </p>
                        )}
                      </div>

                      {/* 群聊选择器（带骨架、搜索与刷新） */}
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-medium text-zinc-600">
                            机器人所在群聊
                            {chats.length > 0 && <span className="ml-1 font-normal text-zinc-400">({chats.length})</span>}
                          </span>
                          {botId && (
                            <HoverTooltip content="刷新机器人所在群聊列表">
                              <button
                                type="button"
                                disabled={chatsQuery.isFetching}
                                onClick={() => {
                                  void api.larkBotChats(botId, { all: true, refresh: true })
                                    .then(data => qc.setQueryData(['lark-bot-chats', botId], data))
                                    .catch(() => void chatsQuery.refetch());
                                }}
                                aria-label="刷新群聊列表"
                                className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-40"
                              >
                                <RefreshCw size={11} className={chatsQuery.isFetching ? 'animate-spin' : ''} />
                                <span>刷新</span>
                              </button>
                            </HoverTooltip>
                          )}
                        </div>

                        <div className="mt-1 overflow-hidden rounded-xl border border-zinc-200 bg-white">
                          <div className="flex items-center gap-2 border-b border-zinc-100 bg-zinc-50/70 px-2.5 py-1.5">
                            <Search size={12} className="shrink-0 text-zinc-400" />
                            <input
                              type="text"
                              value={chatSearch}
                              onChange={event => setChatSearch(event.target.value)}
                              placeholder="搜索群名称或 oc_ 群聊 ID…"
                              className="h-6 min-w-0 flex-1 bg-transparent text-[12px] text-zinc-800 placeholder:text-zinc-400"
                            />
                            {chatSearch && (
                              <button
                                type="button"
                                aria-label="清空群搜索"
                                onClick={() => setChatSearch('')}
                                className="grid h-5 w-5 place-items-center rounded text-zinc-400 hover:bg-zinc-200/70 hover:text-zinc-700"
                              >
                                <X size={11} />
                              </button>
                            )}
                          </div>

                          <div className="max-h-[168px] overflow-y-auto p-1.5">
                            {chatsQuery.isLoading ? (
                              <div className="space-y-1.5 p-1">
                                {[0, 1, 2].map(idx => (
                                  <div key={idx} className="flex items-center gap-2.5 px-1.5 py-1.5">
                                    <div className="ui-skeleton h-7 w-7 shrink-0 rounded-full bg-zinc-200/80" />
                                    <div className="min-w-0 flex-1 space-y-1">
                                      <div className="ui-skeleton h-3 w-32 rounded bg-zinc-200/80" />
                                      <div className="ui-skeleton h-2.5 w-24 rounded bg-zinc-200/60" />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : chatsQuery.isError ? (
                              <div className="p-2.5 text-[11px] leading-5 text-red-600">
                                <p>{chatsQuery.error instanceof Error ? chatsQuery.error.message : '读取机器人所在群聊失败'}</p>
                                <button
                                  type="button"
                                  onClick={() => void chatsQuery.refetch()}
                                  className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700 hover:bg-red-100"
                                >
                                  <RefreshCw size={10} />重试
                                </button>
                              </div>
                            ) : filteredChats.length > 0 ? (
                              filteredChats.map(chat => {
                                const active = chat.chatId === chatId;
                                return (
                                  <button
                                    key={chat.chatId}
                                    type="button"
                                    onClick={() => {
                                      setChatId(chat.chatId);
                                      setChatName(chat.name);
                                      setSelectedMessageIds(new Set());
                                      setLocalBackfillResults({});
                                    }}
                                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
                                      active ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-700 hover:bg-zinc-50'
                                    }`}
                                  >
                                    <CircleAvatar name={chat.name} src={chat.avatar} size={26} />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1.5">
                                        <span className="truncate text-[12px] font-medium">{chat.name}</span>
                                        {chat.chatMode === 'topic' && (
                                          <span className="shrink-0 rounded bg-sky-50 px-1 py-0.2 text-[9px] font-medium text-sky-700">话题群</span>
                                        )}
                                      </div>
                                      <p className="truncate font-mono text-[10px] text-zinc-400">
                                        {chat.description ? `${chat.description} · ` : ''}{chat.chatId}
                                      </p>
                                    </div>
                                    <span
                                      className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border transition-colors ${
                                        active ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-300 text-transparent'
                                      }`}
                                    >
                                      <Check size={10} />
                                    </span>
                                  </button>
                                );
                              })
                            ) : (
                              <div className="px-3 py-5 text-center text-[11px] text-zinc-400">
                                {chatSearch ? '没有匹配的群聊' : '该机器人暂未加入任何群聊，请先将机器人拉入目标飞书群'}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </section>

                  {/* 第 2 步：正则表达式 + AI 生成正则 */}
                  <section className="rounded-2xl border border-zinc-200/90 bg-white p-3.5 shadow-[0_1px_2px_rgba(24,24,27,.03)]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-zinc-900 text-[11px] font-semibold text-white">2</span>
                        <h3 className="text-[13px] font-semibold text-zinc-900">匹配正则表达式</h3>
                      </div>
                      <AiTextAssistControl
                        mode="regex_generate"
                        value={pattern}
                        onChange={nextPattern => {
                          setPattern(nextPattern);
                          if (!nextPattern.trim()) setAiRegexExplanation(undefined);
                        }}
                        label="AI 生成正则"
                        ariaLabel="AI 生成正则表达式"
                        tooltip="用自然语言描述目标消息，AI 自动生成安全正则"
                        unconfiguredTooltip={LLM_UNCONFIGURED_TOOLTIP}
                        instructionPlaceholder="例如：匹配包含 P0/P1 告警、5xx 或线上报错的消息"
                        quickPrompts={DEFAULT_REGEX_QUICK_PROMPTS}
                        resetKey={selectedRuleId ?? 'new'}
                        onFlash={regexFlash.triggerFlash}
                        context={() => ({
                          field: '飞书群聊正则监听表达式',
                          purpose: '匹配需要自动唤起飞书机器人的群聊消息，避免灾难性回溯（ReDoS）',
                          ...(resolvedChatName ? { groupName: resolvedChatName } : {}),
                          ...(botSummaryForAi ? { botContext: botSummaryForAi } : {}),
                          ...(sampleMessagesForAi.length ? { sampleMessages: sampleMessagesForAi } : {})
                        })}
                        onResult={result => {
                          prevFlagsStackRef.current.push(flags);
                          if (result.flags !== undefined) {
                            setFlags(normalizeRegexFlagSet(result.flags || 'i'));
                          }
                          if (result.explanation?.trim()) {
                            setAiRegexExplanation(result.explanation.trim());
                          }
                        }}
                        onUndo={previousPattern => {
                          setPattern(previousPattern);
                          const prevFlags = prevFlagsStackRef.current.pop();
                          if (prevFlags !== undefined) setFlags(prevFlags);
                          setAiRegexExplanation(undefined);
                        }}
                        testId="lark-regex-ai-generate"
                      />
                    </div>

                    {/* /pattern/flags 胶囊输入框 */}
                    <div
                      className={`ui-field-within mt-2.5 flex items-center gap-1 rounded-xl border bg-white px-2.5 py-1.5 transition-colors ${
                        !previewState.valid && pattern.trim()
                          ? 'border-red-300 ring-2 ring-red-100'
                          : 'border-zinc-300'
                      } ${regexFlash.flashClass}`}
                    >
                      <span className="select-none font-mono text-[14px] text-zinc-400">/</span>
                      <input
                        type="text"
                        value={pattern}
                        onChange={event => {
                          setPattern(event.target.value);
                          setAiRegexExplanation(undefined);
                        }}
                        placeholder="(?:P[01]|告警|报错|502|OOM)"
                        aria-label="正则表达式"
                        aria-invalid={!previewState.valid && Boolean(pattern.trim())}
                        className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-zinc-900 placeholder:text-zinc-400"
                      />
                      <span className="select-none font-mono text-[14px] text-zinc-400">/</span>
                      <div className="flex shrink-0 items-center gap-0.5 pl-0.5">
                        {FLAG_OPTIONS.map(option => {
                          const active = flags.includes(option.flag);
                          return (
                            <HoverTooltip key={option.flag} content={option.tip}>
                              <button
                                type="button"
                                aria-pressed={active}
                                onClick={() => setFlags(current => toggleRegexFlag(current, option.flag))}
                                className={`grid h-6 w-6 place-items-center rounded-md font-mono text-[11px] font-semibold transition-colors ${
                                  active
                                    ? 'bg-zinc-900 text-white'
                                    : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800'
                                }`}
                              >
                                {option.label}
                              </button>
                            </HoverTooltip>
                          );
                        })}
                      </div>
                    </div>

                    {/* 实时校验状态 / AI 生成说明 / 防自激开关 */}
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
                        {previewState.loading ? (
                          <span className="inline-flex items-center gap-1 text-zinc-500">
                            <LoaderCircle size={11} className="animate-spin" />
                            <span>正在校验并预匹配…</span>
                          </span>
                        ) : !pattern.trim() ? (
                          <span className="text-zinc-400">输入正则后右侧将实时高亮命中消息</span>
                        ) : !previewState.valid ? (
                          <span className="inline-flex items-center gap-1 font-medium text-red-600">
                            <AlertTriangle size={12} className="shrink-0" />
                            <span className="break-words">{previewState.error}</span>
                          </span>
                        ) : (
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${
                              previewState.matchedCount > 0
                                ? 'bg-emerald-50 text-emerald-700'
                                : 'bg-zinc-100 text-zinc-600'
                            }`}
                          >
                            <CheckCircle2 size={11} />
                            <span>
                              语法安全 · {chatId ? `命中 ${previewState.matchedCount} / ${messages.length} 条` : '选择群聊即可预览命中'}
                            </span>
                          </span>
                        )}
                      </div>

                      <HoverTooltip content="默认开启：跳过其他机器人发送的消息，防止多个机器人互相触发死循环（机器人自身发出的消息始终被屏蔽）">
                        <label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-zinc-500">
                          <span>忽略机器人消息</span>
                          <Switch size="small" checked={ignoreBotMessages} onChange={setIgnoreBotMessages} />
                        </label>
                      </HoverTooltip>
                    </div>

                    {aiRegexExplanation && (
                      <div className="mt-2 flex items-start gap-1.5 rounded-xl border border-sky-200/80 bg-sky-50/70 px-2.5 py-2 text-[11px] leading-4 text-sky-900">
                        <Sparkles size={12} className="mt-0.5 shrink-0 text-sky-600" />
                        <span className="min-w-0 flex-1">{aiRegexExplanation}</span>
                      </div>
                    )}
                  </section>

                  {/* 第 3 步：唤起模式（话题内 vs 主线程） */}
                  <section className="rounded-2xl border border-zinc-200/90 bg-white p-3.5 shadow-[0_1px_2px_rgba(24,24,27,.03)]">
                    <div className="flex items-center gap-2">
                      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-zinc-900 text-[11px] font-semibold text-white">3</span>
                      <h3 className="text-[13px] font-semibold text-zinc-900">唤起模式</h3>
                    </div>

                    <div
                      role="radiogroup"
                      aria-label="唤起模式"
                      className="mt-2.5 grid grid-cols-2 gap-2"
                    >
                      {([
                        {
                          value: 'thread' as const,
                          title: '话题内唤起',
                          desc: 'reply_in_thread 回复原消息，形成独立话题不刷屏',
                          icon: CornerDownRight
                        },
                        {
                          value: 'main' as const,
                          title: '主线程唤起',
                          desc: '在群主线程直接回复并引用定位原消息',
                          icon: MessageSquare
                        }
                      ]).map(option => {
                        const active = replyMode === option.value;
                        const Icon = option.icon;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            onClick={() => setReplyMode(option.value)}
                            className={`flex flex-col items-start rounded-xl border p-2.5 text-left transition-all ${
                              active
                                ? 'border-zinc-900 bg-zinc-900 text-white shadow-sm'
                                : 'border-zinc-200 bg-zinc-50/60 text-zinc-700 hover:border-zinc-300 hover:bg-white'
                            }`}
                          >
                            <div className="flex w-full items-center justify-between gap-1.5">
                              <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold">
                                <Icon size={13} />
                                {option.title}
                              </span>
                              <span
                                className={`grid h-4 w-4 place-items-center rounded-full border ${
                                  active ? 'border-white/40 bg-white/15 text-white' : 'border-zinc-300 text-transparent'
                                }`}
                              >
                                <Check size={9} />
                              </span>
                            </div>
                            <p className={`mt-1 text-[10px] leading-4 ${active ? 'text-zinc-300' : 'text-zinc-500'}`}>
                              {option.desc}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  </section>

                  {/* 第 4 步：预输入 Prompt 模板 + 变量芯片 + AI 写/优化 Prompt */}
                  <section className="rounded-2xl border border-zinc-200/90 bg-white p-3.5 shadow-[0_1px_2px_rgba(24,24,27,.03)]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-zinc-900 text-[11px] font-semibold text-white">4</span>
                        <h3 className="text-[13px] font-semibold text-zinc-900">预输入 Prompt 模板</h3>
                      </div>
                      <AiTextAssistControl
                        mode={promptTemplate.trim() ? 'prompt_optimize' : 'prompt_write'}
                        value={promptTemplate}
                        onChange={nextPrompt => setPromptTemplate(nextPrompt)}
                        label={promptTemplate.trim() ? 'AI 优化 Prompt' : 'AI 写 Prompt'}
                        ariaLabel="AI 编写或优化预输入 Prompt"
                        tooltip="结合所在群聊、正则规则与变量生成或润色预输入指令"
                        unconfiguredTooltip={LLM_UNCONFIGURED_TOOLTIP}
                        instructionPlaceholder="例如：收到 P0 告警时要求先给根因假设再给止血命令"
                        resetKey={selectedRuleId ?? 'new'}
                        onFlash={promptFlash.triggerFlash}
                        context={() => ({
                          field: '飞书群聊正则唤起预输入 Prompt',
                          purpose: '当飞书群消息命中正则表达式时，自动注入给 Agent 的任务指令模板',
                          variables: variables.map(v => v.key),
                          ...(resolvedChatName ? { groupName: resolvedChatName } : {}),
                          ...(botSummaryForAi ? { botContext: botSummaryForAi } : {}),
                          extra: pattern.trim() ? `触发正则：/${pattern}/${flags}` : undefined
                        })}
                        testId="lark-regex-ai-prompt"
                      />
                    </div>

                    {/* 预置场景模板胶囊 */}
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {templates.map(template => {
                        const active = presetId === template.id;
                        return (
                          <HoverTooltip key={template.id} content={template.description}>
                            <button
                              type="button"
                              onClick={() => handleApplyTemplate(template)}
                              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all ${
                                active
                                  ? 'border-zinc-900 bg-zinc-900 text-white shadow-sm'
                                  : 'border-zinc-200 bg-zinc-50 text-zinc-700 hover:border-zinc-300 hover:bg-white'
                              }`}
                            >
                              <span>{template.name}</span>
                            </button>
                          </HoverTooltip>
                        );
                      })}
                    </div>

                    {activePreset && activePreset.suggestedPattern && pattern.trim() !== activePreset.suggestedPattern && (
                      <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-zinc-50 px-2.5 py-1.5 text-[11px] text-zinc-500">
                        <span className="truncate">
                          推荐正则：<code className="font-mono text-zinc-700">/{activePreset.suggestedPattern}/{activePreset.suggestedFlags}</code>
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setPattern(activePreset.suggestedPattern);
                            setFlags(activePreset.suggestedFlags);
                            setReplyMode(activePreset.suggestedReplyMode);
                            regexFlash.triggerFlash();
                          }}
                          className="shrink-0 rounded-md bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-800 shadow-sm ring-1 ring-zinc-200 transition-colors hover:bg-zinc-100"
                        >
                          套用推荐正则
                        </button>
                      </div>
                    )}

                    {/* Prompt 编辑区 */}
                    <div className={`mt-2.5 overflow-hidden rounded-xl border border-zinc-300 bg-white ui-field-within ${promptFlash.flashClass}`}>
                      <textarea
                        ref={promptTextareaRef}
                        value={promptTemplate}
                        onChange={event => setPromptTemplate(event.target.value)}
                        rows={4}
                        placeholder="输入命中正则后发给 Agent 的预设指令，支持点击下方变量芯片插入群聊上下文…"
                        aria-label="预输入 Prompt 模板"
                        className="block w-full resize-y bg-transparent px-3 py-2 text-[12px] leading-5 text-zinc-900 placeholder:text-zinc-400"
                      />
                      <div className="flex flex-wrap items-center gap-1 border-t border-zinc-100 bg-zinc-50/80 px-2 py-1.5">
                        <span className="mr-0.5 text-[10px] font-medium text-zinc-400">插入变量：</span>
                        {variables.map(item => (
                          <HoverTooltip key={item.key} content={`${item.label}：${item.description}`}>
                            <button
                              type="button"
                              onClick={() => handleInsertVariable(item.token)}
                              className="inline-flex items-center rounded-md border border-zinc-200/90 bg-white px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 transition-colors hover:border-zinc-400 hover:text-zinc-900 active:scale-[.97]"
                            >
                              {item.token}
                            </button>
                          </HoverTooltip>
                        ))}
                      </div>
                    </div>

                    {/* 基础信息自动注入保障条 */}
                    <div className="mt-2.5 flex items-start gap-2 rounded-xl border border-zinc-200/80 bg-zinc-50/80 px-2.5 py-2 text-[11px] leading-4 text-zinc-500">
                      <Info size={13} className="mt-0.5 shrink-0 text-zinc-400" />
                      <span>
                        除上方模板外，每次唤起都会<strong className="font-medium text-zinc-700">自动附带基础上下文</strong>（所在群聊名称与 ID、所属机器人、触发规则、发送人、消息时间、原始消息及命中片段），同时完整复用该机器人的预注入 Prompt 与安全门禁。
                      </span>
                    </div>
                  </section>
                </>
              )}
            </div>

            {/* 左栏底部操作栏 */}
            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-zinc-200/80 bg-white px-3.5 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:px-4">
              {selectedRuleId ? (
                confirmDelete ? (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={deleteRule.isPending}
                      onClick={() => deleteRule.mutate(selectedRuleId)}
                      className="inline-flex h-8 items-center gap-1 rounded-lg bg-red-600 px-2.5 text-[12px] font-medium text-white hover:bg-red-700 disabled:opacity-40"
                    >
                      {deleteRule.isPending ? <LoaderCircle size={12} className="animate-spin" /> : <Trash2 size={12} />}
                      确认删除
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      className="h-8 rounded-lg px-2 text-[12px] text-zinc-500 hover:bg-zinc-100"
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-red-600 transition-colors hover:bg-red-50"
                  >
                    <Trash2 size={13} />
                    <span>删除</span>
                  </button>
                )
              ) : (
                <span className="truncate text-[11px] text-zinc-400">
                  {chatId ? '可先在右侧预览命中，再保存规则' : '选择机器人与群聊开始配置'}
                </span>
              )}

              <div className="flex shrink-0 items-center gap-1.5">
                {chatId && (
                  <button
                    type="button"
                    onClick={() => setMobilePane('preview')}
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2.5 text-[12px] font-medium text-zinc-700 hover:bg-zinc-50 lg:hidden"
                  >
                    <span>看命中</span>
                    <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold tabular-nums text-amber-800">
                      {visibleMatchedCount}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={!canSaveRule}
                  onClick={() => saveRule.mutate()}
                  className="inline-flex h-8 min-w-[92px] items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 text-[12px] font-medium text-white transition-all hover:bg-zinc-800 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-35"
                >
                  {saveRule.isPending ? (
                    <>
                      <LoaderCircle size={12} className="animate-spin" />
                      <span>保存中…</span>
                    </>
                  ) : savedNotice ? (
                    <>
                      <Check key="saved" size={13} className="ui-icon-pop text-emerald-400" />
                      <span>已保存</span>
                    </>
                  ) : (
                    <span>{selectedRuleId ? '更新规则' : '保存规则'}</span>
                  )}
                </button>
              </div>
            </div>
          </aside>

          {/* 右栏：群聊记录、正则命中预览 & 历史补偿工作区 */}
          <section
            className={`${
              mobilePane === 'preview' ? 'flex' : 'hidden lg:flex'
            } min-h-0 min-w-0 flex-1 flex-col bg-white`}
          >
            {/* 预览顶栏：群信息 + 刷新 + 全部/仅看命中分段筛选器 */}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2.5 border-b border-zinc-200/80 px-3.5 py-2.5 sm:px-5 sm:py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                {chatId ? (
                  <>
                    <CircleAvatar name={resolvedChatName} src={selectedChat?.avatar} size={32} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <h3 className="truncate text-[13px] font-semibold text-zinc-900 sm:text-[14px]">
                          {resolvedChatName}
                        </h3>
                        <span className="hidden shrink-0 rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500 xl:inline">
                          {chatId}
                        </span>
                      </div>
                      <p className="truncate text-[11px] text-zinc-400">
                        {selectedBot ? `复用「${selectedBot.name}」的飞书设置` : '请选择机器人'}
                        {messages.length > 0 ? ` · 最近 ${messages.length} 条消息` : ''}
                      </p>
                    </div>
                  </>
                ) : (
                  <div className="min-w-0">
                    <h3 className="text-[13px] font-semibold text-zinc-900">群聊消息预览与历史命中补偿</h3>
                    <p className="text-[11px] text-zinc-400">选择机器人和所在群聊后加载最近消息</p>
                  </div>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                {chatId && (
                  <HoverTooltip content="重新拉取该群最近 50 条飞书消息">
                    <button
                      type="button"
                      disabled={messagesQuery.isFetching}
                      onClick={() => void messagesQuery.refetch()}
                      aria-label="刷新群聊消息"
                      className="grid h-8 w-8 place-items-center rounded-lg border border-zinc-200 bg-white text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900 disabled:opacity-40"
                    >
                      <RefreshCw size={13} className={messagesQuery.isFetching ? 'animate-spin' : ''} />
                    </button>
                  </HoverTooltip>
                )}

                {/* 全部消息 / 仅看命中 分段筛选器 */}
                <SlidingSegmented
                  role="tablist"
                  ariaLabel="消息筛选"
                  size="md"
                  itemClassName="px-2.5 text-[11px]"
                  value={filterMode}
                  onChange={setFilterMode}
                  options={[
                    {
                      value: 'all' as const,
                      label: (
                        <>
                          <span>全部消息</span>
                          <span className="tabular-nums text-zinc-400">({messages.length})</span>
                        </>
                      )
                    },
                    {
                      value: 'matched' as const,
                      label: (
                        <>
                          <Filter size={11} />
                          <span>仅看命中</span>
                          <span
                            key={visibleMatchedCount}
                            className={`ui-regex-count-pop rounded-full px-1.5 py-0.2 text-[10px] font-semibold tabular-nums ${
                              visibleMatchedCount > 0
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-zinc-200/80 text-zinc-500'
                            }`}
                          >
                            {visibleMatchedCount}
                          </span>
                        </>
                      )
                    }
                  ]}
                />
              </div>
            </div>

            {/* 批量历史补偿操作条（命中数 > 0 时丝滑展开） */}
            <div
              className="ui-regex-batch-bar shrink-0"
              data-open={Boolean(chatId && hasValidActiveRegex && selectionStats.matchedIds.length > 0)}
            >
              <div className="ui-regex-batch-bar-inner">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200/70 bg-amber-50/60 px-3.5 py-2 sm:px-5">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-amber-900">
                    <button
                      type="button"
                      disabled={selectionStats.uncompensatedMatchedIds.length === 0}
                      onClick={handleToggleSelectAllUncompensated}
                      className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-amber-300/80 bg-white px-2.5 text-[11px] font-medium text-amber-900 transition-colors hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <Check size={11} />
                      <span>
                        {selectionStats.uncompensatedMatchedIds.length > 0
                          && selectionStats.uncompensatedMatchedIds.every(id => selectedMessageIds.has(id))
                          ? '取消全选'
                          : `全选未补偿 (${selectionStats.uncompensatedMatchedIds.length})`}
                      </span>
                    </button>
                    <span className="text-amber-800">
                      共命中 <strong className="tabular-nums">{selectionStats.matchedIds.length}</strong> 条
                      {selectionStats.compensatedMatchedCount > 0 && (
                        <> · 已补偿 <strong className="tabular-nums">{selectionStats.compensatedMatchedCount}</strong> 条</>
                      )}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {selectionStats.selectedCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setSelectedMessageIds(new Set())}
                        className="text-[11px] text-amber-800 hover:underline"
                      >
                        清空勾选
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={selectionStats.selectedCount === 0 || anyBatchBusy || !selectedBot?.setupComplete}
                      onClick={() => {
                        const targets = messages.filter(item => selectedMessageIds.has(item.messageId));
                        void runBackfill(targets, false);
                      }}
                      className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-zinc-900 px-3 text-[11px] font-medium text-white shadow-sm transition-all hover:bg-zinc-800 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {anyBatchBusy ? <LoaderCircle size={11} className="animate-spin" /> : <Zap size={11} />}
                      <span>补偿所选 ({selectionStats.selectedCount})</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* 聊天记录消息流（借鉴 LarkAvatarPanel 对话流视觉语言） */}
            <div
              ref={messagesScrollRef}
              className="min-h-0 flex-1 overflow-y-auto bg-zinc-50/45 px-3.5 py-3.5 sm:px-5 sm:py-4"
            >
              {!botId || !chatId ? (
                <div className="grid h-full place-items-center py-10 text-center">
                  <div className="max-w-[380px]">
                    <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-white text-zinc-400 shadow-sm ring-1 ring-zinc-200">
                      <MessagesSquare size={22} />
                    </div>
                    <h4 className="mt-4 text-[14px] font-semibold text-zinc-900">先选择一个飞书群聊</h4>
                    <p className="mt-1.5 text-[12px] leading-5 text-zinc-500">
                      选中机器人和它所在的群聊后，这里会自动加载最近群聊记录；输入正则表达式即可实时高亮预览命中并一键发起历史补偿。
                    </p>
                    <div className="mt-5 grid grid-cols-3 gap-2 text-left">
                      {[
                        ['1', '选群拉消息', '复用机器人凭证'],
                        ['2', '正则预匹配', '子串高亮筛选'],
                        ['3', '历史补偿', '复用飞书设置']
                      ].map(([step, title, hint]) => (
                        <div key={step} className="rounded-xl border border-zinc-200/80 bg-white p-2.5">
                          <span className="grid h-5 w-5 place-items-center rounded-full bg-zinc-100 text-[10px] font-semibold text-zinc-700">{step}</span>
                          <p className="mt-1.5 text-[11px] font-medium text-zinc-800">{title}</p>
                          <p className="mt-0.5 text-[10px] text-zinc-400">{hint}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : messagesQuery.isLoading ? (
                <ChatBubbleSkeletons />
              ) : messagesQuery.isError ? (
                <div className="grid h-full place-items-center py-8 text-center">
                  <div className="max-w-[420px] rounded-2xl border border-red-200 bg-white p-5 text-left shadow-sm">
                    <div className="flex items-start gap-2.5">
                      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-500" />
                      <div className="min-w-0 flex-1">
                        <h4 className="text-[13px] font-semibold text-zinc-900">无法读取该群聊历史消息</h4>
                        <p className="mt-1 break-words text-[12px] leading-5 text-red-600">
                          {messagesQuery.error instanceof Error ? messagesQuery.error.message : '飞书接口请求失败'}
                        </p>
                        <button
                          type="button"
                          onClick={() => void messagesQuery.refetch()}
                          className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 text-[12px] font-medium text-zinc-700 hover:bg-zinc-50"
                        >
                          <RefreshCw size={12} />重新加载
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : messages.length === 0 ? (
                <div className="grid h-full place-items-center py-10 text-center">
                  <div>
                    <MessagesSquare size={26} className="mx-auto text-zinc-300" />
                    <p className="mt-2 text-[12px] text-zinc-500">该群聊最近暂无可读消息</p>
                    <p className="mt-0.5 text-[11px] text-zinc-400">发送几条群消息后点右上角刷新即可预览匹配</p>
                  </div>
                </div>
              ) : (
                <div>
                  {/* 仅看命中但命中数为 0 的温和空态提示 */}
                  {filterMode === 'matched' && hasValidActiveRegex && visibleMatchedCount === 0 && (
                    <div className="ui-empty-state mb-3 rounded-2xl border border-dashed border-zinc-300 bg-white px-4 py-8 text-center">
                      <Filter size={22} className="mx-auto text-zinc-300" />
                      <p className="mt-2 text-[13px] font-medium text-zinc-700">当前最近 {messages.length} 条消息均未命中该正则</p>
                      <p className="mt-1 text-[11px] text-zinc-400">
                        试试调整表达式、切换 <code className="rounded bg-zinc-100 px-1 font-mono">i</code> 大小写标志，或点击左侧「AI 生成正则」
                      </p>
                      <button
                        type="button"
                        onClick={() => setFilterMode('all')}
                        className="mt-3 inline-flex h-7 items-center rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-[11px] font-medium text-zinc-700 hover:bg-zinc-100"
                      >
                        切回全部消息
                      </button>
                    </div>
                  )}

                  {filterMode === 'matched' && !hasValidActiveRegex && (
                    <div className="ui-empty-state mb-3 rounded-2xl border border-dashed border-zinc-300 bg-white px-4 py-8 text-center">
                      <Regex size={22} className="mx-auto text-zinc-300" />
                      <p className="mt-2 text-[13px] font-medium text-zinc-700">
                        {pattern.trim() ? '请先修正左侧正则表达式语法' : '输入正则表达式后即可筛选命中消息'}
                      </p>
                    </div>
                  )}

                  {messages.map(msg => {
                    const matchInfo = previewState.resultsById.get(msg.messageId);
                    const matched = Boolean(hasValidActiveRegex && matchInfo?.matched);
                    const spans = matched ? (matchInfo?.matches ?? EMPTY_SPANS) : EMPTY_SPANS;
                    const collapsed = filterMode === 'matched' && !matched;
                    const hitInfo = getMessageHitInfo(msg.messageId);

                    return (
                      <LarkRegexMessageRow
                        key={msg.messageId}
                        msg={msg}
                        matched={matched}
                        spans={spans}
                        skippedBot={Boolean(matchInfo?.skippedBot)}
                        collapsed={collapsed}
                        hasValidActiveRegex={hasValidActiveRegex}
                        isChecked={selectedMessageIds.has(msg.messageId)}
                        isBusy={busyMessageIds.has(msg.messageId)}
                        triggered={hitInfo.triggered}
                        hitSessionId={hitInfo.sessionId}
                        failedReason={hitInfo.failedReason}
                        botReady={Boolean(selectedBot?.setupComplete)}
                        onToggleSelect={toggleSelectMessage}
                        onOpenSession={handleOpenSessionStable}
                        onBackfillOne={handleBackfillOne}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
      {toast.toast}
    </div>
  );
}
