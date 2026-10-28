import { useRef } from 'react';
import { useCountDown } from 'ahooks';
import { QRCodeSVG } from 'qrcode.react';
import { Check, ExternalLink, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useLarkRegistration } from './useLarkRegistration';
import { useModalFocusTrap } from './useModalFocusTrap';
import type { RegistrationResult } from './lark-registration';

export function LarkRegistrationDialog({ onClose, onComplete }: { onClose(): void; onComplete(result: RegistrationResult): void }) {
  const { state, start, cancel } = useLarkRegistration();
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = () => { cancel(); onClose(); };
  useModalFocusTrap({ panel, initial: closeButton, dismissible: true, onDismiss: close });
  const [remaining] = useCountDown({ targetDate: state.kind === 'waiting' ? state.expiresAt : undefined });
  const expired = state.kind === 'waiting' && Date.now() >= state.expiresAt;
  const busy = state.kind === 'starting' || state.kind === 'saving';
  const buttonClass = 'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md px-3 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 disabled:opacity-50';
  return <div className="ui-overlay fixed inset-0 z-50 grid place-items-center bg-zinc-950/30 p-4" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="lark-registration-title" className="ui-dialog flex max-h-[calc(100dvh-2rem)] w-full max-w-[440px] flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3"><h2 id="lark-registration-title" className="text-[14px] font-semibold text-zinc-900">扫码创建飞书机器人</h2><button ref={closeButton} type="button" aria-label="关闭扫码创建" onClick={close} className={`${buttonClass} text-zinc-500 hover:bg-zinc-100`}><X size={16}/></button></div>
      <div className="space-y-4 overflow-y-auto px-5 py-5 text-[12px] leading-5 text-zinc-600">
        <p>使用飞书扫码，在授权页确认应用名称和权限。完成后自动保存凭证，再配置工作区、可用成员和 Agent。</p>
        <div aria-live="polite">
          {state.kind === 'idle' && <p className="rounded-md bg-zinc-50 p-3">将创建一个新应用。已有机器人的 App ID 和 App Secret 可通过手动配置接入。</p>}
          {busy && <div className="flex min-h-40 flex-col items-center justify-center gap-3"><LoaderCircle size={24} className="animate-spin text-zinc-500"/><span>{state.kind === 'saving' ? '授权已完成，正在保存机器人…' : '正在生成二维码…'}</span></div>}
          {state.kind === 'waiting' && !expired && <div className="flex flex-col items-center gap-3"><div className="w-full max-w-[248px] bg-white p-2"><QRCodeSVG value={state.url} size={232} marginSize={4} className="h-auto w-full" title="使用飞书扫描二维码创建机器人"/></div><p>{state.slow ? '飞书暂时限流，正在继续等待授权…' : '等待扫码并在飞书中确认授权'}</p><p className="text-[11px] text-zinc-400">二维码将在 {Math.max(1, Math.ceil(remaining / 1000))} 秒后过期</p><a href={state.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-zinc-700 underline underline-offset-4">在浏览器打开授权页<ExternalLink size={12}/></a></div>}
          {(expired || state.kind === 'error') && <p role="alert" className="rounded-md bg-amber-50 p-3 text-amber-800">{expired ? '二维码已过期，请重新生成。' : state.kind === 'error' ? state.message : ''}</p>}
          {state.kind === 'success' && <div className="space-y-3"><p className="flex items-center gap-2 font-medium text-emerald-700"><Check size={18}/>机器人已创建，凭证已保存</p><div className="border-y border-zinc-100 py-3"><p className="break-words font-medium text-zinc-900">{state.result.appName}</p><p className="break-all font-mono text-[11px] text-zinc-500">{state.result.appId}</p></div><p>接下来检查工作区和成员范围，再选择 Agent 完成接入。</p>{state.result.warning && <p className="text-amber-700">{state.result.warning}</p>}{state.result.config.listeningDisabled && <p className="text-amber-700">当前服务已禁用飞书监听；完成配置后需启用监听才能接收消息。</p>}</div>}
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-100 px-4 py-3">
        <button type="button" onClick={close} className={`${buttonClass} border border-zinc-200 text-zinc-600 hover:bg-zinc-50`}>{state.kind === 'idle' || state.kind === 'error' ? '返回手动配置' : state.kind === 'success' ? '稍后配置' : '取消'}</button>
        {state.kind === 'success' ? <button type="button" onClick={() => onComplete(state.result)} className={`${buttonClass} bg-zinc-900 text-white hover:bg-zinc-800`}>继续配置机器人</button> : (state.kind === 'idle' || state.kind === 'error' || expired) && <button type="button" onClick={() => void start()} className={`${buttonClass} bg-zinc-900 text-white hover:bg-zinc-800`}><RefreshCw size={12}/>{state.kind === 'idle' ? '生成二维码' : '重新生成'}</button>}
      </div>
    </div>
  </div>;
}
