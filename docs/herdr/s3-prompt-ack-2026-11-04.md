# S3.5 Herdr prompt 回执身份核验

日期：2026-11-04。分支：`feat/herdr-s3-prompt-ack`。

本机 Herdr 0.9.4 的 `herdr api schema --json` 将 `agent prompt` 的成功结果定义为 `type=agent_prompted`，并附带 `agent` 信息。S3.4 协调器此前只检查 `result` 存在，无法区分目标 Agent 的回执是否与当前绑定一致。

本次调整要求回执的类型、Agent 名称及种类、项目真实路径、Workspace ID 和 Pane ID 全部匹配，才将投递意图记为 `accepted` 并推进游标。命令返回错误、超时、空结果或回执指向别的 Pane 时，保留原始投递意图并进入 `needs_reconcile`；不自动再次投递。

隔离测试保留真实 RLL CLI 的 Ralph → Lisa `NEEDS_WORK` → Ralph 提交链路，伪 Herdr 回送符合 schema 的成功回执；另以模拟超时和“成功但返回错误 Pane”分别验证停机行为。该测试验证协调器的校验逻辑，**尚未验证真实 Herdr Agent 收到并执行提示**。实际服务验收仍需在一次性项目与隔离 Herdr 配置中进行，且现有 CLI 每轮人工来源确认门禁仍在。
