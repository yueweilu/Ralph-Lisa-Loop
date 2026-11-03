# S3.1 双席身份只读预检

状态：**本机隔离 Herdr 运行中验证通过；尚未领取 RLL 宿主租约，也未自动交接。**

## 为什么此阶段不安装 Claude/Codex 集成

Herdr 0.9.4 的官方 Agent 文档说明它能通过终端画面识别 Claude Code 和 Codex 的状态；这两项集成主要使 Herdr 服务重启后恢复原 Agent 会话。S3 的首次启动和席位识别可先验证基础能力，S4 重启恢复验收时再安装集成并检查现有 Agent 配置改动。本插件的 `doctor` 现在把集成安装情况作为独立诊断信息；Herdr 版本、RLL 宿主契约和 Agent 登录状态通过时，不再把缺集成误报为基础启动阻塞。

资料：[Herdr Agents](https://herdr.dev/tui/docs/agents/) · [Herdr Integrations](https://herdr.dev/tui/docs/integrations/)。

## 本次实现

新增 `seat-preflight` 插件动作。它在调用时读取当前 Workspace 上下文和 RLL `host snapshot`，通过 `herdr agent get ralph/lisa` 核对：

| 核对项 | 要求 |
|---|---|
| 角色 | `ralph` 必须是 Claude，`lisa` 必须是 Codex |
| 位置 | 两席属于当前 Workspace，Pane ID 不同，Agent 工作目录对应同一 RLL 项目 |
| 状态 | 两席处于 `idle` 或 `done`，且 Herdr 标记 `interactive_ready=true` |
| RLL | 会话已初始化，`host_state=unclaimed`，快照有会话 ID 和状态摘要 |

通过时返回 `binding_plan`（项目、会话、预期摘要、Workspace ID 和两席 Pane/Agent 目标），**不调用** `host claim`、`host bind-seat` 或 `agent prompt`。身份不符、Agent 缺失或阻塞时返回明确错误并退出非零。控制 Pane 同步显示这份预检结果。

## 实测回执与边界

在临时 XDG 目录和一次性项目的 `rll-s3` Herdr 服务中，未安装 Claude/Codex Herdr 集成。Herdr 分别启动 Claude 和 Codex，处理了测试目录信任确认，并跳过 Codex 更新提示；两席随后均被 Herdr 识别为 `idle`。`agent get` 返回同一 Workspace `w1` 下的 `ralph → claude → w1:p1`、`lisa → codex → w1:p2`，工作目录均为样板项目。插件日志 `plugin-log-1` 的 `seat-preflight` 退出码为 0，包含上述不同 Pane 的 `binding_plan`；`plugin-log-2` 的 `doctor` 也以退出码 0 报告 `ready`，同时保留 `integrations.claude=false`、`integrations.codex=false`。

本次没有从 Agent 获取可复核的原生会话引用，RLL 候选来源仍不能自动证明。下一切片才将实际 Herdr ID 写入 RLL 租约/席位绑定，并处理进程中断与部分绑定；之后才能开展提交回执驱动的单次交接。S4 需要另外验证安装集成后的服务重启恢复。
