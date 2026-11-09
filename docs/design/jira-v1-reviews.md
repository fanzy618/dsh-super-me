# 附：v1 设计的评审记录

本文是随设计文档一起提交的评审摘要；评审原文不随仓库发布。

| 评审人 | 模型 | 方式 | 全文 |
| --- | --- | --- | --- |
| codex | `gpt-6.1-sol` | 可读基线代码 | codex-gpt-6.1-sol.md |
| grok | grok | 仅读设计文档（工具受限） | grok.md |

被评审版本：design-v0.1.md。修订后的版本在 ../README.md（v0.2）。

## 两人独立指出的相同问题（最高置信）

| # | 问题 | codex 表述 | grok 表述 | v0.2 处置 |
| --- | --- | --- | --- | --- |
| 1 | 空 sprint 会清空 `seen`，carry-over 下一 sprint 全部重放 | “sprint 切换会重放或漏单” | “空 sprint 按离开清空 seen，carry-over 变新增，AC-4 无法成立” | §5.2 第 3 步 + §5.3 + AC-1/AC-4 + TC-U4 |
| 2 | 限流丢弃后记为已处理，永久丢失 | “丢弃后补”需待发队列 | “限流丢弃写入 seen 后无法补发” | §5.2 `pending` 队列 + AC-13 + TC-U8/I8 |
| 3 | 守望 Source 的 Trigger 仍会进 Eval | 指到 `src/core/intake.ts` 扇出后无条件 `queueForEval` | “intake:false 被写成 listened:false” | §4.3 拆分语义 + TC-U15 |
| 4 | `repos` accept 时锁定 vs 追问后确定 | “追问无法闭环” | “repos 在 accept 锁定却要追问后才定” | §6.4 两阶段 + AC-14 |
| 5 | 一个 MR 合并就整单结束 | “多仓可能提前结束或误报 merged” | “任一 MR 合并即整单结束” | §8.4 多交付聚合 + AC-10 + TC-U12 |
| 6 | 追问的回答进不来（不拉评论） | “未采集评论” | “轮询无 description/评论，追问闭环断” | §5.5 评论轮询 + AC-16 |

## codex 独有、经代码核实的问题

| 编号 | 问题 | 核实结果 | 处置 |
| --- | --- | --- | --- |
| C1 | prepare 循环失败不退出，目录存在即视为已准备 | ✅ `src/executor/dsh.ts`：`stat(workspace)` 存在即跳过 | §7.2 `.prepared` 标记 + AC-15 + TC-I7 |
| C2 | `EnvironmentInput` 拿不到 ticket 上下文 | ✅ `src/app/execution-environment.ts` 只传 `{deployment, config, trigger}` | §7.3 标注接口变更 |
| C3 | `orchestrator_report` 只接 `pr_number`（GitHub 专用） | ✅ `src/app/tools/executor.ts` 用 `readPull(host.github, …)` | §15 列为改动项 |
| C4 | PR 绑定还校验作者、源仓库与独占性 | ✅ `src/sources/github-pull.ts` 的 `claimPull` 三条校验 | §8.2 逐条对齐 |

## grok 独有、已采纳的问题

| 编号 | 问题 | 处置 |
| --- | --- | --- |
| G1 | Done/改派/移出不产事件，`dropped` 不可达 | §5.2 第 3 步“离开判定” + TC-U9 |
| G2 | 目录名不能当 GitLab 项目路径 | §6.1 拆 `dir` 与 `project` + AC-17 + TC-U13 |
| G3 | push 没有凭证 | §10 git credential helper + 凭证文件 |
| G4 | Jira Server 用 username/status.id，不是英文状态名/accountId | §2、§5.1 `actionableStatusIds` |
| G5 | 线程键 `PROJECT-KEY` 与 issue key 不一致 | §4.1 统一为 `jira:<issue-key>` |
| G6 | TC-I6 与“连续 3 次鉴权失败”冲突 | §5.7 统一为连续 3 次 |

## 未采纳 / 需确认

| 项 | 来源 | 原因 |
| --- | --- | --- |
| “AC-6 在有 default 时不可达” | grok | 已修正为“未知 component 且无 default”，并保留 `ask` 分支；若团队希望 default 永不失灵，可把 default 设为必填 |
| “验收‘一周期’与 AC-2 不符” | grok | 已把 §1 的验收句改为与 JQL 口径一致（指派给我 + open sprint），并在 AC-2 用“≤2 周期” |

## 结论

两位评审人都给 **“不能进入实现”**，理由集中在游标状态机、守望与 Eval 的耦合、仓库解析时机、多交付收尾四条主路径。v0.2 已逐条修订，并补了 6 个验收项（AC-12..AC-17）与 9 个测试用例。

**建议**：v0.2 再做一轮轻量复审（只审 §5.2、§6.4、§8.4、§15 四处），通过后进入 M1。

---

## v0.3 说明

v0.3 不是对上述评审的“回应修缮”，而是**需求澄清后的接入层重写**：Jira 改走本机 `jira` CLI、GitLab 改走 `glab`、删除静态仓库映射、`Ticket.repos` 改为执行期由 `orchestrator_checkout` 记录。

对上述评审结论的影响：

- **仍然有效**：P0-1（空 sprint 保留 seen）、P0-3（守望与 Eval 解耦）、P0-5（多交付收尾）、P0-6（prepare 原子性/评论闭环）→ 全部保留在 v0.3。
- **被取代**：P0-4（repos 冻结与追问矛盾）——两阶段解析整体删除，不再需要。
- **失效**：`features.yml` 相关的 P1（目录名 vs GitLab 项目路径、G4 路径映射）——项目路径由 `glab` 从当前目录推断，映射不存在了。
- **新增待审**：`orchestrator_checkout` 的越界校验、agent 自主选仓的确定性、CLI 输出解析的健壮性。

---

## 第二轮评审（针对 v0.3）

| 评审人 | 模型 | 方式 | 全文 |
| --- | --- | --- | --- |
| codex | `gpt-6.1-sol` | 可读基线代码 | r2-codex-gpt-6.1-sol.md |
| grok | grok | 文档全文内联 | r2-grok.md |

被评审版本：design-v0.3.md。结论：**两人都判“不能进入实现”**。

### 交叉确认（两人独立发现）

| 问题 | codex | grok | 核实 |
| --- | --- | --- | --- |
| 按“当前用户”过滤评论会吞掉人类回答（评论者与插件可能同身份） | P1-6 | P0-1 | ✅ 设计缺陷，无代码可证 |
| `jira issue list` 默认只 100 条，截断会被误判为“离开” | P1-5 | P0-3 | ✅ `--paginate` 默认 `0:100` |
| 空 `deliverables` 时“全部终态”恒真 → 误收尾 | P0-1 | P0-5 | ✅ 逻辑缺陷 |
| `deliverables` 该由 checkout 原子创建，而非等 agent 建 MR | P0-1 | P0-5 | ✅ |
| CLI 超时/部分成功会导致重复建 MR 或重复评论 | P1-8 | P1-2 | ✅ 设计缺陷 |

### codex 独有、已核实

| 编号 | 问题 | 核实 |
| --- | --- | --- |
| C1 | `setup.ts:79` 硬要求 GitHub，Jira-only 部署起不来 | ✅ `resolveDeployment` 无仓库即抛 `repositoryUnset` |
| C2 | `claimPull` 只绑定 open 状态 MR，快速合并会漏绑 | ✅ `src/sources/github-pull.ts` 的条件里有 `pr.state === 'open'` |
| C3 | §15 漏了 setup/deployment/policy/store/构建导出等必改项 | ✅ 确认遗漏 |

### grok 独有、已核实

| 编号 | 问题 | 核实 |
| --- | --- | --- |
| G1 | `jira issue comment add` **没有 `--body`**，文档里的命令不存在 | ✅ 实际是位置参数 `ISSUE-KEY [COMMENT_BODY]`，另有 `--no-input` |
| G2 | 自身评论使 `updated` 前进 → 评论/Trigger 死循环 | ✅ 设计缺陷（应改用内容指纹） |
| G3 | checkout 可被符号链接、`foo/../../x` 绕过 | ✅ 设计缺陷 |
| G4 | `agent/<name>` 与 `agent/<ticket-short-name>` 不一致 | ✅ 文档内部矛盾 |

### v0.4 处置

15 项全部采纳，新增 M0（解除 GitHub 硬依赖，1 天）、5 条验收（AC-18 自评论不成环、AC-19 翻页完整、AC-20 空交付不收尾、AC-21 并发 checkout、AC-22 写操作幂等）与 8 条测试用例。总验收从 17 条增至 22 条，工期从 15–21 人日调整为 17–22 人日。

### 建议

v0.4 只差一件事没验证：`jira issue view --comments N` 的排序与上限（Q9）。这不是设计问题，是**实现前 10 分钟的探针**。建议直接进 M0/M1，边做边验证 Q9 与 Q1。
