import { buildActivitySteps, thinkingTitle, timelineRowKey, type TimelineEvent, type TimelineTurn } from './timeline';
import { summarizeTools, toolPresentation } from './tool-presentation';
import { toolDetailView } from './tool-detail';

export const SYSTEM_PROMPT_SEARCH_KEY = 'system-prompt';

export interface TimelineSearchMatch {
  id: string;
  /** 对应渲染节点上的 data-search-item-key。 */
  itemKey: string;
  sectionKind: 'system-prompt' | 'event' | 'activity';
  /** 命中折叠的执行过程时，记录所属步骤 id，用于自动展开并精准定位。 */
  stepId?: string;
  /** 在 itemKey（或 stepId）内的第几次出现（0-based）。 */
  occurrenceIndex: number;
}

export function normalizeSearchQuery(query: string): string {
  return query.trim();
}

/**
 * 轻量剥离常见 Markdown 语法符号，使索引文本贴近页面实际渲染出的可见文本，
 * 避免 `**加粗**`、`[标题](https://...)` 等语法造成漏匹配或计数偏差。
 */
export function stripMarkdownForSearch(markdown: string): string {
  if (!markdown) return '';
  return markdown
    // 围栏代码块标记行（保留代码内容）
    .replace(/^```[^\n]*$/gm, '')
    .replace(/^~~~[^\n]*$/gm, '')
    // 图片 ![alt](url) -> alt
    .replace(/!\[([^\]]*)\]\([^)\n]+\)/g, '$1')
    // 链接 [label](url) -> label
    .replace(/\[([^\]]+)\]\([^)\n]+\)/g, '$1')
    // 行内代码 `code` -> code
    .replace(/`([^`\n]+)`/g, '$1')
    // 粗体 / 删除线 / 斜体
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    // 标题 / 引用前缀
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '');
}

/** 大小写不敏感的非重叠出现次数统计，避免正则特殊字符转义问题。 */
export function countTextOccurrences(haystack: string, needleLower: string): number {
  if (!haystack || !needleLower) return 0;
  const lower = haystack.toLowerCase();
  const step = needleLower.length;
  let count = 0;
  let pos = 0;
  while (pos <= lower.length - step) {
    const found = lower.indexOf(needleLower, pos);
    if (found === -1) break;
    count += 1;
    pos = found + step;
  }
  return count;
}

function extractToolSearchText(event: TimelineEvent): string {
  const presentation = toolPresentation(event.data);
  const parts: string[] = [presentation.label];
  if (presentation.detail) parts.push(presentation.detail);
  const detail = toolDetailView(event.data);
  if (detail.kind === 'command') {
    if (detail.command) parts.push(detail.command);
    if (detail.output) parts.push(detail.output);
  } else if (detail.kind === 'diff') {
    if (detail.path) parts.push(detail.path);
    if (detail.note) parts.push(detail.note);
    if (detail.lines.length) parts.push(detail.lines.map(line => line.text).join('\n'));
  } else if (detail.kind === 'paths') {
    if (detail.items.length) parts.push(detail.items.join(' '));
    if (detail.output) parts.push(detail.output);
  }
  return parts.join('\n');
}

function extractEventSearchText(event: TimelineEvent): string {
  if (event.type === 'thinking') return '';
  if (event.type === 'text') return stripMarkdownForSearch(event.data.text ?? '');
  if (event.type === 'warning') return stripMarkdownForSearch(event.data.text ?? '');
  if (event.type === 'error') return stripMarkdownForSearch(event.data.message ?? 'Agent 运行失败');
  if (event.type === 'permission_request') return event.data.title ?? '';
  if (event.type === 'tool_call' || event.type === 'tool_result') return extractToolSearchText(event);
  return '';
}

export function searchTimeline({
  turns,
  rowKeys,
  systemPrompt,
  query
}: {
  turns: TimelineTurn[];
  rowKeys?: ReadonlyMap<string, string>;
  systemPrompt?: string;
  query: string;
}): TimelineSearchMatch[] {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) return [];
  const needleLower = normalized.toLowerCase();
  const matches: TimelineSearchMatch[] = [];
  const emptyRowKeys = rowKeys ?? new Map<string, string>();

  const trimmedSystemPrompt = systemPrompt?.trim();
  if (trimmedSystemPrompt) {
    const count = countTextOccurrences(trimmedSystemPrompt, needleLower);
    for (let index = 0; index < count; index++) {
      matches.push({
        id: `${SYSTEM_PROMPT_SEARCH_KEY}:${index}`,
        itemKey: SYSTEM_PROMPT_SEARCH_KEY,
        sectionKind: 'system-prompt',
        occurrenceIndex: index
      });
    }
  }

  for (const turn of turns) {
    for (const section of turn.sections) {
      if (section.kind === 'event') {
        const text = extractEventSearchText(section.event);
        const count = countTextOccurrences(text, needleLower);
        if (!count) continue;
        const itemKey = timelineRowKey(section.event, emptyRowKeys);
        for (let index = 0; index < count; index++) {
          matches.push({
            id: `${itemKey}:${index}`,
            itemKey,
            sectionKind: 'event',
            occurrenceIndex: index
          });
        }
        continue;
      }

      const steps = buildActivitySteps(section.groups);
      for (const step of steps) {
        let text = '';
        if (step.kind === 'thinking') {
          const raw = step.event.data.text ?? '';
          const title = thinkingTitle(raw, false);
          text = raw ? stripMarkdownForSearch(raw) : (title ?? '');
        } else if (step.kind === 'tools') {
          const summary = summarizeTools(step.events) || `${step.events.length} 次工具调用`;
          const toolTexts = step.events.map(extractToolSearchText);
          text = [summary, ...toolTexts].join('\n');
        } else {
          text = stripMarkdownForSearch(step.event.data.text ?? '');
        }
        const count = countTextOccurrences(text, needleLower);
        for (let index = 0; index < count; index++) {
          matches.push({
            id: `${section.id}:${step.id}:${index}`,
            itemKey: section.id,
            sectionKind: 'activity',
            stepId: step.id,
            occurrenceIndex: index
          });
        }
      }
    }
  }

  return matches;
}

/** 索引循环跳转：到达末尾后回到第一条，第一条再往前回到末尾。 */
export function stepSearchIndex(currentIndex: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= total) return delta > 0 ? 0 : total - 1;
  return ((currentIndex + delta) % total + total) % total;
}

/** Cmd+F (macOS) 或 Ctrl+F (Win/Linux)，不含 Alt / Shift。 */
export function isTimelineFindShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): boolean {
  if (!(event.metaKey || event.ctrlKey)) return false;
  if (event.altKey || event.shiftKey) return false;
  return event.key.toLowerCase() === 'f';
}

/**
 * 判定当前 SessionPane 是否应该接管 Cmd/Ctrl+F：
 * - 任何弹窗打开时不抢焦点；
 * - 副屏面板仅在焦点位于该面板内时接管；
 * - 主面板在焦点不在副屏面板内时接管。
 */
export function shouldHandleTimelineFindShortcut({
  hasActiveDialog,
  hasAriaModal,
  pane,
  targetInsidePane,
  targetInsideSecondaryPane
}: {
  hasActiveDialog: boolean;
  hasAriaModal: boolean;
  pane: 'primary' | 'secondary';
  targetInsidePane: boolean;
  targetInsideSecondaryPane: boolean;
}): boolean {
  if (hasActiveDialog || hasAriaModal) return false;
  if (pane === 'secondary') return targetInsidePane;
  return !targetInsideSecondaryPane;
}
