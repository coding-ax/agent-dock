import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Switch } from 'antd';
import { api } from './api';
import { HoverTooltip } from './HoverTooltip';
import { useT } from './i18n';
import { useToast } from './Toast';

/**
 * 侧边栏底部的「开机自启」开关（macOS launchd）。
 *
 * 只对本机所有者开放：会话级 token 没有写权限，请求 403 时静默不显示；不支持的平台 / 沙箱也不显示，
 * 避免出现一个永远点不动的开关。
 */
export function AutostartToggle({ enabled }: { enabled: boolean }) {
  const t = useT();
  const toast = useToast(8_000);
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['autostart'], queryFn: api.autostartStatus, enabled, retry: false, refetchOnWindowFocus: false });
  const toggle = useMutation({
    mutationFn: api.setAutostart,
    onSuccess: next => qc.setQueryData(['autostart'], next),
    onError: error => { toast.show(error.message); void status.refetch(); }
  });
  const data = status.data;
  if (!data?.supported) return null;
  const checked = toggle.isPending ? Boolean(toggle.variables) : data.enabled;
  const label = t('power.autostart.label');
  return <div className="flex h-[34px] items-center gap-2 text-[12px]">
    <HoverTooltip content={data.enabled ? t('power.autostart.tooltipOn', { path: data.plistPath ?? '' }) : t('power.autostart.tooltipOff')}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </HoverTooltip>
    <Switch size="small" className="!ml-auto shrink-0" aria-label={label} checked={checked} loading={toggle.isPending} onChange={value => toggle.mutate(value)}/>
  </div>;
}
