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
| 本机 Herdr 为 `0.9.4`；Claude/Codex 的 Herdr integration status 均为 `not installed` | 本机只读命令 `herdr --version`、`herdr integration status` | 可先做静态插件骨架和隔离 manifest 验证；真实双席活动与恢复验收前须在专用环境装集成并重测 |

快速模式扫描在当前 253 个跟踪文件中未发现常见私钥/令牌模式；**这不是安全审计通过**，尚未检查完整 Git 历史、构建脚本、文档附件及许可证边界。

## 2. 第一阶段先固定产品范围

**本次交付定义：** 用户在 Herdr 中从一个已初始化的公开 RLL 项目启动 Ralph（Claude）与 Lisa（Codex）两个真实席位；Ralph 提交后插件依据公开 CLI 的合法轮次和真实回执通知 Lisa；Lisa 提交 `NEEDS_WORK`/`PASS` 后返回 Ralph 或停在明确状态；用户可暂停、查看原因、恢复。重启、断线、身份变化或提交不明时不重复投递。

**暂不做：** 独立桌面 GUI、SQLite 真源、其他产品能力的全量迁移、所有 Agent 兼容、自动发布、把 Herdr 立即替换成公开仓默认 `auto`。是否以 Herdr 取代 tmux，要在真实插件和旧用户迁移实验后另作决定。

**Herdr 的职责：** 创建 Workspace/Pane，启动/识别两个 Agent，观察活动与终端，提供终端内插件动作和控制 Pane；RLL CLI 保留任务、轮次、提交、评审和门禁判定。[Herdr 插件接口](https://herdr.dev/docs/plugins/) · [Agent 自动化](https://herdr.dev/docs/agent-automation/)。

## 3. 先建怎样的开发分支

**代码开发仓库是公开的 `YW1975/Ralph-Lisa-Loop`。** 已在独立的 `Ralph-Lisa-Loop-herdr/` 目录完成检出；该目录与原有内部工作区平级。公开插件的源码、测试和经审查的文档都在本仓维护，不依赖内部工作区。S0、S1 只读检查和新建会话身份分支已推送开发 fork 并通过 CI；当前在本地 `feat/herdr-s1-mutation-guard` 继续下一切片。

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
| `chore/herdr-s0-baseline` | 开工时重新拉取的 `origin/main@7440e29` | 锁文件、可重复安装、原 CLI 回归与公开边界检查；当前本地开发分支 | 独立 PR → `main`；通过基线检查后合并 |
| `feat/herdr-plugin` | 目前暂基于本地 S0；S0 合并后对齐最新 `origin/main` | S1–S5 的本地集成分支；尚未验收的能力留在这里 | 完整验收、公开审查通过后最终 PR → `main` |
| `feat/herdr-s1-inspect` | 暂基于 `feat/herdr-plugin` | 显式项目定位与只读 JSON 检查；已推送并通过 CI | 后续进入集成分支；不直接合并公开 `main` |
| `feat/herdr-s1-identity` | `feat/herdr-s1-inspect` | 新建会话的稳定 ID 与规范路径记录；已推送并通过 CI | 旧会话接管另做切片 |
| `feat/herdr-s1-mutation-guard` | `feat/herdr-s1-identity` | 宿主占用标记下拦截传统写入和清理命令；当前切片 | 独立测试、提交、推送；原子租约另做切片 |
| `feat/herdr-s1-*`、`feat/herdr-s2-*` 等 | 当时最新的 `feat/herdr-plugin` | 每个可评审切片的短期工作分支，例如会话身份、事务回执、manifest、双席协调 | 小 PR → `feat/herdr-plugin`；每个 PR 有自己的测试与验收结果 |

这样先把不改变产品行为的 S0 基线单独合入公开 `main`，随后把尚未完整交付的 Herdr 能力留在集成分支。当前为推进开发，后续切片临时叠在 S0 提交上；正式 PR 前按合并后的公开 `main` 核对和调整。切片依次合并并复测；集成分支不在别人基于它开发后强制改写历史。最终 PR 合并到公开仓 `main` 前，复核与当前 `main` 的差异、完整历史/依赖/许可及敏感内容，跑干净安装、旧 CLI 回归和真实 Claude/Codex 流程。**S0 与只读检查分支已推到 fork；原仓 PR 尚未创建。**

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

建议先安排 **S0 约 3–5 人日的计划额度**（含公开边界审查、依赖/测试基线和契约清单），完成后再逐切片重估总工期；这不是已实测工时或报价。本机依赖安装现已成功，远端 CI 与真实 Herdr 集成尚未验证，不应把未跑过的双席测试写成通过。

**当前已完成：** 公开仓独立检出及只读接口盘点、本机 Herdr 版本和集成状态核对、当前文件的快速敏感模式扫描、官方插件与 Marketplace 要求复核；S0 固定依赖和锁文件通过本机 `npm ci`、构建与 382 项基线测试；S0、只读检查、新建会话身份和宿主占用保护分支已在开发 fork 的 CI 成功。传统写命令短锁已推送；当前分支本机验证 `host claim/release` 原子占用与冲突拒绝。**尚未完成：** 完整历史/许可审计、旧会话接管、租约心跳与恢复、S1 席位/回执契约、隔离 `plugin link`、真实 Agent 双席或原仓发布。
