import { useEffect, useMemo, useState } from 'react';
import { useEventListener } from 'ahooks';
import {
  Check,
  Columns3,
  FileText,
  FolderKanban,
  LayoutGrid,
  LoaderCircle,
  MessageSquare,
  Search,
  Sparkles,
  StickyNote,
  Upload,
  X
} from 'lucide-react';
import type {
  Agent,
  AssistantTask,
  BoardColumnColor,
  BoardColumnRule,
  BoardDensity,
  BoardDropAction,
  BoardTemplate,
  BoardTemplatePayload,
  BoardViewMode,
  HydratedBoardColumn,
  Session
} from '../api';
import { AgentIcon } from '../AgentIcon';
import { AiFieldHeader, AiTextAssistControl, useAiFlash } from '../AiTextAssist';
import { ExitGate } from '../ExitGate';
import { SlidingSegmented } from '../ui-controls';
import { sessionLabel } from '../session-groups';
import { getBoardColumnColorOptions, localizeBoardColumnName, RULE_PRESETS } from './board-utils';
import { useBi, useLocale } from '../i18n';

/* ---------- 新建 / 导入看板弹窗 ---------- */

export interface CreateBoardPayload {
  name: string;
  description?: string;
  template: BoardTemplate;
  viewMode: BoardViewMode;
  density: BoardDensity;
  isDefault: boolean;
}

export function CreateBoardModal({
  open,
  busy,
  onClose,
  onCreate,
  onImport
}: {
  open: boolean;
  busy: boolean;
  onClose(): void;
  onCreate(payload: CreateBoardPayload): void;
  onImport(template: BoardTemplatePayload, name?: string, isDefault?: boolean): void;
}) {
  const L = useBi();
  const [tab, setTab] = useState<'create' | 'import'>('create');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState<BoardTemplate>('blank');
  const [viewMode, setViewMode] = useState<BoardViewMode>('lanes');
  const [density, setDensity] = useState<BoardDensity>('compact');
  const [isDefault, setIsDefault] = useState(true);
  const [importJson, setImportJson] = useState('');
  const [importError, setImportError] = useState<string>();
  const nameFlash = useAiFlash();
  const descFlash = useAiFlash();
  const [openSeq, setOpenSeq] = useState(0);

  useEffect(() => {
    if (!open) return;
    setOpenSeq(n => n + 1);
    setTab('create');
    setName('');
    setDescription('');
    setTemplate('blank');
    setViewMode('lanes');
    setDensity('compact');
    setIsDefault(true);
    setImportJson('');
    setImportError(undefined);
  }, [open]);

  useEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, { target: () => window, enable: open });

  const submitCreate = () => {
    if (!name.trim() || busy) return;
    onCreate({
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      template,
      viewMode,
      density,
      isDefault
    });
  };

  const submitImport = () => {
    if (!importJson.trim() || busy) return;
    try {
      const parsed = JSON.parse(importJson) as BoardTemplatePayload;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.columns)) {
        setImportError(L("模板 JSON 缺少 columns 数组，请粘贴由看板导出的模板。", "Template JSON is missing the columns array. Please paste an exported board template."));
        return;
      }
      setImportError(undefined);
      onImport(parsed, name.trim() || undefined, isDefault);
    } catch (err) {
      setImportError(L(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`, `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  };

  return (
    <ExitGate open={open}>
      {open ? (
        <div className="ui-overlay fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/35 p-4">
          <div role="dialog" aria-modal="true" aria-label={L("新建看板", "New Board")} className="ui-dialog w-full max-w-[520px] overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_24px_64px_rgba(15,23,42,.22)]">
            <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5">
              <div className="flex items-center gap-2">
                <h2 className="text-[15px] font-semibold text-zinc-900">{L("新建看板", "New Board")}</h2>
                <SlidingSegmented
                  role="tablist"
                  ariaLabel={L("创建方式", "Creation Mode")}
                  size="xs"
                  value={tab}
                  onChange={setTab}
                  options={[
                    { value: 'create' as const, label: L("从模板创建", "From Template") },
                    {
                      value: 'import' as const,
                      label: (
                        <>
                          <Upload size={11}/>
                          
                          {L("导入 JSON", "Import JSON")}
                        </>
                      )
                    }
                  ]}
                />
              </div>
              <button
                type="button"
                aria-label={L("关闭", "Close")}
                onClick={onClose}
                className="ui-press grid h-7 w-7 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"
              >
                <X size={16}/>
              </button>
            </div>

        <div className="max-h-[75vh] space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <AiFieldHeader
              label={L("看板名称", "Board Name")}
              htmlFor="create-board-name"
              hint={tab === 'import' ? L("（留空沿用模板名）", " (optional, defaults to template name)") : undefined}
              assist={
                <AiTextAssistControl
                  mode="title_generate"
                  variant="pill"
                  size="xs"
                  popoverSide="bottom"
                  popoverAlign="end"
                  value={name}
                  onChange={setName}
                  onFlash={nameFlash.triggerFlash}
                  resetKey={openSeq}
                  context={() => ({
                    field: L("任务看板名称", "Board name"),
                    purpose: L("简短直观的看板名称（4–16 字），体现跟踪的主题或周期", "Short, clear board name (4–24 chars) describing the focus or sprint"),
                    maxChars: 18,
                    extra: L(`模板类型：${template}${description.trim() ? `；看板说明：${description.trim()}` : ''}`, `Template: ${template}${description.trim() ? `; Description: ${description.trim()}` : ''}`)
                  })}
                  testId="board-create-name-ai"
                />
              }
            />
            <input
              id="create-board-name"
              type="text"
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && tab === 'create') submitCreate(); }}
              placeholder={L("例如：本周发布冲刺 / 重点项目盯盘 / 个人待办", "e.g., Release Sprint / Active Projects / Personal TODOs")}
              className={`ui-field mt-1.5 h-9 w-full rounded-xl border border-zinc-200 bg-white px-3 text-[13px] text-zinc-900 ${nameFlash.flashClass}`}
            />
          </div>

          {tab === 'create' ? (
            <>
              <div>
                <div className="text-[12.5px] font-medium text-zinc-700">{L("排布模板", "Layout Template")}</div>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {[
                    { key: 'blank' as const, icon: Columns3, title: L("自由定制", "Custom"), desc: L("手动拖入任意任务与会话，完全按你喜好编排", "Manually drag any tasks and sessions into custom columns") },
                    { key: 'status' as const, icon: Sparkles, title: L("运行状态", "Live Status"), desc: L("智能规则自动按待拍板 / 进行中 / 待验收分列", "Smart rules auto-sort by Needs Input / Running / Review") },
                    { key: 'project' as const, icon: FolderKanban, title: L("按项目排布", "By Project"), desc: L("自动按当前活跃工作区生成多项目盯盘列", "Auto-generate columns for each active workspace directory") }
                  ].map(opt => {
                    const active = template === opt.key;
                    const Icon = opt.icon;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => setTemplate(opt.key)}
                        className={`flex flex-col items-start rounded-xl border p-3 text-left transition-all ${
                          active
                            ? 'border-blue-500 bg-blue-50/60 ring-2 ring-blue-500/15'
                            : 'border-zinc-200 bg-white hover:border-zinc-300'
                        }`}
                      >
                        <Icon size={16} className={active ? 'text-blue-600' : 'text-zinc-500'}/>
                        <div className="mt-1.5 text-[13px] font-semibold text-zinc-900">{opt.title}</div>
                        <div className="mt-0.5 text-[11px] leading-4 text-zinc-500">{opt.desc}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[12px] font-medium text-zinc-600">{L("默认视图", "Default View")}</div>
                  <SlidingSegmented
                    ariaLabel={L("默认视图", "Default View")}
                    size="md"
                    className="mt-1.5"
                    itemClassName="px-2"
                    value={viewMode}
                    onChange={setViewMode}
                    options={[
                      { value: 'lanes' as const, label: <><Columns3 size={12}/>{L("列视图", "Columns")}</> },
                      { value: 'grid' as const, label: <><LayoutGrid size={12}/>{L("盯盘矩阵", "Matrix")}</> }
                    ]}
                  />
                </div>
                <div>
                  <div className="text-[12px] font-medium text-zinc-600">{L("卡片密度", "Card Density")}</div>
                  <SlidingSegmented
                    ariaLabel={L("卡片密度", "Card Density")}
                    size="md"
                    className="mt-1.5"
                    itemClassName="px-2"
                    value={density}
                    onChange={setDensity}
                    options={[
                      { value: 'compact' as const, label: L("紧凑盯盘", "Compact") },
                      { value: 'comfortable' as const, label: L("舒适展开", "Comfortable") }
                    ]}
                  />
                </div>
              </div>

              <div>
                <AiFieldHeader
                  label={L("简短说明", "Description")}
                  htmlFor="create-board-desc"
                  hint={L("（可选）", " (Optional)")}
                  assist={
                    <AiTextAssistControl
                      mode="description_polish"
                      variant="pill"
                      size="xs"
                      popoverSide="top"
                      popoverAlign="end"
                      value={description}
                      onChange={setDescription}
                      onFlash={descFlash.triggerFlash}
                      resetKey={openSeq}
                      context={() => ({
                        field: L("看板简短说明", "Board description"),
                        purpose: L("用一句话说明这个看板用来跟踪哪些任务或目标，不超过 50 字", "Brief one-sentence summary of what this board tracks"),
                        maxChars: 50,
                        ...(name.trim() ? { boardName: name.trim() } : {}),
                        extra: L(`排布模板：${template}`, `Layout template: ${template}`)
                      })}
                      testId="board-create-desc-ai"
                    />
                  }
                />
                <input
                  id="create-board-desc"
                  type="text"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder={L("记录这个看板用于盯哪些事项…", "Describe what this board tracks…")}
                  className={`ui-field mt-1 h-8 w-full rounded-lg border border-zinc-200 bg-white px-2.5 text-[12.5px] text-zinc-900 ${descFlash.flashClass}`}
                />
              </div>
            </>
          ) : (
            <div>
              <label className="block text-[12.5px] font-medium text-zinc-700">{L("粘贴看板模板 JSON", "Paste Board Template JSON")}</label>
              <textarea
                rows={7}
                value={importJson}
                onChange={e => setImportJson(e.target.value)}
                placeholder={L("{\n  \"version\": 1,\n  \"board\": { \"name\": \"我的模板\", ... },\n  \"columns\": [ ... ]\n}", "{\n  \"version\": 1,\n  \"board\": { \"name\": \"My Template\", ... },\n  \"columns\": [ ... ]\n}")}
                className="ui-field mt-1.5 w-full rounded-xl border border-zinc-200 bg-zinc-50 p-3 font-mono text-[12px] text-zinc-800"
              />
              {importError && <p className="mt-1.5 text-[12px] text-red-600">{importError}</p>}
            </div>
          )}

          <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-zinc-600">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={e => setIsDefault(e.target.checked)}
              className="h-4 w-4 rounded border-zinc-300"
            />
            
            {L("创建后立即切换到此看板并记忆为默认视角", "Switch to this board immediately and remember as default")}
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-200 bg-zinc-50/70 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="ui-press h-8 rounded-lg px-3 text-[12.5px] font-medium text-zinc-600 hover:bg-zinc-200/60"
          >
            
            {L("取消", "Cancel")}
          </button>
          <button
            type="button"
            disabled={busy || (tab === 'create' ? !name.trim() : !importJson.trim())}
            onClick={tab === 'create' ? submitCreate : submitImport}
            className="ui-press inline-flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-4 text-[12.5px] font-medium text-white hover:bg-zinc-700 disabled:opacity-45"
          >
            {busy && <LoaderCircle size={13} className="animate-spin"/>}
            {tab === 'create' ? L("创建看板", "Create Board") : L("导入并打开", "Import & Open")}
          </button>
        </div>
      </div>
    </div>
      ) : null}
    </ExitGate>
  );
}

/* ---------- 新建 / 编辑列弹窗 ---------- */

export interface ColumnEditorPayload {
  name: string;
  color: BoardColumnColor;
  wipLimit: number | null;
  rule: BoardColumnRule | null;
  onDropAction: BoardDropAction;
}

export function ColumnEditorModal({
  open,
  editing,
  busy,
  onClose,
  onSave
}: {
  open: boolean;
  editing: HydratedBoardColumn | null;
  busy: boolean;
  onClose(): void;
  onSave(payload: ColumnEditorPayload): void;
}) {
  const L = useBi();
  const locale = useLocale();
  const [name, setName] = useState('');
  const [color, setColor] = useState<BoardColumnColor>('zinc');
  const [wipText, setWipText] = useState('');
  const [presetId, setPresetId] = useState('manual');
  const [cwdFilter, setCwdFilter] = useState('');
  const [onDropAction, setOnDropAction] = useState<BoardDropAction>('none');

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name);
      setColor(editing.color);
      setWipText(editing.wipLimit ? String(editing.wipLimit) : '');
      setOnDropAction(editing.onDropAction);
      setCwdFilter(editing.rule?.cwdContains ?? '');
      if (!editing.rule) {
        setPresetId('manual');
      } else if (editing.rule.cwdContains && !editing.rule.taskStates?.length) {
        setPresetId('cwd');
      } else {
        const matched = RULE_PRESETS.find(
          p => p.rule && JSON.stringify(p.rule.taskStates ?? []) === JSON.stringify(editing.rule?.taskStates ?? [])
        );
        setPresetId(matched?.id ?? 'custom');
      }
    } else {
      setName('');
      setColor('blue');
      setWipText('');
      setPresetId('manual');
      setCwdFilter('');
      setOnDropAction('none');
    }
  }, [open, editing]);

  useEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, { target: () => window, enable: open });

  const submit = () => {
    if (!name.trim() || busy) return;
    let rule: BoardColumnRule | null = null;
    if (presetId === 'cwd') {
      rule = cwdFilter.trim() ? { entityKinds: ['task', 'session'], cwdContains: cwdFilter.trim() } : null;
    } else if (presetId === 'custom' && editing?.rule) {
      rule = editing.rule;
    } else {
      const preset = RULE_PRESETS.find(p => p.id === presetId);
      rule = preset?.rule ?? null;
    }
    const wipNum = Number(wipText);
    const wipLimit = wipText.trim() && Number.isFinite(wipNum) && wipNum > 0 ? Math.floor(wipNum) : null;
    onSave({ name: name.trim(), color, wipLimit, rule, onDropAction });
  };

  return (
    <ExitGate open={open}>
      {open ? (
        <div className="ui-overlay fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/35 p-4">
          <div role="dialog" aria-modal="true" aria-label={editing ? L("编辑列", "Edit Column") : L("新建列", "Add Column")} className="ui-dialog w-full max-w-[480px] overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_24px_64px_rgba(15,23,42,.22)]">
            <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5">
              <h2 className="text-[15px] font-semibold text-zinc-900">{editing ? L(`编辑列「${editing.name}」`, `Edit Column "${editing.name}"`) : L("新建自定义列", "New Custom Column")}</h2>
              <button type="button" aria-label={L("关闭", "Close")} onClick={onClose} className="ui-press grid h-7 w-7 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800">
                <X size={16}/>
              </button>
            </div>

        <div className="max-h-[75vh] space-y-4 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_110px]">
            <div>
              <label className="block text-[12px] font-medium text-zinc-600">{L("列名称", "Column Name")}</label>
              <input
                type="text"
                autoFocus
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                placeholder={L("例如：高优阻塞 / 待回归 / 前端联调", "e.g., Blockers / Regression / Frontend Sync")}
                className="ui-field mt-1 h-9 w-full rounded-xl border border-zinc-200 bg-white px-3 text-[13px] text-zinc-900"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-zinc-600">{L("WIP 上限", "WIP Limit")}</label>
              <input
                type="number"
                min={0}
                value={wipText}
                onChange={e => setWipText(e.target.value)}
                placeholder={L("不限", "None")}
                className="ui-field mt-1 h-9 w-full rounded-xl border border-zinc-200 bg-white px-3 text-[13px] text-zinc-900"
              />
            </div>
          </div>

          <div>
            <div className="text-[12px] font-medium text-zinc-600">{L("列色标", "Color")}</div>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {getBoardColumnColorOptions(locale).map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setColor(opt.value)}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors ${
                    color === opt.value
                      ? 'border-zinc-900 bg-zinc-900 text-white'
                      : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
                  }`}
                >
                  <span className={`h-2.5 w-2.5 rounded-full ${opt.swatch}`}/>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[12px] font-medium text-zinc-600">{L("汇聚方式（手动列 / 智能规则列）", "Card Routing (Manual / Smart Rule)")}</div>
            <div className="mt-1.5 space-y-1.5">
              {RULE_PRESETS.map(preset => {
                const active = presetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => {
                      setPresetId(preset.id);
                      if (!editing && !name.trim() && preset.id !== 'manual') setName(preset.label.split('（')[0]!);
                      if (!editing) setColor(preset.color);
                    }}
                    className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors ${
                      active ? 'border-blue-500 bg-blue-50/50' : 'border-zinc-200 bg-white hover:bg-zinc-50'
                    }`}
                  >
                    <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border ${active ? 'border-blue-500 bg-blue-500 text-white' : 'border-zinc-300'}`}>
                      {active && <Check size={10} strokeWidth={3}/>}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12.5px] font-medium text-zinc-900">{preset.label}</div>
                      <div className="text-[11px] text-zinc-500">{preset.desc}</div>
                    </div>
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setPresetId('cwd')}
                className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors ${
                  presetId === 'cwd' ? 'border-blue-500 bg-blue-50/50' : 'border-zinc-200 bg-white hover:bg-zinc-50'
                }`}
              >
                <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border ${presetId === 'cwd' ? 'border-blue-500 bg-blue-500 text-white' : 'border-zinc-300'}`}>
                  {presetId === 'cwd' && <Check size={10} strokeWidth={3}/>}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-medium text-zinc-900">{L("按项目工作目录自动汇聚", "Auto-group by Workspace Path")}</div>
                  <div className="text-[11px] text-zinc-500">{L("自动收入指定路径前缀下的全部任务与会话", "Automatically include all tasks and sessions matching this path prefix")}</div>
                </div>
              </button>
              {presetId === 'cwd' && (
                <input
                  type="text"
                  value={cwdFilter}
                  onChange={e => setCwdFilter(e.target.value)}
                  placeholder="/Users/.../workspace/my-project"
                  className="ui-field h-8 w-full rounded-lg border border-zinc-200 bg-white px-3 font-mono text-[12px] text-zinc-800"
                />
              )}
            </div>
          </div>

          <div>
            <label className="block text-[12px] font-medium text-zinc-600">{L("拖入此列时联动动作", "Action on Card Drop")}</label>
            <select
              value={onDropAction}
              onChange={e => setOnDropAction(e.target.value as BoardDropAction)}
              className="ui-field mt-1 h-9 w-full rounded-xl border border-zinc-200 bg-white px-3 text-[12.5px] text-zinc-800"
            >
              <option value="none">{L("无副作用（纯视觉归类，最安全）", "None (visual grouping only, safest)")}</option>
              <option value="start_plan">{L("拖入计划中便签时自动开始执行", "Auto-start planned notes dropped here")}</option>
              <option value="prompt_kitten">{L("通知主小猫关注此列的新卡片", "Notify companion about new cards here")}</option>
              <option value="archive_session">{L("拖入普通会话时同步归档", "Archive regular sessions dropped here")}</option>
            </select>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-200 bg-zinc-50/70 px-5 py-3">
          <button type="button" onClick={onClose} className="ui-press h-8 rounded-lg px-3 text-[12.5px] font-medium text-zinc-600 hover:bg-zinc-200/60">
            
            {L("取消", "Cancel")}
          </button>
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={submit}
            className="ui-press inline-flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-4 text-[12.5px] font-medium text-white hover:bg-zinc-700 disabled:opacity-45"
          >
            {busy && <LoaderCircle size={13} className="animate-spin"/>}
            {editing ? L("保存列设置", "Save Column") : L("添加列", "Add Column")}
          </button>
        </div>
      </div>
    </div>
      ) : null}
    </ExitGate>
  );
}

/* ---------- 向列添加卡片弹窗（轻量便签 / 现有任务 / 现有会话） ---------- */

export function AddCardModal({
  open,
  column,
  sessions,
  tasks,
  agents,
  busy,
  onClose,
  onAddNote,
  onAddEntity
}: {
  open: boolean;
  column: HydratedBoardColumn | null;
  sessions: Session[];
  tasks: AssistantTask[];
  agents: Agent[];
  busy: boolean;
  onClose(): void;
  onAddNote(input: { columnId: string; title: string; tags: string[]; pinned: boolean }): void;
  onAddEntity(input: { columnId: string; entityKind: 'task' | 'session'; entityId: string }): void;
}) {
  const L = useBi();
  const locale = useLocale();
  const [tab, setTab] = useState<'note' | 'task' | 'session'>('note');
  const [noteTitle, setNoteTitle] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [pinned, setPinned] = useState(false);
  const [search, setSearch] = useState('');
  const noteFlash = useAiFlash();
  const [addOpenSeq, setAddOpenSeq] = useState(0);

  useEffect(() => {
    if (!open) return;
    setAddOpenSeq(n => n + 1);
    setTab('note');
    setNoteTitle('');
    setTagsText('');
    setPinned(false);
    setSearch('');
  }, [open]);

  useEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, { target: () => window, enable: open });

  const filteredTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks
      .filter(t => !t.archivedAt)
      .filter(t => !q || t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q))
      .slice(0, 30);
  }, [tasks, search]);

  const filteredSessions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sessions
      .filter(s => !s.archivedAt)
      .filter(s => {
        if (!q) return true;
        const label = sessionLabel(s, agents.find(a => a.id === s.agentId)?.name);
        return label.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q) || s.id.toLowerCase().includes(q);
      })
      .slice(0, 30);
  }, [sessions, agents, search]);

  const submitNote = () => {
    if (!column || !noteTitle.trim() || busy) return;
    const tags = tagsText.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
    onAddNote({ columnId: column.id, title: noteTitle.trim(), tags, pinned });
  };

  return (
    <ExitGate open={open && Boolean(column)}>
      {open && column ? (
        <div className="ui-overlay fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/35 p-4">
          <div role="dialog" aria-modal="true" aria-label={L(`向「${localizeBoardColumnName(column.name, locale)}」添加卡片`, `Add card to "${localizeBoardColumnName(column.name, locale)}"`)} className="ui-dialog w-full max-w-[480px] overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_24px_64px_rgba(15,23,42,.22)]">
            <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5">
              <h2 className="truncate text-[14.5px] font-semibold text-zinc-900">{L(`添加到「${localizeBoardColumnName(column.name, locale)}」`, `Add to "${localizeBoardColumnName(column.name, locale)}"`)}</h2>
              <button type="button" aria-label={L("关闭", "Close")} onClick={onClose} className="ui-press grid h-7 w-7 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800">
                <X size={16}/>
              </button>
            </div>

            <div className="border-b border-zinc-200 px-5 py-2.5">
              <SlidingSegmented
                role="tablist"
                ariaLabel={L("卡片来源", "Card Source")}
                size="md"
                value={tab}
                onChange={setTab}
                itemClassName="px-2"
                options={[
                  { value: 'note' as const, label: <><FileText size={12}/>{L("快速文字卡", "Quick Note")}</> },
                  { value: 'task' as const, label: <><StickyNote size={12}/>{L("小猫便签", "Sticky Note")}</> },
                  { value: 'session' as const, label: <><MessageSquare size={12}/>{L("普通会话", "Session")}</> }
                ]}
              />
            </div>

        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          {tab === 'note' ? (
            <div className="space-y-3">
              <div>
                <AiFieldHeader
                  label={L("卡片内容", "Card Content")}
                  htmlFor="add-board-card-note"
                  assist={
                    <AiTextAssistControl
                      mode="description_polish"
                      variant="pill"
                      size="xs"
                      popoverSide="bottom"
                      popoverAlign="end"
                      value={noteTitle}
                      onChange={setNoteTitle}
                      onFlash={noteFlash.triggerFlash}
                      resetKey={`${column.id}:${addOpenSeq}`}
                      context={() => ({
                        field: L("看板快速文字卡内容", "Quick card content"),
                        purpose: L("清晰具体地记录一个想法、待办事项或验收要点，后续可直接拖给主小猫执行", "Capture a clear idea, TODO, or acceptance item you can drag to the companion later"),
                        columnName: column.name,
                        ...(tagsText.trim() ? { extra: L(`标签：${tagsText.trim()}`, `Tags: ${tagsText.trim()}`) } : {})
                      })}
                      testId="board-add-card-note-ai"
                    />
                  }
                />
                <textarea
                  id="add-board-card-note"
                  rows={3}
                  autoFocus
                  value={noteTitle}
                  onChange={e => setNoteTitle(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitNote(); }}
                  placeholder={L("记一个想法、待办或临时追踪项（后续可随时拖给主小猫执行）…", "Capture an idea, TODO, or item to track (drag to companion anytime)…")}
                  className={`ui-field mt-1 w-full rounded-xl border border-zinc-200 bg-white p-2.5 text-[13px] text-zinc-900 ${noteFlash.flashClass}`}
                />
              </div>
              <div>
                <label className="block text-[12px] font-medium text-zinc-600">{L("标签（逗号或空格分隔，可选）", "Tags (comma or space separated, optional)")}</label>
                <input
                  type="text"
                  value={tagsText}
                  onChange={e => setTagsText(e.target.value)}
                  placeholder={L("例如：P0 发布 前端", "e.g., P0 release frontend")}
                  className="ui-field mt-1 h-8 w-full rounded-lg border border-zinc-200 bg-white px-2.5 text-[12.5px] text-zinc-900"
                />
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-zinc-600">
                <input type="checkbox" checked={pinned} onChange={e => setPinned(e.target.checked)} className="h-4 w-4 rounded border-zinc-300"/>
                
                {L("置顶到列首", "Pin to top")}
              </label>
              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  disabled={busy || !noteTitle.trim()}
                  onClick={submitNote}
                  className="ui-press inline-flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-4 text-[12.5px] font-medium text-white hover:bg-zinc-700 disabled:opacity-45"
                >
                  {busy && <LoaderCircle size={13} className="animate-spin"/>}
                  
                  {L("添加卡片", "Add Card")}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2.5">
              <div className="ui-field-within flex h-8 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2.5">
                <Search size={13} className="text-zinc-400"/>
                <input
                  type="text"
                  autoFocus
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={tab === 'task' ? L("搜索主小猫便签标题…", "Search sticky notes…") : L("搜索会话标题或工作区…", "Search sessions or workspaces…")}
                  className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-zinc-900 placeholder:text-zinc-400"
                />
              </div>

              {tab === 'task' ? (
                filteredTasks.length ? (
                  <div className="space-y-1">
                    {filteredTasks.map(task => (
                      <button
                        key={task.id}
                        type="button"
                        disabled={busy}
                        onClick={() => onAddEntity({ columnId: column.id, entityKind: 'task', entityId: task.id })}
                        className="flex w-full items-center gap-2.5 rounded-xl border border-zinc-200/80 px-3 py-2 text-left transition-colors hover:bg-zinc-50 disabled:opacity-50"
                      >
                        <AgentIcon agentId={task.agentId ?? 'claude'} size={15}/>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium text-zinc-900">{task.title}</div>
                          <div className="truncate text-[11px] text-zinc-500">{task.state} · {task.id}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="py-6 text-center text-[12.5px] text-zinc-400">{L("暂无可添加的便签", "No sticky notes available")}</p>
                )
              ) : (
                filteredSessions.length ? (
                  <div className="space-y-1">
                    {filteredSessions.map(session => {
                      const agent = agents.find(a => a.id === session.agentId);
                      return (
                        <button
                          key={session.id}
                          type="button"
                          disabled={busy}
                          onClick={() => onAddEntity({ columnId: column.id, entityKind: 'session', entityId: session.id })}
                          className="flex w-full items-center gap-2.5 rounded-xl border border-zinc-200/80 px-3 py-2 text-left transition-colors hover:bg-zinc-50 disabled:opacity-50"
                        >
                          <AgentIcon agentId={session.agentId} agentName={agent?.name} size={15}/>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-medium text-zinc-900">{sessionLabel(session, agent?.name)}</div>
                            <div className="truncate text-[11px] text-zinc-500">{session.state} · {session.cwd}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="py-6 text-center text-[12.5px] text-zinc-400">{L("暂无可添加的会话", "No sessions available")}</p>
                )
              )}
            </div>
          )}
        </div>
      </div>
    </div>
      ) : null}
    </ExitGate>
  );
}
