# S4 真实 Herdr Server 重启与原生会话诊断

日期：2026-11-04。分支：`feat/herdr-s4-native-session-diagnostics`。环境：macOS、本机 Herdr 0.9.4、已安装的 Claude v10/Codex v9 Herdr 集成、已登录的两种 Agent CLI。实验仅使用临时 XDG 配置和状态目录、命名测试服务、一次性 RLL 项目；没有操作默认 Herdr 会话或现有源码项目。

## 重启前

插件 `doctor` 完成日志返回 `ready`。`start` 自动创建双席、领取 RLL 租约、绑定两个 Pane、建立代次 0，并且只向 Ralph 投递一次初始任务。RLL 快照为 `host_state=claimed`、`binding_state=bound`、`generation=0`；插件投递意图为 `accepted`。只读 `recovery-check` 返回 `review_required`，两席位置均匹配。Herdr `agent list` 中 Ralph 的 Claude Agent 带原生 `agent_session` 引用，Lisa 的 Codex Agent 虽为 `idle` 且可交互，却没有 `agent_session` 引用。

## 停止、重启与复查

通过 `herdr session stop <测试会话>` 停止命名测试服务，再从相同临时 XDG 目录启动同名 headless Server。服务日志显示保存与恢复两个 Workspace；原协调器进程消失，RLL 租约仍为 `claimed`，代次与业务摘要未变。Herdr 恢复了 Ralph 所在 Pane 的 Claude Agent，原生会话引用与重启前相同；Lisa 的 Pane 仍在，但只显示 shell，`agent get lisa` 返回 `agent_not_found`。重启后插件命令日志从新会话重新编号，不能当作持久投递账本。

重启后的 `recovery-check` 仍返回 `review_required`：Ralph `matches_binding`，Lisa `unavailable`，初始提示记录仍为 `accepted`。重复调用 `start` 的完成日志返回 `HOST_ALREADY_CLAIMED`，没有重发初始任务。没有调用 `host recover-lease`，也没有把 Lisa 的不可见当成“不会有未记录投递”的证明。

## 本切片改动与边界

`recovery-check` 现在展示每席原生会话引用的 `present`、`missing`、`invalid` 或 `unavailable` 状态，以及存在引用时的 SHA-256 摘要，不输出原始引用。任一席位身份不匹配或引用不可用时，`restart_observation=manual_rebind_required`。引用存在只是一项观察，不能证明它与重启前相同；当前插件尚未在绑定记录中持久保存并核验原生会话引用，也未实现安全重绑、租约接续或自动续跑。完整 S4 重启恢复验收仍未通过。

隔离自动化测试覆盖一席有原生引用、另一席缺失时的诊断与原始引用不外泄；插件测试 14/14 通过。首轮 GitHub CI 的 Node 18 任务暴露了测试在协调器短锁期间读取 `status` 的竞态；测试现仅对明确的 `HOST_BUSY` 做有界重试，其他错误仍直接失败。真实服务试验证明上述特定场景，不能推广为所有 Agent 版本与会话状态的恢复行为。下一步需要把可核验的原生会话身份与 RLL 席位绑定持久关联，并分别处理“从未建立原生会话”“会话已恢复但协调器消失”“投递结果不明”三种路径，任何不确定路径均保持人工核对。
