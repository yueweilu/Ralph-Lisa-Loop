# S4 活动快照失败诊断

日期：2026-11-05。基线 `5ca120d`，承接[真实非零游标验收](s4-live-nonzero-continuation-2026-11-05.md)。旧隔离记录只保存 `ACTIVE_SNAPSHOT_MISMATCH`：协调器在 generation 1 第二次接续后退出，旧 PID 消失，保存游标和历史投递在恢复审查时一致。旧记录没有保存当次 CLI 的退出状态、返回状态或未匹配字段，因此不能从它推断根因。

`requireActiveSnapshot` 失败时仍按原条件停止协调器。新增的 `snapshot_diagnostic` 只记录 CLI 退出状态、受限格式的返回状态与错误码、进程启动错误码，以及固定字段名组成的 `unmatched_fields`。字段覆盖项目路径、RLL 会话、宿主状态、所有权、绑定状态与代次、Workspace、两席 Pane 和 generation；不记录字段值、任务正文或 Agent 原生会话 ID。活动协调器将诊断写入 `needs_reconcile` 记录并输出；重绑暂停态停止预检只输出诊断，不改写原记录。

本次改动仅提供下一次真实运行的定位证据，不将旧错误归因于特定字段或 CLI 状态。后续新命名 Server 和临时项目的复现、修复与稳定性结果须另行记录。
