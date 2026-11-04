# S4.2 只读恢复核对

日期：2026-11-04。分支：`feat/herdr-s4-recovery-audit`。

Herdr 新增 `recovery-check` action。它调用公开 CLI 的 `host recovery-check` 获取租约、绑定代次、业务摘要和证据哈希，再从插件状态目录只读检查当前协调器记录、初始任务意图及逐轮投递意图，并查询 Herdr 两席是否仍与保存的 Workspace、Pane、项目路径一致。输出不包含任务正文或提示全文。

此 action **不调用** `host recover-lease`，也不把 PID、Agent 不可见或旧心跳单独解释为“已停止”。有投递 `intent` 时明确给出 `DELIVERY_OUTCOME_UNCERTAIN`；记录缺失或损坏、租约身份不一致时返回对应错误。任何租约回收仍需按 CLI 回执中的 `required_checks` 核对协调器、Agent 与未记录投递，再走显式人工确认。

隔离测试使用真实公开 CLI 和伪 Herdr，覆盖活跃协调器的租约/双席/已接收初始提示、初始投递超时后的未决意图，以及损坏投递记录的拒绝。真实 Herdr 重启、Agent 原生会话恢复与重新绑定尚未验收；本切片只建立恢复前的观察入口。
