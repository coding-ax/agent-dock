import { message } from 'antd';

/**
 * 一次性提示（顶部居中，超时自动消失）。底层是 antd message，主题跟随根部 ConfigProvider。
 *
 * 同一时刻只保留一条：多条并排会互相遮挡且抢注意力，新的直接替换旧的。
 * `toast` 是挂载点（antd 的 contextHolder），调用方把它放进自己的 JSX 里。
 */
export function useToast(durationMs = 6_000) {
  const [api, toast] = message.useMessage({ maxCount: 1 });
  const key = 'agentdock-toast';
  return {
    toast,
    show: (text: string | undefined, tone: 'error' | 'info' | 'success' = 'error') => {
      if (!text) { api.destroy(key); return; }
      const type = tone === 'error' ? 'error' : tone === 'success' ? 'success' : 'info';
      void api.open({ key, type, content: text, duration: durationMs / 1000 });
    },
    clear: () => api.destroy(key)
  };
}
