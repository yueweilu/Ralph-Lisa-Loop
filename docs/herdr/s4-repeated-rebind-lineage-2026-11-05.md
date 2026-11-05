# S4 重复重绑的多级投递归档

日期：2026-11-05。基线是 [真实重启接续试验](s4-real-continuation-trial-2026-11-05.md)：第 0 代接续和一次 Ralph → Lisa 交接已在命名 Herdr 会话中通过；第二次重启停在 `REPEATED_REBIND_UNSUPPORTED`，且已受提示的 Lisa/Codex 缺少 Herdr 原生会话引用。

## 本切片

每次显式 `rebind` 将前一租约的协调器记录、当期投递文件及其已有的 `prior-<lease>` 归档一起移入新归档。由此形成从当前租约到首个租约的嵌套链，不复制或覆盖历史投递。`recovery-check`、`rebind-check` 和 `continuation-check` 逐层核对租约、项目、会话、交接游标、原始提示与回执记录；证据摘要包含完整链。归档缺失、额外归档、符号链接、游标断裂或超过 32 层时均拒绝。提交重绑前会再读整条链，发现变化则保留待人工核对的写入意图，不发送 Agent 提示。

已收到提示的席位仍必须带有与旧绑定一致的原生会话指纹。即使多级归档有效，Lisa 的指纹缺失也会返回 `AGENT_SESSION_UNVERIFIED_LISA`，不会因本切片获得接续许可。`continue` 仍从保存游标启动，不重发历史提示。

## 验证范围

隔离伪 Herdr 测试使用公开 CLI 正式提交两轮回执，模拟两次 Server 身份变化、人工租约回收、两次显式重绑及接续。第二次重绑后能读到第 0 代初始投递与第 1、2 代交接，接续时没有新增提示。隐藏已受提示 Lisa 的原生会话引用会阻断第二次重绑；将最内层初始投递从 `accepted` 改为 `intent` 会阻断第二次接续。本地插件套件 32/32 通过。测试使用伪 Herdr，只证明插件的本地状态和门禁行为。

真实 Herdr 的第 1 代重启接续仍未验收。已安装的 Codex v9 集成脚本会在继承的 `CODEX_THREAD_ID` 与自身 `session_id` 不同时跳过上报；当前试验尚未证明这就是 Lisa 缺少引用的原因。下一次命名会话须在受管 Pane 中核对启动环境、Codex hook 是否执行以及 Herdr 是否保存原生引用；不能手工伪造引用，也不能绕过指纹门禁。

后续[原生会话引用诊断](s4-codex-session-diagnostic-2026-11-05.md)确认：控制端的线程 ID 没有进入测试 Pane；普通 Codex 两次提示后 Herdr 仍无引用；`--no-daemon` 的真实 Codex 可执行官方 hook 并让 Herdr 收到引用。第 1 代真实重启接续仍受新临时项目的 Claude 目录信任门禁约束。

用户随后仅对新临时项目确认目录信任。[真实非零游标重复重绑验收](s4-live-nonzero-continuation-2026-11-05.md)通过了 generation 1 的两次显式重绑与接续，以及一次 Lisa → Ralph 交接；现场另外发现并修复已暂停协调器的重绑预检阻断。
