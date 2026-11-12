import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, Dices, PawPrint, Sparkles, X } from 'lucide-react';
import { api, type AssistantQuietHours } from './api';
import { normalizeSilentEmoji } from './silent-trigger';
import { useModalFocusTrap } from './useModalFocusTrap';
import { DeferredMount, DeferredSkeleton } from './DeferredMount';
import { ConfirmDialog, SettingRow } from './ui-controls';
import { Kitten } from './companion/Kitten';
import { pickKittenName, sinceLabel } from './companion/companion-model';
import { useAssistantState, useCompanion } from './companion/useCompanion';
import { useCompanionStore } from './companion/companion-store';

const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败';

/**
 * 小猫与督办设置。小猫就是主会话：唯一能派活、验收、配置 watch 的会话。
 * 认领在首页完成（这里没认领时只给一个「去认领」）；认领后可以改名、打开、让它休息（解除主会话）。
 * 静默时段只影响普通通知，默认关闭，起止时间由用户自己定。
 */
export function AssistantSettingsDialog({ onClose, onOpenMain, onAdopt }: { onClose(): void; onOpenMain(): void; onAdopt(): void }) {
  const queryClient = useQueryClient();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useModalFocusTrap({ panel: panelRef, initial: closeRef, dismissible: true, onDismiss: onClose });
  const state = useAssistantState();
  const info = useCompanion();
  const inviteDismissed = useCompanionStore(store => store.inviteDismissed);
  const [quiet, setQuiet] = useState<AssistantQuietHours | null>(null);
  const [name, setName] = useState('');
  const [silentEmoji, setSilentEmoji] = useState('');
  const [silentError, setSilentError] = useState<string>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [silentSaved, setSilentSaved] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(false);

  useEffect(() => {
    if (state.data?.quietHours && !quiet) setQuiet(state.data.quietHours);
  }, [state.data?.quietHours, quiet]);
  useEffect(() => {
    if (state.data?.silentEmoji !== undefined) setSilentEmoji(state.data.silentEmoji);
  }, [state.data?.silentEmoji]);
  useEffect(() => { if (info.adopted) setName(info.name); }, [info.adopted, info.name]);

  const refresh = () => {
    setError(undefined);
    void queryClient.invalidateQueries({ queryKey: ['assistant-state'] });
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
  };
  const fail = (value: unknown) => setError(errorText(value));

  const rename = useMutation({ mutationFn: (value: string) => api.assistantRenameCompanion(value), onSuccess: () => { refresh(); useCompanionStore.getState().celebrate(); }, onError: fail });
  const release = useMutation({ mutationFn: () => api.assistantClearMain(), onSuccess: () => { setConfirmRelease(false); refresh(); }, onError: error => { setConfirmRelease(false); fail(error); } });
  const saveQuiet = useMutation({
    mutationFn: (value: AssistantQuietHours) => api.assistantSaveSettings({ quietHours: value }),
    onSuccess: result => { setQuiet(result.quietHours); setSaved(true); refresh(); },
    onError: fail
  });
  const saveSilent = useMutation({
    mutationFn: (value: string) => api.assistantSaveSettings({ silentEmoji: value }),
    onSuccess: result => { setSilentEmoji(result.silentEmoji); setSilentSaved(true); setSilentError(undefined); refresh(); },
    onError: error => setSilentError(errorText(error))
  });

  const main = info.mainSession;
  const attention = info.counts.needsUser + info.counts.planned + info.pendingDrafts;
  const trimmed = name.trim();
  const normalizedSilent = normalizeSilentEmoji(silentEmoji);
  const silentDirty = normalizedSilent !== undefined && normalizedSilent !== (state.data?.silentEmoji ?? '');

  return <div className="ui-overlay fixed inset-0 z-[60] grid place-items-center bg-zinc-950/30 p-2 sm:p-4" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <div ref={panelRef} role="dialog" aria-modal="true" aria-label="小猫与督办" className="ui-dialog flex max-h-[86dvh] w-full max-w-2xl flex-col overflow-hidden rounded-[14px] border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(24,24,27,.2)]">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-100 px-4">
        <div className="flex items-center gap-2 text-[16px] font-semibold text-zinc-900"><PawPrint size={16}/>小猫与督办</div>
        {attention > 0 && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] leading-none text-amber-700">{attention} 项待你处理</span>}
        <button ref={closeRef} type="button" onClick={onClose} aria-label="关闭" className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"><X size={16}/></button>
      </div>
      <DeferredMount placeholder={<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3"><DeferredSkeleton/></div>}>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {info.adopted && main ? <div className="flex items-center gap-4 border-b border-zinc-100 px-5 py-4">
            <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-zinc-50 ring-1 ring-zinc-200"><Kitten variant="face" size={50} mood={info.mood} collar label={info.name}/></span>
            <div className="min-w-0 flex-1">
              <form className="flex items-center gap-1.5" onSubmit={event => { event.preventDefault(); if (trimmed && trimmed !== info.name) rename.mutate(trimmed); }}>
                <input value={name} maxLength={16} onChange={event => setName(event.target.value)} aria-label="小猫的名字" className="ui-field h-8 w-36 rounded-lg border border-zinc-300 bg-white px-2.5 text-[14px] font-semibold text-zinc-900 outline-none"/>
                <button type="button" onClick={() => setName(current => pickKittenName(current.trim()))} aria-label="随机换一个名字" title="随机换一个名字" className="ui-dice grid h-8 w-8 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"><Dices size={15}/></button>
                {trimmed && trimmed !== info.name && <button type="submit" disabled={rename.isPending} className="h-8 rounded-lg bg-zinc-900 px-3 text-[12px] font-medium text-white hover:bg-zinc-700 disabled:opacity-40">{rename.isPending ? '改名中…' : '改名'}</button>}
              </form>
              <p className="mt-1.5 text-[12px] text-zinc-500">{info.status} · 认领于 {sinceLabel(info.companion?.adoptedAt ?? main.createdAt) || '刚刚'} · {info.counts.open} 张便签还没收尾</p>
              <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-400" title={main.id}>{main.id}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <button type="button" onClick={onOpenMain} className="h-8 rounded-lg bg-zinc-900 px-3 text-[12px] font-medium text-white hover:bg-zinc-700">打开主会话</button>
              <button type="button" disabled={release.isPending} onClick={() => setConfirmRelease(true)} className="h-7 rounded-lg px-2 text-[12px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-40">让它休息</button>
            </div>
          </div> : <div className="flex items-center gap-4 border-b border-zinc-100 px-5 py-4">
            <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl border border-dashed border-zinc-300"><Kitten variant="face" size={46} mood="curious" label="等待认领的小猫"/></span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold text-zinc-900">还没有认领小猫</p>
              <p className="mt-1 text-[12px] leading-5 text-zinc-500">认领后它就是你的主会话：派侧边会话干活、盯进度、验收结果，派出去的事都贴成便签。</p>
              {inviteDismissed && <button type="button" onClick={() => useCompanionStore.getState().dismissInvite(false)} className="mt-1 text-[12px] text-zinc-500 underline underline-offset-2 hover:text-zinc-800">重新在首页和侧栏显示邀请</button>}
            </div>
            <button type="button" onClick={onAdopt} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-zinc-900 px-4 text-[13px] font-medium text-white hover:bg-zinc-700"><PawPrint size={14}/>去认领</button>
          </div>}

          <SettingRow title={<span className="flex items-center gap-1.5"><Clock size={14}/>静默时段</span>} description="开启后，普通通知会压到结束时间再发；紧急通知（notify --urgent）不受影响。默认关闭。">
            <div className="flex flex-col items-end gap-2">
              <label className="flex items-center gap-2 text-[12px] text-zinc-600">
                <input type="checkbox" checked={quiet?.enabled ?? false} onChange={event => setQuiet(value => value ? { ...value, enabled: event.target.checked } : value)} className="h-3.5 w-3.5 accent-zinc-900"/>
                启用
              </label>
              <div className="flex items-center gap-1.5">
                <input type="time" value={quiet?.start ?? '23:00'} disabled={!quiet?.enabled} onChange={event => setQuiet(value => value ? { ...value, start: event.target.value } : value)} aria-label="静默开始时间" className="h-7 rounded-md border border-zinc-200 px-1.5 text-[12px] tabular-nums text-zinc-700 outline-none disabled:bg-zinc-50 disabled:text-zinc-400"/>
                <span className="text-[12px] text-zinc-400">至</span>
                <input type="time" value={quiet?.end ?? '08:00'} disabled={!quiet?.enabled} onChange={event => setQuiet(value => value ? { ...value, end: event.target.value } : value)} aria-label="静默结束时间" className="h-7 rounded-md border border-zinc-200 px-1.5 text-[12px] tabular-nums text-zinc-700 outline-none disabled:bg-zinc-50 disabled:text-zinc-400"/>
                <button type="button" disabled={!quiet || saveQuiet.isPending || !info.adopted} onClick={() => { setSaved(false); if (quiet) saveQuiet.mutate(quiet); }} className="h-7 rounded-md bg-zinc-900 px-2.5 text-[12px] font-medium text-white hover:bg-zinc-800 disabled:opacity-40">保存</button>
              </div>
              {saved && <span className="text-[11px] text-emerald-600">已保存</span>}
            </div>
          </SettingRow>

          <SettingRow title={<span className="flex items-center gap-1.5"><Sparkles size={14}/>静默触发表情</span>} description="在时间线的消息上点这个表情，就在背后开一轮 Agent。不会新增用户气泡，也不会弹通知；只接受一个 emoji，留空关闭。">
            <div className="flex flex-col items-end gap-1.5">
              <div className="flex items-center gap-1.5">
                <input value={silentEmoji} maxLength={16} onChange={event => { setSilentEmoji(event.target.value); setSilentSaved(false); setSilentError(undefined); }} aria-label="静默触发表情" placeholder="例如 🐱" className="h-8 w-20 rounded-lg border border-zinc-300 bg-white px-2 text-center text-[16px] text-zinc-900 outline-none placeholder:text-[12px] placeholder:text-zinc-400"/>
                <button type="button" aria-label="保存静默触发表情" disabled={saveSilent.isPending || !silentDirty} onClick={() => { if (normalizedSilent !== undefined) saveSilent.mutate(normalizedSilent); }} className="h-8 rounded-md bg-zinc-900 px-2.5 text-[12px] font-medium text-white hover:bg-zinc-800 disabled:opacity-40">{saveSilent.isPending ? '保存中…' : '保存'}</button>
              </div>
              {silentEmoji.trim() && normalizedSilent === undefined && <span className="text-[11px] text-red-600">只支持单个 emoji</span>}
              {silentSaved && normalizedSilent !== undefined && !silentDirty && <span className="text-[11px] text-emerald-600">已保存</span>}
              {silentError && <span className="max-w-56 text-right text-[11px] text-red-600">{silentError}</span>}
            </div>
          </SettingRow>

          <div className="px-4 py-3 text-[12px] leading-5 text-zinc-400">
            小猫派活、验收和 watch 用 CLI 完成：<code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-600">agent-dock task|watch|notify -h</code>。侧边会话只能 <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-600">task report</code> 和 <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-600">draft create</code>。命令行认领：<code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-600">agent-dock main set --agent claude --name 小A同学</code>。
          </div>
          {error && <div className="mx-4 mb-3 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] text-red-700">{error}</div>}
        </div>
      </DeferredMount>
    </div>
    <ConfirmDialog open={confirmRelease} tone="warning" title={`让${info.name}休息？`} description="解除后它不再是主会话：不会再收到督办信号，也不能派活和验收。会话本身和已有的便签都会保留，之后可以在首页重新认领一只。" confirmLabel="让它休息" busy={release.isPending} onCancel={() => { if (!release.isPending) setConfirmRelease(false); }} onConfirm={() => release.mutate()}/>
  </div>;
}
