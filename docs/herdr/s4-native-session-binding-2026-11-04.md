# S4 原生 Agent 会话身份绑定

日期：2026-11-04。分支：`feat/herdr-s4-native-session-binding`。

## 解决的问题

真实 Herdr Server 重启试验中，Claude 席位带原生会话引用并恢复；Codex 席位在首次交接前没有引用，重启后只有空 Pane。之前 `recovery-check` 只能报告当前是否有引用，无法证明它是否与启动时是同一个会话。

## 实现

`seat-preflight` 在核对 Agent 名称、种类、项目、Workspace、Pane 和就绪状态时，将 Herdr 的原生会话引用转成 SHA-256 摘要，写入插件的持久席位计划；不保存或输出原始引用。不存在引用时明确保存 `null`，格式错误的引用拒绝预检。正式提示得到目标席位匹配的 `agent_prompted` 回执后，协调器再次读取该席位，若此时才出现原生引用，则把摘要写入下一笔持久协调器记录。

后续投递与暂停恢复前，若席位已保存摘要，协调器要求实时 Herdr 引用与之相同；会话变化或引用消失会停在待核对。`recovery-check` 同时报告 `matches_record`、`changed_or_missing`、`not_recorded`，仅当两席位置和已记录的引用都匹配时给出 `recorded_native_sessions_match` 观察结果。该结果仍不能证明旧协调器已停止、提示未在途或可以回收租约。

## 验证与限制

真实公开 CLI 加伪 Herdr 的隔离集成测试覆盖：启动时 Ralph 有引用而 Lisa 尚无引用；同名同 Pane 的 Ralph 引用变化被恢复核对识别；Lisa 首次正式交接后出现引用并被持久补记；恢复输出不包含原始引用。插件测试 14/14 通过。此切片没有再次重启真实 Herdr Server；真实环境的摘要连续性、Codex 首次提示后的引用出现时机，以及安全重绑仍需分别验收。若提示回执之后 Herdr 尚未暴露引用，插件保留 `null` 并要求人工核对，不猜测会话身份。旧分支生成的记录没有保存摘要，同样保持 `not_recorded`。
