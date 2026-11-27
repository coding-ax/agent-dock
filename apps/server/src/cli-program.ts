import { Command } from 'commander';
import type { DaemonReadyInfo } from './daemon/command.js';
import type {
  CaseCloseCliOptions, CaseListCliOptions, SourceAddCliOptions, SourceRouterCliOptions,
  SourceTestCliOptions, SourceUpdateCliOptions
} from './sources-router/cli.js';
import type {
  AssistantCliOptions, DraftCreateCliOptions, MainCliOptions, NotifyCliOptions,
  TaskAppendCliOptions, TaskReportCliOptions, TaskReviewCliOptions, TaskStartCliOptions, WatchAddCliOptions
} from './assistant/cli.js';
import type {
  LarkMessageListenCliOptions, LarkMessageReadCliOptions, LarkMessageSendCliOptions
} from './lark/message-cli.js';
import type {
  LarkAvatarCommonCliOptions,
  LarkAvatarConfigSetCliOptions,
  LarkAvatarDiagnosticsCliOptions,
  LarkAvatarDraftListCliOptions,
  LarkAvatarDraftWriteCliOptions,
  LarkAvatarInboxCleanupCliOptions,
  LarkAvatarInboxListCliOptions,
  LarkAvatarReactionCliOptions,
  LarkAvatarReactionRouteCliOptions,
  LarkAvatarSendCliOptions
} from './lark-avatar/cli.js';
import type {
  HandoffCliOptions, LifecycleCliOptions, MaintenanceConfigCliOptions, MaintenanceRunCliOptions,
  NotesArchiveCliOptions, NotesListCliOptions, NotesUnarchiveCliOptions
} from './assistant/lifecycle-cli.js';
import type { UsageBreakdownCliOptions, UsageFilterCliOptions, UsageQuotaCliOptions, UsageSessionCliOptions } from './usage-cli.js';
import type {
  BoardAskKittenOptions, BoardCardAddOptions, BoardCardListOptions, BoardCardMoveOptions, BoardCardRemoveOptions, BoardCardUpdateOptions,
  BoardColumnAddOptions, BoardColumnDeleteOptions, BoardColumnMoveOptions, BoardColumnUpdateOptions,
  BoardCommonOptions, BoardCreateOptions, BoardDeleteOptions, BoardExportOptions, BoardImportOptions, BoardShowOptions, BoardUpdateOptions
} from './boards/cli.js';
import type {
  NotifyChannelCommandSetCliOptions, NotifyChannelLarkSetCliOptions, NotifyCommonCliOptions, NotifyConfigSetCliOptions,
  NotifyTestCliOptions, NotifyWebhookAddCliOptions, NotifyWebhookUpdateCliOptions
} from './notifications/cli.js';
import type {
  ThemeApplyCliOptions, ThemeCommonCliOptions, ThemeCreateCliOptions, ThemeExportCliOptions, ThemeImportVsCodeCliOptions
} from './themes/cli.js';

export interface CliOptions {
  host?: string;
  localOnly?: boolean;
  port?: string;
  cwd?: string;
  database?: string;
  idleTimeoutMs?: string;
  cleanupIntervalMs?: string;
  larkAppId?: string;
  larkAppSecret?: string;
  larkReceiveId?: string;
  larkChatId?: string;
  larkReceiveIdType?: string;
  larkAgentName?: string;
  larkBaseUrl?: string;
  larkListen?: boolean;
}

export interface LarkCliOptions {
  state?: string;
  readOnly?: boolean;
  agentName?: string;
  taskName?: string;
  taskId?: string;
  elapsedSeconds?: string;
  receiveId?: string;
  chatId?: string;
  receiveIdType?: string;
  messageId?: string;
  appId?: string;
  appSecret?: string;
  baseUrl?: string;
}

export interface AgentGroupCliOptions {
  after?: string;
  limit?: string;
  timeoutMs?: string;
  to?: string;
  replyTo?: string;
  inThread?: boolean;
  idempotencyKey?: string;
}

export interface UpdateCliOptions {
  distTag?: string;
}

export interface StatusCliOptions {
  json?: boolean;
}

export interface SessionCliOptions {
  database?: string;
  json?: boolean;
}

export interface SessionControlCliOptions {
  from?: string;
  mode?: 'queue' | 'interrupt';
}

export interface ScheduleAddCliOptions { cron?: string; every?: string; at?: string; tz?: string; name?: string; delivery?: string; session?: string; main?: boolean; from?: string; json?: boolean }
export interface ScheduleUpdateCliOptions { prompt?: string; cron?: string; every?: string; at?: string; tz?: string; name?: string; delivery?: string; session?: string; main?: boolean; from?: string; json?: boolean }
export interface ScheduleListCliOptions { all?: boolean; session?: string; main?: boolean; json?: boolean }
export interface ScheduleControlCliOptions { json?: boolean }

export interface DevCliOptions { port?: string; repo?: string; keepData?: boolean }

export interface CliHandlers {
  serve?(options: CliOptions, onReady?: (info?: DaemonReadyInfo) => void): void | Promise<void>;
  daemonStart?(options: CliOptions): void | Promise<void>;
  daemonStop?(): void | Promise<void>;
  daemonRestart?(options: CliOptions): void | Promise<void>;
  daemonStatus?(options: StatusCliOptions): void | Promise<void>;
  update?(options: UpdateCliOptions): void | Promise<void>;
  autostart?(action: 'enable' | 'disable' | 'status', options: { json?: boolean }): void | Promise<void>;
  larkSend?(markdown: string | undefined, options: LarkCliOptions): void | Promise<void>;
  larkUpdate?(markdown: string | undefined, options: LarkCliOptions): void | Promise<void>;
  larkMessageSend?(text: string | undefined, options: LarkMessageSendCliOptions): void | Promise<void>;
  larkMessageRead?(options: LarkMessageReadCliOptions): void | Promise<void>;
  larkMessageListen?(options: LarkMessageListenCliOptions): void | Promise<void>;
  larkAvatarSend?(options: LarkAvatarSendCliOptions): void | Promise<void>;
  larkAvatarDiagnostics?(options: LarkAvatarDiagnosticsCliOptions): void | Promise<void>;
  larkAvatarReaction?(options: LarkAvatarReactionCliOptions): void | Promise<void>;
  larkAvatarReactionRoute?(options: LarkAvatarReactionRouteCliOptions): void | Promise<void>;
  groupSelf?(): void | Promise<void>;
  groupPeers?(): void | Promise<void>;
  groupMembers?(): void | Promise<void>;
  groupBots?(): void | Promise<void>;
  groupMessages?(options: AgentGroupCliOptions): void | Promise<void>;
  groupMessage?(messageId: string): void | Promise<void>;
  groupSend?(content: string, options: AgentGroupCliOptions): void | Promise<void>;
  groupWait?(options: AgentGroupCliOptions): void | Promise<void>;
  groupReplyMode?(mode: string): void | Promise<void>;
  sessionList?(options: SessionCliOptions): void | Promise<void>;
  sessionShow?(sessionId: string, options: SessionCliOptions): void | Promise<void>;
  sessionPeers?(sessionId: string | undefined, options: SessionCliOptions): void | Promise<void>;
  sessionSend?(targetId: string, message: string, options: SessionControlCliOptions): void | Promise<void>;
  sessionInterrupt?(targetId: string, options: SessionControlCliOptions): void | Promise<void>;
  sessionCancel?(targetId: string, taskId: string, options: SessionControlCliOptions): void | Promise<void>;
  devUp?(options: DevCliOptions): void | Promise<void>;
  devRun?(args: string[], options: DevCliOptions): void | Promise<void>;
  devEnv?(options: DevCliOptions): void | Promise<void>;
  devDown?(options: DevCliOptions): void | Promise<void>;
  passwordSet?(options: { stdin?: boolean }): void | Promise<void>;
  passwordClear?(): void | Promise<void>;
  passwordStatus?(): void | Promise<void>;
  scheduleAdd?(prompt: string, options: ScheduleAddCliOptions): void | Promise<void>;
  scheduleUpdate?(id: string, options: ScheduleUpdateCliOptions): void | Promise<void>;
  scheduleList?(options: ScheduleListCliOptions): void | Promise<void>;
  scheduleShow?(id: string, options: ScheduleControlCliOptions): void | Promise<void>;
  schedulePause?(id: string, options: ScheduleControlCliOptions): void | Promise<void>;
  scheduleResume?(id: string, options: ScheduleControlCliOptions): void | Promise<void>;
  scheduleRun?(id: string, options: ScheduleControlCliOptions): void | Promise<void>;
  scheduleRemove?(id: string, options: ScheduleControlCliOptions): void | Promise<void>;
  sourceAdd?(name: string, options: SourceAddCliOptions): void | Promise<void>;
  sourceList?(options: SourceRouterCliOptions): void | Promise<void>;
  sourceShow?(id: string, options: SourceRouterCliOptions): void | Promise<void>;
  sourceEnable?(id: string, options: SourceRouterCliOptions): void | Promise<void>;
  sourceDisable?(id: string, options: SourceRouterCliOptions): void | Promise<void>;
  sourceLogs?(id: string, options: SourceRouterCliOptions & { limit?: string }): void | Promise<void>;
  sourceTest?(id: string, fixture: string | undefined, options: SourceTestCliOptions): void | Promise<void>;
  sourceUpdate?(id: string, options: SourceUpdateCliOptions): void | Promise<void>;
  caseList?(options: CaseListCliOptions): void | Promise<void>;
  caseShow?(id: string, options: SourceRouterCliOptions): void | Promise<void>;
  caseEvents?(id: string, options: SourceRouterCliOptions): void | Promise<void>;
  caseClose?(id: string, options: CaseCloseCliOptions): void | Promise<void>;
  routerStatus?(options: SourceRouterCliOptions): void | Promise<void>;
  routerOpen?(options: SourceRouterCliOptions): void | Promise<void>;
  routerDryRun?(fixture: string | undefined, options: SourceRouterCliOptions & { source?: string }): void | Promise<void>;
  taskStart?(taskId: string | undefined, options: TaskStartCliOptions): void | Promise<void>;
  taskPlan?(options: TaskStartCliOptions): void | Promise<void>;
  taskList?(options: AssistantCliOptions): void | Promise<void>;
  taskShow?(id: string, options: AssistantCliOptions): void | Promise<void>;
  taskReview?(id: string, options: TaskReviewCliOptions): void | Promise<void>;
  taskAppend?(id: string, options: TaskAppendCliOptions): void | Promise<void>;
  taskReport?(options: TaskReportCliOptions): void | Promise<void>;
  taskCancel?(id: string, options: AssistantCliOptions & { reason?: string }): void | Promise<void>;
  watchAdd?(options: WatchAddCliOptions): void | Promise<void>;
  watchList?(options: AssistantCliOptions): void | Promise<void>;
  watchShow?(id: string, options: AssistantCliOptions): void | Promise<void>;
  watchPause?(id: string, options: AssistantCliOptions): void | Promise<void>;
  watchResume?(id: string, options: AssistantCliOptions): void | Promise<void>;
  watchRun?(id: string, options: AssistantCliOptions): void | Promise<void>;
  watchRemove?(id: string, options: AssistantCliOptions): void | Promise<void>;
  notify?(text: string, options: NotifyCliOptions): void | Promise<void>;
  mainGet?(options: AssistantCliOptions): void | Promise<void>;
  mainSet?(sessionId: string | undefined, options: MainCliOptions): void | Promise<void>;
  mainClear?(options: AssistantCliOptions): void | Promise<void>;
  mainRestore?(sessionId: string | undefined, options: AssistantCliOptions): void | Promise<void>;
  mainHandoff?(options: HandoffCliOptions): void | Promise<void>;
  mainHandoffShow?(id: string | undefined, options: LifecycleCliOptions): void | Promise<void>;
  mainHandoffCancel?(id: string | undefined, options: LifecycleCliOptions): void | Promise<void>;
  mainHandoffResend?(id: string, options: LifecycleCliOptions): void | Promise<void>;
  mainLineage?(options: LifecycleCliOptions): void | Promise<void>;
  maintenanceStatus?(options: LifecycleCliOptions): void | Promise<void>;
  maintenanceRun?(options: MaintenanceRunCliOptions): void | Promise<void>;
  maintenanceConfig?(options: MaintenanceConfigCliOptions): void | Promise<void>;
  notesList?(options: NotesListCliOptions): void | Promise<void>;
  notesArchive?(options: NotesArchiveCliOptions): void | Promise<void>;
  notesUnarchive?(options: NotesUnarchiveCliOptions): void | Promise<void>;
  draftCreate?(options: DraftCreateCliOptions): void | Promise<void>;
  draftList?(options: AssistantCliOptions): void | Promise<void>;
  draftSend?(id: string, options: AssistantCliOptions): void | Promise<void>;
  draftDiscard?(id: string, options: AssistantCliOptions): void | Promise<void>;
  usageSummary?(options: UsageFilterCliOptions): void | Promise<void>;
  usageBreakdown?(options: UsageBreakdownCliOptions): void | Promise<void>;
  usageSession?(sessionId: string | undefined, options: UsageSessionCliOptions): void | Promise<void>;
  usageQuota?(agent: string | undefined, options: UsageQuotaCliOptions): void | Promise<void>;
  boardList?(options: BoardCommonOptions & { archived?: boolean }): void | Promise<void>;
  boardCreate?(name: string, options: BoardCreateOptions): void | Promise<void>;
  boardShow?(boardId: string | undefined, options: BoardShowOptions): void | Promise<void>;
  boardUpdate?(boardId: string, options: BoardUpdateOptions): void | Promise<void>;
  boardUse?(boardId: string, options: BoardCommonOptions): void | Promise<void>;
  boardDelete?(boardId: string, options: BoardDeleteOptions): void | Promise<void>;
  boardExport?(boardId: string | undefined, options: BoardExportOptions): void | Promise<void>;
  boardImport?(file: string, options: BoardImportOptions): void | Promise<void>;
  boardAskKitten?(boardId: string | undefined, options: BoardAskKittenOptions): void | Promise<void>;
  boardColumnList?(boardId: string | undefined, options: BoardCommonOptions): void | Promise<void>;
  boardColumnAdd?(boardId: string | undefined, options: BoardColumnAddOptions): void | Promise<void>;
  boardColumnUpdate?(colId: string, options: BoardColumnUpdateOptions): void | Promise<void>;
  boardColumnMove?(colId: string, options: BoardColumnMoveOptions): void | Promise<void>;
  boardColumnDelete?(colId: string, options: BoardColumnDeleteOptions): void | Promise<void>;
  boardCardList?(boardId: string | undefined, options: BoardCardListOptions): void | Promise<void>;
  boardCardAdd?(boardId: string | undefined, options: BoardCardAddOptions): void | Promise<void>;
  boardCardMove?(cardIds: string[], options: BoardCardMoveOptions): void | Promise<void>;
  boardCardUpdate?(cardId: string, options: BoardCardUpdateOptions): void | Promise<void>;
  boardCardRemove?(cardIds: string[], options: BoardCardRemoveOptions): void | Promise<void>;
  notifyStatus?(options: NotifyCommonCliOptions): void | Promise<void>;
  notifyConfigSet?(options: NotifyConfigSetCliOptions): void | Promise<void>;
  notifyChannelLarkSet?(options: NotifyChannelLarkSetCliOptions): void | Promise<void>;
  notifyWebhookList?(options: NotifyCommonCliOptions): void | Promise<void>;
  notifyWebhookAdd?(options: NotifyWebhookAddCliOptions): void | Promise<void>;
  notifyWebhookUpdate?(id: string, options: NotifyWebhookUpdateCliOptions): void | Promise<void>;
  notifyWebhookRemove?(id: string, options: NotifyCommonCliOptions): void | Promise<void>;
  notifyChannelCommandSet?(options: NotifyChannelCommandSetCliOptions): void | Promise<void>;
  notifyTest?(channel: string, options: NotifyTestCliOptions): void | Promise<void>;
  larkAvatarStatus?(options: LarkAvatarCommonCliOptions): void | Promise<void>;
  larkAvatarConfigShow?(options: LarkAvatarCommonCliOptions): void | Promise<void>;
  larkAvatarConfigSet?(options: LarkAvatarConfigSetCliOptions): void | Promise<void>;
  larkAvatarListen?(enabled: boolean, options: LarkAvatarCommonCliOptions): void | Promise<void>;
  larkAvatarChats?(options: LarkAvatarCommonCliOptions): void | Promise<void>;
  larkAvatarPoll?(options: LarkAvatarCommonCliOptions): void | Promise<void>;
  larkAvatarInboxList?(options: LarkAvatarInboxListCliOptions): void | Promise<void>;
  larkAvatarInboxCleanup?(options: LarkAvatarInboxCleanupCliOptions): void | Promise<void>;
  larkAvatarDraftList?(options: LarkAvatarDraftListCliOptions): void | Promise<void>;
  larkAvatarDraftCreate?(options: LarkAvatarDraftWriteCliOptions): void | Promise<void>;
  larkAvatarDraftUpdate?(id: string, options: LarkAvatarDraftWriteCliOptions): void | Promise<void>;
  larkAvatarDraftSend?(id: string, options: LarkAvatarDraftWriteCliOptions): void | Promise<void>;
  larkAvatarDraftDiscard?(id: string, options: LarkAvatarCommonCliOptions): void | Promise<void>;
  themeList?(options: ThemeCommonCliOptions): void | Promise<void>;
  themeCreate?(options: ThemeCreateCliOptions): void | Promise<void>;
  themeImportVsCode?(source: string, options: ThemeImportVsCodeCliOptions): void | Promise<void>;
  themeApply?(idOrName: string | undefined, options: ThemeApplyCliOptions): void | Promise<void>;
  themeReset?(options: ThemeCommonCliOptions): void | Promise<void>;
  themeDelete?(id: string, options: ThemeCommonCliOptions): void | Promise<void>;
  themeExport?(idOrName: string, options: ThemeExportCliOptions): void | Promise<void>;
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

const addCardOptions = (command: Command) => command
  .option('--state <state>', 'Card state: queued, running, completed, failed, or interrupted', 'completed')
  .option('--read-only', 'Render the card without action buttons')
  .option('--agent-name <name>', 'Agent name shown in the card title')
  .option('--task-name <name>', 'Card subtitle / task name', 'AgentDock')
  .option('--task-id <id>', 'Task identifier shown in the footer')
  .option('--elapsed-seconds <seconds>', 'Elapsed time shown in the footer', '0')
  .option('--app-id <id>', 'Lark app ID; defaults to LARK_APP_ID')
  .option('--app-secret <secret>', 'Lark app secret; defaults to LARK_APP_SECRET')
  .option('--base-url <url>', 'Lark OpenAPI base URL; defaults to LARK_OPEN_API_BASE_URL');

const addServerOptions = (command: Command) => command
  .option('--host <host>', 'Advanced: bind a specific host or interface')
  .option('--local-only', 'Only accept connections from this computer (127.0.0.1)')
  .option('--port <port>', 'Bind port (default: 4310)')
  .option('--cwd <directory>', 'Default Agent working directory')
  .option('--database <file>', 'SQLite database path')
  .option('--idle-timeout-ms <ms>', 'Release idle Agent drivers (default: 21600000)')
  .option('--cleanup-interval-ms <ms>', 'Idle cleanup interval (default: 300000)')
  .option('--lark-app-id <id>', 'Lark app ID used by /api/lark; defaults to LARK_APP_ID')
  .option('--lark-app-secret <secret>', 'Lark app secret used by /api/lark; defaults to LARK_APP_SECRET')
  .option('--lark-receive-id <id>', 'Default Lark recipient used by /api/lark')
  .option('--lark-chat-id <id>', 'Default Lark group chat ID used by /api/lark')
  .option('--lark-receive-id-type <type>', 'Default Lark recipient ID type')
  .option('--lark-agent-name <name>', 'Default Lark card agent name')
  .option('--lark-base-url <url>', 'Lark OpenAPI base URL')
  .option('--no-lark-listen', 'Disable Lark message listening for this process without changing saved configuration');

/**
 * Server options may appear on the root (default serve) or a `daemon start /
 * restart` subcommand. Commander routes them to the command that defined them,
 * so a subcommand reads the merged globals to see flags passed on the same
 * invocation.
 */
const serverOptionsFrom = (options: CliOptions, command: Command): CliOptions => {
  const merged: CliOptions = { ...command.optsWithGlobals() };
  // 子命令现在也声明了 server options（--port/--cwd 等），默认值不能盖掉
  // 写在子命令之前的根选项（例如 `agent-dock --no-lark-listen start`）。
  for (const [key, value] of Object.entries(options)) {
    if (command.getOptionValueSource(key) !== 'default') (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
};

export function createCliProgram(version: string, handlers: CliHandlers = {}) {
  const program = new Command()
    .name('agent-dock')
    .description('Run the AgentDock local session server')
    .version(version, '-V, --version', 'Show the installed version')
    // 根命令和子命令都有 --cwd（daemon 默认目录 vs 任务/会话工作目录）。
    // 不开启 positional options 时 Commander 会把子命令后的 --cwd 当成根选项吃掉，
    // 子命令 handler 只能拿到 undefined，任务便悄悄继承主会话目录。
    .enablePositionalOptions();

  addServerOptions(program)
    .showHelpAfterError();

  program.action(options => handlers.serve?.(options));

  const lark = program.command('lark').description('Send AgentDock cards, or send/read/listen to Lark messages');
  addCardOptions(lark.command('send')
    .description('Send a new AgentDock card')
    .argument('[markdown]', 'Final Markdown or fallback card content')
    .option('--receive-id <id>', 'Recipient ID; defaults to LARK_RECEIVE_ID')
    .option('--chat-id <id>', 'Group chat ID (oc_xxx); defaults to LARK_CHAT_ID')
    .option('--receive-id-type <type>', 'ID type; defaults to LARK_RECEIVE_ID_TYPE'))
    .action((markdown, options) => handlers.larkSend?.(markdown, options));
  addCardOptions(lark.command('update')
    .description('Update an existing AgentDock card in place')
    .argument('[markdown]', 'Final Markdown or fallback card content')
    .requiredOption('--message-id <id>', 'Lark card message ID to update'))
    .action((markdown, options) => handlers.larkUpdate?.(markdown, options));

  const larkAvatar = lark.command('avatar')
    .description('AI 飞书替身：用本人已登录的 Web 会话发送消息（群名/消息关键字/@ 姓名都会先解析）');
  larkAvatar.command('send')
    .description('发送文本消息；默认引用回复，--in-thread 在话题内回复')
    .requiredOption('--chat <chat>', '群名、oc_* chat_id 或数字 chat_id')
    .option('--text <text>', '消息正文')
    .option('--text-file <file>', '正文文件；- 表示 stdin')
    .option('--reply-to <target>', 'om_* 消息 ID、数字 rootId 或最近消息关键字')
    .option('--in-thread', '回到原话题内回复（默认引用回复）')
    .option('--at <user>', '要 @ 的姓名、ou_* open_id 或数字 userId，可重复', collect, [])
    .option('--match <mode>', '群名匹配：exact 或 fuzzy')
    .option('--json', '输出 JSON')
    .action(options => handlers.larkAvatarSend?.(options))
    .addHelpText('after', `
Examples:
  $ agent-dock lark avatar send --chat "发布群" --text "构建完成"
  $ agent-dock lark avatar send --chat oc_xxx --reply-to "发布计划" --in-thread --at 张三 --text "@张三 已更到预发"
  $ echo "部署完成" | agent-dock lark avatar send --chat 900001 --text-file - --json`);

  larkAvatar.command('triggers')
    .description('查看最近一次飞书表情事件和触发账本（排查“加了表情没反应”）')
    .option('--limit <n>', '账本条数（1–100，默认 10）')
    .option('--json', '输出 JSON')
    .action(options => handlers.larkAvatarDiagnostics?.(options));

  larkAvatar.command('reaction')
    .description('仅隔离沙箱：注入一条 fake reaction 事件，验证「加表情 → 触发一轮」')
    .requiredOption('--message <messageId>', '被反应消息的 om_* message_id')
    .requiredOption('--emoji <emojiType>', '飞书 emoji_type，例如 THUMBSUP')
    .option('--operator <id>', '操作人 ID；默认 ou_test_operator')
    .option('--operator-type <type>', 'user / bot / app')
    .option('--action-time <time>', '飞书 action_time；重试测试时传新值')
    .option('--chat <chatId>', '会话 ID；默认 oc_test_chat')
    .option('--chat-name <name>', '会话名；默认 测试群')
    .option('--sender <name>', '发送人显示名；默认 测试用户')
    .option('--content <text>', '被反应消息正文')
    .option('--json', '输出 JSON')
    .action(options => handlers.larkAvatarReaction?.(options));

  larkAvatar.command('reaction-route')
    .description('仅隔离沙箱：模拟点击询问卡片的「发到主会话 / 单独处理」')
    .requiredOption('--trigger <key>', 'reaction 账本 key（triggers --json 可查）')
    .requiredOption('--route <route>', 'main 或 independent')
    .option('--operator <id>', '操作人 open_id')
    .option('--json', '输出 JSON')
    .action(options => handlers.larkAvatarReactionRoute?.(options));

  larkAvatar.command('status')
    .description('查看 AI 飞书替身连接状态、监听态与收件箱保留统计')
    .option('--json', '输出 JSON')
    .action(options => handlers.larkAvatarStatus?.(options));

  const larkAvatarConfig = larkAvatar.command('config').description('查看或修改 AI 飞书替身配置（三档回复策略、保留上限、表情触发等）');
  larkAvatarConfig.command('show')
    .description('查看当前配置')
    .option('--json', '输出 JSON')
    .action(options => handlers.larkAvatarConfigShow?.(options));
  larkAvatarConfig.command('set')
    .description('更新配置项（增量生效）')
    .option('--region <region>', '区域：feishu 或 lark')
    .option('--reply-forward <mode>', '回复转发策略：all / final_only / none')
    .option('--reply-mode <mode>', '主会话回复方式：direct / quote / thread')
    .option('--reply-in-topic', '话题内消息回到原话题')
    .option('--no-reply-in-topic', '话题内消息发到主会话')
    .option('--inbox-max <n>', '消息记录保留上限（0 表示不限制）')
    .option('--cleanup-warn <n>', '清理提醒阈值（0 表示关闭提醒）')
    .option('--trigger-prefix <prefix>', '触发前缀，如 /ai')
    .option('--context-messages <n>', '上下文携带条数')
    .option('--context-scope <scope>', '上下文范围：anchor 或 chat')
    .option('--emoji-reactions', '开启自动表情回应')
    .option('--no-emoji-reactions', '关闭自动表情回应')
    .option('--reaction-trigger <on|off>', '开关表情触发 Agent 轮次')
    .option('--reaction-emoji <emoji>', '触发用飞书 emoji_type，如 OK / THUMBSUP')
    .option('--reaction-route <route>', '表情触发路由：main / independent / ask')
    .option('--reaction-ignore-bots', '忽略机器人/应用表情')
    .option('--no-reaction-ignore-bots', '不忽略机器人/应用表情')
    .option('--reply-signature <text>', '回复签名后缀')
    .option('--agent-timeout <sec>', 'Agent 单轮超时秒数（0 表示不限）')
    .option('--agent <id>', '执行 Agent ID')
    .option('--model <model>', '执行模型')
    .option('--reasoning-effort <effort>', '推理强度')
    .option('--workspace <dir>', '工作目录')
    .option('--listen-chats <ids>', '逗号分隔监听群 chat_id 列表')
    .option('--json', '输出 JSON')
    .action(options => handlers.larkAvatarConfigSet?.(options));

  const larkAvatarListen = larkAvatar.command('listen').description('开启或暂停 AI 飞书替身监听');
  larkAvatarListen.command('start').description('开启监听').option('--json', '输出 JSON').action(options => handlers.larkAvatarListen?.(true, options));
  larkAvatarListen.command('stop').description('暂停监听（保留登录态）').option('--json', '输出 JSON').action(options => handlers.larkAvatarListen?.(false, options));

  larkAvatar.command('chats').description('列出已同步的飞书会话列表').option('--json', '输出 JSON').action(options => handlers.larkAvatarChats?.(options));
  larkAvatar.command('poll').description('立即执行一次消息补拉').option('--json', '输出 JSON').action(options => handlers.larkAvatarPoll?.(options));

  const larkAvatarInbox = larkAvatar.command('inbox').description('查看或清理 AI 飞书替身消息记录');
  larkAvatarInbox.command('list')
    .description('列出收件箱消息记录')
    .option('--state <states>', '按状态过滤，如 new,handled')
    .option('--tier <tier>', '按分层过滤：action / fyi / noise')
    .option('--limit <n>', '返回条数')
    .option('--json', '输出 JSON')
    .action(options => handlers.larkAvatarInboxList?.(options));
  larkAvatarInbox.command('cleanup')
    .description('清理旧消息记录')
    .option('--keep-latest <n>', '保留最近 N 条')
    .option('--all', '清空全部消息记录')
    .option('--json', '输出 JSON')
    .action(options => handlers.larkAvatarInboxCleanup?.(options));

  const larkAvatarDraft = larkAvatar.command('draft').description('管理 AI 飞书替身回复草稿');
  larkAvatarDraft.command('list').description('列出草稿').option('--state <state>', 'pending / sent / failed / discarded').option('--json', '输出 JSON').action(options => handlers.larkAvatarDraftList?.(options));
  larkAvatarDraft.command('create').description('创建草稿').requiredOption('--target <target>', '目标会话').option('--text <text>', '正文').option('--text-file <file>', '正文文件；- 表示 stdin').option('--item <id>', '关联收件箱项 ID').option('--thread-key <key>', '话题键').option('--reply-root <id>', '回复根消息 ID').option('--json', '输出 JSON').action(options => handlers.larkAvatarDraftCreate?.(options));
  larkAvatarDraft.command('update').description('修改草稿正文').argument('<draft-id>').option('--text <text>', '正文').option('--text-file <file>', '正文文件；- 表示 stdin').option('--json', '输出 JSON').action((id, options) => handlers.larkAvatarDraftUpdate?.(id, options));
  larkAvatarDraft.command('send').description('发送草稿').argument('<draft-id>').option('--text <text>', '可选覆盖正文').option('--text-file <file>', '正文文件；- 表示 stdin').option('--json', '输出 JSON').action((id, options) => handlers.larkAvatarDraftSend?.(id, options));
  larkAvatarDraft.command('discard').description('丢弃草稿').argument('<draft-id>').option('--json', '输出 JSON').action((id, options) => handlers.larkAvatarDraftDiscard?.(id, options));

  const larkMessage = lark.command('message')
    .description('Generic Lark IM messages using a configured bot (does not create AgentDock sessions)');
  larkMessage.command('send')
    .description('Send a text or post message as a configured bot')
    .argument('[text]', 'Message text; omit to read from stdin')
    .option('--chat <chatId>', 'Group chat ID (oc_xxx); defaults to LARK_CHAT_ID')
    .option('--text <text>', 'Message text (alternative to the positional argument)')
    .option('--format <format>', 'Message format: text or post', 'text')
    .option('--idempotency-key <key>', 'Stable retry key (up to 50 characters)')
    .option('--app <appId>', 'Select a saved bot by app ID')
    .option('--bot <name>', 'Select a saved bot by name or app ID')
    .option('--base-url <url>', 'Lark OpenAPI base URL; defaults to LARK_OPEN_API_BASE_URL')
    .option('--json', 'Print one JSON object')
    .action((text, options) => handlers.larkMessageSend?.(text, options))
    .addHelpText('after', `
Examples:
  $ agent-dock lark message send --chat oc_xxx --text "构建完成"
  $ echo "部署完成" | agent-dock lark message send --chat oc_xxx
  $ agent-dock lark message send --chat oc_xxx --bot "发布机器人" --format post "第一段\\n\\n第二段"
  $ agent-dock lark message send --chat oc_xxx --text "hi" --json`);
  larkMessage.command('read')
    .description('Read recent messages from a group chat (newest first)')
    .option('--chat <chatId>', 'Group chat ID (oc_xxx); defaults to LARK_CHAT_ID')
    .option('--limit <count>', 'Maximum messages to return (1-200)', '20')
    .option('--before <time>', 'Only messages before this time (ISO 8601 or Unix timestamp)')
    .option('--page-token <token>', 'Continue from a page token returned by a previous read')
    .option('--app <appId>', 'Select a saved bot by app ID')
    .option('--bot <name>', 'Select a saved bot by name or app ID')
    .option('--base-url <url>', 'Lark OpenAPI base URL; defaults to LARK_OPEN_API_BASE_URL')
    .option('--json', 'Print one JSON object with full message metadata')
    .action(options => handlers.larkMessageRead?.(options))
    .addHelpText('after', `
Examples:
  $ agent-dock lark message read --chat oc_xxx --limit 10
  $ agent-dock lark message read --chat oc_xxx --before 2026-11-12T10:00:00Z --json
  $ agent-dock lark message read --chat oc_xxx --page-token <token> --json`);
  larkMessage.command('listen')
    .description('Stream new group messages as JSONL until interrupted')
    .option('--chat <chatId>', 'Only emit messages from this group chat (oc_xxx)')
    .option('--app <appId>', 'Select a saved bot by app ID')
    .option('--bot <name>', 'Select a saved bot by name or app ID')
    .option('--timeout <seconds>', 'Exit gracefully after this many seconds')
    .option('--once', 'Exit after the first matching message')
    .option('--json', 'Explicitly request JSONL events (the default)')
    .option('--base-url <url>', 'Lark OpenAPI base URL; defaults to LARK_OPEN_API_BASE_URL')
    .action(options => handlers.larkMessageListen?.(options))
    .addHelpText('after', `
Each line on stdout is one JSON event, for example:
  {"type":"message","appId":"cli_xxx","bot":"发布机器人","message":{"messageId":"om_xxx","chatId":"oc_xxx","text":"hi",...}}

Use --chat to filter, --once for a single message, and SIGINT/SIGTERM to stop. Reconnects are handled by the Lark SDK.

Examples:
  $ agent-dock lark message listen --chat oc_xxx
  $ agent-dock lark message listen --bot "发布机器人" --once
  $ agent-dock lark message listen --chat oc_xxx --timeout 30 --json`);

  const group = program.command('group').description('Collaborate with Agents in the current Lark group');
  group.command('self')
    .description('Show the current Lark Agent and scoped chat')
    .action(() => handlers.groupSelf?.());
  group.command('peers')
    .description('Discover configured Agents that are members of this Lark group')
    .action(() => handlers.groupPeers?.());
  group.command('members')
    .description('Discover human members in this Lark group')
    .action(() => handlers.groupMembers?.());
  group.command('bots')
    .description('List all bots in this Lark group (agentId present means managed by this AgentDock instance)')
    .action(() => handlers.groupBots?.());
  group.command('messages')
    .description('Read messages from this Lark group')
    .option('--after <cursor>', 'Read only messages after a cursor returned by messages or wait')
    .option('--limit <count>', 'Maximum messages to return (1-50)', '20')
    .action(options => handlers.groupMessages?.(options));
  group.command('message')
    .description('Fetch a single message by ID, expanding merge_forward (合并转发) content')
    .argument('<message-id>', 'om_* message ID to fetch')
    .action((messageId) => handlers.groupMessage?.(messageId));
  group.command('send')
    .description('Send a new group message or reply to an existing message/thread')
    .argument('<content>', 'Message content')
    .option('--to <target>', 'Mention a discovered Agent or human member by ID or name')
    .option('--reply-to <message-id>', 'Reply to a message in this group')
    .option('--in-thread', 'Place the reply in the topic/thread; requires --reply-to with an om_* message ID')
    .option('--idempotency-key <key>', 'Stable retry key (up to 50 characters)')
    .action((content, options) => handlers.groupSend?.(content, options))
    .addHelpText('after', `
Examples:
  $ agent-dock group send "我已定位问题" --reply-to om_xxx --in-thread
  $ agent-dock group send "请检查接口" --to cli_peer --reply-to om_xxx --in-thread
  $ agent-dock group send "发布窗口已开启"
  $ agent-dock group send "运行结果：<img src=\\"/abs/path/1.png\\"/>"  # 文本中混排图片
  $ agent-dock group send "<img src=\\"https://example.com/a.png\\"/>"     # 只发一张图片

Content tags:
  <img src="..."/> (also <image>) — standalone or mixed inline image. src can be a local absolute path,
  a path relative to the bot workspace, an http(s) URL, or a data:image/...;base64 data URI.
  <at user_id="ou_*">Name</at> — mention a member/bot by open_id.

Routing guidance:
  Continue a discussion or answer a question with --reply-to ... --in-thread.
  Start an independent announcement or task without --reply-to/--in-thread.`);
  group.command('wait')
    .description('Wait briefly for new messages after a cursor')
    .requiredOption('--after <cursor>', 'Cursor returned by messages or wait')
    .option('--limit <count>', 'Maximum messages to return (1-50)', '20')
    .option('--timeout-ms <milliseconds>', 'Long-poll timeout (0-30000)', '15000')
    .action(options => handlers.groupWait?.(options));
  group.command('reply-mode')
    .description('Set how the final result card is delivered for the current task')
    .requiredOption('--mode <mode>', 'thread (reply in topic) or direct (reply in group chat)')
    .action(options => handlers.groupReplyMode?.(options.mode));

  const session = program.command('session').description('Read sessions and communicate between linked main/side sessions');
  session.command('list')
    .description('List all sessions')
    .option('--json', 'Output raw session rows as JSON')
    .option('--database <file>', 'SQLite database path (defaults to the running daemon database)')
    .action(options => handlers.sessionList?.(options));
  session.command('show')
    .description('Print a readable transcript of one session')
    .argument('<session-id>', 'Session ID (ses_*), see: agent-dock session list')
    .option('--json', 'Output raw session/tasks/events as JSON')
    .option('--database <file>', 'SQLite database path (defaults to the running daemon database)')
    .action((sessionId, options) => handlers.sessionShow?.(sessionId, options));
  session.command('peers')
    .description('List the current session’s linked main/side sessions')
    .argument('[session-id]', 'Defaults to agentdock_session_id in the current Agent environment')
    .option('--json', 'Output full peer session rows as JSON')
    .option('--database <file>', 'SQLite database path (defaults to the running daemon database)')
    .action((sessionId, options) => handlers.sessionPeers?.(sessionId, options));
  session.command('send')
    .description('Send a message to a linked session; queue by default, or interrupt and send immediately')
    .argument('<target-session-id>', 'Linked main or side session ID')
    .argument('<message>', 'Message to send')
    .option('--from <session-id>', 'Source session ID (defaults to agentdock_session_id)')
    .option('--mode <mode>', 'queue or interrupt', 'queue')
    .action((targetId, message, options) => handlers.sessionSend?.(targetId, message, options));
  session.command('interrupt')
    .description('Interrupt the active task in a linked session')
    .argument('<target-session-id>', 'Linked main or side session ID')
    .option('--from <session-id>', 'Source session ID (defaults to agentdock_session_id)')
    .action((targetId, options) => handlers.sessionInterrupt?.(targetId, options));
  session.command('cancel')
    .description('Cancel one queued task in a linked session (use interrupt for the active task)')
    .argument('<target-session-id>', 'Linked main or side session ID')
    .argument('<task-id>', 'Queued task ID from session show')
    .option('--from <session-id>', 'Source session ID (defaults to agentdock_session_id)')
    .action((targetId, taskId, options) => handlers.sessionCancel?.(targetId, taskId, options));
  session.addHelpText('after', `
Inside an AgentDock session the current session ID is in $agentdock_session_id; --from and peers default to it.

Workflow:
  1. agent-dock session peers                    # find linked main/side session IDs (TARGET_ID)
  2. agent-dock session show TARGET_ID           # read its transcript before assuming what it is doing
  3. agent-dock session send TARGET_ID "消息"     # queued; runs after its current task
     agent-dock session send TARGET_ID "消息" --mode interrupt   # urgent: interrupt, then send
  4. agent-dock session show TARGET_ID           # "queued" only means enqueued; confirm it ran

Other:
  agent-dock session interrupt TARGET_ID         # stop its active task only
  agent-dock session cancel TARGET_ID TASK_ID    # drop one queued task (TASK_ID from session show)
  agent-dock session list                        # all sessions; add --json for raw rows

Notes:
  Only message linked sessions, and only when the user asks or the task really needs it.
  Claude ListAgents/SendMessage cannot reach AgentDock sessions; use these commands instead.
  Reads go straight to the local database (no network or token needed).`);

  const task = program.command('task').description('主会话事项：派活、计划、验收、返工（只有主会话能调用，report 除外）');
  const addTaskOptions = (command: Command) => command
    .option('--title <title>', '事项标题')
    .option('--notes <text>', '派活说明')
    .option('--notes-file <file>', '从文件读说明；- 表示 stdin')
    .option('--done-when <criterion>', '验收标准，可重复', collect, [])
    .option('--expect-minutes <n>', '预计时长（分钟）')
    .option('--agent <id>', '侧边会话 Agent；不传继承主会话')
    .option('--cwd <dir>', '侧边会话工作目录（任意绝对路径）；不传继承主会话')
    .option('--model <model>', '侧边会话模型；不传继承主会话')
    .option('--reasoning-effort <effort>', '侧边会话思考深度；不传继承主会话')
    .option('--from <session-id>', '来源会话；默认 $agentdock_session_id')
    .option('--json', '输出 JSON');
  addTaskOptions(task.command('start')
    .description('新建并启动一个事项；传 task-id 时启动已登记的计划卡')
    .argument('[task-id]', '计划卡 ID'))
    .action((taskId, options) => handlers.taskStart?.(taskId, options));
  addTaskOptions(task.command('plan')
    .description('登记一张计划卡，等用户确认后再开工'))
    .action(options => handlers.taskPlan?.(options));
  task.command('list')
    .description('列出事项')
    .option('--json', '输出 JSON')
    .action(options => handlers.taskList?.(options));
  task.command('show')
    .description('查看一个事项')
    .argument('<task-id>')
    .option('--json', '输出 JSON')
    .action((id, options) => handlers.taskShow?.(id, options));
  task.command('review')
    .description('验收一个事项')
    .argument('<task-id>')
    .requiredOption('--verdict <verdict>', 'accepted / rework / needs_user / cancelled')
    .option('--check <check>', "逐条验收，格式 '<标准>=met:<证据>' 或 '<标准>=unmet:<原因>'，可重复", collect, [])
    .option('--note <text>', '备注')
    .option('--from <session-id>', '来源会话；默认 $agentdock_session_id')
    .option('--json', '输出 JSON')
    .action((id, options) => handlers.taskReview?.(id, options));
  task.command('append')
    .description('把补充/打回要求追加回原事项（已关闭也可续做）')
    .argument('<task-id>', '事项 ID')
    .requiredOption('--text <text>', '用户补充/打回要求')
    .option('--mode <mode>', 'queue / interrupt', 'queue')
    .option('--from <session-id>', '来源会话；默认 $agentdock_session_id')
    .option('--json', '输出 JSON')
    .action((id, options) => handlers.taskAppend?.(id, options));
  task.command('report')
    .description('侧边会话汇报：done / question / blocked')
    .requiredOption('--kind <kind>', 'done / question / blocked')
    .requiredOption('--text <text>', '汇报内容')
    .option('--evidence <text>', '证据')
    .option('--from <session-id>', '来源会话；默认 $agentdock_session_id')
    .option('--json', '输出 JSON')
    .action(options => handlers.taskReport?.(options));
  task.command('cancel')
    .description('取消一个事项')
    .argument('<task-id>')
    .option('--reason <text>', '取消原因')
    .option('--from <session-id>', '来源会话；默认 $agentdock_session_id')
    .option('--json', '输出 JSON')
    .action((id, options) => handlers.taskCancel?.(id, options));

  const watch = program.command('watch').description('自定义检查脚本：daemon 定期执行，条件满足才叫醒主会话');
  watch.command('add')
    .description('登记一个 watch')
    .requiredOption('--name <name>', '名称')
    .requiredOption('--command <command>', '检查脚本；exit 0 表示条件满足')
    .option('--every <interval>', '执行间隔，如 60s / 5m / 1h', '60s')
    .option('--timeout <duration>', '单次超时，默认 30s', '30s')
    .option('--repeat', '满足后继续执行；默认一次性')
    .option('--cooldown <duration>', '重复模式下触发后的冷却，默认 30m', '30m')
    .option('--cwd <dir>', '脚本工作目录')
    .option('--expires <iso>', '过期时间')
    .option('--from <session-id>', '来源会话；默认 $agentdock_session_id')
    .option('--json', '输出 JSON')
    .action(options => handlers.watchAdd?.(options));
  watch.command('list').description('列出 watch').option('--json', '输出 JSON').action(options => handlers.watchList?.(options));
  watch.command('show').description('查看一个 watch').argument('<watch-id>').option('--json', '输出 JSON').action((id, options) => handlers.watchShow?.(id, options));
  watch.command('pause').description('暂停 watch').argument('<watch-id>').option('--json', '输出 JSON').action((id, options) => handlers.watchPause?.(id, options));
  watch.command('resume').description('恢复 watch').argument('<watch-id>').option('--json', '输出 JSON').action((id, options) => handlers.watchResume?.(id, options));
  watch.command('run').description('立即执行一次').argument('<watch-id>').option('--json', '输出 JSON').action((id, options) => handlers.watchRun?.(id, options));
  watch.command('remove').description('删除 watch').argument('<watch-id>').option('--json', '输出 JSON').action((id, options) => handlers.watchRemove?.(id, options));

  const notify = program.command('notify')
    .description('主会话主动通知，及多通道通知配置/测试（兼容 agent-dock notify "<text>"）')
    .argument('[text]', '通知内容（兼容既有快捷发送）')
    .option('--ask', '需要用户拍板')
    .option('--urgent', '紧急通知：系统轮次里也放行')
    .option('--from <session-id>', '来源会话；默认 $agentdock_session_id')
    .option('--json', '输出 JSON')
    .action((text, options, command: Command) => {
      if (!text) {
        command.outputHelp();
        return;
      }
      return handlers.notify?.(text, options);
    });
  notify.command('send')
    .description('让主会话主动发送一条通知（等同 agent-dock notify "<text>"）')
    .argument('<text>', '通知内容')
    .option('--ask', '需要用户拍板')
    .option('--urgent', '紧急通知：系统轮次里也放行')
    .option('--from <session-id>', '来源会话；默认 $agentdock_session_id')
    .option('--json', '输出 JSON')
    .action((text, options) => handlers.notify?.(text, options));
  notify.command('status')
    .description('查看通知设置摘要与各通道最近投递健康状态')
    .option('--json', '输出 JSON')
    .action(options => handlers.notifyStatus?.(options));
  const notifyConfig = notify.command('config').description('查看或修改多通道通知规则与防打扰配置');
  notifyConfig.command('show').description('查看当前通知配置（密文已脱敏）').option('--json', '输出 JSON').action(options => handlers.notifyStatus?.(options));
  notifyConfig.command('set')
    .description('修改通知开关、触发事件、防刷屏与范围分层')
    .option('--enabled', '开启通知中心')
    .option('--disabled', '关闭通知中心')
    .option('--events <list>', '逗号分隔启用的事件：completed,failed,waiting_approval')
    .option('--min-duration <sec>', '正常完成的最短耗时阈值（秒）')
    .option('--coalesce-ms <ms>', '远程通道短窗合并毫秒数')
    .option('--remote-only-when-away', '仅离开电脑时推远程通道')
    .option('--always-remote', '始终推远程通道')
    .option('--away-after <sec>', '离机判定秒数')
    .option('--scope-normal <on|off>', '普通会话是否通知')
    .option('--scope-subtasks <on|off>', '主小猫便签子会话是否通知')
    .option('--scope-scheduled <mode>', '定时任务通知模式：all / failed_only / off')
    .option('--json', '输出 JSON')
    .action(options => handlers.notifyConfigSet?.(options));
  const notifyChannel = notify.command('channel').description('配置飞书 / Webhook / 本地命令 Hook 通知通道');
  const notifyLark = notifyChannel.command('lark').description('飞书机器人通知通道');
  notifyLark.command('set')
    .description('配置飞书通知通道')
    .option('--enabled', '启用飞书通知')
    .option('--disabled', '停用飞书通知')
    .option('--app <appId>', '指定飞书机器人 App ID')
    .option('--mode <mode>', 'auto_handover_then_fallback / direct_user / chat')
    .option('--target <id>', '兜底接收者 open_id 或群 chat_id')
    .option('--target-type <type>', 'open_id 或 chat_id')
    .option('--skip-original', '跳过原本就是飞书发起的会话')
    .option('--include-original', '飞书发起的会话也照推')
    .option('--include-summary', '附带结果摘要')
    .option('--no-summary', '不附带摘要')
    .option('--json', '输出 JSON')
    .action(options => handlers.notifyChannelLarkSet?.(options));
  const notifyWebhook = notifyChannel.command('webhook').description('通用 Webhook 通道（支持飞书群机器人/钉钉/企微/Bark/ntfy/Slack/Discord）');
  notifyWebhook.command('list').description('列出已配置 Webhook').option('--json', '输出 JSON').action(options => handlers.notifyWebhookList?.(options));
  notifyWebhook.command('add')
    .description('新增一个 Webhook 通道')
    .requiredOption('--name <name>', '名称')
    .requiredOption('--url <url>', 'Webhook 地址')
    .option('--preset <preset>', 'generic / lark_webhook / dingtalk / wecom / bark / ntfy / slack / discord', 'generic')
    .option('--secret <secret>', '可选签名密钥')
    .option('--header <K=V>', '自定义请求头，可重复', collect, [])
    .option('--timeout <sec>', '超时秒数（1-30）', '8')
    .option('--events <list>', '限定事件：completed,failed,waiting_approval')
    .option('--disabled', '创建后暂不启用')
    .option('--json', '输出 JSON')
    .action(options => handlers.notifyWebhookAdd?.(options));
  notifyWebhook.command('update')
    .description('更新指定 Webhook')
    .argument('<webhook-id>')
    .option('--name <name>', '新名称')
    .option('--url <url>', '新地址')
    .option('--preset <preset>', '预设格式')
    .option('--secret <secret>', '更新密钥（传空串清除）')
    .option('--header <K=V>', '替换自定义请求头，可重复', collect, [])
    .option('--timeout <sec>', '超时秒数')
    .option('--events <list>', '限定事件')
    .option('--enabled', '启用')
    .option('--disabled', '停用')
    .option('--json', '输出 JSON')
    .action((id, options) => handlers.notifyWebhookUpdate?.(id, options));
  notifyWebhook.command('remove').description('删除指定 Webhook').argument('<webhook-id>').option('--json', '输出 JSON').action((id, options) => handlers.notifyWebhookRemove?.(id, options));
  const notifyCommand = notifyChannel.command('command').description('本地 Shell Hook 通知通道');
  notifyCommand.command('set')
    .description('配置本地命令 Hook（--trust-confirm 仅本机用户终端可用）')
    .option('--enabled', '启用命令 Hook')
    .option('--disabled', '停用命令 Hook')
    .option('--cmd <command>', '执行的 Shell 命令或脚本路径')
    .option('--timeout <sec>', '超时秒数（1-30）')
    .option('--trust-confirm', '确认信任本地命令执行风险（仅用户终端）')
    .option('--json', '输出 JSON')
    .action(options => handlers.notifyChannelCommandSet?.(options));
  notify.command('test')
    .description('向指定通知通道发送一条测试通知')
    .argument('<channel>', 'lark / webhook / command')
    .option('--webhook <id>', '测试指定 Webhook ID')
    .option('--json', '输出 JSON')
    .action((channel, options) => handlers.notifyTest?.(channel, options));

  const main = program.command('main').description('查看或指定主会话');
  main.command('show').description('查看当前主会话').option('--json', '输出 JSON').action(options => handlers.mainGet?.(options));
  main.command('set')
    .description('把现有会话设为主会话；不传 session-id 时新建')
    .argument('[session-id]', '现有会话 ID')
    .option('--agent <id>', '新建时使用的 Agent')
    .option('--cwd <dir>', '新建时的工作目录')
    .option('--model <model>', '新建时的模型')
    .option('--reasoning-effort <effort>', '新建时的 reasoning effort')
    .option('--name <name>', '小猫的名字（主会话在界面上的形象），默认「团子」')
    .option('--from <session-id>', '来源会话；默认 $agentdock_session_id')
    .option('--json', '输出 JSON')
    .action((sessionId, options) => handlers.mainSet?.(sessionId, options));
  main.command('clear').description('清除主会话设置').option('--json', '输出 JSON').action(options => handlers.mainClear?.(options));
  main.command('restore').description('恢复被误归档的当前主会话（解除归档并重新启动）').argument('[session-id]')
    .option('--json', '输出 JSON').action((sessionId, options) => handlers.mainRestore?.(sessionId, options));
  // 子命令和 handoff 本身都有 --json / --from：Commander 会让父命令先吃掉它们，子命令用 optsWithGlobals 取回。
  const handoff = main.command('handoff')
    .description('交接仪式：老猫退休、新猫接班。不带 --yes 只提议；--yes 由用户本人确认并执行（失败自动回滚）')
    .option('--yes', '确认并立刻执行仪式（只接受用户本人；Agent 只能提议）')
    .option('--name <name>', '新猫的名字；默认沿用')
    .option('--agent <id>', '接班 Agent；默认继承旧猫')
    .option('--model <id>', '接班模型；默认继承（换 Agent 时用新 Agent 默认）')
    .option('--reasoning <level>', '思考深度；默认继承（换 Agent 时用新 Agent 默认）')
    .option('--reason <text>', '交接原因')
    .option('--wait <seconds>', '--yes 时最多等多久，默认 180')
    .option('--from <session-id>', '来源会话；默认 $agentdock_session_id')
    .option('--json', '输出 JSON')
    .action(options => handlers.mainHandoff?.(options));
  handoff.command('show').description('交接进度、便签交接明细；不传 id 看最近一次').argument('[handoff-id]').option('--json', '输出 JSON')
    .action((id, _options, command: Command) => handlers.mainHandoffShow?.(id, command.optsWithGlobals()));
  handoff.command('cancel').description('婉拒交接提议（「再陪我一阵」）').argument('[handoff-id]')
    .option('--from <session-id>', '来源会话；默认 $agentdock_session_id').option('--json', '输出 JSON')
    .action((id, _options, command: Command) => handlers.mainHandoffCancel?.(id, command.optsWithGlobals()));
  handoff.command('resend').description('交接说明没送达时重发给新主会话').argument('<handoff-id>')
    .option('--from <session-id>', '来源会话；默认 $agentdock_session_id').option('--json', '输出 JSON')
    .action((id, _options, command: Command) => handlers.mainHandoffResend?.(id, command.optsWithGlobals()));
  main.command('lineage').description('血缘：每一代小猫和它的主会话 id（已退休的会话归档只读）').option('--json', '输出 JSON')
    .action(options => handlers.mainLineage?.(options));

  const maintenance = program.command('maintenance').description('主会话整理轮次：指标、阈值、手动整理（系统轮次，不派活、不删记录）');
  maintenance.command('status').description('指标、档位、阈值、最近整理').option('--json', '输出 JSON').action(options => handlers.maintenanceStatus?.(options));
  maintenance.command('run')
    .description('立刻开一轮整理（可见的系统轮次；同一时刻只跑一轮）')
    .option('--reason <text>', '整理原因')
    .option('--from <session-id>', '来源会话；默认 $agentdock_session_id')
    .option('--json', '输出 JSON')
    .action(options => handlers.maintenanceRun?.(options));
  maintenance.command('config')
    .description('查看或修改阈值与开关；不带参数时只查看')
    .option('--auto', '到整理档自动开整理轮次')
    .option('--no-auto', '关闭自动整理')
    .option('--auto-handoff', '到交接档自动生成交接提议（从不自动确认）')
    .option('--no-auto-handoff', '关闭自动提议交接')
    .option('--fold-after-hours <hours>', '整理时只折叠关闭超过这么久的便签')
    .option('--max-runs-per-day <n>', '自动整理每天最多几次')
    .option('--set <key=value>', '阈值，如 rounds.tidy=300、uptimeDays.handoff=off，可重复', collect, [])
    .option('--from <session-id>', '来源会话；默认 $agentdock_session_id')
    .option('--json', '输出 JSON')
    .action(options => handlers.maintenanceConfig?.(options));

  const notes = program.command('notes').description('便签墙与归档区：已关闭便签折叠进归档区（只读、可取出，不删除）');
  notes.command('list').description('列出墙上的便签；--archived 看归档区').option('--archived', '看归档区（按批次）').option('--json', '输出 JSON')
    .action(options => handlers.notesList?.(options));
  notes.command('archive')
    .description('把已关闭的便签折叠进归档区')
    .option('--task <task-id>', '指定便签，可重复', collect, [])
    .option('--closed-before-hours <hours>', '折叠关闭超过这么久的便签')
    .option('--reason <text>', '原因')
    .option('--from <session-id>', '来源会话；默认 $agentdock_session_id')
    .option('--json', '输出 JSON')
    .action(options => handlers.notesArchive?.(options));
  notes.command('unarchive')
    .description('从归档区取出便签')
    .option('--batch <batch-id>', '取出一整批')
    .option('--task <task-id>', '取出单张，可重复', collect, [])
    .option('--from <session-id>', '来源会话；默认 $agentdock_session_id')
    .option('--json', '输出 JSON')
    .action(options => handlers.notesUnarchive?.(options));

  const draft = program.command('draft').description('对外回复草稿：确认后才发送');
  draft.command('create')
    .description('创建草稿')
    .requiredOption('--channel <channel>', 'github_comment / lark_reply')
    .option('--target <target>', '如 github:owner/repo#12；lark_reply 可改用 --chat')
    .option('--body-file <file>', '正文文件；- 表示 stdin')
    .option('--chat <chat>', 'lark_reply 目标群名或 chat_id')
    .option('--reply-to <target>', 'lark_reply 回复目标：om_* / 数字 rootId / 关键字')
    .option('--in-thread', 'lark_reply 在话题内回复')
    .option('--at <user>', 'lark_reply 要 @ 的姓名、ou_* open_id 或数字 userId，可重复', collect, [])
    .option('--task <task-id>', '关联事项')
    .option('--from <session-id>', '来源会话；默认 $agentdock_session_id')
    .option('--json', '输出 JSON')
    .action(options => handlers.draftCreate?.(options));
  draft.command('list').description('列出草稿').option('--json', '输出 JSON').action(options => handlers.draftList?.(options));
  draft.command('send').description('发送草稿').argument('<draft-id>').option('--json', '输出 JSON').action((id, options) => handlers.draftSend?.(id, options));
  draft.command('discard').description('丢弃草稿').argument('<draft-id>').option('--json', '输出 JSON').action((id, options) => handlers.draftDiscard?.(id, options));

  const dev = program.command('dev').description('Isolated sandbox daemon for developing AgentDock itself (separate HOME, database and port; never touches the running instance)');
  dev.command('up')
    .description('Start (or restart onto the latest build) a sandbox daemon from this repo\'s apps/server/dist')
    .option('--port <port>', 'Preferred port (default 4399, falls back to a free one)')
    .option('--repo <dir>', 'agent-dock source repo (defaults to the enclosing repo of the current directory)')
    .action(options => handlers.devUp?.(options));
  dev.command('run')
    .description('Run an agent-dock command against the sandbox, e.g. agent-dock dev run -- schedule list --all')
    .argument('<args...>', 'agent-dock arguments')
    .option('--repo <dir>', 'agent-dock source repo')
    .allowUnknownOption()
    .action((args, options) => handlers.devRun?.(args, options));
  dev.command('env')
    .description('Print sandbox URL, database and paths as JSON (for scripts and browser checks)')
    .option('--repo <dir>', 'agent-dock source repo')
    .action(options => handlers.devEnv?.(options));
  dev.command('down')
    .description('Stop the sandbox and delete its data')
    .option('--keep-data', 'Stop but keep the sandbox database for inspection')
    .option('--repo <dir>', 'agent-dock source repo')
    .action(options => handlers.devDown?.(options));

  const schedule = program.command('schedule').description('Register and manage AgentDock scheduled prompts (persisted by the daemon, survive restarts)');
  schedule.command('add')
    .alias('create')
    .description('Register a scheduled prompt; defaults to the current session (agentdock_session_id)')
    .argument('<prompt>', 'Prompt delivered to the session when the schedule fires')
    .option('--cron <expr>', 'Recurring 5-field cron expression, e.g. "0 9 * * 1-5"')
    .option('--every <interval>', 'Fixed interval from now, e.g. 45m, 2h, 1h30m, 1d (not limited to divisors of 60 like cron)')
    .option('--at <time>', 'One-shot trigger time, e.g. "2026-10-14 18:00" (local) or ISO 8601')
    .option('--tz <timezone>', 'IANA timezone for --cron, defaults to the machine timezone')
    .option('--name <name>', 'Short label shown in lists')
    .option('--delivery <mode>', 'new_session (default: fresh session each run) or append (continue in the bound session)')
    .option('--session <session-id>', 'Bind to this session (use "main" to dynamically follow the active main session)')
    .option('--main', 'Dynamically follow the active main session (shorthand for --session main; survives handoff)')
    .option('--from <session-id>', 'Source session ID (defaults to agentdock_session_id)')
    .option('--json', 'Output the created schedule as JSON')
    .action((prompt, options) => handlers.scheduleAdd?.(prompt, options));
  schedule.command('update')
    .description('Update an existing schedule (prompt, timing, delivery, or target session)')
    .argument('<schedule-id>', 'Schedule ID (sch_*)')
    .option('--prompt <prompt>', 'Updated prompt text')
    .option('--name <name>', 'Updated short label')
    .option('--cron <expr>', 'Switch to a 5-field cron expression')
    .option('--every <interval>', 'Switch to a fixed interval, e.g. 45m, 2h, 1d')
    .option('--at <time>', 'Switch to a one-shot trigger time')
    .option('--tz <timezone>', 'IANA timezone for --cron')
    .option('--delivery <mode>', 'new_session or append')
    .option('--session <session-id>', 'Rebind to this session (use "main" to dynamically follow the active main session)')
    .option('--main', 'Dynamically follow the active main session (shorthand for --session main)')
    .option('--from <session-id>', 'Source session ID (defaults to agentdock_session_id)')
    .option('--json', 'Output the updated schedule as JSON')
    .action((id, options) => handlers.scheduleUpdate?.(id, options));
  schedule.command('list')
    .description('List schedules of the current session (all schedules outside a session)')
    .option('--all', 'List schedules of every session')
    .option('--session <session-id>', 'List schedules bound to this session (use "main" for main-following schedules)')
    .option('--main', 'List schedules dynamically following the active main session')
    .option('--json', 'Output raw schedule rows as JSON')
    .action(options => handlers.scheduleList?.(options));
  schedule.command('show')
    .description('Show one schedule with its recent runs')
    .argument('<schedule-id>', 'Schedule ID (sch_*)')
    .option('--json', 'Output raw schedule and runs as JSON')
    .action((id, options) => handlers.scheduleShow?.(id, options));
  for (const [name, description, handler] of [
    ['pause', 'Pause a schedule', 'schedulePause'],
    ['resume', 'Resume a paused schedule from its next future slot', 'scheduleResume'],
    ['run', 'Fire a schedule once now without changing its plan', 'scheduleRun'],
    ['remove', 'Delete a schedule', 'scheduleRemove']
  ] as const) {
    schedule.command(name)
      .description(description)
      .argument('<schedule-id>', 'Schedule ID (sch_*)')
      .option('--json', 'Output the result as JSON')
      .action((id, options) => handlers[handler]?.(id, options));
  }
  schedule.addHelpText('after', `
Schedules are persisted by the AgentDock daemon and survive session shutdown and restarts. Use them for
anything timed, recurring or "remind me at X" -- not CronCreate, ScheduleWakeup, /loop, crontab, nohup or sleep
loops, which all die with the session.

Examples:
  $ agent-dock schedule add "汇总昨天的告警" --cron "0 9 * * 1-5" --name "工作日早报"
  $ agent-dock schedule add "检查发布状态" --every 45m          # also 2h, 1h30m, 1d
  $ agent-dock schedule add "提醒我开会" --at "2026-10-14 18:00"   # local time; --tz for another zone
  $ agent-dock schedule add "继续跟进" --every 1h --delivery append
  $ agent-dock schedule add "每日巡检" --cron "0 9 * * *" --delivery append --main   # follow active main session across handoffs
  $ agent-dock schedule update sch_xxx --main --delivery append
  $ agent-dock schedule list
  $ agent-dock schedule show|pause|resume|run|remove SCHEDULE_ID

Delivery:
  new_session (default)  each run opens a fresh session under the current one; good for checks, digests, reminders.
  append                 each run continues in the current session; use when it must build on earlier results.

Notes:
  Write the prompt as a complete, self-contained instruction: a new session cannot see this conversation.
  After adding, tell the user the next fire time printed by the command.`);

  const commonSourceOptions = (command: Command) => command
    .option('--database <file>', 'SQLite database path (defaults to the running daemon database)')
    .option('--json', 'Output raw JSON');
  const sources = program.command('source').description('管理外部消息源、规范化事件与试跑');
  sources.command('add')
    .description('创建消息源；密钥用 secret 名称引用，日志和列表不回显明文')
    .argument('<name>', '消息源名称')
    .option('--kind <kind>', 'webhook | poll | stream | worker', 'webhook')
    .option('--config <json>', 'Source config JSON')
    .option('--secret-ref <name>', '环境变量名称引用，可重复', (value: string, previous: string[]) => [...previous, value], [] as string[])
    .option('--secret-env <NAME=value>', '写入密钥值，可重复；生产环境建议只用 secret-ref', (value: string, previous: string[]) => [...previous, value], [] as string[])
    .option('--disabled', '创建后保持禁用')
    .option('--database <file>', 'SQLite database path (defaults to the running daemon database)')
    .option('--json', 'Output raw JSON')
    .action((name, options) => handlers.sourceAdd?.(name, { ...options, enabled: !options.disabled }));
  commonSourceOptions(sources.command('list').description('列出消息源（不返回 secret 明文）')).action(options => handlers.sourceList?.(options));
  commonSourceOptions(sources.command('show').description('查看一个消息源').argument('<source-id>', 'Source ID (src_*)')).action((id, options) => handlers.sourceShow?.(id, options));
  commonSourceOptions(sources.command('enable').description('启用消息源').argument('<source-id>', 'Source ID (src_*)')).action((id, options) => handlers.sourceEnable?.(id, options));
  commonSourceOptions(sources.command('disable').description('禁用消息源').argument('<source-id>', 'Source ID (src_*)')).action((id, options) => handlers.sourceDisable?.(id, options));
  commonSourceOptions(sources.command('logs').description('查看最近事件日志').argument('<source-id>', 'Source ID (src_*)')).option('--limit <count>', '最多显示条数', '20').action((id, options) => handlers.sourceLogs?.(id, options));
  commonSourceOptions(sources.command('test').description('用 fixture 试跑规范化与 Router 决策，不落库').argument('<source-id>', 'Source ID (src_*)').argument('[fixture]', 'JSON fixture 路径；省略时从 stdin 读取')).action((id, fixture, options) => handlers.sourceTest?.(id, fixture, options));
  commonSourceOptions(sources.command('update').description('更新消息源名称或配置').argument('<source-id>', 'Source ID (src_*)'))
    .option('--name <name>', '新名称')
    .option('--config <json>', 'Source config JSON')
    .option('--secret-ref <name>', '环境变量名称引用，可重复', (value: string, previous: string[]) => [...previous, value], [] as string[])
    .option('--secret-env <NAME=value>', '写入密钥值，可重复', (value: string, previous: string[]) => [...previous, value], [] as string[])
    .action((id, options) => handlers.sourceUpdate?.(id, options));

  const cases = program.command('case').description('查看 Case 聚合、时间线并关闭跟踪');
  commonSourceOptions(cases.command('list').description('列出 Case')).option('--source <source-id>', '按消息源过滤').option('--status <status>', 'open | waiting | closed').action(options => handlers.caseList?.(options));
  commonSourceOptions(cases.command('show').description('查看 Case 详情与时间线').argument('<case-id>', 'Case ID (case_*)')).action((id, options) => handlers.caseShow?.(id, options));
  commonSourceOptions(cases.command('events').description('查看 Case 时间线').argument('<case-id>', 'Case ID (case_*)')).action((id, options) => handlers.caseEvents?.(id, options));
  commonSourceOptions(cases.command('close').description('关闭 Case；保留历史，释放 open_key').argument('<case-id>', 'Case ID (case_*)')).option('--reason <reason>', '关闭原因').action((id, options) => handlers.caseClose?.(id, options));

  const router = program.command('router').description('查看 Router 状态、打开固定会话并做无副作用试跑');
  commonSourceOptions(router.command('status').description('查看 Router Session、Inbox、Source 与 Case')).action(options => handlers.routerStatus?.(options));
  commonSourceOptions(router.command('open').description('显示或触发 Router Session 懒创建')).action(options => handlers.routerOpen?.(options));
  commonSourceOptions(router.command('dry-run').description('用 fixture 返回 Router 决策，不创建会话或动作').argument('[fixture]', 'JSON fixture 路径；省略时从 stdin 读取')).option('--source <source-id>', '消息源 ID').action((fixture, options) => handlers.routerDryRun?.(fixture, options));

  const password = program.command('password').description('Manage the optional Web console password (stored as a scrypt hash in ~/.agentdock/web-password)');
  password.command('set')
    .description('Set or change the password; prompts without echo (or reads one line from stdin when piped)')
    .option('--stdin', 'Read the password from stdin instead of prompting')
    .action(options => handlers.passwordSet?.(options));
  password.command('clear')
    .description('Remove the password; only credential links and local access remain')
    .action(() => handlers.passwordClear?.());
  password.command('status')
    .description('Show whether a password is set')
    .action(() => handlers.passwordStatus?.());
  password.addHelpText('after', `
Without a password, the console is reachable only through the credential link printed at startup, Lark card
links, or direct local access. With a password, entering it on the login page also grants full access.
Changes take effect immediately; no restart needed.`);

  program.command('update')
    .description('Update the global AgentDock package and restart the background service')
    .option('--dist-tag <tag>', 'npm dist-tag to install (default: latest)', 'latest')
    .action(options => handlers.update?.(options));

  const autostart = program.command('autostart').description('Start AgentDock automatically at login (macOS launchd)');
  for (const [action, description] of [['enable', 'Install the login item (runs `agent-dock start` at login)'], ['disable', 'Remove the login item'], ['status', 'Show whether the login item is installed']] as const) {
    autostart.command(action).description(description).option('--json', 'Output raw JSON').action(options => handlers.autostart?.(action, options));
  }

  const addProcessCommands = (parent: Command) => {
    addServerOptions(parent.command('start')
      .description('Start the AgentDock server in the background'))
      .action((options, command) => handlers.daemonStart?.(serverOptionsFrom(options, command)));
    parent.command('stop')
      .description('Stop the background AgentDock server')
      .action(() => handlers.daemonStop?.());
    addServerOptions(parent.command('restart')
      .description('Restart the background AgentDock server'))
      .action((options, command) => handlers.daemonRestart?.(serverOptionsFrom(options, command)));
    parent.command('status')
      .description('Show whether the background AgentDock server is running')
      .option('--json', 'Output raw status as JSON')
      .action(options => handlers.daemonStatus?.(options));
  };

  // Both the top-level `agent-dock start/stop/restart/status` (no prefix) and the
  // `agent-dock daemon start/.../status` group are supported and share one implementation.
  addProcessCommands(program);
  const daemon = program.command('daemon').description('Run the AgentDock server in the background and manage it');
  addProcessCommands(daemon);

  const usage = program.command('usage').description('查询真实的 Token 消耗、TPS 与多维统计看板（供人与 Agent 调用）');
  const addUsageFilterOptions = (cmd: Command) => cmd
    .option('--from <date>', '起始时间（支持 today / 7d / 30d / YYYY-MM-DD / ISO 时间）')
    .option('--to <date>', '结束时间（支持 YYYY-MM-DD / ISO 时间）')
    .option('--agent <id>', '按 Agent ID 筛选（如 claude / codex / antigravity）')
    .option('--project <pathOrName>', '按项目目录或项目名筛选')
    .option('--session <id>', '按会话 ID 筛选')
    .option('--model <name>', '按模型名筛选')
    .option('--json', '输出 JSON');
  addUsageFilterOptions(usage.command('summary').description('查询总消耗、平均 TPS 与按日趋势'))
    .action(async (options: UsageFilterCliOptions) => { await handlers.usageSummary?.(options); });
  addUsageFilterOptions(usage.command('breakdown').description('按项目 / Agent / 会话 / 模型维度分组统计消耗'))
    .option('--by <dimension>', '分组维度：project | agent | session | model（默认 project）')
    .option('--limit <n>', '最多返回条数（默认 50）')
    .action(async (options: UsageBreakdownCliOptions) => { await handlers.usageBreakdown?.(options); });
  usage.command('session [session-id]')
    .description('查询指定会话（默认当前 $agentdock_session_id）的累计消耗、TPS 与逐轮明细')
    .option('--json', '输出 JSON')
    .action(async (sessionId: string | undefined, options: UsageSessionCliOptions) => { await handlers.usageSession?.(sessionId, options); });
  usage.command('quota [agent]')
    .description('查询账号额度窗口（all / codex / claude / cursor / antigravity）')
    .option('--refresh', '跳过缓存强制实时拉取')
    .option('--json', '输出 JSON')
    .action(async (agent: string | undefined, options: UsageQuotaCliOptions) => { await handlers.usageQuota?.(agent, options); });

  const board = program.command('board').description('自由拖拽看板：一屏盯盘、定制看板/列、编排卡片并与主小猫联动');
  board.command('list')
    .description('列出全部看板（带 * 为当前默认记忆看板）')
    .option('--archived', '包含已归档看板')
    .option('--json', '输出 JSON')
    .option('-q, --quiet', '仅输出看板 ID')
    .action(options => handlers.boardList?.(options));
  board.command('create')
    .description('新建一个自定义看板（支持默认运行状态 / 空白自由 / 按项目模板）')
    .argument('<name>', '看板名称')
    .option('--template <tpl>', '模板：status / blank / project', 'blank')
    .option('--desc <text>', '看板说明')
    .option('--view <mode>', '视图模式：lanes 或 grid', 'lanes')
    .option('--density <density>', '卡片密度：compact 或 comfortable', 'compact')
    .option('--default', '创建后立即设为默认活跃看板')
    .option('--from <session-id>', '来源会话')
    .option('--json', '输出 JSON')
    .option('-q, --quiet', '仅输出看板 ID')
    .action((name, options) => handlers.boardCreate?.(name, options));
  board.command('show')
    .description('查看看板全部列与实时进度卡片（--watch 进入实时终端盯盘）')
    .argument('[board-id]', '看板 ID；默认当前活跃看板')
    .option('--column <idOrName>', '只看指定列')
    .option('--state <state>', '按视觉状态筛选')
    .option('--watch', '订阅 SSE 实时盯盘刷新')
    .option('--json', '输出 JSON')
    .option('-q, --quiet', '仅输出看板 ID')
    .action((boardId, options) => handlers.boardShow?.(boardId, options));
  board.command('update')
    .description('更新看板名称、视图模式、密度或默认状态')
    .argument('<board-id>', '看板 ID（支持 default）')
    .option('--name <name>', '新名称')
    .option('--desc <text>', '新说明')
    .option('--view <mode>', 'lanes 或 grid')
    .option('--density <density>', 'compact 或 comfortable')
    .option('--default', '设为默认活跃看板')
    .option('--from <session-id>', '来源会话')
    .option('--json', '输出 JSON')
    .option('-q, --quiet', '仅输出看板 ID')
    .action((boardId, options) => handlers.boardUpdate?.(boardId, options));
  board.command('use')
    .description('切换默认活跃看板（记忆并同步到前端快速切换）')
    .argument('<board-id>', '看板 ID')
    .option('--from <session-id>', '来源会话')
    .option('--json', '输出 JSON')
    .option('-q, --quiet', '仅输出看板 ID')
    .action((boardId, options) => handlers.boardUse?.(boardId, options));
  board.command('delete')
    .description('删除或归档看板（不删除底层便签与会话）')
    .argument('<board-id>', '看板 ID')
    .option('--archive', '归档而非永久删除')
    .option('--from <session-id>', '来源会话')
    .option('--json', '输出 JSON')
    .option('-q, --quiet', '仅输出看板 ID')
    .action((boardId, options) => handlers.boardDelete?.(boardId, options));
  board.command('export')
    .description('导出看板列结构与规则模板为 JSON')
    .argument('[board-id]', '看板 ID；默认当前活跃看板')
    .option('--file <path>', '输出到文件；- 或省略打印到 stdout')
    .option('--include-items', '包含手动编排卡片列表')
    .option('--json', '输出 JSON')
    .action((boardId, options) => handlers.boardExport?.(boardId, options));
  board.command('import')
    .description('从模板 JSON 文件或 stdin(-) 导入并创建看板')
    .argument('<file>', '模板路径或 -')
    .option('--name <name>', '覆盖看板名称')
    .option('--default', '导入后设为默认活跃看板')
    .option('--from <session-id>', '来源会话')
    .option('--json', '输出 JSON')
    .option('-q, --quiet', '仅输出看板 ID')
    .action((file, options) => handlers.boardImport?.(file, options));
  board.command('ask-kitten')
    .description('圈选看板中的一张或多张卡片交给主小猫处理')
    .argument('[board-id]', '看板 ID；默认当前活跃看板')
    .option('--cards <ids>', '逗号分隔的卡片 ID（bitem_* / virt:* / atask_* / ses_*）')
    .option('--prompt <text>', '指令内容')
    .option('--prompt-file <file>', '从文件读指令；- 表示 stdin')
    .option('--from <session-id>', '来源会话')
    .option('--json', '输出 JSON')
    .action((boardId, options) => handlers.boardAskKitten?.(boardId, options));

  const boardColumn = board.command('column').description('管理看板自定义列与智能规则列');
  boardColumn.command('list')
    .description('列出看板全部列')
    .argument('[board-id]', '看板 ID；默认当前活跃看板')
    .option('--json', '输出 JSON')
    .option('-q, --quiet', '仅输出列 ID')
    .action((boardId, options) => handlers.boardColumnList?.(boardId, options));
  boardColumn.command('add')
    .description('新建一列（手动列或智能规则列）')
    .argument('[board-id]', '看板 ID；默认当前活跃看板')
    .requiredOption('--name <name>', '列名称')
    .option('--color <color>', '色标：zinc / blue / amber / orange / emerald / sky / red', 'zinc')
    .option('--wip <n>', 'WIP 上限提醒（0 表示不限）')
    .option('--collapsed', '默认折叠为细条')
    .option('--rule <json>', '智能规则 JSON，如 \'{"taskStates":["running"]}\'')
    .option('--on-drop <action>', '拖入动作：none / start_plan / archive_session / prompt_kitten', 'none')
    .option('--before <col-id>', '插在该列之前')
    .option('--after <col-id>', '插在该列之后')
    .option('--from <session-id>', '来源会话')
    .option('--json', '输出 JSON')
    .option('-q, --quiet', '仅输出列 ID')
    .action((boardId, options) => handlers.boardColumnAdd?.(boardId, options));
  boardColumn.command('update')
    .description('修改列名称、色标、折叠态、WIP 或智能规则')
    .argument('<col-id>', '列 ID（bcol_*）')
    .option('--name <name>', '新名称')
    .option('--color <color>', '新色标')
    .option('--wip <n>', 'WIP 上限（0 清除）')
    .option('--collapsed', '折叠为细条')
    .option('--expanded', '展开列')
    .option('--rule <json|clear>', '设置新规则 JSON，传 clear 改为纯手动列')
    .option('--on-drop <action>', '拖入动作')
    .option('--from <session-id>', '来源会话')
    .option('--json', '输出 JSON')
    .option('-q, --quiet', '仅输出列 ID')
    .action((colId, options) => handlers.boardColumnUpdate?.(colId, options));
  boardColumn.command('move')
    .description('调整列的横向顺序')
    .argument('<col-id>', '列 ID（bcol_*）')
    .option('--before <col-id>', '移到该列之前')
    .option('--after <col-id>', '移到该列之后')
    .option('--index <n>', '移到第 N 个位置（0-based）')
    .option('--from <session-id>', '来源会话')
    .option('--json', '输出 JSON')
    .action((colId, options) => handlers.boardColumnMove?.(colId, options));
  boardColumn.command('delete')
    .description('删除一列（可选先将卡片迁移到其他列）')
    .argument('<col-id>', '列 ID（bcol_*）')
    .option('--move-cards-to <col-id>', '将列内卡片迁移到此列')
    .option('--from <session-id>', '来源会话')
    .option('--json', '输出 JSON')
    .action((colId, options) => handlers.boardColumnDelete?.(colId, options));

  const boardCard = board.command('card').description('编排看板卡片（关联便签 atask_*、会话 ses_* 或轻量文字便签）');
  boardCard.command('list')
    .description('列出看板上的卡片')
    .argument('[board-id]', '看板 ID；默认当前活跃看板')
    .option('--column <idOrName>', '按列过滤')
    .option('--kind <kind>', 'task / session / note')
    .option('--state <state>', '按视觉状态过滤')
    .option('--agent <id>', '按 Agent 过滤')
    .option('--tag <tag>', '按标签过滤')
    .option('--pinned', '仅看置顶卡片')
    .option('--json', '输出 JSON')
    .option('-q, --quiet', '仅输出卡片 ID')
    .action((boardId, options) => handlers.boardCardList?.(boardId, options));
  boardCard.command('add')
    .description('将便签、会话或纯文字卡片添加到看板指定列')
    .argument('[board-id]', '看板 ID；默认当前活跃看板')
    .requiredOption('--column <col-id>', '目标列 ID')
    .option('--task <task-id>', '关联主小猫便签（atask_*）')
    .option('--session <session-id>', '关联普通会话（ses_*）')
    .option('--title <text>', '新建纯文字卡片内容')
    .option('--note <text>', '用户备注')
    .option('--kitten-note <text>', '主小猫督办批注')
    .option('--tag <tag>', '标签，可重复', collect, [])
    .option('--pin', '置顶于列首')
    .option('--top', '插入列顶部')
    .option('--bottom', '追加到列底部')
    .option('--from <session-id>', '来源会话')
    .option('--json', '输出 JSON')
    .option('-q, --quiet', '仅输出卡片 ID')
    .action((boardId, options) => handlers.boardCardAdd?.(boardId, options));
  boardCard.command('move')
    .description('移动单张或多张卡片到指定列（自动记住 manual_override 防被规则吸回）')
    .argument('<card-ids...>', '卡片 ID（支持多个批量移动）')
    .requiredOption('--to-column <col-id>', '目标列 ID')
    .option('--board <board-id>', '看板 ID；默认当前活跃看板')
    .option('--before <card-id>', '插到该卡之前')
    .option('--after <card-id>', '插到该卡之后')
    .option('--top', '放到列首')
    .option('--bottom', '放到列尾')
    .option('--apply-action', '显式触发目标列绑定的落入动作')
    .option('--from <session-id>', '来源会话')
    .option('--json', '输出 JSON')
    .action((cardIds, options) => handlers.boardCardMove?.(cardIds, options));
  boardCard.command('update')
    .description('更新卡片备注、小猫批注、标签、置顶或重置规则归位')
    .argument('<card-id>', '卡片 ID')
    .option('--board <board-id>', '看板 ID；默认当前活跃看板')
    .option('--note <text>', '用户备注')
    .option('--kitten-note <text>', '主小猫督办/验收批注')
    .option('--add-tag <tag>', '新增标签，可重复', collect, [])
    .option('--remove-tag <tag>', '移除标签，可重复', collect, [])
    .option('--pin', '置顶')
    .option('--unpin', '取消置顶')
    .option('--reset-rule-override', '解除手动锁位，让智能规则列重新自动接管')
    .option('--from <session-id>', '来源会话')
    .option('--json', '输出 JSON')
    .option('-q, --quiet', '仅输出卡片 ID')
    .action((cardId, options) => handlers.boardCardUpdate?.(cardId, options));
  boardCard.command('remove')
    .description('从看板移出卡片（不删除底层便签或会话）')
    .argument('<card-ids...>', '卡片 ID')
    .option('--board <board-id>', '看板 ID；默认当前活跃看板')
    .option('--from <session-id>', '来源会话')
    .option('--json', '输出 JSON')
    .action((cardIds, options) => handlers.boardCardRemove?.(cardIds, options));

  const theme = program.command('theme').description('管理自定义配色主题、导入 VS Code 主题插件（.vsix/.json/.jsonc/Marketplace）并实时换肤');
  theme.command('list')
    .description('列出全部内置精选与自定义主题及当前激活偏好')
    .option('--json', '输出 JSON')
    .action(options => handlers.themeList?.(options));
  theme.command('create')
    .description('创建或更新自定义配色主题（自动执行 WCAG 对比度守护，--apply 实时热切换）')
    .option('--id <id>', '指定主题 ID（更新已有自定义主题时使用）')
    .option('--name <name>', '主题名称')
    .option('--mode <mode>', '极性：light 或 dark')
    .option('--tokens <json>', '语义色板 JSON（含 bgCanvas/bgSidebar/bgSurface/textPrimary/accent 等）')
    .option('--from-file <path>', '从 JSON/JSONC 文件读取主题定义或色板')
    .option('--description <text>', '主题简短描述')
    .option('--source <source>', '来源标签：custom 或 ai（默认 custom）')
    .option('--apply', '创建后立即生效并通过 SSE 实时广播到所有客户端')
    .option('--json', '输出 JSON')
    .action(options => handlers.themeCreate?.(options));
  theme.command('import-vscode')
    .description('从 .vsix 插件包、.json/.jsonc 主题文件、本机扩展目录或 Marketplace 链接/ID 导入主题')
    .argument('<source>', '.vsix / .json / .jsonc 路径、扩展目录、Marketplace URL 或 publisher.extension')
    .option('--variant <labelOrIndex>', '多变体主题包时指定要导入的变体名称或序号')
    .option('--all', '导入主题包内的全部变体')
    .option('--apply', '导入后立即生效并通过 SSE 实时换肤')
    .option('--json', '输出 JSON')
    .action((source, options) => handlers.themeImportVsCode?.(source, options));
  theme.command('apply')
    .description('切换当前生效主题（按 ID 或名称），或切换亮/暗/跟随系统模式')
    .argument('[id-or-name]', '主题 ID 或名称（如 builtin-tokyo-night 或 "京都抹茶浅色"）')
    .option('--mode <mode>', '切换模式偏好：system / light / dark')
    .option('--json', '输出 JSON')
    .action((idOrName, options) => handlers.themeApply?.(idOrName, options));
  theme.command('reset')
    .description('恢复默认主题偏好（跟随系统 · 默认浅色 / 默认深色）')
    .option('--json', '输出 JSON')
    .action(options => handlers.themeReset?.(options));
  theme.command('delete')
    .description('删除自定义主题（不可删除内置主题）')
    .argument('<id>', '自定义主题 ID')
    .option('--json', '输出 JSON')
    .action((id, options) => handlers.themeDelete?.(id, options));
  theme.command('export')
    .description('将指定主题导出为完整 JSON')
    .argument('<id-or-name>', '主题 ID 或名称')
    .option('-o, --output <path>', '输出到文件路径；不传则打印到标准输出')
    .option('--json', '输出 JSON（搭配 --output 时输出结构化结果）')
    .action((idOrName, options) => handlers.themeExport?.(idOrName, options));

  return program
    .addHelpText('after', `
Examples:
  $ agent-dock
  $ agent-dock --local-only
  $ agent-dock --cwd /path/to/project --port 4310
  $ agent-dock start --port 4310
  $ agent-dock status
  $ agent-dock restart --port 4410
  $ agent-dock update --dist-tag fix
  $ agent-dock autostart enable
  $ agent-dock stop
  $ agent-dock daemon start --port 4310
  $ agent-dock daemon status
  $ agent-dock acpx agents list --json
  $ agent-dock lark send "**任务已完成**"
  $ agent-dock lark update "**最新结果**" --message-id om_xxx
  $ agent-dock lark message send --chat oc_xxx --text "构建完成"
  $ agent-dock lark message read --chat oc_xxx --limit 20
  $ agent-dock lark message listen --chat oc_xxx
  $ agent-dock group peers
  $ agent-dock group members
  $ agent-dock group send "请检查接口" --to cli_peer
  $ agent-dock --version`);
}

export function environmentFromCli(options: CliOptions, base: NodeJS.ProcessEnv = process.env) {
  const env = { ...base };
  if (options.host !== undefined) env.AGENTDOCK_HOST = options.host;
  if (options.localOnly === true) env.AGENTDOCK_LOCAL_ONLY = 'true';
  if (options.port !== undefined) env.AGENTDOCK_PORT = options.port;
  if (options.cwd !== undefined) env.AGENTDOCK_DEFAULT_CWD = options.cwd;
  if (options.database !== undefined) env.AGENTDOCK_DATABASE_URL = options.database;
  if (options.idleTimeoutMs !== undefined) env.AGENTDOCK_DRIVER_IDLE_TIMEOUT_MS = options.idleTimeoutMs;
  if (options.cleanupIntervalMs !== undefined) env.AGENTDOCK_CLEANUP_INTERVAL_MS = options.cleanupIntervalMs;
  if (options.larkAppId !== undefined) env.LARK_APP_ID = options.larkAppId;
  if (options.larkAppSecret !== undefined) env.LARK_APP_SECRET = options.larkAppSecret;
  if (options.larkReceiveId !== undefined) env.LARK_RECEIVE_ID = options.larkReceiveId;
  if (options.larkChatId !== undefined) env.LARK_CHAT_ID = options.larkChatId;
  if (options.larkReceiveIdType !== undefined) env.LARK_RECEIVE_ID_TYPE = options.larkReceiveIdType;
  if (options.larkAgentName !== undefined) env.LARK_AGENT_NAME = options.larkAgentName;
  if (options.larkBaseUrl !== undefined) env.LARK_OPEN_API_BASE_URL = options.larkBaseUrl;
  if (options.larkListen === false) env.AGENTDOCK_DISABLE_LARK_LISTENER = 'true';
  return env;
}
