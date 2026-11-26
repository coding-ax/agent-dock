# AgentDock 官网 · agent.xieguangping.win

AgentDock 的品牌站与交互式上手指南。位于主仓库 [coding-ax/agent-dock](https://github.com/coding-ax/agent-dock) 的 `agent-dock-site/` 独立子目录（不纳入根 pnpm workspace），是纯静态站点：Vite 8 + React 19 + TypeScript + Tailwind CSS 4 + motion。

- 首屏可复制的一键安装命令、漂浮的 Agent 图标
- 1:1 还原的 AgentDock 控制台演示：小猫派活、Agent 与模型、产物预览、定时任务四段自动播放，可暂停、重播
- 小猫主会话的完整生命周期：认领 → 拆活 → 派活 → 督办 → 验收 → 成长 → 换代（宽屏吸顶叙事，手机逐段展开）
- 飞书手机端演示、能力 Bento、架构图、四步上手、命令速查、FAQ
- 浅色 / 深色主题（默认跟随系统），中文 / English（默认中文，`?lang=en` 直达）
- 针对 390px 宽的手机单独排过版：零横向溢出，主要按钮触控区不小于 36px

## 本地开发

```bash
cd agent-dock-site
npm install
npm run dev          # http://127.0.0.1:5188
npm run build        # 类型检查 + 生产构建，输出到 dist/
npm run preview      # 预览生产构建：http://127.0.0.1:4488
npm run check:dist   # 部署前自检：必备文件、资源引用、疑似密钥、体积
```

## 部署

站点以 **Cloudflare Workers 静态资源**的形式部署，配置在 `wrangler.jsonc`：没有 Worker 脚本，`custom_domain` 会自动为 `agent.xieguangping.win` 创建 DNS 记录和证书。

```bash
wrangler login       # 只需一次
npm run deploy       # = build + check:dist + wrangler deploy
```

`public/_headers` 负责缓存策略：带哈希的 `/assets/*` 和字体长期缓存，图片缓存 7 天，HTML 走默认的回源校验。

想换别的托管也行，`dist/` 就是完整站点：

- Cloudflare Pages：`wrangler pages deploy dist --project-name agentdock-site`，再在控制台给项目绑定自定义域名
- Vercel / Netlify / Nginx：直接托管 `dist/`

## 目录

```
src/
  content.ts            全部文案（中英两份，结构一致）；标题里的 \n 是「优先换行点」
  lib/                  i18n、主题、Agent 图标表
  components/
    Hero.tsx            首屏与安装命令
    console/            控制台演示（四段脚本化场景）
    Agents.tsx          Agent 自动发现
    KittenStory.tsx     小猫生命周期叙事
    Lark.tsx            飞书手机端演示
    Features.tsx        能力 Bento
    Architecture.tsx    工作原理
    QuickStart.tsx      四步上手
    Docs.tsx            命令速查与文档入口
    Faq.tsx / Closing.tsx
public/
  companion/            小猫立绘：4 帧动图 WebP + 静态 PNG（减少动效时使用）
  agent-icons/          各家 Agent 图标（来源见目录内 README）
  brand/                像素 Logo、裁好的小猫头像与字标
  fonts/                Fira Code（SIL OFL 1.1）
  og.png                1200×630 社交分享图
scripts/
  crop-logo.mjs         从 Logo SVG 重新生成小猫头像与字标
  check-dist.mjs        部署前自检
```

## 设计约定

- 设计 token 与 AgentDock Web 控制台保持一致（主仓库 `apps/web/src/index.css`）：zinc 灰阶用 CSS 变量、深色主题整体反转，界面文字用 Fira Code，品牌橙 `#ec8a2c` / 深色 `#f2a24a`，标题用与 Logo 同款的硬边像素阴影。
- 主题存 `localStorage['agentdock-site:theme']`，语言存 `localStorage['agentdock-site:lang']`；`index.html` 里的内联脚本在首帧前就定好，切换不闪。
- 所有循环动画只在进入视口后播放；`prefers-reduced-motion` 下小猫换成静态图，场景直接展示结果。
- 改文案只需要动 `src/content.ts`，中英文两份必须保持同样的结构（类型会检查）。

## 素材来源

- 小猫立绘、像素 Logo、应用图标来自 AgentDock 主仓库（MIT，见 `public/brand/AGENTDOCK-LICENSE.txt`）。
- Agent 图标来自主仓库 `apps/web/public/agent-icons`，版权归各自所有者，仅用于标识对应产品。
- Fira Code 字体遵循 SIL Open Font License 1.1（`public/fonts/LICENSE`）。
