import type {
  AskUserQuestionAnswerItem,
  AskUserQuestionAnswerPayload,
  AskUserQuestionConfig,
  ConfirmActionDecision,
  ConfirmActionInteractionPayload,
  ConfirmActionRisk,
  ConfirmActionSpec,
  DeclarativeInteractionField,
  DeclarativeOutputPluginInteractionPayload,
  OutputPluginCatalogItem,
  OutputPluginsCatalogSnapshot,
  OutputPluginsGlobalConfig,
  BoardActor,
  BoardColumnColor,
  BoardColumnRecord,
  BoardColumnRule,
  BoardDensity,
  BoardDropAction,
  BoardEntityKind,
  BoardFilter,
  BoardItemLiveDigest,
  BoardItemRecord,
  BoardRecord,
  BoardTemplate,
  BoardTemplatePayload,
  BoardViewMode,
  CustomTheme,
  CustomThemeMode,
  CustomThemeSource,
  CustomThemeTokenKey,
  CustomThemeTokens,
  HydratedBoard,
  HydratedBoardColumn,
  HydratedBoardItem,
  ThemeContrastAdjustment,
  ThemeContrastReport,
  ThemePreferenceMode,
  ThemePreferences,
  ThemesStateSnapshot,
  VsCodeThemeMeta
} from '@agent-dock/agent-dock-shared';

export type BoardVisualState = BoardItemLiveDigest['visualState'];

export type {
  AskUserQuestionAnswerItem,
  AskUserQuestionAnswerPayload,
  AskUserQuestionConfig,
  ConfirmActionDecision,
  ConfirmActionInteractionPayload,
  ConfirmActionRisk,
  ConfirmActionSpec,
  DeclarativeInteractionField,
  DeclarativeOutputPluginInteractionPayload,
  OutputPluginCatalogItem,
  OutputPluginsCatalogSnapshot,
  OutputPluginsGlobalConfig,
  BoardActor,
  BoardColumnColor,
  BoardColumnRecord,
  BoardColumnRule,
  BoardDensity,
  BoardDropAction,
  BoardEntityKind,
  BoardFilter,
  BoardItemLiveDigest,
  BoardItemRecord,
  BoardRecord,
  BoardTemplate,
  BoardTemplatePayload,
  BoardViewMode,
  CustomTheme,
  CustomThemeMode,
  CustomThemeSource,
  CustomThemeTokenKey,
  CustomThemeTokens,
  HydratedBoard,
  HydratedBoardColumn,
  HydratedBoardItem,
  ThemeContrastAdjustment,
  ThemeContrastReport,
  ThemePreferenceMode,
  ThemePreferences,
  ThemesStateSnapshot,
  VsCodeThemeMeta
};

export interface ParsedVsCodeThemeVariant {
  theme: CustomTheme;
  adjustments: ThemeContrastAdjustment[];
  report: ThemeContrastReport;
  label: string;
  uiTheme?: string;
  colorCount: number;
}

export interface ImportVsCodeThemeResponse {
  sourceLabel: string;
  extensionId?: string;
  extensionName?: string;
  publisher?: string;
  version?: string;
  marketplaceUrl?: string;
  variants: ParsedVsCodeThemeVariant[];
  imported: CustomTheme[];
  appliedTheme?: CustomTheme;
  state: ThemesStateSnapshot;
}

export interface GenerateThemeResponse {
  theme: CustomTheme;
  adjustments: ThemeContrastAdjustment[];
  report: ThemeContrastReport;
  saved: boolean;
  applied: boolean;
  model: string;
  state: ThemesStateSnapshot;
}

export const protocols = ['auto', 'acp', 'jsonl', 'pipe', 'pty'] as const;
export type Protocol = (typeof protocols)[number];
export const permissionModes = ['ask', 'approve-reads', 'deny-all', 'full-trust'] as const;
export type PermissionMode = (typeof permissionModes)[number];
/** 三种模型线格式。与 apps/server/src/llm/types.ts 的 llmFormats 对应（服务端也会回传选项列表）。 */
export const llmFormats = ['openai-chat', 'openai-responses', 'anthropic-messages'] as const;
export type LlmFormat = (typeof llmFormats)[number];
/** Anthropic 兼容端点的鉴权头：原生 API Key 用 x-api-key，代理/OAuth token 用 Bearer。 */
export const llmAuthTypes = ['api-key', 'bearer'] as const;
export type LlmAuthType = (typeof llmAuthTypes)[number];
export type Agent = {
  id: string;
  name: string;
  command: string;
  args: string[];
  protocol: Protocol;
  model?: string;
  extraModels?: string[];
  reasoningEffort?: string;
  version?: string;
  cwd?: string;
  env: Record<string, string>;
  systemPrompt?: string;
  permissionMode: PermissionMode;
  timeout: number;
  capabilities: { pause: boolean; resume: boolean };
  builtin: boolean;
  disabled?: boolean;
};
export type AgentModel = { id: string; name: string };
export type UsageSourceKind = 'official' | 'magpie';
export type UsageMatchedBy = 'session_model' | 'magpie_route' | 'agent_config' | 'magpie_applied' | 'official_direct';
export type UsageUnavailableCode = 'magpie_unreachable' | 'magpie_auth_required' | 'provider_no_quota' | 'official_unavailable';
export type UsageWindowStatus = 'normal' | 'warning' | 'exhausted' | 'cooldown';
export type UsageSourceMeta = {
  service: UsageSourceKind;
  providerId?: string;
  providerName?: string;
  endpoint?: string;
  gatewayVersion?: string;
  matchedBy: UsageMatchedBy;
  matchedModel?: string;
  activeAccount?: string;
  accountCount?: number;
};
export type UsageBalance = { display: string; currency?: string; amount?: number };
export type AgentUsageWindow = {
  label: string;
  usedPercent: number;
  resetsAt?: number;
  display?: string;
  amount?: number;
  limit?: number;
  unit?: string;
  runsOutAt?: number;
  pool?: string;
  status?: UsageWindowStatus;
  aggregated?: boolean;
};
export type UsageAccountSummary = {
  label: string;
  plan?: string;
  active?: boolean;
  windows: AgentUsageWindow[];
  balance?: UsageBalance;
  readAt?: number;
};
export type UsageGatewayStats = {
  period: 'today';
  calls: number;
  errors: number;
  totalTokens: number;
  costUsd?: number;
  credits?: number;
};
export type UsageAlternateSource = { kind: UsageSourceKind; label: string };
export type CodexUsage = {
  status: 'available' | 'unavailable';
  plan?: string;
  windows: (AgentUsageWindow & { windowDurationMins?: number })[];
  balance?: UsageBalance;
  accounts?: UsageAccountSummary[];
  gatewayStats?: UsageGatewayStats;
  notices?: string[];
  reason?: string;
  unavailableCode?: UsageUnavailableCode;
  source?: string;
  sourceMeta?: UsageSourceMeta;
  alternateSources?: UsageAlternateSource[];
  stale?: boolean;
  checkedAt: number;
  cacheTtlMs?: number;
};
export type AgentUsage = {
  status: 'available' | 'unavailable';
  plan?: string;
  windows: AgentUsageWindow[];
  balance?: UsageBalance;
  accounts?: UsageAccountSummary[];
  gatewayStats?: UsageGatewayStats;
  notices?: string[];
  reason?: string;
  unavailableCode?: UsageUnavailableCode;
  source?: string;
  sourceMeta?: UsageSourceMeta;
  alternateSources?: UsageAlternateSource[];
  stale?: boolean;
  checkedAt: number;
  cacheTtlMs?: number;
};
export type UsageQuotaParams = {
  agentId: string;
  model?: string;
  sessionId?: string;
  source?: 'auto' | UsageSourceKind;
  refresh?: boolean;
};
export type AgentModelsResult = { models: AgentModel[]; defaultModel?: string; reasoningEfforts: AgentModel[]; defaultReasoningEffort?: string; source?: 'acp' | 'cli' | 'agent'; warning?: string };
export type SkillReference = { name: string; description: string; path: string; source: 'workspace' | 'user' };
export type LarkAllowedUser = { openId: string; name: string };
export type LarkTurnSyncSources = { supervision: boolean; web: boolean; schedule: boolean; maintenance: boolean };
export type LarkTurnSyncConfig = { enabled: boolean; sources: LarkTurnSyncSources; filterSilentSchedule: boolean };
export type LarkTurnSyncConfigInput = { enabled?: boolean; sources?: Partial<LarkTurnSyncSources>; filterSilentSchedule?: boolean };
export type LarkBotConfig = { configured: true; appId: string; name: string; tabLabel: string; setupComplete: boolean; avatarUrl?: string; workspace?: string; webBaseUrl?: string; defaultAgentId?: string; defaultModel?: string; defaultReasoningEffort?: string; preInjectPrompt: string; listening: boolean; activeListening: boolean; groupToolsEnabled: boolean; groupToolsAllowSend: boolean; groupSessionScope: 'user' | 'chat'; pushIntervalMs: number; traceLimit?: number; hideTraceOnComplete: boolean; quietReply: boolean; turnSync: LarkTurnSyncConfig; allowedUsers: LarkAllowedUser[]; allowedUserNames?: string[]; allowedEmails: string[]; allowedBots: LarkAllowedUser[]; allowedBotNames?: string[]; peerBotsAllowed: boolean; highRiskAllowedUsers: LarkAllowedUser[]; highRiskAllowedUserNames?: string[]; highRiskAllowedEmails: string[]; highRiskPattern: string; gateEnabled: boolean; softGateEnabled: boolean; hardGateEnabled: boolean; hookTrustConfirmed: boolean };
export type LarkConfig = { configured: boolean; bots: LarkBotConfig[]; listeningDisabled: boolean };
export type LarkHookStatus = { agentId?: string; supported: boolean; installed: boolean; writable: boolean; trustRequired: boolean; hooksPath?: string; reason?: string; trustInstructions?: string };
export type LarkBotChatItem = { chatId: string; name: string; description?: string; avatar?: string; ownerId?: string; external?: boolean; chatMode?: string; chatStatus?: string };
export type LarkRegexReplyMode = 'thread' | 'main';
export type LarkRegexTriggerRule = {
  id: string;
  name: string;
  enabled: boolean;
  botId: string;
  chatId: string;
  chatName: string;
  pattern: string;
  flags: string;
  replyMode: LarkRegexReplyMode;
  promptTemplate: string;
  presetId?: string;
  ignoreBotMessages: boolean;
  createdAt: string;
  updatedAt: string;
  hitCount?: number;
  lastTriggeredAt?: string;
};
export type LarkRegexTriggerHit = {
  id: string;
  ruleId: string;
  botId: string;
  chatId: string;
  messageId: string;
  sessionId?: string;
  cardMessageId?: string;
  matchedText: string;
  senderName?: string;
  messagePreview?: string;
  triggerType: 'realtime' | 'backfill';
  status: 'triggered' | 'failed';
  error?: string;
  triggeredAt: string;
};
export type LarkRegexMatchSpan = { start: number; end: number; text: string };
export type LarkPreviewChatMessage = {
  messageId: string;
  chatId: string;
  threadId?: string;
  rootId?: string;
  parentId?: string;
  senderId?: string;
  senderName: string;
  senderType: string;
  text: string;
  msgType: string;
  createTime: string;
  createdAt: string;
  deleted?: boolean;
  mentions?: Array<{ key?: string; name?: string; id?: string }>;
};
export type LarkRegexPromptTemplate = {
  id: string;
  name: string;
  badge: string;
  description: string;
  suggestedPattern: string;
  suggestedFlags: string;
  suggestedReplyMode: LarkRegexReplyMode;
  promptTemplate: string;
};
export type LarkRegexTemplateVariable = { key: string; token: string; label: string; description: string };
export type LarkRegexTriggersResponse = {
  rules: LarkRegexTriggerRule[];
  templates: LarkRegexPromptTemplate[];
  variables: LarkRegexTemplateVariable[];
};
export type LarkChatMessagesPreviewResponse = {
  botId: string;
  chatId: string;
  items: LarkPreviewChatMessage[];
  hasMore: boolean;
  pageToken?: string;
  hitsByMessageId: Record<string, LarkRegexTriggerHit[]>;
};
export type LarkRegexPreviewResponse = {
  valid: boolean;
  error?: string;
  normalizedFlags: string;
  totalCount: number;
  matchedCount: number;
  results: Array<{ messageId: string; matched: boolean; skippedBot?: boolean; matches: LarkRegexMatchSpan[] }>;
  messages?: LarkPreviewChatMessage[];
};
export type LarkRegexBackfillItemResult = {
  messageId: string;
  status: 'triggered' | 'skipped' | 'failed';
  sessionId?: string;
  cardMessageId?: string;
  matchedText?: string;
  alreadyTriggered?: boolean;
  reason?: string;
};
export type LarkRegexBackfillResponse = {
  ruleId: string;
  botId: string;
  chatId: string;
  replyMode: LarkRegexReplyMode;
  triggeredCount: number;
  skippedCount: number;
  failedCount: number;
  results: LarkRegexBackfillItemResult[];
};
export type SaveLarkRegexTriggerBody = {
  name?: string;
  enabled?: boolean;
  botId?: string;
  chatId?: string;
  chatName?: string;
  pattern?: string;
  flags?: string;
  replyMode?: LarkRegexReplyMode;
  promptTemplate?: string;
  presetId?: string | null;
  ignoreBotMessages?: boolean;
};
export type LarkAvatarRegion = 'feishu' | 'lark';
export type LarkAvatarAccount = { userId: string; name: string; avatarUrl?: string; email?: string };
export type LarkAvatarRetentionStatus = { inboxMaxItems: number; inboxCleanupWarnThreshold: number; inboxCount: number; shouldWarnCleanup: boolean };
export type LarkAvatarCleanupResult = { ok: true; deleted: number; remaining: number; keepLatest: number };
export type LarkAvatarStatus = { configured: boolean; connected: boolean; listening: boolean; state: 'disconnected' | 'connecting' | 'connected' | 'expired'; account?: LarkAvatarAccount; region: LarkAvatarRegion; listenChats: string[]; lastError?: string; lastSyncedAt?: string; syncIntervalSeconds: number; counts: { inbox: number; action: number; pendingDrafts: number }; retention?: LarkAvatarRetentionStatus };
export type LarkAvatarReactionRoute = 'ask' | 'main' | 'independent';
export type LarkAvatarReplyForwardMode = 'all' | 'final_only' | 'none';
export type LarkAvatarConfigRecord = { id: string; config: { region: LarkAvatarRegion; triggerPrefix: string; contextMessages: number; contextScope: 'anchor' | 'chat'; replyInTopic: boolean; replyMode: 'direct' | 'quote' | 'thread'; replyForwardMode?: LarkAvatarReplyForwardMode; emojiReactions: boolean; reactionTriggerEnabled: boolean; reactionTriggerEmoji: string; reactionTriggerRoute: LarkAvatarReactionRoute; reactionTriggerIgnoreBots: boolean; replySignature: string; agentTimeoutSeconds: number; listening: boolean; listenChats: string[]; inboxMaxItems?: number; inboxCleanupWarnThreshold?: number; allowedSenders: string[]; agentId: string; model: string; reasoningEffort: string; workspace: string }; account?: LarkAvatarAccount; state: 'disconnected' | 'connecting' | 'connected' | 'expired'; lastError?: string; createdAt: string; updatedAt: string };
export type LarkAvatarReactionTrigger = { key: string; messageId: string; chatId?: string; operatorId?: string; operatorType?: string; emoji: string; route: LarkAvatarReactionRoute; state: 'pending' | 'dispatching' | 'awaiting_route' | 'dispatched' | 'ignored' | 'failed'; actionTime?: string; reason?: string; sessionId?: string; taskId?: string; createdAt: string; updatedAt: string };
export type LarkAvatarReactionDiagnostics = {
  lastEvent?: { at: string; messageId: string; emojiType: string; operatorId?: string; operatorType?: string; appId?: string; actionTime?: string; chatId?: string; route?: LarkAvatarReactionRoute; outcome: string; detail?: string; sessionId?: string; taskId?: string };
  triggers: LarkAvatarReactionTrigger[];
  source?: { botConfigured: boolean; botEnabled: number; botAppIds: string[]; listenerActive: boolean; activeAppIds: string[]; listenerDisabled: boolean };
  lastOutboundReaction?: { at: string; messageId: string; picked: string[]; succeeded: Array<{ emoji: string; count: number }>; failed: Array<{ emoji: string; error: string }> };
};
export type LarkAvatarChatSummary = { id: string; name: string; type: 'p2p' | 'group' | 'topic' | 'unknown'; avatarUrl?: string; memberCount?: number; lastMessageAt?: string };
export type LarkAvatarLoginState = 'idle' | 'starting' | 'waiting' | 'scanned' | 'success' | 'failed' | 'expired';
export type LarkAvatarLoginSnapshot = { state: LarkAvatarLoginState; message: string; region: LarkAvatarRegion; qrContent?: string; attempt: number; expiresAt?: string };
export type LarkAvatarInboxItem = { id: string; threadKey: string; chatId: string; chatType: string; chatName?: string; chatAvatarUrl?: string; senderId?: string; senderName?: string; senderAvatarUrl?: string; title: string; summary?: string; tier: 'action' | 'fyi' | 'noise'; state: 'new' | 'handled'; occurredAt: string; receivedAt: string };
export type LarkAvatarDraft = { id: string; itemId?: string; threadKey?: string; target: string; replyRootId?: string; replyQuote?: boolean; replyThreadChat?: boolean; body: string; state: 'pending' | 'sent' | 'failed' | 'discarded'; sentMessageId?: string; attempts: number; lastError?: string; createdAt: string; updatedAt: string; sentAt?: string };
export type Session = { id: string; agentId: string; state: string; interruptIntent?: 'user' | 'agent_cancelled' | 'daemon_restart'; error?: string; cwd: string; model?: string; reasoningEffort?: string; permissionMode?: 'full-trust'; source?: string; sourceId?: string; sshHost?: string; archivedAt?: string; runId: string; createdAt: string; updatedAt: string; /** 最后一次对话时间；旧数据为空，排序需回退 updatedAt。 */ lastMessageAt?: string | null; systemPrompt?: string; title?: string; titleSource?: 'user' | 'agent' | 'prompt'; customTitle?: string | null; agentTitle?: string | null; /** 非空即置顶；只影响「时间」视图。 */ pinnedAt?: string | null; /** 会话级 XML 询问卡片覆写：null/undefined = 跟随全局默认（向后兼容）。 */ askUserQuestionEnabled?: boolean | null; /** 会话级纯 XML 交互插件覆写映射：缺失或 null = 跟随全局默认。 */ outputPlugins?: Record<string, boolean | null> };
export type Project = { id: string; machineId?: string | null; name: string; cwd: string; pinnedAt?: string | null; exists: boolean; createdAt: string; updatedAt: string };
export type RegisterProjectResult = { project: Project; created: boolean };
export type AutostartStatus = { supported: boolean; enabled: boolean; reason?: string; plistPath?: string; entrypoint?: string };
export type KeepAwakeStatus = { supported: boolean; enabled: boolean; keepDisplay: boolean; reason?: string };
export type SelfUpdateStatus = { currentVersion: string; distTag: string; latestVersion?: string; updateAvailable: boolean; canUpdate: boolean; updating: boolean; runtime?: 'daemon' | 'desktop' | 'foreground'; lastError?: string; checkedAt?: number; checkError?: string };
export type ShareLinkKind = 'hostname' | 'lan-v4' | 'lan-v6' | 'public';
export type ShareLinkUrl = { kind: ShareLinkKind; label: string; url: string };
export type ShareLinkResult = { sessionId?: string; expiresAt: number; urls: ShareLinkUrl[]; publicUrl?: string; publicUrlSource?: 'env' | 'config'; lanEnabled: boolean };
export type ShareSettings = { publicUrl?: string; publicUrlSource?: 'env' | 'config'; envLocked: boolean };
export type SideChatTargetMode = 'follow_current' | 'custom_agent';
export type SideChatOpenMode = 'side_pane' | 'switch_session';
export type BtwSessionReuseMode = 'new_session' | 'reuse_latest';
export type SideChatConfig = {
  targetMode: SideChatTargetMode;
  agentId?: string;
  model?: string;
  reasoningEffort?: string;
  openMode: SideChatOpenMode;
  btwEnabled: boolean;
  triggerPrefix: string;
  btwSessionReuse: BtwSessionReuseMode;
};
export type SideChatConfigState = { configured: boolean; config: SideChatConfig };
export type ExternalSession = { sessionId: string; cwd: string; title?: string; updatedAt?: string };
export type ScheduleDelivery = 'new_session' | 'append';
export type Schedule = { id: string; name: string; sessionId?: string | null; sessionTemplate?: string | null; delivery: ScheduleDelivery; cron?: string | null; runAt?: string | null; intervalMinutes?: number | null; timezone: string; prompt: string; enabled: boolean; nextRunAt?: string | null; lastRunAt?: string | null; lastStatus?: string | null; runCount: number; createdBySessionId?: string | null; createdAt: string; updatedAt: string };
export type ScheduleRun = { id: string; scheduleId: string; fireAt: string; status: 'delivered' | 'skipped' | 'failed'; reason?: string | null; sessionId?: string | null; taskId?: string | null; createdAt: string };
export type ScheduleTemplate = { agentId: string; cwd: string; model?: string; reasoningEffort?: string };
export type UpdateScheduleInput = { name?: string; prompt?: string; delivery?: ScheduleDelivery; sessionId?: string | null; followMain?: boolean; template?: ScheduleTemplate; cron?: string | null; runAt?: string | null; intervalMinutes?: number | null; timezone?: string };
export type CreateScheduleInput = { sessionId?: string; followMain?: boolean; template?: ScheduleTemplate; prompt: string; name?: string; delivery?: ScheduleDelivery; cron?: string; runAt?: string; intervalMinutes?: number; timezone?: string };
export type ExternalSessionsResult = { agentId: string; agentName: string; supported: boolean; sessions: ExternalSession[]; nextCursor?: string };
export type SshHost = { alias: string; hostName?: string; user?: string; port?: number; identityFile?: string; proxy?: boolean; source: string };
export type SshHostsResult = { configPath: string; configExists: boolean; hosts: SshHost[]; error?: string };
export type SshProbeResult = { host: string; ok: boolean; latencyMs: number; platform?: string; nodeVersion?: string; npx?: boolean; home?: string; agents: { claude: boolean; codex: boolean }; detail?: string };
export type DockEvent = { id: string; sequence: number; type: string; timestamp: string; data: any; raw?: string };
export type FsListEntry = { name: string; type: 'file' | 'dir'; size: number; mtime: string };
export type FsListResult = { cwd: string; path: string; entries: FsListEntry[] };
export type FsDirectoryEntry = { name: string; path: string; kind: 'directory' | 'file'; size: number; mtime: string };
export type FsReadFileResult = { kind?: 'file'; cwd: string; path: string; size: number; content: string };
export type FsReadDirectoryResult = {
  kind: 'directory';
  cwd: string;
  path: string;
  absolutePath: string;
  parentPath: string | null;
  entries: FsDirectoryEntry[];
  totalCount: number;
  truncated: boolean;
  hiddenCount: number;
  includeHidden: boolean;
};
export type FsReadResult = FsReadFileResult | FsReadDirectoryResult;
export type Task = { id: string; sessionId: string; prompt: string; sentPrompt?: string | null; finalText?: string | null; status: string; origin?: string | null; createdAt: string; updatedAt: string };
export type AssistantTaskState = 'running' | 'review' | 'needs_user' | 'closed';
export type AssistantTask = {
  id: string; title: string; notes: string; doneWhen: string[]; expectMinutes?: number;
  state: AssistantTaskState; round: number; sessionId?: string; agentId?: string; cwd?: string;
  model?: string; reasoningEffort?: string;
  plan: boolean; outcome?: 'accepted' | 'cancelled'; createdAt: string; updatedAt: string; closedAt?: string;
  /** 第一次开工 / 当前这一轮开工 / 最近一次执行结束的时间。旧服务端没有这些字段。 */
  startedAt?: string; runStartedAt?: string; completedAt?: string;
  /** 已结束各轮的执行时长之和，不含排队、验收等待和返工间隔。 */
  activeMs?: number;
  /** 已关闭便签被折叠进归档区：只读、可取出，不是删除。 */
  archivedAt?: string; archiveBatchId?: string;
  /** 用户主动停止的累计次数与原因；用于在界面上区分停止、失败和被动中断。 */
  stopCount?: number; lastStopReason?: 'user_stopped' | 'failed' | 'interrupted' | 'timeout';
  lastStoppedAt?: string; lastResumedAt?: string; resumedStopCount?: number;
};
export type AssistantWatch = {
  id: string; ownerSessionId: string; name: string; command: string; cwd?: string;
  intervalSeconds: number; timeoutSeconds: number; mode: 'once' | 'repeat'; cooldownSeconds: number;
  state: 'active' | 'paused' | 'fired' | 'expired'; lastRunAt?: string; lastExitCode?: number;
  lastOutput?: string; failCount: number; fireCount: number; expiresAt?: string; createdAt: string; updatedAt: string;
};
export type AssistantDraft = {
  id: string; taskId?: string; channel: 'github_comment' | 'lark_reply'; target: string; body: string;
  state: 'pending' | 'sent' | 'failed' | 'discarded'; idempotencyKey: string; attempts: number;
  lastError?: string; createdBy?: string; createdAt: string; sentAt?: string;
};
/** 主会话在界面上的形象：认领回家的小猫。旧服务端没有这个字段。 */
export type AssistantCompanion = { name: string; adoptedAt: string };
export type AssistantReview = {
  id: string; taskId: string; verdict: 'accepted' | 'rework' | 'needs_user' | 'cancelled';
  checks: Array<{ criterion: string; met: boolean; evidence?: string }>; note?: string; createdAt: string;
};
export type AssistantState = {
  mainSessionId: string | null; mainSession: Session | null; companion?: AssistantCompanion | null;
  tasks: AssistantTask[]; watches: AssistantWatch[]; drafts: AssistantDraft[];
  /** 小猫的一生（代数、阶段、交接提议、整理轮次）。旧服务端没有这个字段。 */
  lifecycle?: AssistantLifecycleLight | null;
};

/* ---------- 小猫的一生：老化、整理轮次、交接仪式（见 docs/2026-11-12-companion-lifecycle-handoff-design.md） ---------- */
export type LifeStage = 'kitten' | 'adult' | 'senior' | 'elder';
export type LifecycleLevel = 'ok' | 'tidy' | 'handoff';
export type LifecycleMetricKey = 'rounds' | 'compactions' | 'events' | 'contextPercent' | 'openNotes' | 'closedNotes' | 'archivedNotes' | 'uptimeDays';
export type LifecycleReason = { metric: LifecycleMetricKey; level: LifecycleLevel; value: number; threshold: number };
export type LifecycleMetrics = { rounds: number; compactions: number; events: number; contextPercent?: number; openNotes: number; closedNotes: number; archivedNotes: number; uptimeDays: number; computedAt: string };
export type LifecycleThreshold = { tidy?: number; handoff?: number };
export type LifecycleConfig = { autoMaintenance: boolean; autoProposeHandoff: boolean; foldClosedAfterHours: number; maxAutoRunsPerDay: number; thresholds: Record<LifecycleMetricKey, LifecycleThreshold> };
export type LifecycleConfigPatch = { autoMaintenance?: boolean; autoProposeHandoff?: boolean; foldClosedAfterHours?: number; maxAutoRunsPerDay?: number; set?: Record<string, number | null> };
export type CatState = 'active' | 'retired' | 'released' | 'aborted';
export type CatRecord = {
  id: string; familyId: string; generation: number; sessionId: string; name: string; agentId?: string; model?: string; reasoningEffort?: string; cwd?: string;
  state: CatState; lifeStage: LifeStage; peakAgeScore: number; rounds: number; adoptedAt: string; retiredAt?: string; retiredReason?: string;
  predecessorId?: string; successorId?: string; handoffId?: string; createdAt: string; updatedAt: string;
};
export type HandoffState = 'proposed' | 'confirmed' | 'packing' | 'spawning' | 'transferring' | 'switching' | 'retiring' | 'briefing' | 'done' | 'rolling_back' | 'rolled_back' | 'cancelled';
export type HandoffOutcome = 'succeeded' | 'partial' | 'needs_confirmation';
export type HandoffSuccessorConfig = { agentId?: string; model?: string; reasoningEffort?: string };
export type HandoffSummary = {
  id: string; state: HandoffState; outcome: HandoffOutcome | null; trigger: 'user' | 'threshold' | 'agent'; reason: string | null; reasons: LifecycleReason[];
  fromSessionId: string; toSessionId: string | null; successorName: string | null; successorConfig?: HandoffSuccessorConfig | null;
  error: string | null; createdAt: string; confirmedAt: string | null; completedAt: string | null;
};
export type HandoffTransfer = { id: string; handoffId: string; kind: 'task' | 'watch' | 'draft'; itemId: string; title: string; status: 'transferred' | 'needs_confirmation' | 'failed' | 'reverted'; detail?: string; createdAt: string; updatedAt: string };
export type HandoffStepRecord = { step: string; at: string; ok: boolean; detail?: string };
export type HandoffPackageView = { successor: { name: string; generation: number }; predecessor: { generation: number; name: string; sessionId: string; lifeStage: LifeStage }; openTasks: Array<{ id: string; title: string }>; watches: Array<{ id: string; name: string }>; pendingDrafts: Array<{ id: string; target: string }>; closedNotes: { archived: number; batchId?: string } };
export type HandoffView = HandoffSummary & {
  steps: HandoffStepRecord[]; archiveBatchId: string | null; briefingTaskId: string | null; metrics: Partial<LifecycleMetrics>;
  fromCat: CatRecord | null; toCat: CatRecord | null; transfers: HandoffTransfer[]; package: HandoffPackageView | null;
};
/** 主会话托管时，飞书机器人要显示的当前小猫。 */
export type HandoverKitten = { isMain: true; name: string; generation: number; avatarUrl: string; catId: string; sessionId: string };
/** 同步机器人资料的结果；ok=false 时 message 是给用户看的手动处理说明。 */
export type HandoverBotProfile = {
  ok: boolean; supported: boolean; updated: boolean; name?: string; generation?: number; avatarUpdated?: boolean;
  reason?: string; message: string; appId?: string; chatId?: string;
};
export type ArchiveBatch = { id: string; source: 'handoff' | 'maintenance' | 'manual'; reason?: string; handoffId?: string; runId?: string; taskIds: string[]; createdAt: string; undoneAt?: string };
export type MaintenanceRun = {
  id: string; trigger: 'auto' | 'manual'; state: 'running' | 'completed' | 'failed' | 'interrupted'; reason?: string; reasons: LifecycleReason[];
  sessionId: string; catId?: string; runtimeTaskId?: string; summary?: string; error?: string; archiveBatchId?: string; createdAt: string; updatedAt: string; completedAt?: string;
  /** 这一轮折叠出来的归档批次（张数、是否已撤销）。 */
  batch?: { count: number; undoneAt?: string } | null;
};
export type AssistantLifecycleLight = {
  cat: { id: string; familyId: string; generation: number; name: string; lifeStage: LifeStage; peakAgeScore: number; rounds: number; adoptedAt: string; predecessor?: { name: string; generation: number; sessionId: string } } | null;
  level: LifecycleLevel;
  handoff: HandoffSummary | null;
  lastHandoff: HandoffSummary | null;
  maintenance: { id: string; trigger: 'auto' | 'manual'; createdAt: string; reasons: LifecycleReason[] } | null;
  ancestorSessionIds: string[];
};
export type AssistantLifecycle = {
  cat: (CatRecord & { stageLabel: string; ageScore: number; stageProgress: number }) | null;
  predecessor: CatRecord | null;
  metrics: LifecycleMetrics | null;
  levels: Record<LifecycleMetricKey, LifecycleLevel> | null;
  level: LifecycleLevel;
  reasons: LifecycleReason[];
  config: LifecycleConfig;
  policy: { maintenanceCooldownHours: number; handoffRemindHours: number | null; selfDescription: string } | null;
  handoff: HandoffView | null;
  handoffs: HandoffSummary[];
  maintenance: MaintenanceRun | null;
  maintenanceRuns: MaintenanceRun[];
  lineage: CatRecord[];
  ancestorSessionIds: string[];
};
/** `events` 只是一页（最近若干条）；总行数与是否被截断由 eventTotal / eventsTruncated 明说。 */
export type SessionRecord = { session: Session; tasks: Task[]; events: DockEvent[]; eventTotal?: number; eventsTruncated?: boolean };
/** 一轮事件的边界：startSequence 是这一轮的提问锚点，endSequence 是下一轮锚点（末轮为最大序号 + 1）。 */
export type TurnRange = { taskId: string; startSequence: number; endSequence: number; segments: number };
/** 一轮事件的一页。truncated 为真时用 nextAfter 继续取——限行数也限字节，两者谁先到谁生效。 */
export type TurnEventsPage = { taskId: string; after: number; before: number; events: DockEvent[]; nextAfter: number; truncated: boolean };
/** 平台拿模型能力的唯一来源：一个 Base URL + 一把 Key + 一种线格式 + 一个模型名。密钥不下发。 */
export type LlmFormatOption = { value: LlmFormat; label: string; baseUrlPlaceholder: string };
export type LlmEndpointState = {
  configured: boolean;
  format?: LlmFormat;
  baseUrl?: string;
  model?: string;
  auth?: LlmAuthType;
  /** 只报「有没有配密钥」——服务端永不回传密钥本身。 */
  apiKeySet?: boolean;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  formats: LlmFormatOption[];
  authTypes?: Array<{ value: LlmAuthType; label: string }>;
};
export type LlmRunResult = { format: LlmFormat; model: string; baseUrl: string; text: string; truncated?: boolean };
export const llmAssistModes = ['prompt_write', 'prompt_optimize', 'message_polish', 'title_generate', 'regex_generate', 'description_polish'] as const;
export type LlmAssistMode = (typeof llmAssistModes)[number];
export const llmAssistActions = ['write', 'optimize', 'concise', 'structure', 'generate'] as const;
export type LlmAssistAction = (typeof llmAssistActions)[number];
export type LlmAssistContext = {
  field?: string;
  purpose?: string;
  variables?: string[];
  cwd?: string;
  agentName?: string;
  model?: string;
  sessionTitle?: string;
  recentMessages?: Array<{ role?: string; text: string }>;
  botContext?: string;
  groupName?: string;
  sampleMessages?: string[];
  negativeSamples?: string[];
  boardName?: string;
  columnName?: string;
  cards?: string[];
  scheduleSummary?: string;
  maxChars?: number;
  extra?: string;
  [key: string]: unknown;
};
export type LlmAssistInput = {
  mode: LlmAssistMode;
  text?: string;
  instruction?: string;
  action?: LlmAssistAction;
  context?: LlmAssistContext;
  timeoutMs?: number;
};
export type LlmAssistResult = LlmRunResult & {
  mode: LlmAssistMode;
  pattern?: string;
  flags?: string;
  explanation?: string;
};
/** 从本机 Agent 配置探测到的候选端点；永远不含密钥。 */
export type DetectedLlmEndpoint = {
  id: string;
  source: 'claude-code' | 'codex' | 'openai';
  label: string;
  format: LlmFormat;
  baseUrl: string;
  model: string;
  auth?: LlmAuthType;
  keySet: boolean;
};
/** 本地 Web 访问门拒绝（401 凭证缺失/过期、403 会话 token 越权）。 */
export class WebAccessDeniedError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'WebAccessDeniedError'; }
}
const json = async <T,>(url: string, init?: RequestInit, quietDenied = false): Promise<T> => {
  const response = await fetch(url, init);
  const data = await response.json();
  if (response.status === 401 || response.status === 403) {
    const denied = new WebAccessDeniedError(response.status, data.error?.message ?? response.statusText);
    // SPA 壳本身公开、数据全走 API：任一查询被访问门拦下即通知 UI 渲染过期提示，避免各页面白屏。
    if (!quietDenied && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('agentdock:web-access-denied', { detail: denied }));
    throw denied;
  }
  // 带上状态码：调用方需要区分「接口不存在（服务端版本旧）」和普通失败，
  // 不能只靠错误文案猜。
  if (!response.ok) throw Object.assign(new Error(data.error?.message ?? response.statusText), { status: response.status });
  return data;
};
/**
 * 读一条 SSE 响应体。按事件块缓冲——一个 chunk 可能落在事件块中间，
 * 凑齐 `\n\n` 才解析，绝不能对半个 JSON 调 parse（与服务端 llm/sse.ts 同一套规则）。
 */
async function readEventStream(body: ReadableStream<Uint8Array>, onEvent: (event: string, data: unknown) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // stream:true 是必须的：一个汉字可能被切在两个 chunk 边界上。
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
          if (!clean || clean.startsWith(':')) continue;
          const colon = clean.indexOf(':');
          const field = colon < 0 ? clean : clean.slice(0, colon);
          const value = colon < 0 ? '' : clean.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = value;
          else if (field === 'data') data.push(value);
        }
        if (data.length) {
          try { onEvent(event, JSON.parse(data.join('\n'))); } catch { /* 坏掉的一条不该毁掉整段回答 */ }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally { reader.releaseLock(); }
}

export type SessionLarkBindingKind = 'handover' | 'lark-group' | 'lark-p2p';

export interface SessionLarkBinding {
  kind: SessionLarkBindingKind;
  appId: string;
  botName: string;
  chatId: string;
  chatType: 'group' | 'p2p';
  name: string;
  url?: string;
  turnSync?: LarkTurnSyncConfig;
  effectiveTurnSync: LarkTurnSyncConfig;
}

export interface SessionHandoverResponse {
  handover: { appId: string; botName: string; chatId: string; name: string; url: string; turnSync?: LarkTurnSyncConfig; effectiveTurnSync?: LarkTurnSyncConfig } | null;
  larkBinding?: SessionLarkBinding | null;
  kitten?: HandoverKitten | null;
}

export type NotificationEventKind = 'completed' | 'failed' | 'waiting_approval' | 'notify';
export type NotificationRuleEventKind = 'completed' | 'failed' | 'waiting_approval';
export type ScheduledNotifyMode = 'all' | 'failed_only' | 'off';
export type LarkNotifyTargetMode = 'auto_handover_then_fallback' | 'direct_user' | 'chat';
export type WebhookPreset = 'generic' | 'lark_webhook' | 'dingtalk' | 'wecom' | 'bark' | 'ntfy' | 'slack' | 'discord';

export interface NotificationWebhookHeader {
  key: string;
  value: string;
  masked?: boolean;
}

export interface NotificationWebhookConfig {
  id: string;
  name: string;
  enabled: boolean;
  preset: WebhookPreset;
  url: string;
  headers: NotificationWebhookHeader[];
  hasSecret?: boolean;
  /** 仅编辑/保存时填写：未改动时可传 '__AGENTDOCK_KEEP_SECRET__' 保留后端密文；空串表示清除。 */
  secret?: string;
  timeoutSec: number;
  events?: NotificationRuleEventKind[];
}

export interface NotificationServerConfig {
  enabled: boolean;
  events: {
    completed: boolean;
    failed: boolean;
    waitingApproval: boolean;
  };
  antiSpam: {
    minDurationSec: number;
    coalesceWindowMs: number;
    remoteOnlyWhenAway: boolean;
    awayAfterSec: number;
  };
  scopes: {
    normalSessions: boolean;
    assistantSubtasks: boolean;
    scheduledSessions: ScheduledNotifyMode;
  };
  lark: {
    enabled: boolean;
    appId?: string;
    mode: LarkNotifyTargetMode;
    fallbackReceiveId?: string;
    fallbackReceiveIdType: 'open_id' | 'chat_id';
    skipOriginalLarkChat: boolean;
    includeSummary: boolean;
  };
  webhooks: NotificationWebhookConfig[];
  commandHook: {
    enabled: boolean;
    command: string;
    timeoutSec: number;
    trustConfirmed: boolean;
  };
}

export interface NotificationChannelDeliveryStatus {
  ok: boolean;
  at: string;
  durationMs: number;
  statusCode?: number;
  detail?: string;
  error?: string;
}

export interface NotificationConfigState {
  configured: boolean;
  config: NotificationServerConfig;
  lastDelivery: Record<string, NotificationChannelDeliveryStatus>;
}

export interface NotificationTestResult {
  channel: string;
  ok: boolean;
  durationMs: number;
  statusCode?: number;
  detail?: string;
  error?: string;
  consoleUrl?: string;
}

export interface NotificationStreamPayload {
  id: string;
  kind: NotificationEventKind;
  sessionId: string;
  taskId?: string;
  agentId: string;
  sessionTitle: string;
  sessionSource?: string;
  sessionSourceId?: string;
  durationMs?: number;
  summary: string;
  error?: string;
  urgent?: boolean;
  ask?: boolean;
  batchCount?: number;
  sessionUrl?: string;
  timestamp: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  costUsd: number;
  turnCount: number;
  sessionCount: number;
  totalGenerationMs: number;
  totalDurationMs: number;
  avgTps: number | null;
  lastTps?: number | null;
}

export interface UsageDailyPoint {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  costUsd: number;
  turnCount: number;
  avgTps: number | null;
}

export interface UsageSummary {
  from?: string;
  to?: string;
  totals: UsageTotals;
  daily: UsageDailyPoint[];
}

export type UsageBreakdownGroup = 'project' | 'agent' | 'session' | 'model';

export interface UsageBreakdownItem {
  key: string;
  label: string;
  sublabel?: string;
  agentId?: string;
  cwd?: string;
  sessionId?: string;
  model?: string;
  lastActiveAt?: string;
  totals: UsageTotals;
}

export interface UsageBreakdown {
  groupBy: UsageBreakdownGroup;
  from?: string;
  to?: string;
  items: UsageBreakdownItem[];
}

export interface SessionUsageTurn {
  id: string;
  taskId?: string | null;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  costUsd?: number | null;
  durationMs?: number | null;
  generationMs?: number | null;
  ttftMs?: number | null;
  tps: number | null;
  createdAt: string;
}

export interface SessionUsageDetail {
  sessionId: string;
  agentId?: string;
  cwd?: string;
  model?: string | null;
  totals: UsageTotals;
  turns: SessionUsageTurn[];
}

export interface UsageQueryParams {
  from?: string;
  to?: string;
  agentId?: string;
  project?: string;
  sessionId?: string;
  model?: string;
  limit?: number;
}

const buildUsageQuery = (params?: UsageQueryParams, extra?: Record<string, string | undefined>) => {
  const qs = new URLSearchParams();
  if (params?.from) qs.set('from', params.from);
  if (params?.to) qs.set('to', params.to);
  if (params?.agentId) qs.set('agentId', params.agentId);
  if (params?.project) qs.set('project', params.project);
  if (params?.sessionId) qs.set('sessionId', params.sessionId);
  if (params?.model) qs.set('model', params.model);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v) qs.set(k, v);
    }
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
};

const agentModelsUrl = (id: string, model?: string, refresh = false, sshHost?: string) => {  const query = new URLSearchParams();
  if (model) query.set('model', model);
  if (refresh) query.set('refresh', '1');
  if (sshHost) query.set('sshHost', sshHost);
  const suffix = query.toString();
  return `/api/agents/${id}/models${suffix ? `?${suffix}` : ''}`;
};
const buildQuotaQuery = (params: UsageQuotaParams) => {
  const qs = new URLSearchParams();
  qs.set('agentId', params.agentId);
  if (params.model) qs.set('model', params.model);
  if (params.sessionId) qs.set('sessionId', params.sessionId);
  if (params.source && params.source !== 'auto') qs.set('source', params.source);
  if (params.refresh) qs.set('refresh', '1');
  return `?${qs.toString()}`;
};
export const api = {
  codexUsage: (refresh = false) => json<CodexUsage>(`/api/codex/usage${refresh ? '?refresh=1' : ''}`, undefined, true),
  claudeUsage: (refresh = false) => json<AgentUsage>(`/api/claude/usage${refresh ? '?refresh=1' : ''}`, undefined, true),
  cursorUsage: (refresh = false) => json<AgentUsage>(`/api/cursor/usage${refresh ? '?refresh=1' : ''}`, undefined, true),
  antigravityUsage: (refresh = false) => json<AgentUsage>(`/api/antigravity/usage${refresh ? '?refresh=1' : ''}`, undefined, true),
  agentQuota: (params: UsageQuotaParams) => json<AgentUsage>(`/api/usage/quota${buildQuotaQuery(params)}`, undefined, true),
  usageSummary: (params?: UsageQueryParams) => json<UsageSummary>(`/api/usage/summary${buildUsageQuery(params)}`, undefined, true),
  usageBreakdown: (groupBy: UsageBreakdownGroup, params?: UsageQueryParams) => json<UsageBreakdown>(`/api/usage/breakdown${buildUsageQuery(params, { groupBy })}`, undefined, true),
  sessionUsage: (sessionId: string) => json<SessionUsageDetail>(`/api/sessions/${encodeURIComponent(sessionId)}/usage`, undefined, true),
  agents: (includeDisabled = false) => json<Agent[]>(`/api/agents${includeDisabled ? '?includeDisabled=1' : ''}`),
  createAgent: (body: unknown) => json<Agent>('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  updateAgent: (id: string, body: unknown) => json<Agent>(`/api/agents/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  deleteAgent: (id: string) => json<{ disabled: boolean }>(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** 启用/停用。不能走 updateAgent——那条接口有意忽略 disabled，停用了就启不回来。 */
  setAgentDisabled: (id: string, disabled: boolean) => json<Agent>(`/api/agents/${encodeURIComponent(id)}/disabled`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ disabled }) }),
  externalSessions: (agentId: string, options: { cursor?: string; cwd?: string; sshHost?: string } = {}) => { const query = new URLSearchParams(); if (options.cursor) query.set('cursor', options.cursor); if (options.cwd) query.set('cwd', options.cwd); if (options.sshHost) query.set('sshHost', options.sshHost); const suffix = query.size ? `?${query.toString()}` : ''; return json<ExternalSessionsResult>(`/api/agents/${encodeURIComponent(agentId)}/external-sessions${suffix}`); },
  sshHosts: () => json<SshHostsResult>('/api/ssh/hosts'),
  probeSshHost: (host: string) => json<SshProbeResult>('/api/ssh/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host }) }),
  llm: () => json<LlmEndpointState>('/api/llm'),
  /** apiKey 留空表示沿用已存的那把——只改模型名时不必重新粘贴密钥。 */
  saveLlm: (body: { format: LlmFormat; baseUrl: string; model: string; apiKey?: string; auth?: LlmAuthType; systemPrompt?: string; maxTokens?: number; timeoutMs?: number }) => json<LlmEndpointState>('/api/llm', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  clearLlm: () => json<LlmEndpointState>('/api/llm', { method: 'DELETE' }),
  /** 全站统一的结构化 AI 文本辅助接口（写/优化 Prompt、润色消息、自动标题、生成正则、优化描述）。 */
  assistLlm: (body: LlmAssistInput, options: { signal?: AbortSignal } = {}) => json<LlmAssistResult>('/api/llm/assist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(options.signal ? { signal: options.signal } : {}) }, true),
  /** 平台功能的一次性补全；prompt 由功能自己构造。 */
  completeLlm: (prompt: string, timeoutMs?: number, options: { signal?: AbortSignal } = {}) => json<LlmRunResult>('/api/llm/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, ...(timeoutMs ? { timeoutMs } : {}) }), ...(options.signal ? { signal: options.signal } : {}) }, true),
  detectLlm: () => json<{ candidates: DetectedLlmEndpoint[] }>('/api/llm/detect', undefined, true),
  /** 应用探测到的端点；密钥不经过浏览器。 */
  applyDetectedLlm: (id: string) => json<LlmEndpointState>('/api/llm/detect/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }, true),
  testLlm: (prompt?: string) => json<LlmRunResult>('/api/llm/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(prompt ? { prompt } : {}) }),
  /**
   * 流式试跑。不能用 EventSource（它只支持 GET，而这里要带 prompt），用 fetch + 手动读流。
   * 帧格式与服务端的会话流一致：event: delta / done / failed。返回一个中止函数。
   */
  testLlmStream: (handlers: { onDelta(text: string): void; onDone(result: LlmRunResult): void; onFailed(error: { code: string; message: string }): void }, prompt?: string) => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/llm/test/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(prompt ? { prompt } : {}),
          signal: controller.signal
        });
        if (!response.ok || !response.body) {
          // 走到这里说明连流都没开起来（访问门拒绝、路由不存在），按失败处理。
          const data = await response.json().catch(() => ({}));
          handlers.onFailed({ code: data.error?.code ?? 'LLM_STREAM_FAILED', message: data.error?.message ?? response.statusText });
          return;
        }
        await readEventStream(response.body, (event, data) => {
          if (event === 'delta') handlers.onDelta(String((data as { text?: string })?.text ?? ''));
          else if (event === 'done') handlers.onDone(data as LlmRunResult);
          else if (event === 'failed') handlers.onFailed(data as { code: string; message: string });
        });
      } catch (error) {
        // 用户主动中止不算失败。
        if (!controller.signal.aborted) handlers.onFailed({ code: 'LLM_STREAM_FAILED', message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => controller.abort();
  },
  agentModels: (id: string, model?: string, refresh = false, sshHost?: string) => json<AgentModelsResult>(agentModelsUrl(id, model, refresh, sshHost)), sessions: () => json<Session[]>('/api/sessions'), projects: () => json<Project[]>('/api/projects'), importProject: (path: string) => json<RegisterProjectResult>('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) }), setProjectPinned: (cwd: string, pinned: boolean) => json<Project>('/api/projects/pin', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd, pinned }) }), setSessionPinned: (id: string, pinned: boolean) => json<Session>(`/api/sessions/${id}/pin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned }) }), events: (id: string, after?: number) => json<DockEvent[]>(`/api/sessions/${id}/events?compact=thinking${after ? `&after=${after}` : ''}`), rawEvents: (id: string, before?: number) => json<DockEvent[]>(`/api/sessions/${id}/events?limit=200${before ? `&before=${before}` : ''}`), tasks: (id: string) => json<Task[]>(`/api/sessions/${id}/tasks`), sessionRecord: (id: string) => json<SessionRecord>(`/api/sessions/${id}/record`),
  /** 轮次锚点图：只回边界与过程条数，不回事件体。面板整个生命周期只请求一次。 */
  sessionTurns: (id: string) => json<{ turns: TurnRange[] }>(`/api/sessions/${id}/turns`),
  /** 单轮事件体（已合并分片）。带上 after/before 可以免掉服务端那一次锚点扫描。 */
  turnEvents: (id: string, taskId: string, range: { after: number; before?: number; limit?: number }) => {
    const query = new URLSearchParams({ after: String(range.after) });
    if (range.before !== undefined) query.set('before', String(range.before));
    if (range.limit !== undefined) query.set('limit', String(range.limit));
    return json<TurnEventsPage>(`/api/sessions/${id}/turns/${encodeURIComponent(taskId)}/events?${query}`);
  },
  // quietDenied：会话 token 没有升级权限，查不到就不显示入口，不能把整页打成「访问被拒」。
  selfUpdateStatus: (refresh = false) => json<SelfUpdateStatus>(`/api/system/update${refresh ? '?refresh=1' : ''}`, undefined, true),
  startSelfUpdate: () => json<SelfUpdateStatus>('/api/system/update', { method: 'POST' }),
  /** 扫码链接（控制台级）。quietDenied：普通会话令牌没有生成新令牌的权限，不能把整页打成「访问被拒」。 */
  shareLink: (sessionId?: string) => json<ShareLinkResult>(`/api/system/share-link${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`, undefined, true),
  saveShareSettings: (publicUrl: string) => json<ShareSettings>('/api/system/share-settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicUrl }) }),
  create: (body: any) => json<Session>('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  importSession: (body: { agentId: string; externalSessionId: string; cwd?: string; mode?: 'full' | 'session'; model?: string; reasoningEffort?: string; sshHost?: string }) => json<Session>('/api/sessions/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  /**
   * clientMessageId 由「一次用户提交」生成，不在重试时换新：网络层把 POST 原样重放时
   * 服务端凭它认出是同一轮，返回同一个 task，而不是再跑一轮。
   */
  send: (id: string, prompt: string, mode: 'queue' | 'interrupt' = 'queue', origin?: string, clientMessageId?: string) => json<{ accepted: true; task: Task }>(`/api/sessions/${id}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, mode, ...(origin ? { origin } : {}), ...(clientMessageId ? { clientMessageId } : {}) }) }),
  setSessionModel: (id: string, model: string) => json<Session & { discoveredModels?: AgentModelsResult }>(`/api/sessions/${id}/config`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) }),
  setSessionReasoningEffort: (id: string, reasoningEffort: string) => json<Session & { discoveredModels?: AgentModelsResult }>(`/api/sessions/${id}/config`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reasoningEffort }) }),
  // 传 null 表示恢复跟随全局默认；纯元数据极速切换，不触发 CLI 冷启动。
  setSessionAskUserQuestionEnabled: (id: string, askUserQuestionEnabled: boolean | null) => json<Session>(`/api/sessions/${id}/config`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ askUserQuestionEnabled }) }),
  setSessionOutputPlugins: (id: string, outputPlugins: Record<string, boolean | null>) => json<Session>(`/api/sessions/${id}/config`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outputPlugins }) }),
  // 传 null / 空串表示「恢复自动命名」，由服务端回落到 Agent 名或首条 prompt 摘要。
  setSessionTitle: (id: string, title: string | null) => json<Session>(`/api/sessions/${id}/title`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) }),
  cancelQueued: (id: string, taskId: string) => json<Task>(`/api/sessions/${id}/queue/${taskId}`, { method: 'DELETE' }),
  updateQueued: (id: string, taskId: string, prompt: string) => json<Task>(`/api/sessions/${id}/queue/${taskId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) }),
  steerQueued: (id: string, taskId: string) => json<Task>(`/api/sessions/${id}/queue/${taskId}/steer`, { method: 'POST' }),
  larkConfig: () => json<LarkConfig>('/api/lark/config'),
  inspectLarkBot: (body: { appId: string; appSecret: string }) => json<{ appName: string; openId: string; avatarUrl?: string; activateStatus?: number }>('/api/lark/bot/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  saveLarkConfig: (body: { stage: 'lark' | 'agent'; originalAppId?: string; appId?: string; appSecret?: string; workspace?: string; webBaseUrl?: string; defaultAgentId?: string; defaultModel?: string; defaultReasoningEffort?: string; preInjectPrompt?: string; listening?: boolean; groupToolsEnabled?: boolean; groupToolsAllowSend?: boolean; groupSessionScope?: 'user' | 'chat'; pushIntervalMs?: number; traceLimit?: number | null; quietReply?: boolean; turnSync?: LarkTurnSyncConfigInput; allowedUsers?: LarkAllowedUser[]; allowedUserNames?: string[]; allowedEmails?: string[]; allowedBots?: LarkAllowedUser[]; allowedBotNames?: string[]; peerBotsAllowed?: boolean; highRiskAllowedUsers?: LarkAllowedUser[]; highRiskAllowedUserNames?: string[]; highRiskAllowedEmails?: string[]; highRiskPattern?: string; gateEnabled?: boolean; softGateEnabled?: boolean; hardGateEnabled?: boolean; hookTrustConfirmed?: boolean }) => json<LarkConfig>('/api/lark/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  deleteLarkConfig: (appId: string) => json<LarkConfig>(`/api/lark/config/${encodeURIComponent(appId)}`, { method: 'DELETE' }),
  larkHookStatus: (appId: string) => json<LarkHookStatus>(`/api/lark/hooks/status?appId=${encodeURIComponent(appId)}`),
  installLarkHook: (appId: string, highRiskPattern: string) => json<LarkHookStatus>('/api/lark/hooks/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId, highRiskPattern }) }),
  larkAvatarStatus: () => json<LarkAvatarStatus>('/api/lark-avatar/status'),
  larkAvatarConfig: () => json<LarkAvatarConfigRecord | null>('/api/lark-avatar/config'),
  larkAvatarChats: () => json<LarkAvatarChatSummary[]>('/api/lark-avatar/chats'),
  // 排障页每 10 秒轮询一次；明确禁用 HTTP 缓存，手动刷新才能拿到新账本。
  larkAvatarReactionDiagnostics: (limit = 10) => json<LarkAvatarReactionDiagnostics>(`/api/lark-avatar/reaction-diagnostics?limit=${Math.min(100, Math.max(1, Math.floor(limit)))}`, { cache: 'no-store' }),
  saveLarkAvatarConfig: (body: { region?: LarkAvatarRegion; triggerPrefix?: string; contextMessages?: number; contextScope?: 'anchor' | 'chat'; replyInTopic?: boolean; replyMode?: 'direct' | 'quote' | 'thread'; replyForwardMode?: LarkAvatarReplyForwardMode; emojiReactions?: boolean; reactionTriggerEnabled?: boolean; reactionTriggerEmoji?: string; reactionTriggerRoute?: LarkAvatarReactionRoute; reactionTriggerIgnoreBots?: boolean; replySignature?: string; agentTimeoutSeconds?: number; listening?: boolean; listenChats?: string[]; inboxMaxItems?: number; inboxCleanupWarnThreshold?: number; allowedSenders?: string[]; agentId?: string; model?: string; reasoningEffort?: string; workspace?: string }) => json<LarkAvatarConfigRecord>('/api/lark-avatar/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  startLarkAvatarLogin: (region: LarkAvatarRegion) => json<LarkAvatarLoginSnapshot>('/api/lark-avatar/login/qr', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ region }) }),
  larkAvatarLoginStatus: () => json<LarkAvatarLoginSnapshot>('/api/lark-avatar/login/status'),
  pollLarkAvatarLogin: () => json<LarkAvatarLoginSnapshot>('/api/lark-avatar/login/poll', { method: 'POST' }),
  cancelLarkAvatarLogin: () => json<LarkAvatarLoginSnapshot>('/api/lark-avatar/login', { method: 'DELETE' }),
  importLarkAvatarCookie: (body: { cookie: string; region: LarkAvatarRegion }) => json<{ connected: boolean; account?: LarkAvatarAccount }>('/api/lark-avatar/login/cookie', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  disconnectLarkAvatar: () => json<{ ok: boolean }>('/api/lark-avatar/disconnect', { method: 'POST' }),
  pollLarkAvatar: () => json<{ created: number; dispatched: number }>('/api/lark-avatar/poll', { method: 'POST' }),
  setLarkAvatarListening: (enabled: boolean) => json<{ ok: boolean; listening: boolean }>('/api/lark-avatar/listening', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) }),
  larkAvatarInbox: (query: { state?: string; tier?: string; limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (query.state) search.set('state', query.state);
    if (query.tier) search.set('tier', query.tier);
    if (query.limit && query.limit > 0) search.set('limit', String(Math.floor(query.limit)));
    return json<LarkAvatarInboxItem[]>(`/api/lark-avatar/inbox?${search}`);
  },
  cleanupLarkAvatarInbox: (body: { keepLatest?: number } = {}) => json<LarkAvatarCleanupResult>('/api/lark-avatar/inbox/cleanup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  larkAvatarDrafts: (state?: string) => json<LarkAvatarDraft[]>(`/api/lark-avatar/drafts${state ? `?state=${encodeURIComponent(state)}` : ''}`),
  draftLarkAvatarInboxItem: (id: string, regenerate = false) => json<LarkAvatarDraft>(`/api/lark-avatar/inbox/${encodeURIComponent(id)}/draft`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ regenerate }) }),
  createLarkAvatarDraft: (body: { itemId?: string; target?: string; body?: string; threadKey?: string; replyRootId?: string }) => json<LarkAvatarDraft>('/api/lark-avatar/drafts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  updateLarkAvatarDraft: (id: string, body: string) => json<LarkAvatarDraft>(`/api/lark-avatar/drafts/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) }),
  sendLarkAvatarDraft: (id: string, body?: string) => json<LarkAvatarDraft>(`/api/lark-avatar/drafts/${encodeURIComponent(id)}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body === undefined ? {} : { body }) }),
  discardLarkAvatarDraft: (id: string) => json<LarkAvatarDraft>(`/api/lark-avatar/drafts/${encodeURIComponent(id)}/discard`, { method: 'POST' }),
  // quietDenied：飞书卡片打开的会话级令牌没有主会话权限，查不到就不显示小猫，不能把整页打成「访问被拒」。
  assistantState: () => json<AssistantState>('/api/assistant/state', undefined, true),
  assistantSetMain: (body: { sessionId?: string; agentId?: string; cwd?: string; model?: string; reasoningEffort?: string; name?: string }) => json<{ session: Session; companion?: AssistantCompanion | null }>('/api/assistant/main', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  assistantRenameCompanion: (name: string) => json<{ companion: AssistantCompanion }>('/api/assistant/companion', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }),
  assistantTask: (id: string) => json<{ task: AssistantTask; reviews?: AssistantReview[] }>(`/api/assistant/tasks/${encodeURIComponent(id)}`, undefined, true),
  assistantClearMain: () => json<{ ok: boolean }>('/api/assistant/main', { method: 'DELETE' }),
  assistantStartTask: (body: { title: string; notes?: string; doneWhen: string[]; expectMinutes?: number; agentId?: string; cwd?: string; model?: string; plan?: boolean }) => json<{ task: AssistantTask }>('/api/assistant/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  assistantStartPlanned: (id: string) => json<{ task: AssistantTask }>(`/api/assistant/tasks/${encodeURIComponent(id)}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  assistantReviewTask: (id: string, body: { verdict: 'accepted' | 'rework' | 'needs_user' | 'cancelled'; checks?: Array<{ criterion: string; met: boolean; evidence?: string }>; note?: string }) => json<{ task: AssistantTask }>(`/api/assistant/tasks/${encodeURIComponent(id)}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  assistantCancelTask: (id: string, reason?: string) => json<{ task: AssistantTask }>(`/api/assistant/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) }),
  assistantAddWatch: (body: { name: string; command: string; cwd?: string; every?: string; timeout?: string; mode?: 'once' | 'repeat'; cooldown?: string; expires?: string }) => json<{ watch: AssistantWatch }>('/api/assistant/watches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  assistantWatchAction: (id: string, action: 'pause' | 'resume' | 'run') => json<{ watch: AssistantWatch }>(`/api/assistant/watches/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  assistantRemoveWatch: (id: string) => json<{ deleted: boolean; id: string }>(`/api/assistant/watches/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  assistantCreateDraft: (body: { channel: 'github_comment' | 'lark_reply'; target: string; body: string; taskId?: string }) => json<{ draft: AssistantDraft }>('/api/assistant/drafts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  assistantSendDraft: (id: string) => json<{ draft: AssistantDraft }>(`/api/assistant/drafts/${encodeURIComponent(id)}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  assistantDiscardDraft: (id: string) => json<{ draft: AssistantDraft }>(`/api/assistant/drafts/${encodeURIComponent(id)}/discard`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  assistantNotify: (body: { text: string; ask?: boolean; urgent?: boolean }) => json<{ id: string; sent?: boolean }>('/api/assistant/notify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  assistantLifecycle: () => json<AssistantLifecycle>('/api/assistant/lifecycle', undefined, true),
  assistantHandoff: (id: string) => json<{ handoff: HandoffView }>(`/api/assistant/handoff/${encodeURIComponent(id)}`),
  assistantProposeHandoff: (body: { reason?: string; name?: string; agentId?: string; model?: string; reasoningEffort?: string } = {}) => json<{ handoff: HandoffView }>('/api/assistant/handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  /** 网页调用不带 from：确认只能由用户本人做，服务端对带 from 的确认一律 403。 */
  assistantConfirmHandoff: (id: string, body: { name?: string; agentId?: string; model?: string; reasoningEffort?: string } = {}) => json<{ handoff: HandoffView }>(`/api/assistant/handoff/${encodeURIComponent(id)}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  assistantCancelHandoff: (id: string) => json<{ handoff: HandoffView }>(`/api/assistant/handoff/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  assistantResendHandoff: (id: string) => json<{ handoff: HandoffView }>(`/api/assistant/handoff/${encodeURIComponent(id)}/resend`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  assistantRunMaintenance: (body: { reason?: string } = {}) => json<{ run: MaintenanceRun }>('/api/assistant/maintenance/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  assistantSaveLifecycleConfig: (patch: LifecycleConfigPatch) => json<{ config: LifecycleConfig }>('/api/assistant/maintenance/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
  assistantNotesArchive: () => json<{ batches: ArchiveBatch[]; tasks: AssistantTask[] }>('/api/assistant/notes/archive', undefined, true),
  assistantArchiveNotes: (body: { taskIds?: string[]; closedBeforeHours?: number; reason?: string }) => json<{ batch: ArchiveBatch | null; archived: number }>('/api/assistant/notes/archive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  assistantUnarchiveNotes: (body: { batchId?: string; taskIds?: string[] }) => json<{ restored: string[]; batch?: ArchiveBatch }>('/api/assistant/notes/unarchive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  /** 旧版本误归档主会话后的恢复：解除归档并重新启动。 */
  assistantRestoreMain: (sessionId?: string) => json<{ session: Session; restored: boolean }>('/api/assistant/main/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sessionId ? { sessionId } : {}) }),
  // 登录接口不走 json()：密码错误是普通失败，不能触发全局「访问被拒」事件。
  authStatus: async (): Promise<{ passwordEnabled: boolean }> => {
    const response = await fetch('/api/auth/status');
    if (!response.ok) return { passwordEnabled: false };
    return response.json();
  },
  login: async (password: string): Promise<void> => {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    if (response.ok) return;
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error?.message ?? '登录失败');
  },
  autostartStatus: () => json<AutostartStatus>('/api/system/autostart', undefined, true),
  setAutostart: (enabled: boolean) => json<AutostartStatus>('/api/system/autostart', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) }),
  keepAwakeStatus: () => json<KeepAwakeStatus>('/api/system/keep-awake', undefined, true),
  setKeepAwake: (body: { enabled?: boolean; keepDisplay?: boolean }) => json<KeepAwakeStatus>('/api/system/keep-awake', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  sideChatConfig: () => json<SideChatConfigState>('/api/side-chat/config', undefined, true),
  saveSideChatConfig: (body: SideChatConfig) => json<SideChatConfigState>('/api/side-chat/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  resetSideChatConfig: () => json<SideChatConfigState>('/api/side-chat/config', { method: 'DELETE' }),
  outputPlugins: () => json<OutputPluginsCatalogSnapshot>('/api/output-plugins', undefined, true),
  saveOutputPluginsConfig: (plugins: Record<string, boolean>) => json<OutputPluginsCatalogSnapshot>('/api/output-plugins/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugins }) }),
  reloadOutputPlugins: () => json<OutputPluginsCatalogSnapshot>('/api/output-plugins/reload', { method: 'POST' }),
  interactOutputPlugin: async (
    sessionId: string,
    pluginId: string,
    body: {
      instanceId: string;
      title?: string;
      answers?: AskUserQuestionAnswerItem[];
      decision?: ConfirmActionDecision;
      decisionLabel?: string;
      risk?: ConfirmActionRisk;
      comment?: string;
      actionValue?: string;
      actionLabel?: string;
      fields?: DeclarativeInteractionField[];
      note?: string;
      mode?: 'queue' | 'interrupt';
      clientMessageId?: string;
    }
  ): Promise<
    | { accepted: true; pluginId: string; instanceId: string; payload: unknown; task: Task & { queuedAhead?: number } }
    | { alreadySubmitted: true; existing: unknown }
  > => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/output-plugins/${encodeURIComponent(pluginId)}/interact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 409 && (data?.alreadySubmitted || data?.alreadyAnswered) && data?.existing) {
      return { alreadySubmitted: true, existing: data.existing };
    }
    if (!response.ok) {
      throw new Error(data?.error?.message ?? `交互提交失败（HTTP ${response.status}）`);
    }
    return data as { accepted: true; pluginId: string; instanceId: string; payload: unknown; task: Task & { queuedAhead?: number } };
  },
  askUserQuestionConfig: () => json<{ configured: boolean; config: AskUserQuestionConfig }>('/api/ask-user-question/config', undefined, true),
  saveAskUserQuestionConfig: (body: AskUserQuestionConfig) => json<{ configured: boolean; config: AskUserQuestionConfig }>('/api/ask-user-question/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  answerAskUserQuestion: async (
    sessionId: string,
    body: {
      questionId: string;
      title?: string;
      answers: AskUserQuestionAnswerItem[];
      mode?: 'queue' | 'interrupt';
      clientMessageId?: string;
    }
  ): Promise<
    | { accepted: true; payload: AskUserQuestionAnswerPayload; task: Task & { queuedAhead?: number } }
    | { alreadyAnswered: true; existing: AskUserQuestionAnswerPayload }
  > => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/ask-user-question/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 409 && data?.alreadyAnswered && data?.existing) {
      return { alreadyAnswered: true, existing: data.existing as AskUserQuestionAnswerPayload };
    }
    if (!response.ok) {
      throw new Error(data?.error?.message ?? `提交回答失败（HTTP ${response.status}）`);
    }
    return data as { accepted: true; payload: AskUserQuestionAnswerPayload; task: Task & { queuedAhead?: number } };
  },
  notificationsConfig: () => json<NotificationConfigState>('/api/notifications/config', undefined, true),
  saveNotificationsConfig: (body: NotificationServerConfig) => json<NotificationConfigState>('/api/notifications/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  testNotificationChannel: (body: { channel: 'lark' | 'webhook' | 'command'; webhookId?: string; draftConfig?: NotificationServerConfig }) => json<NotificationTestResult>('/api/notifications/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  reportNotificationPresence: (body: { clientId: string; focused: boolean; activeSessionId?: string }) => fetch('/api/notifications/presence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(() => undefined),
  larkBotChats: (appId: string, options?: { all?: boolean; refresh?: boolean; pageToken?: string }) => {
    const query = new URLSearchParams();
    if (options?.all) query.set('all', '1');
    if (options?.refresh) query.set('refresh', '1');
    if (options?.pageToken) query.set('pageToken', options.pageToken);
    const qs = query.toString();
    return json<{ items: LarkBotChatItem[]; hasMore: boolean; pageToken?: string }>(`/api/lark/bots/${encodeURIComponent(appId)}/chats${qs ? `?${qs}` : ''}`);
  },
  larkBotChatMessages: (appId: string, chatId: string, options?: { limit?: number; pageToken?: string; ruleId?: string }) => {
    const query = new URLSearchParams();
    if (options?.limit) query.set('limit', String(options.limit));
    if (options?.pageToken) query.set('pageToken', options.pageToken);
    if (options?.ruleId) query.set('ruleId', options.ruleId);
    const qs = query.toString();
    return json<LarkChatMessagesPreviewResponse>(`/api/lark/bots/${encodeURIComponent(appId)}/chats/${encodeURIComponent(chatId)}/messages${qs ? `?${qs}` : ''}`);
  },
  larkRegexTriggers: () => json<LarkRegexTriggersResponse>('/api/lark/regex-triggers'),
  createLarkRegexTrigger: (body: SaveLarkRegexTriggerBody) => json<{ rule: LarkRegexTriggerRule }>('/api/lark/regex-triggers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  updateLarkRegexTrigger: (id: string, body: SaveLarkRegexTriggerBody) => json<{ rule: LarkRegexTriggerRule }>(`/api/lark/regex-triggers/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  deleteLarkRegexTrigger: (id: string) => json<{ deleted: boolean; id: string }>(`/api/lark/regex-triggers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  previewLarkRegexTrigger: (body: { pattern: string; flags?: string; ignoreBotMessages?: boolean; messages?: Array<{ messageId: string; text: string; senderType?: string }>; botId?: string; chatId?: string; limit?: number }, options?: { signal?: AbortSignal }) =>
    json<LarkRegexPreviewResponse>('/api/lark/regex-triggers/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(options?.signal ? { signal: options.signal } : {}) }),
  backfillLarkRegexTrigger: (body: { ruleId?: string; ruleName?: string; botId: string; chatId: string; chatName?: string; pattern: string; flags?: string; replyMode: LarkRegexReplyMode; promptTemplate?: string; ignoreBotMessages?: boolean; force?: boolean; messages: Array<{ messageId: string; text: string; senderId?: string; senderName?: string; senderType?: string; threadId?: string; rootId?: string; parentId?: string; msgType?: string; createTime?: string; createdAt?: string }> }) =>
    json<LarkRegexBackfillResponse>('/api/lark/regex-triggers/backfill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  systemCapabilities: () => json<{ platform: string; directoryPicker: boolean; filePicker: boolean; workingDirectory: string; homeDirectory: string }>('/api/system/capabilities'),
  skills: (cwd?: string) => json<SkillReference[]>(`/api/system/skills${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  selectDirectory: () => json<{ path: string }>('/api/system/select-directory', { method: 'POST' }),
  selectFile: () => json<{ path: string }>('/api/system/select-file', { method: 'POST' }),
  archive: (id: string) => json<Session>(`/api/sessions/${id}/archive`, { method: 'POST' }),
  schedules: (sessionId?: string) => json<Schedule[]>(`/api/schedules${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`),
  scheduleRuns: (id: string) => json<ScheduleRun[]>(`/api/schedules/${encodeURIComponent(id)}/runs?limit=20`),
  recentScheduleRuns: (sessionId?: string) => json<ScheduleRun[]>(`/api/schedule-runs?limit=60${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`),
  createSchedule: (body: CreateScheduleInput) => json<Schedule>('/api/schedules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  updateSchedule: (id: string, body: UpdateScheduleInput) => json<Schedule>(`/api/schedules/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  pauseSchedule: (id: string) => json<Schedule>(`/api/schedules/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
  resumeSchedule: (id: string) => json<Schedule>(`/api/schedules/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
  runSchedule: (id: string) => json<ScheduleRun>(`/api/schedules/${encodeURIComponent(id)}/run`, { method: 'POST' }),
  deleteSchedule: (id: string) => json<{ deleted: boolean; id: string }>(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  syncExternal: (id: string) => json<{ added: number; skipped: number }>(`/api/sessions/${id}/sync-external`, { method: 'POST' }),
  larkUserProfiles: (appId: string, openIds: string[]) => json<{ users: { openId: string; name: string; avatarUrl?: string }[] }>(`/api/lark/user-profiles?appId=${encodeURIComponent(appId)}&openIds=${encodeURIComponent(openIds.join(','))}`),
  larkAppOwner: (appId: string) => json<{ owner: { openId: string; name: string; ownerType?: string; avatarUrl?: string } | null }>(`/api/lark/app-owner?appId=${encodeURIComponent(appId)}`),
  larkMemberSearch: (appId: string, q: string) => json<{ users: { openId: string; name: string }[]; error?: string }>(`/api/lark/member-search?appId=${encodeURIComponent(appId)}&q=${encodeURIComponent(q)}`),
  larkChatMembers: (appId: string, chatId: string) => json<{ users: { openId: string; name: string }[] }>(`/api/lark/chat-members?appId=${encodeURIComponent(appId)}&chatId=${encodeURIComponent(chatId)}`),
  sessionHandover: (id: string) => json<SessionHandoverResponse>(`/api/sessions/${id}/handover`),
  handoverSession: (id: string, body: { appId: string; name?: string; memberOpenIds?: string[]; syncBotProfile?: boolean; turnSync?: LarkTurnSyncConfigInput }) => json<{ sessionId: string; appId: string; chatId: string; name: string; url: string; turnSync?: LarkTurnSyncConfig; effectiveTurnSync?: LarkTurnSyncConfig; kitten?: HandoverKitten | null; botProfile?: HandoverBotProfile | null }>(`/api/sessions/${id}/handover`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  updateSessionHandover: (id: string, body: { turnSync?: LarkTurnSyncConfigInput | null }) => json<SessionHandoverResponse>(`/api/sessions/${id}/handover`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  handoverSyncBot: (sessionId?: string) => json<HandoverBotProfile>('/api/lark/handover/sync-bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sessionId ? { sessionId } : {}) }),
  action: (id: string, action: string) => json(`/api/sessions/${id}/${action}`, { method: 'POST' }),
  permission: (id: string, permissionId: string, approved: boolean) => json(`/api/sessions/${id}/permissions/${permissionId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approved }) }),
  fsList: (id: string, path = '') => json<FsListResult>(`/api/sessions/${id}/fs/list?path=${encodeURIComponent(path)}`, undefined, true),
  fsReadText: (id: string, path: string, options?: { format?: 'text'; hidden?: boolean }) => {
    const query = new URLSearchParams({ path });
    if (options?.format) query.set('format', options.format);
    if (options?.hidden) query.set('hidden', '1');
    // quietDenied=true：敏感文件黑名单或目录越界会返回 403，应在文件面板内联展示错误，不能把整页打成「访问被拒」。
    return json<FsReadResult>(`/api/sessions/${id}/fs/read?${query.toString()}`, undefined, true);
  },
  /** 图片/SVG/PDF 不走 JSON：直接给 <img>/<iframe> 用的同源 URL（cookie/会话令牌语义与其他接口一致）。 */
  fsReadUrl: (id: string, path: string) => `/api/sessions/${id}/fs/read?path=${encodeURIComponent(path)}`,
  fsDownloadUrl: (id: string, path: string) => `/api/sessions/${id}/fs/read?path=${encodeURIComponent(path)}&download=1`,

  // ---- 看板（Kanban） ----
  boards: (includeArchived = false) => json<{ boards: BoardRecord[]; defaultBoardId: string | null }>(`/api/boards${includeArchived ? '?includeArchived=1' : ''}`, undefined, true),
  board: (boardId = 'default') => json<HydratedBoard>(`/api/boards/${encodeURIComponent(boardId)}`, undefined, true),
  createBoard: (body: { name: string; description?: string; template?: BoardTemplate; viewMode?: BoardViewMode; density?: BoardDensity; isDefault?: boolean; clientMutationId?: string }) =>
    json<HydratedBoard>('/api/boards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  updateBoard: (boardId: string, body: { name?: string; description?: string; viewMode?: BoardViewMode; density?: BoardDensity; isDefault?: boolean; archived?: boolean; clientMutationId?: string }) =>
    json<{ board: BoardRecord }>(`/api/boards/${encodeURIComponent(boardId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  useBoard: (boardId: string, clientMutationId?: string) =>
    json<{ board: BoardRecord }>(`/api/boards/${encodeURIComponent(boardId)}/use`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(clientMutationId ? { clientMutationId } : {}) }),
  deleteBoard: (boardId: string, archive = false) =>
    json<{ ok: boolean; archived?: boolean; deleted?: boolean }>(`/api/boards/${encodeURIComponent(boardId)}${archive ? '?archive=1' : ''}`, { method: 'DELETE' }),
  addBoardColumn: (boardId: string, body: { name: string; color?: BoardColumnColor; wipLimit?: number | null; collapsed?: boolean; rule?: BoardColumnRule | null; onDropAction?: BoardDropAction; beforeColumnId?: string; afterColumnId?: string; clientMutationId?: string }) =>
    json<{ column: BoardColumnRecord; board: HydratedBoard }>(`/api/boards/${encodeURIComponent(boardId)}/columns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  updateBoardColumn: (colId: string, body: { name?: string; color?: BoardColumnColor; wipLimit?: number | null; collapsed?: boolean; rule?: BoardColumnRule | null; onDropAction?: BoardDropAction; clientMutationId?: string }) =>
    json<{ column: BoardColumnRecord; board: HydratedBoard }>(`/api/boards/columns/${encodeURIComponent(colId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  moveBoardColumn: (colId: string, body: { beforeColumnId?: string; afterColumnId?: string; index?: number; clientMutationId?: string }) =>
    json<{ column: BoardColumnRecord; board: HydratedBoard }>(`/api/boards/columns/${encodeURIComponent(colId)}/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  deleteBoardColumn: (colId: string, moveCardsTo?: string) =>
    json<{ deleted: boolean; board: HydratedBoard }>(`/api/boards/columns/${encodeURIComponent(colId)}${moveCardsTo ? `?moveCardsTo=${encodeURIComponent(moveCardsTo)}` : ''}`, { method: 'DELETE' }),
  addBoardItem: (boardId: string, body: { columnId: string; entityKind: BoardEntityKind; entityId?: string; title?: string; userNote?: string; kittenNote?: string; tags?: string[]; pinned?: boolean; placement?: 'top' | 'bottom'; beforeItemId?: string; afterItemId?: string; clientMutationId?: string }) =>
    json<{ item: BoardItemRecord; board: HydratedBoard }>(`/api/boards/${encodeURIComponent(boardId)}/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  moveBoardItem: (boardId: string, itemId: string, body: { toColumnId: string; beforeItemId?: string; afterItemId?: string; placement?: 'top' | 'bottom'; applyAction?: boolean; clientMutationId?: string }) =>
    json<{ item: BoardItemRecord; board: HydratedBoard }>(`/api/boards/${encodeURIComponent(boardId)}/items/${encodeURIComponent(itemId)}/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  batchMoveBoardItems: (boardId: string, body: { itemIds: string[]; toColumnId: string; pin?: boolean; applyAction?: boolean; clientMutationId?: string }) =>
    json<{ moved: BoardItemRecord[]; board: HydratedBoard }>(`/api/boards/${encodeURIComponent(boardId)}/items/batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  updateBoardItem: (boardId: string, itemId: string, body: { userNote?: string | null; kittenNote?: string | null; pinned?: boolean; tags?: string[]; addTags?: string[]; removeTags?: string[]; manualOverride?: boolean; clientMutationId?: string }) =>
    json<{ item: BoardItemRecord; board: HydratedBoard }>(`/api/boards/${encodeURIComponent(boardId)}/items/${encodeURIComponent(itemId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  removeBoardItem: (boardId: string, itemId: string) =>
    json<{ removed: boolean; board?: HydratedBoard }>(`/api/boards/${encodeURIComponent(boardId)}/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' }),
  askBoardKitten: (boardId: string, body: { itemIds?: string[]; prompt: string }) =>
    json<{ ok: boolean; sessionId: string; cardCount: number; message: string }>(`/api/boards/${encodeURIComponent(boardId)}/ask-kitten`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  exportBoard: (boardId: string, includeItems = false) =>
    json<BoardTemplatePayload>(`/api/boards/${encodeURIComponent(boardId)}/export${includeItems ? '?includeItems=1' : ''}`),
  importBoard: (body: { template: BoardTemplatePayload; name?: string; isDefault?: boolean }) =>
    json<HydratedBoard>('/api/boards/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),

  // ---- 自定义主题配色与 VS Code 导入 ----
  themes: () => json<ThemesStateSnapshot>('/api/themes', undefined, true),
  saveTheme: (body: { id?: string; name: string; description?: string; mode: CustomThemeMode; source?: Exclude<CustomThemeSource, 'builtin'>; vscodeMeta?: VsCodeThemeMeta; tokens: Partial<CustomThemeTokens>; apply?: boolean }) =>
    json<{ theme: CustomTheme; adjustments: ThemeContrastAdjustment[]; report: ThemeContrastReport; state: ThemesStateSnapshot }>('/api/themes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  updateTheme: (id: string, body: { name?: string; description?: string; mode?: CustomThemeMode; tokens?: Partial<CustomThemeTokens>; apply?: boolean }) =>
    json<{ theme: CustomTheme; adjustments: ThemeContrastAdjustment[]; report: ThemeContrastReport; state: ThemesStateSnapshot }>(`/api/themes/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  deleteTheme: (id: string) =>
    json<{ deleted: true; id: string; state: ThemesStateSnapshot }>(`/api/themes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  activateTheme: (body: { themeId?: string; modePreference?: ThemePreferenceMode; preserveModePreference?: boolean; reset?: boolean }) =>
    json<ThemesStateSnapshot>('/api/themes/active', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  generateTheme: (body: { prompt: string; mode?: 'auto' | CustomThemeMode; save?: boolean; apply?: boolean; timeoutMs?: number }, options: { signal?: AbortSignal } = {}) =>
    json<GenerateThemeResponse>('/api/themes/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(options.signal ? { signal: options.signal } : {}) }, true),
  importVsCodeTheme: (body: { source?: string; fileBase64?: string; fileName?: string; jsonText?: string; variant?: string; all?: boolean; previewOnly?: boolean; apply?: boolean }) =>
    json<ImportVsCodeThemeResponse>('/api/themes/import-vscode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, true)
};
