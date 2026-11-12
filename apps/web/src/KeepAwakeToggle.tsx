import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Switch } from 'antd';
import { api } from './api';
import { HoverTooltip } from './HoverTooltip';
import { useToast } from './Toast';

/**
 * 侧边栏底部的「永不休眠」开关（macOS caffeinate），「屏幕常亮」是它的子开关。
 *
 * 只在服务端报告 supported 时渲染：非 macOS、没有 caffeinate、或会话级 token 没有写权限，
 * 都不会出现一个点不动的开关。和开机自启一样是管理面能力，只对本机所有者开放。
 *
 * 请求进行中时另一个开关禁用：两个开关写同一份状态，先请求后响应可能互相覆盖。
 */
export function KeepAwakeToggle({ enabled }: { enabled: boolean }) {
  const toast = useToast(8_000);
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['keep-awake'], queryFn: api.keepAwakeStatus, enabled, retry: false, refetchOnWindowFocus: false });
  const toggle = useMutation({
    mutationFn: api.setKeepAwake,
    // 两个开关写的是同一份状态，串行执行，避免并发响应后写覆盖前写。
    scope: { id: 'keep-awake' },
    onSuccess: next => qc.setQueryData(['keep-awake'], next),
    onError: error => { toast.show(error.message); void status.refetch(); }
  });
  const data = status.data;
  if (!data?.supported) return null;
  const pending = toggle.isPending;
  // 请求回来前先用刚提交的目标值，避免开关闪回旧状态。
  const checked = pending && toggle.variables?.enabled !== undefined ? toggle.variables.enabled : data.enabled;
  const keepDisplay = pending && toggle.variables?.keepDisplay !== undefined ? toggle.variables.keepDisplay : data.keepDisplay;
  const mainPending = pending && toggle.variables?.enabled !== undefined;
  const displayPending = pending && toggle.variables?.keepDisplay !== undefined;
  return <>
    <div className="flex h-[34px] items-center gap-1 text-[12px]">
      <HoverTooltip content="AgentDock 运行期间用 caffeinate -imsu 阻止 Mac 空闲休眠；daemon 退出后自动释放，下次启动按上次选择恢复">
        <span className="min-w-0 flex-1 truncate">永不休眠</span>
      </HoverTooltip>
      <Switch size="small" className="!ml-auto shrink-0" aria-label="永不休眠" checked={checked} loading={mainPending} disabled={displayPending} onChange={value => toggle.mutate({ enabled: value })}/>
    </div>
    <div className={`flex h-[34px] items-center gap-1 pl-4 text-[12px] transition-opacity ${checked ? '' : 'opacity-50'}`}>
      <HoverTooltip content="额外加 -d，阻止显示器休眠以保持屏幕常亮；关闭主开关时保留这个偏好">
        <span className="min-w-0 flex-1 truncate">屏幕常亮</span>
      </HoverTooltip>
      <Switch size="small" className="!ml-auto shrink-0" aria-label="保持屏幕常亮" disabled={!checked || mainPending} checked={keepDisplay} loading={displayPending} onChange={value => toggle.mutate({ keepDisplay: value })}/>
    </div>
    {toast.toast}
  </>;
}
