import { inflateRawSync } from 'node:zlib';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, posix, resolve } from 'node:path';
import {
  RuntimeError,
  compositeColorOver,
  contrastRatio,
  ensureReadableThemeTokens,
  mixHex,
  normalizeHexColor,
  relativeLuminance,
  slugifyThemeId,
  type CustomTheme,
  type CustomThemeMode,
  type CustomThemeTokens,
  type ThemeContrastAdjustment,
  type ThemeContrastReport,
  type VsCodeThemeMeta
} from '@agent-dock/agent-dock-shared';

const MAX_VSIX_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_INCLUDE_DEPTH = 8;
const MARKETPLACE_TIMEOUT_MS = 20_000;

export interface RawVsCodeThemeFile {
  name?: string;
  type?: string;
  include?: string;
  colors?: Record<string, string>;
  tokenColors?: unknown[];
}

export interface ParsedVsCodeThemeVariant {
  theme: CustomTheme;
  adjustments: ThemeContrastAdjustment[];
  report: ThemeContrastReport;
  label: string;
  uiTheme?: string;
  colorCount: number;
}

export interface ParsedVsCodeBundle {
  sourceLabel: string;
  extensionId?: string;
  extensionName?: string;
  publisher?: string;
  version?: string;
  marketplaceUrl?: string;
  variants: ParsedVsCodeThemeVariant[];
}

export interface ImportVsCodeSourceInput {
  /** 本机路径（.vsix/.json/.jsonc/扩展目录）、Marketplace URL 或 publisher.extension ID。 */
  source?: string;
  /** 前端拖拽/选择上传的文件原始内容（Buffer 或 base64）。 */
  fileBuffer?: Buffer;
  fileBase64?: string;
  fileName?: string;
  /** 直接粘贴的 VS Code 主题 JSON / JSONC 文本。 */
  jsonText?: string;
  /** 可选自定义 fetch（测试注入）。 */
  fetcher?: typeof globalThis.fetch;
}

/* ============================================================================
 * 1. 容错 JSONC 解析器（状态机剥离 //、/* *\/ 注释与尾逗号，绝不误伤字符串内 URL）
 * ============================================================================ */

export function stripJsonCommentsAndTrailingCommas(input: string): string {
  const text = input.replace(/^\uFEFF/, '');
  let out = '';
  let i = 0;
  const len = text.length;
  let inString = false;

  while (i < len) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < len) {
        out += text[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    // 单行注释 //
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < len && text[i] !== '\n' && text[i] !== '\r') i++;
      continue;
    }

    // 多行注释 /* ... */
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  // 去除字符串外紧贴 } 或 ] 前的尾逗号
  let cleaned = '';
  inString = false;
  for (let idx = 0; idx < out.length; idx++) {
    const ch = out[idx]!;
    if (inString) {
      cleaned += ch;
      if (ch === '\\' && idx + 1 < out.length) {
        cleaned += out[idx + 1]!;
        idx++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      cleaned += ch;
      continue;
    }
    if (ch === ',') {
      let lookahead = idx + 1;
      while (lookahead < out.length && /\s/.test(out[lookahead]!)) lookahead++;
      const closing = out[lookahead];
      if (closing === '}' || closing === ']') {
        continue;
      }
    }
    cleaned += ch;
  }

  return cleaned;
}

export function parseJsonc<T = unknown>(text: string, label = 'JSON'): T {
  try {
    return JSON.parse(stripJsonCommentsAndTrailingCommas(text)) as T;
  } catch (error) {
    throw new RuntimeError(
      'INVALID_VSCODE_JSON',
      `无法解析 ${label}：${error instanceof Error ? error.message : String(error)}`,
      400
    );
  }
}

/* ============================================================================
 * 2. 轻量零依赖 ZIP / .vsix 解压器（支持 Store=0 与 Deflate=8，带大小与路径安全校验）
 * ============================================================================ */

interface ZipCentralEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function normalizeZipPath(raw: string): string | null {
  const replaced = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  const normalized = posix.normalize(replaced);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    return null;
  }
  return normalized;
}

export function isZipBuffer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05);
}

/**
 * 读取 ZIP / .vsix 归档的中央目录并返回按需解压读取器。
 * 仅解压实际读取到的文件（package.json、package.nls.json、theme json 及其 include），避免释放无用大图标/资源。
 */
export function openZipArchive(buffer: Buffer): {
  listEntries(): string[];
  readEntry(path: string): Buffer | undefined;
} {
  if (buffer.length > MAX_VSIX_BYTES) {
    throw new RuntimeError('VSIX_TOO_LARGE', 'VSIX 压缩包超过 50MB 上限', 400);
  }
  if (buffer.length < 22) {
    throw new RuntimeError('INVALID_VSIX', '不是有效的 ZIP / VSIX 压缩包（文件过短）', 400);
  }

  // 从末尾向前查找 End of Central Directory (0x06054b50)
  const minOffset = Math.max(0, buffer.length - 65_557);
  let eocdOffset = -1;
  for (let pos = buffer.length - 22; pos >= minOffset; pos--) {
    if (buffer.readUInt32LE(pos) === 0x06054b50) {
      eocdOffset = pos;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new RuntimeError('INVALID_VSIX', '无法在文件中找到 ZIP 中央目录结尾标记（EOCD）', 400);
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (centralDirOffset + centralDirSize > buffer.length) {
    throw new RuntimeError('INVALID_VSIX', 'VSIX 归档中央目录越界或已损坏', 400);
  }

  const entries = new Map<string, ZipCentralEntry>();
  const lowerLookup = new Map<string, string>();
  let cursor = centralDirOffset;
  const end = centralDirOffset + centralDirSize;

  for (let i = 0; i < totalEntries && cursor + 46 <= end; i++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new RuntimeError('INVALID_VSIX', 'VSIX 归档中央目录条目签名无效', 400);
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);

    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > end) break;
    const rawName = buffer.subarray(nameStart, nameEnd).toString((flags & 0x0800) ? 'utf8' : 'latin1');
    const normalized = normalizeZipPath(rawName);
    if (normalized && !rawName.endsWith('/')) {
      entries.set(normalized, {
        name: normalized,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset
      });
      lowerLookup.set(normalized.toLowerCase(), normalized);
    }
    cursor = nameEnd + extraLen + commentLen;
  }

  const readEntry = (targetPath: string): Buffer | undefined => {
    const normalized = normalizeZipPath(targetPath);
    if (!normalized) return undefined;
    const entry = entries.get(normalized) ?? (() => {
      const exact = lowerLookup.get(normalized.toLowerCase());
      return exact ? entries.get(exact) : undefined;
    })();
    if (!entry) return undefined;
    if (entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
      throw new RuntimeError('VSIX_ENTRY_TOO_LARGE', `VSIX 内文件 ${entry.name} 超过 10MB 限制`, 400);
    }
    const lh = entry.localHeaderOffset;
    if (lh + 30 > buffer.length || buffer.readUInt32LE(lh) !== 0x04034b50) {
      throw new RuntimeError('INVALID_VSIX', `VSIX 内文件 ${entry.name} 本地头损坏`, 400);
    }
    const lhNameLen = buffer.readUInt16LE(lh + 26);
    const lhExtraLen = buffer.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + lhNameLen + lhExtraLen;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buffer.length) {
      throw new RuntimeError('INVALID_VSIX', `VSIX 内文件 ${entry.name} 数据区截断`, 400);
    }
    const compressed = buffer.subarray(dataStart, dataEnd);
    if (entry.compressionMethod === 0) {
      return Buffer.from(compressed);
    }
    if (entry.compressionMethod === 8) {
      try {
        const inflated = inflateRawSync(compressed, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
        return inflated;
      } catch (error) {
        throw new RuntimeError('INVALID_VSIX', `解压 VSIX 文件 ${entry.name} 失败：${error instanceof Error ? error.message : String(error)}`, 400);
      }
    }
    throw new RuntimeError('UNSUPPORTED_VSIX_COMPRESSION', `VSIX 文件 ${entry.name} 使用了不支持的压缩方式 (${entry.compressionMethod})`, 400);
  };

  return {
    listEntries: () => [...entries.keys()],
    readEntry
  };
}

/* ============================================================================
 * 3. VS Code 主题 include 继承合并 & 语义化色板映射
 * ============================================================================ */

async function resolveThemeWithIncludes(
  entryPath: string,
  readText: (path: string) => Promise<string | undefined>,
  resolveRelative: (fromFile: string, includePath: string) => string,
  visited = new Set<string>(),
  depth = 0
): Promise<RawVsCodeThemeFile> {
  if (depth > MAX_INCLUDE_DEPTH) {
    throw new RuntimeError('VSCODE_INCLUDE_TOO_DEEP', `VS Code 主题 include 继承层数超过 ${MAX_INCLUDE_DEPTH} 层`, 400);
  }
  const canonical = entryPath.toLowerCase();
  if (visited.has(canonical)) {
    throw new RuntimeError('VSCODE_INCLUDE_CYCLE', `检测到 VS Code 主题循环 include：${entryPath}`, 400);
  }
  visited.add(canonical);

  const rawText = await readText(entryPath);
  if (rawText === undefined) {
    throw new RuntimeError('VSCODE_THEME_FILE_NOT_FOUND', `找不到主题文件：${entryPath}`, 404);
  }
  const current = parseJsonc<RawVsCodeThemeFile>(rawText, basename(entryPath));
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new RuntimeError('INVALID_VSCODE_THEME', `主题文件 ${basename(entryPath)} 不是有效的 JSON 对象`, 400);
  }

  if (typeof current.include === 'string' && current.include.trim()) {
    const parentPath = resolveRelative(entryPath, current.include.trim());
    const parent = await resolveThemeWithIncludes(parentPath, readText, resolveRelative, visited, depth + 1);
    return {
      ...parent,
      ...current,
      colors: { ...(parent.colors ?? {}), ...(current.colors ?? {}) },
      tokenColors: [
        ...(Array.isArray(parent.tokenColors) ? parent.tokenColors : []),
        ...(Array.isArray(current.tokenColors) ? current.tokenColors : [])
      ]
    };
  }

  return current;
}

function resolveMode(rawTheme: RawVsCodeThemeFile, uiTheme?: string): CustomThemeMode {
  const type = rawTheme.type?.trim().toLowerCase();
  if (type === 'light' || type === 'hclight' || type === 'hc-light') return 'light';
  if (type === 'dark' || type === 'hc' || type === 'hcdark' || type === 'hc-dark') return 'dark';

  const ui = uiTheme?.trim().toLowerCase();
  if (ui === 'vs' || ui === 'hc-light') return 'light';
  if (ui === 'vs-dark' || ui === 'hc-black') return 'dark';

  const editorBg = rawTheme.colors?.['editor.background'] ?? rawTheme.colors?.['panel.background'];
  const normalized = editorBg ? normalizeHexColor(editorBg) : null;
  if (normalized) {
    return relativeLuminance(normalized) >= 0.42 ? 'light' : 'dark';
  }
  return 'dark';
}

function pickVsCodeColor(
  colors: Record<string, string>,
  keys: string[],
  backdropHex?: string
): string | undefined {
  for (const key of keys) {
    const raw = colors[key];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const resolved = backdropHex ? compositeColorOver(raw, backdropHex) : normalizeHexColor(raw);
    if (resolved) return resolved;
  }
  return undefined;
}

/**
 * 将 VS Code 主题对象（colors + type + uiTheme）高质量映射到 AgentDock 20 个语义化 Token，
 * 并通过 WCAG 对比度守护算法确保正文/次文/强调按钮/状态色清晰可读。
 */
export function mapVsCodeThemeToAgentDock(
  rawTheme: RawVsCodeThemeFile,
  options: {
    name?: string;
    description?: string;
    uiTheme?: string;
    vscodeMeta?: VsCodeThemeMeta;
  } = {}
): ParsedVsCodeThemeVariant {
  const colors: Record<string, string> = {};
  if (rawTheme.colors && typeof rawTheme.colors === 'object') {
    for (const [k, v] of Object.entries(rawTheme.colors)) {
      if (typeof v === 'string' && v.trim()) colors[k] = v.trim();
    }
  }

  const mode = resolveMode(rawTheme, options.uiTheme);
  const dark = mode === 'dark';

  const fallbackCanvas = dark ? '#1e1f26' : '#ffffff';
  const bgCanvas = pickVsCodeColor(colors, [
    'editor.background',
    'panel.background',
    'sideBar.background'
  ]) ?? fallbackCanvas;

  const bgSidebar = pickVsCodeColor(colors, [
    'sideBar.background',
    'activityBar.background',
    'titleBar.activeBackground',
    'panel.background'
  ], bgCanvas) ?? (dark ? mixHex(bgCanvas, '#000000', 0.18) : mixHex(bgCanvas, '#000000', 0.035));

  const bgSurface = pickVsCodeColor(colors, [
    'editorWidget.background',
    'sideBarSectionHeader.background',
    'editorGroupHeader.tabsBackground',
    'input.background',
    'panel.background'
  ], bgCanvas) ?? (dark ? mixHex(bgCanvas, '#ffffff', 0.05) : mixHex(bgCanvas, '#ffffff', 0.6));

  const bgElevated = pickVsCodeColor(colors, [
    'quickInput.background',
    'dropdown.background',
    'menu.background',
    'notifications.background',
    'editorHoverWidget.background',
    'editorWidget.background'
  ], bgSurface) ?? (dark ? mixHex(bgSurface, '#ffffff', 0.04) : mixHex(bgSurface, '#ffffff', 0.8));

  const textPrimary = pickVsCodeColor(colors, [
    'editor.foreground',
    'foreground',
    'sideBar.foreground',
    'input.foreground'
  ], bgCanvas);

  const bgSurfaceHover = pickVsCodeColor(colors, [
    'list.hoverBackground',
    'toolbar.hoverBackground',
    'list.inactiveSelectionBackground',
    'menubar.selectionBackground'
  ], bgSurface) ?? mixHex(bgSurface, textPrimary ?? (dark ? '#ffffff' : '#000000'), dark ? 0.09 : 0.06);

  const bgCode = pickVsCodeColor(colors, [
    'terminal.background',
    'textCodeBlock.background',
    'editorGroupHeader.tabsBackground'
  ], bgCanvas) ?? (dark ? mixHex(bgCanvas, '#000000', 0.22) : mixHex(bgCanvas, '#000000', 0.035));

  const accent = pickVsCodeColor(colors, [
    'button.background',
    'focusBorder',
    'textLink.foreground',
    'activityBarBadge.background',
    'badge.background',
    'statusBarItem.remoteBackground',
    'terminal.ansiBlue'
  ], bgSurface);

  // 用户气泡底色优先取选区/高亮底，但防止高饱和选区把气泡染花
  const rawBubble = pickVsCodeColor(colors, [
    'list.activeSelectionBackground',
    'editor.lineHighlightBackground',
    'input.background',
    'editor.selectionBackground'
  ], bgCanvas);
  const bgBubbleUser = rawBubble
    ? mixHex(bgCanvas, rawBubble, dark ? 0.65 : 0.45)
    : (accent ? mixHex(bgCanvas, accent, dark ? 0.14 : 0.07) : mixHex(bgCanvas, textPrimary ?? (dark ? '#ffffff' : '#000000'), 0.06));

  const textSecondary = pickVsCodeColor(colors, [
    'sideBar.foreground',
    'tab.inactiveForeground',
    'descriptionForeground',
    'panelTitle.inactiveForeground'
  ], bgCanvas);

  const textMuted = pickVsCodeColor(colors, [
    'descriptionForeground',
    'editorLineNumber.foreground',
    'input.placeholderForeground',
    'disabledForeground',
    'sideBarTitle.foreground'
  ], bgCanvas);

  const borderSubtle = pickVsCodeColor(colors, [
    'panel.border',
    'sideBar.border',
    'editorGroup.border',
    'editorWidget.border',
    'tab.border'
  ], bgSurface);

  const borderStrong = pickVsCodeColor(colors, [
    'input.border',
    'dropdown.border',
    'contrastBorder',
    'menu.border',
    'panel.border'
  ], bgSurface);

  const accentForeground = pickVsCodeColor(colors, [
    'button.foreground',
    'badge.foreground',
    'activityBarBadge.foreground'
  ], accent);

  const success = pickVsCodeColor(colors, [
    'terminal.ansiGreen',
    'gitDecoration.addedResourceForeground',
    'testing.iconPassed',
    'editorGutter.addedBackground'
  ], bgSurface);

  const warning = pickVsCodeColor(colors, [
    'editorWarning.foreground',
    'terminal.ansiYellow',
    'list.warningForeground',
    'gitDecoration.modifiedResourceForeground'
  ], bgSurface);

  const danger = pickVsCodeColor(colors, [
    'editorError.foreground',
    'terminal.ansiRed',
    'errorForeground',
    'list.errorForeground',
    'gitDecoration.deletedResourceForeground'
  ], bgSurface);

  const info = pickVsCodeColor(colors, [
    'editorInfo.foreground',
    'textLink.foreground',
    'terminal.ansiCyan',
    'terminal.ansiBlue'
  ], bgSurface);

  const rawTokens: Partial<Record<keyof CustomThemeTokens, string | undefined>> = {
    bgCanvas,
    bgSidebar,
    bgSurface,
    bgSurfaceHover,
    bgElevated,
    bgBubbleUser,
    bgCode,
    textPrimary,
    textSecondary,
    textMuted,
    textInverse: textPrimary
      ? (contrastRatio('#ffffff', textPrimary) >= contrastRatio('#10131a', textPrimary) ? '#ffffff' : '#10131a')
      : undefined,
    borderSubtle,
    borderStrong,
    accent,
    accentSoft: accent ? mixHex(bgSurface, accent, dark ? 0.2 : 0.12) : undefined,
    accentForeground,
    success,
    warning,
    danger,
    info
  };

  const ensured = ensureReadableThemeTokens(rawTokens, mode);
  const label = options.name?.trim() || rawTheme.name?.trim() || options.vscodeMeta?.variantLabel?.trim() || 'VS Code 主题';
  const description = options.description?.trim()
    || (options.vscodeMeta?.extensionName
      ? `导入自 VS Code 插件「${options.vscodeMeta.extensionName}」`
      : '导入自 VS Code 主题文件');

  const theme: CustomTheme = {
    id: slugifyThemeId(label, 'vscode'),
    name: label.slice(0, 80),
    description: description.slice(0, 300),
    mode,
    source: 'vscode',
    vscodeMeta: {
      ...options.vscodeMeta,
      variantLabel: label,
      ...(options.uiTheme ? { uiTheme: options.uiTheme } : {})
    },
    tokens: ensured.tokens
  };

  return {
    theme,
    adjustments: ensured.adjustments,
    report: ensured.report,
    label,
    ...(options.uiTheme ? { uiTheme: options.uiTheme } : {}),
    colorCount: Object.keys(colors).length
  };
}

/* ============================================================================
 * 4. 扩展包（.vsix / 本机扩展目录 / 单文件 / Marketplace）解析入口
 * ============================================================================ */

interface ExtensionPackageJson {
  name?: string;
  displayName?: string;
  publisher?: string;
  version?: string;
  description?: string;
  contributes?: {
    themes?: Array<{
      id?: string;
      label?: string;
      uiTheme?: string;
      path?: string;
    }>;
  };
}

function resolveNlsValue(value: string | undefined, nls?: Record<string, string>): string | undefined {
  if (!value) return undefined;
  const match = /^%([^%]+)%$/.exec(value.trim());
  if (!match || !nls) return value;
  return nls[match[1]!] ?? value;
}

function expandHome(inputPath: string): string {
  if (inputPath === '~') return homedir();
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return resolve(homedir(), inputPath.slice(2));
  }
  return inputPath;
}

export interface ParsedMarketplaceRef {
  publisher: string;
  extensionName: string;
  extensionId: string;
  marketplaceUrl: string;
}

const VALID_MP_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/;

/** 识别 VS Code Marketplace URL 或 publisher.extension 标识。 */
export function parseMarketplaceReference(input: string): ParsedMarketplaceRef | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    let parsed: URL;
    try { parsed = new URL(trimmed); } catch { return null; }
    if (parsed.hostname.toLowerCase() === 'marketplace.visualstudio.com') {
      const itemName = parsed.searchParams.get('itemName')?.trim();
      if (!itemName) return null;
      return parseMarketplaceReference(itemName);
    }
    return null;
  }

  // 排除显式本地路径（含斜杠、以点开头、或以 .vsix/.json/.jsonc 结尾）
  if (
    trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('~') || trimmed.startsWith('.')
    || /\.(?:vsix|json|jsonc|zip)$/i.test(trimmed)
  ) {
    return null;
  }

  const dot = trimmed.indexOf('.');
  if (dot <= 0 || dot !== trimmed.lastIndexOf('.')) return null;
  const publisher = trimmed.slice(0, dot);
  const extensionName = trimmed.slice(dot + 1);
  if (!VALID_MP_SEGMENT.test(publisher) || !VALID_MP_SEGMENT.test(extensionName)) return null;

  const extensionId = `${publisher}.${extensionName}`;
  return {
    publisher,
    extensionName,
    extensionId,
    marketplaceUrl: `https://marketplace.visualstudio.com/items?itemName=${encodeURIComponent(extensionId)}`
  };
}

export async function downloadVsixFromMarketplace(
  ref: ParsedMarketplaceRef,
  fetcher: typeof globalThis.fetch = globalThis.fetch
): Promise<Buffer> {
  const directUrl = `https://${encodeURIComponent(ref.publisher)}.gallery.vsassets.io/_apis/public/gallery/publisher/${encodeURIComponent(ref.publisher)}/extension/${encodeURIComponent(ref.extensionName)}/latest/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage`;

  let response: Response;
  try {
    response = await fetcher(directUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'AgentDock-ThemeImporter/1.0',
        Accept: 'application/octet-stream, */*'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(MARKETPLACE_TIMEOUT_MS)
    });
  } catch (error) {
    const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new RuntimeError(
      'VSCODE_MARKETPLACE_FETCH_FAILED',
      isTimeout
        ? `从 VS Code Marketplace 下载「${ref.extensionId}」超时（>${MARKETPLACE_TIMEOUT_MS / 1000}s），请稍后重试或手动下载 .vsix 文件导入`
        : `无法连接 VS Code Marketplace 下载「${ref.extensionId}」：${error instanceof Error ? error.message : String(error)}`,
      502
    );
  }

  if (!response.ok) {
    throw new RuntimeError(
      'VSCODE_MARKETPLACE_NOT_FOUND',
      response.status === 404
        ? `在 VS Code Marketplace 上未找到扩展「${ref.extensionId}」，请确认发布者与扩展名是否正确`
        : `从 VS Code Marketplace 下载「${ref.extensionId}」失败（HTTP ${response.status}）`,
      response.status === 404 ? 404 : 502
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > MAX_VSIX_BYTES) {
    throw new RuntimeError('VSIX_TOO_LARGE', `扩展「${ref.extensionId}」的 VSIX 包超过 50MB 上限`, 400);
  }
  if (!isZipBuffer(buffer)) {
    throw new RuntimeError('INVALID_VSIX', `扩展「${ref.extensionId}」返回的不是有效的 VSIX 压缩包`, 422);
  }
  return buffer;
}

export async function parseVsixBuffer(
  buffer: Buffer,
  options: { sourceLabel?: string; sourcePath?: string; marketplaceUrl?: string } = {}
): Promise<ParsedVsCodeBundle> {
  const zip = openZipArchive(buffer);
  const pkgPath = zip.readEntry('extension/package.json') ? 'extension/package.json'
    : zip.readEntry('package.json') ? 'package.json'
      : undefined;
  if (!pkgPath) {
    throw new RuntimeError('INVALID_VSIX_PACKAGE', 'VSIX 压缩包中缺少 extension/package.json', 400);
  }

  const rootDir = posix.dirname(pkgPath) === '.' ? '' : posix.dirname(pkgPath);
  const pkg = parseJsonc<ExtensionPackageJson>(zip.readEntry(pkgPath)!.toString('utf8'), pkgPath);
  const nlsPath = rootDir ? `${rootDir}/package.nls.json` : 'package.nls.json';
  const nlsBuf = zip.readEntry(nlsPath);
  const nls = nlsBuf ? (() => {
    try { return parseJsonc<Record<string, string>>(nlsBuf.toString('utf8'), nlsPath); }
    catch { return undefined; }
  })() : undefined;

  const publisher = pkg.publisher?.trim();
  const pkgName = pkg.name?.trim();
  const extensionId = publisher && pkgName ? `${publisher}.${pkgName}` : pkgName;
  const extensionName = resolveNlsValue(pkg.displayName, nls)?.trim() || pkgName || options.sourceLabel || 'VS Code 主题扩展';
  const version = pkg.version?.trim();
  const themesList = Array.isArray(pkg.contributes?.themes) ? pkg.contributes!.themes : [];

  if (themesList.length === 0) {
    throw new RuntimeError('VSCODE_NO_THEMES_FOUND', `扩展「${extensionName}」的 package.json 中未声明 contributes.themes`, 400);
  }

  const readText = async (entryPath: string): Promise<string | undefined> => {
    const data = zip.readEntry(entryPath);
    return data ? data.toString('utf8') : undefined;
  };
  const resolveRelative = (fromFile: string, includePath: string): string => {
    const baseDir = posix.dirname(fromFile);
    return posix.normalize(baseDir === '.' ? includePath : posix.join(baseDir, includePath));
  };

  const variants: ParsedVsCodeThemeVariant[] = [];
  for (const item of themesList) {
    if (!item?.path?.trim()) continue;
    const entryPath = posix.normalize(rootDir ? posix.join(rootDir, item.path.trim()) : item.path.trim());
    const merged = await resolveThemeWithIncludes(entryPath, readText, resolveRelative);
    const label = resolveNlsValue(item.label, nls)?.trim() || merged.name?.trim() || basename(entryPath, extname(entryPath));
    const variant = mapVsCodeThemeToAgentDock(merged, {
      name: label,
      description: resolveNlsValue(pkg.description, nls)?.trim() || `导入自 VS Code 插件「${extensionName}」`,
      uiTheme: item.uiTheme,
      vscodeMeta: {
        ...(extensionId ? { extensionId } : {}),
        extensionName,
        ...(publisher ? { publisher } : {}),
        ...(version ? { version } : {}),
        variantLabel: label,
        ...(item.uiTheme ? { uiTheme: item.uiTheme } : {}),
        ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
        ...(options.marketplaceUrl ? { marketplaceUrl: options.marketplaceUrl } : {})
      }
    });
    variants.push(variant);
  }

  if (variants.length === 0) {
    throw new RuntimeError('VSCODE_NO_THEMES_FOUND', `扩展「${extensionName}」中没有可解析的主题文件`, 400);
  }

  return {
    sourceLabel: options.sourceLabel || extensionName,
    ...(extensionId ? { extensionId } : {}),
    extensionName,
    ...(publisher ? { publisher } : {}),
    ...(version ? { version } : {}),
    ...(options.marketplaceUrl ? { marketplaceUrl: options.marketplaceUrl } : {}),
    variants
  };
}

export async function parseLocalExtensionDirectory(dirPath: string): Promise<ParsedVsCodeBundle> {
  const resolvedDir = resolve(expandHome(dirPath));
  const pkgCandidate = existsSync(resolve(resolvedDir, 'package.json'))
    ? resolve(resolvedDir, 'package.json')
    : existsSync(resolve(resolvedDir, 'extension', 'package.json'))
      ? resolve(resolvedDir, 'extension', 'package.json')
      : undefined;

  const readText = async (filePath: string): Promise<string | undefined> => {
    try { return await readFile(filePath, 'utf8'); }
    catch { return undefined; }
  };
  const resolveRelative = (fromFile: string, includePath: string): string => resolve(dirname(fromFile), includePath);

  if (pkgCandidate) {
    const extRoot = dirname(pkgCandidate);
    const pkg = parseJsonc<ExtensionPackageJson>(await readFile(pkgCandidate, 'utf8'), pkgCandidate);
    const nlsFile = resolve(extRoot, 'package.nls.json');
    const nls = existsSync(nlsFile) ? await readFile(nlsFile, 'utf8').then(text => {
      try { return parseJsonc<Record<string, string>>(text, nlsFile); }
      catch { return undefined; }
    }).catch(() => undefined) : undefined;
    const publisher = pkg.publisher?.trim();
    const pkgName = pkg.name?.trim();
    const extensionId = publisher && pkgName ? `${publisher}.${pkgName}` : pkgName;
    const extensionName = resolveNlsValue(pkg.displayName, nls)?.trim() || pkgName || basename(resolvedDir);
    const version = pkg.version?.trim();
    const themesList = Array.isArray(pkg.contributes?.themes) ? pkg.contributes!.themes : [];
    if (themesList.length === 0) {
      throw new RuntimeError('VSCODE_NO_THEMES_FOUND', `目录「${resolvedDir}」的 package.json 未声明 contributes.themes`, 400);
    }

    const variants: ParsedVsCodeThemeVariant[] = [];
    for (const item of themesList) {
      if (!item?.path?.trim()) continue;
      const themeFile = resolve(extRoot, item.path.trim());
      const merged = await resolveThemeWithIncludes(themeFile, readText, resolveRelative);
      const label = resolveNlsValue(item.label, nls)?.trim() || merged.name?.trim() || basename(themeFile, extname(themeFile));
      variants.push(mapVsCodeThemeToAgentDock(merged, {
        name: label,
        description: resolveNlsValue(pkg.description, nls)?.trim() || `导入自本机 VS Code 扩展「${extensionName}」`,
        uiTheme: item.uiTheme,
        vscodeMeta: {
          ...(extensionId ? { extensionId } : {}),
          extensionName,
          ...(publisher ? { publisher } : {}),
          ...(version ? { version } : {}),
          variantLabel: label,
          ...(item.uiTheme ? { uiTheme: item.uiTheme } : {}),
          sourcePath: resolvedDir
        }
      }));
    }
    if (!variants.length) {
      throw new RuntimeError('VSCODE_NO_THEMES_FOUND', `目录「${resolvedDir}」未解析出有效主题`, 400);
    }
    return {
      sourceLabel: extensionName,
      ...(extensionId ? { extensionId } : {}),
      extensionName,
      ...(publisher ? { publisher } : {}),
      ...(version ? { version } : {}),
      variants
    };
  }

  // 无 package.json 时扫描目录下 *.json / *.jsonc 主题文件
  const entries = await readdir(resolvedDir);
  const candidates = entries.filter(name => /\.(?:json|jsonc)$/i.test(name) && name !== 'package.json' && name !== 'package.nls.json');
  const variants: ParsedVsCodeThemeVariant[] = [];
  for (const name of candidates) {
    const themeFile = resolve(resolvedDir, name);
    try {
      const merged = await resolveThemeWithIncludes(themeFile, readText, resolveRelative);
      if (!merged.colors || typeof merged.colors !== 'object' || Object.keys(merged.colors).length === 0) continue;
      const label = merged.name?.trim() || basename(name, extname(name));
      variants.push(mapVsCodeThemeToAgentDock(merged, {
        name: label,
        vscodeMeta: { variantLabel: label, sourcePath: themeFile }
      }));
    } catch {
      // 忽略目录中非主题 JSON 文件
    }
  }
  if (!variants.length) {
    throw new RuntimeError('VSCODE_NO_THEMES_FOUND', `目录「${resolvedDir}」中未找到 package.json 或包含 colors 字段的 VS Code 主题文件`, 400);
  }
  return {
    sourceLabel: basename(resolvedDir),
    variants
  };
}

export async function parseSingleThemeFile(filePath: string): Promise<ParsedVsCodeBundle> {
  const resolved = resolve(expandHome(filePath));
  const readText = async (target: string): Promise<string | undefined> => {
    try { return await readFile(target, 'utf8'); }
    catch { return undefined; }
  };
  const resolveRelative = (fromFile: string, includePath: string): string => resolve(dirname(fromFile), includePath);

  const merged = await resolveThemeWithIncludes(resolved, readText, resolveRelative);
  const label = merged.name?.trim() || basename(resolved, extname(resolved));
  const variant = mapVsCodeThemeToAgentDock(merged, {
    name: label,
    vscodeMeta: {
      variantLabel: label,
      sourcePath: resolved
    }
  });
  return {
    sourceLabel: basename(resolved),
    variants: [variant]
  };
}

export function parseSingleThemeJsonText(text: string, fileName?: string): ParsedVsCodeBundle {
  const parsed = parseJsonc<RawVsCodeThemeFile>(text, fileName || 'VS Code 主题 JSON');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RuntimeError('INVALID_VSCODE_THEME', '主题内容必须是包含 colors 字段的 JSON 对象', 400);
  }
  if (!parsed.colors && !parsed.tokenColors) {
    throw new RuntimeError('INVALID_VSCODE_THEME', '未在 JSON 中检测到 VS Code 主题字段（colors / tokenColors）', 400);
  }
  const fallbackName = fileName ? basename(fileName, extname(fileName)) : 'VS Code 主题';
  const label = parsed.name?.trim() || fallbackName;
  const variant = mapVsCodeThemeToAgentDock(parsed, {
    name: label,
    vscodeMeta: { variantLabel: label }
  });
  return {
    sourceLabel: fileName || label,
    variants: [variant]
  };
}

/** 统一解析入口：支持上传文件 Buffer/Base64、粘贴 JSONC、本机 .vsix/.json/.jsonc/目录、Marketplace URL/ID。 */
export async function parseVsCodeThemeSource(input: ImportVsCodeSourceInput): Promise<ParsedVsCodeBundle> {
  // 1. 直接上传的二进制/文本文件（.vsix / .json / .jsonc）
  const rawBuffer = input.fileBuffer
    ?? (input.fileBase64 ? Buffer.from(input.fileBase64, 'base64') : undefined);
  if (rawBuffer && rawBuffer.length > 0) {
    if (isZipBuffer(rawBuffer) || /\.(?:vsix|zip)$/i.test(input.fileName ?? '')) {
      return parseVsixBuffer(rawBuffer, { sourceLabel: input.fileName || '上传的 VSIX 插件' });
    }
    return parseSingleThemeJsonText(rawBuffer.toString('utf8'), input.fileName);
  }

  // 2. 直接粘贴的 JSON / JSONC 文本
  if (typeof input.jsonText === 'string' && input.jsonText.trim()) {
    return parseSingleThemeJsonText(input.jsonText, input.fileName);
  }

  const source = input.source?.trim();
  if (!source) {
    throw new RuntimeError('VSCODE_SOURCE_REQUIRED', '请提供 .vsix / .json / .jsonc 文件、本机扩展目录、Marketplace 链接或 publisher.extension 标识', 400);
  }

  // 3. 若直接把整段 JSON 传进 source
  if (source.startsWith('{')) {
    return parseSingleThemeJsonText(source, input.fileName);
  }

  // 4. VS Code Marketplace URL 或 publisher.extension ID
  const mp = parseMarketplaceReference(source);
  if (mp) {
    const vsixBuf = await downloadVsixFromMarketplace(mp, input.fetcher);
    return parseVsixBuffer(vsixBuf, {
      sourceLabel: mp.extensionId,
      marketplaceUrl: mp.marketplaceUrl
    });
  }

  // 5. 本机路径（.vsix / .json / .jsonc / 扩展目录）
  const resolvedPath = resolve(expandHome(source));
  let info;
  try {
    info = await stat(resolvedPath);
  } catch {
    if (/^https?:\/\//i.test(source)) {
      throw new RuntimeError(
        'UNSUPPORTED_VSCODE_URL',
        '仅支持 VS Code Marketplace 扩展链接（https://marketplace.visualstudio.com/items?itemName=publisher.extension）或 publisher.extension 标识',
        400
      );
    }
    throw new RuntimeError('VSCODE_PATH_NOT_FOUND', `找不到指定的主题路径：${resolvedPath}`, 404);
  }

  if (info.isDirectory()) {
    return parseLocalExtensionDirectory(resolvedPath);
  }

  const fileBuf = await readFile(resolvedPath);
  if (isZipBuffer(fileBuf) || /\.(?:vsix|zip)$/i.test(resolvedPath)) {
    return parseVsixBuffer(fileBuf, { sourceLabel: basename(resolvedPath), sourcePath: resolvedPath });
  }
  return parseSingleThemeFile(resolvedPath);
}
