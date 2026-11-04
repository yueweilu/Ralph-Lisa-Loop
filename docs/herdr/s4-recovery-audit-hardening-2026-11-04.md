# S4.2 恢复核对加固

日期：2026-11-04。分支：`feat/herdr-s4-recovery-audit-hardening`。

恢复审查现在核对插件记录的绑定代次与 CLI 租约证据；逐项核对初始提示和交接提示的 Workspace、Pane、角色、代次及消息摘要与保存的席位计划；再读取一次 CLI 快照，确认项目、会话、宿主、绑定、业务摘要和两席 Pane 仍与恢复证据及插件计划一致。错位返回 `needs_reconcile`，不会回收租约或重新投递。

隔离测试用真实公开 CLI 和伪 Herdr 覆盖初始提示的目标 Pane、Workspace、消息摘要、角色、绑定代次和整套席位计划被改动时的拒绝。该核对仍是两个先后读取的只读观察，不构成跨 CLI、插件状态和 Herdr Server 的原子快照。人工必须继续检查协调器及 Agent 是否停止、是否存在未记录投递，再决定是否调用显式 `host recover-lease`。真实 Herdr Server 重启与原生会话恢复尚未验收。
