import { useEffect, useMemo, useRef, useState, type ComponentType, type FormEvent } from 'react';
import {
  Bug,
  Compass,
  Copy,
  Eye,
  FileSearch,
  FlaskConical,
  Pencil,
  Plus,
  Repeat,
  RotateCcw,
  ScanSearch,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Wand2,
  Wrench,
  X
} from 'lucide-react';
import { ExitGate } from './ExitGate';
import { HoverTooltip } from './HoverTooltip';
import { useBi, useLocale, useT } from './i18n';
import { IconButton } from './ui-controls';
import { useModalFocusTrap } from './useModalFocusTrap';
import { AiFieldHeader, AiTextAssistControl, useAiFlash } from './AiTextAssist';
import {
  applyPromptTemplate,
  customTemplateFromInput,
  displayPromptTemplateDescription,
  extractTemplateFields,
  getBuiltinPromptTemplates,
  getBuiltinTemplateDefaultText,
  getUnfilledPlaceholderKeys,
  isDefaultCustomDescription,
  loadCustomTemplates,
  PROMPT_TEMPLATE_STORAGE_KEY,
  saveCustomTemplates,
  type CustomTemplateInput,
  type PromptTemplate,
  type PromptTemplateField,
  type PromptTemplateIcon
} from './prompt-templates';

const templateIcons: Record<PromptTemplateIcon, ComponentType<{ size?: number; className?: string }>> = {
  repeat: Repeat,
  sparkles: Sparkles,
  bug: Bug,
  review: ScanSearch,
  refactor: Wrench,
  test: FlaskConical,
  compass: Compass,
  custom: FileSearch
};

type DialogState =
  | { kind: 'fill'; template: PromptTemplate }
  | { kind: 'edit'; template?: PromptTemplate; initialDraft?: CustomTemplateInput };

function fieldSlotId(field: PromptTemplateField): string {
  return field.id ?? field.key;
}

/**
 * 首页的提示词模板卡片。
 * - 内置模板按当前语言动态解析，点卡片直接用默认值填入输入框（即点即用模板无残留占位符）。
 * - 点右上角滑块图标进入变量填写与实时预览弹窗，并支持将内置模板另存为自定义副本。
 * - 自定义模板保存在浏览器 localStorage，始终保留用户内容且绝不被覆盖。
 */
export function PromptTemplates({ onUse }: { onUse(text: string): void }) {
  const locale = useLocale();
  const t = useT();
  const builtins = useMemo(() => getBuiltinPromptTemplates(locale), [locale]);
  const [custom, setCustom] = useState<PromptTemplate[]>(() => loadCustomTemplates(locale));
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

  const open = (template: PromptTemplate) => {
    onUse(getBuiltinTemplateDefaultText(template));
  };

  const activeDialog = dialog?.kind === 'fill' && dialog.template.builtin
    ? { kind: 'fill' as const, template: builtins.find(item => item.id === dialog.template.id) ?? dialog.template }
    : dialog;

  return <section aria-label={t('prompts.section.title')} data-testid="prompt-templates-section" className="mt-4">
    <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5 sm:mb-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] font-medium text-zinc-500">
          <Wand2 size={12} className="shrink-0"/>
          <span>{t('prompts.section.title')}</span>
        </span>
        <span className="hidden truncate text-[11.5px] font-normal text-zinc-400 sm:inline">
          {t('prompts.section.hint')}
        </span>
      </div>
      <button
        type="button"
        data-testid="prompt-template-new-btn"
        onClick={() => setDialog({ kind: 'edit' })}
        className="ui-press inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-zinc-200 bg-white px-2 text-[11.5px] font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50"
      >
        <Plus size={12} className="shrink-0"/>
        <span>{t('prompts.section.newBtn')}</span>
      </button>
    </div>
    <p className="mb-2 px-0.5 text-[11px] leading-4 text-zinc-400 sm:hidden">
      {t('prompts.section.hint')}
    </p>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {[...builtins, ...custom].map(template => {
        const Icon = templateIcons[template.icon];
        const hasFill = template.fields.length > 0;
        const description = displayPromptTemplateDescription(template, locale);
        const titleRightPad = template.builtin ? (hasFill ? 'pr-5' : '') : (hasFill ? 'pr-12' : 'pr-5');
        return <div key={template.id} className="group relative h-full min-w-0">
          <button
            type="button"
            data-testid={`prompt-template-card-${template.id}`}
            onClick={() => open(template)}
            className="flex h-full min-h-[78px] w-full flex-col rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-left transition-[border-color,box-shadow,transform] duration-150 ease-[cubic-bezier(.2,0,0,1)] hover:-translate-y-px hover:border-zinc-300 hover:shadow-[0_4px_14px_rgba(24,24,27,.06)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50"
          >
            <span className={`flex w-full min-w-0 items-center gap-1.5 text-[12px] font-medium text-zinc-800 sm:text-[12.5px] ${titleRightPad}`}>
              <Icon size={13} className="shrink-0 text-zinc-400"/>
              <span className="truncate">{template.title}</span>
            </span>
            <span className="mt-1.5 line-clamp-2 w-full text-[11.5px] leading-[1.45] text-zinc-500">
              {description}
            </span>
          </button>
          {hasFill && <HoverTooltip content={t('prompts.card.fillTooltip')}>
            <button
              type="button"
              data-testid={`prompt-template-fill-${template.id}`}
              onClick={() => setDialog({ kind: 'fill', template })}
              aria-label={t('prompts.card.fillAria', { title: template.title })}
              className={`absolute top-1.5 grid h-6 w-6 place-items-center rounded-md text-zinc-400 opacity-100 transition-opacity hover:bg-zinc-100 hover:text-zinc-700 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 ${template.builtin ? 'right-1.5' : 'right-8'}`}
            >
              <SlidersHorizontal size={11}/>
            </button>
          </HoverTooltip>}
          {!template.builtin && <HoverTooltip content={t('prompts.card.editTooltip')}>
            <button
              type="button"
              data-testid={`prompt-template-edit-${template.id}`}
              onClick={() => setDialog({ kind: 'edit', template })}
              aria-label={t('prompts.card.editAria', { title: template.title })}
              className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-md text-zinc-400 opacity-100 transition-opacity hover:bg-zinc-100 hover:text-zinc-700 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
            >
              <Pencil size={11}/>
            </button>
          </HoverTooltip>}
        </div>;
      })}
    </div>
    <ExitGate open={Boolean(activeDialog)}>
      {activeDialog && <TemplateDialog
        state={activeDialog}
        onClose={() => setDialog(undefined)}
        onApply={text => { setDialog(undefined); onUse(text); }}
        onFork={draft => setDialog({ kind: 'edit', initialDraft: draft })}
        onSave={template => {
          persist(custom.some(item => item.id === template.id)
            ? custom.map(item => item.id === template.id ? template : item)
            : [...custom, template]);
          setDialog(undefined);
        }}
        onDelete={id => { persist(custom.filter(item => item.id !== id)); setDialog(undefined); }}
      />}
    </ExitGate>
  </section>;
}

function TemplateDialog({ state, onClose, onApply, onFork, onSave, onDelete }: {
  state: DialogState;
  onClose(): void;
  onApply(text: string): void;
  onFork(draft: CustomTemplateInput): void;
  onSave(template: PromptTemplate): void;
  onDelete(id: string): void;
}) {
  const t = useT();
  const locale = useLocale();
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap({ panel: panelRef, initial: panelRef, dismissible: true, onDismiss: onClose });
  const editing = state.kind === 'edit';
  const title = editing
    ? (state.template ? t('prompts.dialog.editTitle') : state.initialDraft ? t('prompts.dialog.forkTitle') : t('prompts.dialog.newTitle'))
    : state.template.title;
  const description = !editing ? displayPromptTemplateDescription(state.template, locale) : undefined;
  return <div
    className="ui-overlay fixed inset-0 z-[60] grid place-items-center bg-zinc-950/30 p-2 sm:p-4"
    onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}
  >
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="prompt-template-dialog"
      className="ui-dialog flex max-h-[88dvh] w-full max-w-xl flex-col overflow-hidden rounded-[14px] border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(24,24,27,.2)]"
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-zinc-100 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-zinc-900">{title}</div>
          {description && <div className="mt-0.5 truncate text-[12px] text-zinc-400">{description}</div>}
        </div>
        <span className="ml-auto shrink-0">
          <IconButton label={t('common.close')} onClick={onClose}><X size={16}/></IconButton>
        </span>
      </div>
      {editing
        ? <EditTemplate
            key={state.template?.id ?? (state.initialDraft ? `fork:${state.initialDraft.title}` : 'new')}
            template={state.template}
            initialDraft={state.initialDraft}
            onClose={onClose}
            onSave={onSave}
            onDelete={onDelete}
          />
        : <FillTemplate
            key={state.template.id}
            template={state.template}
            onClose={onClose}
            onApply={onApply}
            onFork={onFork}
          />}
    </div>
  </div>;
}

function buildDefaultSlotValues(fields: PromptTemplateField[]): Record<string, string> {
  return Object.fromEntries(fields.map(field => [fieldSlotId(field), field.defaultValue ?? '']));
}

function FillTemplate({ template, onClose, onApply, onFork }: {
  template: PromptTemplate;
  onClose(): void;
  onApply(text: string): void;
  onFork(draft: CustomTemplateInput): void;
}) {
  const t = useT();
  const L = useBi();
  const [slotValues, setSlotValues] = useState<Record<string, string>>(() => buildDefaultSlotValues(template.fields));
  const prevDefaultsRef = useRef<Record<string, string>>(buildDefaultSlotValues(template.fields));

  // 当界面语言在弹窗打开期间切换时：未改动过的默认值平滑切换为新语言默认值，用户已手填的内容完整保留。
  useEffect(() => {
    const nextDefaults = buildDefaultSlotValues(template.fields);
    const prevDefaults = prevDefaultsRef.current;
    setSlotValues(current => {
      const updated: Record<string, string> = {};
      for (const field of template.fields) {
        const slot = fieldSlotId(field);
        const existing = current[slot];
        const prevDefault = prevDefaults[slot] ?? '';
        updated[slot] = existing === undefined || existing === prevDefault
          ? (nextDefaults[slot] ?? '')
          : existing;
      }
      return updated;
    });
    prevDefaultsRef.current = nextDefaults;
  }, [template]);

  const keyedValues = useMemo(
    () => Object.fromEntries(template.fields.map(field => [field.key, slotValues[fieldSlotId(field)] ?? ''])),
    [template.fields, slotValues]
  );

  const preview = useMemo(() => applyPromptTemplate(template, keyedValues), [template, keyedValues]);
  const unfilled = useMemo(() => getUnfilledPlaceholderKeys(preview), [preview]);
  const isDirty = useMemo(
    () => template.fields.some(field => (slotValues[fieldSlotId(field)] ?? '') !== (field.defaultValue ?? '')),
    [template.fields, slotValues]
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply(preview);
  };

  return <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
      {template.fields.map((field, index) => {
        const slot = fieldSlotId(field);
        return <label key={slot} className="block">
          <span className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-zinc-600">
            <span>{field.label}</span>
            {field.optional && (
              <span className="rounded bg-zinc-100 px-1.5 py-px text-[10.5px] font-normal text-zinc-500">
                {t('common.optional')}
              </span>
            )}
          </span>
          {field.multiline
            ? <textarea
                autoFocus={index === 0}
                value={slotValues[slot] ?? ''}
                onChange={event => setSlotValues(current => ({ ...current, [slot]: event.target.value }))}
                rows={3}
                placeholder={field.placeholder}
                className="ui-field w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[13px] leading-5 text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-400"
              />
            : <input
                autoFocus={index === 0}
                value={slotValues[slot] ?? ''}
                onChange={event => setSlotValues(current => ({ ...current, [slot]: event.target.value }))}
                placeholder={field.placeholder}
                spellCheck={false}
                className="ui-field h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 text-[13px] text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-400"
              />}
        </label>;
      })}
      {template.fields.length === 0 && (
        <p className="text-[12px] text-zinc-400">{t('prompts.dialog.noVariables')}</p>
      )}
      <div>
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-zinc-600">
            <Eye size={12} className="text-zinc-400"/>
            <span>{t('prompts.dialog.previewTitle')}</span>
            {unfilled.length === 0
              ? <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-px text-[10.5px] font-medium text-emerald-700">
                  {t('prompts.dialog.previewReady')}
                </span>
              : <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-px text-[10.5px] font-medium text-amber-700">
                  {t('prompts.dialog.previewPending', { count: unfilled.length })}
                </span>}
          </div>
          {isDirty && (
            <button
              type="button"
              onClick={() => setSlotValues(buildDefaultSlotValues(template.fields))}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
            >
              <RotateCcw size={11}/>
              <span>{t('prompts.dialog.resetDefaults')}</span>
            </button>
          )}
        </div>
        <pre
          aria-label={t('prompts.dialog.previewTitle')}
          data-testid="prompt-template-preview"
          className="max-h-52 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 font-sans text-[12px] leading-5 text-zinc-700"
        >
          {preview}
        </pre>
        <p className="mt-1 text-[11.5px] leading-4 text-zinc-400">
          {t('prompts.dialog.previewHint', { token: L('{{变量}}', '{{variable}}') })}
        </p>
      </div>
    </div>
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 border-t border-zinc-100 px-3 py-3 sm:gap-2 sm:px-4">
      {template.builtin && (
        <button
          type="button"
          data-testid="prompt-template-fork-btn"
          onClick={() => onFork({ title: template.title, description: template.description, body: template.body })}
          className="mr-auto inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-[12px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 sm:px-2.5"
        >
          <Copy size={12}/>
          <span className="sm:hidden">{L('另存副本', 'Save copy')}</span>
          <span className="hidden sm:inline">{t('prompts.dialog.forkBtn')}</span>
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        className="whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[12px] text-zinc-600 hover:bg-zinc-100 sm:px-3"
      >
        {t('common.cancel')}
      </button>
      <button
        type="submit"
        data-testid="prompt-template-insert-btn"
        className="ui-press whitespace-nowrap rounded-lg bg-zinc-900 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-zinc-800 sm:px-3.5"
      >
        <span className="sm:hidden">{L('填入', 'Insert')}</span>
        <span className="hidden sm:inline">{t('prompts.dialog.insertBtn')}</span>
      </button>
    </div>
  </form>;
}

function EditTemplate({ template, initialDraft, onClose, onSave, onDelete }: {
  template?: PromptTemplate;
  initialDraft?: CustomTemplateInput;
  onClose(): void;
  onSave(template: PromptTemplate): void;
  onDelete(id: string): void;
}) {
  const t = useT();
  const L = useBi();
  const locale = useLocale();
  const initialDesc = template
    ? (isDefaultCustomDescription(template.description) ? '' : template.description)
    : (initialDraft?.description ?? '');
  const [title, setTitle] = useState(template?.title ?? initialDraft?.title ?? '');
  const [description, setDescription] = useState(initialDesc);
  const [body, setBody] = useState(template?.body ?? initialDraft?.body ?? '');
  const [error, setError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const titleFlash = useAiFlash();
  const descFlash = useAiFlash();
  const bodyFlash = useAiFlash();
  const variables = useMemo(() => extractTemplateFields(body).map(field => field.key), [body]);
  const resetKey = template?.id ?? (initialDraft ? `fork:${initialDraft.title}` : 'new-template');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      onSave(customTemplateFromInput({ title, description, body }, template?.id, locale));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
      <div className="block">
        <AiFieldHeader
          label={t('prompts.form.titleLabel')}
          htmlFor="prompt-template-title"
          required
          className="mb-1.5"
          assist={
            <AiTextAssistControl
              mode="title_generate"
              variant="pill"
              size="xs"
              popoverSide="bottom"
              popoverAlign="end"
              value={title}
              onChange={setTitle}
              onFlash={titleFlash.triggerFlash}
              resetKey={resetKey}
              context={() => ({
                field: L('提示词模板名称', 'Prompt template name'),
                purpose: L('展示在提示词模板卡片上的简短名称（4–16 字）', 'Short title shown on the prompt template card (2–5 words)'),
                maxChars: 18,
                ...(description.trim() ? { extra: L(`模板说明：${description.trim()}`, `Template description: ${description.trim()}`) } : {}),
                ...(body.trim() ? { recentMessages: [{ role: L('模板正文', 'Template body'), text: body.trim().slice(0, 600) }] } : {}),
                ...(variables.length ? { variables } : {})
              })}
              testId="template-title-ai"
            />
          }
        />
        <input
          id="prompt-template-title"
          autoFocus
          value={title}
          onChange={event => setTitle(event.target.value)}
          maxLength={40}
          placeholder={t('prompts.form.titlePlaceholder')}
          className={`ui-field h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 text-[13px] text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-400 ${titleFlash.flashClass}`}
        />
      </div>
      <div className="block">
        <AiFieldHeader
          label={t('prompts.form.descLabel')}
          htmlFor="prompt-template-description"
          className="mb-1.5"
          assist={
            <AiTextAssistControl
              mode="description_polish"
              variant="pill"
              size="xs"
              popoverSide="bottom"
              popoverAlign="end"
              value={description}
              onChange={setDescription}
              onFlash={descFlash.triggerFlash}
              resetKey={resetKey}
              context={() => ({
                field: L('提示词模板一句话说明', 'Prompt template short description'),
                purpose: L('展示在首页提示词模板卡片标题下方的简短说明，不超过 48 字', 'Concise one-line description shown under the prompt template card title'),
                maxChars: 48,
                ...(title.trim() ? { sessionTitle: title.trim() } : {}),
                ...(body.trim() ? { recentMessages: [{ role: L('模板正文', 'Template body'), text: body.trim().slice(0, 600) }] } : {}),
                ...(variables.length ? { variables } : {})
              })}
              testId="template-desc-ai"
            />
          }
        />
        <input
          id="prompt-template-description"
          value={description}
          onChange={event => setDescription(event.target.value)}
          maxLength={120}
          placeholder={t('prompts.form.descPlaceholder')}
          className={`ui-field h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 text-[13px] text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-400 ${descFlash.flashClass}`}
        />
      </div>
      <div className="block">
        <AiFieldHeader
          label={t('prompts.form.bodyLabel')}
          htmlFor="prompt-template-body"
          required
          className="mb-1.5"
          assist={
            <AiTextAssistControl
              mode="prompt_write"
              variant="pill"
              size="xs"
              popoverSide="bottom"
              popoverAlign="end"
              value={body}
              onChange={setBody}
              onFlash={bodyFlash.triggerFlash}
              resetKey={resetKey}
              context={() => ({
                field: L('提示词模板内容', 'Prompt template content'),
                purpose: L('可复用的 AI Agent 提示词模板；需要用户每次填写的部分请使用 {{变量名}} 占位符', 'Reusable AI Agent prompt template; use {{variable}} placeholders for parts filled in each time'),
                ...(title.trim() ? { sessionTitle: title.trim() } : {}),
                ...(description.trim() ? { extra: L(`模板说明：${description.trim()}`, `Template description: ${description.trim()}`) } : {}),
                ...(variables.length ? { variables } : {})
              })}
              testId="template-body-ai"
            />
          }
        />
        <textarea
          id="prompt-template-body"
          value={body}
          onChange={event => setBody(event.target.value)}
          rows={8}
          placeholder={t('prompts.form.bodyPlaceholder', {
            token: L('{{变量名}}', '{{variable}}'),
            example1: L('{{项目}}', '{{project}}'),
            example2: L('{{验证命令}}', '{{command}}')
          })}
          className={`ui-field w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 font-mono text-[12px] leading-5 text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-400 ${bodyFlash.flashClass}`}
        />
      </div>
      <div className="text-[12px] leading-5 text-zinc-500">
        {variables.length
          ? <>{t('prompts.form.detectedVars')}<span className="font-mono text-zinc-700">{variables.join(L('、', ', '))}</span></>
          : t('prompts.form.noVarsHint', { token: L('{{变量}}', '{{variables}}') })}
      </div>
      {error && <p role="alert" className="text-[12px] text-red-600">{error}</p>}
    </div>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-zinc-100 px-4 py-3">
      {template && (
        <button
          type="button"
          onClick={() => {
            if (!confirmDelete) { setConfirmDelete(true); return; }
            onDelete(template.id);
          }}
          className="flex items-center gap-1 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[12px] text-red-600 hover:bg-red-50"
        >
          <Trash2 size={12}/>
          <span>{confirmDelete ? t('prompts.form.confirmDelete') : t('common.delete')}</span>
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        className="ml-auto whitespace-nowrap rounded-lg px-3 py-1.5 text-[12px] text-zinc-600 hover:bg-zinc-100"
      >
        {t('common.cancel')}
      </button>
      <button
        type="submit"
        disabled={!title.trim() || !body.trim()}
        className="ui-press whitespace-nowrap rounded-lg bg-zinc-900 px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {t('prompts.form.saveBtn')}
      </button>
    </div>
  </form>;
}
