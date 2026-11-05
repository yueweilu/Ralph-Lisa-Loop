# S4 Codex 原生会话引用诊断

日期：2026-11-05。代码基线：`0157568`。使用新的临时项目和独立 XDG 目录、命名 Herdr Server；未操作默认 Herdr 会话或 `super-rll`。本记录不包含原始 Agent 会话 ID。

## 观察

- 控制端存在 `CODEX_THREAD_ID`；测试 Server 创建的 Shell Pane 中该变量不存在，同时 `HERDR_ENV` 和 `HERDR_SOCKET_PATH` 存在。因此这次观察到的缺失不能归因于测试 Pane 继承了控制端线程 ID。
- 普通 `codex` 席位启动并完成一次就绪提示后，Herdr `agent get` 仍无 `agent_session`。在正向验收项目的独立对照 Pane 中，普通 `codex` 连续完成两次提示，Herdr 仍无引用。
- 在另一隔离诊断 Pane，`codex --no-daemon` 加临时 `PATH` 观察器调用原有官方 hook。观察器只记录输入字段是否存在，并原样转发给官方 hook；未修改官方 hook 或保存原始 ID。它记录了 `SessionStart`、`UserPromptSubmit`、`Stop` 均实际调用；`session_id` 和 `transcript_path` 非空，`HERDR_ENV`、Socket、Pane 均存在，继承的 `CODEX_THREAD_ID` 不存在。Herdr 随后出现有效 `agent_session`。
- 正向验收项目的正式 Lisa 席位使用 `codex --no-daemon`，不使用观察器。第一次就绪提示后的即时检查仍无引用；第二次提示后 Herdr 出现有效引用。说明启动完成与引用上报之间不能仅用一次即时检查判定永久缺失。

这些对照将问题定位到普通 Codex 的共享 daemon 路径与本地 `--no-daemon` 路径之间：前者在本次真实试验中没有让 Herdr 收到引用，后者可收到。普通路径的 `SessionStart` 是否执行、以及其内部为何未形成上报，尚无直接事件证据，不能把某一条早退条件当成已证实根因。官方 hook 文件和配置均未修改，也未手工伪造引用。

## S4 门禁与验证

本次正向验收项目的 Claude/Ralph 停在新临时目录的“信任此目录”提示，尚未得到对此路径的授权。因此没有确认信任、启动插件租约、提交候选或进入重启接续。后续只有在该路径获授权、两席与原生引用复核通过后，才可运行 `0157568` 的 generation 1 重启、第二次显式重绑和接续；每份候选仍须单独经人工来源确认。

本地插件测试 32/32 通过。`0157568` 对应的 GitHub CI 已通过；两者均不能代替上述真实验收。
