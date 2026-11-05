# S4 真实非零游标重复重绑验收

日期：2026-11-05。基线提交 `0157568`，现场发现的暂停态修复另行提交。使用独立 XDG 目录、命名 Herdr 0.9.4 Server `rll-s4-live-cuzpam` 和临时项目 `/tmp/rll-s4-live-20261105-cUZPAm/project`；没有操作默认 Herdr 会话或 `super-rll`。只记录原生 Agent 会话的存在与指纹连续性，不记录原始引用。

## 双席与候选

用户仅对上述临时项目确认了 Claude 的目录信任。Ralph/Claude 的原生会话引用存在；Lisa/Codex 使用未修改官方 hook 的 `--no-daemon` 启动，第二次就绪提示后 Herdr 也提供有效引用。`seat-preflight` 记录两席指纹。临时项目中的全局 `ralph-lisa` 命令与本仓库公开 CLI 不同，会提示缺少 `.session-anchor`；插件配置使用本仓库 `cli/dist/cli.js`，公开宿主命令正常。Agent 未执行候选确认或正式提交。

Ralph 终端草稿经用户对精确候选和 SHA-256 单独确认，公开 CLI 记录 `human_asserted`，随后仅一次 `host commit` 将 generation 0→1、`turn=lisa`。策略通过，测试门禁未启用；插件仅保存一份 generation 1、目标 Lisa 的 `accepted` 交接。Lisa 在真实 Pane 留下 `[NEEDS_WORK]` 草稿。候选来源验证仍为 `unverified`，人工作者确认不等于独立作者证明。

## 两次 generation 1 重启

第一次重启前协调器已确认 `paused`、游标 1，Lisa 已完成交接提示。重启后旧 PID 消失；`recovery-check` 合并看到一份初始提示、一份 Lisa 交接，两席原生会话指纹均 `matches_record`。CLI 使用证据摘要显式回收旧租约且声明不重放。原 `0157568` 的 `rebind-check` 对已确认的 `paused` 记录返回 `PLUGIN_RECORD_INVALID`。现场修复仅允许暂停记录的 `pause_state_digest`、generation、回执和轮次与当前快照及游标完全相同，并继续要求旧 PID 不在、恢复回执、接受的完整投递链和两席指纹。修复后第一次精确 `REBIND` 建立 `rebound_paused`；精确 `CONTINUE` 从 generation 1 启动，未新增提示。

第二次 Server 重启后同样核对旧 PID、两席指纹、游标与两份已接受投递，显式回收替代租约。`rebind-check` 无阻断；第二次精确 `REBIND` 建立深度 2 的嵌套归档，精确 `CONTINUE` 从 generation 1 启动。此时全链仍只有一份初始提示和一份 Lisa 交接。

第二次接续后的协调器后来在 Lisa 候选提出之前以 `ACTIVE_SNAPSHOT_MISMATCH` 停到 `needs_reconcile`。当时只读恢复审查显示旧 PID 已退出、游标仍为 1、历史投递均为 `accepted`、两席指纹匹配且无在途投递阻断；错误的内部触发条件未被证明。为完成当前交接，先停止并重启命名 Server，随后按新证据显式回收、第三次重绑并接续；深度 3 的归档和游标 1 均通过预检。没有手工修改记录、伪造引用或重放提示。这个额外恢复是持续运行稳定性尚需继续排查的限制。

Lisa 候选在当前租约下重新提出后，用户对精确候选、SHA-256 及终端草稿的格式整理单独确认。`commit-check` 保持 `human_source_asserted`，策略为 `warn`（`reason-required`），测试门禁未启用。仅一次正式 `host commit` 将 generation 1→2、`turn=ralph`；插件全链恰好一份 generation 2、目标 Ralph 的 `accepted` 交接，真实 Ralph Pane 显示匹配回执。Ralph 对旧全局 CLI 的下一条命令请求已取消，没有产生新候选。插件正常 `stop`；最终公开 CLI 快照为 `host_state=unclaimed`、`binding_state=stale`、generation 2，命名 Server 已停止。

## 证据边界

本地插件套件 33/33 通过，新增用例覆盖非零游标的暂停态重启、快照不符拒绝、显式重绑与单次交接。真实验收覆盖两次非零游标重启和第二次显式重绑；后续额外恢复与 `ACTIVE_SNAPSHOT_MISMATCH` 单独保留为运行时限制。GitHub CI 只验证代码回归，不能替代真实 Agent 与 Server 观察。
