import { createInterface } from 'node:readline';
import { clearWebPassword, minWebPasswordLength, setWebPassword, webPasswordEnabled, webPasswordPath } from './web-password.js';

export interface PasswordSetOptions { stdin?: boolean }

/** 从 stdin 读一行（管道 / 脚本用）。 */
async function readLineFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
}

/** 终端里不回显地读密码。密码不走命令行参数：参数会进 shell 历史和 ps。 */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = rl as unknown as { _writeToOutput(text: string): void };
    let prompted = false;
    output._writeToOutput = text => { if (!prompted) { process.stdout.write(text); prompted = true; } };
    rl.on('SIGINT', () => { rl.close(); process.stdout.write('\n'); reject(new Error('已取消。')); });
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

export async function runPasswordSet(options: PasswordSetOptions = {}, path = webPasswordPath()): Promise<string> {
  let password: string;
  if (options.stdin || !process.stdin.isTTY) {
    password = await readLineFromStdin();
  } else {
    password = await promptHidden(`设置 Web 控制台访问密码（至少 ${minWebPasswordLength} 位）：`);
    const confirm = await promptHidden('再输入一次：');
    if (password !== confirm) throw new Error('两次输入不一致，未修改。');
  }
  setWebPassword(password, path);
  return `已设置访问密码（哈希保存在 ${path}）。立即生效，无需重启；打开控制台时输入密码即可进入。\n`;
}

export function runPasswordClear(path = webPasswordPath()): string {
  return clearWebPassword(path) ? '已清除访问密码，只能通过带凭证链接或本机直连进入控制台。\n' : '当前没有设置访问密码。\n';
}

export function runPasswordStatus(path = webPasswordPath()): string {
  return webPasswordEnabled(path)
    ? `访问密码：已设置（${path}）。\n`
    : '访问密码：未设置。可运行 agent-dock password set 设置，设置后在登录页输入密码即可进入控制台。\n';
}
