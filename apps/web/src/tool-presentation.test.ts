import { describe, expect, it } from 'vitest';
import { elapsedMilliseconds, formatElapsed, groupToolActivityRows, noteCommandPresentation, summarizeTools, toolActionLabel, toolDescription, toolPresentation } from './tool-presentation';

const event = (id: string, name: string, input?: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  sequence: 1,
  type: 'tool_result',
  timestamp: '2026-01-01T00:00:00.000Z',
  data: { id, name, input, status: 'completed', ...extra }
});

describe('tool presentation', () => {
  it('never misclassifies files or commands containing agent/agent-dock/task as subagent calls', () => {
    const nonSubagentCases: Array<{ name: string; input?: unknown; kind?: string; expectedKind: string; expectedLabel: string }> = [
      // Antigravity File <path> 读取 / 修改 / 写入（路径含 agent / agent-dock / agent-runtime / task）
      {
        name: 'File packages/agent-runtime/src/index.ts',
        input: { Path: '/Users/dev/workspace/agent-dock/packages/agent-runtime/src/index.ts', StartLine: 1, EndLine: 100 },
        expectedKind: 'read',
        expectedLabel: '读取文件'
      },
      {
        name: 'File .claude/skills/agent-dock-self-dev/SKILL.md',
        input: { Path: '/Users/dev/workspace/agent-dock/.claude/skills/agent-dock-self-dev/SKILL.md' },
        expectedKind: 'read',
        expectedLabel: '读取文件'
      },
      {
        name: 'File apps/server/src/agent.ts',
        input: { Path: '/Users/dev/workspace/agent-dock/apps/server/src/agent.ts' },
        expectedKind: 'read',
        expectedLabel: '读取文件'
      },
      {
        name: 'File apps/server/src/lark/agent-tools.ts',
        input: { Path: 'apps/server/src/lark/agent-tools.ts', Target: 'old', Replacement: 'new' },
        expectedKind: 'edit',
        expectedLabel: '修改文件'
      },
      {
        name: 'File apps/web/src/agent-task-panel.tsx',
        input: { Path: 'apps/web/src/agent-task-panel.tsx', Content: 'export {}', Overwrite: true },
        expectedKind: 'edit',
        expectedLabel: '写入文件'
      },
      // Claude / Codex / OpenCode / Cursor 文件与检索操作
      {
        name: 'Read apps/server/src/agent.ts',
        input: { file_path: '/repo/agent-dock/apps/server/src/agent.ts' },
        expectedKind: 'read',
        expectedLabel: '读取文件'
      },
      {
        name: "Read file '/Users/dev/workspace/agent-dock/packages/agent-runtime/src/index.ts'",
        expectedKind: 'read',
        expectedLabel: '读取文件'
      },
      {
        name: 'Edit apps/web/src/AgentConfigDialog.tsx',
        input: { file_path: 'apps/web/src/AgentConfigDialog.tsx', old_string: 'a', new_string: 'b' },
        expectedKind: 'edit',
        expectedLabel: '修改文件'
      },
      {
        name: 'Write apps/server/src/agent-task.ts',
        input: { file_path: 'apps/server/src/agent-task.ts', content: 'export const x = 1;' },
        expectedKind: 'edit',
        expectedLabel: '写入文件'
      },
      {
        name: 'Grep',
        input: { pattern: 'agent-dock', path: 'packages/agent-runtime' },
        expectedKind: 'search',
        expectedLabel: '搜索内容'
      },
      {
        name: 'Glob',
        input: { pattern: '**/*agent*.ts', path: 'apps/server' },
        expectedKind: 'search',
        expectedLabel: '查找文件'
      },
      {
        name: 'list_dir',
        input: { DirectoryPath: '/Users/dev/workspace/agent-dock/packages/agent-runtime' },
        expectedKind: 'list',
        expectedLabel: '查看目录'
      },
      // 含 agent-dock / task 的命令与内联脚本
      {
        name: 'npm view @agent-dock/cli dist-tags.latest',
        input: { CommandLine: 'npm view @agent-dock/cli dist-tags.latest', WaitMsBeforeAsync: 5000 },
        expectedKind: 'terminal',
        expectedLabel: '执行命令'
      },
      {
        name: 'node apps/server/dist/cli.js dev up',
        input: { CommandLine: 'node apps/server/dist/cli.js dev up' },
        expectedKind: 'terminal',
        expectedLabel: '执行命令'
      },
      {
        name: 'agent-dock schedule show sch_123',
        input: { CommandLine: 'agent-dock schedule show sch_123' },
        expectedKind: 'terminal',
        expectedLabel: '执行命令'
      },
      {
        name: 'agent-dock task report --help',
        input: { CommandLine: 'agent-dock task report --help' },
        expectedKind: 'terminal',
        expectedLabel: '执行命令'
      },
      {
        name: 'agent-dock task list',
        input: { CommandLine: 'agent-dock task list' },
        expectedKind: 'note',
        expectedLabel: '翻看便签'
      },
      {
        name: 'sqlite3 /Users/dev/workspace/agent-dock/.agentdock/agentdock.db ".tables"',
        input: { CommandLine: 'sqlite3 /Users/dev/workspace/agent-dock/.agentdock/agentdock.db ".tables"' },
        expectedKind: 'database',
        expectedLabel: '查询数据'
      },
      {
        name: "ego-browser nodejs <<'EOF'\nconst task = await taskSpace(42);\nconst page = task.page('p1');\nEOF",
        input: { CommandLine: "ego-browser nodejs <<'EOF'\nconst task = await taskSpace(42);\nconst page = task.page('p1');\nEOF" },
        expectedKind: 'browser',
        expectedLabel: '操作浏览器'
      },
      {
        name: 'rg -n "invoke_subagent" apps/',
        input: { CommandLine: 'rg -n "invoke_subagent" apps/' },
        expectedKind: 'search',
        expectedLabel: '搜索内容'
      },
      {
        name: 'cat packages/agent-runtime/src/index.ts',
        input: { command: 'cat packages/agent-runtime/src/index.ts' },
        expectedKind: 'read',
        expectedLabel: '读取文件'
      },
      {
        name: 'git log --oneline apps/server/src/agent.ts',
        input: { command: 'git log --oneline apps/server/src/agent.ts' },
        expectedKind: 'git',
        expectedLabel: 'Git 操作'
      },
      {
        name: 'npx vitest run apps/web/src/agent-config.test.ts',
        input: { CommandLine: 'npx vitest run apps/web/src/agent-config.test.ts' },
        expectedKind: 'test',
        expectedLabel: '运行测试'
      },
      // 后台任务 / 待办 / 浏览器子工具不是子 Agent
      {
        name: 'Run manage_task',
        input: { Action: 'status', TaskId: 'task_1' },
        expectedKind: 'task',
        expectedLabel: '管理后台任务'
      },
      {
        name: 'TaskStop',
        input: { task_id: 'bg_1' },
        expectedKind: 'task',
        expectedLabel: '停止后台任务'
      },
      {
        name: 'TaskCreate',
        input: { subject: '梳理工具描述' },
        expectedKind: 'plan',
        expectedLabel: '更新计划'
      },
      {
        name: 'browser_subagent',
        input: { TaskName: '检查页面主题' },
        expectedKind: 'browser',
        expectedLabel: '操作浏览器'
      }
    ];

    for (const tc of nonSubagentCases) {
      const result = toolPresentation({ name: tc.name, input: tc.input, ...(tc.kind ? { kind: tc.kind } : {}) });
      expect(result.kind, tc.name).toBe(tc.expectedKind);
      expect(result.label, tc.name).toBe(tc.expectedLabel);
      expect(result.label, tc.name).not.toContain('Agent');
    }
  });

  it('accurately identifies genuine subagent and multi-agent collaboration tools', () => {
    expect(toolPresentation({
      name: 'Run invoke_subagent',
      input: { TypeName: 'research', Role: 'Codebase Researcher', Prompt: 'Inspect timeline' }
    })).toEqual({ kind: 'agent', label: '调用子 Agent', detail: 'Codebase Researcher' });

    expect(toolPresentation({
      name: 'invoke_subagent',
      input: { TypeName: 'self', Role: 'Verifier', Prompt: 'Run checks' }
    })).toEqual({ kind: 'agent', label: '调用子 Agent', detail: 'Verifier' });

    // Claude Code Agent / Task (direct and ACP-rendered title with subagent_type)
    expect(toolPresentation({
      name: 'Agent',
      input: { description: 'Explore tool labels', prompt: 'Search repo', subagent_type: 'Explore' }
    })).toEqual({ kind: 'agent', label: '调用子 Agent', detail: 'Explore tool labels' });

    expect(toolPresentation({
      name: 'Explore tool labels',
      kind: 'think',
      input: { description: 'Explore tool labels', prompt: 'Search repo', subagent_type: 'Explore' }
    })).toEqual({ kind: 'agent', label: '调用子 Agent', detail: 'Explore tool labels' });

    expect(toolPresentation({ name: 'Task', input: {} })).toEqual({ kind: 'agent', label: '调用子 Agent' });
    expect(toolPresentation({ name: 'Task (high effort)', input: {} })).toEqual({ kind: 'agent', label: '调用子 Agent' });

    // Codex / Cursor / 通用结构化 subagent
    expect(toolPresentation({ name: 'spawn_agent', input: { agent_type: 'explorer', message: 'check' } }))
      .toEqual({ kind: 'agent', label: '调用子 Agent', detail: 'explorer' });
    expect(toolPresentation({ name: 'Subagent', input: { description: 'Audit tests' } }))
      .toEqual({ kind: 'agent', label: '调用子 Agent', detail: 'Audit tests' });
    expect(toolPresentation({ name: 'custom_delegate', kind: 'subagent', input: {} }))
      .toEqual({ kind: 'agent', label: '调用子 Agent', detail: 'custom_delegate' });

    // 定义 / 管理 / 消息 / Swarm / 工作流 / 群协作精准区分
    expect(toolPresentation({ name: 'Run define_subagent', input: { Name: 'reviewer', Description: 'Review diff', SystemPrompt: '...' } }))
      .toEqual({ kind: 'agent', label: '定义子 Agent', detail: 'reviewer' });
    expect(toolPresentation({ name: 'Run manage_subagents', input: { Action: 'list' } }))
      .toEqual({ kind: 'agent', label: '管理子 Agent', detail: 'list' });
    expect(toolPresentation({ name: 'ListAgents', input: {} }))
      .toEqual({ kind: 'agent', label: '管理子 Agent' });
    expect(toolPresentation({ name: 'Run send_message', input: { Recipient: 'conv_1', Message: 'done' } }))
      .toEqual({ kind: 'agent', label: '发送消息', detail: 'conv_1' });
    expect(toolPresentation({ name: 'SendMessage', input: { recipient: 'worker-1' } }))
      .toEqual({ kind: 'agent', label: '发送消息', detail: 'worker-1' });
    expect(toolPresentation({ name: 'Run swarm', input: { action: 'add', name: 'reviewer' } }))
      .toEqual({ kind: 'agent', label: '多 Agent 协作', detail: 'add reviewer' });
    expect(toolPresentation({ name: 'Run run_workflow', input: { Description: 'Parallel file audit' } }))
      .toEqual({ kind: 'workflow', label: '运行工作流', detail: 'Parallel file audit' });
    expect(toolPresentation({ name: 'Terminal', input: { command: 'agent-dock group messages --limit 20' } }))
      .toMatchObject({ kind: 'agent', label: 'Agent 群协作' });
    expect(toolPresentation({ name: 'Terminal', input: { command: 'agent-dock group send -h' } }))
      .toMatchObject({ kind: 'terminal', label: '执行命令' });
  });

  it('classifies common tools across Antigravity, Claude Code, Codex, OpenCode, Cursor, and ACP', () => {
    // 文件查看与代码结构
    expect(toolPresentation({ name: 'Read', input: { path: 'README.md' } })).toEqual({ kind: 'read', label: '读取文件', detail: 'README.md' });
    expect(toolPresentation({ name: 'Read File', input: {} })).toEqual({ kind: 'read', label: '读取文件' });
    expect(toolPresentation({ name: 'Read docs/README.md (1 - 60)', input: { file_path: '/abs/docs/README.md' } }))
      .toEqual({ kind: 'read', label: '读取文件', detail: 'docs/README.md (1 - 60)' });
    expect(toolPresentation({ name: 'view_file_outline', input: { AbsolutePath: 'src/app.ts' } }))
      .toEqual({ kind: 'read', label: '查看代码结构', detail: 'src/app.ts' });
    expect(toolPresentation({ name: 'view_code_item', input: { File: 'src/app.ts', NodePaths: ['ToolsStep'] } }))
      .toEqual({ kind: 'read', label: '查看代码结构', detail: 'src/app.ts · ToolsStep' });
    expect(toolPresentation({ name: 'View Image /tmp/shot.png', input: { path: '/tmp/shot.png' } }))
      .toEqual({ kind: 'image', label: '查看图片', detail: '/tmp/shot.png' });

    // 文件修改 / 写入 / 补丁 / 删除 / 移动
    expect(toolPresentation({ name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' } }))
      .toEqual({ kind: 'edit', label: '修改文件', detail: 'src/a.ts' });
    expect(toolPresentation({ name: 'MultiEdit', input: { file_path: 'src/a.ts' } }))
      .toEqual({ kind: 'edit', label: '修改文件', detail: 'src/a.ts' });
    expect(toolPresentation({ name: 'replace_file_content', input: { TargetFile: 'src/a.ts' } }))
      .toEqual({ kind: 'edit', label: '修改文件', detail: 'src/a.ts' });
    expect(toolPresentation({ name: 'multi_replace_file_content', input: { TargetFile: 'src/a.ts' } }))
      .toEqual({ kind: 'edit', label: '修改文件', detail: 'src/a.ts' });
    expect(toolPresentation({ name: 'NotebookEdit', input: { notebook_path: 'nb.ipynb' } }))
      .toEqual({ kind: 'edit', label: '修改文件', detail: 'nb.ipynb' });
    expect(toolPresentation({ name: 'Editing files' })).toEqual({ kind: 'edit', label: '修改文件' });
    expect(toolPresentation({ name: 'Write docs/GUIDE.md', input: { file_path: '/abs/docs/GUIDE.md', content: '# Hi' } }))
      .toEqual({ kind: 'edit', label: '写入文件', detail: 'docs/GUIDE.md' });
    expect(toolPresentation({ name: 'write_file', input: { Path: 'src/new.ts', Content: 'export {}' } }))
      .toEqual({ kind: 'edit', label: '写入文件', detail: 'src/new.ts' });
    expect(toolPresentation({ name: 'Preparing file…', input: {} })).toEqual({ kind: 'edit', label: '写入文件' });
    expect(toolPresentation({ name: 'apply_patch', input: { patch: '*** Update File: src/x.ts\n@@' } }))
      .toEqual({ kind: 'edit', label: '应用补丁', detail: 'src/x.ts' });
    expect(toolPresentation({ name: 'apply_patch', input: { command: 'apply_patch' } }))
      .toEqual({ kind: 'edit', label: '应用补丁', detail: 'apply_patch' });
    expect(toolPresentation({ name: 'Search', input: { query: 'AgentDock' } }))
      .toEqual({ kind: 'search', label: '搜索内容', detail: 'AgentDock' });
    expect(toolPresentation({ name: 'delete_file', input: { path: 'tmp/old.ts' } }))
      .toEqual({ kind: 'edit', label: '删除文件', detail: 'tmp/old.ts' });
    expect(toolPresentation({ name: 'move_file', input: { from: 'a.ts', to: 'b.ts' } }))
      .toEqual({ kind: 'edit', label: '移动文件', detail: 'a.ts → b.ts' });

    // 目录与检索
    expect(toolPresentation({ name: 'LS', input: { path: 'apps/web' } })).toEqual({ kind: 'list', label: '查看目录', detail: 'apps/web' });
    expect(toolPresentation({ name: "List files in 'lark-avatar'" })).toEqual({ kind: 'list', label: '查看目录', detail: 'lark-avatar' });
    expect(toolPresentation({ name: 'List files' })).toEqual({ kind: 'list', label: '查看目录' });
    expect(toolPresentation({ name: 'find_by_name', input: { SearchDirectory: 'apps', Pattern: '*.tsx' } }))
      .toEqual({ kind: 'search', label: '查找文件', detail: '*.tsx · apps' });
    expect(toolPresentation({ name: 'Find `apps/web` `**/*.ts`', input: { path: 'apps/web', pattern: '**/*.ts' } }))
      .toEqual({ kind: 'search', label: '查找文件', detail: '**/*.ts · apps/web' });
    expect(toolPresentation({ name: 'grep_search', input: { SearchPath: 'apps/web', Query: 'toolPresentation' } }))
      .toEqual({ kind: 'search', label: '搜索内容', detail: 'toolPresentation · apps/web' });
    expect(toolPresentation({ name: "Search for 'contextPercent' in packages/" }))
      .toEqual({ kind: 'search', label: '搜索内容', detail: 'contextPercent · packages/' });
    expect(toolPresentation({ name: 'Terminal', input: { command: 'rg --files apps/web' } }))
      .toEqual({ kind: 'search', label: '查找文件', detail: 'rg --files apps/web' });
    expect(toolPresentation({ name: 'Terminal', input: { command: 'ls -la apps/web' } }))
      .toEqual({ kind: 'list', label: '查看目录', detail: 'ls -la apps/web' });

    // 终端与命令 I/O（管道与重定向处理）
    expect(toolPresentation({ name: 'tool call', input: { command: 'pwd' } })).toEqual({ kind: 'terminal', label: '执行命令', detail: 'pwd' });
    expect(toolPresentation({ name: 'Terminal', input: {} })).toEqual({ kind: 'terminal', label: '执行命令' });
    expect(toolPresentation({ name: 'command_status', input: { CommandId: 'cmd_42' } }))
      .toEqual({ kind: 'terminal', label: '查看命令输出', detail: 'cmd_42' });
    expect(toolPresentation({ name: 'write_stdin', input: { session_id: 's1', chars: 'y\n' } }))
      .toEqual({ kind: 'terminal', label: '向命令发送输入', detail: 's1' });
    expect(toolPresentation({ name: 'Bash', input: { command: 'git diff | head -n 40' } }))
      .toEqual({ kind: 'git', label: 'Git 操作', detail: 'git diff | head -n 40' });
    expect(toolPresentation({ name: 'Bash', input: { command: 'cat foo.ts > bar.ts' } }))
      .toEqual({ kind: 'terminal', label: '执行命令', detail: 'cat foo.ts > bar.ts' });
    expect(toolPresentation({ name: 'Bash', input: { command: "sed -n '1,40p' README.md" } }))
      .toEqual({ kind: 'read', label: '读取文件', detail: "sed -n '1,40p' README.md" });
    expect(toolPresentation({ name: 'Bash', input: { command: "sed -i '' 's/a/b/' README.md" } }))
      .toEqual({ kind: 'terminal', label: '执行命令', detail: "sed -i '' 's/a/b/' README.md" });

    // 网络与网页
    expect(toolPresentation({ name: 'search_web', input: { query: 'ACP tool kind spec' } }))
      .toEqual({ kind: 'web', label: '搜索网页', detail: 'ACP tool kind spec' });
    expect(toolPresentation({ name: '"MoviePilot plugins" on Web', input: { query: 'MoviePilot plugins' } }))
      .toEqual({ kind: 'web', label: '搜索网页', detail: 'MoviePilot plugins' });
    expect(toolPresentation({ name: 'Web search: npm publish', input: { query: 'npm publish' } }))
      .toEqual({ kind: 'web', label: '搜索网页', detail: 'npm publish' });
    expect(toolPresentation({ name: 'Search "Remotion video"', input: { query: 'Remotion video' } }))
      .toEqual({ kind: 'web', label: '搜索网页', detail: 'Remotion video' });
    expect(toolPresentation({ name: 'WebFetch', input: { url: 'https://example.com/docs' } }))
      .toEqual({ kind: 'web', label: '读取网页', detail: 'https://example.com/docs' });
    expect(toolPresentation({ name: 'read_url_content', input: { Url: 'https://example.com/spec' } }))
      .toEqual({ kind: 'web', label: '读取网页', detail: 'https://example.com/spec' });
    expect(toolPresentation({ name: 'Fetch https://example.com', input: { url: 'https://example.com' } }))
      .toEqual({ kind: 'web', label: '读取网页', detail: 'https://example.com' });

    // 浏览器与 MCP
    expect(toolPresentation({ name: 'mcp.playwright.browser_tabs', input: { server: 'playwright', tool: 'browser_tabs' } }))
      .toEqual({ kind: 'browser', label: '操作浏览器', detail: 'playwright / browser_tabs' });
    expect(toolPresentation({ name: 'mcp__chrome-devtools__take_snapshot', input: {} }))
      .toEqual({ kind: 'browser', label: '操作浏览器', detail: 'chrome-devtools / take_snapshot' });
    expect(toolPresentation({ name: 'mcp__github__create_issue', input: { title: 'Bug' } }))
      .toEqual({ kind: 'mcp', label: '调用 MCP', detail: 'github / create_issue' });
    expect(toolPresentation({ name: 'mcp.cua_repl.js', input: { server: 'cua_repl', tool: 'js' } }))
      .toEqual({ kind: 'mcp', label: '调用 MCP', detail: 'cua_repl / js' });

    // 交互 / 规划 / 后台任务 / 定时 / 技能 / 图片生成 / 压缩
    expect(toolPresentation({ name: 'AskUserQuestion', input: { questions: [{ question: '要发布正式版吗？' }] } }))
      .toEqual({ kind: 'question', label: '发起提问', detail: '要发布正式版吗？' });
    expect(toolPresentation({ name: 'Run ask_question', input: { questions: [{ question: '选哪个方案？' }] } }))
      .toEqual({ kind: 'question', label: '发起提问', detail: '选哪个方案？' });
    expect(toolPresentation({ name: 'TodoWrite', input: { todos: [{ content: '排查根因' }, { content: '补齐单测' }] } }))
      .toEqual({ kind: 'plan', label: '更新待办', detail: '排查根因、补齐单测' });
    expect(toolPresentation({ name: 'update_plan', input: { plan: [{ step: '步骤一' }, { step: '步骤二' }] } }))
      .toEqual({ kind: 'plan', label: '更新计划', detail: '步骤一、步骤二' });
    expect(toolPresentation({ name: 'Approve Plan', kind: 'switch_mode', input: {} }))
      .toEqual({ kind: 'plan', label: '切换规划模式' });
    expect(toolPresentation({ name: 'Run schedule', input: { CronExpression: '*/5 * * * *', Prompt: '巡检构建' } }))
      .toEqual({ kind: 'task', label: '设置定时任务', detail: '*/5 * * * * · 巡检构建' });
    expect(toolPresentation({ name: 'Load skill: ego-browser', input: { skill: 'ego-browser' } }))
      .toEqual({ kind: 'skill', label: '加载技能', detail: 'ego-browser' });
    expect(toolPresentation({ name: 'Skill', input: { skill: 'run-workflow' } }))
      .toEqual({ kind: 'skill', label: '加载技能', detail: 'run-workflow' });
    expect(toolPresentation({ name: 'Run invoke_subagent', input: { TypeName: 'image-generator', Role: 'Illustration', Prompt: '画一只猫' } }))
      .toEqual({ kind: 'image', label: '生成图片', detail: '画一只猫' });
    expect(toolPresentation({ name: 'generate_image', input: { Prompt: '产品图标' } }))
      .toEqual({ kind: 'image', label: '生成图片', detail: '产品图标' });
    expect(toolPresentation({ name: 'Compact conversation', input: undefined }))
      .toEqual({ kind: 'plan', label: '压缩上下文' });

    // 流式通用占位 `tool call` 推断与边界兜底
    expect(toolPresentation({ name: 'tool call', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } }))
      .toEqual({ kind: 'edit', label: '修改文件', detail: 'src/a.ts' });
    expect(toolPresentation({ name: 'tool call', input: { file_path: 'src/a.ts', content: 'hello' } }))
      .toEqual({ kind: 'edit', label: '写入文件', detail: 'src/a.ts' });
    expect(toolPresentation({ name: 'tool call', input: { url: 'https://example.com' } }))
      .toEqual({ kind: 'web', label: '读取网页', detail: 'https://example.com' });
    expect(toolPresentation({ name: 'tool call', input: undefined }))
      .toEqual({ kind: 'tool', label: '工具调用' });
    expect(toolPresentation({ name: 'custom_vendor_tool', kind: 'read', input: { path: 'a.txt' } }))
      .toEqual({ kind: 'read', label: '读取文件', detail: 'a.txt' });
    expect(toolPresentation({ name: 'CustomVendorTool', input: { foo: 1 } }))
      .toEqual({ kind: 'tool', label: 'CustomVendorTool' });
  });

  it('summarizes batches with precise Chinese verbs, counts, and no redundant prefixes', () => {
    expect(summarizeTools([
      event('1', 'Terminal', { command: 'pwd' }),
      event('2', 'Terminal', { command: 'pnpm test' }),
      event('3', 'Read', { path: 'README.md' })
    ])).toBe('执行了命令 · 运行了测试 · 读取了文件');

    expect(summarizeTools([
      event('1', 'File apps/web/src/agent.ts', { Path: 'apps/web/src/agent.ts' }),
      event('2', 'File packages/agent-runtime/src/index.ts', { Path: 'packages/agent-runtime/src/index.ts' }),
      event('3', 'File apps/web/src/a.ts', { Path: 'apps/web/src/a.ts', Target: 'x', Replacement: 'y' }),
      event('4', 'write_file', { Path: 'apps/web/src/b.ts', Content: 'hi' }),
      event('5', 'apply_patch', {})
    ])).toBe('读取了 2 个文件 · 修改了文件 · 写入了文件 · 应用了补丁');

    expect(summarizeTools([
      event('1', 'list_dir', { DirectoryPath: 'apps' }),
      event('2', 'Glob', { pattern: '*.ts' }),
      event('3', 'Grep', { pattern: 'foo' }),
      event('4', 'Grep', { pattern: 'bar' })
    ])).toBe('查看了目录 · 查找了文件 · 搜索了 2 次内容');

    expect(summarizeTools([
      event('1', 'search_web', { query: 'a' }),
      event('2', 'WebFetch', { url: 'https://example.com' }),
      event('3', 'Bash', { command: 'ego-browser skill' })
    ])).toBe('搜索了网页 · 读取了网页 · 操作了浏览器');

    expect(summarizeTools([
      event('1', 'invoke_subagent', { TypeName: 'research', Role: 'R1', Prompt: 'p1' }),
      event('2', 'invoke_subagent', { TypeName: 'research', Role: 'R2', Prompt: 'p2' }),
      event('3', 'send_message', { Recipient: 'c1', Message: 'hi' }),
      event('4', 'manage_subagents', { Action: 'list' }),
      event('5', 'run_workflow', { Description: 'wf' })
    ])).toBe('调用了 2 个子 Agent · 发送了消息 · 管理了子 Agent · 运行了工作流');

    expect(summarizeTools([
      event('1', 'ask_question', { questions: [{ question: 'q?' }] }),
      event('2', 'TodoWrite', { todos: [{ content: 't' }] }),
      event('3', 'update_plan', { plan: [{ step: 's' }] }),
      event('4', 'Run manage_task', { Action: 'list' }),
      event('5', 'Run schedule', { DurationSeconds: 30, Prompt: 'ping' }),
      event('6', 'Skill', { skill: 'ego-browser' }),
      event('7', 'mcp__github__list_prs', {})
    ])).toBe('发起了提问 · 更新了待办 · 更新了计划 · 管理了后台任务 · 设置了定时任务 · 加载了技能 · 调用了 MCP 工具');

    expect(summarizeTools([event('1', 'tool call', undefined)])).toBe('调用了工具');
    expect(summarizeTools([event('1', 'CustomTool', {}), event('2', 'CustomTool', {})])).toBe('使用了 2 次 CustomTool');
  });

  it('formats running and completed action labels accurately across tool types', () => {
    const pairs: Array<[Parameters<typeof toolPresentation>[0], string, string]> = [
      [{ name: 'Terminal', input: { command: 'pwd' } }, '正在执行命令', '已执行命令'],
      [{ name: 'File packages/agent-runtime/src/index.ts', input: { Path: 'packages/agent-runtime/src/index.ts' } }, '正在读取文件', '已读取文件'],
      [{ name: 'view_file_outline', input: { AbsolutePath: 'a.ts' } }, '正在查看代码结构', '已查看代码结构'],
      [{ name: 'Edit', input: { file_path: 'a.ts' } }, '正在修改文件', '已修改文件'],
      [{ name: 'Write', input: { file_path: 'a.ts' } }, '正在写入文件', '已写入文件'],
      [{ name: 'apply_patch', input: {} }, '正在应用补丁', '已应用补丁'],
      [{ name: 'list_dir', input: { DirectoryPath: '.' } }, '正在查看目录', '已查看目录'],
      [{ name: 'Glob', input: { pattern: '*.ts' } }, '正在查找文件', '已查找文件'],
      [{ name: 'Grep', input: { pattern: 'foo' } }, '正在搜索内容', '已搜索内容'],
      [{ name: 'search_web', input: { query: 'test' } }, '正在搜索网页', '已搜索网页'],
      [{ name: 'WebFetch', input: { url: 'https://example.com' } }, '正在读取网页', '已读取网页'],
      [{ name: 'Bash', input: { command: 'ego-browser skill' } }, '正在操作浏览器', '已操作浏览器'],
      [{ name: 'invoke_subagent', input: { TypeName: 'research', Role: 'R', Prompt: 'p' } }, '正在调用子 Agent', '已调用子 Agent'],
      [{ name: 'send_message', input: { Recipient: 'a', Message: 'hi' } }, '正在发送消息', '已发送消息'],
      [{ name: 'run_workflow', input: { Description: 'wf' } }, '正在运行工作流', '已运行工作流'],
      [{ name: 'Terminal', input: { command: 'agent-dock group messages' } }, '正在进行 Agent 群协作', '已完成 Agent 群协作'],
      [{ name: 'ask_question', input: { questions: [{ question: 'q?' }] } }, '正在发起提问', '已发起提问'],
      [{ name: 'TodoWrite', input: { todos: [] } }, '正在更新待办', '已更新待办'],
      [{ name: 'update_plan', input: {} }, '正在更新计划', '已更新计划'],
      [{ name: 'Run manage_task', input: { Action: 'list' } }, '正在管理后台任务', '已管理后台任务'],
      [{ name: 'Run schedule', input: { DurationSeconds: 60, Prompt: 'check' } }, '正在设置定时任务', '已设置定时任务'],
      [{ name: 'Skill', input: { skill: 'ego-browser' } }, '正在加载技能', '已加载技能'],
      [{ name: 'mcp__github__get_pr', input: {} }, '正在调用 MCP 工具', '已调用 MCP 工具'],
      [{ name: 'tool call', input: undefined }, '正在执行工具', '已执行工具'],
      [{ name: 'CustomTool', input: {} }, '正在调用 CustomTool', '已调用 CustomTool']
    ];
    for (const [data, running, completed] of pairs) {
      const p = toolPresentation(data);
      expect(toolActionLabel(p, false), String(data.name)).toBe(running);
      expect(toolActionLabel(p, true), String(data.name)).toBe(completed);
    }
  });

  it('speaks the kitten\'s note commands in plain words', () => {
    expect(toolPresentation({ name: 'Terminal', input: { command: 'agent-dock task start --title "edit README 并跑 test" --done-when "有 diff" --json' } }))
      .toEqual({ kind: 'note', label: '派出便签', detail: 'edit README 并跑 test' });
    expect(toolPresentation({ name: 'agent-dock task report --kind done --text "已修复"', input: { CommandLine: 'agent-dock task report --kind done --text "已修复"' } }))
      .toEqual({ kind: 'note', label: '汇报完成', detail: '已修复' });
    expect(noteCommandPresentation("agent-dock task plan --title='整理发布说明'")).toEqual({ label: '写计划便签', detail: '整理发布说明' });
    expect(noteCommandPresentation('agent-dock task start atask_abc')).toEqual({ label: '便签开工', detail: 'atask_abc' });
    expect(noteCommandPresentation('agent-dock task review atask_abc --verdict accepted --check "测试=met:CI 绿"')).toEqual({ label: '验收通过', detail: 'atask_abc' });
    expect(noteCommandPresentation('agent-dock task review atask_abc --verdict rework')).toMatchObject({ label: '打回返工' });
    expect(noteCommandPresentation('agent-dock task cancel atask_abc --reason 不需要了')).toEqual({ label: '撕掉便签', detail: 'atask_abc' });
    expect(noteCommandPresentation('agent-dock task report --kind done --text "改好了" --evidence log')).toEqual({ label: '汇报完成', detail: '改好了' });
    expect(noteCommandPresentation('cd /repo && agent-dock notify "发版前需要你确认" --ask')).toEqual({ label: '请你拍板', detail: '发版前需要你确认' });
    expect(noteCommandPresentation('agent-dock watch add --name ci --command "gh run list"')).toEqual({ label: '布置盯梢', detail: 'ci' });
    expect(noteCommandPresentation('agent-dock session show ses_1')).toBeUndefined();
    expect(noteCommandPresentation('agent-dock task report --help')).toBeUndefined();
    expect(noteCommandPresentation('echo agent-docker task')).toBeUndefined();
    expect(toolActionLabel(toolPresentation({ name: 'Terminal', input: { command: 'agent-dock task start --title x' } }), false)).toBe('正在派出便签');
    expect(summarizeTools([event('one', 'Terminal', { command: 'agent-dock task start --title a' })])).toBe('派出便签');
  });

  it('formats tool and turn elapsed time', () => {
    expect(elapsedMilliseconds('2026-01-01T00:00:00.000Z', '2026-01-01T00:01:37.000Z')).toBe(97_000);
    expect(formatElapsed(780)).toBe('780 毫秒');
    expect(formatElapsed(97_000)).toBe('1 分 37 秒');
  });

  it('uses a tool description or Antigravity toolSummary as the human-readable action', () => {
    expect(toolDescription({ input: { command: 'find . -type f', description: '统计各项目 specs 数量' } })).toBe('统计各项目 specs 数量');
    expect(toolDescription({ input: { CommandLine: 'rg foo apps/', toolSummary: '搜索工具标签' } })).toBe('搜索工具标签');
  });

  it('collapses only consecutive tools with the same description', () => {
    const first = event('one', 'Terminal', { command: 'echo one', description: '检查项目' });
    const second = event('two', 'Terminal', { command: 'echo two', description: '检查项目' });
    const thinking = { ...event('thinking', 'thinking', {}), type: 'thinking', data: { text: '继续分析' } };
    const third = event('three', 'Terminal', { command: 'echo three', description: '检查项目' });
    const rows = groupToolActivityRows([first, second, thinking, third]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: 'batch', description: '检查项目', events: [first, second] });
    expect(rows[1]).toMatchObject({ kind: 'event', event: thinking });
    expect(rows[2]).toMatchObject({ kind: 'event', event: third });
  });
});
