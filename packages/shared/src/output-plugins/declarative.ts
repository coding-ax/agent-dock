import { z } from 'zod';
import {
  OUTPUT_PLUGIN_INTERACTION_ORIGIN_PREFIX,
  declarativeActionStyles,
  declarativeFieldTypes,
  declarativeOutputPluginManifestSchema,
  outputPluginAccentTones,
  outputPluginInteractionSources,
  type DeclarativeActionStyle,
  type DeclarativeFieldType,
  type DeclarativeOutputPluginManifest,
  type OutputPluginAccentTone,
  type OutputPluginDefinition,
  type OutputPluginParseResult,
  type OutputPluginSource,
  type OutputPluginStreamingSplit
} from './types.js';
import {
  decodeXmlEntities,
  detectPendingStreamingXmlTag,
  extractTrailingXmlBlock,
  fnv1aHex,
  parseBooleanAttr,
  parseBooleanLike,
  parseJsonBodyCandidate,
  parseXmlAttributes
} from './xml-utils.js';

export interface DeclarativeSpecFieldOption {
  value: string;
  label: string;
}

export interface DeclarativeSpecField {
  name: string;
  label: string;
  value?: string;
  type: DeclarativeFieldType;
  placeholder?: string;
  required: boolean;
  options: DeclarativeSpecFieldOption[];
}

export interface DeclarativeSpecAction {
  value: string;
  label: string;
  style: DeclarativeActionStyle;
  description?: string;
}

export interface DeclarativeSpecLink {
  label: string;
  href: string;
}

export interface DeclarativeOutputPluginSpec {
  id: string;
  kind: DeclarativeOutputPluginManifest['kind'];
  title?: string;
  summary?: string;
  status?: string;
  tone: OutputPluginAccentTone;
  fields: DeclarativeSpecField[];
  actions: DeclarativeSpecAction[];
  links: DeclarativeSpecLink[];
  allowNote: boolean;
  notePlaceholder?: string;
  submitLabel: string;
}

export const declarativeInteractionFieldSchema = z.object({
  name: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(200),
  value: z.string().max(4_000),
  displayValue: z.string().max(4_000).optional()
});

export type DeclarativeInteractionField = z.infer<typeof declarativeInteractionFieldSchema>;

export const declarativeOutputPluginInteractionSchema = z.object({
  version: z.literal(1),
  pluginId: z.string().trim().min(1).max(120),
  pluginName: z.string().trim().max(120).optional(),
  instanceId: z.string().trim().min(1).max(200),
  title: z.string().trim().max(300).optional(),
  source: z.enum(outputPluginInteractionSources),
  actedBy: z.string().trim().max(200).optional(),
  responderName: z.string().trim().max(200).optional(),
  responderSessionId: z.string().trim().max(200).optional(),
  actedAt: z.string().min(1),
  actionValue: z.string().trim().max(200).optional(),
  actionLabel: z.string().trim().max(200).optional(),
  fields: z.array(declarativeInteractionFieldSchema).default([]),
  note: z.string().trim().max(4_000).optional()
});

export type DeclarativeOutputPluginInteractionPayload = z.infer<typeof declarativeOutputPluginInteractionSchema>;

export function declarativePluginInteractionOrigin(pluginId: string): string {
  return `${OUTPUT_PLUGIN_INTERACTION_ORIGIN_PREFIX}${pluginId}`;
}

function normalizeTone(raw: string | undefined, fallback: OutputPluginAccentTone): OutputPluginAccentTone {
  const candidate = raw?.trim().toLowerCase();
  if (candidate && (outputPluginAccentTones as readonly string[]).includes(candidate)) {
    return candidate as OutputPluginAccentTone;
  }
  return fallback;
}

function normalizeActionStyle(raw: string | undefined, fallback: DeclarativeActionStyle = 'default'): DeclarativeActionStyle {
  const candidate = raw?.trim().toLowerCase();
  if (candidate && (declarativeActionStyles as readonly string[]).includes(candidate)) {
    return candidate as DeclarativeActionStyle;
  }
  return fallback;
}

function normalizeFieldType(raw: string | undefined): DeclarativeFieldType {
  const candidate = raw?.trim().toLowerCase();
  if (candidate && (declarativeFieldTypes as readonly string[]).includes(candidate)) {
    return candidate as DeclarativeFieldType;
  }
  return 'text';
}

function parseFieldOptions(raw: string | undefined): DeclarativeSpecFieldOption[] {
  if (!raw?.trim()) return [];
  const options: DeclarativeSpecFieldOption[] = [];
  const seen = new Set<string>();
  for (const segment of raw.split(/[,;\n]+/)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    const value = (colon >= 0 ? trimmed.slice(0, colon) : trimmed).trim();
    const label = (colon >= 0 ? trimmed.slice(colon + 1) : trimmed).trim() || value;
    if (!value || seen.has(value)) continue;
    seen.add(value);
    options.push({ value, label });
  }
  return options;
}

function isSafeLinkHref(href: string): boolean {
  const trimmed = href.trim().toLowerCase();
  return trimmed.startsWith('https://') || trimmed.startsWith('http://') || trimmed.startsWith('/');
}

export function buildDefaultDeclarativeProtocolExample(manifest: DeclarativeOutputPluginManifest): string {
  const tag = manifest.tagName;
  if (manifest.kind === 'action-card') {
    const actions = manifest.card?.actions?.length
      ? manifest.card.actions
      : [
          { value: 'approve', label: '确认执行', style: 'primary' as const },
          { value: 'cancel', label: '取消', style: 'danger' as const }
        ];
    const actionLines = actions
      .map(action => `  <action value="${action.value}" style="${action.style}">${action.label}</action>`)
      .join('\n');
    return `<${tag} id="action_1" title="${manifest.card?.headerTitle || manifest.name}">\n  <summary>简短说明当前待确认事项</summary>\n  <field label="目标">示例值</field>\n${actionLines}\n</${tag}>`;
  }
  if (manifest.kind === 'form-card') {
    return `<${tag} id="form_1" title="${manifest.card?.headerTitle || manifest.name}">\n  <summary>请补充以下参数</summary>\n  <field name="env" label="目标环境" type="select" required="true" options="staging:预发,prod:生产"/>\n  <field name="note" label="备注说明" type="textarea" placeholder="可选补充"/>\n</${tag}>`;
  }
  return `<${tag} id="info_1" title="${manifest.card?.headerTitle || manifest.name}" status="READY">\n  <summary>结构化结果摘要</summary>\n  <field label="条目">示例内容</field>\n  <link label="查看详情" href="https://example.com"/>\n</${tag}>`;
}

export function buildDefaultDeclarativePromptInstruction(manifest: DeclarativeOutputPluginManifest): string {
  const example = manifest.protocolExample?.trim() || buildDefaultDeclarativeProtocolExample(manifest);
  return `[AgentDock 交互插件协议：${manifest.name}]
用途：${manifest.description}
仅在真正需要触发「${manifest.name}」卡片时，才在回复**最末尾**附带一个裸 \`<${manifest.tagName}>\` XML 块（不要放进 Markdown 代码块，也不要在正文中复述协议语法）：
${example}`;
}

function readNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

function parseDeclarativeJsonSpec(
  manifest: DeclarativeOutputPluginManifest,
  rootAttrs: Record<string, string>,
  json: Record<string, unknown>,
  rawXml: string
): DeclarativeOutputPluginSpec | null {
  const defaults = manifest.card;
  const fallbackTone: OutputPluginAccentTone = defaults?.accentTone ?? 'sky';
  const title = readNonEmptyString(json.title, rootAttrs.title, defaults?.headerTitle);
  const summary = readNonEmptyString(json.summary, json.description, rootAttrs.summary);
  const status = readNonEmptyString(json.status, rootAttrs.status);
  const tone = normalizeTone(readNonEmptyString(json.tone, rootAttrs.tone), fallbackTone);

  const fields: DeclarativeSpecField[] = [];
  const seenFieldNames = new Set<string>();
  const rawFields = json.fields;
  if (Array.isArray(rawFields)) {
    rawFields.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
      const rec = entry as Record<string, unknown>;
      const label = readNonEmptyString(rec.label, rec.name, rec.key) ?? '';
      const value = readNonEmptyString(rec.value, rec.text, rec.defaultValue);
      if (!label && !value) return;
      let name = readNonEmptyString(rec.name, rec.key) ?? `field_${index + 1}`;
      if (seenFieldNames.has(name)) {
        let suffix = 2;
        while (seenFieldNames.has(`${name}_${suffix}`)) suffix++;
        name = `${name}_${suffix}`;
      }
      seenFieldNames.add(name);
      const rawOptions = Array.isArray(rec.options)
        ? rec.options.flatMap((opt): DeclarativeSpecFieldOption[] => {
            if (typeof opt === 'string') {
              const t = opt.trim();
              return t ? [{ value: t, label: t }] : [];
            }
            if (!opt || typeof opt !== 'object' || Array.isArray(opt)) return [];
            const o = opt as Record<string, unknown>;
            const optVal = readNonEmptyString(o.value, o.id, o.label);
            const optLabel = readNonEmptyString(o.label, o.text, optVal);
            return optVal && optLabel ? [{ value: optVal, label: optLabel }] : [];
          })
        : typeof rec.options === 'string'
          ? parseFieldOptions(rec.options)
          : [];
      const placeholder = readNonEmptyString(rec.placeholder);
      fields.push({
        name,
        label: label || name,
        ...(value !== undefined ? { value } : {}),
        type: normalizeFieldType(readNonEmptyString(rec.type)),
        ...(placeholder ? { placeholder } : {}),
        required: parseBooleanLike(rec.required, false),
        options: rawOptions
      });
    });
  }

  const actions: DeclarativeSpecAction[] = [];
  const seenActionValues = new Set<string>();
  if (Array.isArray(json.actions)) {
    for (const entry of json.actions) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const rec = entry as Record<string, unknown>;
      const label = readNonEmptyString(rec.label, rec.text, rec.title) ?? '';
      const rawValue = readNonEmptyString(rec.value, rec.id, label) ?? '';
      if (!label && !rawValue) continue;
      let value = rawValue || label;
      if (seenActionValues.has(value)) {
        let suffix = 2;
        while (seenActionValues.has(`${value}_${suffix}`)) suffix++;
        value = `${value}_${suffix}`;
      }
      seenActionValues.add(value);
      const description = readNonEmptyString(rec.description, rec.desc);
      actions.push({
        value,
        label: label || value,
        style: normalizeActionStyle(readNonEmptyString(rec.style)),
        ...(description ? { description } : {})
      });
    }
  }
  if (!actions.length && manifest.kind === 'action-card') {
    const presets = defaults?.actions?.length
      ? defaults.actions
      : [
          { value: 'confirm', label: '确认', style: 'primary' as const },
          { value: 'cancel', label: '取消', style: 'default' as const }
        ];
    for (const preset of presets) {
      actions.push({
        value: preset.value,
        label: preset.label,
        style: preset.style,
        ...(preset.description ? { description: preset.description } : {})
      });
    }
  }

  const links: DeclarativeSpecLink[] = [];
  if (Array.isArray(json.links)) {
    for (const entry of json.links) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const rec = entry as Record<string, unknown>;
      const href = readNonEmptyString(rec.href, rec.url) ?? '';
      const label = readNonEmptyString(rec.label, rec.title, href) ?? '';
      if (!href || !isSafeLinkHref(href)) continue;
      links.push({ label, href });
    }
  }

  if (manifest.kind === 'form-card' && fields.length === 0) return null;
  if (manifest.kind === 'action-card' && actions.length === 0) return null;
  if (manifest.kind === 'info-card' && !title && !summary && fields.length === 0 && links.length === 0) return null;

  const allowNote = parseBooleanLike(
    json.allowNote ?? json.allow_note ?? json['allow-note'] ?? rootAttrs['allow-note'] ?? rootAttrs.allowNote,
    defaults?.allowNote ?? false
  );
  const notePlaceholder = readNonEmptyString(
    json.notePlaceholder,
    json.note_placeholder,
    json['note-placeholder'],
    rootAttrs['note-placeholder'],
    rootAttrs.notePlaceholder,
    defaults?.notePlaceholder
  );
  const submitLabel = readNonEmptyString(
    json.submitLabel,
    json.submit_label,
    json['submit-label'],
    rootAttrs['submit-label'],
    rootAttrs.submitLabel,
    defaults?.submitLabel
  ) ?? '提交';
  const id = readNonEmptyString(json.id, json.instanceId, json.instance_id, rootAttrs.id)
    ?? `${manifest.tagName}_${fnv1aHex(rawXml.trim())}`;

  return {
    id,
    kind: manifest.kind,
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(status ? { status } : {}),
    tone,
    fields,
    actions,
    links,
    allowNote,
    ...(notePlaceholder ? { notePlaceholder } : {}),
    submitLabel
  };
}

function parseDeclarativeSpec(
  manifest: DeclarativeOutputPluginManifest,
  rootAttrs: Record<string, string>,
  innerXml: string,
  rawXml: string
): DeclarativeOutputPluginSpec | null {
  const defaults = manifest.card;
  const fallbackTone: OutputPluginAccentTone = defaults?.accentTone ?? 'sky';
  const title = rootAttrs.title?.trim() || defaults?.headerTitle?.trim() || undefined;
  const status = rootAttrs.status?.trim() || undefined;
  const tone = normalizeTone(rootAttrs.tone, fallbackTone);

  // 先剥除子块，避免 summary 误抓其他标签内部文本
  const withoutChildren = innerXml
    .replace(/<field\b[^>]*>[\s\S]*?<\/field>/gi, '')
    .replace(/<field\b[^>]*\/>/gi, '')
    .replace(/<action\b[^>]*>[\s\S]*?<\/action>/gi, '')
    .replace(/<link\b[^>]*>[\s\S]*?<\/link>/gi, '')
    .replace(/<link\b[^>]*\/>/gi, '');
  const summaryMatch = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(withoutChildren);
  const summary = (summaryMatch ? decodeXmlEntities(summaryMatch[1] ?? '').trim() : '')
    || rootAttrs.summary?.trim()
    || undefined;

  const fields: DeclarativeSpecField[] = [];
  const seenFieldNames = new Set<string>();
  const fieldPattern = /<field\b([^>]*?)(?:\/>|>([\s\S]*?)<\/field>)/gi;
  let fieldMatch: RegExpExecArray | null;
  let fieldIndex = 0;
  while ((fieldMatch = fieldPattern.exec(innerXml)) !== null) {
    const attrs = parseXmlAttributes(fieldMatch[1] ?? '');
    const bodyText = decodeXmlEntities(fieldMatch[2] ?? '').trim();
    const label = (attrs.label ?? attrs.name ?? '').trim();
    if (!label && !bodyText) continue;
    let name = (attrs.name ?? `field_${fieldIndex + 1}`).trim() || `field_${fieldIndex + 1}`;
    if (seenFieldNames.has(name)) {
      let suffix = 2;
      while (seenFieldNames.has(`${name}_${suffix}`)) suffix++;
      name = `${name}_${suffix}`;
    }
    seenFieldNames.add(name);
    const type = normalizeFieldType(attrs.type);
    const value = (bodyText || attrs.value?.trim() || undefined);
    const placeholder = attrs.placeholder?.trim() || undefined;
    const required = parseBooleanAttr(attrs.required, false);
    const options = parseFieldOptions(attrs.options);
    fields.push({
      name,
      label: label || name,
      ...(value !== undefined ? { value } : {}),
      type,
      ...(placeholder ? { placeholder } : {}),
      required,
      options
    });
    fieldIndex++;
  }

  const actions: DeclarativeSpecAction[] = [];
  const seenActionValues = new Set<string>();
  const actionPattern = /<action\b([^>]*)>([\s\S]*?)<\/action>/gi;
  let actionMatch: RegExpExecArray | null;
  while ((actionMatch = actionPattern.exec(innerXml)) !== null) {
    const attrs = parseXmlAttributes(actionMatch[1] ?? '');
    const label = decodeXmlEntities(actionMatch[2] ?? '').trim();
    const rawValue = (attrs.value ?? label).trim();
    if (!label && !rawValue) continue;
    let value = rawValue || label;
    if (seenActionValues.has(value)) {
      let suffix = 2;
      while (seenActionValues.has(`${value}_${suffix}`)) suffix++;
      value = `${value}_${suffix}`;
    }
    seenActionValues.add(value);
    const description = attrs.description?.trim() || undefined;
    actions.push({
      value,
      label: label || value,
      style: normalizeActionStyle(attrs.style),
      ...(description ? { description } : {})
    });
  }

  const links: DeclarativeSpecLink[] = [];
  const linkPattern = /<link\b([^>]*?)(?:\/>|>([\s\S]*?)<\/link>)/gi;
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = linkPattern.exec(innerXml)) !== null) {
    const attrs = parseXmlAttributes(linkMatch[1] ?? '');
    const href = (attrs.href ?? '').trim();
    const label = (decodeXmlEntities(linkMatch[2] ?? '').trim() || attrs.label?.trim() || href);
    if (!href || !isSafeLinkHref(href)) continue;
    links.push({ label, href });
  }

  if (!summaryMatch && fields.length === 0 && actions.length === 0 && links.length === 0) {
    const jsonBody = parseJsonBodyCandidate(innerXml);
    if (jsonBody) {
      return parseDeclarativeJsonSpec(manifest, rootAttrs, jsonBody, rawXml);
    }
  }

  if (!actions.length && manifest.kind === 'action-card') {
    const presets = defaults?.actions?.length
      ? defaults.actions
      : [
          { value: 'confirm', label: '确认', style: 'primary' as const },
          { value: 'cancel', label: '取消', style: 'default' as const }
        ];
    for (const preset of presets) {
      actions.push({
        value: preset.value,
        label: preset.label,
        style: preset.style,
        ...(preset.description ? { description: preset.description } : {})
      });
    }
  }

  // 基础完整性校验：避免把空标签当有效卡片
  if (manifest.kind === 'form-card' && fields.length === 0) return null;
  if (manifest.kind === 'action-card' && actions.length === 0) return null;
  if (manifest.kind === 'info-card' && !title && !summary && fields.length === 0 && links.length === 0) return null;

  const allowNote = parseBooleanAttr(
    rootAttrs['allow-note'] ?? rootAttrs.allowNote,
    defaults?.allowNote ?? false
  );
  const notePlaceholder = (rootAttrs['note-placeholder'] ?? rootAttrs.notePlaceholder)?.trim()
    || defaults?.notePlaceholder
    || undefined;
  const submitLabel = (rootAttrs['submit-label'] ?? rootAttrs.submitLabel)?.trim()
    || defaults?.submitLabel
    || '提交';
  const id = rootAttrs.id?.trim() || `${manifest.tagName}_${fnv1aHex(rawXml.trim())}`;

  return {
    id,
    kind: manifest.kind,
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(status ? { status } : {}),
    tone,
    fields,
    actions,
    links,
    allowNote,
    ...(notePlaceholder ? { notePlaceholder } : {}),
    submitLabel
  };
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => vars[key] ?? '');
}

export function formatDeclarativeInteractionForAgent(
  manifest: DeclarativeOutputPluginManifest,
  payload: DeclarativeOutputPluginInteractionPayload
): string {
  const isAssistant = payload.source === 'assistant';
  const responder = payload.responderName?.trim() || payload.actedBy?.trim();
  const sourceLabel = isAssistant ? '小猫代答' : payload.source === 'lark' ? '飞书' : '网页端';
  const actorSuffix = responder ? ` · ${responder}` : '';
  const fieldsSummary = payload.fields.length
    ? payload.fields.map(field => `- ${field.label}：${field.displayValue || field.value}`).join('\n')
    : '';

  if (manifest.responseTemplate?.trim()) {
    return renderTemplate(manifest.responseTemplate.trim(), {
      pluginId: manifest.id,
      pluginName: manifest.name,
      instanceId: payload.instanceId,
      title: payload.title ?? manifest.name,
      source: sourceLabel,
      actedBy: responder ?? '',
      actionValue: payload.actionValue ?? '',
      actionLabel: payload.actionLabel ?? payload.actionValue ?? '',
      fieldsSummary,
      note: payload.note ?? ''
    }).trim();
  }

  const titlePart = payload.title?.trim() ? `「${payload.title.trim()}」` : `「${manifest.name}」`;
  const lines: string[] = [
    isAssistant
      ? `主会话小猫${responder ? `（${responder}）` : ''}已在${titlePart}交互卡片中代用户完成操作（来源：${sourceLabel}${actorSuffix}）：`
      : `用户已在${titlePart}交互卡片中完成操作（来源：${sourceLabel}${actorSuffix}）：`
  ];
  if (payload.actionLabel || payload.actionValue) {
    const label = payload.actionLabel || payload.actionValue!;
    const suffix = payload.actionValue && payload.actionValue !== label ? ` (${payload.actionValue})` : '';
    lines.push(`- 操作：${label}${suffix}`);
  }
  if (fieldsSummary) {
    lines.push(fieldsSummary);
  }
  if (payload.note?.trim()) {
    lines.push(`- 补充说明：${payload.note.trim()}`);
  }
  lines.push('');
  lines.push(
    isAssistant
      ? '请基于以上主会话代答的操作结果继续执行下一步。'
      : '请基于以上用户的明确操作继续执行下一步。'
  );
  return lines.join('\n');
}

export function summarizeDeclarativeInteraction(
  manifest: DeclarativeOutputPluginManifest,
  payload: DeclarativeOutputPluginInteractionPayload
): string {
  const parts: string[] = [];
  if (payload.actionLabel || payload.actionValue) parts.push(payload.actionLabel || payload.actionValue!);
  for (const field of payload.fields) {
    const val = (field.displayValue || field.value).trim();
    if (val) parts.push(`${field.label}=${val}`);
  }
  if (payload.note?.trim()) parts.push(payload.note.trim());
  const prefix = payload.source === 'assistant'
    ? (payload.title?.trim() ? `小猫已代答「${payload.title.trim()}」` : `小猫已代答「${manifest.name}」`)
    : (payload.title?.trim() ? `已响应「${payload.title.trim()}」` : `已响应「${manifest.name}」`);
  if (!parts.length) return prefix;
  const full = `${prefix}：${parts.join(' / ')}`;
  return full.length > 80 ? `${full.slice(0, 79)}…` : full;
}

export function parseDeclarativeInteraction(raw: string | null | undefined): DeclarativeOutputPluginInteractionPayload | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = declarativeOutputPluginInteractionSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * 声明式纯 XML 交互插件工厂：
 * 给定一份经 Zod 校验的 JSON 清单，自动生成完整插件定义（含代码围栏免疫解析、流式占位、
 * Web/飞书双端自动渲染元数据、交互序列化与时间线搜索索引），无需手写任何业务代码。
 */
export function createDeclarativeOutputPlugin(
  rawManifest: DeclarativeOutputPluginManifest,
  options: { source?: OutputPluginSource; sourcePath?: string } = {}
): OutputPluginDefinition<DeclarativeOutputPluginSpec, DeclarativeOutputPluginInteractionPayload> {
  const manifest = declarativeOutputPluginManifestSchema.parse(rawManifest);
  const interactive = manifest.kind !== 'info-card';
  const protocolExample = manifest.protocolExample?.trim() || buildDefaultDeclarativeProtocolExample(manifest);
  const promptInstruction = manifest.promptInstruction?.trim() || buildDefaultDeclarativePromptInstruction(manifest);
  const interactionOrigin = interactive ? declarativePluginInteractionOrigin(manifest.id) : undefined;

  const parseOutput = (
    text: string | null | undefined,
    precomputedMasked?: string
  ): OutputPluginParseResult<DeclarativeOutputPluginSpec> | null => {
    const block = extractTrailingXmlBlock(text, manifest.tagName, precomputedMasked);
    if (!block) return null;
    const spec = parseDeclarativeSpec(manifest, block.rootAttrs, block.innerXml, block.rawXml);
    if (!spec) return null;
    return {
      pluginId: manifest.id,
      tagName: manifest.tagName,
      proseText: block.proseText,
      spec,
      rawXml: block.rawXml,
      startIndex: block.startIndex,
      endIndex: block.endIndex
    };
  };

  const splitStreaming = (
    text: string | null | undefined,
    streaming: boolean,
    precomputedMasked?: string
  ): OutputPluginStreamingSplit<DeclarativeOutputPluginSpec> => {
    if (!text) return { kind: 'none', proseText: '' };
    const extracted = parseOutput(text, precomputedMasked);
    if (extracted) {
      return {
        kind: 'complete',
        pluginId: manifest.id,
        tagName: manifest.tagName,
        proseText: extracted.proseText,
        spec: extracted.spec,
        rawXml: extracted.rawXml
      };
    }
    if (!streaming) return { kind: 'none', proseText: text };
    const pending = detectPendingStreamingXmlTag(text, manifest.tagName, precomputedMasked);
    if (pending) {
      return {
        kind: 'pending',
        pluginId: manifest.id,
        tagName: manifest.tagName,
        proseText: pending.proseText,
        ...(pending.partialTitle ? { partialTitle: pending.partialTitle } : {})
      };
    }
    return { kind: 'none', proseText: text };
  };

  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    icon: manifest.icon,
    tagName: manifest.tagName,
    defaultEnabled: manifest.defaultEnabled,
    version: manifest.version,
    builtin: false,
    source: options.source ?? 'local',
    capabilities: {
      web: true,
      lark: true,
      interactive,
      streamingPlaceholder: true
    },
    protocolExample,
    ...(interactionOrigin ? { interactionOrigin } : {}),
    declarative: manifest,
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
    promptInstruction,
    ...(manifest.disabledNotice ? { disabledNotice: manifest.disabledNotice } : {}),
    parseOutput,
    splitStreaming,
    getInstanceId: spec => spec.id,
    getTitle: spec => spec.title,
    ...(interactive
      ? {
          parseInteraction: (raw: string | null | undefined) => {
            const parsed = parseDeclarativeInteraction(raw);
            if (!parsed || parsed.pluginId !== manifest.id) return null;
            return parsed;
          },
          getInteractionInstanceId: (payload: DeclarativeOutputPluginInteractionPayload) => payload.instanceId,
          serializeInteraction: (payload: DeclarativeOutputPluginInteractionPayload) => JSON.stringify(payload),
          formatInteractionForAgent: (payload: DeclarativeOutputPluginInteractionPayload) => formatDeclarativeInteractionForAgent(manifest, payload),
          summarizeInteraction: (payload: DeclarativeOutputPluginInteractionPayload) => summarizeDeclarativeInteraction(manifest, payload),
          extractInteractionSearchText: (payload: DeclarativeOutputPluginInteractionPayload) => {
            const parts: string[] = [
              manifest.name,
              payload.source === 'assistant' ? '小猫代答' : payload.source === 'lark' ? '飞书' : '网页端'
            ];
            if (payload.title) parts.push(payload.title);
            if (payload.responderName) parts.push(payload.responderName, `${payload.responderName}代答`);
            if (payload.actedBy && payload.actedBy !== payload.responderName) parts.push(payload.actedBy);
            if (payload.actionLabel) parts.push(payload.actionLabel);
            for (const field of payload.fields) {
              parts.push(field.label, field.displayValue || field.value);
            }
            if (payload.note) parts.push(payload.note);
            return parts.join('\n');
          }
        }
      : {}),
    extractSearchText: spec => {
      const parts: string[] = [];
      if (spec.title) parts.push(spec.title);
      if (spec.summary) parts.push(spec.summary);
      if (spec.status) parts.push(spec.status);
      for (const field of spec.fields) {
        parts.push(field.label);
        if (field.value) parts.push(field.value);
      }
      for (const action of spec.actions) {
        parts.push(action.label);
        if (action.description) parts.push(action.description);
      }
      for (const link of spec.links) {
        parts.push(link.label);
      }
      return parts.join('\n');
    }
  };
}
