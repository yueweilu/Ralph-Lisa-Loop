# S4 Herdr 重启后的孤儿协调器阻断

日期：2026-11-04。分支：`feat/herdr-s4-server-epoch-fence`。

## 真实试验发现

在临时 XDG 目录和命名 Herdr 0.9.4 服务中，最新公开插件自动创建 Claude/Codex 双席并投递一次初始任务。RLL 租约已领取，Ralph 的原生会话摘要写入持久席位计划，`recovery-check` 显示 `matches_record`；Lisa 在首次正式交接前仍为 `not_recorded`。停止并重启命名 Server 后，Ralph 的原生会话摘要仍匹配，Lisa 的 Pane 存在但 Agent 不可用。

与先前一次试验不同，**旧插件 action 协调器进程这次未退出**：其原 PID 成为 PID 1 的子进程，重启后的 RLL 租约心跳序号从 19 增至 25，插件新 Server 的命令日志却从空列表开始。旧协调器与新 Server 生命周期不能混为一谈。随后对该隔离项目调用插件 `stop`，旧进程退出、RLL 租约释放；命名测试服务也已停止。没有对默认 Herdr 会话或现有源码项目操作。

## 本切片的阻断方式

启动预检要求 Herdr 返回两席各自的 `terminal_id`，并将其与 Workspace、Pane、原生会话摘要一起持久保存。每次投递前重新核对目标 Terminal；协调器每五秒在发送下一次 RLL 租约心跳前检查两席实时 Agent、项目、Workspace、Pane、Terminal 和已记录的原生会话摘要。Herdr API 不可用、Agent 消失或 Terminal 改变时，协调器写入 `needs_reconcile` 并停止，保留原租约与投递记录供人工核对。`recovery-check` 可显示 `terminal_changed`。正式投递意图也写入目标 Terminal ID 供恢复审查。

真实重启时 Herdr 重新创建了 Ralph Terminal，ID 与重启前不同；这是本机 Herdr 0.9.4 的观察，不将 Terminal ID 当作公开保证的全局 Server 代次。正常的 Terminal 替换也会触发保守暂停。旧代码已经启动的协调器不会因这次源码更新自动获得阻断逻辑，须先显式停止旧运行实例。

## 新代码的真实重启验收

同日另建独立项目 `project-fence` 和命名会话 `rll-s4-fence`，运行更新后的插件。启动后 Claude/Codex 两席就绪，初始提示已接受；插件记录为 `active`，协调器 PID 为 `39860`，RLL 租约为 `claimed`。保存的 Ralph/Lisa Terminal ID 分别为 `term_65f6d62b42c042` 和 `term_65f6d6485a8443`。

停止并重启这个命名 Herdr Server 后，旧协调器 PID 不再存在，插件记录变为 `needs_reconcile`，错误为 `AGENT_CHANGED`：重启时 Lisa Agent 缺席。Ralph 的新 Terminal ID 为 `term_65f6d6ace8c582`，也与原计划不同。租约仍为 `claimed`，心跳序号停在 `5`，六秒后复查未增加；轮次仍为第 1 轮、generation `0`，没有观察到第二次投递。新 Server 的插件命令日志为空。最后已停止这个命名测试会话；未调用租约恢复或修改默认 Herdr 会话。

因此，当前版本在本机真实 Server 重启场景下验证了旧协调器退出和保守暂停。这里实际先触发的是 Agent 缺席检查；Terminal 变化分支由伪 Herdr 隔离测试覆盖。自动恢复、租约接管和正式提交交接仍未因此得到验证。
