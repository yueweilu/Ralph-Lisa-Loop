# D5 Ralph 聊天改任务：隔离真实 Herdr 验收

日期：2026-11-09。测试使用 Herdr 0.9.4、本仓 CLI 0.3.13 和本地链接的插件 0.1.5。代码起点为 `c33f7f3`；本记录中的适配器与协调器时序修复在现场发现后先通过本地测试，再用于重启后的隔离会话，最终提交号以 Git 历史为准。隔离根目录 `/private/tmp/ht-zc4BdQ` 使用独立的 `XDG_CONFIG_HOME`、`XDG_STATE_HOME`、命名 Server `rll-ht-zc4bdq` 和项目 `project`。插件列表初始为空，`doctor=ready`。没有操作默认 Herdr 会话或 `super-rll`。

## 首次现场阻断与处理

用户仅对此项目确认了 Claude 目录信任，并允许本轮临时状态文件的只读检查。`herdr-rll --project ...` 以默认交互权限启动，双席建立；Ralph 初始提示已被接受，但 Claude 为只读工具多次请求执行许可。启动结果为 `needs_input/AGENT_BLOCKED`，人工完成被授权的只读许可后，宿主仍为 generation 0。

从同一 Ralph/Claude 聊天 Pane 输入“切换为创建单句 README”后，Ralph 写出请求文件。首次调用 `task-update-request.mjs` 返回 `CALLER_AGENT_MISMATCH`；适配器此前只接受 Herdr 的 `working` 状态。修复限定为：`blocked` 仅在当前 Pane、终端、项目、Ralph/Claude 身份、交互就绪及有效原生 Claude 会话均匹配时接受；`idle` 和错误席位仍拒绝。按相同请求 ID 重试后，Ralph Pane 返回 `task_update_requested`。

初始指引在配置使用 `node <本仓 CLI>` 时只说“使用已配置的 CLI”，Ralph 因而反复查找入口。指引现在识别本仓 CLI 的 `node` 启动形式并给出完整命令路径；自定义外部 CLI 仍只显示通用提示，不把未知路径写入 Agent 提示。

协调器随后以 `AGENT_NOT_READY` 退出，未写任务事件。现场只读证据：原请求 `ac34dbc9-c937-4c7d-9fbc-fee6341e4722` 的 `host receipt=unknown`，快照仍为 generation 0、候选数 0；插件记录为 `needs_reconcile`，无该请求的投递文件。协调器现在在 Ralph 仍完成聊天轮次时等待其空闲，不把暂时未就绪当成不可恢复故障；模拟 Herdr 的回归验证了等待期间不提交、空闲后只提交一次。

为保留失败证据，用 `abandon-uncommitted-task-request ... 0 reviewed-no-commit` 只在回执未知、无写入意图、快照和插件游标都未变化且没有投递文件时，将旧请求移入 `task-update-requests-abandoned`。确认命名 Server 停止后，`recovery-check` 给出可复核证据，显式回收旧租约，未重放提示。重启同一命名 Server 后，Ralph 原生会话恢复；Lisa 使用 `codex --no-daemon` 并经一次就绪提示取得原生引用。经用户分别确认重绑和接续的证据摘要，替代租约重绑到两席并在 generation 0 接续，旧初始提示没有重发。

## 聊天任务事件与双向交接

Ralph 在同一聊天 Pane 再次收到明确的新任务，使用新请求 ID `e1d00f28-c354-4d7e-b928-2acca49033f6` 调用适配器。正式任务事件回执为 `task_updated`：`mode=switch`、任务版本 1→2、generation 0→1、`turn=ralph`、`round=1`、`step=planning`。`task.md` 含新任务，插件仅保存一份该事件的 `accepted` Ralph 投递；游标到 1，请求进入归档队列，旧自动候选授权结束。请求与回执仍标记 `source_verification=unverified`。

| 事件 | 正式结果 | 插件投递 |
|---|---|---|
| Ralph 新任务计划候选 `76481a76-cb89-4ca8-a73d-c2d3becf9be3` | 用户对精确正文及 SHA-256 `48d92d9c303f83d526950e51abdce884e559c9e750d7e3d419860cf593400c67` 单独确认来源；回执 `2ea220d3-bea1-400e-91c5-c3ef4a31726e` 为 `human_asserted`、generation 1→2 | 一份 `accepted` Ralph→Lisa，Lisa/Codex Pane 收到并评审新任务 |
| Lisa `[NEEDS_WORK]` 候选 `561ce706-42ec-46fd-8386-90ed872480ff` | 指出 `$(cat README.md)` 会吞掉末尾换行，不能验证字节精确；用户对精确正文及 SHA-256 `d76f2b8de9c728b60baa5282bf689d270417452f3415d5b9e5426be349bd804f` 单独确认来源；回执 `dd828942-14c4-44d6-8aec-54d49fe2592c` 为 `human_asserted`、generation 2→3 | 一份 `accepted` Lisa→Ralph，Ralph Pane 收到评审并读取新任务 |

两份候选均通过格式与策略预检，测试门禁为 `not_enabled`。人工确认只是用户接受候选来自对应 Pane 的说明；CLI 无独立作者证明，正式回执保留 `source_verification=unverified`。没有代写候选、跳过门禁或重复正式提交。

## 收尾与边界

插件 `stop` 动作成功，最终 `host_state=unclaimed`、generation 3、`turn=ralph`、round 2；命名 Server 已停止。隔离目录保留用于审计。README 只停在计划和评审阶段，尚未完成文件创建或后续共识；本次证明的是聊天改任务及其双向交接，不是整个新任务完成。任务事件发生后的再次 Server 重启、非零游标接续、写中故障注入及长期运行仍未验收。原 tmux `update-task` 未修改。

本地 `integrations/herdr/*.test.mjs` 全套与 CLI 宿主测试通过；提交后应以对应 GitHub CI 的 Node 18/20/22 结果确认远端构建，不把本地结果写成远端通过。
