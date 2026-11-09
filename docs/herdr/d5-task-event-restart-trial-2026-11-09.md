# D5 任务事件后的 Herdr 停机与异常退出试验

日期：2026-11-09。代码基线 `06d62918ff8cf33b1f9d6c799900e249d3d1b970`，Herdr 0.9.4，插件本地链接版本 0.1.6，CLI 0.3.13。所有试验使用独立 `XDG_CONFIG_HOME`、`XDG_STATE_HOME` 和命名 Server；没有操作默认 Herdr 会话或 `super-rll`。用户分别授权了每个新临时目录的 Claude 信任提示和本轮必要的临时项目读写；没有候选来源确认或正式候选提交。

## 任务事件与正常停机

隔离根 `/private/tmp/htr-g6KqUq` 的项目 `project` 中，Ralph Pane 接收新的 README 任务，调用 `task-update-request.mjs`。正式回执 `0eccb619-84d2-4815-a9c4-2945debf4d62` 把任务版本 1→2、generation 0→1；`source_verification=unverified`。插件保存一份 `accepted` 的任务更新投递，游标为 1，Ralph Pane 收到新任务提示。`herdr session stop rll-htr-g6kquq` 正常关闭 Server 后，协调器以 `managed_pane_closed` 结束并释放租约；最终快照 `host_state=unclaimed`、generation 1、候选数 0，已接受投递文件仍在。`host recovery-check` 返回 `HOST_NOT_CLAIMED`，因此没有可执行的重绑接续路径。

同一个命名 Server 重新启动时，先前项目的 Ralph Agent 名称仍恢复在旧 Workspace。直接为另一个临时项目启动新会话返回 `AGENT_IDENTITY_MISMATCH`，没有领取新项目租约。只在确认旧项目已释放租约后关闭这次试验创建的旧 Workspace；没有操作默认会话。这个结果说明连续试验前需要清理命名会话中残留的 Agent 名称，不能把新会话启动失败误记为任务更新失败。

## 命名 Server 异常终止

在同一隔离根的新项目 `project-crash2` 中，Ralph 发起任务更新请求 `b554db42-01f9-4f48-a63d-fb109771de4e`。正式回执把任务版本 1→2、generation 0→1；插件游标为 1、活动记录含 Ralph 原生会话指纹；一份 `delivery-b554db42-01f9-4f48-a63d-fb109771de4e.json` 的状态为 `accepted`，Ralph Pane 收到提示。没有候选提交或交接。

随后只对这个命名测试 Server 的 socket 所属 PID `47662` 执行 `SIGKILL`。Server 退出后，协调器记录 `stop_reason=managed_pane_closed`、`phase=released` 并释放租约；最终快照仍为 generation 1、`host_state=unclaimed`、`binding_state=stale`。`host recovery-check` 同样返回 `HOST_NOT_CLAIMED`。一次短时进程检查发现旧协调器 PID `50774` 在记录已释放后仍存活；确认无活动租约后向该 PID 发送 `SIGTERM`，随后确认进程退出。此观察尚不足以判定长期进程泄漏或原因。

两种 Server 停止方式都保留了任务回执与一次投递，且没有出现重复投递；也都未生成待重绑租约，所以**没有验证任务事件后的非零游标重绑接续**。仅杀掉 Server 不能稳定制造所需的待恢复状态，因为托管 Pane 关闭会触发协调器的安全释放逻辑。

## 后续尝试与阻断

为了单独模拟协调器异常退出，另建 `/private/tmp/htr2-IO2Ro4/project` 和命名 Server `rll-htr2-io2ro4`。首次启动在信任提示后返回 `AGENT_NOT_READY`，宿主仍为未领取；在核对 Ralph、Lisa 均处于原 Pane 且项目未变化后，用同一启动请求走插件的 preclaim retry，成功建立 generation 0 的双席和初始投递。随后初始指令和聊天任务切换都在 Claude Pane 收到 `API Error: 402 Insufficient Balance`，Ralph 未写任务更新请求，故不能进入目标试验。插件 `stop` 动作成功、宿主回到 `unclaimed`，命名 Server 已停止。此结果不证明任务事件后的异常接续。

以上为首次试验的剩余验收项；同日的续验结果见下节。任何结果不明均先只读核查，不重复投递或提交候选。

## Claude 集成修复与任务事件后异常接续

在新的隔离根 `/private/tmp/htr4-Paoxa5`、本地链接插件 0.1.6 和代码基线 `3585d96639735fad00c889195ebfb48623c8ac86` 上，首先用 `project` 复现聊天切换任务：正式回执把 generation 0→1，只有一份任务更新 `accepted` 投递、候选数 0。但两席未返回原生会话引用，Ralph 绑定记录没有指纹，不满足后续重绑条件。现场检查发现 Claude 的 Herdr hook 脚本虽存在，`~/.claude/settings.json` 却没有 `SessionStart` 注册。正常停止该项目和命名 Server 后重新运行 `herdr integration install claude`；修复前后对比确认模型、API 环境和权限配置未变化。没有修改默认 Herdr 会话。

在全新的 `project2` 与命名 Server `rll-htr4b-paoxa5` 中，用户仅对该目录确认 Claude 信任。Ralph/Claude 与 Lisa/Codex 均有 Herdr 原生会话引用；Ralph 初始绑定记录有引用指纹。Ralph 聊天要求切换任务，CLI 的 `task_updated` 回执 `3587f53c-21fa-4e86-98a1-03e50d104b51` 将任务版本 1→2、generation 0→1。协调器只保存一份新任务 `accepted` 投递，Ralph Pane 收到提示；候选数始终为 0。任务切换结束了原先的自动候选授权，后续候选仍须单独确认来源。

确认 PID `1980` 为本次 `node coordinator.mjs start` 后，仅对它执行 `SIGKILL`，不杀 Herdr Server。旧 PID 消失而宿主租约仍为 `claimed`、generation 为 1。随后正常停止并重新启动该命名 Server：旧 Ralph/Lisa 进程均退出，新终端 ID 与旧绑定不同，两席恢复的原生会话指纹均与记录匹配。只读 `recovery-check` 看到一份初始提示和一份任务更新投递、均为 `accepted`，游标与回执一致；用户按证据摘要单独确认后，`recover-lease` 返回 `recovered`、`not_replayed`。

首次 `rebind-check` 返回 `PLUGIN_RECORD_INVALID`。根因是异常终止留下的协调器记录仍为 `active`，原校验只接受 `needs_reconcile` 或有精确暂停证据的 `paused`。修复允许 `active` 进入预检的条件是记录游标与当前 generation、最后回执和轮次一致；后续原有检查仍要求旧 PID 不在、租约回收证明、完整且已接受的投递链、当前席位与已提示 Agent 的原生指纹一致、前后快照无变化。`coordinator rebind` 的二次校验同步接受经该预检确认的 `active`。模拟 `SIGKILL` 回归同时验证游标不一致时明确拒绝。

修复后只读 `rebind-check` 无阻断；用户对证据 SHA-256 `5a586991a48126734286c30f169782497baff262a83ec0d9004c8bb2fe18b7d5` 单独确认。一次显式重绑建立替代租约 `fd29fdae-f899-4edb-a5c5-376e6917dc71`，进入 `rebound_paused`，generation 仍为 1，未重发提示。只读 `continuation-check` 确认两席指纹和游标匹配、阻断项为空；用户对证据 SHA-256 `36d5c45bc01e5f9d6662eaeae9c4712eb13a4051ec841d65f68c6f6d1930bb32` 单独确认。`CONTINUE` 返回 `continued`、`not_replayed`；新协调器为 `active`，租约心跳序号从 9 增至 14，投递链仍只有原初始提示与新任务提示各一份。最终插件 `stop` 成功，宿主为 `unclaimed`、generation 1、候选数 0；命名 Server 已停止，隔离目录保留审计证据。

本地聚焦崩溃回归和 `integrations/herdr/*.test.mjs` 全套均通过。本轮证明的是一次真实任务事件后、协调器异常退出及 Server 重启的显式恢复与无重放接续；没有验证后续候选交接、长时间运行或系统断电。没有正式提交候选，也没有操作默认 Herdr 会话或 `super-rll`。
