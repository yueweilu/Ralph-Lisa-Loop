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

剩余验收：在 Claude 可正常调用时，使用新的隔离项目创建任务事件并确认投递、游标为 1；仅让协调器进程异常退出而保留租约，再重启命名 Server，核对旧 PID、原生会话、任务回执与投递链；经单独人工确认后执行租约回收、重绑与接续，验证 generation 1 和投递计数不变。任何结果不明均先只读核查，不重复投递或提交候选。
