# P5 固定 GitHub 安装版：任务切换、双重启与 tmux 回归

日期：2026-11-10。基线：`feat/herdr-auto-task-launch` 的 `586eb08f35d4bcbedf9c300153b8231246bb60a7`。按 [实施方案](herdr-auto-task-launch-implementation-2026-11-06.md) 的 A06、A07、A08、A09、A10 逐项记录。本次没有修改产品代码；以下区分真实 Herdr 会话、带假 Agent 的真实 tmux，以及本地测试。

## 1. 隔离与安装

- Herdr 0.9.4；从 GitHub 指定上述完整 SHA 安装 `ralph-lisa.loop` 0.1.6。隔离注册的 `requested_ref`、`resolved_commit` 和托管 checkout HEAD 一致；同仓 CLI 已构建。真实插件 `doctor=ready`。
- Herdr 会话名 `rll-hd6-jqptzk`；项目 `/private/tmp/hd6-JqpTZK/project`；配置、状态、npm 缓存在 `/private/tmp/hd6-JqpTZK` 下。插件设置只指向此项目，`settings.json` 的 SHA-256 为 `d063377a207792ea7bb8085e7849127b0889cf45e0fad77fe89affa95c8c46fd`。
- 用户仅对该临时项目批准 Claude 的目录信任。默认 Herdr 会话、`super-rll` 未操作。

## 2. A07：Ralph 聊天切换任务

以安装 checkout 的 `herdr-rll --full-auto` 启动初始任务，初始投递只有一份 `accepted`。在 Ralph Pane 中直接提出切换任务：创建 `README.md`，内容恰好为 `GitHub installed continuation verified.` 再加一个换行。Ralph 通过受控 `task-update-request` 登记；正式任务事件回执 `f1fd4aa5-50ea-49c1-9358-23d121e88f8e`，任务版本 1→2，generation 0→1，一份新的 Ralph 投递被接受。旧任务下无候选提交。

切换任务撤销了启动时的会话自动提交授权。后续每份候选均停在 `awaiting_source_confirmation`，经用户分别审阅正文和摘要后才各正式提交一次；回执仍标记 `source_verification=unverified`。这符合任务切换后的门禁，不能把本次双向交接描述成无人值守的 A03 验收。

## 3. A06/A10：两次非零游标重启及双向交接

| 阶段 | 现场证据与结果 |
|---|---|
| 首次 Server 重启，generation 1 | 旧协调器 PID `55460` 与旧 Agent 进程退出；Ralph/Claude 恢复同一原生会话。Lisa 在首次正式交接前尚无原生引用。只读 `recovery-check` 后，用户按证据 `3d0ff99a4a73ee796921c4a6332ff73b7551181c791df3c378940dcb213bf35f` 允许回收旧租约；回收 ID `5ad914d5-1b1f-47b4-b1da-3e2e319f06d9`。按 `16417395b2cdbca9ff56f9e2a9c2a16288506a3b5551bd35e00eb1f6e166b42c` 重绑，按 `0df9635da4b72eafe686a6ad3f3cdd7dd162e2471d126e4cda0c261b2bc38774` 接续；generation 保持 1，`replay=not_replayed`。 |
| Ralph→Lisa | Ralph Pane 提议 `[PLAN]` 候选 `3d955b08-7595-41b7-874e-e90541b365fe`，SHA-256 `84ce19a203b0636310ce09fcedaf72f682a06b23d94fa5413995ce1a5b625c1c`。策略 `pass`、测试门禁 `not_enabled`；用户单独确认来源。请求 `e71b7819-ecd1-4c8b-8bc4-8261085b9702` 只正式提交一次，generation 1→2。Herdr 对 Lisa 保存一份 `accepted` 交接，Lisa Pane 实际收到并开始评审，之后获得 Codex 原生会话引用。 |
| 第二次 Server 重启，generation 2 | Lisa 先在旧租约提出 `[PASS]` 候选但未提交。见下文中断说明。Server 重启后两席原生指纹均与记录匹配；三份既有投递各一份 `accepted`。用户按证据 `497708286bb9e0bc3908309292d1a4f6ef1dbc43050522a775d49bcf7a54dd27` 回收旧租约，回收 ID `75b07fae-d549-46e6-a772-d57c47f5a6f6`；按 `7abe4a2200fd3f928717bfd956429954a551a9483df8d635c74fe6f4643571db` 重绑，按 `a076f73b4eb5d5bbda1fa3a9eb6fed0866b81c987a7ce2766fbecaf8f1896ed2` 接续。新租约 `4ee290bf-037e-494d-938b-fe35b6de5d33`、绑定代次 6，generation 仍为 2，`replay=not_replayed`。 |
| Lisa→Ralph | 旧 Lisa 候选绑定已回收租约，未跨租约提交。恢复后的同一 Lisa 原生会话重新提议相同正文的新候选 `757c72b4-33c9-4376-ab39-4ccaad5fb432`，SHA-256 `fe36105c2df122b875b2e8dccc79123d9099cc64eaad814caa3478be992a10da`。用户单独确认来源；请求 `57ca951f-b417-48d1-b9d7-67c05111ce8d` 只正式提交一次，generation 2→3、轮到 Ralph 第 2 轮。Herdr 对 Ralph 保存一份 `accepted` 交接，Ralph Pane 开始处理。 |

**第二次重启的限制：**Lisa 在旧候选来源确认提示上等待时，测试操作中断了该 Codex Pane，协调器因此以 `AGENT_CHANGED` 进入 `needs_reconcile`，旧 PID 随后退出。Lisa 在同一 Pane 用 `codex resume <同一原生会话>` 恢复；启动后 Herdr 暂未报告原生引用，一条明确禁止提议和提交的诊断提示使官方 hook 报告了相同引用。随后才停止并重启命名 Server。因而本次证明了在这些显式恢复步骤之后，非零游标和双席指纹可接续；它不是一条完全无额外诊断提示的平滑重启链，也没有证明 Codex resume 在空闲时一定自动报告引用。

**重绑操作页更正：**第二次的 Herdr `rebind` Pane 打开后立即消失，是本次调用额外传入 `--cwd <项目目录>`，覆盖了插件脚本的工作目录；插件清单使用相对命令 `node rebind.mjs`，该项目目录没有脚本。[独立最小探针](p5-pane-and-codex-resume-diagnostic-2026-11-10.md)已复现：带 `--cwd` 子进程以退出码 1 结束，去掉后交互 Pane 正常保持运行。前次只读 `rebind-check` 重新算出同一证据后，使用固定 checkout 的 `coordinator.mjs rebind` 完成重绑，`continue` 同理。此处不构成已证实的插件源码缺陷；完整重绑操作页仍未在有效恢复现场重新验收。

## 4. A08：权限阻塞与暂停

Lisa→Ralph 后，Claude 对只读 `host snapshot` 显示权限提示，Herdr 将 Ralph 状态标记为 `blocked`；此时 generation=3、candidate_count=3，未自行提交下一候选。插件 `pause` 返回 `paused`，记录固定 generation=3、最后回执与状态摘要；权限提示仍在，游标不前进。随后插件 `stop` 返回 `stopped`，宿主为 `unclaimed`、generation=3，协调器 PID 消失，命名 Server 已停止。未在暂停态继续向 Ralph 手工输入，因此“暂停后直接输入不被协调器抢占”尚未单独实测。

## 5. A09：传统 tmux 入口与宿主保护

另建 `/private/tmp/rll-a09-wtkOYx`，tmux socket 与 Herdr 隔离。初次试验中，tmux 的默认交互 shell 重置 PATH，意外启动了本机真实 Claude/Codex；发现后立即用旧 CLI `stop --no-archive` 停止，tmux session 和其进程均确认退出。该次不计入假 Agent 验收。随后在新的隔离 tmux Server 将 `default-command` 固定为带假 Agent PATH 的 `/bin/sh`，先在探针 Pane 核对 `command -v claude/codex` 都指向临时脚本，再执行以下测试；假 Agent 只记参数和输入，不调用模型。

| 用例 | 结果 |
|---|---|
| `auto "A09 manual tmux task"`，独立项目 | 双 Pane 启动；假 Claude/Codex 均收到空参数；旧 CLI `stop --no-archive` 正常停止。 |
| `auto --full-auto "A09 full tmux task"`，另一独立项目 | 双 Pane 启动；假 Claude 收到 `--dangerously-skip-permissions`，假 Codex 收到 `--full-auto`；正常停止。 |
| 传统 `update-task` | 在 full 项目把 `A09 updated tmux scope` 追加到 `task.md`，历史记录同步更新；不需要 Herdr 任务事件。 |
| Herdr 租约占用保护 | 第三个最小项目仅 `host claim`。`update-task`、`auto`、`auto --full-auto` 均以退出码 4 拒绝，任务正文、轮次、候选数未改变；测试租约已释放。 |

这验证了传统 tmux 命令的进程布局、参数、任务更新和宿主阻断；假 Agent 不证明真实 Claude/Codex 在 tmux 下完成语义协作。

## 6. 测试与结论

- 本地 CLI `npm test`：518/518 通过。插件 `node --test integrations/herdr/*.test.mjs`：57/57 通过。
- 固定 GitHub 安装、真实双席和两次非零游标显式恢复均有现场回执。任务切换后双向交接依赖逐份人工来源确认，因此 A03 的无人值守完整闭环仍不能由本次记录宣称通过。
- 待处理：在有效恢复现场用默认插件工作目录验收重绑操作页；定位 Codex `resume` 空闲时未上报原生引用的具体原因；补做暂停后直接输入及更长时间稳定性。[后续核查](p5-pane-and-codex-resume-diagnostic-2026-11-10.md)已确认前次自动关闭是测试调用错误。不要放宽来源或重复投递门禁来绕过这些限制。
- 以上为本机验收；GitHub CI 应以本记录对应提交的 Actions 运行结果单独核对，不能由本地通过推断。
