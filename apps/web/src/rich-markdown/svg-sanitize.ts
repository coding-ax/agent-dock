import DOMPurify from 'dompurify';

const FORBIDDEN_SVG_TAGS = [
  'script',
  'foreignObject',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'applet',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'textarea',
  'button',
  'select',
  'audio',
  'video'
];

let domPurifyHooksInstalled = false;

function isSafeSvgHref(value: string): boolean {
  const trimmed = value.trim();
  // 仅允许 SVG 内部锚点引用（如 href="#grad1" / xlink:href="#arrow"），严禁外链与可执行协议
  return /^#[A-Za-z_][\w:.-]*$/.test(trimmed);
}

function sanitizeInlineStyleValue(style: string): string {
  // 清除任何可执行表达式、@import 或外链 url(...)（仅保留本地 url(#id)）
  return style
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/@import[^;]+;?/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/vbscript\s*:/gi, '')
    .replace(/url\s*\(\s*(['"]?)(?!#)[^)]*\1\s*\)/gi, 'none');
}

function ensureDomPurifyHooks(): void {
  if (domPurifyHooksInstalled || typeof window === 'undefined') return;
  if (typeof DOMPurify?.addHook !== 'function') return;
  domPurifyHooksInstalled = true;

  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    const attrName = data.attrName.toLowerCase();
    // 显式封杀所有 on* 事件处理器
    if (attrName.startsWith('on')) {
      data.keepAttr = false;
      return;
    }
    // 严格限制 href / xlink:href 仅允许本地 #fragment 引用
    if (attrName === 'href' || attrName === 'xlink:href' || attrName === 'src') {
      if (!isSafeSvgHref(data.attrValue)) {
        data.keepAttr = false;
        node.removeAttribute(data.attrName);
      }
      return;
    }
    if (attrName === 'style' && data.attrValue) {
      data.attrValue = sanitizeInlineStyleValue(data.attrValue);
    }
  });
}

/**
 * 确定性纵深防御清理（既作为 Node/SSR 环境兜底，也作为浏览器 DOMPurify 后的二次守卫）。
 * 严禁 `<script>`、`<foreignObject>`、`<iframe>`、`<object>`、`<embed>`、`on*`、危险协议及外链 `href`/`xlink:href`。
 */
function deterministicSvgGuard(markup: string): string {
  let clean = markup;

  // 1. 删除危险成对标签与自闭合标签（含跨行）
  for (const tag of FORBIDDEN_SVG_TAGS) {
    const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
    const selfClosing = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
    clean = clean.replace(paired, '').replace(selfClosing, '');
  }

  // 2. 清理 <style> 内部危险规则（外链 @import / url(http...) / javascript: / expression）
  clean = clean.replace(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi, (_m, attrs: string, css: string) => {
    const safeCss = sanitizeInlineStyleValue(css);
    return `<style${attrs}>${safeCss}</style>`;
  });

  // 3. 删除所有 on* 事件属性（双引号 / 单引号 / 无引号）
  clean = clean.replace(/\s+on[a-zA-Z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // 4. 删除危险或外链 href / xlink:href / src 属性（仅放行 #localId）
  clean = clean.replace(
    /\s+((?:xlink:)?href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (full, _attr: string, dq?: string, sq?: string, bare?: string) => {
      const value = dq ?? sq ?? bare ?? '';
      return isSafeSvgHref(value) ? full : '';
    }
  );

  // 5. 清理行内 style 属性中的危险片段
  clean = clean.replace(/\s+style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (_full, dq?: string, sq?: string) => {
    const raw = dq ?? sq ?? '';
    const safe = sanitizeInlineStyleValue(raw).trim();
    return safe ? ` style="${safe.replace(/"/g, '&quot;')}"` : '';
  });

  // 6. 兜底剥离任意残留的 javascript:/vbscript:/data:text/html 协议
  clean = clean.replace(/\b(?:javascript|vbscript)\s*:/gi, '');
  clean = clean.replace(/\bdata\s*:\s*text\/html/gi, '');

  return clean.trim();
}

function parseNumericAttr(tag: string, attr: string): number | null {
  const re = new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]+)"|'([^']+)')`, 'i');
  const match = re.exec(tag);
  if (!match) return null;
  const raw = (match[1] ?? match[2] ?? '').trim();
  if (raw.endsWith('%')) return null;
  const num = Number.parseFloat(raw);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * 规范化根 `<svg>` 属性：补充 xmlns，若缺失 viewBox 且有明确数值 width/height 则自动补齐 viewBox，
 * 确保响应式缩放（390px 移动端不撑破容器，桌面端与 Lightbox 清晰自适应）。
 */
function normalizeSvgRoot(svg: string): string {
  const openTagMatch = /<svg\b[^>]*>/i.exec(svg);
  if (!openTagMatch) return '';

  let openTag = openTagMatch[0];
  if (!/\bxmlns\s*=/i.test(openTag)) {
    openTag = openTag.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  const hasViewBox = /\bviewBox\s*=/i.test(openTag);
  const hasWidth = /\bwidth\s*=/i.test(openTag);
  if (!hasViewBox) {
    const w = parseNumericAttr(openTag, 'width');
    const h = parseNumericAttr(openTag, 'height');
    if (w && h) {
      openTag = openTag.replace(/>$/, ` viewBox="0 0 ${w} ${h}">`);
    }
  } else if (!hasWidth) {
    // 仅有 viewBox 而无 width 时，在 flex 容器内可能被收缩为 0px；补全逻辑 width 配合 CSS max-width:100%;height:auto 既保清晰又保响应式。
    const vbMatch = /\bviewBox\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(openTag);
    const parts = (vbMatch?.[1] ?? vbMatch?.[2] ?? '').trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && Number.isFinite(parts[2]) && parts[2]! > 0) {
      openTag = openTag.replace(/>$/, ` width="${parts[2]!}">`);
    }
  }

  return svg.slice(0, openTagMatch.index) + openTag + svg.slice(openTagMatch.index + openTagMatch[0].length);
}

/** 从 SVG 源码提取逻辑宽高，供高清 PNG 导出与 Lightbox 居中排版使用。 */
export function parseSvgDimensions(svg: string): { width: number; height: number } {
  const openTag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const vbMatch = /\bviewBox\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(openTag);
  if (vbMatch) {
    const parts = (vbMatch[1] ?? vbMatch[2] ?? '')
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (parts.length === 4 && Number.isFinite(parts[2]) && Number.isFinite(parts[3]) && parts[2]! > 0 && parts[3]! > 0) {
      return { width: parts[2]!, height: parts[3]! };
    }
  }
  const w = parseNumericAttr(openTag, 'width');
  const h = parseNumericAttr(openTag, 'height');
  if (w && h) return { width: w, height: h };
  return { width: 800, height: 480 };
}

/**
 * 对 ```svg 代码块执行严格防 XSS 消毒并返回可直接内联渲染的安全 SVG 字符串。
 * 若输入不是合法 `<svg>`，返回 null（渲染层静默回退为代码块）。
 */
export function sanitizeSvgMarkup(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || !/<svg[\s>]/i.test(trimmed)) return null;

  // 截取从第一个 <svg 到最后一个 </svg>（容忍前后 XML 声明或注释）
  const startIdx = trimmed.search(/<svg[\s>]/i);
  const endIdx = trimmed.toLowerCase().lastIndexOf('</svg>');
  if (startIdx < 0 || endIdx < startIdx) return null;
  const candidate = trimmed.slice(startIdx, endIdx + 6);

  let sanitized = candidate;

  // 浏览器环境优先走 DOMPurify SVG 严格白名单配置
  if (typeof window !== 'undefined' && typeof DOMPurify?.sanitize === 'function') {
    ensureDomPurifyHooks();
    sanitized = DOMPurify.sanitize(candidate, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: FORBIDDEN_SVG_TAGS,
      ADD_ATTR: ['viewBox', 'preserveAspectRatio', 'xmlns', 'xmlns:xlink']
    });
  }

  // 纵深防御：浏览器 + Node/SSR 统一再过一层确定性守卫
  sanitized = deterministicSvgGuard(sanitized);

  if (!/<svg[\s>]/i.test(sanitized) || !/<\/svg\s*>$/i.test(sanitized)) {
    return null;
  }

  const normalized = normalizeSvgRoot(sanitized);
  return normalized || null;
}
