import { Spinner } from './Loaders';
import { useMemo, useRef, useState } from 'react';
import { useLocalStorageState } from 'ahooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, ExternalLink, RotateCcw, Search, Users, X } from 'lucide-react';
import { Input } from 'antd';
import { cleanChatName } from '@agent-dock/agent-dock-shared';
import { api, type Agent, type HandoverBotProfile, type LarkTurnSyncConfig, type Session, type SessionLarkBinding } from './api';
import { useModalFocusTrap } from './useModalFocusTrap';
import { DeferredMount, DeferredSkeleton } from './DeferredMount';
import { parseLarkSourceId } from './lark-session-link';
import { defaultHandoverPicked, filterHandoverCandidates, toggleHandoverPicked } from './handover-members';
import { DEFAULT_LARK_TURN_SYNC, normalizeLarkTurnSyncForm } from './lark-config-form';
import { LarkTurnSyncControls } from './LarkTurnSyncControls';

/** 为内置小猫头像追加版本号参数，避免旧版 immutable 强缓存继续展示旧线条猫。 */
export function handoverKittenAvatarSrc(avatarUrl: string): string {
  if (avatarUrl === '/api/lark/kitten-avatar.png') return `${avatarUrl}?v=2`;
  return avatarUrl;
}

const BINDING_META = {
  handover: {
    dialogTitle: '托管群同步设置',
    dialogSubtitle: '控制哪些非飞书轮次同步进该托管群',
    kindLabel: '托管群',
    kindBadgeClass: 'border-emerald-200 bg-white text-emerald-700',
    openLabel: '打开群聊',
    overrideLabel: '当前托管群已使用独立同步配置',
    savedLabel: '已保存该托管群的轮次同步策略，后续轮次立即生效。'
  },
  'lark-group': {
    dialogTitle: '飞书群同步设置',
    dialogSubtitle: '控制哪些非飞书轮次同步回该飞书群',
    kindLabel: '飞书群聊',
    kindBadgeClass: 'border-blue-200 bg-white text-blue-700',
    openLabel: '打开群聊',
    overrideLabel: '当前飞书群会话已使用独立同步配置',
    savedLabel: '已保存该飞书群会话的轮次同步策略，后续轮次立即生效。'
  },
  'lark-p2p': {
    dialogTitle: '飞书私聊同步设置',
    dialogSubtitle: '控制哪些非飞书轮次同步回该飞书私聊',
    kindLabel: '飞书私聊',
    kindBadgeClass: 'border-sky-200 bg-white text-sky-700',
    openLabel: '打开私聊',
    overrideLabel: '当前飞书私聊会话已使用独立同步配置',
    savedLabel: '已保存该飞书私聊会话的轮次同步策略，后续轮次立即生效。'
  }
} as const;

/**
 * 「托管给机器人 / 飞书同步设置」：
 * - 未绑定的普通会话 / 主会话：建飞书群并绑定，同时可细粒度勾选非飞书轮次同步策略；
 * - 已绑定飞书会话（普通托管群、主会话托管群、普通飞书群聊、普通飞书私聊）：查看绑定入口并按需调整同步开关（支持恢复继承机器人默认）。
 */
export function HandoverDialog({ session, agent, onClose }: { session: Session; agent?: Agent; onClose(): void }) {
  const qc = useQueryClient();
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap({ panel: panelRef, initial: panelRef, dismissible: true, onDismiss: onClose });
  const config = useQuery({ queryKey: ['lark-config'], queryFn: api.larkConfig });
  const bots = config.data?.bots ?? [];
  // 读取会话的飞书绑定（含普通托管群、主小猫托管群、原生飞书群聊、飞书私聊）与生效同步策略。
  const handoverQuery = useQuery({ queryKey: ['session-handover', session.id], queryFn: () => api.sessionHandover(session.id), staleTime: 30_000 });
  const existingHandover = handoverQuery.data?.handover ?? undefined;
  const activeBinding: SessionLarkBinding | undefined = handoverQuery.data?.larkBinding
    ?? (existingHandover
      ? {
          kind: 'handover',
          appId: existingHandover.appId,
          botName: existingHandover.botName,
          chatId: existingHandover.chatId,
          chatType: 'group',
          name: existingHandover.name,
          url: existingHandover.url,
          ...(existingHandover.turnSync ? { turnSync: existingHandover.turnSync } : {}),
          effectiveTurnSync: normalizeLarkTurnSyncForm(existingHandover.effectiveTurnSync)
        }
      : undefined);
  const kitten = handoverQuery.data?.kitten ?? undefined;
  const [appId, setAppId] = useState('');
  // 默认群名来自会话标题，必须先清洗：附件首发的会话标题就是一条本地路径，直接拿去建群
  // 会出现一个叫 `/Users/xxx/a.png` 的飞书群。主会话则用当前小猫的名字。
  const [name, setName] = useState<string>();
  const defaultName = kitten ? `${kitten.name} · AgentDock` : `${cleanChatName(session.title) || agent?.name || session.agentId} · AgentDock`;
  const nameValue = name ?? defaultName;
  const [manual, setManual] = useState('');
  const [keyword, setKeyword] = useState('');
  const [created, setCreated] = useState<{ chatId: string; name: string; url: string; botProfile?: HandoverBotProfile | null }>();
  const [selfOpenId, setSelfOpenId] = useLocalStorageState<string>('agentdock:handover-self-openid', { defaultValue: '' });
  const [picked, setPicked] = useState<string[] | null>(null);
  const [searched, setSearched] = useState<{ openId: string; name: string }[]>([]);
  const [turnSyncDraft, setTurnSyncDraft] = useState<LarkTurnSyncConfig | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  const effectiveAppId = bots.some(bot => bot.appId === appId) ? appId : bots[0]?.appId ?? '';
  const bot = bots.find(item => item.appId === (activeBinding?.appId ?? effectiveAppId));
  const originChatId = parseLarkSourceId(session.sourceId)?.chatId;

  const baseTurnSync = useMemo(() => {
    if (activeBinding?.effectiveTurnSync) return normalizeLarkTurnSyncForm(activeBinding.effectiveTurnSync);
    if (bot?.turnSync) return normalizeLarkTurnSyncForm(bot.turnSync);
    return DEFAULT_LARK_TURN_SYNC;
  }, [activeBinding?.effectiveTurnSync, bot?.turnSync]);
  const effectiveTurnSync = turnSyncDraft ?? baseTurnSync;
  const isLarkNativeSession = session.source === 'lark';
  const isManageMode = Boolean(activeBinding && !created);
  const bindingMeta = activeBinding ? BINDING_META[activeBinding.kind] : undefined;
  const dialogTitle = bindingMeta?.dialogTitle ?? (isLarkNativeSession ? '飞书同步设置' : '托管给机器人');
  const dialogSubtitle = bindingMeta?.dialogSubtitle ?? (isLarkNativeSession ? '控制哪些非飞书轮次同步回原飞书会话' : '建一个飞书群，用群聊继续这个会话');
  const waitingNativeBinding = isLarkNativeSession && !activeBinding && handoverQuery.isLoading;

  // 机器人创建者：默认邀请人（机器人 + 创建者自己），无需用户去找 open_id。
  const owner = useQuery({
    queryKey: ['lark-app-owner', effectiveAppId],
    queryFn: () => api.larkAppOwner(effectiveAppId),
    enabled: Boolean(!isManageMode && !isLarkNativeSession && effectiveAppId),
    staleTime: 5 * 60_000
  });

  // 候选 = 机器人创建者 + 白名单 + 会话原群成员 + 手动搜索结果。
  const members = useQuery({
    queryKey: ['lark-chat-members', effectiveAppId, originChatId],
    queryFn: () => api.larkChatMembers(effectiveAppId, originChatId!),
    enabled: Boolean(!isManageMode && !isLarkNativeSession && effectiveAppId && originChatId),
    staleTime: 60_000
  });
  const candidates = useMemo(() => {
    const map = new Map<string, string>();
    if (owner.data?.owner) map.set(owner.data.owner.openId, owner.data.owner.name);
    for (const user of bot?.allowedUsers ?? []) if (!map.has(user.openId)) map.set(user.openId, user.name);
    for (const user of members.data?.users ?? []) if (!map.has(user.openId)) map.set(user.openId, user.name);
    for (const user of searched) if (!map.has(user.openId)) map.set(user.openId, user.name);
    return [...map].map(([openId, userName]) => ({ openId, name: userName }));
  }, [bot, members.data, searched, owner.data]);

  // 按姓名全量搜人：建新群时不该要求用户知道 open_id。ONLY on explicit submit（扫群很贵，不能边打边搜）。
  const search = useMutation({
    mutationFn: (q: string) => api.larkMemberSearch(effectiveAppId, q),
    onSuccess: result => {
      if (result.users.length) {
        setSearched(current => {
          const map = new Map(current.map(user => [user.openId, user]));
          for (const user of result.users) map.set(user.openId, user);
          return [...map.values()];
        });
        setPicked(current => current ?? [result.users[0]!.openId]);
      }
    }
  });

  // 头像：对当前候选批量取（含创建者）。拿不到就退回首字母兜底，不阻塞选择。
  const candidateIds = candidates.map(user => user.openId).sort();
  const profiles = useQuery({
    queryKey: ['lark-user-profiles', effectiveAppId, candidateIds.join(',')],
    queryFn: () => api.larkUserProfiles(effectiveAppId, candidateIds),
    enabled: Boolean(!isManageMode && !isLarkNativeSession && effectiveAppId && candidateIds.length),
    staleTime: 5 * 60_000
  });
  const avatarFor = (openId: string) =>
    profiles.data?.users.find(user => user.openId === openId)?.avatarUrl
    ?? (owner.data?.owner?.openId === openId ? owner.data.owner.avatarUrl : undefined);

  // null 表示还没手动改过：此刻才按上次选择/创建者给一个默认值；用户一旦清空就是 []，不再回补。
  const effectivePicked = picked ?? defaultHandoverPicked(candidates, owner.data?.owner?.openId, selfOpenId);
  const toggle = (openId: string) => setPicked(toggleHandoverPicked(effectivePicked, openId));
  const filtered = useMemo(() => filterHandoverCandidates(candidates, keyword, effectivePicked), [candidates, keyword, effectivePicked]);
  const manualOpenId = manual.trim();
  const manualValid = manualOpenId === '' || manualOpenId.startsWith('ou_');
  const memberOpenIds = [...new Set([...effectivePicked, ...(manualValid && manualOpenId ? [manualOpenId] : [])])];

  const handover = useMutation({
    mutationFn: () => api.handoverSession(session.id, {
      appId: effectiveAppId,
      name: nameValue,
      memberOpenIds,
      turnSync: effectiveTurnSync
    }),
    onSuccess: result => {
      if (effectivePicked[0]) setSelfOpenId(effectivePicked[0]);
      setCreated(result);
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      void qc.invalidateQueries({ queryKey: ['session-handover', session.id] });
    }
  });

  const updateSync = useMutation({
    mutationFn: (next: LarkTurnSyncConfig | null) => api.updateSessionHandover(session.id, { turnSync: next }),
    onSuccess: data => {
      qc.setQueryData(['session-handover', session.id], data);
      setTurnSyncDraft(null);
      setSavedNotice(true);
    }
  });

  const activeError = handover.error ?? updateSync.error;

  return <div className="ui-overlay fixed inset-0 z-[60] grid place-items-center bg-zinc-950/30 p-3" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <div ref={panelRef} role="dialog" aria-modal="true" aria-label={dialogTitle} className="ui-dialog flex max-h-[calc(100dvh-1.5rem)] w-full max-w-lg flex-col overflow-hidden rounded-[14px] border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(24,24,27,.2)]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-100 px-4">
        <Bot size={16} className="shrink-0 text-zinc-500"/>
        <span className="truncate text-[16px] font-semibold">{dialogTitle}</span>
        <span className="hidden truncate text-[12px] text-zinc-400 sm:inline">
          {dialogSubtitle}
        </span>
        <button type="button" onClick={onClose} aria-label="关闭" className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"><X size={16}/></button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <DeferredMount placeholder={<DeferredSkeleton/>}>
        {kitten && <div data-testid="handover-kitten" className="mb-3 flex items-center gap-2.5 rounded-lg border border-amber-100 bg-amber-50/60 px-2.5 py-2">
          <img src={handoverKittenAvatarSrc(kitten.avatarUrl)} alt={`${kitten.name}的头像`} className="ui-pixelated h-9 w-9 shrink-0 rounded-full object-cover"/>
          <div className="min-w-0 text-[12px] leading-4">
            <div className="font-medium text-zinc-800">当前小猫：{kitten.name} · 第 {kitten.generation} 代</div>
            <div className="text-zinc-500">
              {isManageMode
                ? '主会话的系统督办、网页对话与定时任务将按下方策略实时同步至绑定飞书群。'
                : '建群后会尝试把飞书机器人名称和头像同步成这只小猫；不支持时会提示你手动处理。'}
            </div>
          </div>
        </div>}

        {waitingNativeBinding ? (
          <div className="flex items-center gap-2 py-6 text-[12px] text-zinc-400"><Spinner size={13}/>正在读取飞书会话绑定信息…</div>
        ) : isManageMode && activeBinding && bindingMeta ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 px-3 py-2.5 text-[12px]">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium text-emerald-900">{activeBinding.name}</span>
                  <span className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10.5px] font-medium leading-none ${bindingMeta.kindBadgeClass}`}>
                    {bindingMeta.kindLabel}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-emerald-700">绑定机器人：{activeBinding.botName}</div>
              </div>
              {activeBinding.url && (
                <a href={activeBinding.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 rounded-md border border-emerald-200 bg-white px-2.5 py-1 text-[12px] font-medium text-emerald-700 hover:bg-emerald-50">
                  <ExternalLink size={12}/>{bindingMeta.openLabel}
                </a>
              )}
            </div>

            <LarkTurnSyncControls
              value={effectiveTurnSync}
              onChange={next => { setTurnSyncDraft(next); setSavedNotice(false); }}
              variant="compact"
              targetKind={activeBinding.kind}
              disabled={updateSync.isPending || Boolean(session.archivedAt)}
            />

            {activeBinding.turnSync && !session.archivedAt && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-zinc-50/70 px-3 py-2 text-[12px] text-zinc-500">
                <span>{bindingMeta.overrideLabel}</span>
                <button
                  type="button"
                  disabled={updateSync.isPending}
                  onClick={() => updateSync.mutate(null)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-zinc-700 hover:bg-zinc-200/70 disabled:opacity-40"
                >
                  <RotateCcw size={12}/>恢复跟随机器人默认
                </button>
              </div>
            )}

            {savedNotice && (
              <div role="status" className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
                <Check size={13}/>{bindingMeta.savedLabel}
              </div>
            )}
          </div>
        ) : isLarkNativeSession ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px] leading-5 text-amber-800">
            未解析到当前飞书会话的绑定信息，请确认所属机器人已在「飞书设置」中配置。
          </div>
        ) : <>
          {config.isLoading && <div className="flex items-center gap-2 text-[12px] text-zinc-400"><Spinner size={13}/>正在读取机器人配置…</div>}
          {!config.isLoading && !bots.length && <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-5 text-amber-800">还没有配置任何飞书机器人。先到「飞书设置」添加一个，再回来托管。</div>}

          {bots.length > 0 && <>
            <label className="block text-[12px] font-medium text-zinc-700">用哪个机器人</label>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {bots.map(item => <button key={item.appId} type="button" onClick={() => { setAppId(item.appId); setPicked(null); setKeyword(''); setTurnSyncDraft(null); }} className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition-colors ${item.appId === effectiveAppId ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300'}`}>{item.name || item.appId}</button>)}
            </div>

            <label className="mt-4 block text-[12px] font-medium text-zinc-700">群名称</label>
            <Input size="large" value={nameValue} onChange={event => setName(event.target.value)} className="mt-1.5 text-[13px]"/>

            <div className="mt-4 flex items-center gap-1.5 text-[12px] font-medium text-zinc-700"><Users size={12}/>邀请成员<span className="font-normal text-zinc-400">（点成员胶囊勾选，可全部取消）</span></div>
            <div className="mt-1.5 flex items-center gap-1.5">
              <Input className="min-w-0 flex-1" value={keyword} onChange={event => setKeyword(event.target.value)} onPressEnter={event => { if (keyword.trim()) { event.preventDefault(); search.mutate(keyword.trim()); } }} placeholder="输入姓名后回车搜索（机器人可见范围）" prefix={<Search size={13} className="text-zinc-400"/>} suffix={(members.isFetching || search.isPending) ? <Spinner size={12} className="text-zinc-400"/> : <span/>}/>
              <button type="button" disabled={!effectiveAppId || !keyword.trim() || search.isPending} onClick={() => search.mutate(keyword.trim())} className="h-8 shrink-0 rounded-md border border-zinc-200 px-2.5 text-[12px] text-zinc-600 hover:bg-zinc-50 disabled:opacity-40">搜索</button>
            </div>
            {(search.data?.error || search.error) && <p className="mt-1.5 text-[12px] text-amber-700">{search.data?.error ?? (search.error instanceof Error ? search.error.message : '搜索失败')}</p>}
            <div className="mt-2.5 rounded-lg border border-zinc-100 bg-zinc-50/60 p-2.5">
              <div className="mb-2 flex items-center gap-1.5 text-[12px] text-zinc-400"><Users size={11}/>已选 {effectivePicked.length} 人{effectivePicked.length === 0 && <span className="text-zinc-400">· 仅机器人和自己可在群内，其他人可稍后邀请</span>}</div>
              <div className="max-h-40 overflow-y-auto">
                {filtered.length > 0 ? <div className="flex flex-wrap gap-1.5">{filtered.map(user => {
                  const selected = effectivePicked.includes(user.openId);
                  const avatar = avatarFor(user.openId);
                  return <button key={user.openId} type="button" aria-pressed={selected} onClick={() => toggle(user.openId)} className={`flex h-8 items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-[12px] transition-colors ${selected ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300'}`}>{avatar ? <img src={avatar} alt="" className="h-6 w-6 rounded-full object-cover"/> : <span className="grid h-6 w-6 place-items-center rounded-full bg-zinc-100 text-[12px] text-zinc-500">{(user.name || '?').slice(0, 1)}</span>}{user.name}{selected && <span aria-hidden="true" className="ml-0.5 text-[10px] font-semibold">✓</span>}</button>;
                })}</div> : <p className="text-[12px] text-zinc-400">{members.isError && originChatId ? '读取原群成员失败（机器人可能不在该群）；用上面的搜索按姓名找人，或在下面填 open_id。' : '没有匹配的成员：换个名字搜索，或在下面填 open_id。'}</p>}
              </div>
            </div>
            <Input value={manual} status={manualValid ? undefined : 'error'} onChange={event => setManual(event.target.value)} placeholder="补充一个 open_id（ou_ 开头，可选）" className="mt-2 font-mono text-[12px]"/>
            {!manualValid && <p className="mt-1 text-[12px] text-red-600">open_id 必须以 ou_ 开头。</p>}

            <div className="mt-4">
              <div className="mb-1.5 text-[12px] font-medium text-zinc-700">全轮次同步策略</div>
              <LarkTurnSyncControls
                value={effectiveTurnSync}
                onChange={setTurnSyncDraft}
                variant="compact"
                targetKind="handover"
                disabled={handover.isPending}
              />
            </div>

            <p className="mt-3 text-[12px] leading-4 text-zinc-400">建群后，这个群的消息会直接进入当前会话；现有 Agent、模型、历史都保持不变。群里需要 @ 机器人来唤醒。机器人白名单内的群成员都能以完全信任权限驱动这个会话，请只拉信任的人。</p>
          </>}
        </>}

        {activeError && <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700">{activeError instanceof Error ? activeError.message : String(activeError)}</p>}
        {created && <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-[12px] leading-5 text-emerald-800">
          已建群并绑定：<span className="font-medium">{created.name}</span>
          <a href={created.url} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-1 font-medium text-emerald-700 underline"><ExternalLink size={11}/>打开群聊</a>
          {created.botProfile && <p className={`mt-1.5 border-t pt-1.5 ${created.botProfile.ok ? 'border-emerald-200 text-emerald-700' : 'border-amber-200 text-amber-800'}`}>{created.botProfile.message}</p>}
        </div>}
        </DeferredMount>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-zinc-100 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button type="button" onClick={onClose} className="rounded-lg border border-zinc-300 px-3.5 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50">{created ? '完成' : '关闭'}</button>
        {isManageMode ? (
          !session.archivedAt && <button type="button" disabled={updateSync.isPending} onClick={() => updateSync.mutate(effectiveTurnSync)} className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400">
            {updateSync.isPending && <Spinner size={12}/>}保存同步设置
          </button>
        ) : (
          !isLarkNativeSession && !created && <button type="button" disabled={!effectiveAppId || !nameValue.trim() || !manualValid || handover.isPending} onClick={() => handover.mutate()} className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400">{handover.isPending && <Spinner size={12}/>}建群并托管</button>
        )}
      </div>
    </div>
  </div>;
}
