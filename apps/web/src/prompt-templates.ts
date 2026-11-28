import type { Locale } from '@agent-dock/agent-dock-shared';
import { getCurrentLocale, tWeb } from './i18n';

/**
 * 首页提示词模板与空会话快捷起步词。
 *
 * - 内置 6 套高频实战模板始终按当前界面语言（zh-CN / en-US）动态解析，不落本地持久化，
 *   确保切换语言时标题、简介、正文、变量名、提示文案与默认值 100% 同步切换。
 * - 模板正文采用干净的 Markdown 结构（无单换行黏连、占位符不含下划线），在 Milkdown
 *   所见即所得输入框与纯文本预览弹窗中都能清晰排版。
 * - 自定义模板保存在浏览器 localStorage，保留用户编辑的全部内容且绝不被内置升级覆盖。
 */

export type PromptTemplateIcon = 'repeat' | 'sparkles' | 'bug' | 'review' | 'refactor' | 'test' | 'compass' | 'custom';

export interface PromptTemplateField {
  /** 内置字段的跨语言稳定标识，用于切换语言时保留用户已填内容。 */
  id?: string;
  key: string;
  label: string;
  placeholder?: string;
  multiline?: boolean;
  optional?: boolean;
  defaultValue?: string;
}

export interface PromptTemplate {
  id: string;
  title: string;
  description: string;
  icon: PromptTemplateIcon;
  body: string;
  fields: PromptTemplateField[];
  builtin: boolean;
}

export interface SessionStarterPrompt {
  id: string;
  label: string;
  prompt: string;
}

export const PROMPT_TEMPLATE_STORAGE_KEY = 'agentdock.prompt-templates.v1';
const MAX_TITLE = 40;
const MAX_DESCRIPTION = 120;
const MAX_BODY = 20_000;
const MAX_CUSTOM_TEMPLATES = 50;

const DEFAULT_CUSTOM_DESCRIPTIONS = new Set([
  '',
  '自定义提示词模板',
  'Custom prompt template'
]);

const bugBodyZh = `请彻底排查并修复以下问题，严禁只治标不治本。

- **问题现象与线索**：{{问题与线索}}
- **验证方式**：{{验证命令}}

**执行要求**
1. **先复现再动手**：修改业务代码前，先用失败测试、最小复现命令或精确调用路径证实问题确实存在。
2. **深挖根因并查同类**：沿完整调用链定位真正根因（而非表层症状），并检索仓库内是否存在同类写法或联动受影响处，避免漏修。
3. **最小精准修复**：只改与根因直接相关的代码，不顺手重构无关模块；严禁吞异常、放宽断言、硬加 sleep/重试或绕过校验来“糊绿”测试。
4. **回归锁死并实跑**：补充覆盖该边界条件的回归测试，实际运行验证命令与类型检查，确认修复生效且无回归。

**交付格式**
- 根因分析（精确到 file:line 及触发链路）
- 修复改动与同类排查结论
- 实跑验证命令与关键输出（若发现底层设计冲突需大改，先停下说明方案与影响）`;

const featureBodyZh = `请按「先摸底规划 → 再最小实现 → 最后实跑验收」完成以下需求。

- **需求目标**：{{需求目标}}
- **边界与约束**：{{边界与约束}}

**执行要求**
1. **摸底与对齐**：先阅读相关源码、类型定义和现有测试，沿用项目既有模式。若发现关键需求歧义、破坏性变更或隐藏边界风险，先明确列出假设或停下确认，切勿擅自拍板。
2. **简明方案**：动手前先输出精炼实现计划——涉及文件清单、核心数据/状态流、边界与异常路径处理，以及潜在回归点。
3. **最小增量实现**：按计划干净落地，严禁顺手重构无关模块；关键路径与边界场景必须补齐对应测试。
4. **实跑自检**：运行相关单测、类型检查与构建命令（如适用），修完所有报错再交付。

**交付格式**
- 实现方案与关键改动文件（附简明设计取舍）
- 新增或更新的测试覆盖点
- 实跑验证命令、通过结果与遗留风险`;

const reviewBodyZh = `请以资深工程师视角对以下改动做一次严格、只讲干货的代码审查（先只读检查，不要直接改代码）。

- **审查范围**：{{审查范围}}
- **重点关注**：{{重点关注}}

**审查要求**
1. **结合上下文通读**：先检查 git status / diff，再阅读改动涉及的调用方、类型与相关测试，绝不只盯 diff 片段下结论。
2. **只报真问题，零废话凑数**：不要客套夸赞，也不要用无关风格充数；把真实缺陷按严重级别归类：
   - **P0（阻塞合并）**：必现 Bug、数据损坏、安全漏洞、崩溃或严重回归
   - **P1（高风险）**：边界条件漏洞、竞态/异步错误、资源泄漏、吞错、破坏兼容性、缺失关键测试
   - **P2（建议优化）**：具体可落地的可维护性或清晰度改进（精简列出）
3. **每条发现必须可验证**：给出精确 file:line、具体触发条件、实际后果与最小修复建议；无法百分百确认的明确标注「待确认」及核实方式。

**输出格式**
- 合并结论（可直接合并 / 修复 P0-P1 后合并 / 需重新设计）
- 分级问题清单（P0 / P1 / P2；无问题直接写“无”）
- 建议补充运行的验证命令或测试场景`;

const refactorBodyZh = `请对以下目标进行严格保行为的安全重构，目标是降低复杂度、消除重复与隐蔽耦合，绝不引入功能回归。

- **重构目标**：{{重构目标}}
- **行为不变约束**：{{行为约束}}

**执行要求**
1. **基线先行**：改任何代码前，先理清所有调用方并运行现有测试与类型检查建立基线；若关键逻辑缺少测试保护，先补齐刻画现状行为的保护性测试。
2. **明确重构边界**：先列出要治理的具体坏味道（如重复逻辑、过深嵌套、职责混杂、死代码）与目标结构，拒绝大拆大改或夹带需求变更。
3. **小步可回退推进**：按逻辑拆分为清晰的小步骤，每一步都保持可编译、测试全绿；避免为抽象而过度设计。
4. **终态核验**：重跑完整相关测试、类型检查与构建，核对 git diff 确认无意外行为偏移。

**交付格式**
- 重构前后结构对比与具体收益
- 不变量核查结果与新增的保护性测试
- 实跑基线与终态验证命令输出`;

const onboardingBodyZh = `请以只读方式帮我快速摸清当前代码库的真实结构与运行脉络（严禁修改任何文件）。

- **关注范围与问题**：{{关注范围}}

**调研要求**
1. **以真实代码为准**：结合目录结构、package.json / 构建脚本、入口文件与核心实现来梳理，不要只照抄可能过时的 README。
2. **画清主链路**：说明核心模块职责划分，并用精确 file:line 与关键符号追踪 1–2 条最核心的数据或控制流。
3. **给出阅读导航**：挑出最值得优先精读的 5 个文件，按推荐阅读顺序说明每个文件扮演什么角色。
4. **实测跑通指引**：总结本地启动、单测、类型检查与构建命令及常见坑点；顺手跑一条无副作用的最小检查命令验证环境可用（不可用则说明卡点）。

**输出格式**
- 一句话架构概览 + 精简模块拓扑
- 核心主链路追踪（附 file:line）
- Top 5 必读文件清单（按阅读顺序）
- 本地开发/测试命令与避坑提示`;

const verifyLoopBodyZh = `请以自主闭环模式持续推进以下任务：每轮严格执行「诊断 → 最小修复 → 重跑验收 → 记录进展」，直到验收命令全绿或触发停止条件。

- **目标任务**：{{目标任务}}
- **验收命令**：{{验收命令}}
- **最大轮次**：{{最大轮次}}

**每轮硬规则**
1. **先建基线**：开工前先检查仓库约定（如 AGENTS.md / CLAUDE.md）与当前 git status，先跑一次验收命令看清基线失败点。
2. **单点闭环**：每轮只聚焦解决一个独立、明确的根因失败项，保持改动克制，不做无关重构。
3. **严禁作弊糊绿**：绝不跳过或删除失败测试（skip/only）、放宽断言、屏蔽类型检查（@ts-ignore / any）或修改预期去迁就错误实现。
4. **改后必验**：每次修改后必须重跑验收命令，确认原失败项转绿且未引入新失败，再进入下一轮。

**停止条件**
- **验收全绿**：立即收敛，汇报每轮定位的根因、改动文件清单与最终命令输出。
- **达到最大轮次或连续 2 轮无实质进展**：立即停下，列出剩余失败项、已排除假设与建议人工介入点。
- **需要产品决策、外部凭证或破坏性架构调整**：立即停下询问，绝不猜测强改。`;

const bugBodyEn = `Investigate and fix the issue below at its root cause—do not patch over symptoms.

- **Issue & clues**: {{issue}}
- **Verification**: {{verify}}

**Workflow**
1. **Reproduce first**: Before editing production code, confirm the failure with a minimal failing test, repro command, or traced execution path.
2. **Isolate root cause & check siblings**: Trace the full call chain to the true cause (not the surface symptom), and search the codebase for sibling sites with the same flaw.
3. **Minimal, clean fix**: Change only what is needed for the root cause—no drive-by refactors. Never swallow exceptions, weaken assertions, or mask failures with arbitrary sleeps/retries.
4. **Lock in & verify**: Add a deterministic regression test covering the failure edge case, then run the verification command and typecheck to prove the fix and rule out regressions.

**Deliverable**
- Root cause analysis (exact file:line and trigger path)
- Changes made and sibling-site audit result
- Verification commands run and observed output (if a larger architectural change is needed, stop and explain trade-offs first)`;

const featureBodyEn = `Deliver the feature below following a "Read & Plan → Minimal Build → Real Verification" workflow.

- **Goal**: {{goal}}
- **Constraints**: {{constraints}}

**Workflow**
1. **Read & align first**: Inspect relevant code, types, and existing tests to match repo patterns. Surface ambiguities, breaking contracts, or tricky edge cases upfront—ask if blocking, otherwise state explicit assumptions.
2. **Brief plan before edits**: Outline affected files, core data/state flow, error & edge-case handling, and regression risks before writing code.
3. **Minimal implementation**: Ship the cleanest diff that satisfies the spec without drive-by refactors. Add or update tests covering critical and edge paths.
4. **Real self-verification**: Run relevant tests, typecheck, and build (if applicable) and resolve all failures before finishing.

**Deliverable**
- Summary of changes and key design trade-offs (with file paths)
- Test cases added or updated
- Verification commands run, observed results, and any remaining risks`;

const reviewBodyEn = `Perform a strict, high-signal staff-engineer code review for the changes below (read-only first—do not edit files).

- **Review scope**: {{scope}}
- **Focus areas**: {{focus}}

**Review Protocol**
1. **Read with full context**: Inspect git status and diff first, then read surrounding callers, types, and tests—never judge diff hunks in isolation.
2. **Signal over noise**: Skip filler praise and nitpick padding. Group real findings strictly by severity:
   - **P0 (Blocker)**: Definite bug, data loss/corruption, security flaw, crash, or severe regression
   - **P1 (High Risk)**: Edge-case failure, race/async bug, resource leak, swallowed error, API breakage, or missing critical tests
   - **P2 (Suggestion)**: Concrete maintainability or clarity improvements (keep brief)
3. **Evidence for every finding**: Include exact file:line, concrete trigger path, real impact, and a minimal fix. Mark anything unverified as "Needs verification" with how to check.

**Output Format**
- Merge verdict (Approve / Request changes / Needs redesign)
- Findings by severity (P0 / P1 / P2; state "None" if empty)
- Recommended verification commands or missing test cases`;

const refactorBodyEn = `Perform a strictly behavior-preserving refactor on the target below to cut complexity, duplication, and coupling without regressions.

- **Refactor target**: {{target}}
- **Behavior invariants**: {{invariants}}

**Workflow**
1. **Establish a baseline first**: Inspect all callers and run existing tests and typecheck before editing. If critical behavior lacks coverage, add characterization tests first to lock in current behavior.
2. **Scope the cleanup**: List the exact smells to remove (duplication, deep nesting, mixed responsibilities, dead code) and the intended structure. Do not mix in feature changes or unrelated rewrites.
3. **Small, verifiable steps**: Apply incremental, reversible edits and keep tests/types green throughout—avoid speculative over-abstraction.
4. **Final proof**: Re-run full relevant tests, typecheck, and build, then audit git diff to ensure zero unintended behavioral drift.

**Deliverable**
- Before/after structural summary and concrete improvements
- Invariants verified and any protective tests added
- Baseline vs. final verification command results`;

const onboardingBodyEn = `Map out this repository's real architecture and workflows in read-only mode (do not modify any files).

- **Focus / question**: {{focus}}

**Research Protocol**
1. **Ground in real code**: Inspect the directory tree, package/build scripts, entry points, and core modules—do not rely blindly on a potentially stale README.
2. **Trace core flows**: Explain module boundaries and trace 1–2 critical end-to-end data/control flows with exact file:line pointers and key symbols.
3. **Reading guide**: Pick the top 5 files to read first in recommended order, explaining what each file owns.
4. **Verified dev workflow**: Summarize how to run locally, test, typecheck, and build—plus real gotchas. Run one safe, non-destructive check command to confirm the local setup works (or report what is blocked).

**Output Format**
- One-line architecture summary + concise module map
- Core flow trace (with file:line references)
- Top 5 must-read files in reading order
- Local dev/test commands and gotchas`;

const verifyLoopBodyEn = `Run an autonomous "Diagnose → Minimal Fix → Re-Verify → Track" loop until the verification command passes cleanly or a stop condition triggers.

- **Goal**: {{goal}}
- **Verification command**: {{command}}
- **Max iterations**: {{rounds}}

**Per-Round Guardrails**
1. **Baseline first**: Check repo conventions (AGENTS.md / CLAUDE.md) and git status, then run the verification command once to establish exact baseline failures.
2. **One root cause per round**: Tackle one clear failure per iteration with minimal, targeted edits—no unrelated drive-by refactors.
3. **Zero cheating**: Never skip or delete failing tests (skip/only), loosen assertions, silence types (@ts-ignore / any), or alter expected behavior to hide a bug.
4. **Verify every change**: Re-run the full verification command after each fix to confirm progress and rule out regressions before the next round.

**Stop Conditions**
- **All checks pass**: Stop and report root causes fixed, modified files, and final verification output.
- **Max iterations reached or 2 consecutive rounds with no progress**: Stop and report remaining failures, ruled-out hypotheses, and concrete next steps.
- **Product decision, missing credentials, or breaking architectural change needed**: Stop immediately and ask rather than guessing.`;

const builtinPromptTemplatesZh: PromptTemplate[] = [
  {
    id: 'builtin-bug',
    title: '根因修 Bug',
    description: '复现定因、查同类隐患并补回归测试',
    icon: 'bug',
    body: bugBodyZh,
    builtin: true,
    fields: [
      {
        id: 'issue',
        key: '问题与线索',
        label: '问题现象 / 报错线索',
        placeholder: '粘贴报错堆栈、复现步骤，或一句话描述异常与预期行为',
        multiline: true
      },
      {
        id: 'verify',
        key: '验证命令',
        label: '验证命令',
        placeholder: '例如：pnpm test src/foo.test.ts',
        defaultValue: '自动识别并运行相关单测与类型检查',
        optional: true
      }
    ]
  },
  {
    id: 'builtin-feature',
    title: '需求规划与实现',
    description: '先出文件级方案与边界，再最小实现验收',
    icon: 'sparkles',
    body: featureBodyZh,
    builtin: true,
    fields: [
      {
        id: 'goal',
        key: '需求目标',
        label: '要实现的需求与预期效果',
        placeholder: '描述用户可见行为、输入输出及最关心的验收标准',
        multiline: true
      },
      {
        id: 'constraints',
        key: '边界与约束',
        label: '边界与约束',
        placeholder: '例如：不改公开 API、兼容旧数据、不引入新依赖',
        defaultValue: '沿用现有架构与代码风格，保持对外接口兼容，不引入不必要依赖',
        optional: true
      }
    ]
  },
  {
    id: 'builtin-review',
    title: '严格代码审查',
    description: '即点即用 · 结合上下文输出 P0-P2 审查结论',
    icon: 'review',
    body: reviewBodyZh,
    builtin: true,
    fields: [
      {
        id: 'scope',
        key: '审查范围',
        label: '审查范围',
        placeholder: '例如：git diff main...HEAD 或指定文件路径',
        defaultValue: '当前工作区全部未提交改动（含暂存与未暂存）；若工作区干净则审查最近一次提交或 main...HEAD'
      },
      {
        id: 'focus',
        key: '重点关注',
        label: '重点关注',
        placeholder: '例如：并发竞争、权限校验、性能瓶颈、状态一致性',
        defaultValue: '正确性、边界条件、异步/并发与资源释放、安全鉴权、兼容与测试缺口',
        optional: true
      }
    ]
  },
  {
    id: 'builtin-refactor',
    title: '安全重构治理',
    description: '先跑基线锁行为，再小步降复杂度零回归',
    icon: 'refactor',
    body: refactorBodyZh,
    builtin: true,
    fields: [
      {
        id: 'target',
        key: '重构目标',
        label: '重构模块 / 文件或代码痛点',
        placeholder: '例如：apps/server/src/service.ts 中重复的状态流转逻辑',
        multiline: true
      },
      {
        id: 'invariants',
        key: '行为约束',
        label: '不可破坏的行为约束',
        placeholder: '例如：对外 API 签名、错误码与持久化格式保持完全兼容',
        defaultValue: '保持对外接口、返回值、错误语义与持久化格式完全兼容，并通过全部现有测试与类型检查',
        optional: true
      }
    ]
  },
  {
    id: 'builtin-onboarding',
    title: '摸清代码脉络',
    description: '即点即用 · 只读梳理架构、主链路与启动命令',
    icon: 'compass',
    body: onboardingBodyZh,
    builtin: true,
    fields: [
      {
        id: 'focus',
        key: '关注范围',
        label: '想摸清的模块或问题',
        placeholder: '例如：一次请求从前端到后端持久化经过了哪些模块？',
        defaultValue: '整个仓库的模块边界、核心入口到主链路数据流，以及本地开发/测试/构建方式',
        multiline: true
      }
    ]
  },
  {
    id: 'builtin-verify-loop',
    title: '自检迭代到全绿',
    description: '自主诊断修复重跑，直到验收命令全绿',
    icon: 'repeat',
    body: verifyLoopBodyZh,
    builtin: true,
    fields: [
      {
        id: 'goal',
        key: '目标任务',
        label: '要达成的目标',
        placeholder: '例如：修完当前分支所有类型报错和失败单测，并保持公共 API 不变',
        multiline: true
      },
      {
        id: 'command',
        key: '验收命令',
        label: '验收命令',
        placeholder: '例如：pnpm typecheck && pnpm test',
        defaultValue: 'pnpm typecheck && pnpm test'
      },
      {
        id: 'rounds',
        key: '最大轮次',
        label: '最大迭代轮次',
        defaultValue: '8'
      }
    ]
  }
];

const builtinPromptTemplatesEn: PromptTemplate[] = [
  {
    id: 'builtin-bug',
    title: 'Debug & Fix',
    description: 'Reproduce, fix root cause & add tests',
    icon: 'bug',
    body: bugBodyEn,
    builtin: true,
    fields: [
      {
        id: 'issue',
        key: 'issue',
        label: 'Issue, repro, or error log',
        placeholder: 'Paste a stack trace, repro steps, or actual vs. expected behavior',
        multiline: true
      },
      {
        id: 'verify',
        key: 'verify',
        label: 'Verification command',
        placeholder: 'e.g. pnpm test src/foo.test.ts',
        defaultValue: 'Auto-detect and run relevant tests & typecheck',
        optional: true
      }
    ]
  },
  {
    id: 'builtin-feature',
    title: 'Plan & Build',
    description: 'Design plan & edge cases, then ship',
    icon: 'sparkles',
    body: featureBodyEn,
    builtin: true,
    fields: [
      {
        id: 'goal',
        key: 'goal',
        label: 'Feature goal & expected behavior',
        placeholder: 'Describe user-visible behavior, inputs/outputs, and acceptance criteria',
        multiline: true
      },
      {
        id: 'constraints',
        key: 'constraints',
        label: 'Constraints & boundaries',
        placeholder: 'e.g. Keep public APIs stable, preserve legacy data, no new deps',
        defaultValue: 'Follow existing architecture & patterns, preserve backward compatibility, avoid unnecessary dependencies',
        optional: true
      }
    ]
  },
  {
    id: 'builtin-review',
    title: 'Code Review',
    description: '1-click · P0-P2 diff audit & verdict',
    icon: 'review',
    body: reviewBodyEn,
    builtin: true,
    fields: [
      {
        id: 'scope',
        key: 'scope',
        label: 'Review scope',
        placeholder: 'e.g. git diff main...HEAD or specific file paths',
        defaultValue: 'All uncommitted workspace changes (staged & unstaged); if clean, the latest commit or main...HEAD'
      },
      {
        id: 'focus',
        key: 'focus',
        label: 'Focus areas',
        placeholder: 'e.g. race conditions, auth checks, perf, state consistency',
        defaultValue: 'Correctness, edge cases, async/concurrency & cleanup, security/auth, compatibility & missing tests',
        optional: true
      }
    ]
  },
  {
    id: 'builtin-refactor',
    title: 'Safe Refactor',
    description: 'Lock baseline tests, simplify safely',
    icon: 'refactor',
    body: refactorBodyEn,
    builtin: true,
    fields: [
      {
        id: 'target',
        key: 'target',
        label: 'Target module, files, or code smell',
        placeholder: 'e.g. Duplicated state transitions in apps/server/src/service.ts',
        multiline: true
      },
      {
        id: 'invariants',
        key: 'invariants',
        label: 'Behavior invariants',
        placeholder: 'e.g. Keep public API signatures, error codes, and storage schema identical',
        defaultValue: 'Keep public APIs, return values, error semantics, and persisted formats 100% compatible; pass all existing tests & typecheck',
        optional: true
      }
    ]
  },
  {
    id: 'builtin-onboarding',
    title: 'Codebase Map',
    description: '1-click · Read-only repo & flow map',
    icon: 'compass',
    body: onboardingBodyEn,
    builtin: true,
    fields: [
      {
        id: 'focus',
        key: 'focus',
        label: 'What to map or understand',
        placeholder: 'e.g. How does a request flow from the UI through the API to storage?',
        defaultValue: 'Overall module boundaries, core entry-to-storage data flows, and local dev/test/build workflow',
        multiline: true
      }
    ]
  },
  {
    id: 'builtin-verify-loop',
    title: 'Run to Green',
    description: 'Iterate fixes until all checks pass',
    icon: 'repeat',
    body: verifyLoopBodyEn,
    builtin: true,
    fields: [
      {
        id: 'goal',
        key: 'goal',
        label: 'Target outcome',
        placeholder: 'e.g. Fix all failing tests and type errors on this branch without changing public APIs',
        multiline: true
      },
      {
        id: 'command',
        key: 'command',
        label: 'Verification command',
        placeholder: 'e.g. pnpm typecheck && pnpm test',
        defaultValue: 'pnpm typecheck && pnpm test'
      },
      {
        id: 'rounds',
        key: 'rounds',
        label: 'Max iterations',
        defaultValue: '8'
      }
    ]
  }
];

const sessionStarterPromptsZh: SessionStarterPrompt[] = [
  {
    id: 'starter-map-project',
    label: '摸清当前项目',
    prompt: '请只读梳理当前项目（不要修改文件）：先概括技术栈与核心目录职责，再用 file:line 追踪 1 条最核心的主链路，列出最值得先读的 3 个文件，以及本地启动和测试命令。'
  },
  {
    id: 'starter-review-diff',
    label: '审查未提交改动',
    prompt: '请结合上下文只读审查当前工作区的未提交改动（含 git status 与 diff）：只报真实 Bug、边界条件、并发/资源或回归风险，按 P0/P1/P2 给出 file:line、触发条件和最小修复建议。'
  },
  {
    id: 'starter-plan-next',
    label: '梳理下一步计划',
    prompt: '请检查当前分支状态、近期提交与待办线索（先不要改代码）：帮我梳理当前进展与潜在阻塞，并按优先级给出接下来最值得做的 3 个最小可验证增量及验收命令。'
  }
];

const sessionStarterPromptsEn: SessionStarterPrompt[] = [
  {
    id: 'starter-map-project',
    label: 'Map this project',
    prompt: 'Map this project in read-only mode (do not edit files): summarize the tech stack and core directories, trace one critical end-to-end flow with file:line references, list the top 3 files to read first, and share verified local dev/test commands.'
  },
  {
    id: 'starter-review-diff',
    label: 'Review uncommitted changes',
    prompt: 'Review all uncommitted changes in this workspace (git status & diff) with surrounding context in read-only mode. Report only real bugs, edge cases, concurrency/cleanup, or regression risks grouped by P0/P1/P2 with file:line, trigger path, and minimal fixes.'
  },
  {
    id: 'starter-plan-next',
    label: 'Plan the next steps',
    prompt: 'Inspect the current branch state, recent commits, and open TODOs without editing files. Summarize current progress, flag risks or blockers, and propose the top 3 smallest verifiable next increments with verification commands.'
  }
];

export function getBuiltinPromptTemplates(locale: Locale = getCurrentLocale()): PromptTemplate[] {
  return locale === 'en-US' ? builtinPromptTemplatesEn : builtinPromptTemplatesZh;
}

export const builtinPromptTemplates: PromptTemplate[] = builtinPromptTemplatesZh;

export function getSessionStarterPrompts(locale: Locale = getCurrentLocale()): SessionStarterPrompt[] {
  return locale === 'en-US' ? sessionStarterPromptsEn : sessionStarterPromptsZh;
}

/** 按出现顺序提取 `{{变量}}`，重复的只保留一次。 */
export function extractTemplateFields(body: string): PromptTemplateField[] {
  const seen = new Set<string>();
  const fields: PromptTemplateField[] = [];
  for (const match of body.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const key = match[1]!.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fields.push({ key, label: key, multiline: true });
  }
  return fields;
}

/**
 * 把变量填进模板。所有变量都是可选的：没填的保留 `{{变量}}` 占位，
 * 让用户能在输入框里直接看到还差什么，而不是被必填校验挡在表单里。
 */
export function applyPromptTemplate(template: PromptTemplate, values: Record<string, string>): string {
  return template.body.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, rawKey: string) => {
    const key = rawKey.trim();
    return values[key]?.trim() || `{{${key}}}`;
  });
}

/** 返回模板使用默认变量渲染后的直接填入文本。 */
export function getBuiltinTemplateDefaultText(template: PromptTemplate): string {
  const defaults = Object.fromEntries(template.fields.map(field => [field.key, field.defaultValue ?? '']));
  return applyPromptTemplate(template, defaults);
}

/** 返回一段文案里尚未填写的去重 `{{变量}}` 占位名。 */
export function getUnfilledPlaceholderKeys(text: string): string[] {
  return extractTemplateFields(text).map(field => field.key);
}

/** 是否所有变量都有默认值（点卡片直接填入即可无修改发送）。 */
export function isTemplateReadyToRun(template: PromptTemplate): boolean {
  return getUnfilledPlaceholderKeys(getBuiltinTemplateDefaultText(template)).length === 0;
}

/** 归一化 Milkdown / ProseMirror 回写带来的无语义差异（如 `* ` vs `- `、多余空行或转义反斜杠）。 */
function normalizePromptForComparison(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .split('\n')
    .map(line => line.replace(/^(\s*)[*-]\s+/, '$1- ').trimEnd())
    .filter((line, index, arr) => !(line === '' && (index === 0 || arr[index - 1] === '')))
    .join('\n')
    .trim();
}

/**
 * 若输入框里恰好是某个内置模板在旧语言下的“未修改默认填入文本”，
 * 切换语言时自动替换为新语言对应的默认填入文本；只要用户改过一字即保持原样。
 */
export function translateUnmodifiedBuiltinPrompt(
  currentText: string,
  fromLocale: Locale,
  toLocale: Locale
): string | undefined {
  if (!currentText || fromLocale === toLocale) return undefined;
  const normalizedCurrent = normalizePromptForComparison(currentText);
  const sourceTemplates = getBuiltinPromptTemplates(fromLocale);
  const targetTemplates = getBuiltinPromptTemplates(toLocale);
  for (const source of sourceTemplates) {
    if (normalizePromptForComparison(getBuiltinTemplateDefaultText(source)) === normalizedCurrent) {
      const target = targetTemplates.find(item => item.id === source.id);
      if (target) return getBuiltinTemplateDefaultText(target);
    }
  }
  return undefined;
}

export function isDefaultCustomDescription(description: string | null | undefined): boolean {
  return DEFAULT_CUSTOM_DESCRIPTIONS.has((description ?? '').trim());
}

export function displayPromptTemplateDescription(template: PromptTemplate, locale: Locale = getCurrentLocale()): string {
  if (!template.builtin && isDefaultCustomDescription(template.description)) {
    return tWeb('prompts.custom.defaultDesc', undefined, locale);
  }
  return template.description;
}

/** localStorage 是外部输入：只接受结构正确的条目，长度也在这里收口。 */
export function parseCustomTemplates(raw: string | null | undefined, locale: Locale = getCurrentLocale()): PromptTemplate[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const result: PromptTemplate[] = [];
  const ids = new Set<string>();
  for (const value of parsed) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id.trim() || ids.has(record.id)) continue;
    if (typeof record.title !== 'string' || !record.title.trim()) continue;
    if (typeof record.body !== 'string' || !record.body.trim()) continue;
    const title = record.title.trim().slice(0, MAX_TITLE);
    const rawDesc = typeof record.description === 'string' ? record.description.trim() : '';
    const description = isDefaultCustomDescription(rawDesc)
      ? tWeb('prompts.custom.defaultDesc', undefined, locale)
      : rawDesc.slice(0, MAX_DESCRIPTION);
    const body = record.body.slice(0, MAX_BODY);
    ids.add(record.id);
    result.push({
      id: record.id, title, description, body, icon: 'custom', builtin: false,
      fields: extractTemplateFields(body)
    });
    if (result.length >= MAX_CUSTOM_TEMPLATES) break;
  }
  return result;
}

export function serializeCustomTemplates(templates: PromptTemplate[]): string {
  return JSON.stringify(templates.map(template => ({
    id: template.id,
    title: template.title.slice(0, MAX_TITLE),
    description: isDefaultCustomDescription(template.description) ? '' : template.description.slice(0, MAX_DESCRIPTION),
    body: template.body.slice(0, MAX_BODY)
  })));
}

export interface CustomTemplateInput {
  title: string;
  description: string;
  body: string;
}

export function customTemplateFromInput(input: CustomTemplateInput, id?: string, locale: Locale = getCurrentLocale()): PromptTemplate {
  const title = input.title.trim().slice(0, MAX_TITLE);
  const body = input.body.trim().slice(0, MAX_BODY);
  if (!title) throw new Error(tWeb('prompts.error.emptyTitle', undefined, locale));
  if (!body) throw new Error(tWeb('prompts.error.emptyBody', undefined, locale));
  const rawDesc = input.description.trim();
  return {
    id: id ?? `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    title,
    description: isDefaultCustomDescription(rawDesc)
      ? tWeb('prompts.custom.defaultDesc', undefined, locale)
      : rawDesc.slice(0, MAX_DESCRIPTION),
    icon: 'custom',
    body,
    builtin: false,
    fields: extractTemplateFields(body)
  };
}

export function loadCustomTemplates(locale: Locale = getCurrentLocale()): PromptTemplate[] {
  try {
    return parseCustomTemplates(window.localStorage.getItem(PROMPT_TEMPLATE_STORAGE_KEY), locale);
  } catch { return []; }
}

export function saveCustomTemplates(templates: PromptTemplate[]): void {
  try {
    window.localStorage.setItem(PROMPT_TEMPLATE_STORAGE_KEY, serializeCustomTemplates(templates));
  } catch { /* 隐私模式或存储已满：本次会话内仍然可用 */ }
}
