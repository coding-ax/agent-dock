/**
 * 全站文案（中文默认 + 英文）。产品事实全部来自 agent-dock 仓库的 README / README_zh 与网页端真实文案，
 * 不编造数据、不编造用户评价。
 */
export type Lang = 'zh' | 'en';

export const LINKS = {
  github: 'https://github.com/coding-ax/agent-dock',
  releases: 'https://github.com/coding-ax/agent-dock/releases',
  npm: 'https://www.npmjs.com/package/@agent-dock/cli',
  issues: 'https://github.com/coding-ax/agent-dock/issues',
  license: 'https://github.com/coding-ax/agent-dock/blob/main/LICENSE',
  contributing: 'https://github.com/coding-ax/agent-dock/blob/main/AGENTS.md',
  desktop: 'https://github.com/coding-ax/agent-dock/blob/main/apps/desktop/README.md',
  readmeZh: 'https://github.com/coding-ax/agent-dock/blob/main/README_zh.md',
  readmeEn: 'https://github.com/coding-ax/agent-dock/blob/main/README.md',
  guide: 'https://github.com/coding-ax/agent-dock/blob/main/README_zh.md#完整使用手册',
  api: 'https://github.com/coding-ax/agent-dock/blob/main/README_zh.md#服务化接入',
  lark: 'https://github.com/coding-ax/agent-dock/blob/main/README_zh.md#飞书接入',
  agents: 'https://github.com/coding-ax/agent-dock/blob/main/README_zh.md#agent-发现与自定义-agent',
  cli: 'https://github.com/coding-ax/agent-dock/blob/main/README_zh.md#命令行速查',
  acp: 'https://agentclientprotocol.com'
} as const;

export const INSTALL = {
  one: 'npm i -g @agent-dock/cli && agent-dock start',
  lines: ['npm i -g @agent-dock/cli', 'agent-dock start']
} as const;

export const VERSION = '0.3.21';

const zh = {
  meta: {
    title: 'AgentDock · 认领一只小猫，替你指挥所有 Agent',
    description: 'AgentDock 是开源的本地 Agent 工作台：统一托管 Claude Code、Codex、Gemini、Cursor 等 ACP Agent，小猫主会话替你拆活、派活、督办、验收；飞书 @ 一下、Web 里说一句，过程实时可见。'
  },
  nav: {
    links: [
      { id: 'demo', label: '演示' },
      { id: 'kitten', label: '小猫' },
      { id: 'lark', label: '飞书' },
      { id: 'features', label: '能力' },
      { id: 'start', label: '上手' },
      { id: 'docs', label: '文档' }
    ],
    github: 'GitHub',
    cta: '开始使用',
    themeLight: '切换到浅色',
    themeDark: '切换到深色',
    lang: 'EN',
    langLabel: 'Switch to English',
    menu: '菜单',
    close: '关闭'
  },
  hero: {
    badgeTag: `v${VERSION}`,
    badge: '定时任务随小猫换代自动跟随',
    titleA: '认领一只小猫，',
    titleB1: '替你指挥',
    titleB2: '所有 Agent。',
    sub: 'AgentDock 把 Claude Code、Codex、Gemini、Cursor 等本机 Agent 托管成常驻服务。小猫主会话替你拆活、派活、督办、验收——飞书 @ 一下、Web 里说一句，过程实时可见。',
    copy: '复制安装命令',
    copied: '已复制',
    desktop: '下载桌面版',
    github: '在 GitHub 查看',
    facts: ['Node.js 22.13+', 'macOS · Windows 桌面版', 'MIT 开源', '数据只在你的电脑上'],
    peek: '喵～带我回家吧？',
    peekHover: '喵！要试试吗？'
  },
  demo: {
    kicker: '交互演示',
    title: '一个控制台，\n看清每一步。',
    sub: '下面是按真实界面复刻的 AgentDock 控制台。挑一个场景，看小猫怎么把一句话变成几张便签、几个 Agent 和一份验收报告。',
    tabs: [
      { id: 'dispatch', label: '小猫派活', short: '小猫派活', hint: '拆便签 · 派侧边会话 · 督办 · 验收' },
      { id: 'switch', label: 'Agent 与模型', short: 'Agent 与模型', hint: '自动发现 · 动态模型 · 推理强度' },
      { id: 'artifacts', label: '产物预览', short: '产物预览', hint: '行号定位 · 图片视频 · 划词引用' },
      { id: 'schedule', label: '定时任务', short: '定时任务', hint: 'cron · 换代自动跟随' }
    ],
    replay: '重播',
    pause: '暂停',
    play: '播放',
    url: '127.0.0.1:4310',
    rail: {
      newChat: '新建对话',
      search: '搜索会话',
      sessions: '会话列表',
      byTime: '时间',
      byProject: '项目',
      today: '今天',
      settings: '设置',
      lark: '飞书 · 研发群',
      baseline: [
        { title: '升级 acpx 到 0.20.0', agent: 'codex', time: '18 分钟' },
        { title: '排查 TPS 计算偏差', agent: 'claude', time: '42 分钟' },
        { title: '给定时任务补测试', agent: 'codex', time: '1 小时' },
        { title: '调研 SQLite 原生依赖崩溃', agent: 'antigravity', time: '2 小时' },
        { title: '整理飞书群协作权限清单', agent: 'claude', time: '3 小时' },
        { title: '首页移动端适配', agent: 'cursor', time: '5 小时' }
      ],
      justNow: '刚刚'
    },
    cat: { name: '团子', main: '主会话', gen1: '第 1 代 · 幼猫', gen1Old: '第 1 代 · 老年', gen2: '第 2 代 · 幼猫', name2: '团子二世' },
    status: {
      idle: '在等你派活',
      thinking: '正在拆便签…',
      dispatched: '3 张便签进行中',
      reviewing: '正在验收…',
      done: '3 张便签已验收'
    },
    chips: { review: '待验收', running: '进行中', notes: '便签', retire: '退休' },
    composer: {
      placeholderMain: '跟团子说说要做什么，Enter 发送；它会拆成便签派出去',
      placeholderHome: '输入消息，Enter 发送；/ 选择 Skill 或命令，可粘贴/拖入文件',
      quoteFollow: '这里的校验再加个手机号格式'
    },
    dispatch: {
      prompt: '把登录页按新设计重构，顺手修掉飞书卡片超长被截断的问题，再出一份 v0.4 发布说明。',
      processed: (s: number, n: number) => `已处理 ${s} 秒 · ${n} 步`,
      reply: '收到！拆成 3 张便签，分头派出去：',
      notes: [
        { title: '登录页按新设计重构', agent: 'Codex', model: 'gpt-6.1-sol', cwd: 'web' },
        { title: '飞书卡片超长截断', agent: 'Claude Code', model: 'Opus 5.5', cwd: 'server' },
        { title: 'v0.4 发布说明', agent: 'Antigravity', model: 'Gemini 4 Neon', cwd: 'docs' }
      ],
      tool: 'agent-dock task start',
      systemRound: '系统自动开了一轮 · 督办',
      systemBadge: '系统轮次',
      systemDesc: 'daemon 在侧边会话完成后自动注入，不是用户消息',
      reviewing: '3 个侧边会话都交回来了，逐条验收：',
      verdictOk: '验收通过',
      verdictRework: '打回返工',
      reworkNote: '缺少 390px 截图，补齐再交',
      final: '3 张便签全部验收通过。截图、测试结果和 PR 链接都附在便签里，也同步到了飞书群。',
      status: { running: '进行中', review: '待验收', done: '已验收' },
      legend: { running: '进行中', review: '待验收', done: '已验收' }
    },
    switch: {
      agentHeader: '自动发现 · 只列出本机已安装',
      modelHeader: '动态发现 · 来自 ACP',
      effort: '推理强度',
      cwd: 'my-app',
      toast: '新对话将使用 Codex · gpt-6.1-sol · high',
      notInstalled: '未安装',
      greeting: '有什么要做的？',
      newChat: '新对话',
      handTo: '交给团子'
    },
    artifacts: {
      ask: '登录页改完了吗？给我看看效果。',
      replyA: '改好了。关键改动在 ',
      replyB: '，截图在 ',
      replyC: '，录了一段演示 ',
      replyD: '。表单校验现在统一走 zod，错误提示会贴着输入框显示。',
      quote: '表单校验现在统一走 zod',
      quoteBtn: '引用',
      preview: '预览',
      lines: 'L42-L58',
      imageTitle: '欢迎回来',
      imageSub: '登录以继续使用 AgentDock',
      email: '邮箱',
      password: '密码',
      signIn: '登录',
      range: '按 Range 流式播放'
    },
    schedule: {
      title: '定时任务',
      name: '工作日早报',
      prompt: '汇总昨天的告警和还没收尾的便签',
      cron: '0 9 * * 1-5',
      cronHuman: '工作日 09:00',
      every: '每 45 分钟',
      second: '检查发布状态',
      target: '跟随当前主会话',
      targetHint: '换代自动跟随',
      next: '下次运行',
      nextValue: '明天 09:00',
      save: '保存',
      handoff: '新猫团子二世接班啦，喵！',
      tired: '团子有点累了，要不要交接给下一代？',
      migrated: '已跟到第 2 代',
      ceremony: ['打包交接包', '新猫出生', '便签交接', '换主会话', '老猫退休', '交接说明'],
      ceremonyTitle: '交接仪式',
      cli: 'agent-dock schedule add "汇总昨天的告警" --cron "0 9 * * 1-5" --name "工作日早报"',
      ask: '以后每个工作日早上 9 点，帮我汇总一下前一天的告警。',
      answer: '好～我建一个「工作日早报」，目标设成跟随主会话，以后换代也不会丢。',
      fields: { name: '名称', prompt: '内容', when: '频率', target: '发给', other: '指定会话' },
      cronTab: 'cron',
      everyTab: '间隔'
    }
  },
  agents: {
    kicker: 'Agent 自动发现',
    title: '装了哪些 Agent，\n它就认识哪些。',
    sub: '启动时读取 ACPX 内置注册表，逐个检查本机 CLI，只列出真正装好的。模型列表通过 ACP 动态发现；新对话里挑 Agent，会话中随时换模型和推理强度。',
    points: [
      { title: '只讲 ACP', body: '不内嵌任何供应商 SDK。固定版本的 acpx 负责握手、持久会话、重连与权限请求。' },
      { title: '模型动态发现', body: '模型和推理强度从 Agent 实时拉取；反代模型可以用 extraModels 手动补充。' },
      { title: '接入任意 Agent', body: '用 AGENTDOCK_AGENTS_JSON 声明自定义 ACP 服务，命令可用时自动纳入。' },
      { title: '默认全允许', body: '会话默认 full-trust（全允许）以无阻塞执行；高危命令可通过正则门禁拦截，并配成员白名单控制。' }
    ],
    more: '以及任何讲 ACP 的 Agent'
  },
  kitten: {
    kicker: '小猫伴侣',
    title: '主会话，\n是一只会长大的小猫。',
    sub: '认领后它就是你的主会话：你说要做什么，它派侧边会话去干、盯进度、做完帮你验收，每件事都贴成便签。',
    steps: [
      { key: 'adopt', label: '认领', title: '喵～带我回家吧？', body: '在首页认领一只小猫：给它起个名字，选它用哪个 Agent 思考、思考多深、常驻在哪个目录。从此它就是你的主会话。', bubble: '喵～带我回家吧？' },
      { key: 'split', label: '拆活', title: '你只管说需求。', body: '一句话丢给小猫，它把需求拆成一张张便签：每张有标题、验收标准和执行目录，贴在屏幕右边，随时划出来看。', bubble: '收到！拆成 3 张便签～' },
      { key: 'dispatch', label: '派活', title: '派给最合适的 Agent。', body: '每张便签交给一个侧边会话。Codex 改前端、Claude Code 修后端、Antigravity 写文档——不同 Agent、不同目录，并行开工。', bubble: '分头派出去啦，我盯着' },
      { key: 'supervise', label: '督办', title: '它会自己盯进度。', body: '侧边会话一交回来，daemon 就自动开一轮「督办」把小猫叫醒：卡住了就追问，跑偏了就纠正，你不用守在屏幕前。', bubble: '夜深了～我在盯着 2 张便签，有进展会叫你' },
      { key: 'review', label: '验收', title: '有证据才算完成。', body: '小猫逐条验收：测试、截图、日志都要对得上。不达标就「打回返工」，要求追加回原便签；全部通过才来找你。', bubble: '3 张便签都验收通过！' },
      { key: 'age', label: '成长', title: '它会长大，也会变老。', body: '主会话的轮次和上下文压缩越攒越多，小猫就从幼猫长成老猫。年纪越大越该整理记忆——它会主动提醒你。', bubble: '团子有点累了，要不要交接给下一代？' },
      { key: 'handoff', label: '换代', title: '新猫出生，接着干。', body: '发起交接后，老猫打包交接包，新猫出生并接手没做完的便签、watch 和定时任务。任何一步失败都会自动回滚，旧主会话完好。', bubble: '新猫团子二世接班啦，喵！' }
    ],
    stages: [
      { key: 'kitten', label: '幼猫', blurb: '刚接班，精神满满，什么都想试试' },
      { key: 'adult', label: '成年', blurb: '状态正好，派活验收都利索' },
      { key: 'senior', label: '资深', blurb: '经验老到，就是记忆有点沉了' },
      { key: 'elder', label: '老年', blurb: '有点累了，该考虑交接给下一代' }
    ],
    metrics: [
      { label: '主会话轮次', value: '412' },
      { label: '上下文压缩', value: '7 次' },
      { label: '上下文用量', value: '83%' }
    ],
    adopt: { nameLabel: '给它起个名字', name: '团子', agentLabel: '它用哪个 Agent 思考', agent: 'Claude Code', depth: '思考深度', depthValue: 'high', cta: '带它回家' },
    ceremony: ['打包交接包', '新猫出生', '便签交接', '换主会话', '老猫退休', '交接说明'],
    sessions: ['登录页按新设计重构', '飞书卡片超长截断', 'v0.4 发布说明'],
    systemRound: '系统自动开了一轮 · 督办',
    systemDesc: 'daemon 在侧边会话完成后自动注入',
    verdicts: { ok: '验收通过', rework: '打回返工' },
    stepOf: (i: number, n: number) => `${String(i).padStart(2, '0')} / ${String(n).padStart(2, '0')}`
  },
  lark: {
    kicker: '飞书机器人',
    title: '手机上 @ 一下，\n家里的电脑就开工。',
    sub: '私聊或在群里 @ 机器人：先回一个表情，再发一张「正在思考中」卡片，Agent 的过程和结果持续覆盖同一张卡片。人在地铁上，活在家里跑。',
    features: [
      { title: '扫码创建机器人', body: '左下角「飞书设置」→「扫码创建机器人」，飞书扫码授权，选好工作区和 Agent 就能用。' },
      { title: '话题侧聊 /btw', body: '在话题里发 /btw，另开一条侧聊处理岔开的问题，不打断主线任务。' },
      { title: '多 Agent 群协作', body: '多个机器人在同一个群里互相发现、读消息、@ 交接；写入权限默认关闭。' },
      { title: '卡片可中断、可重试', body: '运行中点「中断」，失败或取消后点「重试」，复用同一个会话。' },
      { title: '高危门禁与白名单', body: '高危命令按正则拦截，成员白名单填真实姓名，都在界面里配。' }
    ],
    phone: {
      group: '研发群',
      members: '8',
      me: '我',
      ask: '@AgentDock 线上登录接口偶发 500，帮我查一下',
      bot: 'AgentDock',
      agent: 'Claude Code',
      thinking: '正在思考中…',
      running: '运行中',
      done: '已完成',
      interrupt: '中断',
      trace: ['读取 logs/api-2026-11-25.log', '检索 session.ts 的过期判断', '运行 pnpm test auth'],
      result: '根因：会话过期判断用了服务器本地时区，跨零点会误判。已修复并补了 2 个测试，PR #128 等你看。',
      elapsed: '耗时 48 秒',
      thread: '/btw 顺手把告警阈值调到 5 分钟',
      threadReply: '好的，开了一条侧聊去处理 ↗',
      input: '发送给 研发群'
    }
  },
  features: {
    kicker: '工作台细节',
    title: '为长时间托管\n打磨的每个细节。',
    sub: '流式 Markdown、工具调用、权限请求、终端输出全部落在本地 SQLite：可回放、可续传、手机扫码接着聊。',
    cards: {
      artifacts: { title: '产物实时预览', body: 'Agent 生成的图片、视频、音频、Markdown 点开就看；大文件按 Range 流式播放。' },
      lines: { title: '代码行号定位', body: '回复里的 file.ts#L14-L16 一点直达，高亮到行。' },
      quote: { title: '划词引用回复', body: '选中回复里任意一段，引用它继续追问。' },
      schedule: { title: '跟着小猫走的定时任务', body: 'cron 或 --every 45m；目标设为「跟随主会话」，小猫换代后自动跟到新猫身上。' },
      queue: { title: '排队 · 插队 · 重试', body: 'Agent 忙时新消息先排队，也可以中断当前轮次立即发送。' },
      mobile: { title: '扫码接着聊', body: '侧栏扫码，手机接着聊。二维码等同登录凭证，别转发。' },
      guard: { title: '门禁与白名单', body: '高危操作拦截、成员白名单、控制台密码，都在界面里配。' },
      api: { title: 'HTTP + SSE 接口', body: '完整的会话、队列、权限 API，SSE 断线可续传，能当上层多 Agent 平台的执行底座。' },
      rsi: { title: '递归自我改进', body: 'agent-dock dev up 起隔离沙箱，Agent 改进 AgentDock 自身并端到端验证，绝不重启自己所在的 daemon。' }
    },
    labels: {
      queued: '排队中',
      steer: '插队执行',
      running: '执行中',
      retry: '重试',
      blocked: '已拦截，等待授权',
      allowed: '白名单',
      scan: '手机扫码访问',
      lan: '局域网',
      quote: '引用',
      daily: '工作日早报',
      follow: '跟随当前主会话',
      gen: (n: number) => `第 ${n} 代`
    }
  },
  arch: {
    kicker: '工作原理',
    title: '不内嵌任何 SDK，\n只讲 ACP。',
    sub: '固定版本的 acpx 运行时负责 ACP 握手、持久会话、重连、流式输出与权限请求；AgentDock 负责产品状态、标准化事件、存储、API 与通道。只要你的 Agent 讲 ACP，就能接进来。',
    inputs: ['飞书 / Lark', 'Web 控制台', 'HTTP + SSE', '定时任务'],
    core: 'AgentDock 运行时',
    coreItems: ['会话与队列', '小猫主会话', '权限与门禁', '标准化事件'],
    store: 'SQLite · 全部可回放',
    runtime: 'acpx',
    outputs: ['Claude Code', 'Codex', 'Gemini', 'Cursor', '…'],
    warn: '默认监听 0.0.0.0，局域网可访问；控制台只有一层「所有者」凭证。只想本机用加 --local-only，对外暴露务必在前面加 HTTPS 和身份认证。'
  },
  start: {
    kicker: '快速上手',
    title: '四步，\n把小猫带回家。',
    sub: '从安装到认领第一只小猫，十分钟以内。',
    prev: '上一步',
    next: '下一步',
    done: '去 GitHub 看完整手册',
    steps: [
      {
        key: 'install',
        label: '安装',
        title: '一条命令装好，后台常驻。',
        body: '需要 Node.js 22.13+。全局安装 CLI，在你的项目目录里启动后台服务，然后打开浏览器。',
        code: ['npm i -g @agent-dock/cli@latest', 'cd /path/to/your/project', 'agent-dock start      # 后台启动，打开 http://127.0.0.1:4310'],
        tips: ['agent-dock status 查看 PID、地址和日志路径', 'macOS 可用 agent-dock autostart enable 开机自启', '不想装 Node？直接下载 macOS / Windows 桌面版']
      },
      {
        key: 'agents',
        label: '配 Agent',
        title: '装好你常用的 Agent CLI。',
        body: 'Claude Code、Codex、Gemini、Cursor、Antigravity……装好并登录，AgentDock 启动时自动发现，模型列表实时拉取。',
        code: ['agent-dock acpx agents list --json   # 看看都发现了谁', 'curl http://127.0.0.1:4310/api/agents'],
        tips: ['只有本机真装了 CLI 的 Agent 才会出现', '自定义 ACP 服务用 AGENTDOCK_AGENTS_JSON 接入', '会话默认 full-trust（全允许）无阻塞执行，可配合高危命令正则门禁使用']
      },
      {
        key: 'lark',
        label: '接飞书',
        title: '扫个码，飞书里就能 @ 它。',
        body: '打开左下角「飞书设置」→「扫码创建机器人」，用飞书扫码授权，再选好工作区和 Agent。之后私聊机器人，或在群里 @ 它。',
        code: ["agent-dock lark send '**构建完成**' --task-id release-42   # 命令行也能发卡片"],
        tips: ['群协作与写入开关默认关闭，需要管理员显式开启', '临时停掉监听：agent-dock --no-lark-listen', '权限清单与高危门禁见完整手册 · 飞书接入']
      },
      {
        key: 'adopt',
        label: '认领小猫',
        title: '认领一只小猫，从此只管说。',
        body: '在首页认领一只小猫，给它起名、选 Agent。之后把需求丢给它：拆便签、派侧边会话、督办、验收，它全包了。',
        code: ['agent-dock main set --agent claude --name 团子   # 命令行认领', 'agent-dock schedule add "汇总昨天的告警" --cron "0 9 * * 1-5" --name "工作日早报"'],
        tips: ['派活、验收和 watch 都有 CLI：agent-dock task|watch|notify -h', '定时任务目标可设为「跟随主会话」', '小猫老了会主动提醒你交接']
      }
    ]
  },
  docs: {
    kicker: '文档',
    title: '命令行速查',
    sub: '每条命令的完整参数见 agent-dock <命令> --help，完整手册在 GitHub。',
    tabs: [
      { id: 'service', label: '服务', short: '服务', code: ['agent-dock start        # 后台启动', 'agent-dock status       # PID、地址、日志路径', 'agent-dock restart', 'agent-dock stop', 'agent-dock update       # 更新并重启后台服务', 'agent-dock              # 不带子命令：前台运行', 'agent-dock --local-only # 只允许本机访问'] },
      { id: 'schedule', label: '定时任务', short: '定时任务', code: ['agent-dock schedule add "汇总昨天的告警" --cron "0 9 * * 1-5" --name "工作日早报"', 'agent-dock schedule add "检查发布状态" --every 45m', 'agent-dock schedule list | show | pause | resume | run | remove <schedule-id>'] },
      { id: 'session', label: '会话', short: '会话', code: ['agent-dock session peers', 'agent-dock session show <session-id>', 'agent-dock session send <session-id> "消息" [--mode interrupt]', 'agent-dock main set --agent claude --name 团子'] },
      { id: 'lark', label: '飞书', short: '飞书', code: ["agent-dock lark send '**构建完成**' --task-id release-42", 'agent-dock lark message send --chat oc_xxx --text "部署完成"', 'agent-dock lark message read --chat oc_xxx --limit 20', 'agent-dock group peers', "agent-dock group send '请检查这个接口' --to cli_peer"] },
      { id: 'api', label: 'HTTP API', short: 'HTTP API', code: ['GET  /health                       # {"ok":true}', 'GET  /api/agents                   # 已发现的 Agent', 'POST /api/sessions                 # 创建会话，必填 agentId', 'POST /api/sessions/:id/send        # 202：进了队列，不等于完成', 'GET  /api/sessions/:id/stream      # SSE，断线带 Last-Event-ID 续传', 'POST /api/sessions/:id/permissions/:permissionId'] }
    ],
    cards: [
      { title: '完整使用手册', body: '安装、Web 工作台、飞书、门禁、生命周期与存储。', href: LINKS.guide },
      { title: 'HTTP API', body: '会话生命周期、排队与抢占、事件与 SSE、权限请求。', href: LINKS.api },
      { title: '飞书接入', body: '扫码建机器人、权限清单、群协作、高危门禁。', href: LINKS.lark },
      { title: '自定义 Agent', body: 'ACPX 注册表、Codex 发现规则、AGENTDOCK_AGENTS_JSON。', href: LINKS.agents },
      { title: '桌面客户端', body: 'Electron 壳，自带 daemon 与 Node 运行时，应用内更新。', href: LINKS.desktop },
      { title: '参与贡献', body: '源码开发、dev up 隔离沙箱、发版流程。', href: LINKS.contributing }
    ]
  },
  faq: {
    kicker: '常见问题',
    title: '还有疑问？',
    items: [
      { q: 'AgentDock 和直接用 Claude Code、Codex 有什么区别？', a: '它不替代任何 Agent，而是把它们托管成常驻服务：统一的 Web 工作台、飞书入口、HTTP API、本地持久化和回放，再加一只替你派活、督办、验收的小猫主会话。' },
      { q: '数据存在哪里？会上传吗？', a: '全部在你自己的机器上。会话、事件、工具调用、权限都存在本地 SQLite（.agentdock/agentdock.db），AgentDock 不内置任何云端服务；Agent 自己的模型调用走你自己的账号。' },
      { q: '支持哪些 Agent？', a: 'ACPX 注册表里的 Claude Code、Codex、Gemini、Cursor、Copilot、Antigravity、Trae、opencode、Qwen、iFlow、Kilocode、Pi 等，只要本机装了 CLI 就会出现；也能用 AGENTDOCK_AGENTS_JSON 接入任意讲 ACP 的服务。' },
      { q: '安全吗？可以放到公网吗？', a: '默认监听 0.0.0.0，局域网可访问，控制台只有一层「所有者」凭证，没有多用户和租户隔离；Agent 会话默认 full-trust（全允许）无阻塞执行。只想本机用请加 --local-only；对外暴露务必在前面加 HTTPS 和身份认证，并按需在界面里配置高危命令拦截与成员白名单。' },
      { q: '电脑需要一直开着吗？', a: '是的，AgentDock 跑在你自己的电脑或远端开发机上。macOS 可以 agent-dock autostart enable 开机自启，并在设置里打开「永不休眠」。' },
      { q: '小猫换代会丢东西吗？', a: '不会。交接时老猫打包交接包，未完成的便签、watch 和「跟随主会话」的定时任务都会转给新猫；任何一步失败都会自动回滚，旧主会话完好。' },
      { q: '收费吗？', a: 'AgentDock 以 MIT 协议开源、免费使用。Agent 的用量走你自己的订阅或 API 账号。' }
    ]
  },
  cta: {
    title: '今天就认领\n你的第一只小猫。',
    sub: '一条命令装好，十分钟接上飞书。剩下的，交给小猫。',
    github: '在 GitHub 上 Star',
    desktop: '下载桌面版'
  },
  footer: {
    tagline: '本地 Agent 工作台。\n认领一只小猫，替你指挥所有 Agent。',
    groups: [
      { title: '产品', links: [{ label: '交互演示', href: '#demo' }, { label: '小猫伴侣', href: '#kitten' }, { label: '飞书机器人', href: '#lark' }, { label: '快速上手', href: '#start' }] },
      { title: '资源', links: [{ label: 'GitHub', href: LINKS.github }, { label: 'npm', href: LINKS.npm }, { label: '桌面版下载', href: LINKS.releases }, { label: '完整手册', href: LINKS.guide }] },
      { title: '社区', links: [{ label: '提 Issue', href: LINKS.issues }, { label: '参与贡献', href: LINKS.contributing }, { label: 'MIT 许可证', href: LINKS.license }, { label: 'ACP 协议', href: LINKS.acp }] }
    ],
    rights: 'MIT 开源 · 由社区与一群小猫共同维护',
    made: '用 AgentDock 托管的 Claude Code 打造'
  },
  common: {
    copy: '复制',
    copied: '已复制',
    external: '在新标签页打开'
  }
};

export type Content = typeof zh;

const en: Content = {
  meta: {
    title: 'AgentDock · Adopt a kitten. It runs your agents.',
    description: 'AgentDock is an open-source local agent workbench. It hosts Claude Code, Codex, Gemini, Cursor and every other ACP agent as an always-on service, with a kitten main session that splits, dispatches, follows up and reviews your work. Mention it in Lark or type in the console and watch every step live.'
  },
  nav: {
    links: [
      { id: 'demo', label: 'Demo' },
      { id: 'kitten', label: 'Kitten' },
      { id: 'lark', label: 'Lark' },
      { id: 'features', label: 'Features' },
      { id: 'start', label: 'Get started' },
      { id: 'docs', label: 'Docs' }
    ],
    github: 'GitHub',
    cta: 'Get started',
    themeLight: 'Switch to light theme',
    themeDark: 'Switch to dark theme',
    lang: '中文',
    langLabel: '切换到中文',
    menu: 'Menu',
    close: 'Close'
  },
  hero: {
    badgeTag: `v${VERSION}`,
    badge: 'Schedules now follow your kitten across handoffs',
    titleA: 'Adopt a kitten.',
    titleB1: 'It runs',
    titleB2: 'your agents.',
    sub: 'AgentDock turns Claude Code, Codex, Gemini, Cursor and every other agent on your machine into an always-on service. Your kitten main session splits the work, dispatches it, follows up and reviews. Mention it in Lark or type in the console, and watch every step live.',
    copy: 'Copy install command',
    copied: 'Copied',
    desktop: 'Download desktop app',
    github: 'View on GitHub',
    facts: ['Node.js 22.13+', 'macOS · Windows desktop', 'MIT licensed', 'Your data stays local'],
    peek: 'Meow~ take me home?',
    peekHover: 'Meow! Try it?'
  },
  demo: {
    kicker: 'Interactive demo',
    title: 'One console.\nEvery step in sight.',
    sub: 'A faithful replica of the AgentDock console. Pick a scene and watch the kitten turn one sentence into sticky notes, a few agents and a reviewed result.',
    tabs: [
      { id: 'dispatch', label: 'Kitten dispatch', short: 'Dispatch', hint: 'Notes · side sessions · follow-up · review' },
      { id: 'switch', label: 'Agents & models', short: 'Agents', hint: 'Discovery · live models · reasoning effort' },
      { id: 'artifacts', label: 'Artifacts', short: 'Artifacts', hint: 'Line links · images & video · quote reply' },
      { id: 'schedule', label: 'Schedules', short: 'Schedules', hint: 'cron · follows the main kitten' }
    ],
    replay: 'Replay',
    pause: 'Pause',
    play: 'Play',
    url: '127.0.0.1:4310',
    rail: {
      newChat: 'New chat',
      search: 'Search sessions',
      sessions: 'Sessions',
      byTime: 'Time',
      byProject: 'Project',
      today: 'Today',
      settings: 'Settings',
      lark: 'Lark · Dev team',
      baseline: [
        { title: 'Upgrade acpx to 0.20.0', agent: 'codex', time: '18m' },
        { title: 'Debug TPS calculation', agent: 'claude', time: '42m' },
        { title: 'Add tests for schedules', agent: 'codex', time: '1h' },
        { title: 'Triage SQLite native crash', agent: 'antigravity', time: '2h' },
        { title: 'List Lark group scopes', agent: 'claude', time: '3h' },
        { title: 'Mobile layout for home', agent: 'cursor', time: '5h' }
      ],
      justNow: 'now'
    },
    cat: { name: 'Mochi', main: 'Main', gen1: 'Gen 1 · Kitten', gen1Old: 'Gen 1 · Elder', gen2: 'Gen 2 · Kitten', name2: 'Mochi II' },
    status: {
      idle: 'Waiting for work',
      thinking: 'Writing sticky notes…',
      dispatched: '3 notes in progress',
      reviewing: 'Reviewing…',
      done: '3 notes accepted'
    },
    chips: { review: 'to review', running: 'running', notes: 'Notes', retire: 'Retire' },
    composer: {
      placeholderMain: 'Tell Mochi what to do. Enter to send; it will split the work into notes',
      placeholderHome: 'Message, Enter to send; / for skills and commands, paste or drop files',
      quoteFollow: 'Also validate phone number format here'
    },
    dispatch: {
      prompt: 'Rebuild the login page to the new design, fix Lark cards getting truncated, and draft the v0.4 release notes.',
      processed: (s: number, n: number) => `Processed ${s}s · ${n} steps`,
      reply: 'On it! Three sticky notes, dispatched in parallel:',
      notes: [
        { title: 'Rebuild login page', agent: 'Codex', model: 'gpt-6.1-sol', cwd: 'web' },
        { title: 'Fix truncated Lark cards', agent: 'Claude Code', model: 'Opus 5.5', cwd: 'server' },
        { title: 'v0.4 release notes', agent: 'Antigravity', model: 'Gemini 4 Neon', cwd: 'docs' }
      ],
      tool: 'agent-dock task start',
      systemRound: 'System round · follow-up',
      systemBadge: 'System',
      systemDesc: 'Injected by the daemon when a side session finishes, not by you',
      reviewing: 'All three side sessions reported back. Reviewing each one:',
      verdictOk: 'Accepted',
      verdictRework: 'Sent back',
      reworkNote: 'Missing the 390px screenshot. Add it and resubmit',
      final: 'All three notes accepted. Screenshots, test runs and PR links are attached to each note and posted to the Lark group.',
      status: { running: 'Running', review: 'To review', done: 'Accepted' },
      legend: { running: 'Running', review: 'Review', done: 'Done' }
    },
    switch: {
      agentHeader: 'Discovered · installed on this machine',
      modelHeader: 'Discovered live · via ACP',
      effort: 'Effort',
      cwd: 'my-app',
      toast: 'New chats will use Codex · gpt-6.1-sol · high',
      notInstalled: 'Not installed',
      greeting: 'What should we do?',
      newChat: 'New chat',
      handTo: 'Hand to Mochi'
    },
    artifacts: {
      ask: 'Is the login page done? Show me.',
      replyA: 'Done. The key change is in ',
      replyB: ', screenshot at ',
      replyC: ', and a short demo ',
      replyD: '. Form validation now runs through zod, with errors shown right under each field.',
      quote: 'Form validation now runs through zod',
      quoteBtn: 'Quote',
      preview: 'Preview',
      lines: 'L42-L58',
      imageTitle: 'Welcome back',
      imageSub: 'Sign in to continue to AgentDock',
      email: 'Email',
      password: 'Password',
      signIn: 'Sign in',
      range: 'Streamed with HTTP Range'
    },
    schedule: {
      title: 'Schedules',
      name: 'Weekday digest',
      prompt: "Summarize yesterday's alerts and unfinished notes",
      cron: '0 9 * * 1-5',
      cronHuman: 'Weekdays 09:00',
      every: 'Every 45 min',
      second: 'Check release status',
      target: 'Follow the main session',
      targetHint: 'Moves with handoffs',
      next: 'Next run',
      nextValue: 'Tomorrow 09:00',
      save: 'Save',
      handoff: 'Mochi II takes over. Meow!',
      tired: 'Mochi is getting tired. Hand over to the next generation?',
      migrated: 'Moved to Gen 2',
      ceremony: ['Pack up', 'Newborn', 'Hand notes', 'Switch main', 'Retire', 'Briefing'],
      ceremonyTitle: 'Handoff ceremony',
      cli: 'agent-dock schedule add "Summarize alerts" --cron "0 9 * * 1-5" --name "Weekday digest"',
      ask: 'Every weekday at 9am, summarize the previous day’s alerts for me.',
      answer: 'Sure! I’ll set up a “Weekday digest” that follows the main session, so it survives handoffs.',
      fields: { name: 'Name', prompt: 'Prompt', when: 'When', target: 'Send to', other: 'A specific session' },
      cronTab: 'cron',
      everyTab: 'every'
    }
  },
  agents: {
    kicker: 'Agent discovery',
    title: 'Every agent you installed.\nNothing you didn’t.',
    sub: 'On start, AgentDock reads the ACPX registry and checks each CLI on your machine, listing only the ones that are really there. Models are discovered live over ACP: pick an agent for a new chat, switch model and effort any time.',
    points: [
      { title: 'Just ACP', body: 'No vendor SDK inside. A pinned acpx runtime handles handshakes, persistent sessions, reconnects and permissions.' },
      { title: 'Live model discovery', body: 'Models and reasoning effort come from the agent itself; add proxy-only models with extraModels.' },
      { title: 'Plug in anything', body: 'Declare custom ACP services in AGENTDOCK_AGENTS_JSON. They show up once the command exists.' },
      { title: 'Full trust + gates', body: 'Sessions default to full-trust (approve-all) for unblocked execution; risky commands can be blocked by regex gates alongside member allowlists.' }
    ],
    more: 'and any agent that speaks ACP'
  },
  kitten: {
    kicker: 'Kitten companion',
    title: 'Your main session is\na kitten that grows up.',
    sub: 'Once adopted, it becomes your main session. Say what you need; it sends side sessions to do the work, follows up and reviews the results, and pins every job as a sticky note.',
    steps: [
      { key: 'adopt', label: 'Adopt', title: 'Meow~ take me home?', body: 'Adopt a kitten from the home screen. Name it, choose which agent it thinks with, how hard it thinks and where it lives. From now on, it is your main session.', bubble: 'Meow~ take me home?' },
      { key: 'split', label: 'Split', title: 'You just say what you need.', body: 'Toss it one sentence. It splits the request into sticky notes, each with a title, acceptance criteria and a working directory, pinned to the edge of your screen.', bubble: 'Got it! Three notes~' },
      { key: 'dispatch', label: 'Dispatch', title: 'Sent to the right agent.', body: 'Each note goes to its own side session. Codex on the front end, Claude Code on the server, Antigravity on the docs: different agents, different folders, all in parallel.', bubble: 'All dispatched. I’m watching' },
      { key: 'supervise', label: 'Follow up', title: 'It keeps an eye on things.', body: 'When a side session reports back, the daemon opens a follow-up round and wakes the kitten. Stuck work gets nudged, drifting work gets corrected. You don’t have to babysit.', bubble: 'Late night~ watching 2 notes, I’ll ping you' },
      { key: 'review', label: 'Review', title: 'Done means proven.', body: 'The kitten reviews every note: tests, screenshots and logs must line up. Anything short gets sent back with notes appended. It only pings you when it all passes.', bubble: 'All three notes accepted!' },
      { key: 'age', label: 'Grow', title: 'It grows up. It gets old.', body: 'As rounds and context compactions pile up, the kitten ages from kitten to elder. The older it gets, the more its memory needs tidying, and it will tell you.', bubble: 'Mochi is getting tired. Hand over to the next generation?' },
      { key: 'handoff', label: 'Handoff', title: 'A new kitten picks it up.', body: 'Start a handoff: the old kitten packs up, a new one is born and inherits unfinished notes, watches and schedules. If any step fails, it rolls back and the old main session stays intact.', bubble: 'Mochi II takes over. Meow!' }
    ],
    stages: [
      { key: 'kitten', label: 'Kitten', blurb: 'Just took over, full of energy, wants to try everything' },
      { key: 'adult', label: 'Adult', blurb: 'In its prime, quick to dispatch and review' },
      { key: 'senior', label: 'Senior', blurb: 'Seasoned, but its memory is getting heavy' },
      { key: 'elder', label: 'Elder', blurb: 'A bit tired, time to think about a handoff' }
    ],
    metrics: [
      { label: 'Main rounds', value: '412' },
      { label: 'Compactions', value: '7' },
      { label: 'Context used', value: '83%' }
    ],
    adopt: { nameLabel: 'Give it a name', name: 'Mochi', agentLabel: 'Which agent it thinks with', agent: 'Claude Code', depth: 'Effort', depthValue: 'high', cta: 'Take it home' },
    ceremony: ['Pack up', 'Newborn', 'Hand notes', 'Switch main', 'Retire', 'Briefing'],
    sessions: ['Rebuild login page', 'Fix truncated Lark cards', 'v0.4 release notes'],
    systemRound: 'System round · follow-up',
    systemDesc: 'Injected by the daemon when a side session finishes',
    verdicts: { ok: 'Accepted', rework: 'Sent back' },
    stepOf: (i: number, n: number) => `${String(i).padStart(2, '0')} / ${String(n).padStart(2, '0')}`
  },
  lark: {
    kicker: 'Lark bot',
    title: 'Mention it on your phone.\nYour desk gets to work.',
    sub: 'DM the bot or @ it in a group. It reacts with an emoji, posts a “thinking” card, then keeps updating that same card with progress and results. You’re on the train; the work runs at home.',
    features: [
      { title: 'Create a bot by QR code', body: 'Lark settings → Create bot by QR code. Scan, authorize, pick a workspace and an agent.' },
      { title: 'Thread side chat /btw', body: 'Send /btw in a thread to spin off a side chat without derailing the main task.' },
      { title: 'Multi-agent group work', body: 'Several bots in one group can discover each other, read messages and hand off. Writes are off by default.' },
      { title: 'Interrupt and retry on the card', body: 'Interrupt while it runs; retry after a failure, reusing the same session.' },
      { title: 'Guardrails and allowlists', body: 'Block risky commands by regex and allowlist members by real name, all in the UI.' }
    ],
    phone: {
      group: 'Dev team',
      members: '8',
      me: 'Me',
      ask: '@AgentDock login API throws 500 now and then in prod. Can you dig in?',
      bot: 'AgentDock',
      agent: 'Claude Code',
      thinking: 'Thinking…',
      running: 'Running',
      done: 'Completed',
      interrupt: 'Interrupt',
      trace: ['Read logs/api-2026-11-25.log', 'Search expiry check in session.ts', 'Run pnpm test auth'],
      result: 'Root cause: session expiry used the server’s local time zone and misfired around midnight. Fixed with 2 new tests. PR #128 is ready for you.',
      elapsed: '48s',
      thread: '/btw also bump the alert threshold to 5 minutes',
      threadReply: 'Sure, opened a side chat for it ↗',
      input: 'Message Dev team'
    }
  },
  features: {
    kicker: 'Workbench details',
    title: 'Polished for agents\nthat run all day.',
    sub: 'Streaming Markdown, tool calls, permission requests and terminal output all land in local SQLite: replayable, resumable, and one QR scan away from your phone.',
    cards: {
      artifacts: { title: 'Live artifact preview', body: 'Images, video, audio and Markdown made by agents open right in place; large files stream with HTTP Range.' },
      lines: { title: 'Line-precise links', body: 'A file.ts#L14-L16 link in a reply opens the file with those lines highlighted.' },
      quote: { title: 'Select to quote', body: 'Highlight any part of a reply and quote it in your follow-up.' },
      schedule: { title: 'Schedules that follow the kitten', body: 'cron or --every 45m. Target “follow the main session” and it moves to the new kitten after a handoff.' },
      queue: { title: 'Queue · steer · retry', body: 'New messages queue while the agent is busy, or interrupt the current turn to go first.' },
      mobile: { title: 'Scan to continue', body: 'Scan the QR code in the sidebar and keep chatting on your phone. Treat it like a password.' },
      guard: { title: 'Guardrails & allowlists', body: 'Risky-command gates, member allowlists and a console password, all set in the UI.' },
      api: { title: 'HTTP + SSE API', body: 'Sessions, queues and permissions over HTTP, with resumable SSE. A solid execution layer for your own multi-agent platform.' },
      rsi: { title: 'Recursive self-improvement', body: 'agent-dock dev up gives agents an isolated sandbox to improve AgentDock itself and verify end to end, without restarting the daemon they run in.' }
    },
    labels: {
      queued: 'Queued',
      steer: 'Run next',
      running: 'Running',
      retry: 'Retry',
      blocked: 'Blocked, awaiting approval',
      allowed: 'Allowlist',
      scan: 'Open on your phone',
      lan: 'LAN',
      quote: 'Quote',
      daily: 'Weekday digest',
      follow: 'Follow main session',
      gen: (n: number) => `Gen ${n}`
    }
  },
  arch: {
    kicker: 'How it works',
    title: 'No vendor SDK.\nJust ACP.',
    sub: 'A pinned acpx runtime handles ACP handshakes, persistent sessions, reconnects, streaming and permission requests. AgentDock owns product state, normalized events, storage, the API and channels. If your agent speaks ACP, it plugs in.',
    inputs: ['Lark', 'Web console', 'HTTP + SSE', 'Schedules'],
    core: 'AgentDock runtime',
    coreItems: ['Sessions & queues', 'Kitten main session', 'Permissions & gates', 'Normalized events'],
    store: 'SQLite · fully replayable',
    runtime: 'acpx',
    outputs: ['Claude Code', 'Codex', 'Gemini', 'Cursor', '…'],
    warn: 'AgentDock listens on 0.0.0.0 by default, so it is reachable on your LAN, and the console has a single owner credential. Use --local-only to keep it on this machine, and put HTTPS and real authentication in front before exposing it anywhere else.'
  },
  start: {
    kicker: 'Get started',
    title: 'Four steps to\nbring a kitten home.',
    sub: 'From install to your first kitten in under ten minutes.',
    prev: 'Back',
    next: 'Next',
    done: 'Read the full guide on GitHub',
    steps: [
      {
        key: 'install',
        label: 'Install',
        title: 'One command, always on.',
        body: 'Requires Node.js 22.13+. Install the CLI globally, start the background service from your project folder, then open the console.',
        code: ['npm i -g @agent-dock/cli@latest', 'cd /path/to/your/project', 'agent-dock start      # runs in the background; open http://127.0.0.1:4310'],
        tips: ['agent-dock status shows PID, address and log path', 'On macOS, agent-dock autostart enable starts it at login', 'Rather not install Node? Get the macOS or Windows desktop app']
      },
      {
        key: 'agents',
        label: 'Agents',
        title: 'Install the agent CLIs you use.',
        body: 'Claude Code, Codex, Gemini, Cursor, Antigravity… install and sign in. AgentDock discovers them on start and fetches their models live.',
        code: ['agent-dock acpx agents list --json   # see what was discovered', 'curl http://127.0.0.1:4310/api/agents'],
        tips: ['Only agents whose CLI is installed show up', 'Add custom ACP services with AGENTDOCK_AGENTS_JSON', 'Sessions default to full-trust (approve-all) for unblocked runs; pair with risky-command regex gates']
      },
      {
        key: 'lark',
        label: 'Lark',
        title: 'Scan once, then just @ it.',
        body: 'Open Lark settings → Create bot by QR code, scan with Lark to authorize, then choose a workspace and an agent. DM the bot or @ it in a group.',
        code: ["agent-dock lark send '**Build finished**' --task-id release-42   # cards from the CLI too"],
        tips: ['Group collaboration and writes are off until an admin enables them', 'Pause listening with agent-dock --no-lark-listen', 'Permissions and gates are covered in the full guide (Chinese)']
      },
      {
        key: 'adopt',
        label: 'Adopt',
        title: 'Adopt a kitten. Then just talk.',
        body: 'Adopt a kitten from the home screen, name it and pick its agent. Then hand it your requests: notes, side sessions, follow-ups and reviews are all on the kitten.',
        code: ['agent-dock main set --agent claude --name Mochi   # adopt from the CLI', 'agent-dock schedule add "Summarize alerts" --cron "0 9 * * 1-5" --name "Weekday digest"'],
        tips: ['Dispatch, review and watch have CLIs too: agent-dock task|watch|notify -h', 'Point schedules at “follow the main session”', 'An old kitten will ask you for a handoff']
      }
    ]
  },
  docs: {
    kicker: 'Docs',
    title: 'CLI at a glance',
    sub: 'Run agent-dock <command> --help for every flag. The full guide lives on GitHub (Chinese).',
    tabs: [
      { id: 'service', label: 'Service', short: 'Service', code: ['agent-dock start        # run in the background', 'agent-dock status       # PID, address, log path', 'agent-dock restart', 'agent-dock stop', 'agent-dock update       # update and restart the service', 'agent-dock              # no subcommand: foreground', 'agent-dock --local-only # this machine only'] },
      { id: 'schedule', label: 'Schedules', short: 'Cron', code: ['agent-dock schedule add "Summarize alerts" --cron "0 9 * * 1-5" --name "Weekday digest"', 'agent-dock schedule add "Check release status" --every 45m', 'agent-dock schedule list | show | pause | resume | run | remove <schedule-id>'] },
      { id: 'session', label: 'Sessions', short: 'Sessions', code: ['agent-dock session peers', 'agent-dock session show <session-id>', 'agent-dock session send <session-id> "message" [--mode interrupt]', 'agent-dock main set --agent claude --name Mochi'] },
      { id: 'lark', label: 'Lark', short: 'Lark', code: ["agent-dock lark send '**Build finished**' --task-id release-42", 'agent-dock lark message send --chat oc_xxx --text "Deployed"', 'agent-dock lark message read --chat oc_xxx --limit 20', 'agent-dock group peers', "agent-dock group send 'Please check this API' --to cli_peer"] },
      { id: 'api', label: 'HTTP API', short: 'API', code: ['GET  /health                       # {"ok":true}', 'GET  /api/agents                   # discovered agents', 'POST /api/sessions                 # create, agentId required', 'POST /api/sessions/:id/send        # 202 = queued, not done', 'GET  /api/sessions/:id/stream      # SSE, resume with Last-Event-ID', 'POST /api/sessions/:id/permissions/:permissionId'] }
    ],
    cards: [
      { title: 'Full guide', body: 'Install, web console, Lark, gates, lifecycle and storage (Chinese).', href: LINKS.guide },
      { title: 'HTTP API', body: 'Session lifecycle, queueing and steering, events and SSE, permissions.', href: LINKS.api },
      { title: 'Lark integration', body: 'QR bot setup, scopes, group collaboration, risky-command gates.', href: LINKS.lark },
      { title: 'Custom agents', body: 'ACPX registry, Codex discovery rules, AGENTDOCK_AGENTS_JSON.', href: LINKS.agents },
      { title: 'Desktop app', body: 'Electron shell with a bundled daemon and Node runtime, in-app updates.', href: LINKS.desktop },
      { title: 'Contributing', body: 'Run from source, the dev up sandbox, and the release flow.', href: LINKS.contributing }
    ]
  },
  faq: {
    kicker: 'FAQ',
    title: 'Questions?',
    items: [
      { q: 'How is this different from using Claude Code or Codex directly?', a: 'It doesn’t replace any agent. It hosts them as an always-on service: one web console, a Lark entry point, an HTTP API, local persistence and replay, plus a kitten main session that dispatches, follows up and reviews for you.' },
      { q: 'Where does my data live?', a: 'On your machine. Sessions, events, tool calls and permissions are stored in local SQLite (.agentdock/agentdock.db). AgentDock ships no cloud service; model calls go through your own agent accounts.' },
      { q: 'Which agents are supported?', a: 'Everything in the ACPX registry, including Claude Code, Codex, Gemini, Cursor, Copilot, Antigravity, Trae, opencode, Qwen, iFlow, Kilocode and Pi, as long as the CLI is installed. Any other ACP service can be added via AGENTDOCK_AGENTS_JSON.' },
      { q: 'Is it safe? Can I expose it publicly?', a: 'It listens on 0.0.0.0 by default, so it is reachable on your LAN, behind a single owner credential with no multi-user isolation, and agent sessions default to full-trust (approve-all) for unblocked execution. Use --local-only to keep it local, put HTTPS plus real authentication in front before exposing it, and configure risky-command gates and allowlists in the UI.' },
      { q: 'Does my computer need to stay on?', a: 'Yes. AgentDock runs on your own computer or dev box. On macOS, agent-dock autostart enable starts it at login, and the “Never sleep” switch keeps the machine awake while it runs.' },
      { q: 'Does a handoff lose anything?', a: 'No. The old kitten packs a handoff bundle; unfinished notes, watches and schedules that follow the main session move to the new kitten. If any step fails, everything rolls back and the old main session stays intact.' },
      { q: 'Is it free?', a: 'Yes. AgentDock is MIT-licensed open source. Agent usage goes through your own subscriptions or API accounts.' }
    ]
  },
  cta: {
    title: 'Adopt your\nfirst kitten today.',
    sub: 'One command to install, ten minutes to Lark. The kitten takes it from there.',
    github: 'Star on GitHub',
    desktop: 'Download desktop app'
  },
  footer: {
    tagline: 'The local agent workbench.\nAdopt a kitten; it runs your agents.',
    groups: [
      { title: 'Product', links: [{ label: 'Demo', href: '#demo' }, { label: 'Kitten companion', href: '#kitten' }, { label: 'Lark bot', href: '#lark' }, { label: 'Get started', href: '#start' }] },
      { title: 'Resources', links: [{ label: 'GitHub', href: LINKS.github }, { label: 'npm', href: LINKS.npm }, { label: 'Desktop downloads', href: LINKS.releases }, { label: 'Full guide', href: LINKS.guide }] },
      { title: 'Community', links: [{ label: 'Open an issue', href: LINKS.issues }, { label: 'Contributing', href: LINKS.contributing }, { label: 'MIT license', href: LINKS.license }, { label: 'ACP protocol', href: LINKS.acp }] }
    ],
    rights: 'MIT licensed · maintained by the community and a few kittens',
    made: 'Built with Claude Code, hosted in AgentDock'
  },
  common: {
    copy: 'Copy',
    copied: 'Copied',
    external: 'Opens in a new tab'
  }
};

export const content: Record<Lang, Content> = { zh, en };
