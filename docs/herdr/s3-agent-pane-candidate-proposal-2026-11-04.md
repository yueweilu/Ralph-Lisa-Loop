# S3 Agent Pane 候选提议入口

日期：2026-11-04。分支：`feat/herdr-s4-server-epoch-fence`。

## 发现与选择

本机 Herdr 0.9.4 的隔离试验中，从 Pane `w1:p1` 执行 `herdr plugin action invoke`，当界面聚焦在 `w1:p2` 时，action 上下文返回的是**聚焦 Pane `w1:p2`**；不能据此判定调用者。相同条件下，在 Pane `w1:p1` 执行 `herdr pane current --current`，返回 `w1:p1`。Herdr 官方文档也说明每个 Pane 进程继承 `HERDR_PANE_ID`，Agent 命令可按当前 Pane 定位 Agent：[CLI 参考](https://herdr.dev/tui/docs/cli-reference/)、[Agent 自动化](https://herdr.dev/tui/docs/agent-automation/)。

因此新增 `integrations/herdr/candidate-propose.mjs`，由 Agent 在**自己的 Herdr Pane**中作为工具命令执行。它要求 Herdr Pane 环境，向 Herdr 查询调用 Pane 和该 Pane 的实时 Agent，再与公开 CLI 的项目、当前轮次、Workspace、Pane 和绑定代次核对；只有 Ralph/Claude 或 Lisa/Codex 位于当前合法席位且状态为 `working` 时，才使用现有 `host propose` 保存候选。调用方提供稳定的候选 UUID，重复调用沿用 CLI 的幂等语义。它不调用 `confirm-candidate` 或 `commit`。

## 验证

- 隔离自动化测试使用真实公开 CLI、伪 Herdr，覆盖非 Herdr 环境、调用 Pane 不匹配、Terminal 不匹配、错席位、非工作状态的拒绝，以及正常提议、重复 UUID 幂等和候选计数。
- 真实 Herdr 0.9.4 命名会话中，插件启动 Claude/Ralph 与 Codex/Lisa；Claude 在自己的 Pane 写出一次性 `[PLAN]` 文件并调用辅助命令。结果返回 `candidate_observed`、Ralph `w2:p1`、当前 Terminal、候选 SHA-256、`source_verification=unverified`、`commit_ready=false`。公开 CLI 快照显示 generation `0`、turn `ralph`、候选数 `1`；没有正式回执或交接。插件 `stop` 释放租约，命名测试服务已停止。默认 Herdr 会话未参与。

## 仍需解决

该入口核对的是**提议命令运行时的席位**，不是文件写入者的独立证明。Pane 环境和同一用户权限下的进程不能视为不可伪造的凭证；Agent 名称也可能在暂停进程后暂留。`source_verification` 因此仍为 `unverified`，人审门禁照旧。后续如要取消逐轮人工确认，须另立可审计的提交来源契约并验证 Agent 在真实工作流中如何提交候选；不能用 action 的聚焦 Pane、屏幕文字或本辅助命令的成功结果直接代签。
