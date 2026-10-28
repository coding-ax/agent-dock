/**
 * 飞书群名最大字符数（按 JS code unit 计）。调用方还会在后面拼 ` · AgentDock`，
 * 所以这里给会话标题留的额度比飞书上限小一截，避免整名被飞书静默截断。
 */
export const CHAT_NAME_MAX_CHARS = 40;

/** markdown 图片：`![alt](url)`——附件注入进来的形态，整段没有信息量。 */
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
/** 附件占位：飞书把非文本消息渲染成 `[图片]` / `[文件]` 这类标记。 */
const ATTACHMENT_PLACEHOLDER = /\[(?:图片|图像|文件|视频|语音|音频|表情|卡片|链接)\]/g;
/** 本地绝对路径：`/Users/...`、`/tmp/...`。只在「以 / 开头」的词上生效，`apps/web` 这种不会被误伤。 */
const ABSOLUTE_PATH = /(?:^|\s)\/[^\s]+/g;

/**
 * 把一段文本清洗成可以当飞书群名的短标题。
 *
 * 起因：会话标题兜底等于「首条 prompt 压平截断」。首条消息如果是附件（图片/文件/直接粘贴的
 * 路径），标题就变成 `[图片] /Users/xxx/a.png ![a.png](/Users/xxx/a.png)` 这种东西，
 * 而「托管给机器人」的默认群名正是接的会话标题——于是飞书群里出现一条路径当群名。
 *
 * 这里只做减法：去掉附件标记、markdown 图片和本地绝对路径，折叠空白、截断。清洗后可能为空
 * （整条标题都是附件/路径），调用方据此回退到别的兜底名，不要在这里编一个名字出来。
 */
export function cleanChatName(source: string | null | undefined, maxChars = CHAT_NAME_MAX_CHARS): string {
  const flat = (source ?? '')
    .replace(MARKDOWN_IMAGE, ' ')
    .replace(ATTACHMENT_PLACEHOLDER, ' ')
    .replace(ABSOLUTE_PATH, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, maxChars).trimEnd()}…`;
}
