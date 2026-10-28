import { Fragment } from 'react';
import type { Session } from './api';
import { modelBadge, modelBadgeText } from './model-label';
import { absoluteActivityTime, sessionActivityRow, sessionSourceLabel, sessionStatusLabel } from './session-details';

/**
 * 会话行 hover 卡片。
 *
 * 补的是「行上看不到、又必须看到」的几项：侧栏到处在截断（标题、路径），
 * `最近`的单行形态连 Agent 和状态文字都省了，缩进的侧边会话更看不出从哪来。
 *
 * 只负责排版：文案全部来自 session-details.ts 的纯函数，逻辑不在这儿重写一遍。
 */
export function SessionHoverCard({ session, agentName, botName, parentLabel, now }: {
  session: Session;
  agentName?: string;
  botName?: string;
  parentLabel?: string;
  now: Date;
}) {
  const status = sessionStatusLabel(session);
  // 别直接渲染 session.model：它是 agent 侧原样透传的，可能是 JSON 数组或带 [effort=…] 的怪串。
  const model = modelBadgeText(modelBadge(session.model, session.reasoningEffort));
  const rows: Array<{ label: string; value: string; path?: boolean }> = [
    { label: '工作目录', value: session.cwd, path: true },
    sessionActivityRow(session, now),
    { label: '创建于', value: absoluteActivityTime(session.createdAt) },
    { label: '来源', value: sessionSourceLabel(session, { botName, parentLabel }) }
  ];
  return <div className="w-[320px] max-w-[76vw] leading-5">
    {session.title && <div className="mb-1 break-words text-[12.5px] font-medium text-zinc-50">{session.title}</div>}
    <div className="flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.tone}`}/>
      <span className="min-w-0 truncate text-zinc-300">{[agentName ?? session.agentId, status.text, model].filter(Boolean).join(' · ')}</span>
    </div>
    <div className="my-1.5 border-t border-white/15"/>
    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      {rows.map(row => <Fragment key={row.label}>
        <span className="whitespace-nowrap text-zinc-400">{row.label}</span>
        <span className={`min-w-0 break-words text-zinc-100 ${row.path ? 'font-mono text-[10.5px]' : ''}`}>{row.path ? pathSegments(row.value) : row.value}</span>
      </Fragment>)}
    </div>
    <div className="my-1.5 border-t border-white/15"/>
    {/* 等宽 + 淡色：报障、去 CLI 里捞、跟人对齐都要用它，平时界面上无处可看。 */}
    <div className="break-all font-mono text-[10.5px] text-zinc-400">{session.id}</div>
  </div>;
}

/**
 * 路径按 `/` 切开，每段后面插一个 `<wbr/>`。
 *
 * 不插的话 `break-words` 会在任意位置断，长路径会断成 `my-` / `code/agent-` 这种
 * 半截词；插了之后浏览器优先在分隔符处换行，每一行都是一个完整的目录名。
 */
function pathSegments(value: string) {
  return value.split('/').map((segment, index) => <Fragment key={index}>{index > 0 && <>{'/'}<wbr/></>}{segment}</Fragment>);
}
