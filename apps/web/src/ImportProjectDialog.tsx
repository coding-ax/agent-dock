import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FolderOpen, FolderPlus, X } from 'lucide-react';
import { api, type Project } from './api';
import { hasMacDirectoryPicker, desktopProjectPicker } from './desktop-projects';
import { useModalFocusTrap } from './useModalFocusTrap';

/**
 * 导入项目。
 *
 * macOS 桌面壳走 Electron 的 `dialog.showOpenDialog({ properties: ['openDirectory'] })`
 * （preload 暴露 `agentdockDesktop.projects.pickDirectory`）；浏览器、Windows、Linux
 * 没有这个 bridge，退化成手输绝对路径。两条路径最终都调同一个 `/api/projects`，
 * 服务端负责 `~` 展开、realpath 归一、存在/目录/读写权限校验和去重。
 */
export function ImportProjectDialog({ onClose, onImported }: { onClose(): void; onImported(project: Project, duplicate: boolean): void }) {
  const qc = useQueryClient();
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap({ panel: panelRef, initial: panelRef, dismissible: true, onDismiss: onClose });
  const picker = hasMacDirectoryPicker() ? desktopProjectPicker() : undefined;
  const [path, setPath] = useState('');
  const [localError, setLocalError] = useState<string>();
  const [picking, setPicking] = useState(false);

  const importProject = useMutation({
    mutationFn: (value: string) => api.importProject(value),
    onSuccess: result => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
      onImported(result.project, !result.created);
      onClose();
    }
  });

  const error = localError ?? (importProject.error instanceof Error ? importProject.error.message : undefined);

  const submit = (value = path) => {
    const trimmed = value.trim();
    if (!trimmed) { setLocalError('请输入项目路径'); return; }
    setLocalError(undefined);
    importProject.mutate(trimmed);
  };

  const pick = async () => {
    if (!picker) return;
    setLocalError(undefined);
    setPicking(true);
    try {
      const result = await picker.pickDirectory();
      if (result.canceled) return;
      if (!result.supported) { setLocalError('当前桌面端不支持目录选择器，请手动输入绝对路径'); return; }
      if (!result.path) { setLocalError('没有拿到所选目录，请重试'); return; }
      setPath(result.path);
      submit(result.path);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPicking(false);
    }
  };

  const busy = importProject.isPending || picking;
  return <div className="ui-overlay fixed inset-0 z-[60] grid place-items-center bg-zinc-950/30 p-2 sm:p-4" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <div ref={panelRef} role="dialog" aria-modal="true" aria-label="导入项目" className="ui-dialog flex w-full max-w-lg flex-col overflow-hidden rounded-[14px] border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(24,24,27,.2)]">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-100 px-4">
        <div className="flex items-center gap-2 text-[16px] font-semibold text-zinc-900"><FolderPlus size={16}/>导入项目</div>
        <button type="button" onClick={onClose} aria-label="关闭" className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"><X size={16}/></button>
      </div>
      <div className="space-y-3 px-4 py-4">
        <p className="text-[12px] leading-5 text-zinc-500">
          {picker
            ? '选择一个本机文件夹作为项目。导入后可以在项目视图里用它作为工作目录新建会话。'
            : '粘贴本机文件夹的绝对路径。导入后可以在项目视图里用它作为工作目录新建会话。'}
        </p>
        {picker
          ? <button type="button" disabled={busy} onClick={() => void pick()} className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-300 bg-zinc-50 text-[13px] font-medium text-zinc-700 transition-colors hover:border-zinc-400 hover:bg-zinc-100 disabled:opacity-60">
              <FolderOpen size={15}/>{picking ? '正在打开目录选择器…' : '选择文件夹…'}
            </button>
          : <input
              autoFocus
              value={path}
              onChange={event => { setPath(event.target.value); setLocalError(undefined); }}
              onKeyDown={event => { if (event.key === 'Enter' && !busy) submit(); }}
              placeholder="/Users/you/code/project"
              aria-label="项目绝对路径"
              spellCheck={false}
              className="h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 font-mono text-[13px] text-zinc-800 outline-none focus:border-zinc-400"/>
        }
        {picker && path && <div className="rounded-md bg-zinc-50 px-2.5 py-2 font-mono text-[12px] leading-5 text-zinc-600">{path}</div>}
        {error && <div role="alert" className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700"><AlertTriangle size={13} className="mt-0.5 shrink-0"/><span className="min-w-0 break-words">{error}</span></div>}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="h-8 rounded-lg px-3 text-[12px] text-zinc-600 hover:bg-zinc-100">取消</button>
          {!picker && <button type="button" disabled={busy} onClick={() => submit()} className="h-8 rounded-lg bg-zinc-900 px-3.5 text-[12px] font-medium text-white hover:bg-zinc-800 disabled:opacity-50">{importProject.isPending ? '导入中…' : '导入'}</button>}
        </div>
      </div>
    </div>
  </div>;
}
