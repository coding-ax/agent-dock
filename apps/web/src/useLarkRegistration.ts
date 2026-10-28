import { useRef, useState } from 'react';
import { useMemoizedFn, useUnmount } from 'ahooks';
import { registerLarkBot, type RegistrationProgress, type RegistrationResult } from './lark-registration';

export type RegistrationState = RegistrationProgress | { kind: 'idle' } | { kind: 'success'; result: RegistrationResult } | { kind: 'error'; message: string };

export function useLarkRegistration() {
  const [state, setState] = useState<RegistrationState>({ kind: 'idle' });
  const active = useRef<AbortController | undefined>(undefined);
  const cancel = useMemoizedFn(() => { active.current?.abort(); active.current = undefined; });
  const start = useMemoizedFn(async () => {
    cancel();
    const controller = new AbortController();
    active.current = controller;
    setState({ kind: 'starting' });
    try {
      const result = await registerLarkBot(controller.signal, progress => {
        if (active.current === controller) setState(progress);
      });
      if (active.current === controller) setState({ kind: 'success', result });
    } catch (error) {
      if (active.current === controller && !controller.signal.aborted) setState({ kind: 'error', message: error instanceof Error ? error.message : '创建失败，请重试。' });
    } finally {
      if (active.current === controller) active.current = undefined;
    }
  });
  useUnmount(cancel);
  return { state, start, cancel };
}
