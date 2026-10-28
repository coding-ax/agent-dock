import type { DockEvent } from './api';

export type ComposerReference = { id: string; kind: 'file' | 'skill' | 'image'; label: string; value: string; url?: string };
export type ContextStats = { used?: number; size?: number; compacted?: number; percentage?: number };
export type ModelReadiness =
  | { kind: 'ready' }
  | { kind: 'loading'; label: string; reason: string }
  | { kind: 'blocked'; label: string; reason: string };

/**
 * 能不能发消息，以及模型选择器上显示什么。
 *
 * 只有「正在切换模型」才真正阻塞发送——那一刻会话的 model 处于中间态，发出去可能
 * 用错模型。模型**列表**只服务于「切换模型」下拉，发消息用的是会话已有的 model，
 * 列表没加载完不该拦着用户打字。
 *
 * 之前把 loading / failed 也算作阻塞，代价很大：模型探测要真起一个 ACP 会话去问
 * Agent，实测 codex 首次 9.1 秒（之后走服务端 5 分钟缓存才 0.8ms）。localStorage
 * 缓存按 agent+model 分键，换模型、换机器、清缓存都会 MISS，于是每次都干等 9 秒。
 *
 * 更糟的是探测失败时：react-query 会重试，重试期间 isFetching 为 true，旧实现里
 * loading 分支排在 failed 前面，用户永远看到「模型加载中」、永远等不到失败提示，
 * 表现就是输入框被无限锁死。现在失败只降级显示，不阻塞发送。
 */
export function getModelReadiness({ loaded, loading, switching, failed }: { loaded: boolean; loading: boolean; switching: boolean; failed: boolean }): ModelReadiness {
  if (switching) return { kind: 'blocked', label: '模型切换中…', reason: '模型切换完成后才能发送消息' };
  if (loaded) return { kind: 'ready' };
  if (loading) return { kind: 'loading', label: '模型加载中…', reason: '正在读取可切换的模型列表，不影响发送消息' };
  if (failed) return { kind: 'loading', label: '模型列表不可用', reason: '读取模型列表失败，仍可使用当前模型发送消息' };
  return { kind: 'loading', label: '默认模型', reason: '正在读取可切换的模型列表，不影响发送消息' };
}

export function shouldDismissComposerPanel({ insidePopover, onPanelTrigger }: { insidePopover: boolean; onPanelTrigger: boolean }): boolean {
  return !insidePopover && !onPanelTrigger;
}

/**
 * 文件和图片引用块的前缀标记。**不能以 `/` 开头**：Claude Code CLI 会把以 `/` 开头的
 * 用户消息当成斜杠命令解析，而 `/file` `/skills` 都不是 Agent 通告的命令，于是 CLI 会
 * 回一条 `Unknown command: /file` 的 local-command-stdout 块并混进会话里显示出来。
 * 用方括号前缀表达同样的语义，对 CLI 完全惰性；路径本身仍然原样带给 Agent。
 */
const FILE_MARKER = '[文件]';
const IMAGE_MARKER = '[图片]';
/** 技能**没有**被 Agent 通告时的惰性写法，理由同上。 */
const SKILL_MARKER = '[技能]';
/** 旧版前缀（历史排队任务里存的就是这种），只用于解析兼容。 */
const LEGACY_SKILL_MARKER = '/skills';
/** 前导引用块的通用形状「标记 + 值」，含旧版前缀；方括号在正则里要转义。 */
const REFERENCE_MARKER = /^(?:\/file|\/skills|\[文件\]|\[图片\]|\[技能\])\s+(.+)$/;
/** 真实斜杠命令的形状：`/名字` **独占一行**（技能名里只有字母数字和 `-_:`）。 */
const SLASH_COMMAND_LINE = /^\/([A-Za-z0-9_:-]+)$/;

/**
 * 引用块里的技能有两种写法，取决于它是不是当前会话真通告过的斜杠命令：
 *
 * - **通告过**（如 `lark-doc`）：写成 `/lark-doc`，这才是技能真正的调用方式，CLI 会执行它，
 *   后面的引用块和正文作为它的参数传进去。必须**独占首行**——CLI 只把以 `/` 开头的消息
 *   当斜杠命令，排在第二行的 `/名字` 只会退化成普通文本。
 * - **没通告过**：写成惰性的 `[技能] 名字`。输入框里的 skill 来自服务端扫本地 SKILL.md
 *   （workspace/.agents/skills、~/.codex/skills 等），跟 Agent 通告的命令是两套集合，
 *   实测当前工作区 66 个本地技能只有 31 个在通告的 151 条命令里，剩下 35 个发 `/名字`
 *   只会换来一条 `Unknown command: /名字`。
 *
 * 最多提升一个：斜杠命令只认首行，其余技能保持方括号写法。
 */
export function buildPrompt(message: string, references: ComposerReference[], advertisedCommands: string[] = []) {
  const advertised = new Set(advertisedCommands);
  const rawCommand = /^\/(goal|plan|fast)(?=\s|$)/.exec(message.trim())?.[1];
  const startsWithAdvertisedCommand = Boolean(rawCommand && advertised.has(rawCommand));
  const promoted = startsWithAdvertisedCommand ? undefined : references.find(reference => reference.kind === 'skill' && advertised.has(reference.value));
  const referenceLines = [
    ...(promoted ? [`/${promoted.value}`] : []),
    ...references.filter(reference => reference !== promoted).flatMap(reference => {
      if (reference.kind === 'skill') return [`${SKILL_MARKER} ${reference.value}`];
      if (reference.kind === 'image') {
        return [`${IMAGE_MARKER} ${reference.value}`, `![${reference.label}](${reference.value})`];
      }
      return [`${FILE_MARKER} ${reference.value}`];
    })
  ];
  return (startsWithAdvertisedCommand ? [message.trim(), ...referenceLines] : [...referenceLines, message.trim()]).filter(Boolean).join('\n\n');
}

/**
 * buildPrompt 的逆运算：把排队任务里存的 prompt 拆回「正文 + 引用 chips」，
 * 供「编辑排队任务」时把内容退回主输入框——原地单行输入框没法处理图片/文件
 * 引用，也拿不到粘贴、上传、斜杠命令等完整交互。
 *
 * 只解析前导的引用块；正文一旦开始，后续内容（即使用户手写了 [文件]、![]()）
 * 全部按正文处理，与 buildPrompt「引用全部在前、正文在后」的生成顺序对称。
 * 参考标记同时兼容旧版 `/file` `/skills`（历史排队任务里存的是旧格式）。
 *
 * advertisedCommands 用于识别 buildPrompt 提升过的真实斜杠命令：只有通告过的名字才算技能
 * 引用，否则用户手打的 `/compact`、`/clear` 之类会被误判成技能 chip 退回来。命中的名字
 * 重新构造成 `/<名字>` 由 buildPrompt 还原，所以这类草稿来回编辑不会变形。
 */
export function parsePromptToDraft(prompt: string, advertisedCommands: string[] = []): { text: string; references: ComposerReference[] } {
  const advertised = new Set(advertisedCommands);
  const references: ComposerReference[] = [];
  const bodyBlocks: string[] = [];
  let pending: { kind: 'file' | 'image'; path: string } | undefined;

  const flushPending = () => {
    if (!pending) return;
    references.push({ id: `${pending.kind}-${pending.path}`, kind: pending.kind, label: pending.path.split('/').pop() || pending.path, value: pending.path });
    pending = undefined;
  };

  for (const block of prompt.split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    // 正文已开始：剩余内容全部是正文。此时 pending 必已 flush。
    if (bodyBlocks.length > 0) { bodyBlocks.push(block); continue; }

    // 图片块后面紧跟 ![label](path) 块时，两者合成一张图片引用（buildPrompt 对 image 的写法）。
    if (pending) {
      const image = trimmed.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
      if (image) {
        references.push({ id: `image-${pending.path}`, kind: 'image', label: image[1] || pending.path.split('/').pop() || pending.path, value: pending.path });
        pending = undefined;
        continue;
      }
      flushPending();
    }

    const command = trimmed.match(SLASH_COMMAND_LINE);
    if (command && advertised.has(command[1]!)) { references.push({ id: `skill-${command[1]}`, kind: 'skill', label: command[1]!, value: command[1]! }); continue; }

    const marker = trimmed.match(REFERENCE_MARKER);
    if (!marker) { bodyBlocks.push(block); continue; }
    const value = marker[1]!.trim();
    const keyword = trimmed.split(/\s/, 1)[0]!;
    if (keyword === SKILL_MARKER || keyword === LEGACY_SKILL_MARKER) { references.push({ id: `skill-${value}`, kind: 'skill', label: value, value }); continue; }
    pending = { kind: keyword === IMAGE_MARKER ? 'image' : 'file', path: value };
  }
  flushPending();

  return { text: bodyBlocks.join('\n\n').trim(), references };
}

/**
 * 「编辑排队任务」退回输入框时，由图片引用的本地上传路径恢复服务端缩略图 URL。
 * 上传路径形如 …/.agentdock/uploads/<sessionId>/<filename>，而上传文件接口是
 * GET /api/sessions/:sessionId/uploads/:filename。
 * 必须从 /uploads/ 之后拆出 <sessionId>/<filename> 两段再拼，缺少 /uploads/ 段会 404。
 * 解析不出合法两段时返回 undefined，由调用方回退到原引用，不生成不可用的 URL。
 */
export function queuedImageThumbnailUrl(value: string): string | undefined {
  const uploaded = value.split('/uploads/')[1];
  if (!uploaded) return undefined;
  const slash = uploaded.indexOf('/');
  if (slash <= 0) return undefined;
  const sessionId = uploaded.slice(0, slash);
  const filename = uploaded.slice(slash + 1);
  if (!sessionId || !filename) return undefined;
  return `/api/sessions/${sessionId}/uploads/${filename}`;
}

export function slashQuery(value: string, caret = value.length) {
  const beforeCaret = value.slice(0, caret);
  const match = beforeCaret.match(/(?:^|\s)\/([^\s/]*)$/);
  return match ? match[1]!.toLowerCase() : undefined;
}

export function replaceSlashQuery(value: string, replacement: string, caret = value.length) {
  const beforeCaret = value.slice(0, caret);
  const match = beforeCaret.match(/(?:^|\s)\/[^\s/]*$/);
  if (!match || match.index === undefined) return value;
  const leadingWhitespace = match[0].startsWith('/') ? '' : match[0][0]!;
  return `${beforeCaret.slice(0, match.index)}${leadingWhitespace}${replacement}${value.slice(caret)}`;
}

export function contextStatsFromEvents(events: DockEvent[] = []): ContextStats {
  let used: number | undefined;
  let size: number | undefined;
  let compacted = 0;
  let hasUsage = false;
  for (const event of events) {
    if (event.type !== 'status' || event.data?.state !== 'usage') continue;
    // 部分反代/自研模型（如 auto_model/seed-*）会吐 used=0 的 usage_update，实际拿不到真实
    // token 数。0 不是有效用量：接受它会让上下文显示成 0/200k，并把之前的有效用量误记成
    // 「压缩」。整条事件忽略（size 也不取，保证没真实用量时整块统计隐藏）。
    const rawUsed = Number.isFinite(event.data.used) ? Number(event.data.used) : Number.isFinite(event.data.breakdown?.totalTokens) ? Number(event.data.breakdown.totalTokens) : undefined;
    if (rawUsed === undefined || rawUsed <= 0) continue;
    hasUsage = true;
    const nextSize = Number.isFinite(event.data.size) ? Number(event.data.size) : undefined;
    if (used !== undefined && rawUsed < used) compacted += used - rawUsed;
    used = rawUsed;
    if (nextSize !== undefined) size = nextSize;
  }
  return { used, size, ...(hasUsage ? { compacted } : {}), ...(used !== undefined && size ? { percentage: Math.min(100, used / size * 100) } : {}) };
}

export function commandsFromEvents(events: DockEvent[] = []): Array<{ name: string; description: string }> {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type === 'status' && event.data?.state === 'commands' && Array.isArray(event.data.availableCommands)) {
      return event.data.availableCommands.flatMap((command: any) => typeof command?.name === 'string' ? [{ name: command.name.replace(/^\//, ''), description: typeof command.description === 'string' ? command.description : '' }] : []);
    }
  }
  return [];
}

export function formatTokens(value?: number) {
  if (value === undefined) return '等待数据';
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

/**
 * 上传一个文件到指定会话。Composer（已有会话）与 DraftComposer（草稿态先建会话再上传）
 * 共用这一段，避免两处各写一遍 fetch 与错误解析。
 */
export async function uploadSessionFile(sessionId: string, file: File | Blob): Promise<{ path: string; url: string; filename: string }> {
  const name = 'name' in file ? file.name : '（未命名文件）';
  const response = await fetch(`/api/sessions/${sessionId}/uploads`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      // 浏览器对 .md/.heic/.zip 等类型上报不一致，带上原始文件名让服务端按扩展名兜底。
      ...(name ? { 'X-Upload-Filename': encodeURIComponent(name) } : {})
    },
    body: file
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
    throw new Error(detail?.error?.message ?? `上传失败（HTTP ${response.status}）`);
  }
  return await response.json() as { path: string; url: string; filename: string };
}

export function referenceFromUpload(result: { path: string; url: string; filename: string }, isImage: boolean): ComposerReference {
  const kind: ComposerReference['kind'] = isImage ? 'image' : 'file';
  return { id: `${kind}-${result.path}`, kind, label: result.filename, value: result.path, url: isImage ? result.url : undefined };
}

/** 工作目录 chip 只展示最后一段（me / agent-dock）；完整路径放 tooltip 和下拉里。 */
export function workspaceBasename(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? path;
}
