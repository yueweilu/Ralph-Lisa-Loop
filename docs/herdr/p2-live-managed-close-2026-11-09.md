# P2 受管理启动与关闭：真实 Herdr 验收（2026-11-09）

## 范围与隔离

- 公开仓分支：`feat/herdr-auto-task-launch`；试验开始时本地及 fork 均为 `b7f633dc4ad2d3e7792b8161a45b70a4a0803434`。
- Herdr 0.9.4；本仓插件 0.1.5、本仓构建的 CLI 0.3.13。三个命名 Server 分别使用 `/tmp/rhp2-Ml523e` 下独立的 `XDG_CONFIG_HOME`、`XDG_STATE_HOME` 与临时项目状态。测试项目路径每次复用前均保留前次项目目录，未覆盖旧 `.dual-agent`。
- 任务只要求在一次性项目写一行 README。没有对候选做来源确认、正式提交或交接；没有操作默认 Herdr 会话及 `super-rll`。Claude 对 `/private/tmp/rhp2-Ml523e/project` 的目录信任由用户仅对此目录授权一次；其他权限提示未代答。
- Terminal 中打开了隔离 Herdr TUI，但自动化工具不能读取该 Terminal 画面。因此这里只验收 CLI、Server 日志、插件记录及 RLL 宿主状态，不把视觉布局标为已验收。

## 三次现场结果

| 会话 | 现场观察 | 处理及结论 |
|---|---|---|
| `rll-p2-ml523e` | 首次受管理启动遇到 Claude 目录信任，CLI 返回 `needs_input`；用户授权后 Ralph 就绪，但启动协调器已超过两分钟并留下 `AGENT_READY_TIMEOUT` 的未就绪结果。 | 同一启动请求按预领租约重试，保留原 Ralph 原生会话，Lisa Pane 启动，初始任务只投递一次，`started`、generation 0、host claimed。修复了合法重试无法更新旧启动结果的问题：旧结果先归档，当前结果写为 `started`。 |
| `rll-p2b-ml523e` | 新会话直接 `started`，初始投递一次。关闭受管理协调器 Pane 后，Server 在约 0.5 秒后以 SIGKILL 结束子进程；RLL 租约仍 claimed，插件记录仍 active。 | 增加 SIGHUP 监听仍不足：协调器在一秒轮询等待中未及时执行安全释放。停止隔离 Server，确认相关进程退出、generation 0、候选 0、只有一份已接受初始投递后，以 `recovery-check` 的证据摘要显式回收旧租约；未重放。 |
| `rll-p2c-ml523e` | 新会话直接 `started`，初始投递一次。关闭控制 Pane 的 Server 日志显示请求时间 `02:53:07.992968Z`、子进程 SIGTERM 退出 `02:53:08.268042Z`。 | 改为信号唤醒轮询等待后，协调器在 Herdr 强制终止前完成游标核查及宿主释放。插件留下 `phase=released`、`stop_reason=managed_pane_closed` 的 finished 记录；RLL 快照为 `host_state=unclaimed`、`binding_state=stale`、generation 0、候选 0。该命名 Server 已停止。 |

第一次与第二次失败留下的租约均按只读证据和明确的 `verified-stopped-no-replay` 决策回收；没有删除租约文件来模拟成功。第三次正常释放无需恢复命令。三个隔离 Server 均已停止；临时试验目录保留用于复核。

## 本次代码边界

1. 仅在预领租约检查通过、且请求 ID 与原 `not_ready`/`needs_reconcile` 结果相同的情况下，归档并替换启动结果。已 `started` 的结果不能被该路径覆盖。
2. 受管理启动监听 SIGHUP，并用可被信号立即唤醒的等待代替一秒固定睡眠。活动循环仍先核对宿主快照、游标及未投递回执，再调用原 `host release`；检查不通过继续保留租约供人工恢复。
3. 回归覆盖预领租约关闭后同请求重试、初始提示一次、SIGTERM/SIGHUP 关闭及业务状态变化时拒绝释放。模拟测试不替代上述真实 Herdr 证据。

## 尚未验收

- Lisa/Codex 在这三次启动中均未向 Herdr 返回可保存的原生会话引用；第三次 finished 记录中 Lisa 的原生引用指纹为 `null`。因此不能据此宣布双席 Server 重启接续通过。需独立排查 Codex 启动/SessionStart hook、Herdr `agent get` 与本插件 `nativeSessionReference` 的字段契约，并用新的隔离会话复验。
- 本轮没有正式候选、Ralph→Lisa 或 Lisa→Ralph 交接，也未验证任务输入 overlay 的视觉呈现。自动提交仍受现有逐份人工来源确认门禁约束；本次修复没有放宽门禁。
- 关闭活动 Pane 时的安全释放仅在快照与游标一致、没有待投递回执的场景通过。SIGKILL、Server 异常退出、忙锁或已提交而未交接的场景仍需 S4 只读恢复与显式决策。

## 验证记录

本地执行 `node --test integrations/herdr/*.test.mjs`，47/47 通过。真实证据为各隔离项目的 `host snapshot`、`host recovery-check`、插件 `initial-*`/`finished-*` 记录及命名 Server 日志；文档不包含任务正文、原生 Agent Session ID 或个人凭证。提交与 GitHub CI 状态在本次开发报告中另行核对。
