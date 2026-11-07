import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { sourcesRouterApi, type CaseDetail, type RouterCase, type RouterStatus, type Source } from './api';
import '../../src/index.css';
import './index.css';

const formatTime = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const badge = (status: string) => <span className="sr-badge" data-status={status}>{status}</span>;

function Panel({ title, actions, children }: { title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return <section className="sr-panel">
    <header className="sr-panel-header"><h2>{title}</h2><div>{actions}</div></header>
    <div className="sr-panel-body">{children}</div>
  </section>;
}

function App() {
  const [sources, setSources] = useState<Source[]>([]);
  const [cases, setCases] = useState<RouterCase[]>([]);
  const [router, setRouter] = useState<RouterStatus | null>(null);
  const [selected, setSelected] = useState<CaseDetail | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [newName, setNewName] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [nextSources, nextCases, nextRouter] = await Promise.all([
        sourcesRouterApi.sources(), sourcesRouterApi.cases({ sourceId: sourceFilter || undefined, status: statusFilter || undefined }), sourcesRouterApi.routerStatus()
      ]);
      setSources(nextSources); setCases(nextCases); setRouter(nextRouter); setError('');
      if (selectedId) {
        try { setSelected(await sourcesRouterApi.caseDetail(selectedId)); }
        catch { setSelected(null); setSelectedId(''); }
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [selectedId, sourceFilter, statusFilter]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(''); setMessage('');
    try { await action(); setMessage(success); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const createSource = () => run(async () => sourcesRouterApi.createSource({
    name: newName.trim() || '新的消息源', kind: 'webhook',
    config: { correlation: { mode: 'object' }, allowedRepos: [], actions: ['comment'] },
    ...(secret ? { secrets: { signingSecret: secret } } : {})
  }), '消息源已创建').then(() => { setNewName(''); setSecret(''); });

  const pendingInbox = useMemo(() => router?.inbox.filter(item => item.status === 'pending') ?? [], [router]);

  return <div className="sr-app">
    <aside className="sr-sidebar">
      <div className="sr-brand"><span className="sr-dot"/>AgentDock</div>
      <h1>消息源与 Router</h1>
      <p className="sr-muted">外部事件进入 Case，Router 判断并委派 Worker；所有内容按不可信数据处理。</p>
      <nav>
        <a href="/">返回主控制台</a>
        <a href="/sources-router.html" className="active">消息源控制台</a>
      </nav>
      <div className="sr-summary">
        <div><span>消息源</span><strong>{sources.length}</strong></div>
        <div><span>Case</span><strong>{cases.length}</strong></div>
        <div><span>Inbox</span><strong>{pendingInbox.length}</strong></div>
      </div>
      <div className="sr-router-card">
        <span className="sr-label">Router Session</span>
        <code>{router?.sessionId ?? '懒创建'}</code>
        <small>{router?.paused ? '已暂停' : '运行中'}</small>
        <button disabled={busy} onClick={() => void run(() => sourcesRouterApi.openRouter(), 'Router Session 已就绪')}>打开 / 复用 Router</button>
        <button disabled={busy} onClick={() => router && void run(() => sourcesRouterApi.setPaused(!router.paused), router.paused ? '已恢复 Router 派发' : '已开启全部暂停')}>{router?.paused ? '恢复全部' : '全部暂停'}</button>
      </div>
    </aside>
    <main className="sr-main">
      {(message || error) && <div className={`sr-notice ${error ? 'error' : ''}`}>{error || message}</div>}
      <div className="sr-grid">
        <Panel title="消息源" actions={<button disabled={busy} onClick={() => void refresh()}>刷新</button>}>
          <div className="sr-form">
            <input aria-label="消息源名称" placeholder="消息源名称" value={newName} onChange={event => setNewName(event.target.value)}/>
            <input aria-label="签名密钥" type="password" placeholder="签名密钥（可选）" value={secret} onChange={event => setSecret(event.target.value)}/>
            <button disabled={busy} onClick={() => void createSource()}>创建</button>
          </div>
          <div className="sr-list">
            {sources.map(source => <article key={source.id} className="sr-row">
              <div><strong>{source.name}</strong><code>{source.id}</code><span>{source.kind} · 最近事件 {formatTime(source.lastEventAt)}</span></div>
              <div className="sr-row-actions">{badge(source.enabled ? source.status : 'disabled')}<button disabled={busy} onClick={() => void run(() => sourcesRouterApi.setEnabled(source.id, !source.enabled), source.enabled ? '消息源已禁用' : '消息源已启用')}>{source.enabled ? '禁用' : '启用'}</button></div>
            </article>)}
            {!sources.length && <p className="sr-empty">暂无消息源。</p>}
          </div>
        </Panel>
        <Panel title="Router Inbox">
          <div className="sr-list">
            {pendingInbox.map(item => <article key={item.id} className="sr-row"><div><strong>{item.kind}</strong><code>{item.caseId ?? '-'}</code><span>{formatTime(item.createdAt)}</span></div>{badge(item.status)}</article>)}
            {!pendingInbox.length && <p className="sr-empty">Inbox 为空。</p>}
          </div>
        </Panel>
        <Panel title="Cases" actions={<>
          <select aria-label="按消息源筛选" value={sourceFilter} onChange={event => setSourceFilter(event.target.value)}><option value="">全部消息源</option>{sources.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          <select aria-label="按状态筛选" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="">全部状态</option><option value="open">open</option><option value="waiting">waiting</option><option value="closed">closed</option></select>
        </>}>
          <div className="sr-list">
            {cases.map(item => <button key={item.id} className={`sr-case ${selectedId === item.id ? 'selected' : ''}`} onClick={() => void sourcesRouterApi.caseDetail(item.id).then(detail => { setSelected(detail); setSelectedId(item.id); }).catch(reason => setError(String(reason)))}>
              <span><strong>{item.title}</strong><code>{item.id}</code></span>{badge(item.status)}<small>{formatTime(item.updatedAt)}</small>
            </button>)}
            {!cases.length && <p className="sr-empty">暂无 Case。</p>}
          </div>
        </Panel>
        <Panel title="Case 详情" actions={selected && selected.status !== 'closed' ? <button disabled={busy} onClick={() => selected && void run(() => sourcesRouterApi.closeCase(selected.id, '控制台手动关闭'), 'Case 已关闭')}>关闭 Case</button> : null}>
          {selected ? <div className="sr-detail">
            <div className="sr-detail-head"><strong>{selected.title}</strong>{badge(selected.status)}<code>{selected.correlationKey}</code></div>
            <p className="sr-muted">来源对象：<code>{String(selected.objectValue.id ?? '-')}</code> · 主会话：<code>{selected.primarySessionId ?? '-'}</code></p>
            <h3>时间线</h3>
            <ol className="sr-timeline">{selected.events.map(item => <li key={item.id}><time>{formatTime(item.createdAt)}</time><span>{item.kind}</span><p>{item.summary}</p></li>)}</ol>
            <h3>关联会话与动作</h3>
            <div className="sr-chips">{selected.sessions.map(item => <span key={item.sessionId}>委派 · {item.sessionId}</span>)}{selected.watches.map(item => <span key={item.id}>Watch · {item.status}</span>)}{selected.actions.map(item => <span key={item.id}>Action · {item.status}</span>)}{!selected.sessions.length && !selected.watches.length && !selected.actions.length && <span>暂无关联对象</span>}</div>
          </div> : <p className="sr-empty">选择一个 Case 查看时间线、关联 Session、Watch 和 Action。</p>}
        </Panel>
      </div>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>);
