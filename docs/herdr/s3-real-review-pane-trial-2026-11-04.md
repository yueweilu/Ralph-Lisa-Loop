# S3 真实 Herdr 候选审阅窗格试验

日期：2026-11-04。使用 Herdr 0.9.4、独立 XDG 配置/状态目录、命名测试会话和一次性 `init --minimal` 项目；默认 Herdr 会话与已有项目未参与。

## 运行过程与证据

1. 在隔离服务中链接当前插件，`doctor` 的**完成日志**返回 `ready`，公开 CLI 宿主契约、Claude/Codex Herdr 集成和两个 CLI 登录状态均通过。`start` 自动建立 `w2:p1` Claude/Ralph 与 `w2:p2` Codex/Lisa，RLL 快照为 `turn=ralph`、`generation=0`、`binding_state=bound`。
2. 真实 Claude 在 Ralph Pane 中读取一次性任务并写出 732 字节的 `[PLAN]` 候选文件。它调用 `candidate-propose.mjs` 时返回 `CALLER_AGENT_MISMATCH`；现场 `agent explain` 报 `working`，`agent get` 仍报 `blocked`。辅助命令因此**没有**写候选或自动确认。该状态分歧需要单独调查，不能把失败记为来源已核验。
3. 为单独验收审阅界面，操作者使用公开 CLI `host propose` 将上述文件保存为 `source_verification=unverified` 候选。候选 ID `0d6513c4-4e29-473c-a3ac-cfe33243a3cf`，正文 SHA-256 `510cdba881ebc2939b1316e64b961b325deea8c33e66e9d21aad511be87e8700`，记录中的预期席位为 `w2:p1`。这一步不声称 CLI 能证明写入者。
4. 真实 Herdr `review` Pane `w2:p3` 成功打开，显示候选列表；选择候选后，Pane 按行展示完整正文、RLL 会话/租约、轮次、代次、Workspace/Pane/Agent、SHA-256，以及 `Policy: pass`、`Gate: not_enabled`。预检生成请求 ID `d9f18f47-cdf2-467a-a662-b4337fd68222`，随后等待明确的 `COMMIT <candidate-id> <full-sha256>` 输入。
5. 在确认提示处按 Enter 取消。CLI `host receipt` 对该请求返回 `unknown`；RLL 快照仍为 Ralph 第 1 轮、generation 0、`last_receipt_id=null`，候选数为 1。`stop` 的完成日志返回 `stopped`，最终宿主状态为 `unclaimed`、绑定为 `stale`。命名 Herdr 测试会话已停止。

## 验收边界

这次通过了**运行中 Herdr Pane 的候选显示、只读预检和取消不提交**。未执行 `host confirm-candidate` 或 `host commit`，也未产生 Lisa 交接；真人来源确认、真实提交正向路径和 TUI 客户端目视截图仍未验收。自动化测试中的确认输入不替代真人操作。下一切片先调查 `agent get` 与 `agent explain` 的状态分歧，保持“未观察到 `working` 则不提议”的安全门禁；不得为了通过试验而把 `blocked` 当成 Agent 正在工作。
