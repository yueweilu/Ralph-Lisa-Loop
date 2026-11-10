# A09：全局插件启动与状态显示复验

日期：2026-11-10。固定安装提交 `0298413b29539c799f2b27986339f1405c3e3f7f`，插件 0.1.7、Herdr 0.9.4。测试项目为 `/private/tmp/rll-codex-retest-TXe1pk/project`；使用本机默认 Herdr Server 的新工作区 `wG`。未操作其他工作区或 `super-rll`。

## 操作与现场结果

运行 `herdr-rll --project /private/tmp/rll-codex-retest-TXe1pk/project --full-auto 'Plan a README containing exactly the sentence "Codex startup retest."'`。初次沙箱内调用返回 `HERDR_COMMAND_FAILED`，在获准的本机环境重试后命令返回 `needs_input / AGENT_BLOCKED`，退出码 3，指出 Ralph Pane `wG:p1`。随后同一会话的协调器记录 `initial_prompted`、`started`，启动回执文件最终为 `started`。没有再次执行启动命令。

Ralph/Claude 与 Lisa/Codex 均在 Herdr 中取得原生会话引用。Lisa/Codex 显示可交互界面，没有复现上一次 `account/read failed during TUI bootstrap`。Ralph 候选自动提交至 generation 1 并交给 Lisa；Lisa 的 `[NEEDS_WORK]` 自动提交至 generation 2 并交回 Ralph；修订与后续评审继续推进。插件完成记录 `phase=completed`、`cursor_generation=6`、`initial_status=accepted`、`auto_commit=true`，完成时间 `2026-11-10T08:48:52.516Z`。本任务仅要求规划 README，测试不代表已创建 README。

## 发现的状态显示问题

1. 启动命令返回 `AGENT_BLOCKED` 时，协调器后来仍完成初始投递并启动。这个退出结果不能稳定表达这次启动的最终状态。
2. 完成记录存在且宿主租约已释放后，`herdr-rll status --project ...` 返回 `needs_review`，同时显示 `host_state=unclaimed`、`binding_state=stale`、generation 6。正常完成被呈现为需要人工复核。

这些是入口与状态查询的反馈缺陷；本次自动轮次和最终完成由协调器回执单独证明。候选来源仍是 `unverified`，本次 `--full-auto` 使用会话级自动提交授权，不表示独立作者证明。

## 后续修复验证

复验记录先以独立提交 `00b7769` 推送。随后改动 CLI：仅将协调器的持久启动回执视为确定结果；等待超时而 Herdr 仍观察到 blocked 时返回 `pending / AGENT_BLOCKED_UNCONFIRMED` 和席位位置，不报告确定的启动失败。状态查询只在插件已归档 `completed`，且归档的项目、会话、请求、工作区、最终游标、摘要与释放后的宿主快照一致时返回 `completed`。插件版本提升至 0.1.8。

修复后定向回归 8/8 通过，CLI 构建与发布包校验通过；新 CLI 对本次真实项目的只读状态查询返回 `completed`、generation 6。尚未用 0.1.8 安装包重新启动一轮真实双席，因此新启动等待逻辑目前由回归测试覆盖，不把既有 0.1.7 现场结果算成 0.1.8 的真实启动验收。
