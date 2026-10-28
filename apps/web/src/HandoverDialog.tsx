import { useMemo, useRef, useState } from 'react';
import { useLocalStorageState } from 'ahooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, ExternalLink, LoaderCircle, Search, Users, X } from 'lucide-react';
import { Input } from 'antd';
import { cleanChatName } from '@agent-dock/agent-dock-shared';
import { api, type Agent, type Session } from './api';
import { useModalFocusTrap } from './useModalFocusTrap';
import { parseLarkSourceId } from './lark-session-link';

/**
 * 「托管给机器人」：给已存在的会话建飞书群并绑定，之后用群聊继续这个会话。
 *
 * 选人不要求用户知道自己的 open_id：优先列出「这个会话原本所在飞书群」的成员（带姓名），
 * 搜名字勾选即可；机器人白名单里的人也会一并出现。上次选过的人会用 localStorage 记住并默认勾上。
 */
export function HandoverDialog({ session, agent, onClose }: { session: Session; agent?: Agent; onClose(): void }) {
  const qc = useQueryClient();
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap({ panel: panelRef, initial: panelRef, dismissible: true, onDismiss: onClose });
  const config = useQuery({ queryKey: ['lark-config'], queryFn: api.larkConfig });
  const bots = config.data?.bots ?? [];
  const [appId, setAppId] = useState('');
  // 默认群名来自会话标题，必须先清洗：附件首发的会话标题就是一条本地路径，直接拿去建群
  // 会出现一个叫 `/Users/xxx/a.png` 的飞书群。洗空了再退回 Agent 名。
  const [name, setName] = useState(`${cleanChatName(session.title) || agent?.name || session.agentId} · AgentDock`);
  const [manual, setManual] = useState('');
  const [keyword, setKeyword] = useState('');
  const [created, setCreated] = useState<{ chatId: string; name: string; url: string }>();
  const [selfOpenId, setSelfOpenId] = useLocalStorageState<string>('agentdock:handover-self-openid', { defaultValue: '' });
  const [picked, setPicked] = useState<string[]>([]);
  const [searched, setSearched] = useState<{ openId: string; name: string }[]>([]);

  const effectiveAppId = bots.some(bot => bot.appId === appId) ? appId : bots[0]?.appId ?? '';
  const bot = bots.find(item => item.appId === effectiveAppId);
  const originChatId = parseLarkSourceId(session.sourceId)?.chatId;

  // 机器人创建者：默认邀请人（机器人 + 创建者自己），无需用户去找 open_id。
  const owner = useQuery({
    queryKey: ['lark-app-owner', effectiveAppId],
    queryFn: () => api.larkAppOwner(effectiveAppId),
    enabled: Boolean(effectiveAppId),
    staleTime: 5 * 60_000
  });

  // 候选 = 机器人创建者 + 白名单 + 会话原群成员 + 手动搜索结果。
  const members = useQuery({
    queryKey: ['lark-chat-members', effectiveAppId, originChatId],
    queryFn: () => api.larkChatMembers(effectiveAppId, originChatId!),
    enabled: Boolean(effectiveAppId && originChatId),
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
        setPicked(current => current.length ? current : [result.users[0]!.openId]);
      }
    }
  });
  const filtered = candidates.filter(user => !keyword.trim() || user.name.toLowerCase().includes(keyword.trim().toLowerCase()));

  // 头像：对当前候选批量取（含创建者）。拿不到就退回首字母兜底，不阻塞选择。
  const candidateIds = candidates.map(user => user.openId).sort();
  const profiles = useQuery({
    queryKey: ['lark-user-profiles', effectiveAppId, candidateIds.join(',')],
    queryFn: () => api.larkUserProfiles(effectiveAppId, candidateIds),
    enabled: Boolean(effectiveAppId && candidateIds.length),
    staleTime: 5 * 60_000
  });
  const avatarFor = (openId: string) =>
    profiles.data?.users.find(user => user.openId === openId)?.avatarUrl
    ?? (owner.data?.owner?.openId === openId ? owner.data.owner.avatarUrl : undefined);

  // 默认勾人：优先「上次选过的自己」，否则机器人创建者，最后才退到第一个候选。
  const effectivePicked = useMemo(() => {
    if (picked.length) return picked;
    if (selfOpenId && candidates.some(user => user.openId === selfOpenId)) return [selfOpenId];
    const ownerId = owner.data?.owner?.openId;
    if (ownerId && candidates.some(user => user.openId === ownerId)) return [ownerId];
    return candidates.length ? [candidates[0]!.openId] : [];
  }, [picked, selfOpenId, candidates, owner.data]);
  const toggle = (openId: string) => {
    const current = effectivePicked;
    setPicked(current.includes(openId) ? current.filter(id => id !== openId) : [...current, openId]);
  };

  const handover = useMutation({
    mutationFn: () => api.handoverSession(session.id, {
      appId: effectiveAppId,
      name,
      memberOpenIds: [...new Set([...effectivePicked, ...(manual.trim().startsWith('ou_') ? [manual.trim()] : [])])]
    }),
    onSuccess: result => {
      if (effectivePicked[0]) setSelfOpenId(effectivePicked[0]);
      setCreated(result);
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      void qc.invalidateQueries({ queryKey: ['session-handover', session.id] });
    }
  });

  return <div className="ui-overlay fixed inset-0 z-[60] grid place-items-center bg-zinc-950/30 p-3 backdrop-blur-[2px]" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <div ref={panelRef} role="dialog" aria-modal="true" aria-label="托管给机器人" className="ui-dialog flex max-h-[calc(100dvh-1.5rem)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(24,24,27,.2)]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-100 px-4">
        <Bot size={16} className="text-zinc-500"/>
        <span className="text-[14px] font-semibold">托管给机器人</span>
        <span className="hidden truncate text-[11px] text-zinc-400 sm:inline">建一个飞书群，用群聊继续这个会话</span>
        <button type="button" onClick={onClose} aria-label="关闭" className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"><X size={16}/></button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {config.isLoading && <div className="flex items-center gap-2 text-[12px] text-zinc-400"><LoaderCircle size={13} className="animate-spin"/>正在读取机器人配置…</div>}
        {!config.isLoading && !bots.length && <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">还没有配置任何飞书机器人。先到「飞书设置」添加一个，再回来托管。</div>}

        {bots.length > 0 && <>
          <label className="block text-[11px] font-medium text-zinc-700">用哪个机器人</label>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {bots.map(item => <button key={item.appId} type="button" onClick={() => { setAppId(item.appId); setPicked([]); setKeyword(''); }} className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition-colors ${item.appId === effectiveAppId ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300'}`}>{item.name || item.appId}</button>)}
          </div>

          <label className="mt-4 block text-[11px] font-medium text-zinc-700">群名称</label>
          <Input size="large" value={name} onChange={event => setName(event.target.value)} className="mt-1.5 text-[13px]"/>

          <div className="mt-4 flex items-center gap-1.5 text-[11px] font-medium text-zinc-700"><Users size={12}/>邀请成员<span className="font-normal text-zinc-400">（默认机器人创建者，可搜索/更换）</span></div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <Input className="min-w-0 flex-1" value={keyword} onChange={event => setKeyword(event.target.value)} onPressEnter={event => { if (keyword.trim()) { event.preventDefault(); search.mutate(keyword.trim()); } }} placeholder="输入姓名后回车搜索（机器人可见范围）" prefix={<Search size={13} className="text-zinc-400"/>} suffix={(members.isFetching || search.isPending) ? <LoaderCircle size={12} className="animate-spin text-zinc-400"/> : <span/>}/>
            <button type="button" disabled={!effectiveAppId || !keyword.trim() || search.isPending} onClick={() => search.mutate(keyword.trim())} className="h-8 shrink-0 rounded-md border border-zinc-200 px-2.5 text-[11px] text-zinc-600 hover:bg-zinc-50 disabled:opacity-40">搜索</button>
          </div>
          {(search.data?.error || search.error) && <p className="mt-1.5 text-[10px] text-amber-700">{search.data?.error ?? (search.error instanceof Error ? search.error.message : '搜索失败')}</p>}
          {effectivePicked.length > 0 && <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 px-2.5 py-2">
            <span className="text-[10px] text-zinc-400">已选</span>
            {effectivePicked.map(openId => {
              const user = candidates.find(item => item.openId === openId);
              const avatar = avatarFor(openId);
              return <span key={openId} className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-700">{avatar ? <img src={avatar} alt="" className="h-6 w-6 rounded-full object-cover"/> : <span className="grid h-6 w-6 place-items-center rounded-full bg-zinc-200 text-[10px] text-zinc-600">{(user?.name ?? '?').slice(0, 1)}</span>}{user?.name ?? openId}</span>;
            })}
          </div>}
          <div className="mt-2.5 border-t border-zinc-100 pt-3">
            <div className="max-h-40 overflow-y-auto">
              {filtered.length > 0 ? <div className="flex flex-wrap gap-1.5">{filtered.map(user => {
                const selected = effectivePicked.includes(user.openId);
                const avatar = avatarFor(user.openId);
                return <button key={user.openId} type="button" onClick={() => toggle(user.openId)} className={`flex h-8 items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-[11px] transition-colors ${selected ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-zinc-200 text-zinc-600 hover:border-zinc-300'}`}>{avatar ? <img src={avatar} alt="" className="h-6 w-6 rounded-full object-cover"/> : <span className="grid h-6 w-6 place-items-center rounded-full bg-zinc-100 text-[10px] text-zinc-500">{(user.name || '?').slice(0, 1)}</span>}{user.name}{selected && <Check size={11}/>}</button>;
              })}</div> : <p className="text-[11px] text-zinc-400">{members.isError && originChatId ? '读取原群成员失败（机器人可能不在该群）；用上面的搜索按姓名找人，或在下面填 open_id。' : '没有匹配的成员：换个名字搜索，或在下面填 open_id。'}</p>}
            </div>
          </div>
          <Input value={manual} onChange={event => setManual(event.target.value)} placeholder="补充一个 open_id（ou_ 开头，可选）" className="mt-2 font-mono text-[11px]"/>

          <p className="mt-3 text-[10px] leading-4 text-zinc-400">建群后，这个群的消息会直接进入当前会话；现有 Agent、模型、历史都保持不变。群里需要 @ 机器人来唤醒。机器人白名单内的群成员都能以完全信任权限驱动这个会话，请只拉信任的人。</p>
        </>}

        {handover.error && <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] leading-5 text-red-700">{handover.error instanceof Error ? handover.error.message : String(handover.error)}</p>}
        {created && <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-[11px] leading-5 text-emerald-800">
          已建群并绑定：<span className="font-medium">{created.name}</span>
          <a href={created.url} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-1 font-medium text-emerald-700 underline"><ExternalLink size={11}/>打开群聊</a>
        </div>}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-zinc-100 px-4 py-3">
        <button type="button" onClick={onClose} className="rounded-lg border border-zinc-300 px-3.5 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50">{created ? '完成' : '取消'}</button>
        {!created && <button type="button" disabled={!effectiveAppId || !name.trim() || handover.isPending} onClick={() => handover.mutate()} className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400">{handover.isPending && <LoaderCircle size={12} className="animate-spin"/>}建群并托管</button>}
      </div>
    </div>
  </div>;
}
