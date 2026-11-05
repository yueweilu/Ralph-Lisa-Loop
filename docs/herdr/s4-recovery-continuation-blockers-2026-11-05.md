# S4 重启接续前的只读阻断项

日期：2026-11-05。对应公开插件实施文档 S4 的“恢复核对、Herdr 重启重绑、未知提交停在待核对”。

## 已实现

插件 `recovery-check` 在已有租约、投递记录与 Herdr 席位核对上，增加 `coordinator_process` 和 `continuation_blockers`：

| 阻断码 | 含义 |
|---|---|
| `COORDINATOR_PID_PRESENT` / `COORDINATOR_PID_UNKNOWN` | 旧记录中的进程 PID 存在或无法观察；不能假定旧协调器已停止 |
| `PLUGIN_RECORD_MISSING` | 缺少可核对的插件协调记录 |
| `DELIVERY_OUTCOME_UNCERTAIN` | 初始提示未确认接受，或任一投递意图未确认接受 |
| `DELIVERY_RECORD_MISSING` | 初始投递记录缺失，或已提交代次缺少连续且已接受的交接记录 |
| `CURSOR_STATE_MISMATCH` | 协调器最后确认的代次、回执或轮次与 RLL 当前快照不一致 |
| `CONTROL_PENDING` | 暂停、恢复或停止请求文件仍待处理 |
| `SEAT_REBIND_REQUIRED` | Herdr 双席缺失、位置变化，或原生 Agent 会话摘要未与原记录匹配 |

这些字段只用于拒绝未经核对的接续。PID 检查是一次 `kill(pid, 0)` 观察，可能遇到 PID 复用；`pid_absent` 也不能证明没有在途 Agent 提示。空阻断列表不是自动恢复许可。CLI 租约恢复仍须人工逐项核实 `required_checks`，后续接续动作也必须重新校验状态，不能信任这份旧输出。

## 验证与剩余

隔离测试使用真实公开 CLI 和伪 Herdr，覆盖活跃协调器 PID、原生会话变更、初始提示结果不明、投递记录缺失、游标错位和未处理控制文件；原有 Server 重启与投递不重放用例仍通过。真实 Herdr Server 重启后的重绑、租约接续及不重复交接尚未验收。
