import type { Locale } from '@agent-dock/agent-dock-shared';
import type { AppDialogKind } from '../dialog-store';
import { getCurrentLocale, tWeb, type WebMessageKey } from '../i18n';

export type SettingsCategoryId = 'general' | 'agent' | 'automation' | 'lark' | 'notifications';

export type GeneralSubTab = 'overview' | 'theme-studio';
export type AgentSubTab = 'llm' | 'agents' | 'side-chat' | 'output-plugins' | 'schedules';
export type AutomationSubTab = 'assistant' | 'task-recovery';
export type LarkSubTab = 'bots' | 'regex' | 'avatar';

export type SettingsSubTab = GeneralSubTab | AgentSubTab | AutomationSubTab | LarkSubTab | 'main';

export interface SettingsNavigationTarget {
  category: SettingsCategoryId;
  subTab: SettingsSubTab;
}

export interface SettingsSubTabMeta {
  id: SettingsSubTab;
  label: string;
  mobileLabel?: string;
}

export interface SettingsCategoryMeta {
  id: SettingsCategoryId;
  label: string;
  mobileLabel: string;
  description: string;
  defaultSubTab: SettingsSubTab;
  subTabs: readonly SettingsSubTabMeta[];
}

interface RawSettingsSubTabMeta {
  id: SettingsSubTab;
  labelKey: WebMessageKey;
  mobileLabelKey: WebMessageKey;
}

interface RawSettingsCategoryMeta {
  id: SettingsCategoryId;
  labelKey: WebMessageKey;
  mobileLabelKey: WebMessageKey;
  descriptionKey: WebMessageKey;
  defaultSubTab: SettingsSubTab;
  subTabs: readonly RawSettingsSubTabMeta[];
}

const RAW_SETTINGS_CATEGORIES: readonly RawSettingsCategoryMeta[] = [
  {
    id: 'general',
    labelKey: 'settings.cat.general.label',
    mobileLabelKey: 'settings.cat.general.mobile',
    descriptionKey: 'settings.cat.general.desc',
    defaultSubTab: 'overview',
    subTabs: [
      { id: 'overview', labelKey: 'settings.sub.overview.label', mobileLabelKey: 'settings.sub.overview.mobile' },
      { id: 'theme-studio', labelKey: 'settings.sub.theme-studio.label', mobileLabelKey: 'settings.sub.theme-studio.mobile' }
    ]
  },
  {
    id: 'agent',
    labelKey: 'settings.cat.agent.label',
    mobileLabelKey: 'settings.cat.agent.mobile',
    descriptionKey: 'settings.cat.agent.desc',
    defaultSubTab: 'llm',
    subTabs: [
      { id: 'llm', labelKey: 'settings.sub.llm.label', mobileLabelKey: 'settings.sub.llm.mobile' },
      { id: 'agents', labelKey: 'settings.sub.agents.label', mobileLabelKey: 'settings.sub.agents.mobile' },
      { id: 'side-chat', labelKey: 'settings.sub.side-chat.label', mobileLabelKey: 'settings.sub.side-chat.mobile' },
      { id: 'output-plugins', labelKey: 'settings.sub.output-plugins.label', mobileLabelKey: 'settings.sub.output-plugins.mobile' },
      { id: 'schedules', labelKey: 'settings.sub.schedules.label', mobileLabelKey: 'settings.sub.schedules.mobile' }
    ]
  },
  {
    id: 'automation',
    labelKey: 'settings.cat.automation.label',
    mobileLabelKey: 'settings.cat.automation.mobile',
    descriptionKey: 'settings.cat.automation.desc',
    defaultSubTab: 'assistant',
    subTabs: [
      { id: 'assistant', labelKey: 'settings.sub.assistant.label', mobileLabelKey: 'settings.sub.assistant.mobile' },
      { id: 'task-recovery', labelKey: 'settings.sub.task-recovery.label', mobileLabelKey: 'settings.sub.task-recovery.mobile' }
    ]
  },
  {
    id: 'lark',
    labelKey: 'settings.cat.lark.label',
    mobileLabelKey: 'settings.cat.lark.mobile',
    descriptionKey: 'settings.cat.lark.desc',
    defaultSubTab: 'bots',
    subTabs: [
      { id: 'bots', labelKey: 'settings.sub.bots.label', mobileLabelKey: 'settings.sub.bots.mobile' },
      { id: 'regex', labelKey: 'settings.sub.regex.label', mobileLabelKey: 'settings.sub.regex.mobile' },
      { id: 'avatar', labelKey: 'settings.sub.avatar.label', mobileLabelKey: 'settings.sub.avatar.mobile' }
    ]
  },
  {
    id: 'notifications',
    labelKey: 'settings.cat.notifications.label',
    mobileLabelKey: 'settings.cat.notifications.mobile',
    descriptionKey: 'settings.cat.notifications.desc',
    defaultSubTab: 'main',
    subTabs: []
  }
];

export function getSettingsCategories(locale: Locale = getCurrentLocale()): readonly SettingsCategoryMeta[] {
  return RAW_SETTINGS_CATEGORIES.map(cat => ({
    id: cat.id,
    label: tWeb(cat.labelKey, undefined, locale),
    mobileLabel: tWeb(cat.mobileLabelKey, undefined, locale),
    description: tWeb(cat.descriptionKey, undefined, locale),
    defaultSubTab: cat.defaultSubTab,
    subTabs: cat.subTabs.map(sub => ({
      id: sub.id,
      label: tWeb(sub.labelKey, undefined, locale),
      mobileLabel: tWeb(sub.mobileLabelKey, undefined, locale)
    }))
  }));
}

export function getSettingsCategoryMap(locale: Locale = getCurrentLocale()): Readonly<Record<SettingsCategoryId, SettingsCategoryMeta>> {
  return Object.fromEntries(
    getSettingsCategories(locale).map(cat => [cat.id, cat])
  ) as Readonly<Record<SettingsCategoryId, SettingsCategoryMeta>>;
}

/** Default zh-CN category list (backward compatibility for static callers & tests). */
export const SETTINGS_CATEGORIES: readonly SettingsCategoryMeta[] = getSettingsCategories('zh-CN');

export const SETTINGS_CATEGORY_MAP: Readonly<Record<SettingsCategoryId, SettingsCategoryMeta>> = getSettingsCategoryMap('zh-CN');

export type SettingsQuickActionId = 'usage' | 'archived' | 'import' | 'share';

export interface SettingsSearchItem {
  id: string;
  title: string;
  description: string;
  category: SettingsCategoryId;
  subTab: SettingsSubTab;
  keywords: readonly string[];
  quickAction?: SettingsQuickActionId;
  requiresPwaVisible?: boolean;
}

interface RawSettingsSearchItem {
  id: string;
  titleKey: WebMessageKey;
  descriptionKey: WebMessageKey;
  category: SettingsCategoryId;
  subTab: SettingsSubTab;
  keywords: readonly string[];
  quickAction?: SettingsQuickActionId;
  requiresPwaVisible?: boolean;
}

const RAW_SETTINGS_SEARCH_ITEMS: readonly RawSettingsSearchItem[] = [
  // 1. General & Appearance
  {
    id: 'language-region',
    titleKey: 'settings.search.language.title',
    descriptionKey: 'settings.search.language.desc',
    category: 'general',
    subTab: 'overview',
    keywords: ['语言', '地区', '中文', '简体中文', '英文', '英语', '双语', '国际化', '跟随系统', 'yuyan', 'zhongwen', 'yingwen', 'yingyu', 'shuangyu', 'guojihua', 'yy', 'zw', 'yw', 'language', 'locale', 'region', 'english', 'chinese', 'zh', 'en', 'i18n', 'bilingual', 'system']
  },
  {
    id: 'appearance-mode',
    titleKey: 'settings.search.appearance.title',
    descriptionKey: 'settings.search.appearance.desc',
    category: 'general',
    subTab: 'overview',
    keywords: ['外观', '浅色', '深色', '暗黑', '亮色', '夜间', '跟随系统', 'waiguan', 'qianse', 'shense', 'anhei', 'liangse', 'yejian', 'gensuixitong', 'wg', 'qs', 'ss', 'theme', 'dark', 'light', 'mode', 'appearance']
  },
  {
    id: 'theme-studio',
    titleKey: 'settings.search.themeStudio.title',
    descriptionKey: 'settings.search.themeStudio.desc',
    category: 'general',
    subTab: 'theme-studio',
    keywords: ['主题', '工坊', '配色', '皮肤', '颜色', '画廊', '调色板', 'zhuti', 'zhutigongfang', 'gongfang', 'peise', 'pifu', 'yanse', 'tiaoseban', 'hualang', 'zt', 'ztgf', 'ps', 'vscode', 'vsix', 'wcag', 'tokyo', 'dracula', 'matcha', 'theme', 'studio', 'palette', 'color']
  },
  {
    id: 'autostart',
    titleKey: 'settings.search.autostart.title',
    descriptionKey: 'settings.search.autostart.desc',
    category: 'general',
    subTab: 'overview',
    keywords: ['开机', '自启', '登录启动', '启动项', 'kaiji', 'ziqi', 'kaijiziqi', 'qidong', 'kj', 'kjzq', 'launchd', 'autostart', 'startup', 'boot', 'login']
  },
  {
    id: 'keep-awake',
    titleKey: 'settings.search.keepAwake.title',
    descriptionKey: 'settings.search.keepAwake.desc',
    category: 'general',
    subTab: 'overview',
    keywords: ['永不休眠', '休眠', '屏幕常亮', '常亮', '熄屏', '电源', '防休眠', 'xiumian', 'yongbuxiumian', 'pingmuchangliang', 'changliang', 'xiping', 'dianyuan', 'ybxm', 'pmcl', 'xm', 'caffeinate', 'awake', 'display', 'sleep', 'power']
  },
  {
    id: 'pwa-install',
    titleKey: 'settings.search.pwaInstall.title',
    descriptionKey: 'settings.search.pwaInstall.desc',
    category: 'general',
    subTab: 'overview',
    keywords: ['安装', '桌面应用', 'pwa', '浏览器', '独立窗口', 'anzhuang', 'zhuomian', 'zhuomianyingyong', 'az', 'zm', 'install', 'desktop', 'app'],
    requiresPwaVisible: true
  },
  {
    id: 'version-update',
    titleKey: 'settings.search.versionUpdate.title',
    descriptionKey: 'settings.search.versionUpdate.desc',
    category: 'general',
    subTab: 'overview',
    keywords: ['版本', '更新', '升级', '检查更新', '新版', 'banben', 'gengxin', 'shengji', 'bb', 'gx', 'sj', 'version', 'update', 'upgrade', 'release']
  },
  {
    id: 'usage-dashboard',
    titleKey: 'settings.search.usage.title',
    descriptionKey: 'settings.search.usage.desc',
    category: 'general',
    subTab: 'overview',
    quickAction: 'usage',
    keywords: ['消耗', '看板', '用量', '费用', '额度', '统计', 'xiaohao', 'kanban', 'xiaohaokanban', 'yongliang', 'edu', 'xh', 'xhkb', 'token', 'usage', 'cost', 'quota', 'dashboard']
  },
  {
    id: 'archived-sessions',
    titleKey: 'settings.search.archived.title',
    descriptionKey: 'settings.search.archived.desc',
    category: 'general',
    subTab: 'overview',
    quickAction: 'archived',
    keywords: ['归档', '历史会话', '找回', '恢复会话', 'guidang', 'guidanghuihua', 'lishi', 'gd', 'gdhh', 'archived', 'archive', 'sessions']
  },
  {
    id: 'import-session',
    titleKey: 'settings.search.import.title',
    descriptionKey: 'settings.search.import.desc',
    category: 'general',
    subTab: 'overview',
    quickAction: 'import',
    keywords: ['导入', '外部会话', '历史', '迁移', 'daoru', 'waibuhuihua', 'dr', 'claude', 'codex', 'import', 'session']
  },
  {
    id: 'share-mobile',
    titleKey: 'settings.search.share.title',
    descriptionKey: 'settings.search.share.desc',
    category: 'general',
    subTab: 'overview',
    quickAction: 'share',
    keywords: ['手机', '扫码', '二维码', '移动端', '局域网', '访问', 'shouji', 'saoma', 'erweima', 'sj', 'sm', 'ewm', 'share', 'mobile', 'qr']
  },

  // 2. Agents & Capabilities
  {
    id: 'llm-endpoint',
    titleKey: 'settings.search.llm.title',
    descriptionKey: 'settings.search.llm.desc',
    category: 'agent',
    subTab: 'llm',
    keywords: ['模型', '端点', 'ai', '文本辅助', '优化', '润色', 'moxing', 'duandian', 'moxingduandian', 'wenbenfuzhu', 'runse', 'mx', 'dd', 'wbfz', 'api', 'key', 'base url', 'openai', 'anthropic', 'llm', 'endpoint', 'assist']
  },
  {
    id: 'agents-manage',
    titleKey: 'settings.search.agents.title',
    descriptionKey: 'settings.search.agents.desc',
    category: 'agent',
    subTab: 'agents',
    keywords: ['agent', '智能体', '内置', '自定义', '探测', '停用', '启用', 'zhinengti', 'zidingyi', 'tance', 'guanli', 'znt', 'claude', 'codex', 'cursor', 'opencode', 'cli']
  },
  {
    id: 'side-chat',
    titleKey: 'settings.search.sideChat.title',
    descriptionKey: 'settings.search.sideChat.desc',
    category: 'agent',
    subTab: 'side-chat',
    keywords: ['侧边对话', '侧边聊天', '副屏', 'btw', '快捷指令', 'cebian', 'cebianduihua', 'cebianliaotian', 'fuping', 'cb', 'cbdh', 'side', 'chat']
  },
  {
    id: 'output-plugins',
    titleKey: 'settings.search.outputPlugins.title',
    descriptionKey: 'settings.search.outputPlugins.desc',
    category: 'agent',
    subTab: 'output-plugins',
    keywords: ['交互插件', '插件中心', '询问卡', '确认卡', 'xml', '插件', 'chajian', 'jiaohuchajian', 'chajianzhongxin', 'xunwenka', 'querenka', 'cj', 'jhcj', 'askuserquestion', 'confirm', 'plugin', 'plugins', 'output']
  },
  {
    id: 'schedules',
    titleKey: 'settings.search.schedules.title',
    descriptionKey: 'settings.search.schedules.desc',
    category: 'agent',
    subTab: 'schedules',
    keywords: ['定时任务', '定时', '计划任务', '周期', 'cron', '巡检', '提醒', 'dingshi', 'dingshirenwu', 'jihuarenwu', 'zhouqi', 'ds', 'dsrw', 'schedule', 'schedules', 'timer']
  },

  // 3. Companion & Automation
  {
    id: 'assistant',
    titleKey: 'settings.search.assistant.title',
    descriptionKey: 'settings.search.assistant.desc',
    category: 'automation',
    subTab: 'assistant',
    keywords: ['小猫', '督办', '主会话', '认领', '改名', '便签', '交接', '退休', '生命周期', 'xiaomao', 'duban', 'xiaomaoyuduban', 'zhuhuihua', 'renling', 'bianqian', 'jiaojie', 'xm', 'db', 'xmdb', 'assistant', 'companion', 'cat', 'kitten', 'supervision']
  },
  {
    id: 'task-recovery',
    titleKey: 'settings.search.taskRecovery.title',
    descriptionKey: 'settings.search.taskRecovery.desc',
    category: 'automation',
    subTab: 'task-recovery',
    keywords: ['中断', '自动恢复', '恢复', '断点续跑', '重启', '护栏', '错峰', '确认卡', 'huifu', 'zidonghuifu', 'zhongduan', 'zhongduanhuifu', 'xupao', 'chongqi', 'hulan', 'hf', 'zdhf', 'zd', 'recovery', 'resume', 'restart', 'auto']
  },

  // 4. Lark & Collaboration
  {
    id: 'lark-bots',
    titleKey: 'settings.search.larkBots.title',
    descriptionKey: 'settings.search.larkBots.desc',
    category: 'lark',
    subTab: 'bots',
    keywords: ['飞书', '机器人', '长连接', '白名单', '门禁', 'hook', '静默回复', 'trace', '同步', 'feishu', 'jiqiren', 'feishujiqiren', 'baimingdan', 'menjin', 'fs', 'fsjqr', 'jqr', 'lark', 'bot', 'bots']
  },
  {
    id: 'lark-regex',
    titleKey: 'settings.search.larkRegex.title',
    descriptionKey: 'settings.search.larkRegex.desc',
    category: 'lark',
    subTab: 'regex',
    keywords: ['飞书', '群聊', '正则', '唤起', '自动触发', '补偿', '监听规则', 'feishu', 'qunliao', 'zhengze', 'huanqi', 'qunliaozhengze', 'buchang', 'fs', 'zz', 'qlzz', 'regex', 'trigger', 'lark']
  },
  {
    id: 'lark-avatar',
    titleKey: 'settings.search.larkAvatar.title',
    descriptionKey: 'settings.search.larkAvatar.desc',
    category: 'lark',
    subTab: 'avatar',
    keywords: ['飞书', '替身', '分身', '私聊', '草稿', '表情', '转发', 'feishu', 'tishen', 'feishutishen', 'fenshen', 'siliao', 'caogao', 'biaoqing', 'fs', 'ts', 'fsts', 'avatar', 'lark']
  },

  // 5. Notifications
  {
    id: 'notifications',
    titleKey: 'settings.search.notifications.title',
    descriptionKey: 'settings.search.notifications.desc',
    category: 'notifications',
    subTab: 'main',
    keywords: ['通知', '提醒', '渠道', '降噪', '弹窗', '提示音', '声音', '飞书推送', 'webhook', '钉钉', '企微', 'bark', 'ntfy', 'slack', 'discord', 'shell', 'hook', 'tongzhi', 'tixing', 'qudao', 'jiangzao', 'tanchuang', 'tishiyin', 'shengyin', 'tz', 'tx', 'tzqd', 'notification', 'notifications', 'notify', 'alert']
  }
];

export function getSettingsSearchItems(locale: Locale = getCurrentLocale()): readonly SettingsSearchItem[] {
  return RAW_SETTINGS_SEARCH_ITEMS.map(item => ({
    id: item.id,
    title: tWeb(item.titleKey, undefined, locale),
    description: tWeb(item.descriptionKey, undefined, locale),
    category: item.category,
    subTab: item.subTab,
    keywords: item.keywords,
    ...(item.quickAction ? { quickAction: item.quickAction } : {}),
    ...(item.requiresPwaVisible ? { requiresPwaVisible: item.requiresPwaVisible } : {})
  }));
}

export const SETTINGS_SEARCH_ITEMS: readonly SettingsSearchItem[] = getSettingsSearchItems('zh-CN');

const SUGGESTED_TAG_KEYS: readonly WebMessageKey[] = [
  'settings.tag.language',
  'settings.tag.themeStudio',
  'settings.tag.llm',
  'settings.tag.plugins',
  'settings.tag.schedules',
  'settings.tag.recovery',
  'settings.tag.larkRegex',
  'settings.tag.webhook'
];

export function getSuggestedSearchTags(locale: Locale = getCurrentLocale()): readonly string[] {
  return SUGGESTED_TAG_KEYS.map(key => tWeb(key, undefined, locale));
}

export const SUGGESTED_SEARCH_TAGS = getSuggestedSearchTags('zh-CN');

export function normalizeSettingsTarget(
  category: SettingsCategoryId = 'general',
  subTab?: SettingsSubTab
): SettingsNavigationTarget {
  const meta = SETTINGS_CATEGORY_MAP[category] ?? SETTINGS_CATEGORY_MAP.general;
  if (!subTab) return { category: meta.id, subTab: meta.defaultSubTab };
  if (meta.subTabs.length === 0) return { category: meta.id, subTab: meta.defaultSubTab };
  const matched = meta.subTabs.some(item => item.id === subTab);
  return { category: meta.id, subTab: matched ? subTab : meta.defaultSubTab };
}

export function resolveDialogKindToSettingsTarget(
  kind: AppDialogKind,
  options?: { sessionId?: string; settingsCategory?: SettingsCategoryId; settingsSubTab?: SettingsSubTab }
): SettingsNavigationTarget | null {
  switch (kind) {
    case 'settings':
      return normalizeSettingsTarget(options?.settingsCategory ?? 'general', options?.settingsSubTab);
    case 'theme-studio':
      return { category: 'general', subTab: 'theme-studio' };
    case 'agent':
      return { category: 'agent', subTab: 'llm' };
    case 'side-chat':
      return { category: 'agent', subTab: 'side-chat' };
    case 'output-plugins':
      return { category: 'agent', subTab: 'output-plugins' };
    case 'schedule':
      return options?.sessionId ? null : { category: 'agent', subTab: 'schedules' };
    case 'assistant':
      return { category: 'automation', subTab: 'assistant' };
    case 'task-recovery':
      return { category: 'automation', subTab: 'task-recovery' };
    case 'lark':
      return { category: 'lark', subTab: 'bots' };
    case 'lark-regex':
      return { category: 'lark', subTab: 'regex' };
    case 'lark-avatar':
      return { category: 'lark', subTab: 'avatar' };
    case 'notifications':
      return { category: 'notifications', subTab: 'main' };
    default:
      return null;
  }
}

export interface SearchSettingsOptions {
  showPwaInstall?: boolean;
  locale?: Locale;
}

/**
 * Bilingual keyword search & ranking:
 * Matches Chinese, English, and Pinyin tokens regardless of active display locale
 * (searching "飞书" or "语言" in English UI, or "lark" / "language" in Chinese UI both work),
 * returning items localized in `options.locale ?? getCurrentLocale()`.
 */
export function searchSettingsItems(
  rawQuery: string,
  options: SearchSettingsOptions = {}
): SettingsSearchItem[] {
  const showPwaInstall = options.showPwaInstall ?? true;
  const displayLocale = options.locale ?? getCurrentLocale();
  const trimmed = rawQuery.trim().toLowerCase();
  if (!trimmed) return [];

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const scored: Array<{ item: SettingsSearchItem; score: number }> = [];
  const zhCatMap = getSettingsCategoryMap('zh-CN');
  const enCatMap = getSettingsCategoryMap('en-US');

  for (const raw of RAW_SETTINGS_SEARCH_ITEMS) {
    if (raw.requiresPwaVisible && !showPwaInstall) continue;

    const zhTitle = tWeb(raw.titleKey, undefined, 'zh-CN');
    const enTitle = tWeb(raw.titleKey, undefined, 'en-US');
    const zhDesc = tWeb(raw.descriptionKey, undefined, 'zh-CN');
    const enDesc = tWeb(raw.descriptionKey, undefined, 'en-US');
    const zhCat = zhCatMap[raw.category].label;
    const enCat = enCatMap[raw.category].label;

    const titleLower = `${zhTitle} ${enTitle}`.toLowerCase();
    const activeTitleLower = (displayLocale === 'en-US' ? enTitle : zhTitle).toLowerCase();
    const descLower = `${zhDesc} ${enDesc}`.toLowerCase();
    const catLower = `${zhCat} ${enCat}`.toLowerCase();
    const kwJoined = raw.keywords.join(' ').toLowerCase();
    const haystack = `${titleLower} ${descLower} ${catLower} ${kwJoined}`;

    if (!tokens.every(token => haystack.includes(token))) continue;

    let score = 0;
    const zhTitleLower = zhTitle.toLowerCase();
    const enTitleLower = enTitle.toLowerCase();
    if (activeTitleLower === trimmed || zhTitleLower === trimmed || enTitleLower === trimmed) score += 100;
    else if (activeTitleLower.startsWith(trimmed) || zhTitleLower.startsWith(trimmed) || enTitleLower.startsWith(trimmed)) score += 60;
    else if (titleLower.includes(trimmed)) score += 40;

    for (const token of tokens) {
      if (titleLower.includes(token)) score += 20;
      else if (raw.keywords.some(kw => kw.toLowerCase() === token)) score += 16;
      else if (raw.keywords.some(kw => kw.toLowerCase().includes(token))) score += 12;
      else if (catLower.includes(token)) score += 8;
      else if (descLower.includes(token)) score += 6;
    }

    scored.push({
      item: {
        id: raw.id,
        title: displayLocale === 'en-US' ? enTitle : zhTitle,
        description: displayLocale === 'en-US' ? enDesc : zhDesc,
        category: raw.category,
        subTab: raw.subTab,
        keywords: raw.keywords,
        ...(raw.quickAction ? { quickAction: raw.quickAction } : {}),
        ...(raw.requiresPwaVisible ? { requiresPwaVisible: raw.requiresPwaVisible } : {})
      },
      score
    });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.item);
}
