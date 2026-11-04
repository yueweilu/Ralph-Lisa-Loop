# 从公开 Ralph-Lisa Loop 仓库开始开发 Herdr 插件

**日期：** 2026-10-29

**目标：** 以公开 Ralph-Lisa Loop CLI 为基础，先让 Claude/Codex 双席在 Herdr 中真实自动交接，再评估独立客户端。此文是实施起点，不代表插件已经开发或发布。S1 的具体契约见[详细实施方案](public-cli-s1-host-contract-implementation-2026-10-29.md)。

## 1. 已核对的公开仓基线

2026-10-29 检出 [YW1975/Ralph-Lisa-Loop](https://github.com/YW1975/Ralph-Lisa-Loop) 并只读核对 `main@7440e29e4134bf8905e079b7d44c5e659a99ef4c`（提交日期 2026-04-01）。以下代码事实仅对应这个固定 SHA；开工时须重新检查远端。

| 发现 | 代码证据 | 对实施的影响 |
|---|---|---|
| 当前公开 CLI 为 `0.3.13` | [公开 `cli/package.json`](https://github.com/YW1975/Ralph-Lisa-Loop/blob/7440e29/cli/package.json) | 本方案只依据公开版本；不预设其他版本的命令、回执或工期 |
| 公开 `auto` 直接要求 tmux，生成并启动 shell watcher，之后 `attach-session` | [公开 `commands.ts`](https://github.com/YW1975/Ralph-Lisa-Loop/blob/7440e29/cli/src/commands.ts) `cmdAuto` | 插件应另建 Herdr 宿主，提取必要业务接口；不要在 watcher 里全局替换 `tmux` 字符串 |
| `start` 在 macOS 调 iTerm/Terminal，其他平台可回退 tmux；不是 Herdr 启动器 | 同上 `cmdStart` | 双席启动必须新建 Herdr 适配，不可把 `start` 包进 Pane 当集成 |
| 公开仓 `plugin/` 的 manifest 是 `.claude-plugin/plugin.json` | [公开 `plugin/`](https://github.com/YW1975/Ralph-Lisa-Loop/tree/7440e29/plugin) | 这是 Claude Code 插件，不是 Herdr 插件；Herdr 包应单独置于例如 `integrations/herdr/` |
| 公开 CLI 有 `whose-turn`、`submit-ralph`、`submit-lisa`、`status`、`policy`、`doctor`、`logs` | [公开 `cli.ts`](https://github.com/YW1975/Ralph-Lisa-Loop/blob/7440e29/cli/src/cli.ts) | 双 Agent 基础协议可复用，但需核对每个命令的机器语义 |
| 公开 CLI 没有席位绑定、宿主租约、结构化提交回执、测试/验收/图谱一级入口 | 公开 `cli/src` 与命令分派只读检索；[公开 `cli.ts`](https://github.com/YW1975/Ralph-Lisa-Loop/blob/7440e29/cli/src/cli.ts) | 插件首版不能承诺这些能力现成可用；按最小需要补协议 |
| `resolveStateDir()` 先读 tmux session 的 `RL_STATE_DIR`，再读进程环境变量；`cmdInit` 会删除并重建现有 `.dual-agent` | [公开 `state.ts`](https://github.com/YW1975/Ralph-Lisa-Loop/blob/7440e29/cli/src/state.ts)、[公开 `commands.ts`](https://github.com/YW1975/Ralph-Lisa-Loop/blob/7440e29/cli/src/commands.ts) | Herdr 子进程必须清理继承的 `TMUX/TMUX_PANE`，绑定绝对状态路径；插件不对已有会话盲调 `init` |
| 提交只核对轮次并写多个文本文件；门禁由 policy 与可选 `RL_RALPH_GATE` 控制 | 公开 `cmdSubmitRalph` / `cmdSubmitLisa`、`runGate` | 自动协调器要有唯一提交回执与重复抑制，不把终端输出或 Agent `idle` 当成提交成功；保留必要门禁 |
| 基线 `main@7440e29` 没有包锁文件，仓库 `.gitignore` 还忽略 `package-lock.json`；早期两次 npm 下载出现 `ECONNRESET` | 基线 `cli/` 的只读检查与本机命令输出 | 当前 S0 分支已固定依赖并生成锁文件，且 `npm ci` 本机验证通过；远端 CI 尚未运行 |
| 使用本机已有 TypeScript `5.9.3`、`@types/node 20.19.39` 的依赖目录，在**隔离克隆**中构建成功；原有测试 382 通过、0 失败 | `npm run build`、`npm test` 本次运行输出 | 证明这一组本机依赖下公开 CLI 的回归基线可运行；**不等于**公开仓独立安装、插件集成或真实 Agent 测试通过 |
| 本机 Herdr 为 `0.9.4`；Claude/Codex 集成已安装，状态为 `current`（v10/v9），但双席同会话重启恢复尚未验收 | 本机 `herdr --version`、`herdr integration status` 与隔离会话试验 | 初次启动和席位绑定已验证；重启恢复须单独核对有效会话引用，不能以安装状态代替验收 |

快速模式扫描在当前 253 个跟踪文件中未发现常见私钥/令牌模式；**这不是安全审计通过**，尚未检查完整 Git 历史、构建脚本、文档附件及许可证边界。

## 2. 第一阶段先固定产品范围

**本次交付定义：** 用户在 Herdr 中从一个已初始化的公开 RLL 项目启动 Ralph（Claude）与 Lisa（Codex）两个真实席位；Ralph 提交后插件依据公开 CLI 的合法轮次和真实回执通知 Lisa；Lisa 提交 `NEEDS_WORK`/`PASS` 后返回 Ralph 或停在明确状态；用户可暂停、查看原因、恢复。重启、断线、身份变化或提交不明时不重复投递。

**暂不做：** 独立桌面 GUI、SQLite 真源、其他产品能力的全量迁移、所有 Agent 兼容、自动发布、把 Herdr 立即替换成公开仓默认 `auto`。是否以 Herdr 取代 tmux，要在真实插件和旧用户迁移实验后另作决定。

**Herdr 的职责：** 创建 Workspace/Pane，启动/识别两个 Agent，观察活动与终端，提供终端内插件动作和控制 Pane；RLL CLI 保留任务、轮次、提交、评审和门禁判定。[Herdr 插件接口](https://herdr.dev/docs/plugins/) · [Agent 自动化](https://herdr.dev/docs/agent-automation/)。

## 3. 先建怎样的开发分支

**代码开发仓库是公开的 `YW1975/Ralph-Lisa-Loop`。** 已在独立的 `Ralph-Lisa-Loop-herdr/` 目录完成检出；该目录与原有内部工作区平级。公开插件的源码、测试和经审查的文档都在本仓维护，不依赖内部工作区。S0 至代次基线的已完成 S1 切片已推送开发 fork 并通过 CI；当前在 `feat/herdr-s1-candidate-inbox` 建立只保存、不自动提交的候选收件箱，尚未合并上游 `main`。

```text
工作区父目录/
├── 内部项目/                  # 只作为历史对照，不参与公开插件构建
└── Ralph-Lisa-Loop-herdr/     # 已检出：公开仓的独立工作目录
    ├── cli/                   # S1：修改公开 CLI 0.3.13 的最小宿主契约
    ├── plugin/                # 原有 Claude Code 插件，继续保留
    ├── integrations/herdr/    # S2–S4：新 Herdr 插件与协调器
    └── docs/herdr/            # 公开版安装、契约、兼容及验收说明
```

**分支与合并路线：**

| 分支 | 从哪里创建 | 做什么 | 目标分支/合并条件 |
|---|---|---|---|
| `main` | 公开仓现有默认分支 | 公开版本基线；开发期间保持可用 | 不直接在此写代码 |
| `docs/herdr-final-plan` | `main@7440e29` | 保存这两份经整理的实施文档；本地保留分支 | 文档已带入 S0 分支；它不是插件开发分支 |
| `chore/herdr-s0-baseline` | 开工时拉取的 `origin/main@7440e29` | 锁文件、可重复安装、原 CLI 回归与公开边界检查；已推送并通过 CI | 独立 PR → `main`；通过公开审查后合并 |
| `feat/herdr-plugin` | 暂基于本地 S0；S0 合并后对齐最新 `origin/main` | S1–S5 的本地集成分支；尚未验收的能力留在这里 | 完整验收、公开审查通过后最终 PR → `main` |
| `feat/herdr-s1-inspect` | 暂基于 `feat/herdr-plugin` | 显式项目定位与只读 JSON 检查；已推送并通过 CI | 后续进入集成分支；不直接合并公开 `main` |
| `feat/herdr-s1-identity` | `feat/herdr-s1-inspect` | 新建会话的稳定 ID 与规范路径记录；已推送并通过 CI | 旧会话接管另做切片 |
| `feat/herdr-s1-mutation-guard` → `feat/herdr-s1-bind-seat` | 前一已验证切片 | 写保护、命令短锁、租约、快照、席位绑定；各分支已推送并通过 CI | 依次纳入集成分支，暂不合并公开 `main` |
| `feat/herdr-s1-adopt-legacy` | `feat/herdr-s1-bind-seat` | 旧会话备份、冻结和明确确认；已推送并通过 CI | 依次纳入集成分支 |
| `feat/herdr-s1-lease-heartbeat` | `feat/herdr-s1-adopt-legacy` | 同一宿主租约的心跳序号与时间；已推送并通过 CI | 依次纳入集成分支 |
| `feat/herdr-s1-lease-recovery` | `feat/herdr-s1-lease-heartbeat` | 租约核对、明确人工确认、冻结和归档；已推送并通过 CI | 依次纳入集成分支 |
| `feat/herdr-s1-generation-baseline` | `feat/herdr-s1-lease-recovery` | 显式建立代次 0 与业务摘要；已推送并通过 CI | 依次纳入集成分支 |
| `feat/herdr-s1-candidate-inbox` | `feat/herdr-s1-generation-baseline` | 候选正文与摘要持久化，标记来源未验证；已推送并通过 CI | 依次纳入集成分支 |
| `feat/herdr-s1-rejection-ledger` → `feat/herdr-s1-human-confirmation` | 前一已验证切片 | 内部事务与回执、拒绝历史、只读预检、人工声明；各分支已推送并通过 CI | 依次纳入集成分支 |
| `feat/herdr-s1-host-commit` | `feat/herdr-s1-human-confirmation` | 人工确认路径的受控正式提交；已推送并通过 CI | 后续纳入集成分支 |
| `feat/herdr-s1-process-faults` | `feat/herdr-s1-host-commit` | S1.4 首个跨进程故障与并发切片：短锁显式核对/归档、部分事务冻结；已推送并通过 CI | 继续剩余 S1.4 |
| `feat/herdr-s1-write-fault-matrix` | `feat/herdr-s1-process-faults` | Ralph/Lisa 正式提交的逐阶段进程中断矩阵，补齐待核对状态诊断；已推送并通过 CI | 继续 S1.4 样板流程 |
| `feat/herdr-s1-sample-flow` | `feat/herdr-s1-write-fault-matrix` | 隔离项目的三次 CLI 提交、跨目录定位、旧会话与错席位回归 | 完整测试、提交、推送和核验后进入 S2 准备 |
| 后续 `feat/herdr-s1-*`、`feat/herdr-s2-*` 等 | 最近已验证的开发切片 | 异常恢复、manifest、双席协调等 | 每个切片独立测试、提交、推送和核验 |

这样先把不改变产品行为的 S0 基线单独合入公开 `main`，随后把尚未完整交付的 Herdr 能力留在集成分支。当前为推进开发，S1 切片暂时逐个叠在前一切片之上；正式 PR 前按合并后的公开 `main` 核对和调整。切片依次合并并复测；集成分支不在别人基于它开发后强制改写历史。最终 PR 合并到公开仓 `main` 前，复核与当前 `main` 的差异、完整历史/依赖/许可及敏感内容，跑干净安装、旧 CLI 回归和真实 Claude/Codex 流程。**已完成切片均推到 fork；原仓 PR 尚未创建。**

开工时先查远端最新 `main` 和是否已有同名工作分支；不能把这次检出的 `7440e29` 当成未来开工时的最新 SHA。若有原仓写权限，在原公开仓建分支；若没有，可用个人 fork 作为开发与提 PR 的中转，但最终发布仍以原仓或确认过的非 fork 公开仓默认分支为准。Herdr [Marketplace](https://herdr.dev/docs/marketplace/)要求公开默认分支有可解析 manifest 与 `herdr-plugin` topic，且不收录 fork。

后续分支顺序（S0 本地分支已创建；以下命令用于说明 S0 合并后的阶段）：

```bash
# S0 完成并通过 PR 合并后，再更新 main，创建 feat/herdr-plugin
cd /path/to/Ralph-Lisa-Loop-herdr
git switch main
git pull --ff-only origin main
git switch -c feat/herdr-plugin
# 每个 S1 切片再从最新 feat/herdr-plugin 派生短期分支
git switch -c feat/herdr-s1-session
```

执行前确认远端权限和分支名未被占用；这里的命令描述 S0 合并后的正式分支整理方式，**尚未在远端执行**。S1 切片合并后，回到 `feat/herdr-plugin` 更新，再建下一切片分支。若需要 fork，先在此检出中添加独立的 fork remote，保持原仓为上游来源。

每个切片只把公开仓本来就有的代码或明确允许公开的新增代码带入；不复制内部 CLI、内部文档、密钥、测试数据或本机绝对路径。若确需移植某个内部算法，先拆出最小变更、做来源和许可审查，再在公开仓独立实现与测试。只有开发验收完成后，才考虑在公开仓加 marketplace topic 或打发布 tag。

## 4. 建议按六个可评审切片开发

| 切片 | 本次要做的最小改动 | 可以验收什么 |
|---|---|---|
| S0 基线与公开边界 | 解决依赖下载；原版 build/test；列实际 CLI 命令、状态文件、tmux watcher、副作用、公开/内部差异；审核公开内容 | 有固定 SHA、测试回执、能力差异与不移植清单；明确需要补的最小机器接口 |
| S1 CLI 宿主契约 | 在公开 CLI 增加**显式状态目录、会话/席位绑定、结构化只读快照与提交回执**的最小接口；保持原人工 CLI 用法；同一会话只能有一个协调宿主 | 错项目/错席位/错轮次提交被拒；重复请求有可核对结果；旧手工用法和必要门禁不回退 |
| S2 Herdr 插件骨架 | 新建 `integrations/herdr/`，manifest 的 `start/status/pause/resume/stop` 动作、控制 Pane、版本诊断；不用 `plugin/` 的 Claude manifest | 在隔离 Herdr 配置里 `plugin link`、调用 `doctor/status`；缺 CLI、未登录、版本不符有明确报错 |
| S3 真实双席与自动交接 | 用返回 ID 创建 Workspace/Pane；启动 Claude/Codex；保存会话/Pane/Agent/角色/代次绑定；协调器按 RLL 轮次及回执投递 | 从 Ralph 真实提交到 Lisa，再从 `NEEDS_WORK` 回 Ralph；每次消息只给正确席位一次 |
| S4 人工介入与恢复 | 显式暂停、人工输入、恢复核对；事件丢失重取快照、Herdr 重启重绑、未知提交停在待核对；同会话 tmux 冲突防护 | 断线/重启/重复启动不串项目、不双协调、不重复提交；旧 tmux 在别的项目继续运行 |
| S5 发布准备 | 完整回归、安装/更新/卸载、许可证/依赖/构建审查、README、版本和示例，确定仓库结构与推广 | 新机器可从公开 GitHub 安装，真实 Claude/Codex 跑通成功与失败案例；发布状态另行核对 |

S1 的工程细节、命令/回执样例与验收矩阵见[公开 CLI 宿主契约实施方案](public-cli-s1-host-contract-implementation-2026-10-29.md)。其工期仅覆盖 S1，不替代本表中的 S0、S2–S5。

**首个可展示里程碑不是“两窗打开”：** 在隔离样板项目中，Herdr 启动两席，Ralph 用公开 CLI 正式提交，插件自动且只一次通知 Lisa；Lisa 提交 `NEEDS_WORK` 后再次自动交回 Ralph。每一步保存 RLL 轮次/回执和 Herdr 席位身份。任何权限阻塞、来源不明或投递结果不明均显示原因并暂停。

## 5. 开工顺序与工期口径

**第一天先做 S0，不先改 `cmdAuto`。** 逐条核对公开仓 `0.3.13` 的命令、门禁与状态文件；在干净依赖安装下重跑已通过的测试；把 Herdr 最小 manifest 在隔离配置里链接；选一个仅含测试文件的样板项目跑 CLI 一轮。随后冻结 S1 的输入/输出契约，再开始代码改造。公开版 `cmdInit` 会删除旧 `.dual-agent`，样板项目必须是一次性测试目录。

建议先安排 **S0 约 3–5 人日的计划额度**（含公开边界审查、依赖/测试基线和契约清单），完成后再逐切片重估总工期；这不是已实测工时或报价。本机依赖安装、远端 CI、S2 只读插件动作和 S3.3 真实双席启动均已验证；提交回执驱动的真实双席 Ralph → Lisa → Ralph 交接已在隔离样板项目验收；两次候选仍需人工来源确认，不属于无人值守闭环。

**截至 2026-11-04 的进展：** 公开仓独立检出及基线盘点、S0 和 S1 宿主契约切片已在开发 fork 通过 CI；隔离样板项目的 Ralph → Lisa `NEEDS_WORK` → Ralph 与错项目/旧会话/旧绑定回归也已完成。S2 插件 manifest、只读 `doctor/status`、控制 Pane 和自动化测试已在隔离 Herdr 0.9.4 服务中完成运行中 API 验收，详情见 [S2 实测记录](s2-live-acceptance-2026-11-03.md)。S3.1 已在未装 Claude/Codex 集成的隔离服务中验证真实两席可启动、识别和只读预检，见 [S3.1 席位预检](s3-seat-preflight-2026-11-03.md)。S3.2 已在真实 Herdr 服务中验证插件 `start/stop`、宿主租约、两席绑定、持续心跳和显式释放，见 [S3.2 租约实测](s3-coordinator-lease-2026-11-03.md)。S3.3 已验证插件自动创建双席和等待启动提示，见 [S3.3 自动双席实测](s3-auto-seats-2026-11-03.md)。S3.4 已用真实公开 CLI 与伪 Herdr 验证正式回执驱动的单次交接和结果不明时暂停，见 [S3.4 回执交接](s3-receipt-handoff-2026-11-04.md)。候选来源仍标记 `unverified`，CLI 无法证明真实 Herdr Agent 的身份或用户实际审阅候选。**尚未完成：** 完整历史/许可审计、TUI 客户端目视展示、无需人工逐轮确认的受控来源、S4 重启自动恢复验收、原仓发布。

**后续切片：** S3.5 已按 Herdr 0.9.4 schema 核对 `agent_prompted` 回执的目标席位，见 [S3.5 回执身份核验](s3-prompt-ack-2026-11-04.md)。S4.1 已实现显式暂停/恢复的隔离测试，见 [S4.1 暂停恢复](s4-pause-resume-2026-11-04.md)；真实 Herdr 中的暂停/恢复已在双席交接试验中验收；重启后的自动恢复仍未验收。

S3.6 已补上“启动后把当前项目任务单次投给 Ralph”的缺口，见 [S3.6 初始任务](s3-initial-task-2026-11-04.md)。此项目前由真实公开 CLI 和伪 Herdr 的集成测试覆盖，真实 Herdr 任务执行仍待验收。

S4.2 新增只读 `recovery-check`，把 CLI 租约证据、插件投递记录和 Herdr 席位观察放在一起，见 [S4.2 恢复核对](s4-recovery-audit-2026-11-04.md)。它不自动回收租约或重发提示。

S4.2 后续加固将投递记录中的 Workspace、Pane、消息摘要与插件席位计划逐项核验，并对照 CLI 当前绑定及业务摘要；任何错位均停在待核对，见 [S4.2 恢复核对加固](s4-recovery-audit-hardening-2026-11-04.md)。

S4 真实重启试验发现：已有原生会话引用的 Claude 席位恢复，尚无原生会话引用的 Codex 席位未恢复；协调器退出但 RLL 租约保留，重复启动被拒。`recovery-check` 补充每席原生会话引用状态及摘要，见 [S4 重启实测](s4-real-restart-2026-11-04.md)。同会话自动安全续跑尚未实现。

S4 后续切片将原生会话引用的摘要随席位计划持久保存，并在交接提示后补记新出现的引用；恢复核对可区分匹配、变更或尚未记录，见 [S4 原生会话绑定](s4-native-session-binding-2026-11-04.md)。实际重启后的自动重绑与租约接续仍需另做。

S4 最新实测纠正了“Server 重启必然结束插件协调器”的假设：一次命名服务重启后，旧插件 action 进程仍存活并持续心跳，而 Lisa 不可用。现已将 Herdr Terminal 身份纳入席位计划及投递意图，并在每次心跳前检查两席，连接丢失或 Terminal 改变即停在待核对。更新后的代码在第二次真实命名服务重启中验证了旧协调器退出、租约保留且心跳不再增长；重启后的自动重绑与接续仍未完成，见 [S4 孤儿协调器阻断](s4-server-epoch-fence-2026-11-04.md)。

S3 真实双席交接试验已让 Claude/Ralph 生成候选，经现有人工来源确认与正式提交后，由插件只向真实 Codex/Lisa 投递一次匹配回执；Lisa 已生成并提议 `[NEEDS_WORK]` 候选；经同一人工来源确认后正式提交，插件只向真实 Claude/Ralph 投递一次匹配回执。RLL 快照进入第 2 轮 Ralph。命名测试会话已停止，宿主租约已释放。见 [S3 真实交接试验](s3-real-handoff-trial-2026-11-04.md)。

S3 后续来源归因试验发现：插件 action 上下文使用界面聚焦 Pane，不能代表命令调用 Pane；从 Agent Pane 运行的 `pane current --current` 可返回调用 Pane。新增 Agent Pane 候选提议辅助命令，在提议前核对 Herdr 实时 Agent 与公开 CLI 席位绑定；真实 Claude/Ralph 已在隔离项目中成功调用。该观察不能证明候选文件写入者，`source_verification` 和人工确认门禁仍保持原样，见 [S3 Agent Pane 候选提议](s3-agent-pane-candidate-proposal-2026-11-04.md)。

S3 人工确认路径现有独立 `review` Pane：公开 CLI 先只读列出/读取已保存候选，Pane 展示正文、席位和摘要，预检通过后要求用户键入候选 ID 与完整摘要，才调用人工声明和正式提交。隔离自动化测试覆盖取消、通过与篡改冻结；Herdr 0.9.4 manifest 注册已核验，真实 Pane 目视操作及真实用户审阅仍待验收。来源继续标记 `unverified`，见 [S3 人工候选审阅](s3-human-candidate-review-2026-11-04.md)。
