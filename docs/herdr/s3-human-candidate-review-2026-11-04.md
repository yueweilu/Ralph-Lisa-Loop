# S3 人工候选审阅入口

**对应基线：** [公开 CLI 宿主契约](public-cli-s1-host-contract-implementation-2026-10-29.md)中“后续插件必须展示候选正文与这些 ID，并由真实用户操作后调用确认”。

Herdr 插件新增独立 `review` Pane。它从插件 `status` 定位当前项目，通过公开 CLI 的 `host candidates` 和 `host candidate-show` 读取不可变候选记录，不直接解析 `.dual-agent/host/candidates` 文件。选择一个候选后，Pane 展示完整正文、会话/租约、轮次/代次、Workspace/Pane/Agent 目标和正文 SHA-256，再用新请求 ID 调用 `host commit-check`。只有预检允许且用户键入 `COMMIT <candidate-id> <完整 SHA-256>`，才先调用 `host confirm-candidate`，再调用 `host commit`。提交仍执行 RLL 原有 policy 和测试门禁；拒绝和结果不明均停止，不自动重试。结果不明时按已展示的请求 ID 查询 `host receipt`。

候选来源继续标为 `unverified`；人工声明仅表示用户核对了显示的正文和身份，**不证明文件由绑定 Agent 写入**。Plugin Pane 的交互测试用预设输入模拟人工操作，不能代替真实 Herdr 目视审阅验收。

验证范围：CLI 构建及 490 项回归通过；`host-candidate` 测试证明读取持久化原文、摘要篡改冻结和业务状态不变；Pane 测试覆盖取消、确认后正式提交、篡改候选在提示前停止。真实 Herdr Pane 操作和无人工来源归因另行验证。
