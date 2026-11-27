/**
 * 字典序分形索引（Fractional Indexing）。
 *
 * 字符表按 ASCII 严格递增排列（0-9 A-Z a-z，共 62 进制），且生成的键永不以 `'0'` 结尾：
 * 这使得 SQLite `ORDER BY position ASC` 与 JavaScript 字典序比较（`a < b`）完全一致，
 * 单次拖拽排序只需 UPDATE 被移动的 1 行记录，不重写整列。
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length; // 62
const MAX_DIGIT = BASE - 1;

function digitAt(key: string, index: number): number {
  if (index >= key.length) return 0;
  const value = DIGITS.indexOf(key[index]!);
  if (value < 0) throw new Error(`Invalid fractional index character "${key[index]}" in "${key}"`);
  return value;
}

export function compareOrderKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * 生成严格位于 `(before, after)` 之间的排序键。
 * - `before = null | undefined` 表示排到最前；
 * - `after = null | undefined` 表示排到最后；
 * - 两者皆空返回中点键 `'V'`。
 */
export function generateKeyBetween(before?: string | null, after?: string | null): string {
  const a = before?.trim() || null;
  const b = after?.trim() || null;

  if (a !== null && b !== null && a >= b) {
    throw new Error(`Invalid fractional index bounds: "${a}" >= "${b}"`);
  }

  let index = 0;
  let prefix = '';

  while (true) {
    const da = a === null ? 0 : digitAt(a, index);
    const db = b === null ? (index === 0 ? BASE : 0) : digitAt(b, index);

    if (da === db) {
      prefix += DIGITS[da]!;
      index += 1;
      continue;
    }

    if (db - da > 1) {
      const mid = Math.floor((da + db) / 2);
      return prefix + DIGITS[mid]!;
    }

    // 相邻数字（db = da + 1）：保留 da，在后续位找一个严格大于 a 剩余部分的后缀。
    prefix += DIGITS[da]!;
    let tailIndex = index + 1;
    while (true) {
      const tailDigit = a === null ? 0 : digitAt(a, tailIndex);
      if (tailDigit < MAX_DIGIT) {
        const mid = Math.floor((tailDigit + BASE) / 2);
        return prefix + DIGITS[mid]!;
      }
      prefix += DIGITS[MAX_DIGIT]!;
      tailIndex += 1;
    }
  }
}

/**
 * 批量生成 `count` 个严格递增且位于 `(before, after)` 之间的键。
 * 采用二分递归分割，保持键长度极短（100 项仅 2 字符左右）。
 */
export function generateNKeysBetween(before: string | null | undefined, after: string | null | undefined, count: number): string[] {
  if (count <= 0) return [];
  if (count === 1) return [generateKeyBetween(before, after)];
  const midCount = Math.floor(count / 2);
  const midKey = generateKeyBetween(before, after);
  const left = generateNKeysBetween(before, midKey, midCount);
  const right = generateNKeysBetween(midKey, after, count - midCount - 1);
  return [...left, midKey, ...right];
}
