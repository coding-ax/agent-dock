/**
 * 输入框粘贴策略。
 *
 * 背景：从消息/文档里复制一条「参考链接」再贴进输入框，Milkdown 的 clipboard 插件会把
 * text/html 里的 <a> 原样插到光标处。光标若正好停在上一枚链接（或一段正文）的末尾，
 * 新链接就紧紧粘在后面，既看不出是两枚链接，也不好选中/删除——用户原话是
 * 「参考链接复制后，直接输入会贴到链接的后面」。
 *
 * 策略：**只**接管「剪贴板内容就是一条链接」这一种情况，插成一个独立的 Markdown
 * 链接 token（`[显示文字](url)`），并在与前文相连时先补一个空格。其余（多行正文、
 * 代码块、表格、带格式的片段）完全交给 Milkdown，避免把富文本粘贴改坏。
 */

export type PastedLink = { url: string; label: string };

const URL_PATTERN = /^(https?:\/\/|file:\/\/)\S+$/i;

/** 从 `<a href="…">文字</a>` 里取出 href 与可见文字；不是单个链接时返回 undefined。 */
export function linkFromPastedHtml(html: string): PastedLink | undefined {
  const match = html.match(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/i);
  if (!match) return undefined;
  // 只接受「整段 HTML 就是这一个链接」：a 标签之外除了空白/包裹元素什么都不留。
  const without = html.replace(match[0], '').replace(/<(?:meta|html|body|head|span|div|p|br)\b[^>]*>|<\/(?:meta|html|body|head|span|div|p)>/gi, '').trim();
  if (without) return undefined;
  const url = (match[1] ?? match[2] ?? match[3] ?? '').trim();
  const label = match[4]!.replace(/<[^>]+>/g, '').trim() || url;
  return URL_PATTERN.test(url) ? { url, label } : undefined;
}

/**
 * 把剪贴板（text/plain + text/html）归一成一枚链接。
 * html 优先（能拿到锚文本），否则认纯文本里的裸 URL；两者不一致时以纯文本为准。
 */
export function pastedLink(plain: string, html?: string): PastedLink | undefined {
  const text = (plain ?? '').trim();
  const fromText = URL_PATTERN.test(text) ? { url: text, label: text } : undefined;
  const fromHtml = html ? linkFromPastedHtml(html) : undefined;
  if (fromText) return fromHtml && fromHtml.url === text ? { url: text, label: fromHtml.label } : fromText;
  return fromHtml;
}

/** 链接写成什么 Markdown，以及要不要补前导空格（由调用方分两步用）。 */
export function linkedPasteToken(link: PastedLink): string {
  return link.label === link.url ? `<${link.url}>` : `[${link.label.replace(/[\[\]()]/g, '')}](${link.url})`;
}

/** 光标前没有空白时补一个前导空格，保证新链接不和前文（尤其是上一枚链接）粘在一起。 */
export function needsPasteSeparator(before: string): boolean {
  return Boolean(before) && !/\s$/.test(before);
}
