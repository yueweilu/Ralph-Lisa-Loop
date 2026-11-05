# S4 活动快照失败诊断

日期：2026-11-05。基线 `5ca120d`，承接[真实非零游标验收](s4-live-nonzero-continuation-2026-11-05.md)。旧隔离记录只保存 `ACTIVE_SNAPSHOT_MISMATCH`：协调器在 generation 1 第二次接续后退出，旧 PID 消失，保存游标和历史投递在恢复审查时一致。旧记录没有保存当次 CLI 的退出状态、返回状态或未匹配字段，因此不能从它推断根因。

`requireActiveSnapshot` 失败时仍按原条件停止协调器。新增的 `snapshot_diagnostic` 只记录 CLI 退出状态、受限格式的返回状态与错误码、进程启动错误码，以及固定字段名组成的 `unmatched_fields`。字段覆盖项目路径、RLL 会话、宿主状态、所有权、绑定状态与代次、Workspace、两席 Pane 和 generation；不记录字段值、任务正文或 Agent 原生会话 ID。活动协调器将诊断写入 `needs_reconcile` 记录并输出；重绑暂停态停止预检只输出诊断，不改写原记录。

## 新隔离真实运行

诊断提交 `71bde7b` 已推送，其 Node 18/20/22 CI 和本地插件套件 34/34 均通过。使用独立 XDG 目录、命名 Herdr Server `rll-s4-snapshot-vq8mnt` 与临时项目 `/tmp/rll-s4-snapshot-20261105-vq8Mnt/project`；仅在用户对该路径回复继续后确认 Claude 的目录信任。Lisa 使用未修改官方 hook 的 `--no-daemon`，两席在 Herdr 中均有有效原生引用。没有操作默认 Herdr 会话或 `super-rll`。

Ralph 的带标签候选在公开 CLI 的只读预检为 `awaiting_source_confirmation`、策略 `warn`（`plan-test-plan`）、测试门禁未启用。用户确认了精确正文和摘要后，仅一次正式提交进入 generation 1；Lisa 收到一份 `accepted` 交接。协调器暂停后，第一次和第二次命名 Server 重启均核对旧 PID 已退出、两席原生指纹匹配、游标 1 和两份已接受投递，再分别显式回收旧租约、重绑与接续。两个接续均未重发旧提示，归档深度达到 2。

第二次接续后连续十分钟只读观察，协调器始终 `active`、游标 1，公开 CLI 快照为已认领且已绑定，没有 `snapshot_diagnostic`。Lisa 的新租约候选经用户再次确认精确正文、摘要和策略 `warn`（`reason-required`、`file-line-ref`）后，只正式提交一次进入 generation 2。插件完整投递链恰好为 Ralph 初始、Lisa 交接、Ralph 交接各一份，均为 `accepted`；Ralph 真实 Pane 显示匹配回执。再观察三分钟仍为 `active`、游标 2，随后插件正常 `stop`，命名 Server 停止，最终公开 CLI 快照为 `unclaimed`、绑定 `stale`。候选的 `source_verification` 仍为 `unverified`，人工确认不构成独立作者证明。

**结论边界：**本次按旧现场的非零游标重复重绑顺序运行，但未复现 `ACTIVE_SNAPSHOT_MISMATCH`。旧记录和这次运行均不能确定旧错误的 CLI 返回状态或具体未匹配字段，因此没有证据支持针对根因的行为修复。十分钟及交接后三分钟的正常运行是有界稳定性观察，不等于长期稳定性验收。若再次触发，保留 `snapshot_diagnostic` 与只读恢复证据，先据其定位再修改阻断逻辑。
