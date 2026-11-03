# S3.3 插件自动创建 Herdr 双席实测

日期：2026-11-03。范围：从已初始化的临时 RLL 项目，由 Herdr 插件 `start` 自动创建 Workspace/Pane 并启动 Claude/Codex；未进行任务投递或提交回执驱动的交接。

## 实现

`start` 先读取项目快照和席位预检，再写独占意图。两席都已在当前 Workspace 就绪时沿用 S3.2 接管路径；两席都不存在时，创建专用 Workspace、拆成两个 Pane，依次启动名为 `ralph` 的 Claude 与名为 `lisa` 的 Codex。只有 Herdr 返回的 Agent、Pane、Workspace ID、项目路径和就绪状态再次通过预检后，才领取 RLL 租约、绑定两席和开始心跳。已存在部分席位或身份不匹配时拒绝创建。

Agent 启动遇到阻塞时，日志输出 `needs_input`、角色和 Pane ID；协调器等待最多两分钟，由用户处理界面提示。它不自动确认信任、权限、登录或升级。启动过程异常时保留插件记录供核对，不自动抢占租约或重放。

## 隔离 Herdr 0.9.4 验证

插件从项目 Workspace 调用 `start` 后创建了专用 `w2`，Claude 和 Codex 分别落在 `w2:p1`、`w2:p2`。Claude 对新建临时目录显示信任提示，Codex 显示版本更新提示；两处都由测试者查看后处理。`start` 日志先输出两条 `needs_input`，然后输出 `started`。RLL 快照显示 `host_state=claimed`、`binding_state=bound`、`binding_generation=2`，两席 Pane 与 Herdr 返回值一致。`stop` 与 `start` 的最终 Herdr 日志均为 `succeeded`，释放后 RLL 快照为 `host_state=unclaimed`、`binding_state=stale`，业务摘要未变化，两个 Agent 仍在 Herdr 中。

首次运行时，Herdr 在未找到 Agent 的情况下把 JSON 错误写入 stderr；协调器只解析 stdout，因而提前失败。修正为解析 stdout 或 stderr 后，在同一隔离服务中重新运行成功。首次失败发生在创建 Workspace 和领取租约之前，其记录在确认无 Herdr Agent、无新 Workspace、无 RLL 租约后归档。

自动化测试使用真实公开 RLL CLI 与替身 Herdr，覆盖已有双席接管、双席自动创建、Codex 启动阻塞后的等待、租约绑定和释放。它不代表真实 Ralph → Lisa → Ralph 交接已完成。

## 后续

下一步是 S3.4：建立代次基线，核对受控提交回执，再向正确席位持久化并只投递一次交接消息。候选来源仍为 `unverified`，人工确认门禁不能省略。部分启动后的取消/恢复、Herdr 服务重启后的同会话恢复属于 S4；本机 Claude/Codex 集成已安装，但该恢复验收尚未通过。
