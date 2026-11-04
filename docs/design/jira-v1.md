# dsh-superagent v1：Jira 驱动的多仓库任务代理

| 项 | 值 |
| --- | --- |
| 状态 | 草案 v0.5（探针已验证 Q1/Q9/Q11，待实现） |
| 日期 | 2026-11-04 |
| 基线代码 | `dsh-superagent-prototype` @ `6337fc8` |
| 范围 | v1 只做 Jira 入口 + GitLab 交付；不含 IM |
| 历史 | [评审记录](reviews/)；v0.2 修 P0×6，v0.3 重写接入层，v0.4 修第二轮 P0×7 |

## 修订记录

**v0.4 → v0.5**：在真实 Jira 上跑探针，三个悬而未决的问题落地。

| 探针 | 实测结果 | 对设计的影响 |
| --- | --- | --- |
| Q1 `sprint in openSprints()` | ✅ 正常返回 JSON（示例项目当前 sprint 为百量级） | 不需要退化为 board API |
| Q9 评论读取 | `--comments N` **不裁剪** raw 输出：N=1 返回 3 条；评论按 id 升序返回完整列表 | 游标策略简化为“取全量 + id 去重”，删掉“N 逐步翻大”的复杂逻辑 |
| 分页 | `--paginate 0:3` / `3:3` 正确翻页；**不带 paginate 实测恰好返回 100 条** | AC-19 的截断风险属实，翻页为强制要求 |
| 单页上限 | `--paginate 0:200` **静默返回空数组**（退出码 0） | pageSize 硬性 ≤100 并在加载时校验，否则空数组会被误判为“无 issue” |
| 规模 | 实测样本：open sprint 为百量级，其中指派给操作者且未完成的为十量级 | `maxTriggersPerRound=20` 足够；sprint 切换时一轮即可清空 |
| 鉴权失败 | 未登录：退出 1 + `needs a Jira API token`；坏 token：退出 1 + `401` | 空数组 + 退出 0 才是“无 sprint”，删掉每轮额外调用 `jira me` |

**v0.3 → v0.4**：第二轮评审（gpt-6.1-sol 读代码 + grok 读文档）独立发现以下问题，全部采纳。

| # | 问题 | 严重度 | 处置 |
| --- | --- | --- | --- |
| 1 | `setup.ts:79` 硬要求 GitHub，Jira-only 部署根本起不来 | P0 | §2.2 GitHub 变为可选 |
| 2 | 自身评论使 `updated` 前进，形成评论→Trigger→再评论的死循环 | P0 | §5.3 改用内容指纹，不用 `updated` |
| 3 | 过滤“当前用户”的评论会丢掉人类回答（评论者与插件可能同身份） | P0 | §5.3 只按插件标记过滤 |
| 4 | `jira issue list` 默认只返回 100 条，被截断时误判“离开” | P0 | §5.2 强制 `--paginate` 翻页至空页 |
| 5 | `deliverables` 为空时“全部终态”恒真，工单被误收尾 | P0 | §7.2 checkout 原子写 pending；§8.4 空集合显式不算完成 |
| 6 | checkout 路径可被符号链接/`..` 绕过，并发 worktree 竞态 | P0 | §6.1 单段名 + realpath 边界 + lstat 拒符号链接 + 按仓加锁 |
| 7 | 快速合并的 MR 因“只绑定 open”漏绑 | P0 | §8.4 绑定接受终态，扫描覆盖全部状态 |
| 8 | `jira issue comment add` 没有 `--body` 参数（文档里的命令不存在） | P1 | §5.2 改为位置参数 + `--no-input` |
| 9 | 评论窗口 20 条与游标不一致，间隔期评论永久跳过 | P1 | §5.3 翻页追至游标，未追平不前进 |
| 10 | CLI 超时后重试会重复建 MR / 重复评论 | P1 | §5.2、§8.1 写操作视为“结果未知”，先查后重试 |
| 11 | 选仓无机械闸门，全靠提示词 | P1 | §6.2 数量上限 + 多仓需确认 + 记录依据 |
| 12 | §15 漏了 setup/deployment/policy/store/构建导出等必改项 | P1 | §15 补全 |
| 13 | 分支名 `agent/<name>` 与工单短名不一致，会绑错 MR | P2 | 全统一为 `agent/<ticket-short-name>` |
| 14 | 未登录时 `[]` 被当成“无活跃 sprint” | P2 | §5.4 空结果先 `jira me` 校验 |
| 15 | token 注入 worker 环境可被 agent 读出 | P2 | §10 只注入 Source 子进程，不进 Session 环境 |

**v0.1 → v0.2**：修复首轮评审的六个 P0；**v0.2 → v0.3**：改用本机 CLI、删除静态映射。详见 [reviews/README.md](reviews/README.md)。

## 实现偏差（M1 落地时）

设计写了两处 M1 的改动，实现时做了调整：

1. **Ticket 新字段不升 schema**：`repos` / `deliver` / `deliverables` 定义为可选，创建时给默认值。v1 尚无生产数据，省掉一次 11→12 迁移；将来需要强制回填时再补。
2. **GitHub 线程键带仓库推迟**：该改动只影响 GitHub Source，而 v1 关闭它。等真正启用 GitHub 入口时再做，避免无测试覆盖的全局重构。

## 1. 目标与非目标

**目标**：以 Jira 当前 sprint 为任务来源，agent 自己在工作根里找到该动的仓库，完成后交付 MR，并且只在产出 MR 之后才周期性跟随其结果。

**一句话验收**：把一个指派给我的 issue 放进我参与的 sprint，agent 在一个轮询周期内建单、自己找到正确的代码目录、改代码、开 MR、把链接回写 Jira，并在全部 MR 合并后收尾。

**非目标**：IM（v2）、GitHub 事件流、按仓库分区授权、文档/镜像交付、多工作区。

## 2. 前提与复用

### 2.1 现有能力

| 能力 | 现状 | v1 用法 |
| --- | --- | --- |
| Jira | `jira` CLI（jira-cli）已登录操作者账号 | Source 调用 `jira`；凭证放在配置指定的文件里 |
| Jira skill | 工作区里的 `jira` 技能（封装 CLI 与凭证） | 写一份等价的 bundle 内 SKILL.md 给 worker |
| GitLab | `glab` 已登录 GitLab（操作者账号） | 建 MR、读 MR、轮询全走 `glab` |
| GitHub | 无 | v1 不实现 |

### 2.2 启动要求（v0.4 修正）

基线 `src/app/setup.ts:79` 无条件调用 `resolveDeployment`，没有 GitHub 仓库就抛 `repositoryUnset`，服务停在 setup 阶段。v1 必须改成：

- **必需**：`stateDir`、Jira CLI 可用且已登录（`jira me` 成功）；
- **可选**：GitHub（未配置则 GitHub Source 不注册，`Deployment.github` 变为可选类型）；
- **可选**：GitLab（未配置则交付功能报 setup 问题，不影响 Jira 轮询）。

## 3. 架构总览

```
        ┌──────────── Jira Source（入口，轮询 jira CLI）────────────┐
        │ JQL: assignee = currentUser() AND sprint in openSprints() │
        │ 状态：seen / pending / commentCursor                       │
        └───────────────┬───────────────────────────────────────────┘
                        │ Trigger（jira:PROJ-1234）
                        ▼
                Eval（gate + assessment）
                        ▼
            Ticket {deliver='mr', repos=[], deliverables=[]}
                        │
        Assignment → Executor（工单目录，agent 自己 checkout）
                        │  orchestrator_checkout(repos) → repos + pending 交付项
                        ▼
        ┌──────── GitLab 守望 Source（intake=false）────────┐
        └───────────────┬───────────────────────────────────┘
                        ▼
                 Channel：Jira 评论 / MR 讨论
```

## 4. 领域模型变更

### 4.1 Thread 键

| 用途 | 键 |
| --- | --- |
| Jira issue | `jira:<issue-key>` |
| GitLab MR | `gitlab:<host>/<project-path>!<iid>` |

### 4.2 Ticket 字段

```ts
interface Ticket {
  repos: string[]
  deliver: { kind: 'mr' | 'doc' | 'image'; target?: string }
  /** 由 checkout 原子写入；收尾判定只看它 */
  deliverables: { repo: string; project: string; kind: 'mr'; ref?: number;
                  state: 'pending' | 'open' | 'merged' | 'closed' | 'failed' }[]
}
```

### 4.3 Source 能力位 `intake`

```ts
interface SourceKind { intake?: boolean }   // 默认 true
```

`scope()` 管接收与扇出；`intake` 管扇出后能否进 Eval。改动点：`src/core/intake.ts` 扇出后的 `if (!this.owners(trigger).length) this.queueForEval(trigger)` 加 `intake` 判断。

## 5. Jira Source

### 5.1 配置

```yaml
kind: jira
config:
  cli: jira
  envFile: <credentials file>
  projects: [PROJ]
  jql: assignee = currentUser() AND sprint in openSprints() AND project in (PROJ) AND statusCategory != Done
  pollSeconds: 300
  maxTriggersPerRound: 20
  commentPageSize: 50
```

### 5.2 调用形式（v0.4 按真实 CLI 校正）

| 动作 | 命令 |
| --- | --- |
| 拉 issue（**必须翻页**） | `jira issue list -p <PROJECT> -q "<JQL>" --raw --paginate <from>:<limit>`，循环直到返回条数 < limit |
| 读 issue | `jira issue view <KEY> --raw` |
| 读评论 | `jira issue view <KEY> --comments <N> --raw`（**N 不是硬截断**，实测 N=1 仍返回 3 条；见 §5.3） |
| 发评论 | `jira issue comment add <KEY> "<body>" --no-input`（**位置参数，无 `--body`**） |
| 校验身份 | `jira me` |

**CLI 契约**：所有调用统一加超时（30s）与 `--no-input`；非零退出、超时、输出不可解析三种情况分别处理。**写操作（评论）超时视为“结果未知”**：先按标记查重，确认不存在才重试。

**分页陷阱（实测）**：`--paginate` 单页上限 100，**超过 100 会静默返回空数组且退出码 0**（`0:200` → 空）。配置里的 pageSize 必须硬性 ≤100 并在加载时校验，否则会把“参数错误”当成“没有 issue”，进而误判空 sprint 与离开。

### 5.3 状态机

| 键 | 内容 | 语义 |
| --- | --- | --- |
| `jira:seen:<key>` | `{ fingerprint, statusId, sprintId }` | 已处理版本，只在确认离开时删除 |
| `jira:pending` | `[{key, fingerprint}]` | 待派发；派发成功才出队 |
| `jira:comments:<key>` | `{ lastCommentId }` | 评论游标 |

**指纹** `fingerprint = hash(statusId, assignee, summary, description, labels, components)`——**不用 `updated`**，否则自己发评论会让 issue “变新”，形成评论→Trigger→再评论的循环。

每轮：

1. **翻页拉全**（§5.2）。任一次调用失败或最后一条满页 → 本轮作废，不更新任何状态。
2. 新建（不在 `seen`）→ 入 `pending`；指纹变化 → 入 `pending`；指纹相同 → 忽略。
3. **离开判定**：仅当本轮完整、key 在 `seen` 但不在结果集、**且**用 `jira issue view <KEY>` 逐个确认状态（Done / 改派 / 不在 sprint）→ 删 `seen` 并发生命周期事件。空结果集不判离开。
4. **派发**：最多 `maxTriggersPerRound` 条，写库成功后才出队并写 `seen`。
5. **评论轮询**：对 pending 的 issue 与所有活跃 Ticket 的 issue，用 `--comments <commentPageSize>` 取一次；**实测该参数不裁剪 raw 输出**（N=1 返回 3 条），返回的是该 issue 的完整评论列表，按 id 升序。用 id 游标去重后扇出；若返回条数恰好等于 100（Jira 服务端常见分页上限），记 health 警告并在下轮重试。
6. **过滤自身评论**：只跳过正文含 `<sub>dsh-superagent:` 标记的评论。**绝不按作者跳过**——评论者与插件可能使用同一身份，按作者过滤会吞掉人类回答。

**幂等**：Trigger id = `key('jira-issue', key, fingerprint)`；Input id = `key('input', ticketId, 'comment', commentId)`。

### 5.4 sprint 切换

- 空结果：**先看退出码**。实测未登录/坏 token 一律退出码 1 且 stderr 可区分（`needs a Jira API token` / `401`），只有 `[]` + 退出码 0 才是真无 sprint。因此空数组 → `ready` / `no open sprint`，不清 `seen`；退出码非 0 → `error`。
- carry-over 的指纹未变 → 不产 Trigger。
- 批量改动由 `maxTriggersPerRound` + `pending` 分摊。

### 5.5 Trigger 映射

| 字段 | 值 |
| --- | --- |
| `id` | `key('jira-issue', key, fingerprint)` |
| `threads[0]` | `{source:'jira', id:key}` |
| `actor` | `{source:'jira', id:assignee}`，`human:true` |
| `addressed` | `'direct'` |
| `text` | summary + description（截断 8k） |
| `channel` | `{source:'jira', thread:key, address:{issue:key}}` |
| `meta` | `{issue, statusId, sprintId}` |

### 5.6 Channel 与健康

- `send`：`jira issue comment add <KEY> "<body>" --no-input`；正文尾部附 `<sub>dsh-superagent:&lt;id&gt;</sub>`；发送前用 `--comments N` 查重。
- `gone`：CLI 报 404 / issue 不存在。
- health：`ready`（含 pending 数）／`no open sprint`／连续 3 次失败 → `error`。

## 6. 仓库发现（agent 自主）

### 6.1 `orchestrator_checkout` 契约（v0.4 加固）

```ts
orchestrator_checkout({ repos: string[] })  // 1..3 个
```

校验顺序（任一步失败即整体拒绝，**不产生任何副作用**）：

1. 名字匹配 `^[a-z0-9][a-z0-9._-]*$`（不接受 `/`、`..`、绝对路径、大小写变体）；
2. `lstat(workspace/name)` 是目录且**不是符号链接**；
3. `realpath(workspace/name)` 仍以 `realpath(workspace)` 为前缀（防 `foo/../../x` 与链上逃逸）；
4. 每个仓库一把文件锁（`<ticketdir>/.checkout/<name>.lock`），拿不到即返回“进行中”，不阻塞；
5. 建 worktree 前检查分支：已存在则**复用**，不 `reset`、不 `clean`、不删未提交改动；
6. 成功后**原子地**追加 `Ticket.repos` 与该仓库的 `deliverables: {state:'pending'}`，再返回绝对路径。

### 6.2 失控防护

| 风险 | 措施 |
| --- | --- |
| 选错仓库 | 提示词要求先读 `AGENTS.md` 并说明依据；`Ticket.repos` 记录依据（issue 摘要中的一句话） |
| 多选 | 单次 ≤3 个；>1 个时工具返回提示，要求 agent 在 Jira 里先确认范围 |
| 反复 checkout | 幂等复用；同一仓库第二次调用不重建 |
| 选了不该动的仓库 | 工作根 `.dsh-protected`（纯文本，一行一个目录名）里的仓库拒绝 checkout |

### 6.3 不确定就问

`orchestrator_report({state:'blocked', human_action:'<具体问题>'})` → v1 落到 Jira 评论；IM 是 v2 的加速器。

## 7. 执行

### 7.1 目录

- 工作根 `executor.workspace`；工单目录 `<stateDir>/work/<ticket-short-name>/`；各仓库在 `<工单目录>/<目录名>/`。

### 7.2 prepare 与 checkout

- `prepare` 默认留空。
- 交付项的创建**只发生在 checkout 里**（原子），不依赖 agent 后续是否记得建 MR。
- 重试复用已存在 worktree。

### 7.3 环境变量

| 变量 | 含义 |
| --- | --- |
| `DSH_SUPERAGENT_WORKSPACE` | 工作根 |
| `DSH_SUPERAGENT_JIRA_ISSUE` | issue key |
| `DSH_SUPERAGENT_DELIVER` | `mr` |
| `DSH_SUPERAGENT_DIR` / `_NAME` / `_TICKET` | 不变 |

**不注入 `DSH_SUPERAGENT_REPOS`**：环境变量在 Session 启动时固定，checkout 之后新增的仓库不在其中；路径以工具返回值为准。同理**不把 `JIRA_API_TOKEN` 注入 Session 环境**（§10）。

### 7.4 分支与身份

- 分支统一 `agent/<ticket-short-name>`（与 §8.2 绑定规则一致）。
- 提交身份继承全局 git 配置；push 走 ssh。
- 提交信息 `<type>: <summary> [<issue-key>]`。

## 8. 交付与守望

### 8.1 建 MR

```sh
glab mr create --no-editor --title "<summary>" --description "<说明 + Closes KEY>" \
  --source-branch "agent/$DSH_SUPERAGENT_NAME" --target-branch <default>
```

- 项目由当前目录推断，无需映射。
- **结果未知处理**：命令超时或输出无 URL 时，先 `glab mr list --source-branch` 查是否已创建，存在则取 URL，不存在才重试。
- 成功后写 `deliverables[repo] = {state:'open', ref:iid}` 并评论到 Jira。

### 8.2 绑定规则

1. 作者是当前用户；2. 源分支 = `agent/<ticket-short-name>`；3. 源仓库 ∈ `Ticket.repos`；4. 一个 MR 只绑一个活跃工单；5. **状态为 merged/closed 的 MR 同样可绑定**（v0.4 修正：基线 `claimPull` 只绑 open，会漏掉快速合并）。

### 8.3 守望

- 每 `mrPollSeconds`（默认 120）对 state ∈ {pending, open} 的交付项执行
  `glab api projects/<urlencoded project>/merge_requests/<iid>` 与 `/notes`。
- 项目路径在 §8.1 创建成功时写入 `deliverables[repo].project`，**不从目录名推断**。
- 新 note → Trigger（`intake:false`）→ 只扇出给订阅 Ticket。

### 8.4 收尾（v0.4 加固）

| 情形 | 结果 |
| --- | --- |
| 有任一 `state='pending'` | **不结束**，等 MR 创建或人工 |
| 有任一 `state='failed'` | **不结束**，报 health |
| `repos` 非空但 `deliverables` 为空 | **不结束**（视为未交付），health 提示 |
| 全部 merged | `merged` |
| 全部 closed（无 merged） | `closed` |
| 有 merged 也有 closed | `closed`（部分未合并） |
| Jira 侧 Done 但交付未终态 | 记录事件，**不结束** |

**补绑扫描**：每轮对所有 `state='pending'` 的仓库，按 `agent/<ticket-short-name>` 搜索**全状态** MR；命中即绑定并更新状态。

## 9. 面板与运维

- Source 卡片：`jira`（最近轮询、pending、issue 数）、`gitlab`（订阅 MR 数、最近错误）。
- Overview：`blocked`（等回答）、“repos 非空但 deliverables 为空”的工单置顶。

## 10. 凭证与隔离

| 用途 | 来源 | 边界 |
| --- | --- | --- |
| Jira | 凭证文件（权限 600，路径由配置指定） | **只注入 Source 的子进程**；不写入 Session 环境、不落盘 |
| GitLab | `glab` 自有配置 | 插件不读取、不复制 |
| Git | 全局配置 | 不在仓库 `.git/config` 写凭证 |

- 日志脱敏：`JIRA_API_TOKEN`、token 形态字符串一律替换。
- worker 若需要 Jira 操作，通过 host 工具（`orchestrator_*`）而非直接 CLI，避免拿到 token。

## 11. 验收标准

| 编号 | 验收项 | 判定 |
| --- | --- | --- |
| AC-1 | 无活跃 sprint 正常且不丢状态 | 退出 0；`no open sprint`；重启后不重放 |
| AC-2 | 新 issue 建单 | ≤2 周期；同指纹不重复 |
| AC-3 | 更新扇出 | 状态变更 → 既有 Ticket 收 Input，不新建 |
| AC-4 | sprint 切换无噪声 | carry-over 指纹未变 → 0 个新 Ticket |
| AC-5 | agent 选对仓库 | e2e 固定 3 个 issue，均选中正确目录 |
| AC-6 | 不确定时追问 | 模糊 issue → Jira 提问，不改任何仓库 |
| AC-7 | 多仓执行 | 每仓 `agent/<name>` 分支可 commit |
| AC-8 | MR 交付 | 每仓 1 个 MR，URL 评论回 Jira 并在面板可见 |
| AC-9 | MR 评论扇出 | 留言 ≤2 周期进 Ticket；回复出现在 MR |
| AC-10 | 多交付收尾 | 一仓合并 → 不结束；全合并 → `merged`；一合并一关闭 → `closed` |
| AC-11 | 幂等 | 同指纹 / 同 note 不产生第二条 Input |
| AC-12 | 凭证不泄漏 | 日志、面板、Session 环境均无 token |
| AC-13 | 限流不丢单 | 25 条 → 分轮处理，最终各一次 |
| AC-14 | checkout 记录 | `Ticket.repos` 与 MR 所在仓库一致 |
| AC-15 | checkout 边界 | `..`、绝对路径、符号链接、越界 realpath、保护名单全部拒绝 |
| AC-16 | 评论入 Input | Jira 与 MR 新评论都成 Input；插件自身评论不触发 |
| AC-17 | CLI 失败安全 | 未登录/超时 → health error，本轮状态不变 |
| AC-18 | 自评论不成环 | agent 发评论后，下一轮不产生新 Trigger |
| AC-19 | 翻页完整 | 120 条 issue 分两页拉全；只拉到 100 条时**不判离开** |
| AC-20 | 空交付不收尾 | repos 非空且无 MR → 工单保持 open |
| AC-21 | 并发 checkout | 同仓两个并发调用，一个成功一个返回“进行中”，无损坏 |
| AC-22 | 写操作幂等 | 评论/MR 超时后重试不产生重复 |

## 12. 测试用例

**单元（vitest）**

| 编号 | 覆盖 | 输入 | 期望 |
| --- | --- | --- | --- |
| TC-U1 | AC-2 | 空 seen，2 条 | 2 条 Trigger |
| TC-U2 | AC-11 | 同批两轮 | 第二轮 0 条 |
| TC-U3 | AC-18 | 自评论后指纹不变 | 0 条 Trigger |
| TC-U4 | AC-1/4/19 | 空结果；仅 100 条满页；新 sprint 同批 | 均 0 条，seen 不变 |
| TC-U5 | AC-13 | 25 条 | 首轮 20 + pending 5 |
| TC-U6 | AC-6 | 模糊 issue | `blocked`，无 checkout |
| TC-U7 | AC-11/16 | 同 note 两轮；人类回答 + 插件评论 | 前者 0 条；后者只收人类 |
| TC-U8 | §5.3 | 确认 Done | 删 seen + 生命周期事件 |
| TC-U9 | AC-10/20 | 一 merged 一 open；repos 非空 deliverables 空 | 均不结束 |
| TC-U10 | AC-15 | `../x`、`/abs`、符号链接、`foo/../../x`、保护名单 | 全部拒绝且无副作用 |
| TC-U11 | AC-14/21 | checkout 正常；并发两次 | repos 记录正确；第二次返回进行中 |
| TC-U12 | AC-17 | CLI 连续 3 次失败 | health error，状态不变 |
| TC-U13 | AC-22 | 评论超时后重试 | 只存在一条评论 |
| TC-U14 | §4.3 | intake=false 无订阅 | 不进 Eval |

**集成（模拟 CLI 输出）**

| 编号 | 覆盖 | 场景 | 期望 |
| --- | --- | --- | --- |
| TC-I1 | AC-1 | JQL 返回 `[]` 且 `jira me` 成功 | ready/no open sprint |
| TC-I2 | AC-2 | 两轮，第二轮多一条 | 建单 1 个 |
| TC-I3 | AC-8 | 执行完成 | 每仓一次 `glab mr create` |
| TC-I4 | AC-9/16 | notes 新增含人类与插件 | 只扇出人类评论 |
| TC-I5 | AC-10 | 两仓均 merged | `merged` |
| TC-I6 | AC-17 | CLI 连续 3 次超时 | error；无 token 泄漏 |
| TC-I7 | AC-7 补绑 | MR 建后进程崩溃，下轮扫描 | 按分支名绑定终态 MR |
| TC-I8 | AC-6 | `jira me` 失败但返回空列表 | error，不写 `no open sprint` |

**端到端（真实 Jira + GitLab 测试项目）**

| 编号 | 覆盖 | 步骤 |
| --- | --- | --- |
| TC-E1 | AC-2/5/7/8 | issue 进 sprint → Ticket → 自选仓库 → 分支 → MR → Jira 评论 |
| TC-E2 | AC-9/10 | MR 留言 → 回复 → 全合并 → 收尾 |
| TC-E3 | AC-6 | 模糊 issue → Jira 追问 → 人工回答 → 继续 |
| TC-E4 | AC-1/18 | 空窗 10 分钟 → 新 sprint → 无重放；自评论不成环 |

## 13. 里程碑

| 里程碑 | 内容 | 判据 |
| --- | --- | --- |
| M0（1 天） | **解除 GitHub 硬依赖**：setup/deployment 改造，Jira-only 能启动 | AC-12、服务能起 |
| M1（3–4 天） | Thread 键、Ticket 字段、`orchestrator_checkout`、工单目录 | TC-U10/U11、AC-7/14/15/21 |
| M2（5–6 天） | Jira Source：翻页、指纹、sprint 边界、评论游标 | TC-U1..U5、U7、U8、TC-I1/I2/I8 |
| M3（2–3 天） | Channel 与追问闭环 | TC-U6、U13、TC-I6 |
| M4（4–6 天） | GitLab 交付与守望、多交付收尾、补绑 | TC-U9、TC-I3..I7、AC-8..AC-10 |
| M5（2 天） | 面板、health、文档、e2e | TC-E1..E4 |

合计 17–22 人日（M0 与第二轮的加固项各增 1 天）。

## 14. 风险与决策

| 编号 | 问题 | 处置 |
| --- | --- | --- |
| Q1 | `openSprints()` 可用性 | ✅ **已实测**（2026-11-04）：`sprint in openSprints() AND assignee = currentUser()` 正常返回 JSON |
| Q2 | 工单目录 | 已定 `<stateDir>/work` |
| Q4 | MR 通道 | 已定 `glab` |
| Q7 | `jira --raw` 字段随版本变化 | zod 校验，缺字段即报错 |
| Q8 | agent 选错仓库 | §6.2 机械闸门 + e2e + 强制追问 |
| Q9 | 评论读取语义 | ✅ **已实测**：`--comments N` 不裁剪 raw 输出（N=1 返回 3 条），按 id 升序返回完整列表；服务端上限未探明，按 100 条告警 |
| Q10 | worktree 并发锁 | `git worktree add` 自带失败 + 文件锁双保险 |
| Q11 | `jira issue list` 分页 | ✅ **已实测**：`--paginate 0:3` / `3:3` 正确翻页；**不带 paginate 实测返回恰好 100 条**，截断风险属实（AC-19 有效） |

## 15. 与现有代码的差异清单（v0.4 补全）

| 文件 | 变更 | 阻塞 |
| --- | --- | --- |
| `src/app/setup.ts` | GitHub 变可选；新增 Jira/GitLab 探测 | 是 |
| `src/deployment.ts` | `Deployment.github` 可选；新增 Jira/GitLab 配置与校验 | 是 |
| `src/setup.ts` | 新增 setup 问题码（`jiraCliMissing`、`jiraAuthFailed`、`gitlabMissing`） | 是 |
| `src/infra/environment.ts` | worker 环境不再包含 Jira token 与仓库列表 | 是 |
| `src/app/execution-environment.ts` | 新增 `DSH_SUPERAGENT_WORKSPACE`、`_JIRA_ISSUE`、`_DELIVER` | 是 |
| `src/policy.ts` | 新增 `jira`、`gitlab` 的 Source 部分 schema | 是 |
| `src/core/model.ts` | Ticket 加 `repos`/`deliver`/`deliverables` | 是 |
| `src/core/intake.ts` | 扇出后按 `intake` 决定是否入 Eval | 是 |
| `src/core/kind.ts` | `SourceKind.intake`；`EnvironmentInput` 增 ticket 上下文 | 是 |
| `src/app/tools/executor.ts` | 新增 `orchestrator_checkout`；report 支持多交付 | 是 |
| `src/app/store.ts` + `src/app/migration.ts` | schema 11→12；新字段默认值 | 是 |
| `src/executor/dsh.ts` | 用显式准备标记替代“目录存在即已准备” | 是 |
| `tsdown.config.ts` / `package.json` | 新增 `jira-watch`、`gitlab-watch` 入口与 export | 是 |
| `cordis.patch.yml` | 注册两个新 Source 插件 | 是 |
| 新增 `src/sources/jira.ts` | CLI 封装、状态机、Channel | 否 |
| 新增 `src/sources/gitlab.ts` | `glab` 封装、守望、补绑 | 否 |
| 新增 `skills/dsh-superagent-jira`、`skills/dsh-superagent-gitlab` | worker 操作手册 | 否 |
| `src/sources/github*.ts` | 不启用 | 否 |
| `prompts/*` | 仓库定位、checkout、提交身份、MR 模板 | 否 |
| `docs/006`、`docs/008` | 部署与新增 Source | 否 |
