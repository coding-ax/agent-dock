import { useEffect, useMemo, useRef, useState, type ComponentType, type FormEvent } from 'react';
import { Bug, Compass, Eye, FileSearch, FlaskConical, Pencil, Plus, Repeat, ScanSearch, SlidersHorizontal, Sparkles, Trash2, Wand2, X } from 'lucide-react';
import { useModalFocusTrap } from './useModalFocusTrap';
import {
  applyPromptTemplate, builtinPromptTemplates, customTemplateFromInput, extractTemplateFields,
  loadCustomTemplates, PROMPT_TEMPLATE_STORAGE_KEY, saveCustomTemplates,
  type PromptTemplate, type PromptTemplateIcon
} from './prompt-templates';

const templateIcons: Record<PromptTemplateIcon, ComponentType<{ size?: number; className?: string }>> = {
  repeat: Repeat, sparkles: Sparkles, bug: Bug, review: ScanSearch,
  test: FlaskConical, compass: Compass, custom: FileSearch
};

type DialogState = { kind: 'fill'; template: PromptTemplate } | { kind: 'edit'; template?: PromptTemplate };

/**
 * 首页的提示词模板卡片。预置模板只读，自定义模板存在当前浏览器的 localStorage；
 * 点卡片先填变量，再「填入输入框」——不会直接发送，用户仍可改完再发。
 */
export function PromptTemplates({ onUse }: { onUse(text: string): void }) {
  const [custom, setCustom] = useState<PromptTemplate[]>(() => loadCustomTemplates());
  const [dialog, setDialog] = useState<DialogState>();

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === PROMPT_TEMPLATE_STORAGE_KEY) setCustom(loadCustomTemplates());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const persist = (next: PromptTemplate[]) => {
    setCustom(next);
    saveCustomTemplates(next);
  };

  // 点卡片 = 直接用默认值回填输入框；没填的变量保留 {{变量}}，在编辑器里就地改，
  // 不再先弹一个必填表单挡路。带变量的模板仍可从右上角图标进入表单逐项填写并预览。
  const open = (template: PromptTemplate) => {
    const defaults = Object.fromEntries(template.fields.map(field => [field.key, field.defaultValue ?? '']));
    onUse(applyPromptTemplate(template, defaults));
  };

  return <section aria-label="提示词模板" className="mt-4">
    <div className="mb-2 flex items-center gap-1.5 px-0.5 text-[12px] font-medium text-zinc-500">
      <Wand2 size={12}/><span>提示词模板</span>
      <span className="ml-auto font-normal text-zinc-400">点卡片直接填入，右上角可填写变量</span>
    </div>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {[...builtinPromptTemplates, ...custom].map(template => {
        const Icon = templateIcons[template.icon];
        const hasFill = template.fields.length > 0;
        return <div key={template.id} className="group relative h-full">
          <button type="button" onClick={() => open(template)} title="点击直接填入输入框" className={`flex h-full min-h-[78px] w-full flex-col rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-left transition-[border-color,box-shadow,transform] duration-150 ease-[cubic-bezier(.2,0,0,1)] hover:-translate-y-px hover:border-zinc-300 hover:shadow-[0_4px_14px_rgba(24,24,27,.06)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50 ${template.builtin ? (hasFill ? 'pr-8' : '') : 'pr-14'}`}>
            <span className="flex w-full items-center gap-1.5 pr-5 text-[12px] font-medium text-zinc-800"><Icon size={13} className="shrink-0 text-zinc-400"/><span className="truncate">{template.title}</span></span>
            <span className="mt-1 line-clamp-2 block text-[12px] leading-[1.5] text-zinc-500">{template.description}</span>
          </button>
          {hasFill && <button type="button" onClick={() => setDialog({ kind: 'fill', template })} aria-label={`填写模板变量：${template.title}`} title="填写变量并预览最终文案" className={`absolute top-1.5 grid h-6 w-6 place-items-center rounded-md text-zinc-400 opacity-100 transition-opacity hover:bg-zinc-100 hover:text-zinc-700 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 ${template.builtin ? 'right-1.5' : 'right-8'}`}><SlidersHorizontal size={11}/></button>}
          {!template.builtin && <button type="button" onClick={() => setDialog({ kind: 'edit', template })} aria-label={`编辑模板：${template.title}`} title="编辑模板" className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-md text-zinc-400 opacity-100 transition-opacity hover:bg-zinc-100 hover:text-zinc-700 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"><Pencil size={11}/></button>}
        </div>;
      })}
      <button type="button" onClick={() => setDialog({ kind: 'edit' })} className="flex min-h-[78px] w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-zinc-300 px-3 py-2.5 text-[12px] text-zinc-500 transition-colors hover:border-zinc-400 hover:bg-zinc-50 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50"><Plus size={14}/><span>新建模板</span></button>
    </div>
    {dialog && <TemplateDialog state={dialog} onClose={() => setDialog(undefined)} onApply={text => { setDialog(undefined); onUse(text); }} onSave={template => {
      persist(custom.some(item => item.id === template.id) ? custom.map(item => item.id === template.id ? template : item) : [...custom, template]);
      setDialog(undefined);
    }} onDelete={id => { persist(custom.filter(item => item.id !== id)); setDialog(undefined); }}/>}
  </section>;
}

function TemplateDialog({ state, onClose, onApply, onSave, onDelete }: {
  state: DialogState;
  onClose(): void;
  onApply(text: string): void;
  onSave(template: PromptTemplate): void;
  onDelete(id: string): void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap({ panel: panelRef, initial: panelRef, dismissible: true, onDismiss: onClose });
  const editing = state.kind === 'edit';
  const title = editing ? (state.template ? '编辑模板' : '新建模板') : state.template.title;
  return <div className="ui-overlay fixed inset-0 z-[60] grid place-items-center bg-zinc-950/30 p-2 sm:p-4">
    <div ref={panelRef} role="dialog" aria-modal="true" aria-label={title} className="ui-dialog flex max-h-[88dvh] w-full max-w-xl flex-col overflow-hidden rounded-[14px] border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(24,24,27,.2)]">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-100 px-4">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold text-zinc-900">{title}</div>
          {!editing && <div className="truncate text-[12px] text-zinc-400">{state.template.description}</div>}
        </div>
        <button type="button" onClick={onClose} aria-label="关闭" className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"><X size={16}/></button>
      </div>
      {editing ? <EditTemplate template={state.template} onClose={onClose} onSave={onSave} onDelete={onDelete}/> : <FillTemplate template={state.template} onClose={onClose} onApply={onApply}/>}
    </div>
  </div>;
}

function FillTemplate({ template, onClose, onApply }: { template: PromptTemplate; onClose(): void; onApply(text: string): void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(template.fields.map(field => [field.key, field.defaultValue ?? ''])));
  // 所有变量都可留空，留空的保留 {{变量}}，到编辑器里还能继续补；这里只做实时预览。
  const preview = useMemo(() => applyPromptTemplate(template, values), [template, values]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply(preview);
  };
  return <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
      {template.fields.map((field, index) => <label key={field.key} className="block">
        <span className="mb-1.5 flex items-center gap-1 text-[12px] font-medium text-zinc-600">{field.label}</span>
        {field.multiline
          ? <textarea autoFocus={index === 0} value={values[field.key] ?? ''} onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))} rows={3} placeholder={field.placeholder} className="ui-field w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[13px] leading-5 text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-400"/>
          : <input autoFocus={index === 0} value={values[field.key] ?? ''} onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))} placeholder={field.placeholder} spellCheck={false} className="ui-field h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 text-[13px] text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-400"/>}
      </label>)}
      {template.fields.length === 0 && <p className="text-[12px] text-zinc-400">这个模板没有变量，会直接填入输入框。</p>}
      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-zinc-600"><Eye size={12} className="text-zinc-400"/>最终文案预览</div>
        <pre aria-label="最终文案预览" className="max-h-44 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 font-sans text-[12px] leading-5 text-zinc-600">{preview}</pre>
        <p className="mt-1 text-[12px] text-zinc-400">变量留空会保留 {'{{变量}}'} 占位，填入后仍可在输入框里修改。</p>
      </div>
    </div>
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-zinc-100 px-4 py-3">
      <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-[12px] text-zinc-600 hover:bg-zinc-100">取消</button>
      <button type="submit" className="rounded-lg bg-zinc-900 px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-zinc-800">填入输入框</button>
    </div>
  </form>;
}

function EditTemplate({ template, onClose, onSave, onDelete }: { template?: PromptTemplate; onClose(): void; onSave(template: PromptTemplate): void; onDelete(id: string): void }) {
  const [title, setTitle] = useState(template?.title ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [body, setBody] = useState(template?.body ?? '');
  const [error, setError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const variables = useMemo(() => extractTemplateFields(body).map(field => field.key), [body]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      onSave(customTemplateFromInput({ title, description, body }, template?.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
      <label className="block">
        <span className="mb-1.5 flex items-center gap-1 text-[12px] font-medium text-zinc-600">模板名称<span className="text-red-500">*</span></span>
        <input autoFocus value={title} onChange={event => setTitle(event.target.value)} maxLength={40} placeholder="例如：发布前检查" className="ui-field h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 text-[13px] text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-400"/>
      </label>
      <label className="block">
        <span className="mb-1.5 block text-[12px] font-medium text-zinc-600">一句话说明</span>
        <input value={description} onChange={event => setDescription(event.target.value)} maxLength={120} placeholder="显示在卡片上，可留空" className="ui-field h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 text-[13px] text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-400"/>
      </label>
      <label className="block">
        <span className="mb-1.5 flex items-center gap-1 text-[12px] font-medium text-zinc-600">模板内容<span className="text-red-500">*</span></span>
        <textarea value={body} onChange={event => setBody(event.target.value)} rows={8} placeholder={'直接写完整提示词。用 {{变量名}} 标记需要每次填写的内容。\n\n例如：请检查 {{项目}} 的发布前状态，并运行 {{验证命令}}。'} className="ui-field w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 font-mono text-[12px] leading-5 text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-400"/>
      </label>
      <div className="text-[12px] leading-5 text-zinc-500">
        {variables.length ? <>识别到变量：<span className="font-mono text-zinc-700">{variables.join('、')}</span></> : '没有 {{变量}}，点击卡片会直接填入整段提示词。'}
      </div>
      {error && <p role="alert" className="text-[12px] text-red-600">{error}</p>}
    </div>
    <div className="flex shrink-0 items-center gap-2 border-t border-zinc-100 px-4 py-3">
      {template && <button type="button" onClick={() => {
        if (!confirmDelete) { setConfirmDelete(true); return; }
        onDelete(template.id);
      }} className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] text-red-600 hover:bg-red-50"><Trash2 size={12}/>{confirmDelete ? '确认删除' : '删除'}</button>}
      <button type="button" onClick={onClose} className="ml-auto rounded-lg px-3 py-1.5 text-[12px] text-zinc-600 hover:bg-zinc-100">取消</button>
      <button type="submit" disabled={!title.trim() || !body.trim()} className="rounded-lg bg-zinc-900 px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40">保存模板</button>
    </div>
  </form>;
}
