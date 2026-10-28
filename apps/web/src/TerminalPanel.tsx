import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { LoaderCircle, RefreshCw, Terminal as TerminalIcon } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';

type ConnState = 'connecting' | 'open' | 'closed' | 'denied';

/**
 * 会话内可交互终端（右侧 tab 面板；移动端全屏覆盖）：连接 /api/sessions/:id/terminal，
 * 同一会话的多个客户端共享服务端同一个 pty。断线做有限次退避重连；
 * 访问门 401/403（全局 'agentdock:web-access-denied' 事件）后停止重连。
 */
export function TerminalPanel({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ConnState>('connecting');
  const [attempt, setAttempt] = useState(0);
  // epoch 变化即整体重挂一次连接（点「立即重连」时 +1）。
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#18181b', foreground: '#e4e4e7', cursor: '#e4e4e7', selectionBackground: '#3f3f46' }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // 等容器完成布局再 fit；尺寸为 0 时 fitAddon 会抛异常。
    const initialFit = requestAnimationFrame(() => { try { fit.fit(); } catch { /* 抽屉动画中尺寸可能为 0，ResizeObserver 会再 fit。 */ } });

    let socket: WebSocket | undefined;
    let closedByUser = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    let disposed = false;

    const sendResize = () => {
      if (socket?.readyState === WebSocket.OPEN && term.cols && term.rows) {
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    const resizeObserver = new ResizeObserver(() => { try { fit.fit(); sendResize(); } catch { /* 容器隐藏时忽略。 */ } });
    resizeObserver.observe(host);

    const onDataDisposable = term.onData(data => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
    });

    const stopOnDenied = () => { closedByUser = true; setState('denied'); socket?.close(); };
    window.addEventListener('agentdock:web-access-denied', stopOnDenied);

    const connect = () => {
      setState(retries ? 'closed' : 'connecting');
      const ws = new WebSocket(`/api/sessions/${sessionId}/terminal`);
      socket = ws;
      ws.onopen = () => {
        retries = 0;
        setState('open');
        setAttempt(0);
        try { fit.fit(); } catch { /* ignore */ }
        sendResize();
      };
      ws.onmessage = event => {
        if (typeof event.data !== 'string') return;
        let frame: { type?: string; data?: string; exitCode?: number };
        try { frame = JSON.parse(event.data); } catch { return; }
        if (frame.type === 'output' && typeof frame.data === 'string') term.write(frame.data);
        else if (frame.type === 'exit') term.write(`\r\n\x1b[90m[进程已退出，code=${frame.exitCode ?? 0}；关闭后重开可重新启动 shell]\x1b[0m\r\n`);
      };
      ws.onclose = () => {
        if (closedByUser || disposed) return;
        setState('closed');
        // 最多 5 次退避（1/2/4/8/8s）；服务端 pty 有 10 分钟空闲保留，重连不丢现场。
        if (retries >= 5) return;
        const delay = Math.min(1000 * 2 ** retries, 8000);
        retries += 1;
        setAttempt(retries);
        retryTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => { try { ws.close(); } catch { /* already closing */ } };
    };
    connect();

    return () => {
      disposed = true;
      closedByUser = true;
      cancelAnimationFrame(initialFit);
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener('agentdock:web-access-denied', stopOnDenied);
      resizeObserver.disconnect();
      onDataDisposable.dispose();
      try { socket?.close(); } catch { /* ignore */ }
      term.dispose();
    };
  }, [sessionId, epoch]);

  return <div className="flex h-full min-h-0 flex-col bg-[#18181b]">
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-zinc-800 px-3 text-[11px] text-zinc-400">
      <TerminalIcon size={13} className="text-zinc-300"/>
      <span className="font-medium text-zinc-300">终端</span>
      <span className="truncate font-mono text-[10px] text-zinc-500">$SHELL -l · 会话工作目录</span>
      <span className="ml-2 flex shrink-0 items-center gap-1 text-[10px]">
        {state === 'connecting' && <><LoaderCircle size={11} className="animate-spin text-blue-400"/>连接中…</>}
        {state === 'open' && <><span className="h-1.5 w-1.5 rounded-full bg-emerald-400"/>已连接</>}
        {state === 'closed' && <><span className="h-1.5 w-1.5 rounded-full bg-amber-400"/>已断开{attempt > 0 && `（第 ${attempt} 次重连）`}</>}
        {state === 'denied' && <><span className="h-1.5 w-1.5 rounded-full bg-red-400"/>访问凭证失效，不再重连</>}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        {state !== 'open' && state !== 'connecting' && state !== 'denied' && <button type="button" onClick={() => setEpoch(value => value + 1)} aria-label="立即重连" className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"><RefreshCw size={13}/></button>}
      </span>
    </div>
    <div ref={hostRef} className="min-h-0 flex-1 px-2 py-1 [&_.xterm]:h-full"/>
  </div>;
}
