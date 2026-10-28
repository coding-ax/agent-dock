import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, type Query } from '@tanstack/react-query';
import { KeyRound, LoaderCircle, Lock } from 'lucide-react';
import { api, type WebAccessDeniedError } from './api';

export const AUTH_STATUS_QUERY_KEY = ['auth-status'] as const;

/**
 * 收到访问门 401/403 时取消其余在途查询，但必须放过公开的 `/api/auth/status`：
 * 首屏并发请求会先后触发多次拒绝事件，第 2 次事件到达时 WebAccessDeniedPanel 已经挂载并
 * 发出了 auth-status 查询；无差别 cancelQueries 会把它标为已取消，导致即便服务端返回
 * `{ passwordEnabled: true }` 也被丢弃，密码框偶现不渲染。
 */
export const shouldCancelOnAccessDenied = (query: Pick<Query, 'queryKey'>) => query.queryKey[0] !== AUTH_STATUS_QUERY_KEY[0];

/**
 * 拒绝面板里的本机绕行地址。端口沿用当前地址：经 SSH 隧道 / 端口转发访问时，
 * 浏览器看到的端口就是隧道口，用户只要把主机名换掉即可，不用去猜 daemon 的真实端口。
 */
export function localBypassUrl(port: string): string {
  return `http://localhost${port ? `:${port}` : ''}/`;
}

/**
 * 访问门拒绝时的整页面板。设了访问密码就给一个密码框：输对后服务端种下全权 cookie，
 * 整页重新加载——拒绝发生时全部查询已被取消，重载比逐个恢复状态可靠。
 * 会话链接越权（403）也给密码框：用户是机器所有者时，输密码即可升级为全权访问。
 */
export function WebAccessDeniedPanel({ denied }: { denied: WebAccessDeniedError }) {
  const [password, setPassword] = useState('');
  const status = useQuery({ queryKey: AUTH_STATUS_QUERY_KEY, queryFn: api.authStatus, retry: false });
  const login = useMutation({ mutationFn: api.login, onSuccess: () => window.location.reload() });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (password && !login.isPending) login.mutate(password);
  };
  const passwordEnabled = status.data?.passwordEnabled === true;
  const localUrl = localBypassUrl(window.location.port);

  return <div className="grid h-full place-items-center bg-[#f7f8fa] p-6">
    <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 text-center shadow-[0_24px_80px_rgba(24,24,27,.08)]">
      <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-amber-50 text-amber-600"><Lock size={20}/></div>
      <h1 className="text-[15px] font-semibold text-zinc-900">{denied.status === 403 ? '该链接无权访问此资源' : '访问凭证缺失或已过期'}</h1>
      <p className="mt-2 text-[12px] leading-5 text-zinc-500">{denied.message || '请从飞书卡片上的「查看详情」重新打开；本机使用请用 agent-dock 启动输出的带凭证控制台地址。'}</p>
      {passwordEnabled && <form onSubmit={submit} className="mt-5 text-left">
        <label htmlFor="agentdock-password" className="text-[11px] font-medium text-zinc-600">或输入访问密码进入控制台</label>
        <div className="mt-1.5 flex gap-2">
          <input id="agentdock-password" type="password" autoFocus autoComplete="current-password" value={password} onChange={event => { setPassword(event.target.value); login.reset(); }} placeholder="访问密码" className="h-9 min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 text-[13px] text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-zinc-500"/>
          <button type="submit" disabled={!password || login.isPending} className="flex h-9 min-w-16 items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-3 text-[12px] font-medium text-white hover:bg-zinc-700 disabled:opacity-40">{login.isPending ? <LoaderCircle size={14} className="animate-spin"/> : <><KeyRound size={13}/>进入</>}</button>
        </div>
        {login.error && <p role="alert" className="mt-1.5 text-[11px] text-red-600">{login.error.message}</p>}
      </form>}
      {/* 最常见的误用就是拿局域网 IP / 转发端口打开：那种 Host 永远不会被当成「本机」，
          cookie 又绑死在那个字面 IP 上，换个网段就得重输一次。这里直接给出该换的地址。 */}
      <p className="mt-4 border-t border-zinc-100 pt-3 text-[11px] leading-5 text-zinc-400">
        若浏览器与 daemon 同机，或这条地址是你自己用 SSH 隧道 / 端口转发出来的，改用 <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[10.5px] text-zinc-600">{localUrl}</code> 打开即可免密进入，且换网段也不用重输。
      </p>
      {status.isSuccess && !passwordEnabled && <p className="mt-3 border-t border-zinc-100 pt-3 text-[11px] leading-5 text-zinc-400">也可以在本机终端运行 <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[10.5px] text-zinc-600">agent-dock password set</code> 设置访问密码，之后在这里输入密码即可进入。</p>}
    </div>
  </div>;
}
