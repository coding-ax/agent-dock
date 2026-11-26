#!/usr/bin/env node
// 部署前自检：dist 结构完整、页面引用的静态资源都在、没有误打包的临时文件或疑似密钥。
// 用法：npm run build && npm run check:dist
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const dist = join(projectRoot, 'dist');
const errors = [];
const warnings = [];

if (!existsSync(dist)) {
  console.error('✗ dist/ 不存在，先运行 npm run build');
  process.exit(1);
}

const files = [];
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
};
walk(dist);
const urlOf = path => `/${relative(dist, path).split(sep).join('/')}`;
const present = new Set(files.map(urlOf));

// 1. 必备文件
const required = [
  '/index.html', '/og.png', '/favicon-32.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png',
  '/site.webmanifest', '/robots.txt', '/sitemap.xml', '/_headers',
  '/fonts/FiraCode-VF.woff2', '/brand/kitten-mark.svg', '/brand/wordmark-light.svg', '/brand/wordmark-dark.svg'
];
for (const url of required) if (!present.has(url)) errors.push(`缺少必备文件 ${url}`);

// 2. index.html 里引用的站内资源
const html = readFileSync(join(dist, 'index.html'), 'utf8');
if (!html.includes('<div id="root">')) errors.push('index.html 缺少 <div id="root">');
if (!/<script type="module"[^>]+src="\/assets\//.test(html)) errors.push('index.html 没有引用打包后的入口脚本');
for (const match of html.matchAll(/(?:src|href)="(\/[^"#?]*)"/g)) {
  const url = match[1];
  if (url !== '/' && !present.has(url)) errors.push(`index.html 引用了不存在的 ${url}`);
}

// 3. 小猫立绘（每种心情的动图 + 静态兜底）与 Agent 图标（以源码为准）
for (const mood of ['idle', 'happy', 'curious', 'sparkle', 'busy', 'search', 'sleepy']) {
  for (const ext of ['webp', 'png']) if (!present.has(`/companion/cat-${mood}.${ext}`)) errors.push(`缺少小猫立绘 /companion/cat-${mood}.${ext}`);
}
const agentsSource = readFileSync(join(projectRoot, 'src/lib/agents.ts'), 'utf8');
for (const match of agentsSource.matchAll(/icon\('([^']+)'\)/g)) {
  if (!present.has(`/agent-icons/${match[1]}`)) errors.push(`缺少 Agent 图标 /agent-icons/${match[1]}`);
}

// 4. 打包产物里写死的站内资源路径
const textFiles = files.filter(path => /\.(?:js|css|html|webmanifest|xml|txt)$/.test(path));
for (const path of textFiles) {
  const source = readFileSync(path, 'utf8');
  for (const match of source.matchAll(/["'(`](\/(?:companion|agent-icons|brand|fonts)\/[A-Za-z0-9._-]+\.[a-z0-9]+)["')`]/g)) {
    if (!present.has(match[1])) errors.push(`${urlOf(path)} 引用了不存在的 ${match[1]}`);
  }
  // 5. 疑似密钥 / 本机路径
  if (/(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(source)) {
    errors.push(`${urlOf(path)} 疑似包含密钥`);
  }
  if (/\/Users\/[A-Za-z0-9_-]+\//.test(source)) errors.push(`${urlOf(path)} 包含本机绝对路径`);
}

// 6. 不该上线的文件
for (const url of present) {
  if (/(?:^|\/)(?:__|\.env|\.DS_Store)/.test(url) || url.endsWith('.map')) errors.push(`不应发布的文件 ${url}`);
}

// 7. 体积
const sizeOf = path => statSync(path).size;
const kb = bytes => `${(bytes / 1024).toFixed(1)} KB`;
const total = files.reduce((sum, path) => sum + sizeOf(path), 0);
const scripts = files.filter(path => path.endsWith('.js'));
const styles = files.filter(path => path.endsWith('.css'));
const jsTotal = scripts.reduce((sum, path) => sum + sizeOf(path), 0);
for (const path of scripts) if (sizeOf(path) > 400 * 1024) warnings.push(`${urlOf(path)} 有 ${kb(sizeOf(path))}，偏大`);

console.log(`dist：${files.length} 个文件，共 ${kb(total)}`);
console.log(`  JS  ${scripts.length} 个，${kb(jsTotal)}（未压缩）`);
console.log(`  CSS ${styles.length} 个，${kb(styles.reduce((sum, path) => sum + sizeOf(path), 0))}`);
for (const warning of warnings) console.warn(`! ${warning}`);
if (errors.length) {
  for (const error of errors) console.error(`✗ ${error}`);
  process.exit(1);
}
console.log('✓ dist 自检通过');
