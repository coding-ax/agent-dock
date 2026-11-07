import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 读 Codex 自己给会话起的名字。
 *
 * Codex 不通过 ACP 的 `session_info_update` 推标题，但会把它生成的 `thread_name` 追加写进
 * `$CODEX_HOME/session_index.jsonl`（每行 `{ id, thread_name, updated_at }`，id 就是 ACP 的 acpSessionId）。
 * 同一个 id 可能出现多行（改名），以最后一行为准。读失败、没有该 id、名字为空都返回 undefined，
 * 由上层回退到首条 prompt 摘要——标题是锦上添花，不能影响一轮的执行。
 */
export async function readCodexThreadName(threadId: string | undefined, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')): Promise<string | undefined> {
  if (!threadId) return;
  let text: string;
  try { text = await readFile(join(codexHome, 'session_index.jsonl'), 'utf8'); }
  catch { return; }
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line || !line.includes(threadId)) continue;
    try {
      const entry = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
      if (entry.id === threadId && typeof entry.thread_name === 'string' && entry.thread_name.trim()) return entry.thread_name.trim();
    } catch { /* 损坏的行跳过 */ }
  }
}
