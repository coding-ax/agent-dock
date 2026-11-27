/**
 * AgentDock 纯 XML 输出插件共享解析基础库：
 * - Markdown 围栏代码块（``` / ~~~，含流式未闭合代码块）与行内代码（`...`）等长掩码免疫；
 * - XML 实体/CDATA 解码与属性解析；
 * - 回答末尾裸 XML 块提取与流式未闭合标签探测（全插件复用，避免各自重复造轮子）。
 */

export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_match, entity: string) => {
      switch (entity) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
        default: {
          const code = entity.startsWith('#x') || entity.startsWith('#X')
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
          if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return _match;
          try { return String.fromCodePoint(code); } catch { return _match; }
        }
      }
    });
}

export function parseXmlAttributes(rawAttrs: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([A-Za-z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(rawAttrs)) !== null) {
    const key = match[1]!;
    const value = decodeXmlEntities(match[2] ?? match[3] ?? '');
    attrs[key] = value;
  }
  return attrs;
}

export function parseBooleanAttr(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return defaultValue;
}

export function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 将 Markdown 中的围栏代码块（``` / ~~~，含流式未闭合代码块）和行内代码（`...`）
 * 替换为等长空格（保留换行符），保证返回的字符下标与原文 1:1 严格一致。
 *
 * 这样在技术讨论、文档或示例里写 `<agentdock-*>` 时绝不会误触发任何插件卡片解析。
 */
export function maskProtectedMarkdown(text: string): string {
  const len = text.length;
  // 按 UTF-16 下标切片构造，保证含代理对（emoji 等）时下标与原文 1:1 一致。
  const out = new Array<string>(len);
  for (let i = 0; i < len; i++) out[i] = text[i]!;

  let i = 0;
  let atLineStart = true;
  let fenceChar: '`' | '~' | null = null;
  let fenceLen = 0;

  while (i < len) {
    if (atLineStart) {
      let indent = 0;
      while (i + indent < len && indent < 3 && text[i + indent] === ' ') indent++;
      const ch = text[i + indent];
      if (ch === '`' || ch === '~') {
        let run = 0;
        while (i + indent + run < len && text[i + indent + run] === ch) run++;
        if (run >= 3) {
          let lineEnd = text.indexOf('\n', i + indent + run);
          if (lineEnd < 0) lineEnd = len;
          const rest = text.slice(i + indent + run, lineEnd);
          if (fenceChar === null) {
            // CommonMark：反引号围栏的 info string 不能包含反引号。
            if (ch === '~' || !rest.includes('`')) {
              fenceChar = ch;
              fenceLen = run;
              for (let k = i; k < lineEnd; k++) out[k] = ' ';
              i = lineEnd < len ? lineEnd + 1 : len;
              atLineStart = true;
              continue;
            }
          } else if (ch === fenceChar && run >= fenceLen && /^[ \t\r]*$/.test(rest)) {
            for (let k = i; k < lineEnd; k++) out[k] = ' ';
            fenceChar = null;
            fenceLen = 0;
            i = lineEnd < len ? lineEnd + 1 : len;
            atLineStart = true;
            continue;
          }
        }
      }
    }

    if (fenceChar !== null) {
      if (text[i] === '\n') {
        atLineStart = true;
      } else {
        out[i] = ' ';
        atLineStart = false;
      }
      i++;
      continue;
    }

    if (text[i] === '`') {
      let tickRun = 0;
      while (i + tickRun < len && text[i + tickRun] === '`') tickRun++;
      // 在剩余文本中寻找相同长度的闭合反引号串（不跨越空行，避免流式或单个孤立反引号吃掉整段）
      let search = i + tickRun;
      let closeStart = -1;
      let prevNewline = false;
      while (search < len) {
        if (text[search] === '\n') {
          if (prevNewline) break;
          prevNewline = true;
          search++;
          continue;
        }
        if (text[search] !== ' ' && text[search] !== '\t' && text[search] !== '\r') {
          prevNewline = false;
        }
        if (text[search] === '`') {
          let closeRun = 0;
          while (search + closeRun < len && text[search + closeRun] === '`') closeRun++;
          if (closeRun === tickRun) {
            closeStart = search;
            break;
          }
          search += closeRun;
          continue;
        }
        search++;
      }
      if (closeStart >= 0) {
        const spanEnd = closeStart + tickRun;
        for (let k = i; k < spanEnd; k++) {
          if (out[k] !== '\n') out[k] = ' ';
        }
        atLineStart = false;
        i = spanEnd;
        continue;
      }
      // 未闭合的行内反引号：若是流式输出中同一行末尾的 `<agentd...`，屏蔽到行尾以防行内代码示例误触。
      let lineEnd = text.indexOf('\n', i + tickRun);
      if (lineEnd < 0) lineEnd = len;
      const tailOnLine = text.slice(i + tickRun, lineEnd);
      if (/<agentd/i.test(tailOnLine)) {
        for (let k = i; k < lineEnd; k++) out[k] = ' ';
        i = lineEnd;
        atLineStart = false;
        continue;
      }
      atLineStart = false;
      i += tickRun;
      continue;
    }

    atLineStart = text[i] === '\n';
    i++;
  }

  return out.join('');
}

export interface ExtractedTrailingXmlBlock {
  proseText: string;
  rawXml: string;
  rootAttrs: Record<string, string>;
  innerXml: string;
  startIndex: number;
  endIndex: number;
}

/**
 * 严格提取回答**末尾**的完整 `<tagName ...>...</tagName>` 块（支持可选自闭合检查前的标准双标签）：
 * - 自动忽略 Markdown 围栏代码块与行内代码；
 * - 闭合标签后仅允许空白字符；
 * - 起始与闭合之间若嵌套了同标签闭合，拒绝解析。
 */
export function extractTrailingXmlBlock(
  text: string | null | undefined,
  tagName: string,
  precomputedMasked?: string
): ExtractedTrailingXmlBlock | null {
  if (!text) return null;
  const normalizedTag = tagName.trim();
  if (!normalizedTag) return null;
  const tagLower = normalizedTag.toLowerCase();
  if (!text.toLowerCase().includes(tagLower)) return null;

  const masked = precomputedMasked ?? maskProtectedMarkdown(text);
  const maskedLower = masked.toLowerCase();
  const closeTag = `</${normalizedTag}>`;
  const closeLower = closeTag.toLowerCase();
  const closeIdx = maskedLower.lastIndexOf(closeLower);
  if (closeIdx < 0) return null;

  const endIndex = closeIdx + closeTag.length;
  if (text.slice(endIndex).trim() !== '') return null;

  const escapedTag = escapeRegexLiteral(normalizedTag);
  const openPattern = new RegExp(`<${escapedTag}(?=[\\s>])([^>]*)>`, 'gi');
  let lastOpenStart = -1;
  let lastOpenTagEnd = -1;
  let lastRawAttrs = '';
  const prefixSlice = masked.slice(0, closeIdx);
  let match: RegExpExecArray | null;
  while ((match = openPattern.exec(prefixSlice)) !== null) {
    lastOpenStart = match.index;
    lastOpenTagEnd = match.index + match[0].length;
    lastRawAttrs = text.slice(match.index + normalizedTag.length + 1, lastOpenTagEnd - 1);
  }
  if (lastOpenStart < 0 || lastOpenTagEnd < 0) return null;

  if (maskedLower.slice(lastOpenStart, closeIdx).includes(closeLower)) return null;

  const rawXml = text.slice(lastOpenStart, endIndex);
  const innerXml = text.slice(lastOpenTagEnd, closeIdx);
  const rootAttrs = parseXmlAttributes(lastRawAttrs);
  const proseText = text.slice(0, lastOpenStart).trimEnd();
  return { proseText, rawXml, rootAttrs, innerXml, startIndex: lastOpenStart, endIndex };
}

export interface PendingStreamingXmlTag {
  proseText: string;
  startIndex: number;
  partialTitle?: string;
  partialAttrs: Record<string, string>;
  /** true 表示已看到完整标签名（如 `<agentdock-foo`）；false 表示仅匹配流式前缀（如 `<agentd`）。 */
  exactTag: boolean;
}

/**
 * 探测流式输出末尾尚未闭合的指定 XML 标签（含 `<agentd...` 前缀阶段）。
 * 返回 null 表示末尾不存在该标签的未闭合片段或位于代码围栏内。
 */
export function detectPendingStreamingXmlTag(
  text: string,
  tagName: string,
  precomputedMasked?: string
): PendingStreamingXmlTag | null {
  if (!text) return null;
  const normalizedTag = tagName.trim();
  if (!normalizedTag) return null;

  const masked = precomputedMasked ?? maskProtectedMarkdown(text);
  const maskedLower = masked.toLowerCase();
  const openPrefix = `<${normalizedTag}`;
  const openLower = openPrefix.toLowerCase();
  const closeLower = `</${normalizedTag}>`.toLowerCase();

  // 1) 末尾已出现完整起始标签名 `<tagName` 且尚未闭合
  const lastOpen = maskedLower.lastIndexOf(openLower);
  if (lastOpen >= 0) {
    const afterChar = masked[lastOpen + openPrefix.length];
    const validBoundary = afterChar === undefined || afterChar === '>' || /\s/.test(afterChar);
    const hasCloseAfter = maskedLower.indexOf(closeLower, lastOpen) >= 0;
    if (validBoundary && !hasCloseAfter) {
      const openSlice = text.slice(lastOpen);
      const tagHeaderEnd = openSlice.indexOf('>');
      let partialAttrs: Record<string, string> = {};
      if (tagHeaderEnd > 0) {
        partialAttrs = parseXmlAttributes(openSlice.slice(openPrefix.length, tagHeaderEnd));
      }
      const partialTitle = partialAttrs.title?.trim() || undefined;
      return {
        proseText: text.slice(0, lastOpen).trimEnd(),
        startIndex: lastOpen,
        ...(partialTitle ? { partialTitle } : {}),
        partialAttrs,
        exactTag: true
      };
    }
  }

  // 2) 流式 token 刚吐到 `<agentd...`（至少 7 字符，避免误伤 HTML `<a>` / `<article>`）
  const partialTailMatch = /(?:^|\s)(<agentd[a-z0-9-]*)$/i.exec(masked);
  if (partialTailMatch) {
    const candidate = partialTailMatch[1]!.toLowerCase();
    if (openLower.startsWith(candidate)) {
      const start = masked.length - candidate.length;
      return {
        proseText: text.slice(0, start).trimEnd(),
        startIndex: start,
        partialAttrs: {},
        exactTag: false
      };
    }
  }

  return null;
}
