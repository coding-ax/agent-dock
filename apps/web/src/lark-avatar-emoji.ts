import {
  findLarkReactionEmoji,
  larkReactionEmojiOptions,
  normalizeLarkReactionEmoji
} from '@agent-dock/agent-dock-shared';

export interface ReactionEmojiRow {
  code: string;
  emoji: string;
  label: string;
  /** 历史配置不在常用集合里；保留而不是清空。 */
  custom: boolean;
}

export interface ReactionEmojiSelection {
  code: string;
  emoji: string;
  label: string;
  custom: boolean;
}

const unknownPreview = (code: string): string => {
  const normalized = code.trim();
  if (!normalized) return '＋';
  // 历史值如果是 unicode 表情，直接展示；否则给一个中性占位符，避免编造不存在的飞书表情。
  return /\p{Extended_Pictographic}/u.test(normalized) ? normalized : '•';
};

/** 下拉列表：未选择时是常用集合；历史自定义值置顶并标记，便于保留。 */
export function reactionEmojiRows(current: string): ReactionEmojiRow[] {
  const value = current.trim();
  const known: ReactionEmojiRow[] = larkReactionEmojiOptions.map(option => ({ ...option, custom: false }));
  if (!value) return known;
  if (findLarkReactionEmoji(normalizeLarkReactionEmoji(value) ?? value)) return known;
  return [{ code: value, emoji: unknownPreview(value), label: '当前配置（不在常用集合）', custom: true }, ...known];
}

/** 按钮上的回显：选中项或历史自定义值。 */
export function reactionEmojiSelection(current: string): ReactionEmojiSelection | undefined {
  const value = current.trim();
  if (!value) return undefined;
  const known = findLarkReactionEmoji(normalizeLarkReactionEmoji(value) ?? value);
  return known
    ? { ...known, custom: false }
    : { code: value, emoji: unknownPreview(value), label: '当前值', custom: true };
}

export function reactionEmojiIsCustom(current: string): boolean {
  const value = current.trim();
  return Boolean(value) && !findLarkReactionEmoji(normalizeLarkReactionEmoji(value) ?? value);
}

/** 保存时原样写回，后端负责最终规范化与兼容历史值。 */
export function reactionEmojiPayload(current: string): { reactionTriggerEmoji: string } {
  return { reactionTriggerEmoji: current.trim() };
}
