/**
 * 飞书 reaction 常用 emoji_type。
 *
 * 代码来自飞书官方《表情回复 emoji 列表》：
 * https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
 * 注意 `Fire`、`Trophy`、`Music` 等是大小写敏感的混合大小写代码，不能统一转大写。
 */

export interface LarkReactionEmojiOption {
  /** 飞书 emoji_type 原文。 */
  code: string;
  /** 选择器里的预览字符。 */
  emoji: string;
  /** 中文名，便于不认识 emoji 代码的人选择。 */
  label: string;
}

export const larkReactionEmojiOptions: readonly LarkReactionEmojiOption[] = [
  { code: 'THUMBSUP', emoji: '👍', label: '点赞' },
  { code: 'OK', emoji: '👌', label: '好的' },
  { code: 'DONE', emoji: '✅', label: '完成' },
  { code: 'HEART', emoji: '❤️', label: '爱心' },
  { code: 'SMILE', emoji: '😄', label: '微笑' },
  { code: 'LAUGH', emoji: '😂', label: '大笑' },
  { code: 'Fire', emoji: '🔥', label: '火' },
  { code: 'PARTY', emoji: '🎉', label: '庆祝' },
  { code: 'GLANCE', emoji: '👀', label: '偷看（眼睛）' },
  { code: 'CLAP', emoji: '👏', label: '鼓掌' },
  { code: 'FINGERHEART', emoji: '🫰', label: '比心' },
  { code: 'PRAISE', emoji: '🙌', label: '赞赏' },
  { code: 'JIAYI', emoji: '☝️', label: '加一' },
  { code: 'WINK', emoji: '😉', label: '眨眼' },
  { code: 'WOW', emoji: '😮', label: '哇' },
  { code: 'MUSCLE', emoji: '💪', label: '加油' },
  { code: 'THANKS', emoji: '🙏', label: '感谢' },
  { code: 'APPLAUSE', emoji: '👏', label: '喝彩' },
  { code: 'ROSE', emoji: '🌹', label: '玫瑰' },
  { code: 'BEER', emoji: '🍺', label: '啤酒' },
  { code: 'CAKE', emoji: '🎂', label: '蛋糕' },
  { code: 'GIFT', emoji: '🎁', label: '礼物' },
  { code: 'Trophy', emoji: '🏆', label: '奖杯' },
  { code: 'BOMB', emoji: '💣', label: '炸弹' },
  { code: 'Music', emoji: '🎵', label: '音乐' },
  { code: 'FIREWORKS', emoji: '🎆', label: '烟花' },
  { code: 'HEARTBROKEN', emoji: '💔', label: '心碎' },
  { code: 'POOP', emoji: '💩', label: '便便' },
  { code: 'Hundred', emoji: '💯', label: '一百分' },
  { code: 'CheckMark', emoji: '✔️', label: '勾' },
  { code: 'CrossMark', emoji: '❌', label: '叉' },
  { code: 'Coffee', emoji: '☕', label: '咖啡' },
  { code: 'Pin', emoji: '📌', label: '图钉' },
  { code: 'SALUTE', emoji: '🫡', label: '敬礼' }
];

const emojiKey = (value: string): string => value.replace(/\uFE0F/g, '');
const byCode = new Map(larkReactionEmojiOptions.map(option => [option.code, option]));
const byLowerCode = new Map(larkReactionEmojiOptions.map(option => [option.code.toLowerCase(), option.code]));
const byEmoji = new Map(larkReactionEmojiOptions.map(option => [emojiKey(option.emoji), option.code]));

/** 官方列表里常见、但不在常用集合里的 unicode 预览。 */
const extraEmojiAliases: Record<string, string> = {
  '😀': 'SMILE',
  '😃': 'SMILE',
  '😁': 'SMILE',
  '😊': 'BLUSH',
  '🫶': 'FINGERHEART',
  '🙌': 'PRAISE',
  '✌️': 'YEAH',
  '💯': 'Hundred',
  '☕': 'Coffee',
  '🎯': 'OKR',
  '📌': 'Pin'
};

export function findLarkReactionEmoji(code: string): LarkReactionEmojiOption | undefined {
  return byCode.get(code.trim());
}

/**
 * 规范化为飞书的 emoji_type。
 * - 空串表示「未选择」；
 * - 已在常用集合里的代码大小写不敏感地回正（`fire` → `Fire`）；
 * - 历史自定义值只要是代码形态就原样保留，不因为前端收窄而丢掉；
 * - 常见 unicode emoji 转成对应代码；
 * - 其他内容返回 undefined，由调用方报 400。
 */
export function normalizeLarkReactionEmoji(input: unknown): string | undefined {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'string') return undefined;
  const raw = input.trim();
  if (!raw) return '';
  const stripped = raw.replace(/^:+|:+$/g, '').trim();
  if (!stripped) return '';

  const exact = byCode.get(stripped);
  if (exact) return exact.code;
  const known = byLowerCode.get(stripped.toLowerCase());
  if (known) return known;

  const emojiCode = byEmoji.get(emojiKey(stripped)) ?? extraEmojiAliases[stripped] ?? extraEmojiAliases[emojiKey(stripped)];
  if (emojiCode) return emojiCode;

  // 飞书还有 `2022` 这类纯数字代码；历史自定义值也允许是普通代码形态。
  return /^[A-Za-z0-9][A-Za-z0-9_]*$/.test(stripped) ? stripped : undefined;
}
