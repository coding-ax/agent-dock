# 小猫的一生：自动整理、两种交接与老化

> 状态：P1 服务端、P2 网页已实现，单测 + 隔离沙箱端到端 + ego-browser 验收通过（见第 8 节）；P3 待排期 · 2026-11-12
> 前置：[`2026-11-09-agentdock-main-session-design.md`](2026-11-09-agentdock-main-session-design.md)（主会话、便签、督办）
> 一句话：主会话（小猫）和便签会越攒越多。daemon 持续量指标，到阈值先开一个**看得见的整理轮次**（`origin=maintenance`）帮你汇总、折叠；再往上就**提议交接**：老猫退休、新猫接班，事项原样转交。整个过程不删任何记录。

---

## 0. 名词

| 名词 | 含义 |
| --- | --- |
| 小猫 / 猫 | 一个 `assistant-main` 主会话在界面上的形象。一只猫 = 一条 `assistant_lineage` 记录。 |
| 血缘（family） | 从「认领」开始，经过一次次交接延续下来的一串猫。`familyId` 相同，`generation` 递增。 |
| 便签 | 主会话的事项（`assistant_tasks`），与 `agent-dock task` 是同一个东西。 |
| 整理轮次 | daemon 发给主会话的一轮 AI 对话，`origin=maintenance`，负责汇总、分组、折叠、提建议。 |
| 交接说明轮次 | 交接完成后 daemon 发给新主会话的第一轮，`origin=handoff`，内容是交接包。 |
| 交接包（handoff package） | 旧猫交给新猫的结构化上下文：旧会话 id、指标、最近对话、未完成事项、watch、草稿、文件索引、整理摘要。 |
| 归档区 | 被折叠的已关闭便签。只读、可查看、可「取出」（撤销折叠），不删除。 |

---

## 1. 两种交接

### 1.1 主会话交接（小猫退休 / 接班）

**目的**：主会话跑久了上下文膨胀、事件过多。换一个干净的新会话继续当主会话，同时不丢任何东西。

**做什么**

1. 旧主会话**归档为只读**（`runtime.archive`：先停 driver，再写 `archivedAt`）。它的事件、轮次、标题全部保留，网页可以打开查看，`agent-dock session show <旧id>` 可以读。
2. 事项、草稿、watch 都存在 assistant 库里，不随会话删除；交接只改「归属」，不删行。
3. 新建一个 `assistant-main` 会话，**继承**旧会话的 Agent、模型、思考深度、工作目录和猫的名字（可在仪式里给新猫另起名）。
4. 新会话通过**交接包**获得旧会话的关键上下文。交接包以一轮 `origin=handoff` 的系统轮次送达：
   - 时间线上渲染成「🐾 交接说明」卡片，**不是用户气泡**；
   - 发给 Agent 的正文开头明确写「这是 daemon 生成的交接包，不是用户消息」；
   - 正文里写明旧会话 id、旧猫名字和代数，以及怎么查旧会话。
5. 交接说明轮次**不触发派活**：`composePrompt` 不给系统轮次加 `<agentdock-superagent>`，并且系统轮次进行中 daemon 拒绝来自主会话的 `task start|plan`。
6. 血缘写入 `assistant_lineage`：旧猫 `state=retired`、`retiredAt`、`successorId`；新猫 `generation+1`、`predecessorId`、从幼猫开始。

### 1.2 事项 / 便签交接

**目的**：旧猫手上的活，原样转给新猫；已经做完的便签收进归档区，便签墙重新变清爽。

| 对象 | 交接动作 | 交接后状态 |
| --- | --- | --- |
| 未关闭事项（running / review / needs_user / 计划卡） | 记一条 transfer，事项本身不动（状态、侧边会话、返工轮次照旧）；督办照常按事项工作 | `transferred`；needs_user 与计划卡标 `needs_confirmation` |
| 侧边会话已不存在 / 已归档的未关闭事项 | 照样转交，但提示用户处理 | `needs_confirmation` |
| watch（active / paused） | `ownerSessionId` 改成新主会话（回滚时改回） | `transferred` |
| 待确认草稿（pending） | 记录转交；发送仍需用户确认 | `needs_confirmation` |
| 已关闭事项 | 折叠进归档区（同一个归档批次，`source=handoff`） | `archived`，可取出 |
| 已触发 / 已过期 watch、已发送 / 已丢弃草稿 | 只计数写进交接包，不转交 | — |

**交接结果（outcome）**，交接完成时三选一：

- `succeeded`：所有条目都 `transferred`。
- `needs_confirmation`：没有失败，但有条目需要用户确认（needs_user、计划卡、待确认草稿、侧边会话异常）。
- `partial`：至少一个条目 `failed`，或交接说明轮次没送达。旧会话仍然已安全归档、新主会话可用；失败条目在仪式结果页列出，可重试。

**不删除**：交接不会删除任何事项、草稿、watch、事件。归档区是只读视图，`agent-dock notes unarchive` 能取回。

### 1.3 交接仪式状态机

```
              ┌────────── cancel ──────────┐
              ▼                            │
  (trigger) proposed ──confirm──► confirmed ──► packing ──► spawning ──► transferring ──► switching ──► retiring ──► briefing ──► done(outcome)
                                     │            │            │              │             │            │            │
                                     └────────────┴────────────┴──────────────┴─────────────┴────────────┘            └─ 失败 → done(partial)
                                                         任一步失败 → rolling_back → rolled_back
```

| 状态 | 做什么 | 失败处理 |
| --- | --- | --- |
| `proposed` | 触发：用户手动（网页按钮 / `main handoff`）、阈值（`handoff` 档）、或主会话自己提议。界面显示邀请，**等用户确认**。 | 用户可「再陪我一阵」→ `cancelled` |
| `confirmed` | 用户确认。主会话正在忙（thinking/running_tool/等权限/有排队）时拒绝确认，返回「等这一轮结束再交接」。 | — |
| `packing` | 生成交接包（纯数据，可复现），落库。 | 回滚 |
| `spawning` | `runtime.start` 新建 `assistant-main` 会话，继承配置。 | 回滚 |
| `transferring` | 便签交接（1.2），每个条目写 `assistant_transfers`；已关闭事项折叠进归档批次。 | 回滚：watch 改回、归档批次撤销、transfer 标 `reverted` |
| `switching` | 主会话指针切到新会话，新猫写入血缘（`generation+1`、幼猫）。 | 回滚：指针改回旧会话，新猫标 `aborted` |
| `retiring` | 归档旧主会话（**提交点**），旧猫 `retired`。 | 回滚（旧会话此时尚未归档，安全） |
| `briefing` | 给新主会话发 `origin=handoff` 的交接说明轮次。 | 不回滚：`done(partial)`，可 `main handoff --resend <id>` 重发 |
| `done` | 记录 outcome，界面播「新猫出现 → 便签飞过去 → 完成」。 | — |

**回滚保证**：旧主会话在提交点之前从不被归档，所以回滚只需要：新会话归档（保留记录，标题加「交接失败」）、transfer 逐条复原、归档批次撤销、主会话指针改回。**不可能把旧主会话弄丢**：提交点之后它是归档只读的，血缘里永远记着它的 id。

**幂等**

- 同一时刻只允许一个未结束的交接：重复 `propose` 返回已有那一单。
- `confirm` 用数据库条件更新（`WHERE state='proposed'`）抢占，重复确认只返回当前进度，不会执行两次。
- transfer 以 `(handoffId, kind, itemId)` 唯一，重跑跳过已完成条目。
- `main handoff --yes` = propose + confirm，一条命令跑完；已在进行中就返回进度。

**崩溃恢复**：daemon 启动时扫描未结束的交接。提交点之前（packing…retiring）的一律回滚；`briefing` 的标成 `done(partial)`，提示重发。

**确认必须来自用户**：带 `from`（即 Agent 环境里执行）的 `confirm` 一律 403，Agent 只能 `propose`。网页按钮和普通终端（无 `agentdock_session_id`）才能确认。

---

## 2. 小猫老化

### 2.1 指标（每只猫各自计算）

| 指标 | 含义 | 来源 |
| --- | --- | --- |
| `rounds` | 主会话轮次数（不含 `maintenance` / `handoff` 系统轮次，不含排队/取消） | `tasks.listBySession(main)` |
| `compactions` | 成功完成的上下文压缩次数；一次压缩只算一个 `completed` 周期 | `events.countCompletedCompactions(main)` |
| `events` | 对话段数：连续 thinking / assistant text 流式分片各合为一段；`status`、`raw_terminal` 诊断行不计。只作高位上限保护 | `events.countConversationSegments(main)` |
| `contextPercent` | 最近一次上下文用量 `used/size` | 最近 400 条事件里最后一条 `status/usage` |
| `openNotes` | 未关闭便签数 | assistant 库 |
| `closedNotes` | 已关闭但未归档的便签数（用户从归档区「取出」过的不计，见 3.3「撤销是持久的」） | assistant 库 |
| `archivedNotes` | 归档区便签数（归档体积） | assistant 库 |
| `uptimeDays` | 这只猫连续当主会话的天数（自认领/接班起） | 血缘 `adoptedAt` |

指标最多 60 秒算一次（缓存），30 秒扫描和接口共用。主会话一轮结束（状态离开 thinking / running_tool / 等权限）时缓存立即失效，档案里的轮次数不会落后最多一分钟。

### 2.2 年龄与阶段

```
load      = max(rounds / R_handoff, (compactions / K_handoff)^0.83, contextPercent / C_handoff,
                events / E_handoff if events >= E_handoff else 0)                       # 用量疲劳（缺失的项不参与）
ageScore  = 0.8 × load + 0.2 × min(1.5, uptimeDays / D_handoff)
peak      = max(历史 peak, ageScore)                                                 # 单调：猫不会越活越年轻
lifeStage = kitten (<0.15) → adult (<0.45) → senior (<0.8) → elder (≥0.8)
```

- **不只按时间**：只挂着不用 45 天，`ageScore = 0.2` → 成年，永远到不了老年；用量才是主因。
- 达到任一项交接阈值时 `load ≥ 1` → `ageScore ≥ 0.8` → 老年，与「该交接了」一致。
- **压缩是主指标**：默认 `K_handoff=6`，压缩项用 `(count/6)^0.83` 的轻微凸曲线，
  使 3 次 completed 正好到 senior 的 `0.45`、6 次正好到 elder 的 `0.80`。对应的年龄分约为
  1 次 `0.181`、2 次 `0.321`、3 次 `0.450`、4 次 `0.571`、6 次 `0.800`。
  曲线只作用于压缩项，不改 rounds/context 的线性口径或全局阶段线。
- **事件只作上限**：`events` 未到 `E_handoff`（默认 60,000 段）时不进入 `load`，不会再因为流式分片
  或历史膨胀单独催老；越过上限才作为病理体积保护。
- 上下文被压缩后 `contextPercent` 会下降，但 `peak` 不降，所以阶段不会倒退。
- 交接后新猫 `peak=0`，从幼猫开始。

**为什么以压缩为主**：`contextPercent` 只反映当前窗口，压缩后会立刻回落，无法表达累积记忆压力；
`events` 即使按对话段合并仍受流式实现和历史长度影响；`rounds` 只数用户轮次，长工具链一轮也可能
耗尽上下文。`compactions` 是 provider 真正执行过上下文压缩的离散证据，最适合做主指标；`events`
保留为 60k 段的病理上限，`rounds` 和 `contextPercent` 继续覆盖没有压缩事件的 provider/历史代际。

**为什么事件不数原始行**：ACP 把思考与正文按 token 级 chunk 落库，一个几轮的小会话就能攒出几万行
（实测第 2 代：20 轮 / 42,259 行，合并后只有 735 个对话段）。`events` 的阈值是按「可阅读的对话体积」
定的，因此先按 Web 时间线同一套规则合并，再排除 `status` / `raw_terminal`；原始行数仍可用
`events.countBySession` 查诊断，但不再参与老化。

**上下文分母来自哪里**：`latestContextPercent` 直接读 ACP `usage_update` 的 `used/size`，
`size` 是 provider 给出的**模型有效窗口**，不是 AgentDock 的默认值或百分比换算。比如 1M 窗口的模型
会报告 `size=950000`（预留 5%），`used=154180` 时就是 16.2%。只有 `used<=0` 或 `size<=0` 的噪声
更新会被跳过；拿不到有效 usage 时这一项不参与档位与年龄计算。

**压缩怎么识别**：

- claude-agent-acp 把压缩横幅伪装成 `agent_message_chunk`；`normalizeAcpxEvent` 把
  `Compacting...`、`Compacting completed.`、`Compacting failed: ...` 归一成
  `status/compaction` 的 `start/completed/failed`。一次压缩会重复多条 `start`，所以只数 `completed`。
- codex-acp 发结构化的 `compaction_update`（`status=in_progress|completed|failed|cancelled`）和
  `compaction_summary_chunk`；两者也归一成 `status/compaction`，摘要不会落成 `raw_terminal`。
  同一个 `compactionId` 的重复 `completed` 去重计数；没有 id 的旧横幅按 completed 行数计。
- 历史会话或没有压缩事件的 provider 记 `0`，不会凭空补数；这些代际仍由 rounds / contextPercent
  计算，事件上限继续兜底。旧版本已落库的显式压缩横幅同样按 `completed` 计数。

| 阶段 | 文案基调 | 样子 | 整理冷却 | 交接提醒（被婉拒后再提醒） |
| --- | --- | --- | --- | --- |
| 幼猫 kitten | 刚来，精神满满 | 头顶一撮毛、瞳孔大、蹦得欢 | 24h | 不再提醒 |
| 成年 adult | 状态正好 | 标准 + 项圈 | 12h | 不再提醒 |
| 资深 senior | 经验老到 | 圆眼镜 | 8h | 7 天 |
| 老年 elder | 有点累了，想交接 | 眼镜 + 白眉 + 呼吸放慢 | 6h | 3 天 |

### 2.3 持久化

`assistant_lineage` 每只猫一行：`id, familyId, generation, sessionId, name, agentId, model, reasoningEffort, cwd, state(active|retired|released|aborted), lifeStage, peakAgeScore, rounds, adoptedAt, retiredAt, retiredReason, predecessorId, successorId, handoffId`。

- 认领（新建主会话 / `main set`）：新的 `familyId`，第 1 代。
- 交接：同一 `familyId`，`generation+1`。
- 让它休息（`main clear`）：当前猫 `state=released`，记录保留。
- 老版本升级：已有主会话但没有血缘记录时，懒创建第 1 代，`adoptedAt` 取原来的认领时间。

### 2.4 指标口径迁移（v2）

`assistant.lifecycle.metricVersion` 不存在或小于 2 时，第一次采集新指标会执行一次迁移：

1. 用新口径的 `compactions / events(对话段) / contextPercent / rounds` 重算当前猫的 `peakAgeScore`
   和 `lifeStage`，**覆盖旧 peak**（这是唯一一次允许峰值回落的路径，因为旧值来自错误口径）。
2. 清空旧 `assistant.lifecycle.alerts` 档位记录，避免旧 `events=handoff` 继续压着后续判断。
3. 若存在 `trigger=threshold` 的 `proposed` 交接，且其越线理由包含 `events`、而新口径下 events 已不在
   handoff 档，则把该提议标成 `cancelled`，写入 `recovery` 步骤和原因；不删除记录，也不会自动确认。
4. 写入 `metricVersion=2`。此后恢复普通 `advanceAge` 单调规则，不会再次重置。

迁移是惰性的：下一次 `collectMetrics`（网页打开档案、30 秒扫描、`maintenance status` 等）触发，
不需要手工改数据库；旧会话和旧便签数据不动。

### 2.5 配置口径迁移（v1）

0.3.4 为了避免旧构建按原始行重算 peak，曾把正式库的 `assistant.lifecycle.config` 临时设成
`events.tidy=200000 / events.handoff=300000`，且配置里还没有 `compactions`。0.3.5 首次启动时
（`AssistantLifecycle.initialize()`）执行一次配置规范化，并写入 `assistant.lifecycle.configVersion=1`：

1. 按默认值补齐缺失的阈值，重点是 `compactions = { tidy: 3, handoff: 6 }`。
2. 若 `events` 正好等于临时守卫值 `200000/300000`，恢复为新默认 `20000/60000`。
3. 把规范化后的完整配置落库（不是只在读取时补默认值），并写一行迁移日志。
4. `configVersion` 已存在时直接跳过，幂等；此后用户再手动设置 200000/300000 也不会被覆盖。

这一步和 2.4 的指标迁移相互独立：配置迁移保证事件上限保护立刻生效，指标迁移负责按新口径一次性
重算旧 peak 并作废旧 events 交接提议。

---

## 3. 自动检测与整理轮次

### 3.1 阈值（默认保守，可配置）

| 指标 | 整理档 `tidy` | 交接档 `handoff` |
| --- | --- | --- |
| rounds | 200 | 600 |
| compactions | 3 | 6 |
| events（对话段，上限保护） | 20,000 | 60,000 |
| contextPercent | 75% | 90% |
| openNotes | 15 | — |
| closedNotes | 40 | — |
| archivedNotes | 500 | — |
| uptimeDays | 14 | 45 |

配置项（`assistant.lifecycle.config`）：`autoMaintenance`（默认开）、`autoProposeHandoff`（默认开）、`foldClosedAfterHours`（默认 12，整理时只折叠关闭超过这么久的便签）、`maxAutoRunsPerDay`（默认 2）、每个阈值。CLI：`agent-dock maintenance config`；网页：「小猫与督办 → 小猫档案」。

### 3.2 档位动作

- 到 `tidy`：自动开一个**整理轮次**（主会话空闲时；忙就等下一次扫描）。
- 到 `handoff`：生成一张交接**提议**（`proposed`），界面上小猫冒泡、侧栏卡片标「该交接了」。**从不自动确认。**
- 档位只升不刷：每个指标记住「已处理到哪一档」（`alerts.levels`）。同一档只处理一次；指标继续恶化到更高档才再处理；指标回落（例如折叠后 closedNotes 变少）就把记录降下来，以后再越线才会再提醒。
- 用户手动 `maintenance run` / 网页「立即整理」不受档位和冷却限制（同一时刻仍只跑一个）。
- 换猫（交接/重新认领）后档位记录清零。

### 3.3 整理轮次（`origin=maintenance`）

**来源与可见性**

- 走 `runtime.dispatch(main, visible, 'queue', agentPrompt, undefined, 'maintenance')`。
- 时间线渲染成「🧹 整理轮次 · 系统发起」卡片：触发原因（哪些指标越线）、展开可看完整指令；完成后显示 AI 给的摘要和折叠结果，带「撤销折叠」。
- 卡片标题按发起方写，不冒充用户：阈值触发写越线指标（如「已完成便签 3/2」）；用户手动写「你让我收拾一下」；主会话自己 `maintenance run --from` 写「我自己收拾一下」，指令里也写「你（主会话）要求整理」，而不是「用户手动要求整理」。
- 不转发飞书，不发通知。

**撤销是持久的**

- 用户「取出」（`notes unarchive`、网页「撤销折叠」「取出」）会给便签打 `restoredAt`。之后自动折叠（整理轮次、交接）不再收它，`closedNotes` 也不再计它。否则冷却一过，指标又越线，同一批便签会被折回去，等于撤销白做。
- 用户手动 `notes archive` 指定的便签照样能收，以用户的决定为准。
- 交接回滚时由系统撤销归档批次，不打 `restoredAt`：这些便签以后仍可正常被整理。

**整理什么**

| 对象 | AI 做什么 | daemon 做什么 |
| --- | --- | --- |
| 对话轮次 / 事件时间线 | 用 5–10 行总结这一代主会话的主线、已定的事、待拍板的事 | 摘要存进 `assistant_maintenance_runs.summary`，作为下次交接包的「交接信」；时间线上以整理卡片标出「以上已整理」 |
| 已关闭便签 | 按主题分组列出 id | 轮次结束后把关闭超过 `foldClosedAfterHours` 的便签折叠进一个归档批次（`source=maintenance`），可撤销 |
| 工作区文件引用 | 只看索引，给归档/清理**建议** | 从主会话事件里提取路径做索引（次数、最近时间），**不删除、不修改任何文件** |

**绝不递归、绝不派活**

1. `composePrompt` 对 `maintenance` / `handoff` / `injected` 三种系统来源都不加 `<agentdock-superagent>`；文本里还有唯一标记兜底。
2. 系统轮次进行中，来自 Agent（带 `from`）的 `task start|plan`、计划卡开工、`watch add`、普通 `notify` 一律 409。
3. 同一时刻最多一个整理轮次；自动触发有阶段冷却和每日上限。
4. `rounds` 不计系统轮次；整理产生的事件即使让别的指标越线，也只会按档位规则处理一次（`tidy` 已处理过就不再触发整理，最多升到 `handoff` 档给一张提议）。
5. 督办器只看侧边会话；主会话的整理轮次结束不产生任何信号。

---

## 4. 接口

### 4.1 HTTP（`/api/assistant`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/lifecycle` | 当前猫（代数、阶段、年龄）、指标与档位、阈值配置、当前交接、最近整理、血缘 |
| GET | `/lineage` | 血缘列表（含已退休猫的旧会话 id） |
| POST | `/handoff` | 提议交接 `{ reason?, name?, from? }`；已有未结束的直接返回 |
| POST | `/handoff/:id/confirm` | 确认并执行；带 `from` 返回 403 |
| POST | `/handoff/:id/cancel` | 婉拒提议 |
| POST | `/handoff/:id/resend` | 重发交接说明轮次（`partial` 时） |
| GET | `/handoff/:id` | 交接详情：步骤、transfer 明细、交接包 |
| GET | `/handoffs` | 交接历史 |
| GET | `/maintenance` | 指标、档位、整理轮次历史 |
| POST | `/maintenance/run` | 手动整理 `{ reason? }` |
| PUT | `/maintenance/config` | 修改阈值与开关 |
| GET | `/notes/archive` | 归档区（按批次） |
| POST | `/notes/archive` | 折叠 `{ taskIds? , closedBeforeHours?, reason? }`，只接受已关闭事项 |
| POST | `/notes/unarchive` | 取出 `{ batchId? , taskIds? }` |

`GET /api/assistant/state` 额外带一个轻量的 `lifecycle` 字段（阶段、代数、提议、进行中的整理），网页不用多轮询一个接口。

### 4.2 CLI

```bash
agent-dock main handoff [--yes] [--name 新名字] [--reason 原因] [--wait 秒]   # 不带 --yes 只提议；带 --yes 立刻执行仪式，--wait 等到结束
agent-dock main handoff show [handoff-id]                        # 进度、transfer 明细、交接包
agent-dock main handoff cancel [handoff-id]
agent-dock main handoff resend <handoff-id>
agent-dock main lineage                                          # 血缘：每一代的猫和会话 id
agent-dock maintenance status                                    # 指标、档位、阈值、最近整理
agent-dock maintenance run [--reason 原因]
agent-dock maintenance config [--auto|--no-auto] [--auto-handoff|--no-auto-handoff] [--fold-after-hours 12] [--max-runs-per-day 2] [--set rounds.tidy=300 ...]
agent-dock notes list [--archived]
agent-dock notes archive [--task <id>...] [--closed-before-hours 12] [--reason 原因]
agent-dock notes unarchive (--batch <id> | --task <id>...)
```

权限：`main handoff --yes`/`confirm` 只接受用户（不带 `from`）；`propose`、`maintenance run`、`notes archive|unarchive` 允许主会话与用户；侧边会话一律 403。

---

## 5. 界面

1. **小猫样子**：`<Kitten stage>` 按阶段画头顶毛 / 眼镜 / 白眉，呼吸节奏随阶段放慢。主会话标题栏显示「第 N 代 · 资深」；侧栏卡片只有约 268px 宽，所以只显示阶段（如「老年」）和一个纯图标的「该交接了」角标，完整信息放在悬浮提示里，避免挤掉猫的名字。
2. **整理卡片**（主会话时间线）：系统发起徽标、触发原因、摘要、折叠批次与「撤销折叠」。
3. **交接邀请**：到交接档时小猫冒泡「我有点累了，要不要交接？」，点开仪式；侧栏卡片角标「该交接了」。
4. **交接仪式弹窗**（状态机直接驱动画面）：
   `为什么（越线指标）` → `确认（可给新猫起名）` → `老猫退休（挥手、戴上小帽子走远）` → `打包交接包（爪印进度）` → `新猫出现（幼猫蹦出来）` → `便签飞过去（逐条 transfer 状态）` → `完成（outcome 徽标、打开新主会话 / 查看旧会话只读）`。失败时显示「已回滚，旧主会话完好」。
5. **小猫档案**（设置弹窗）：代数、阶段、年龄条、各指标与阈值、血缘列表（可打开已退休猫的只读会话）、「立即整理」「交接仪式」、阈值编辑。
6. **便签抽屉 → 归档区**：按批次折叠展示，只读，可「取出」。

---

## 6. 分阶段交付

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| P1 服务端 | 纯逻辑模块（阈值、档位、年龄、交接包、状态机）、存储、交接仪式（含回滚/恢复/幂等）、便签交接与归档、整理轮次与防递归、接口、CLI | 纯逻辑单测 + 服务路径单测；沙箱 CLI 端到端 |
| P2 网页 | 小猫阶段样子、交接仪式弹窗、整理/交接卡片、小猫档案、归档区 | 组件纯逻辑单测；ego-browser 沙箱验收与截图 |
| P3 后续 | 交接时让老猫亲笔写「交接信」（额外一轮 AI，带超时）；`session peers` 按血缘认亲；时间线按整理点折叠历史轮次 | 另行排期 |

## 7. 实现位置

| 模块 | 文件 |
| --- | --- |
| 纯逻辑（阈值、档位、年龄、交接包、状态机、文件索引、整理/交接文案） | `apps/server/src/assistant/lifecycle.ts`（含 `SYSTEM_ROUND_ORIGINS`） |
| 存储（血缘、交接、transfer、归档批次、整理轮次；`assistant_tasks.archived_at/archive_batch_id/restored_at` 列，按 `PRAGMA table_info` 守卫迁移） | `apps/server/src/assistant/store.ts`、`types.ts` |
| 编排（指标与缓存失效、整理轮次、交接仪式、回滚、崩溃恢复、防递归守卫） | `apps/server/src/assistant/lifecycle-service.ts` |
| 主会话钩子（认领/清除/改名/快照/防派活：`SYSTEM_TURN_ORIGINS` 让 `composePrompt` 不加 `<agentdock-superagent>`，`buildSuperagentDirective` 认整理/交接标记兜底） | `apps/server/src/assistant/service.ts` |
| HTTP | `apps/server/src/assistant/lifecycle-routes.ts`，`routes.ts` 里的守卫与 `/state.lifecycle` |
| CLI | `apps/server/src/assistant/lifecycle-cli.ts`、`apps/server/src/cli-program.ts`、`apps/server/src/cli.ts` |
| 系统轮次锚点 | `packages/agent-runtime/src/index.ts`：`maintenance` / `handoff` 轮次的锚点事件带 `detail`（完整指令），和 `injected` 一样（`packages/shared` 没有改） |
| 网页：模型与数据 | `apps/web/src/companion/lifecycle-model.ts`（含 `isSystemRoundOrigin`）、`useCompanion.ts`（`useLifecycleOverview`）、`companion-store.ts`（仪式开关）、`api.ts` |
| 网页：组件 | `HandoffCeremony.tsx`（仪式弹窗）、`CatProfile.tsx`（小猫档案）、`ArchiveShelf.tsx`（归档区）、`LifecycleNotices.tsx`（整理 / 交接说明卡片）、`LifecycleBadges.tsx`（阶段徽标、「该交接了」角标）、`lifecycle.css`、`Kitten.tsx`、`CompanionLayer.tsx`（冒泡与事件反应）、`CompanionCard.tsx`、`CompanionHeader.tsx`、`CompanionEdge.tsx`、`HomeStage.tsx`、`StickyDrawer.tsx`、`AssistantSettingsDialog.tsx`、`App.tsx` |
| 网页：时间线 | `TimelineItems.tsx`（系统轮次卡片，不渲染用户气泡）、`timeline.ts`（展开指令）、`silent-trigger.ts`、`SessionPane.tsx`（系统轮次不进排队条） |
| 单测 | `apps/server/src/assistant/lifecycle.test.ts`（29）、`lifecycle-service.test.ts`（20）、`lifecycle-cli.test.ts`（3）、`apps/web/src/companion/lifecycle-model.test.ts`（16） |

## 8. 验证记录（2026-11-12）

**单测与检查**（在仓库里跑）：`pnpm test` 142 个文件 / 1488 个用例全过（其中生命周期 68 个）；`pnpm typecheck` 10 个包全过；`pnpm build` 通过（日志 `.agentdock/lifecycle-shots/pnpm-build-isolated.log`）。

**为什么在隔离副本里构建**：正式 daemon 会从仓库的 `apps/server/dist/agents/*.mjs` 拉起 adapter，而 `scripts/build.mjs` 第一步就是删掉 `dist`。在仓库里 `pnpm build` 会让正式实例短暂找不到 adapter。所以构建和端到端都在 `/tmp/agentdock-lifecycle-build`（rsync 的源码副本，`node_modules` 软链到仓库）里做，沙箱用 `dev up --repo` 起在独立端口。正式 daemon 和用户的 4399 沙箱都没有碰。

**沙箱端到端**（mock Agent，阈值调低；CLI 证据见 `.agentdock/lifecycle-shots/e2e-cli.txt`）：

1. 自动检测：「已完成便签 3/2」越线 → 自动开整理轮次（指令写「不是用户消息」）→ 折叠一个归档批次 → 「撤销折叠」取回 3 张。冷却期内没有重复整理。
2. 防递归：整理轮次进行中（主会话 `thinking`），以主会话身份（`--from`）发起的派活、计划、计划开工、watch、普通通知、嵌套整理都返回 409 `SYSTEM_ROUND_ACTIVE`「整理轮次里不能…」；走会话 send 接口的用户消息正常排队。
3. 老化：轮次 11/8 → 老年；只生成一张交接提议（Agent 提的那张），没有重复提醒。
4. 交接（网页仪式）：团子（第 1 代）→ 豆豆（第 2 代），outcome `needs_confirmation`：4 项转交，计划卡与草稿等确认。旧主会话归档只读（「该会话已永久归档，仅支持查看。」，没有输入框）；新主会话第一轮渲染成「交接说明」卡片，没有用户气泡。
5. 回滚：停用 Agent 后确认交接 → `spawning 失败：Agent 已停用` → `rolled_back`，主会话还是原来那只，便签、草稿、watch 都回到原处。
6. 第二次交接：豆豆 → 米粒（第 3 代）成功，血缘列表显示三代，每一代的旧会话都能只读打开。

**截图**（`.agentdock/lifecycle-shots/`）：`01-home-elder-chip-flag.png`、`02-ceremony-invite.png`、`03-ceremony-1-invite.png`、`03-ceremony-2-farewell.png`、`03-ceremony-3-done.png`、`04-ceremony-done.png`、`05-predecessor-session-readonly.png`、`06-new-main-handoff-briefing.png`、`07-cat-profile.png`、`08-drawer-archive-shelf.png`、`09-ceremony-user-invite.png`、`10-ceremony-rolled-back.png`、`11-ceremony-done-gen3.png`、`12-lineage-three-generations.png`。

**验收中发现并已修的问题**：

- 侧栏卡片太窄，「该交接了」角标盖住其他徽标、猫名被挤没。改成紧凑徽标后，角标可以点到，名字也露出来了。
- 撤销折叠不持久：冷却一过，同一批便签会被折回去。改为 `restoredAt` 机制（见 3.3）。
- 指标缓存让轮次数最多落后 60 秒：改为主会话一轮结束就失效。
- 主会话自己要求的整理被写成「用户手动要求」：改为按发起方写文案。
- CLI 时间按 UTC 打印：改为本地时间。
- 仪式里旧猫的名牌被裁切、离场时和新猫重叠，回滚文案重复：都已修。

**已知限制 / 后续**：

- `agent-dock session show` 把整理 / 交接系统轮次标成「用户」。格式化逻辑在 `session-cli-format.ts`，那个文件正被另一个事项修改，这次没碰，留作后续。
- P3（老猫亲笔交接信、`session peers` 按血缘认亲、时间线按整理点折叠）未做。
- mock Agent 回得很快，网页轮询只拍到「邀请 → 告别 → 完成」三段，中间的打包 / 转交动画没有单独截图（步骤列表在完成页里有）。
- `10-ceremony-rolled-back.png` 拍在回滚文案去重之前（图里是「…旧主会话完好 主会话还是原来那只…」）。去重后的文案（「<错误>。便签、草稿和 watch 都回到了原处。」）已通过类型检查和构建，但没有重拍。
- 只用 mock Agent 验证；真实模型的整理摘要质量没有测。移动端布局没有单独截图。
