# S4 真实 Server 重启接续试验

日期：2026-11-05。分支：`feat/herdr-s4-server-epoch-fence`。环境：独立临时 XDG 配置与状态目录、命名 Herdr 0.9.4 Server `rll-s4-20261105-tgmhin-b`、一次性项目 `/tmp/rll-s4-live-20261105-tgmHin/project`。没有操作默认 Herdr 会话或 `super-rll`。首次半启动的另一个命名会话没有复用。

## 0 游标重启与接续

真实 Claude/Ralph 与 Codex/Lisa 在两个 Pane 启动。Ralph 的 Herdr `agent_session` 指纹已记录；Lisa 虽可交互并完成一次就绪提示，Herdr 仍未返回 `agent_session`。插件领取旧租约 `d8a4027a-65fd-4775-a02c-a0619236f859`，generation 0，仅向 Ralph 投递一份已接受的初始提示。

停止并重启命名 Server 后，旧协调器 PID 消失，心跳停在序号 70。Ralph 在新 Terminal 恢复且原生会话指纹相同；Lisa 的 Pane 恢复为空 Shell。只读 `recovery-check` 显示旧提示已接受、游标 0 和席位重绑阻断。确认没有在途 RLL 投递后，使用公开 CLI 的证据摘要显式回收旧租约；重新启动尚未收到 RLL 交接的 Lisa。

`rebind-check` 无阻断，`rebind` Pane 通过精确证据确认后建立替代租约 `b5a68579-5602-42fa-adbb-bda11e3f87c1`，状态为 `rebound_paused`，未发送提示。`continuation-check` 无阻断；`continue` Pane 显式接续为 `active`，保留 generation 0，历史初始提示未重发。

## 一次真实交接与非零游标阻断

Ralph 的终端展示候选草稿；操作者将其正文复制到临时项目并移除不合提交格式的标题。用户仅对候选 `b861db95-25d5-4067-8c15-8d37fa8dfa6d`、SHA-256 `f6f60cafdf44b7633ca504482ab12adf86de7a3704d627be710eb5b59b7f5b67` 明确接受来源说明并授权一次正式提交。CLI 在提交前复查正文、摘要、租约、generation 0、绑定代次 4 和策略，记录 `human_asserted`；`source_verification` 仍为 `unverified`，测试门禁未启用。

请求 `e5603ece-76a7-4285-960e-3bf052d1229b` 的 `host commit` 返回 `committed`，generation 0→1，`turn=lisa`。插件为该回执仅保存一份目标 `w1:p2` 的 `accepted` 交接；真实 Codex Pane 显示该回执并处理任务，写出未正式提交的 `NEEDS_WORK` 候选。游标固定为 generation 1 和同一回执 ID。

Lisa 完成后，Herdr `agent get lisa` 仍无 `agent_session`，插件席位计划也没有 Lisa 原生会话指纹。再次暂停、停止并重启命名 Server：旧协调器 PID 消失，心跳停在序号 610，Ralph 原生会话继续匹配，Lisa 的 Pane 再次恢复为空 Shell。只读审查合并显示旧初始提示和新租约的一份 Lisa 交接，游标未变。显式回收替代租约后，重新启动 Lisa；`rebind-check` 拒绝第二次重绑，且当前设计无法核验已经受提示的 Lisa 原生会话。因此没有执行第二次重绑或非零游标 `continue`，也没有第二次交接。命名测试服务已停止。

本次发现第二次重绑的诊断原先返回笼统 `PLUGIN_RECORD_INVALID`。现在 `rebind-check` 对含既有归档的记录明确返回 `REPEATED_REBIND_UNSUPPORTED`，保持只读和阻断。此改动没有扩大重绑权限；正向非零游标重启接续仍需解决多级租约归档与 Codex 原生会话引用缺失，并重新做真实验收。
