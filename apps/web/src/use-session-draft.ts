import { useEffect, useRef, useState } from 'react';
import {
  createSessionDraftWriter,
  getBrowserDraftStorage,
  registerDraftFlush,
  type DraftStorage,
  type SessionDraftWriter
} from './session-drafts';

/**
 * 把输入框内容按会话防抖落盘。组件卸载和页面隐藏时各 flush 一次，
 * 所以切会话或刷新都不会丢掉最后一次按键。
 */
export function useSessionDraftWriter(
  sessionId: string | undefined,
  value: string,
  options: { enabled?: boolean; skipEmptyValue?: boolean; storage?: DraftStorage } = {}
): SessionDraftWriter {
  const [writer] = useState(() => createSessionDraftWriter({
    storage: options.storage ?? getBrowserDraftStorage()
  }));
  const enabled = options.enabled !== false;
  const skipEmptyValue = Boolean(options.skipEmptyValue);
  const state = useRef({ enabled, skipEmptyValue });
  state.current = { enabled, skipEmptyValue };
  const activeSessionId = useRef(sessionId);

  useEffect(() => {
    // 同一组件被复用到另一个会话时，先把上一个会话的 pending 落到它自己的 key，
    // 再开始写新会话；否则新写入会覆盖旧 pending，草稿跟着会话串位。
    if (activeSessionId.current !== sessionId) {
      writer.flush();
      activeSessionId.current = sessionId;
    }
    if (!sessionId || !state.current.enabled) return;
    // 发送中的空值只是乐观清屏，不代表用户删除了草稿；成功或失败后状态会再变一次。
    if (!value && state.current.skipEmptyValue) return;
    writer.write(sessionId, value);
  }, [sessionId, value, enabled, skipEmptyValue, writer]);

  useEffect(() => {
    const flush = () => writer.flush();
    const unregister = registerDraftFlush(window, flush);
    const onVisibilityChange = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      unregister();
      flush();
    };
  }, [writer]);

  return writer;
}
