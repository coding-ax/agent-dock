import { describe, expect, it } from 'vitest';
import { CHAT_NAME_MAX_CHARS, cleanChatName } from './chat-name.js';

describe('cleanChatName', () => {
  it('把「[图片] + 路径 + markdown 图片」整条洗成空串，交给调用方兜底', () => {
    const title = '[图片] /Users/me/.agentdock/uploads/ses_abc/1792397012357-65b1ec43f312.png ![1792397012357-65b1ec43f312.png](/Users/me/.agentdock/uploads/ses_abc/1792397012357-65b1ec43f312.png)';
    expect(cleanChatName(title)).toBe('');
  });

  it('保留正文，只摘掉附件标记与路径', () => {
    const title = '[图片] /Users/me/tmp/shot.png 这个弹窗间距很丑，改一下';
    expect(cleanChatName(title)).toBe('这个弹窗间距很丑，改一下');
  });

  it('不误伤正文里带斜杠的普通词', () => {
    expect(cleanChatName('修复 apps/web 的 HandoverDialog 间距')).toBe('修复 apps/web 的 HandoverDialog 间距');
    expect(cleanChatName('看下 1/2 的进度')).toBe('看下 1/2 的进度');
  });

  it('折叠换行与连续空白', () => {
    expect(cleanChatName('第一行\n\n  第二行  ')).toBe('第一行 第二行');
  });

  it('超长截断并加省略号', () => {
    const result = cleanChatName('啊'.repeat(100));
    expect(result).toBe(`${'啊'.repeat(CHAT_NAME_MAX_CHARS)}…`);
  });

  it('空输入返回空串', () => {
    expect(cleanChatName(undefined)).toBe('');
    expect(cleanChatName('   ')).toBe('');
  });
});
