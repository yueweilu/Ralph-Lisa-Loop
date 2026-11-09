# P3 真实 Herdr 会话级自动提交验收

日期：2026-11-09。真实运行基线为 `2ecbed83af9e9e8ca9114e42599955575f68f7da`；使用本仓已构建 CLI、Herdr 0.9.4、本地链接插件 0.1.5。测试根目录为 `/private/tmp/ha-Oa8998`，配置、状态均使用该目录下独立的 XDG 路径，命名 Server 分别为 `rll-ha-oa8998` 和 `rll-ha-full`。没有操作默认 Herdr 会话、`super-rll` 或其他项目。

## 启动权限与双席

- 隔离插件列表起初为空；只在隔离配置中链接本仓插件。插件 `doctor` 返回 `ready`，Herdr、同仓 CLI 宿主契约、Claude/Codex 集成和登录检查均通过。
- 第一份临时项目 `project` 用默认 `interactive` 权限启动。用户只授权该项目的 Claude 目录信任。Ralph 和 Lisa 两席及 generation 0 初始提示均建立；Claude 随后在读取状态文件的 Bash 命令处要求交互确认。未代用户批准该命令；停止后宿主为 `unclaimed`、generation 0、候选数 0。
- 第二份临时项目 `project-auto` 用 `herdr-rll --full-auto` 启动，用户另行只授权此目录的 Claude 信任。启动回执为 `auto_commit=true`、`source_verification=unverified`、`permission_profile=full_auto`。Ralph/Claude 与 Lisa/Codex 均取得有效原生会话引用，但记录中不保存原始引用值。

## 自动轮次证据

在 `project-auto`，两席自己编写并提议候选，操作者未创建候选文件、未调用 `confirm-candidate` 或 `host commit`。每份正式回执均为 `source_confirmation=session_authorized_auto`、`source_verification=unverified`。Herdr 的 Pane 观察不能证明候选作者；这仍是产品接受的会话级信任边界。

| generation | 候选与业务结果 | 协调器结果 |
|---:|---|---|
| 0→1 | Ralph `[PLAN]`，候选 `cb88763a-8e82-478f-b7df-e8ce4327257f`，策略 pass | 自动提交并向 Lisa 投递一次 |
| 1→2 | Lisa `[NEEDS_WORK]`，指出测试命令漏检末尾换行 | 自动提交并向 Ralph 投递一次 |
| 2→3 | Ralph `[FIX]`，改用逐字节比较并创建 README | 自动提交并向 Lisa 投递一次 |
| 3→4 | Lisa `[PASS]`，独立验证 README 精确字节 | 自动提交并向 Ralph 投递一次 |
| 4→5 | Ralph `[CONSENSUS]`，再次验证文件 | 自动提交并向 Lisa 投递一次 |
| 5→6 | Lisa `[CONSENSUS]`，双方最新正式记录达成共识 | 自动提交；旧协调器仍错误地向 Ralph 多投递一次 |

独立执行 `printf 'Herdr automatic handoff trial.\n' | cmp -s - README.md` 退出码 0。最终快照为 generation 6，`work.md` 与 `review.md` 的最新规范标签均为 `[CONSENSUS]`。测试在此由插件 `stop` 成功释放租约，`host_state=unclaimed`；命名 Server 均已停止。隔离目录保留以便核对，未作为交付项目。

## 本轮发现与修复边界

1. 旧 `policy check-consensus` 和 `policy check-next-step` 在多轮 `review.md` 中取了首个 `[NEEDS_WORK]`，与最新 `[PASS]/[CONSENSUS]` 不符。提交 `745fdc6` 改为读取最后一个规范轮次区块；CLI 回归 181/181 通过，真实归档上的两个只读命令随后均返回共识成立。
2. 旧协调器没有共识停止分支，generation 6 后仍保存并接受了一份目标 Ralph 的交接。后续代码仅在 Lisa 的正式回执后、RLL 完成检查通过且快照未变化时记录完成并释放租约；模拟 Herdr 的完成测试通过，第二个真实会话的自动停止结果见下节。
3. 本次真实运行证明自动候选提交、双向交接、NEEDS_WORK 修复、PASS 和双方共识可从 CLI 入口连续发生；不证明聊天中改任务、Server 重启后自动授权接续或长期运行稳定性。`--full-auto` 仍不能跳过 Claude 首次目录信任。

## 自动停止修复的第二次真实复验

固定本仓提交 `9780a25b68a4827a3b5ced231ee9809e7676b8aa`，在同一隔离 XDG 根目录的**新命名 Server** `rll-ha-done` 和**新项目** `/private/tmp/ha-Oa8998/project-complete` 启动 `herdr-rll --full-auto`。用户只授权此新目录的 Claude 信任。任务要求创建字节精确的 `README.md`，两席完成后各自给出 `[CONSENSUS]`。本次没有人工代写候选或逐份确认。

| generation | 真实席位行为 | 正式结果 |
|---:|---|---|
| 0→1 | Ralph `[PLAN]` | 自动提交，向 Lisa 投递一次 |
| 1→2 | Lisa `[NEEDS_WORK]`：README 尚未创建 | 自动提交，向 Ralph 投递一次 |
| 2→3 | Ralph 创建 README 并验证其为 `Done.` 的 5 字节，提交 `[CONSENSUS]` | 自动提交，向 Lisa 投递一次 |
| 3→4 | Lisa 独立读出 `446f6e652e` 并提交 `[CONSENSUS]` | 自动提交，协调器写 `phase=completed`，释放租约；**没有 generation 4 的 Ralph 投递文件** |

最终只读 `host receipt` 确认 Lisa 回执 `fa0be676-833e-5698-95e5-0db4fb0f6473` 为 `session_authorized_auto`、`source_verification=unverified`，generation 3→4。`host snapshot` 为 `host_state=unclaimed`、generation 4、最新回执相同。归档协调器记录的游标为 4、阶段 `completed`；只存在前三份回执的交接文件。`policy check-next-step` 退出 0，`printf 'Done.' | cmp -s - README.md` 退出 0，`wc -c README.md` 为 5。命名 Server 已停止。此复验确认正常收敛路径的自动停止；不覆盖异常重启、聊天改任务或长期运行。
