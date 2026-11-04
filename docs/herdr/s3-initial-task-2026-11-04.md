# S3.6 初始任务单次投递

日期：2026-11-04。分支：`feat/herdr-s3-initial-task`。

## 实现

插件在领取 RLL 租约、绑定真实 Herdr 双席和建立第 0 代后，确认当前轮次为 Ralph、项目 `task.md` 是非空普通文件，再向已核验的 Ralph 席位投递一次“阅读项目任务和当前 RLL 状态”的提示。任务正文仍留在项目 `.dual-agent/task.md`，插件的持久化记录只存会话、目标席位、代次和提示摘要。

初始提示使用独立 `initial-<session-id>.json` 意图，发送前同步落盘。只有 Herdr 返回匹配项目、Workspace、Pane、Agent 名称与种类的 `agent_prompted` 回执后，才记为 `accepted` 并输出 `started`。超时或回执不符进入 `needs_reconcile`，不自动重发。同一 RLL 会话即使正常停止并重新启动，也不会再次投递初始提示；恢复路径留给 S4 后续切片。

## 隔离验证

真实公开 CLI 与伪 Herdr 的集成测试覆盖初始 Ralph 提示一次、Ralph 正式提交后向 Lisa 投递、Lisa `[NEEDS_WORK]` 后交回 Ralph；重复轮询无额外提示。还覆盖初始提示超时保留意图，以及停止后同会话重新启动拒绝重复投递。真实 Herdr 双 Agent 的任务执行尚未运行验收；CLI 每轮候选来源确认门禁仍需人工操作。
