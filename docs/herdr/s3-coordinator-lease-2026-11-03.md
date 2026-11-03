# S3.2 Herdr 协调器租约与双席绑定实测

日期：2026-11-03。范围：公开仓插件 `start/stop` 动作的真实 Herdr 0.9.4 服务运行；未执行 Agent 消息投递、候选提交或自动轮次交接。

## 实现边界

`start` 先以只读预检确认同一 Herdr Workspace 内的 `ralph`（Claude）与 `lisa`（Codex）均已运行且就绪，再写独占意图、领取 RLL 宿主租约、复核会话和业务摘要、复核两个 Agent 的真实 Pane ID、绑定两席并持续心跳。`stop` 通过持久请求让原协调器释放租约；不会关闭两个 Agent。异常或不确定状态保留记录并要求人工核查，不会按心跳超时自动抢占。

## 隔离服务验证

在临时 XDG 配置及临时 RLL 项目下启动 Herdr 0.9.4 服务；创建 `w1` Workspace 和 `w1:p1`、`w1:p2` 两个 Pane。Herdr `agent start` 启动 Claude `ralph`；Codex `lisa` 首次遇到更新提示，跳过提示后 Herdr `agent list` 报告两席 `idle`、`interactive_ready=true`。没有安装 Claude/Codex 的 Herdr 集成。

链接当前插件后调用 `ralph-lisa.loop.start`。异步调用先返回运行中日志 ID；随后插件状态为 `active`，RLL `host snapshot` 报告 `host_state=claimed`、`binding_state=bound`、`binding_generation=2`、两席 Pane 分别为 `w1:p1` 和 `w1:p2`。租约记录中的 `heartbeat_seq` 达到 9，证明长运行协调器持续心跳。调用 `ralph-lisa.loop.stop` 后，两条 Herdr 插件日志均为 `succeeded`、退出码 0；`start` 日志包含 `started` 和 `stopped`，`stop` 日志包含 `stopped`。RLL 快照变为 `host_state=unclaimed`、`binding_state=stale`，业务 `state_digest` 始终为 `57b5bc7ee5ca16c279e78074179a6405c3ca4d86de3ec7543414b0543fe75633`。

自动化测试使用真实公开 CLI、临时项目以及替身 Herdr/Agent 命令，覆盖双席绑定、重复启动拒绝、心跳、显式停止和业务摘要不变。该测试不能替代真实 Agent 交接验收。

## 下一步与限制

当前没有 Agent 消息投递、Ralph/Lisa 自动轮次交接、候选来源认证、`pause/resume` 或 Herdr 服务重启后的同会话恢复。RLL CLI 将席位标记为 `verification=unverified`；插件在绑定前核对 Herdr 返回值，但 RLL CLI 不能独立证明这些返回值的来源。异常退出会保留宿主租约，需先做 `host recovery-check` 和人工核查。S3 后续应以受控提交回执驱动双席交接；S4 再安装 Herdr 集成并验证重启恢复。
