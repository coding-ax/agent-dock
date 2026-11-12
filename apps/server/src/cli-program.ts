import { Command } from 'commander';
import type { DaemonReadyInfo } from './daemon/command.js';
import type {
  CaseCloseCliOptions, CaseListCliOptions, SourceAddCliOptions, SourceRouterCliOptions,
  SourceTestCliOptions, SourceUpdateCliOptions
} from './sources-router/cli.js';
import type {
  AssistantCliOptions, DraftCreateCliOptions, MainCliOptions, NotifyCliOptions,
  SettingsCliOptions, TaskReportCliOptions, TaskReviewCliOptions, TaskStartCliOptions,
  WatchAddCliOptions
} from './assistant/cli.js';
import type {
  LarkMessageListenCliOptions, LarkMessageReadCliOptions, LarkMessageSendCliOptions
} from './lark/message-cli.js';

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

export interface ScheduleAddCliOptions { cron?: string; every?: string; at?: string; tz?: string; name?: string; delivery?: string; session?: string; from?: string; json?: boolean }
export interface ScheduleListCliOptions { all?: boolean; session?: string; json?: boolean }
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
  settingsGet?(options: AssistantCliOptions): void | Promise<void>;
  settingsQuietHours?(options: SettingsCliOptions): void | Promise<void>;
  draftCreate?(options: DraftCreateCliOptions): void | Promise<void>;
  draftList?(options: AssistantCliOptions): void | Promise<void>;
  draftSend?(id: string, options: AssistantCliOptions): void | Promise<void>;
  draftDiscard?(id: string, options: AssistantCliOptions): void | Promise<void>;
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
const serverOptionsFrom = (options: CliOptions, command: Command): CliOptions => ({ ...command.optsWithGlobals(), ...options });

export function createCliProgram(version: string, handlers: CliHandlers = {}) {
  const program = new Command()
    .name('agent-dock')
    .description('Run the AgentDock local session server')
    .version(version, '-V, --version', 'Show the installed version');

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

  program.command('notify')
    .description('让主会话主动通知用户；免打扰默认关闭')
    .argument('<text>', '通知内容')
    .option('--ask', '需要用户拍板')
    .option('--urgent', '绕过免打扰')
    .option('--from <session-id>', '来源会话；默认 $agentdock_session_id')
    .option('--json', '输出 JSON')
    .action((text, options) => handlers.notify?.(text, options));

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

  const settings = program.command('settings').description('主会话设置');
  settings.command('show').description('查看设置').option('--json', '输出 JSON').action(options => handlers.settingsGet?.(options));
  settings.command('quiet-hours')
    .description('设置免打扰时段（默认关闭）')
    .option('--enabled', '开启免打扰')
    .option('--off', '关闭免打扰')
    .option('--start <HH:MM>', '开始时间')
    .option('--end <HH:MM>', '结束时间')
    .option('--from <session-id>', '来源会话；默认 $agentdock_session_id')
    .option('--json', '输出 JSON')
    .action(options => handlers.settingsQuietHours?.(options));

  const draft = program.command('draft').description('对外回复草稿：确认后才发送');
  draft.command('create')
    .description('创建草稿')
    .requiredOption('--channel <channel>', 'github_comment / lark_reply')
    .requiredOption('--target <target>', '如 github:owner/repo#12')
    .option('--body-file <file>', '正文文件；- 表示 stdin')
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
    .description('Register a scheduled prompt; defaults to the current session (agentdock_session_id)')
    .argument('<prompt>', 'Prompt delivered to the session when the schedule fires')
    .option('--cron <expr>', 'Recurring 5-field cron expression, e.g. "0 9 * * 1-5"')
    .option('--every <interval>', 'Fixed interval from now, e.g. 45m, 2h, 1h30m, 1d (not limited to divisors of 60 like cron)')
    .option('--at <time>', 'One-shot trigger time, e.g. "2026-10-14 18:00" (local) or ISO 8601')
    .option('--tz <timezone>', 'IANA timezone for --cron, defaults to the machine timezone')
    .option('--name <name>', 'Short label shown in lists')
    .option('--delivery <mode>', 'new_session (default: fresh session each run) or append (continue in the bound session)')
    .option('--session <session-id>', 'Bind to this session instead of the current one (current session or its linked main/side sessions only)')
    .option('--from <session-id>', 'Source session ID (defaults to agentdock_session_id)')
    .option('--json', 'Output the created schedule as JSON')
    .action((prompt, options) => handlers.scheduleAdd?.(prompt, options));
  schedule.command('list')
    .description('List schedules of the current session (all schedules outside a session)')
    .option('--all', 'List schedules of every session')
    .option('--session <session-id>', 'List schedules bound to this session')
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
    parent.command('start')
      .description('Start the AgentDock server in the background')
      .action((options, command) => handlers.daemonStart?.(serverOptionsFrom(options, command)));
    parent.command('stop')
      .description('Stop the background AgentDock server')
      .action(() => handlers.daemonStop?.());
    parent.command('restart')
      .description('Restart the background AgentDock server')
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
