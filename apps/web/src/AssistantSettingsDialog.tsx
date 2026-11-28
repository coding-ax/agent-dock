import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dices, PawPrint, X } from 'lucide-react';
import { api } from './api';
import { useModalFocusTrap } from './useModalFocusTrap';
import { DeferredMount, DeferredSkeleton } from './DeferredMount';
import { ConfirmDialog } from './ui-controls';
import { HoverTooltip } from './HoverTooltip';
import { Kitten } from './companion/Kitten';
import { CatProfile } from './companion/CatProfile';
import { pickKittenName, sinceLabel } from './companion/companion-model';
import { useCompanion } from './companion/useCompanion';
import { useCompanionStore } from './companion/companion-store';
import { bi, useBi } from './i18n';

const errorText = (error: unknown) => error instanceof Error ? error.message : bi("操作失败", "Action failed");

/**
 * 小猫与督办设置。小猫就是主会话：唯一能派活、验收、配置 watch 的会话。
 * 认领在首页完成（这里没认领时只给一个「去认领」）；认领后可以改名、打开、让它休息（解除主会话）。
 */
export function AssistantSettingsDialog({ onClose, onOpenMain, onAdopt, onOpenSession, embedded = false }: { onClose(): void; onOpenMain(): void; onAdopt(): void; onOpenSession?(id: string): void; embedded?: boolean }) {
  const L = useBi();
  const queryClient = useQueryClient();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useModalFocusTrap({ panel: panelRef, initial: closeRef, dismissible: true, onDismiss: onClose, enabled: !embedded });
  const info = useCompanion();
  const inviteDismissed = useCompanionStore(store => store.inviteDismissed);
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [confirmRelease, setConfirmRelease] = useState(false);

  useEffect(() => { if (info.adopted) setName(info.name); }, [info.adopted, info.name]);

  const refresh = () => {
    setError(undefined);
    void queryClient.invalidateQueries({ queryKey: ['assistant-state'] });
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
  };
  const fail = (value: unknown) => setError(errorText(value));

  const rename = useMutation({ mutationFn: (value: string) => api.assistantRenameCompanion(value), onSuccess: () => { refresh(); useCompanionStore.getState().celebrate(); }, onError: fail });
  const release = useMutation({ mutationFn: () => api.assistantClearMain(), onSuccess: () => { setConfirmRelease(false); refresh(); }, onError: error => { setConfirmRelease(false); fail(error); } });

  const main = info.mainSession;
  const attention = info.counts.needsUser + info.counts.planned + info.pendingDrafts;
  const trimmed = name.trim();

  const body = (
    <div className="min-h-0 flex-1 overflow-y-auto pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {info.adopted && main ? <div className="flex flex-col gap-3 border-b border-zinc-100 px-4 py-4 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-3.5 sm:gap-4">
          <HoverTooltip content={`${info.moodMeta.label} · ${info.moodMeta.hint}`} hoverOnly>
            <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-zinc-50 ring-1 ring-zinc-200"><Kitten variant="face" size={50} mood={info.mood} stage={info.stage} collar label={`${info.name}：${info.moodMeta.label}`}/></span>
          </HoverTooltip>
          <div className="min-w-0 flex-1">
            <form className="flex items-center gap-1.5" onSubmit={event => { event.preventDefault(); if (trimmed && trimmed !== info.name) rename.mutate(trimmed); }}>
              <input value={name} maxLength={16} onChange={event => setName(event.target.value)} aria-label={L("小猫的名字", "Companion name")} className="ui-field h-8 min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-2.5 text-[14px] font-semibold text-zinc-900 outline-none sm:w-36 sm:flex-none"/>
              <HoverTooltip content={L("随机换一个名字", "Randomize name")}>
                <button type="button" onClick={() => setName(current => pickKittenName(current.trim()))} aria-label={L("随机换一个名字", "Randomize name")} className="ui-dice grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"><Dices size={15}/></button>
              </HoverTooltip>
              {trimmed && trimmed !== info.name && <button type="submit" disabled={rename.isPending} className="h-8 shrink-0 rounded-lg bg-zinc-900 px-3 text-[12px] font-medium text-white hover:bg-zinc-700 disabled:opacity-40">{rename.isPending ? L("改名中…", "Renaming…") : L("改名", "Rename")}</button>}
            </form>
            <p className="mt-1.5 text-[12px] text-zinc-500">{info.status}  {L("· 认领于", "· Adopted ")} {sinceLabel(info.companion?.adoptedAt ?? main.createdAt) || L("刚刚", "just now")} · {info.counts.open}  {L("张便签还没收尾", " open note(s)")}</p>
            <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-400" title={main.id}>{main.id}</p>
          </div>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:flex-col sm:items-end sm:gap-1.5">
          <button type="button" onClick={onOpenMain} className="h-8 flex-1 rounded-lg bg-zinc-900 px-3 text-[12px] font-medium text-white hover:bg-zinc-700 sm:flex-none">{L("打开主会话", "Open Main Session")}</button>
          <button type="button" disabled={release.isPending} onClick={() => setConfirmRelease(true)} className="h-8 rounded-lg px-2.5 text-[12px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-40 sm:h-7 sm:px-2">{L("让它休息", "Put to Rest")}</button>
        </div>
      </div> : <div className="flex flex-col gap-3 border-b border-zinc-100 px-4 py-4 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-3.5 sm:gap-4">
          <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl border border-dashed border-zinc-300"><Kitten variant="face" size={46} mood="curious" label={L("等待认领的小猫", "Companion awaiting adoption")}/></span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-zinc-900">{L("还没有认领小猫", "No Companion Adopted")}</p>
            <p className="mt-1 text-[12px] leading-5 text-zinc-500">{L("认领后它就是你的主会话：派侧边会话干活、盯进度、验收结果，派出去的事都贴成便签。", "Once adopted, it becomes your main session to delegate, supervise, and review side-session tasks as sticky notes.")}</p>
            {inviteDismissed && <button type="button" onClick={() => useCompanionStore.getState().dismissInvite(false)} className="mt-1 text-[12px] text-zinc-500 underline underline-offset-2 hover:text-zinc-800">{L("重新在首页和侧栏显示邀请", "Show adoption banner again")}</button>}
          </div>
        </div>
        <button type="button" onClick={onAdopt} className="inline-flex h-9 w-full shrink-0 items-center justify-center gap-1.5 rounded-full bg-zinc-900 px-4 text-[13px] font-medium text-white hover:bg-zinc-700 sm:w-auto"><PawPrint size={14}/>{L("去认领", "Adopt")}</button>
      </div>}

      {info.adopted && main && <CatProfile
        onOpenSession={id => onOpenSession?.(id)}
        onOpenCeremony={handoffId => { onClose(); useCompanionStore.getState().openCeremony(handoffId); }}
      />}

      <div className="px-4 py-3 text-[12px] leading-5 text-zinc-400 sm:px-5">
        
        {L("小猫派活、验收和 watch 用 CLI 完成：", "Delegation, reviews, and watches run via CLI: ")}<code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-600">agent-dock task|watch|notify -h</code>{L("。侧边会话只能", ". Side sessions can only run ")}<code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-600">task report</code>{L(" 和 ", " and ")}<code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-600">draft create</code>{L("。命令行认领：", ". Adopt via CLI: ")}<code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-600">{L("agent-dock main set --agent claude --name 小A同学", "agent-dock main set --agent claude --name Mochi")}</code>{L("。", ".")}
      </div>
      {error && <div className="mx-4 mb-3 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] text-red-700 sm:mx-5">{error}</div>}
    </div>
  );

  const confirmDialog = <ConfirmDialog open={confirmRelease} tone="warning" title={L(`让${info.name}休息？`, `Put ${info.name} to rest?`)} description={L("解除后它不再是主会话：不会再收到督办信号，也不能派活和验收。会话本身和已有的便签都会保留，之后可以在首页重新认领一只。", "Releasing removes its main-session role without deleting the session or existing sticky notes. You can adopt again anytime.")} confirmLabel={L("让它休息", "Put to Rest")} busy={release.isPending} onCancel={() => { if (!release.isPending) setConfirmRelease(false); }} onConfirm={() => release.mutate()}/>;

  if (embedded) {
    return <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {attention > 0 && <div className="flex shrink-0 items-center gap-2 border-b border-zinc-100 px-4 py-2 sm:px-5">
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium leading-none text-amber-700">{attention}  {L("项待你处理", " need attention")}</span>
      </div>}
      <DeferredMount placeholder={<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3"><DeferredSkeleton/></div>}>
        {body}
      </DeferredMount>
      {confirmDialog}
    </div>;
  }

  return <div className="ui-overlay ui-overlay-sheet fixed inset-0 z-[60] grid place-items-center bg-zinc-950/30 p-0 sm:p-4" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <div ref={panelRef} role="dialog" aria-modal="true" aria-label={L("小猫与督办", "Companion & Supervision")} className="ui-dialog flex h-[100dvh] max-h-[100dvh] w-full max-w-2xl flex-col overflow-hidden rounded-none border-0 bg-white shadow-[0_24px_80px_rgba(24,24,27,.2)] sm:h-auto sm:max-h-[86dvh] sm:rounded-[14px] sm:border sm:border-zinc-200">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-100 px-4">
        <div className="flex items-center gap-2 text-[16px] font-semibold text-zinc-900"><PawPrint size={16}/>{L("小猫与督办", "Companion & Supervision")}</div>
        {attention > 0 && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] leading-none text-amber-700">{attention}  {L("项待你处理", " need attention")}</span>}
        <button ref={closeRef} type="button" onClick={onClose} aria-label={L("关闭", "Close")} className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"><X size={16}/></button>
      </div>
      <DeferredMount placeholder={<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3"><DeferredSkeleton/></div>}>
        {body}
      </DeferredMount>
    </div>
    {confirmDialog}
  </div>;
}
