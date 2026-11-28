import type { Locale } from './i18n/index.js';

export const METRIC_TONES = ['positive', 'negative', 'info', 'warning', 'neutral'] as const;
export type MetricTone = (typeof METRIC_TONES)[number];

export interface MetricItem {
  label: string;
  value: string;
  sub?: string;
  tone: MetricTone;
}

export const STEP_STATUSES = ['done', 'active', 'pending'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export interface StepItem {
  status: StepStatus;
  title: string;
  detail?: string;
}

export const CALLOUT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

export interface ParsedCalloutMarker {
  kind: CalloutKind;
  title?: string;
}

function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2) {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1).replace(/\\(["'\\])/g, '$1').trim();
    }
  }
  return s;
}

function normalizeTone(raw: unknown, sub?: string): MetricTone {
  if (typeof raw === 'string' && raw.trim()) {
    const key = raw.trim().toLowerCase();
    if (key === 'positive' || key === 'up' || key === 'good' || key === 'success' || key === 'green') return 'positive';
    if (key === 'negative' || key === 'down' || key === 'bad' || key === 'danger' || key === 'error' || key === 'red') return 'negative';
    if (key === 'warning' || key === 'warn' || key === 'amber' || key === 'orange' || key === 'yellow') return 'warning';
    if (key === 'info' || key === 'blue' || key === 'sky' || key === 'accent' || key === 'highlight') return 'info';
    if (key === 'neutral' || key === 'muted' || key === 'default' || key === 'gray' || key === 'grey') return 'neutral';
  }
  if (sub) {
    const trimmed = sub.trim();
    if (/^(?:\+|↑|▲|↗)/.test(trimmed)) return 'positive';
    if (/^(?:-\d|↓|▼|↘)/.test(trimmed)) return 'negative';
  }
  return 'neutral';
}

function normalizeStepStatus(raw: unknown): StepStatus | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  if (['done', 'completed', 'complete', 'finished', 'success', 'ok', 'checked', 'x', '✓', '✔', '✅'].includes(key)) {
    return 'done';
  }
  if (['active', 'current', 'in_progress', 'in-progress', 'inprogress', 'running', 'doing', 'working', 'wip', 'now', '~', '*', '>', '•', '●', '🔵'].includes(key)) {
    return 'active';
  }
  if (['pending', 'todo', 'waiting', 'queued', 'upcoming', 'planned', 'idle', 'open', 'next', '', ' ', '○', '⚪'].includes(key)) {
    return 'pending';
  }
  return null;
}

function asNonEmptyString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function metricFromRecord(record: Record<string, unknown>): MetricItem | null {
  const label = asNonEmptyString(record.label ?? record.title ?? record.name ?? record.key);
  const value = asNonEmptyString(record.value ?? record.val ?? record.metric);
  if (!label || !value) return null;
  const sub = asNonEmptyString(
    record.delta ?? record.sub ?? record.subtitle ?? record.change ?? record.note ?? record.hint ?? record.trend
  );
  const tone = normalizeTone(record.tone ?? record.status ?? record.color ?? record.trendType, sub || undefined);
  return sub ? { label, value, sub, tone } : { label, value, tone };
}

function stepFromRecord(record: Record<string, unknown>): StepItem | null {
  const title = asNonEmptyString(record.title ?? record.label ?? record.name ?? record.step);
  if (!title) return null;
  const status = normalizeStepStatus(record.status ?? record.state ?? 'pending');
  if (!status) return null;
  const detail = asNonEmptyString(record.detail ?? record.description ?? record.desc ?? record.sub ?? record.subtitle ?? record.note);
  return detail ? { status, title, detail } : { status, title };
}

function parseSimpleYamlListOfMaps(raw: string, allowedWrappers: string[]): Array<Record<string, string>> | null {
  const rawLines = raw.replace(/\r\n?/g, '\n').split('\n');
  const lines = rawLines.filter(line => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('#');
  });
  if (lines.length === 0) return null;

  let startIndex = 0;
  const firstTrimmed = lines[0]!.trim();
  const wrapperMatch = /^([A-Za-z_][\w-]*)\s*:\s*$/.exec(firstTrimmed);
  if (wrapperMatch && allowedWrappers.includes(wrapperMatch[1]!.toLowerCase())) {
    startIndex = 1;
  }

  const items: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;
  let sawDashItem = false;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]!;
    const dashMatch = /^\s*-\s+(.*)$/.exec(line);
    if (dashMatch) {
      sawDashItem = true;
      if (current) items.push(current);
      current = {};
      const rest = dashMatch[1]!.trim();
      const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(rest);
      if (!kv) return null;
      current[kv[1]!.toLowerCase()] = unquote(kv[2]!);
      continue;
    }
    if (!current) return null;
    const kv = /^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) return null;
    current[kv[1]!.toLowerCase()] = unquote(kv[2]!);
  }

  if (current) items.push(current);
  if (!sawDashItem || items.length === 0) return null;
  return items;
}

/**
 * 解析 ```metrics 结构化块，支持：
 * 1) JSON 数组或 `{ items / metrics: [...] }`
 * 2) 简洁 YAML 对象列表（`- label / value / delta|sub / tone`）
 * 3) 紧凑键值/竖线行（`当前线上版本: v0.3.15 | +6 路合入` 或 `label | value | sub | tone`）
 *
 * 解析失败返回 null，由渲染端静默回退为优雅代码块。
 */
export function parseMetricsBlock(raw: string): MetricItem[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1) JSON
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? ((parsed as Record<string, unknown>).items ?? (parsed as Record<string, unknown>).metrics)
          : null;
      if (!Array.isArray(list) || list.length === 0) return null;
      const items: MetricItem[] = [];
      for (const entry of list) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
        const item = metricFromRecord(entry as Record<string, unknown>);
        if (!item) return null;
        items.push(item);
      }
      return items;
    } catch {
      return null;
    }
  }

  // 2) YAML 对象列表
  const yamlRecords = parseSimpleYamlListOfMaps(trimmed, ['metrics', 'items']);
  if (yamlRecords) {
    const items: MetricItem[] = [];
    for (const rec of yamlRecords) {
      const item = metricFromRecord(rec);
      if (!item) return null;
      items.push(item);
    }
    if (items.length > 0) return items;
  }

  // 3) 紧凑键值 / 竖线列表
  const lines = trimmed
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));

  if (lines.length === 0) return null;

  const items: MetricItem[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/^[-*•]\s+/, '').trim();
    if (!line) return null;

    // 形式 A：label: value | sub | tone（支持中英文冒号）
    const colonIdx = (() => {
      const en = line.indexOf(':');
      const zh = line.indexOf('：');
      if (en < 0) return zh;
      if (zh < 0) return en;
      return Math.min(en, zh);
    })();
    const pipeIdx = line.indexOf('|');

    if (colonIdx > 0 && (pipeIdx < 0 || colonIdx < pipeIdx)) {
      const label = unquote(line.slice(0, colonIdx));
      const rest = line.slice(colonIdx + 1).trim();
      if (!label || !rest) return null;
      const parts = rest.split('|').map(p => unquote(p)).filter(Boolean);
      const value = parts[0] ?? '';
      if (!value) return null;
      let sub: string | undefined;
      let explicitTone: string | undefined;
      if (parts.length >= 3) {
        sub = parts[1];
        explicitTone = parts[2];
      } else if (parts.length === 2) {
        // 如果第二段刚好是合法 tone 关键词，则作为 tone；否则作为 sub/delta
        const second = parts[1]!;
        if ((METRIC_TONES as readonly string[]).includes(second.toLowerCase())) {
          explicitTone = second;
        } else {
          sub = second;
        }
      }
      const tone = normalizeTone(explicitTone, sub);
      items.push(sub ? { label, value, sub, tone } : { label, value, tone });
      continue;
    }

    // 形式 B：label | value | sub | tone
    if (pipeIdx > 0) {
      const parts = line.split('|').map(p => unquote(p));
      const label = parts[0] ?? '';
      const value = parts[1] ?? '';
      if (!label || !value) return null;
      const third = parts[2]?.trim() || undefined;
      const fourth = parts[3]?.trim() || undefined;
      let sub: string | undefined = third;
      let explicitTone: string | undefined = fourth;
      if (third && !fourth && (METRIC_TONES as readonly string[]).includes(third.toLowerCase())) {
        sub = undefined;
        explicitTone = third;
      }
      const tone = normalizeTone(explicitTone, sub);
      items.push(sub ? { label, value, sub, tone } : { label, value, tone });
      continue;
    }

    return null;
  }

  return items.length > 0 ? items : null;
}

/**
 * 解析 ```steps 步进时间轴结构化块，支持：
 * 1) JSON 数组或 `{ steps / items: [...] }`
 * 2) 简洁 YAML 对象列表（`- status / title / detail`）
 * 3) 紧凑列表（`[x] 标题 | 副标题`、`[~] 进行中`、`[ ] 待开始`、`done: 标题 | 副标题` 等，也支持缩进下一行写副标题）
 */
export function parseStepsBlock(raw: string): StepItem[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1) JSON（注意避免把 `[x] 步骤` 这类方括号复选框误判为非法 JSON 而提前返回）
  if (trimmed.startsWith('{') || /^\[\s*(?:\{|"|\])/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? ((parsed as Record<string, unknown>).steps ?? (parsed as Record<string, unknown>).items)
          : null;
      if (!Array.isArray(list) || list.length === 0) return null;
      const items: StepItem[] = [];
      for (const entry of list) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
        const item = stepFromRecord(entry as Record<string, unknown>);
        if (!item) return null;
        items.push(item);
      }
      return items;
    } catch {
      return null;
    }
  }

  // 2) YAML 对象列表
  const yamlRecords = parseSimpleYamlListOfMaps(trimmed, ['steps', 'items']);
  if (yamlRecords) {
    const items: StepItem[] = [];
    for (const rec of yamlRecords) {
      const item = stepFromRecord(rec);
      if (!item) return null;
      items.push(item);
    }
    if (items.length > 0) return items;
  }

  // 3) 紧凑步骤行
  const rawLines = trimmed.replace(/\r\n?/g, '\n').split('\n');
  const items: StepItem[] = [];

  for (const rawLine of rawLines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;

    // 缩进续行作为上一条 step 的 detail
    if (/^[ \t]{2,}\S/.test(rawLine) && items.length > 0 && !/^\s*[-*•]?\s*\[/.test(rawLine)) {
      const last = items[items.length - 1]!;
      const extra = rawLine.trim();
      last.detail = last.detail ? `${last.detail} ${extra}` : extra;
      continue;
    }

    const line = rawLine.trim().replace(/^[-*•]\s+/, '').trim();
    let status: StepStatus | null = null;
    let body = '';

    // 形式 A：[x] / [~] / [*] / [>] / [ ] / [done] / [active] / [pending] Title | Detail
    const bracketMatch = /^\[([^\]]*)\]\s+(.+)$/.exec(line);
    if (bracketMatch) {
      status = normalizeStepStatus(bracketMatch[1]!);
      body = bracketMatch[2]!.trim();
    } else {
      // 形式 B：done: Title | Detail 或 done | Title | Detail
      const prefixColon = /^([A-Za-z_-]+|✅|🔵|⚪|✓|●|○)\s*[:：]\s*(.+)$/.exec(line);
      if (prefixColon) {
        status = normalizeStepStatus(prefixColon[1]!);
        body = prefixColon[2]!.trim();
      } else {
        const pipeParts = line.split('|').map(p => p.trim());
        if (pipeParts.length >= 2) {
          const maybeStatus = normalizeStepStatus(pipeParts[0]!);
          if (maybeStatus) {
            status = maybeStatus;
            body = pipeParts.slice(1).join(' | ').trim();
          }
        }
      }
    }

    if (!status || !body) return null;

    const pipeIdx = body.indexOf('|');
    if (pipeIdx >= 0) {
      const title = unquote(body.slice(0, pipeIdx));
      const detail = unquote(body.slice(pipeIdx + 1));
      if (!title) return null;
      items.push(detail ? { status, title, detail } : { status, title });
    } else {
      const title = unquote(body);
      if (!title) return null;
      items.push({ status, title });
    }
  }

  return items.length > 0 ? items : null;
}

const calloutMarkerPattern = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+(.+?))?[ \t]*$/i;

/** 解析 GFM Callout 首行标记：`[!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]`，可选自定义标题。 */
export function parseCalloutMarker(firstLine: string): ParsedCalloutMarker | null {
  const match = calloutMarkerPattern.exec(firstLine.trim());
  if (!match) return null;
  const kind = match[1]!.toLowerCase() as CalloutKind;
  const title = match[2]?.trim() || undefined;
  return title ? { kind, title } : { kind };
}

const LARK_CALLOUT_META: Record<CalloutKind, { icon: string; zh: string; en: string }> = {
  note: { icon: 'ℹ️', zh: '备注', en: 'Note' },
  tip: { icon: '💡', zh: '提示', en: 'Tip' },
  important: { icon: '📌', zh: '重要', en: 'Important' },
  warning: { icon: '⚠️', zh: '警告', en: 'Warning' },
  caution: { icon: '🚨', zh: '注意', en: 'Caution' }
};

/** 保护行内代码反引号片段，仅对其外的正文执行轻量行内降级（`==高亮==`、`<mark>`、`<kbd>`）。 */
function degradeInlineForLark(line: string): string {
  // 无目标语法时零拷贝返回，保证普通 Markdown 字节级不变。
  if (!line.includes('==') && !line.includes('<mark') && !line.includes('<kbd')) {
    return line;
  }
  // 按行内反引号代码切分，跳过奇数索引（行内代码片段）。
  const segments = line.split(/(`+[^`]*`+)/g);
  for (let i = 0; i < segments.length; i += 2) {
    let seg = segments[i]!;
    if (!seg) continue;
    seg = seg.replace(/(?<!=)==(?![\s=])((?:(?!==)[^\n])+?)(?<![\s=])==(?!=)/g, '**$1**');
    seg = seg.replace(/<mark>([\s\S]*?)<\/mark>/gi, '**$1**');
    seg = seg.replace(/<kbd>([\s\S]*?)<\/kbd>/gi, '`$1`');
    segments[i] = seg;
  }
  return segments.join('');
}

function formatMetricsForLark(items: MetricItem[], locale: Locale): string {
  const isEn = locale === 'en-US';
  return items
    .map(item => {
      if (item.sub) {
        return isEn
          ? `- **${item.label}**: **${item.value}** (${item.sub})`
          : `- **${item.label}**：**${item.value}**（${item.sub}）`;
      }
      return isEn
        ? `- **${item.label}**: **${item.value}**`
        : `- **${item.label}**：**${item.value}**`;
    })
    .join('\n');
}

function formatStepsForLark(items: StepItem[]): string {
  return items
    .map(step => {
      const icon = step.status === 'done' ? '✅' : step.status === 'active' ? '🔵' : '⚪';
      const title = step.status === 'pending' ? step.title : `**${step.title}**`;
      return step.detail ? `${icon} ${title} — ${step.detail}` : `${icon} ${title}`;
    })
    .join('\n');
}

/**
 * 将 AgentDock 原生富文本 Markdown 优雅降级为飞书卡片 / 纯文本原生可读 Markdown：
 * - ```metrics -> 清爽加粗指标清单
 * - ```steps   -> ✅ / 🔵 / ⚪ 步进清单
 * - ```svg     -> 简洁可读提示，避免裸露大段 XML 源码
 * - > [!NOTE|TIP|IMPORTANT|WARNING|CAUTION] -> 带语义图标与双语标题的引用块
 * - ==重点== / <mark>重点</mark> -> **重点**；<kbd>Esc</kbd> -> `Esc`
 * - 普通代码块与常规 Markdown 原样保留，且满足幂等性 f(f(x)) === f(x)。
 */
export function degradeRichMarkdownForLark(markdown: string, locale: Locale = 'zh-CN'): string {
  if (!markdown) return markdown;
  const hasRichToken =
    /(?:```|~~~)\s*(?:metrics|steps|svg)\b/i.test(markdown) ||
    />\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(markdown) ||
    markdown.includes('==') ||
    markdown.includes('<mark') ||
    markdown.includes('<kbd');
  if (!hasRichToken) return markdown;

  const isEn = locale === 'en-US';
  const lines = markdown.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // 1) 围栏代码块（保持普通代码块原样，仅降级 metrics / steps / svg）
    const fenceOpen = /^([ \t]{0,3})(`{3,}|~{3,})([^\n]*)$/.exec(line);
    if (fenceOpen) {
      const fenceChars = fenceOpen[2]!;
      const fenceChar = fenceChars[0]!;
      const fenceLen = fenceChars.length;
      const lang = fenceOpen[3]!.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      const closePattern = new RegExp(`^[ \\t]{0,3}${fenceChar}{${fenceLen},}[ \\t]*$`);

      const bodyLines: string[] = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (closePattern.test(lines[j]!)) {
          closed = true;
          break;
        }
        bodyLines.push(lines[j]!);
        j++;
      }

      if (closed && lang === 'metrics') {
        const parsed = parseMetricsBlock(bodyLines.join('\n'));
        if (parsed) {
          out.push(formatMetricsForLark(parsed, locale));
          i = j + 1;
          continue;
        }
      } else if (closed && lang === 'steps') {
        const parsed = parseStepsBlock(bodyLines.join('\n'));
        if (parsed) {
          out.push(formatStepsForLark(parsed));
          i = j + 1;
          continue;
        }
      } else if (closed && lang === 'svg') {
        const bodyText = bodyLines.join('\n');
        if (/<svg[\s>]/i.test(bodyText)) {
          out.push(
            isEn
              ? '🖼️ **[SVG Diagram]** *(Open in AgentDock Web to view the full vector graphic)*'
              : '🖼️ **[SVG 矢量图表]**（请在 AgentDock 网页端查看完整矢量图）'
          );
          i = j + 1;
          continue;
        }
      }

      // 普通代码块或解析失败 / 未闭合块：原样保留，绝不改写内部代码。
      const endIdx = closed ? j : lines.length - 1;
      for (let k = i; k <= endIdx; k++) {
        out.push(lines[k]!);
      }
      i = endIdx + 1;
      continue;
    }

    // 2) GFM Callout 引用块（> [!TIP] 等）
    const quoteMatch = /^([ \t]{0,3}>\s?)(.*)$/.exec(line);
    if (quoteMatch) {
      const marker = parseCalloutMarker(quoteMatch[2]!);
      if (marker) {
        const meta = LARK_CALLOUT_META[marker.kind];
        const heading = marker.title ?? (isEn ? meta.en : meta.zh);
        out.push(`${quoteMatch[1]!}${meta.icon} **${heading}**`);
        i++;
        while (i < lines.length) {
          const contMatch = /^([ \t]{0,3}>\s?)(.*)$/.exec(lines[i]!);
          if (!contMatch) break;
          out.push(`${contMatch[1]!}${degradeInlineForLark(contMatch[2]!)}`);
          i++;
        }
        continue;
      }
    }

    // 3) 普通行：仅做行内安全降级
    out.push(degradeInlineForLark(line));
    i++;
  }

  return out.join('\n');
}
