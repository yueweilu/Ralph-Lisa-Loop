# S3.4 提交回执驱动的双席交接

**日期：** 2026-11-04

**分支：** `feat/herdr-s3-receipt-handoff`

**状态：** 代码与隔离契约测试已完成；真实 Herdr 双 Agent 完整交接仍待运行验收。

## 本次实现

1. 双席绑定后用 `host prepare-generation` 建立第 0 代；已有更高代次的会话不由新协调器直接接管。
2. 每秒重取 RLL `host snapshot`。只有代次恰好增加 1、`last_receipt_id` 可由 `host receipt` 查询为 `committed`，且项目、会话、租约、绑定代次、原席位、目标轮次、摘要均一致时，才投递给对席。Herdr 的 `idle/done` 只用来判断目标能否接收，不决定业务提交成功。
3. 投递前写入 `delivery-<request-id>.json` 意图并同步到磁盘；Herdr 接受后记为 `accepted`，推进本地游标。轮询同一回执不会重发。投递返回错误或超时时保留意图与 `needs_reconcile`，禁止自动补发。
4. `stop` 在存在尚未交接的回执时拒绝释放租约；正常停止保留投递记录，Agent 继续运行。

## 已验证

- 隔离临时项目使用**真实公开 CLI**完成 Ralph 的 `propose → commit-check → confirm-candidate → commit`，协调器向伪 Herdr 的 Lisa 席位投递一次；Lisa 提交 `[NEEDS_WORK]` 后向 Ralph 投递一次。两次消息含各自正式回执 ID，重复轮询无额外投递。
- 伪 Herdr 在收到 prompt 后返回超时：磁盘只保留一份 `intent`，协调器转 `needs_reconcile`，不自动重试，也不把租约当作正常停止来释放。
- 原有双席自动启动、阻塞提示等待、租约心跳与停止路径仍在同一集成测试中通过。

验证结果：`cli/npm run build` 通过；`cli/npm test` 为 **488/488**；`node --test integrations/herdr/actions.test.mjs integrations/herdr/coordinator.test.mjs` 为 **10/10**。远端 CI 结果在推送后另行核对。

## 当前边界与下一步

这次验证的 Herdr 命令由伪实现接收；尚不能声称真实 Claude/Codex 已收到或执行提示。公开 CLI 仍将候选来源标为 `unverified`，每次 `host commit` 前必须由人执行来源审阅确认；协调器不代签确认，不从 Agent 屏幕文本推断提交。要达到会议所需的无人逐轮操作，还需设计可核验的 Agent 来源与受控提交路径，再做真实 Herdr 样板项目验收。暂停、人工接管和重启恢复属于 S4。
