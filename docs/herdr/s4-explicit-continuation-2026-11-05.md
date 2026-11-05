# S4 显式接续替代租约

日期：2026-11-05。基线为 [只读接续预检](s4-continuation-preflight-2026-11-05.md) 和 [显式暂停重绑](s4-explicit-paused-rebind-2026-11-05.md)。

## 操作和状态

操作者先在原 Workspace 执行 `ralph-lisa.loop.continuation-check`，确认替代租约、当前轮次、保存游标、两席和证据摘要。然后打开插件 `continue` Pane，输入精确的 `CONTINUE <证据 SHA-256>`。该 Pane 重新执行预检；输入不匹配或预检已变化时不写入。

通过后，协调器独占写入 `continuation.pending.json`，再次核对插件记录、RLL 快照、Ralph/Claude 与 Lisa/Codex 的 Pane 和 Terminal，并给替代租约发送一次心跳。随后记录新进程 PID、原游标和 `active` 状态，删除意图标记，发出 `continued`。**启动接续不会调用 `agent prompt`，旧任务和旧回执也不会重放。**

活动协调器沿用原有心跳、暂停/恢复、停止和 `checkDelivery` 逻辑。新回执必须属于替代租约，匹配当前绑定代次，并从保存的游标只前进一步。投递前先以回执 ID 独占写入意图；Herdr 明确确认后才将投递标为 `accepted` 并推进游标。结果不明时保留意图，停止在 `needs_reconcile`，不自动重试。

恢复审查现在合并读取旧租约归档和替代租约的新投递记录，并固定接续时继承的游标。接续写入中断会留下 `continuation.pending.json`；检查和停止动作均要求人工核对，避免第二个协调器接管。

## 已验证和未验收

隔离伪 Herdr 回归验证：证据不符不启动；成功接续不重发旧 Ralph 提示；新租约的 Ralph 提交只提示 Lisa 一次；重复接续被拒；席位身份在写入后变化留下待核对标记；Lisa 提示结果不明保留投递意图且不重试。Pane 单测覆盖取消、精确确认和结果不明。插件套件 31/31 通过；隔离 XDG 配置中的 `herdr plugin link` 接受了新增 Pane。

后续增加了非零游标的重启接续组合测试：旧租约在第 0 代由 Ralph 正式提交并只向 Lisa 投递一次，保存第 1 代游标和 Lisa 原生会话指纹；模拟重启后人工回收旧租约、显式重绑并接续。替代租约从第 1 代启动时不重发旧提示，Lisa 的 `NEEDS_WORK` 正式提交进入第 2 代，只向 Ralph 投递一次。恢复审查同时核对旧归档和新投递链，两个回执分别属于旧、新租约。此项仍属于本地隔离验证。

真实 Herdr Server 重启后，仍须在受管 Herdr Pane 中验证替代租约接续、真实 Claude/Codex 原生会话、一次交接和异常阻断。人工候选来源确认仍是公开 CLI 的门禁；本功能不实现无人值守候选提交。
