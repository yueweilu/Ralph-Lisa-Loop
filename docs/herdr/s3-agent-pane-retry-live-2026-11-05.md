# S3 Agent Pane 候选提议短时重查实测

日期：2026-11-05。针对[前次真实审阅窗格试验](s3-real-review-pane-trial-2026-11-04.md)中 `agent get=blocked`、`agent explain=working` 的分歧，在公开插件的候选辅助命令加入了有界重查。它仍只接受 `agent get` 实际返回 `working`，不把 `agent explain` 或标题文字当成来源凭证。

## 验收过程

- 使用独立 XDG 配置/状态目录和新命名 Herdr 0.9.4 会话，复用一次性 RLL 项目；另领租约并将两席绑定到新 Workspace 的 `w2:p1`/`w2:p2`。Ralph 由真实 Herdr `agent start` 启动 Claude，返回 `interactive_ready=true`、`agent_status=idle` 和新 Terminal ID。Lisa 的 Pane 只用于满足本次绑定快照，未启动 Codex；这不是双席交接试验。
- 通过 `agent prompt` 要求 Ralph 在自己的 Pane 只执行一次 `candidate-propose.mjs`，对已保存的 732 字节 `[PLAN]` 文件提议。审批该**具体**工具命令后，Claude 的真实工具输出返回 `status=candidate_observed`，候选 ID `0343f639-4d4b-4558-98e3-4bbea5e9b8d7`，观察 Pane `w2:p1`、正确 Terminal ID、`source_verification=unverified`、`commit_ready=false`。
- 公开 CLI `host candidates` 读到同 ID 新候选，租约和绑定代次与本次会话匹配，正文 SHA-256 为 `510cdba881ebc2939b1316e64b961b325deea8c33e66e9d21aad511be87e8700`。旧历史候选仍在，不被覆盖。没有 `confirm-candidate`、`commit` 或轮次交接。
- 显式 `host release` 成功；命名测试会话已停止。最终快照为 `host_state=unclaimed`、`turn=ralph`、generation 0、`last_receipt_id=null`。

## 结论与边界

本次真实 Herdr Agent Pane 的正向候选提议已通过。隔离测试同时覆盖 `blocked → blocked → working` 时继续，以及持续 `blocked` 时拒绝；现场成功只证明此调用观察到了合法席位和一次 `working` 状态，**不能证明文件写入者**。人工审阅与正式提交门禁仍保持原样；真实双席重启恢复、真人确认后的 `review` Pane 提交和 Lisa 交接仍待另行验收。
