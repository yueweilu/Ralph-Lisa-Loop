# P2 受管理启动与关闭：真实 Herdr 验收（2026-11-09）

## 范围与隔离

- 公开仓分支：`feat/herdr-auto-task-launch`；试验开始时本地及 fork 均为 `b7f633dc4ad2d3e7792b8161a45b70a4a0803434`。
- Herdr 0.9.4；本仓插件 0.1.5、本仓构建的 CLI 0.3.13。前三次命名 Server 分别使用 `/tmp/rhp2-Ml523e` 下独立的 `XDG_CONFIG_HOME`、`XDG_STATE_HOME` 与临时项目状态；后续复验继续使用新的隔离配置。测试项目路径每次复用前均保留前次项目目录，未覆盖旧 `.dual-agent`。
- 任务只要求在一次性项目写一行 README。前三次启动没有对候选做来源确认、正式提交或交接；后续首交接的单份候选另获用户确认，见下文。没有操作默认 Herdr 会话及 `super-rll`。Claude 对 `/private/tmp/rhp2-Ml523e/project` 的目录信任由用户仅对此目录授权一次；其他权限提示未代答。
- Terminal 中打开了隔离 Herdr TUI，但自动化工具不能读取该 Terminal 画面。因此这里只验收 CLI、Server 日志、插件记录及 RLL 宿主状态，不把视觉布局标为已验收。

## 三次现场结果

| 会话 | 现场观察 | 处理及结论 |
|---|---|---|
| `rll-p2-ml523e` | 首次受管理启动遇到 Claude 目录信任，CLI 返回 `needs_input`；用户授权后 Ralph 就绪，但启动协调器已超过两分钟并留下 `AGENT_READY_TIMEOUT` 的未就绪结果。 | 同一启动请求按预领租约重试，保留原 Ralph 原生会话，Lisa Pane 启动，初始任务只投递一次，`started`、generation 0、host claimed。修复了合法重试无法更新旧启动结果的问题：旧结果先归档，当前结果写为 `started`。 |
| `rll-p2b-ml523e` | 新会话直接 `started`，初始投递一次。关闭受管理协调器 Pane 后，Server 在约 0.5 秒后以 SIGKILL 结束子进程；RLL 租约仍 claimed，插件记录仍 active。 | 增加 SIGHUP 监听仍不足：协调器在一秒轮询等待中未及时执行安全释放。停止隔离 Server，确认相关进程退出、generation 0、候选 0、只有一份已接受初始投递后，以 `recovery-check` 的证据摘要显式回收旧租约；未重放。 |
| `rll-p2c-ml523e` | 新会话直接 `started`，初始投递一次。关闭控制 Pane 的 Server 日志显示请求时间 `02:53:07.992968Z`、子进程 SIGTERM 退出 `02:53:08.268042Z`。 | 改为信号唤醒轮询等待后，协调器在 Herdr 强制终止前完成游标核查及宿主释放。插件留下 `phase=released`、`stop_reason=managed_pane_closed` 的 finished 记录；RLL 快照为 `host_state=unclaimed`、`binding_state=stale`、generation 0、候选 0。该命名 Server 已停止。 |

第一次与第二次失败留下的租约均按只读证据和明确的 `verified-stopped-no-replay` 决策回收；没有删除租约文件来模拟成功。第三次正常释放无需恢复命令。三个隔离 Server 均已停止；临时试验目录保留用于复核。

## 本次代码边界

1. 仅在预领租约检查通过、且请求 ID 与原 `not_ready`/`needs_reconcile` 结果相同的情况下，归档并替换启动结果。已 `started` 的结果不能被该路径覆盖。
2. 受管理启动监听 SIGHUP，并用可被信号立即唤醒的等待代替一秒固定睡眠。活动循环仍先核对宿主快照、游标及未投递回执，再调用原 `host release`；检查不通过继续保留租约供人工恢复。
3. 回归覆盖预领租约关闭后同请求重试、初始提示一次、SIGTERM/SIGHUP 关闭及业务状态变化时拒绝释放。模拟测试不替代上述真实 Herdr 证据。

## 前三次试验后的未验收项

- Lisa/Codex 在这三次启动中均未向 Herdr 返回可保存的原生会话引用；第三次 finished 记录中 Lisa 的原生引用指纹为 `null`。因此不能据此宣布双席 Server 重启接续通过。需独立排查 Codex 启动/SessionStart hook、Herdr `agent get` 与本插件 `nativeSessionReference` 的字段契约，并用新的隔离会话复验。
- 前三次试验没有正式候选、Ralph→Lisa 或 Lisa→Ralph 交接，也未验证任务输入 overlay 的视觉呈现。自动提交仍受现有逐份人工来源确认门禁约束；本次修复没有放宽门禁。
- 关闭活动 Pane 时的安全释放仅在快照与游标一致、没有待投递回执的场景通过。SIGKILL、Server 异常退出、忙锁或已提交而未交接的场景仍需 S4 只读恢复与显式决策。

## 验证记录

本地执行 `node --test integrations/herdr/*.test.mjs`，47/47 通过。真实证据为各隔离项目的 `host snapshot`、`host recovery-check`、插件 `initial-*`/`finished-*` 记录及命名 Server 日志；文档不包含任务正文、原生 Agent Session ID 或个人凭证。提交与 GitHub CI 状态在本次开发报告中另行核对。

### 后续只读会话引用探针

另以 `config4/state4` 和命名 Server `rll-p2probe-ml523e` 在同一临时项目启动单席 Codex，不启动 RLL 协调器。Herdr `agent start codex-probe --kind codex -- --no-daemon` 返回 ready，argv 确认含 `--no-daemon`；紧接的 `agent get` 显示 `agent_session=null`。发送一次明确要求“不编辑文件、不运行命令、仅回复固定短语”的探针提示后，Herdr 的 `agent prompt` 回执含 `agent_session`，类型为 `id`、来源为 `herdr:codex`。RLL 项目快照保持 unclaimed、generation 0、候选 0；探针 Server 已停止。原生 ID 只在临时机器输出中出现，不写入本文。

该探针说明“ready 即有原生引用”的假设不成立；首次交互之后可取得引用。不能把这次非业务探针提示偷偷加入正式双席启动：它需要独立持久投递意图、未知结果不重发、重启时的引用核查，并避免让 Lisa 误以为已收到 Ralph 的正式交接。P2 的 Lisa 启动时引用验收仍未完成。

### `--full-auto` 参数兼容复验

随后用新的 `config5/state5` 与命名 Server `rll-p2handoff-ml523e` 试行 CLI `auto --host herdr --full-auto`。Ralph 就绪，但 Lisa Pane 中 Codex CLI 0.167.0 明确报 `unexpected argument '--full-auto'`；启动结果为 `START_OUTCOME_UNKNOWN`，只读复核显示插件记录最终为 `needs_reconcile`、原因 `timeout`，宿主仍 unclaimed、generation 为 null、候选 0、没有初始投递。Server 已停止，失败项目单独保留；没有重复执行同一请求。

本机 `codex --help` 显示支持 `--sandbox workspace-write`、`--ask-for-approval never` 与 `--no-daemon`。插件将 Codex 的 `full_auto` 启动参数改为这组三项；模拟 Herdr 回归检查实际转发的参数。新的 `config6/state6` 与命名 Server `rll-p2handoff2-ml523e` 在另一份新建临时项目上实测返回 `started`：两席绑定、初始任务接受一次、host claimed、generation 0、候选 0。此时还未正式提交候选或验证 Lisa 的首次交接原生引用。

该 `config6/state6` 会话随后收到 Ralph 候选，但候选正文直接是 README 的一句话，缺少 planning 轮次的 `[PLAN]` 首行。只读 `commit-check` 返回 `INVALID_SUBMISSION`；未做来源确认、正式提交或交接。关闭受管理协调器 Pane 后，租约正常释放；最终 generation 0、候选 1，Server 已停止。该失败项目已单独保留。

初始 Ralph 提示因此明确区分交付文件和 RLL 评审候选，并要求 planning 候选以 `[PLAN]` 开头、包含测试命令与覆盖范围，先做只读 `commit-check`。新的 `config7/state7` 命名会话 `rll-p2handoff3-ml523e` 在新项目中启动，Ralph 提出一份独立 `[PLAN]` 候选；只读门禁返回 `awaiting_source_confirmation`、策略 pass，此时尚无正式提交或交接。

用户随后仅对这份候选 `56cafeea-c9c3-4566-92fa-2a7c63c87abc`、SHA-256 `6288226e2bdd92e1bf413407d33e5619b691166332fe2628657130ca0ffba18f` 确认来源并授权正式提交一次。重读候选及 `commit-check` 后，用同一请求 ID 一次 `confirm-candidate`、一次 `host commit`；CLI 返回 committed，generation 0→1、turn Ralph→Lisa。插件 `delivery-*` 为 accepted、游标 1；Lisa Pane 收到正式提示。Lisa 随后提出候选，但未获来源确认，未正式提交。关闭协调器后 host unclaimed、generation 1、candidate_count 2；命名 Server 已停止。

该真实交接暴露了更窄的时序差：Herdr `agent get lisa` 在提示后出现 `agent_session`（`kind=id`、`source=herdr:codex`），但协调器在 `agent_prompted` 回执刚返回时读取仍为空，持久计划中的 Lisa 指纹继续为 `null`。既有代码只在该瞬间尝试记录，没有在后续心跳补存。修复后，活动心跳只对已接受过正式提示、且原指纹为空的席位观察并持久保存后来出现的引用指纹；未提示的 Lisa 不自动登记。模拟 Herdr 回归延迟揭示 Lisa 引用，检查同一交接只投递一次且后续记录取得指纹。修复后的真实再验仍待完成，不能把本次旧进程的结果写成已通过。

### 延迟引用修复后的真实再验

新建 `config8/state8`、命名 Server `rll-p2native-ml523e` 和同路径全新临时项目，链接修复后的本仓插件。`auto --host herdr --full-auto` 返回 `started`，两席绑定，Ralph 初始任务一次 accepted。Ralph 提出的 `[PLAN]` 候选 `0b87cfb5-934d-49ce-9b3e-fa86f13fd6bf`、SHA-256 `1951ea3240ae8b078fe049986b0bf938cd18b029cd0b12cd77c4657b0a1ab06d` 经只读 `candidate-show` 和 `commit-check` 核对；用户仅对这份候选明确接受来源并授权正式提交一次。随后同一请求 ID `3c6a0977-0c04-4410-98c3-49ec2f051e58` 的一次 `confirm-candidate` 与一次 `host commit` 返回 human_asserted、committed，generation 0→1、turn Ralph→Lisa。

插件只有一份该回执的 `delivery-*`，状态 accepted、角色 Lisa、游标 1。真实 `herdr agent get lisa` 显示 ready、working、`agent_session` 存在且来源 `herdr:codex`；活动记录在后续心跳保存 Lisa 原生引用 SHA-256 指纹。关闭协调器 Pane 后，宿主快照为 unclaimed、binding stale、generation 1；finished 记录为 `phase=released`、`stop_reason=managed_pane_closed`，Ralph/Lisa 两席指纹均存在。Lisa 另提出一份候选，未获单独来源确认，未正式提交。命名 Server 已停止，临时证据目录保留。

本地插件套件 47/47 通过；修复提交 `8a7bfb95bb3bf18b063ce4533fa235ca494fa4c2` 的 [GitHub CI](https://github.com/yueweilu/Ralph-Lisa-Loop/actions/runs/42565344550) 在 Node 18/20/22 全部成功。这证实 P2 的正式首交接后原生引用持久化及受管理关闭收尾。任务输入 overlay 的视觉呈现、两个入口与本次新进程的非零游标 Server 重启接续仍需分别验收；本次没有启用自动来源授权或无人值守正式提交。

### 两个任务入口的真实启动验收

`herdr-rll` 短命令在新的 `config9/state9`、命名 Server `rll-p2short-ml523e` 和全新临时项目中，以 `--full-auto --project <项目> "Write README.md with exactly one sentence: P2 short entry trial."` 启动。CLI 返回 `started`、request `d7e223e5-48cf-43a6-913b-abf8b60896b7`、Workspace `w2` 和协调器 `w2:p2`。宿主为 claimed/bound、generation 0、候选 0；任务正文落入 `task.md`，仅有一份 Ralph 初始投递记录且状态 accepted。关闭协调器后宿主 unclaimed/binding stale，generation 和候选数不变；命名 Server 已停止，项目保留在 `/tmp/rhp2-Ml523e/project-short-entry`。这里的 `--full-auto` 只配置 Agent 权限模式，**没有**授权候选自动正式提交。

`start-task` 插件入口在新的 `config10/state10`、命名 Server `rll-p2overlay-ml523e` 中复验。Herdr 0.9.4 对 overlay 使用当前活动 Pane：带 `--workspace w2` 或 `--target-pane w2:p1` 均返回 `invalid_params`；未显式切换焦点时，它附着到 `w1`，显示 `/Users/fugur`。该空输入页未提交任务，已关闭。显式聚焦测试项目 Workspace `w2` 后，以 `plugin pane open --plugin ralph-lisa.loop --entrypoint start-task --placement overlay --focus` 打开 `w2:p2`，输入页显示正确项目 `/private/tmp/rhp2-Ml523e/project`；输入一次 `Write README.md with exactly one sentence: P2 overlay entry trial.` 后输入页退出。启动结果为 `started`，request `25a19330-2ab7-4d09-aece-77af7a27cfe0`；双席出现在同一项目 Workspace，协调器在 `w2:p4`。宿主为 claimed/bound、generation 0、候选 0；只有一份 Ralph 初始投递记录，状态 accepted。控制端未连接默认 Server：测试 Pane 的 `HERDR_SOCKET_PATH` 指向 `config10` 下命名会话 socket。

Ralph 随后停在读取会话状态文件的权限提示；这不是目录信任提示，未代用户确认，也没有候选、正式提交或轮次交接。关闭协调器后宿主为 unclaimed/binding stale、generation 0、候选 0；finished 记录为 `phase=released`、`stop_reason=managed_pane_closed`。命名 Server 已停止，临时证据保留。该验收证明插件输入页的**功能路径**与短命令入口均可启动；Terminal 画面仍无法由自动化工具读取，视觉布局未验收。overlay 对活动 Workspace 的依赖应在界面与使用说明中明确；不能把 `--workspace` 作为 0.9.4 overlay 的定址参数。
