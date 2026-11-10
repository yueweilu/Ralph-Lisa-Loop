# A03 / A08：真实双席自动交接与暂停输入验收

日期：2026-11-10。固定 GitHub 安装提交 `d0e6b085019d5e346444b4542583edd07a0ca8e2`，Herdr 0.9.4，RLL CLI 0.3.13。对应[一条命令启动与自动协作实施方案](herdr-auto-task-launch-implementation-2026-11-06.md)的 A03、A08。仅在 `/private/tmp/rta-erlVde/project`、独立 XDG 配置和命名 Server `rll-rta-erlvde` 验证；未操作默认 Herdr 会话或 `super-rll`。

## 入口和隔离

从固定提交的托管 checkout 调用 `herdr-rll --full-auto --project <临时项目> <README 任务>`。任务要求 Ralph 收到直接聊天消息 `GO` 后才提议候选。插件 `doctor=ready`；启动时 Claude 对该目录提出信任提示，用户只授权这个临时目录后确认。Herdr 两席均取得原生会话引用；RLL 宿主记录仍将候选来源标记为 `unverified`，不把 Herdr 观察说成作者证明。当前会话的自动授权记录限定项目、RLL session、租约、绑定代次和两席，`granted_via=cli_auto_host_herdr`、`permission_profile=full_auto`。

## A08：暂停期间的直接输入

会话 `0fc2e87f-7604-420a-96ff-88b12b70a79b` 在 generation 0 暂停，`pause` 动作返回 `paused`。暂停期间通过 Ralph Pane 直接发送 `GO`，Ralph 最初仍在处理上一段输出，消息先排队；后来 Ralph 收到消息，并提议候选 `cc3a2841-40a8-4a58-8150-55b297bc0792`，摘要 `bb46102561dc82bbad8fc9ce3ae2bf9f894fc88b115c8ebdae62d5bd6aa6d503`。暂停态只读快照仍为 `turn=ralph`、generation 0、候选数 1、无正式提交回执、无 Lisa 投递。恢复前单独读取插件 `status` 与宿主快照，确认暂停态和游标；`resume` 返回 `active`。这说明协调器暂停时没有抢走该候选或推进轮次。直接聊天消息的处理时间仍受 Agent 当前工作影响，本次曾用 Esc 中断长思考后让 Ralph 继续；不能据此宣称消息即时生效。

## A03：恢复后自动双向交接

| 阶段 | 现场回执 |
|---|---|
| Ralph → Lisa | Ralph 候选正式提交回执 `638a565e-9f7c-5e7d-9bc2-e8da5dab5144`，generation 0→1、`turn=lisa`；Lisa 投递意图同 ID，状态 `accepted`，仅一份。 |
| Lisa 评审 | Lisa/Codex 实际读取计划、指出测试命令的换行字节错误，提议 `[NEEDS_WORK]` 候选 `69a45492-4815-4609-984c-5959fe3ffe8b`，摘要 `71ab3da4f87790acc66e4e75a7e1d3b4dbf84ddf4b7328b9c66e77de788f518f`。 |
| Lisa → Ralph | Lisa 候选正式提交回执 `c1d4bf6a-bf37-5255-a6bb-9e834e664e25`，generation 1→2、`turn=ralph`、`round=2`；Ralph 投递意图同 ID，状态 `accepted`，仅一份。Ralph Pane 随后读取状态和计划，开始核对 Lisa 指出的字节问题。 |

两份正式回执均为 `source_confirmation=session_authorized_auto`、`source_verification=unverified`，策略 `pass`，测试门禁 `not_enabled`；本轮没有逐份人工来源确认。短暂 `HOST_BUSY` 发生在并发只读快照时；随后回读到确定的正式回执和连续游标，没有因未知结果再次提交。一次并行调用中，`seat-preflight` 对已领取的宿主返回 `HOST_ALREADY_CLAIMED`，这不是正在运行会话的健康检查。

## 结论与边界

A03 的“合格候选自动提交、Ralph→Lisa→Ralph 各一次交接和 Ralph 下一轮开始”在本次真实双席会话通过。A08 的“暂停后可在原 Pane 直接输入、暂停期间不自动消费候选、核对后恢复”通过；目录信任仍需用户针对该目录单独确认。本次在 Ralph 第 2 轮中止测试，**未验证 README 最终实现、最终共识、长时间稳定运行或重启后的自动授权接续**。这也不是候选作者的独立身份认证。

收尾时插件 `stop` 返回 `stopped`；宿主只读快照为 `unclaimed`、generation 2、绑定 `stale`、候选数 2。命名 Server 已停止，默认环境未操作；临时目录在记录完成后清理。本次未修改产品代码。
