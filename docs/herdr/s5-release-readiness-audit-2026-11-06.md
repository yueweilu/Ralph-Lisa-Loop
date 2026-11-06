# Herdr 公开插件发布前核对（2026-11-06）

后续进展：固定提交 `a75cd39` 的隔离真实首次启动重试和双向交接已完成，见[新验收记录](s5-v012-live-retry-and-dual-handoff-2026-11-06.md)。下文“尚未满足”的第 1 项保留本审计时点的状态；真实 `agent_pane_busy`、Server 重启接续和长期稳定性仍未由该新试验覆盖。

## 本轮交付与证据

| 项目 | 已核对结果 |
|---|---|
| 首次启动失败重试 | `e045f444f09a8605fa363d85e6501965a9924737` 只允许未领租约、未写初始投递意图的失败记录重试；核对同一项目、会话、摘要、Workspace、Pane、Terminal 和 Agent，异常时继续阻断。模拟 Lisa `agent_pane_busy` 的回归验证原窗格复用、篡改拒绝和初始任务单次投递。完整插件测试 37/37；[CI](https://github.com/yueweilu/Ralph-Lisa-Loop/actions/runs/42155530881) 的 Node 18/20/22 全部成功。 |
| Agent 使用同仓 CLI | `4a2377ad6ff1c61aac95c36bab90f8952805dfde` 在初始和交接提示中给出插件实际使用的同仓 CLI 命令；显式自定义 CLI 只提示使用配置项，不回显其参数。命令路径转义测试与真实协调器形状的模拟交接测试通过；[CI](https://github.com/yueweilu/Ralph-Lisa-Loop/actions/runs/42156282150) 的 Node 18/20/22 全部成功。 |
| 既有真实双席 | GitHub 安装版在 `41593890dae22d99a2c85b6bfa2c98efb617e09b` 完成 Ralph→Lisa 与 Lisa→Ralph 各一次人工确认后的正式提交和交接，见[验收记录](s5-github-dual-agent-closure-2026-11-06.md)。该结果早于本轮两个代码提交。 |

## 本次发布元数据校正

- 插件 manifest 版本由 `0.1.1` 升至 `0.1.2`，平台先声明 `macos`。Node 测试在 GitHub 的 Linux runner 上通过，不等于真实 Linux Herdr 安装及双 Agent 验收。待 Linux 实机验证后再声明支持。
- 本地 Herdr 0.9.4 在独立 XDG 目录、命名 Server `rla-l7xkjc` 中成功链接并列出新 manifest，返回 `version=0.1.2`、`platforms=["macos"]`。随后已 unlink，命名 Server 已停止。此验证只覆盖 manifest 解析与注册，没有运行双 Agent。
- README 已更新双向交接结论和完整插件测试命令。

## 尚未满足的公开发布条件

1. 本轮两个代码变更尚未从 GitHub 固定新提交安装后重复真实双 Agent 流程；首次启动失败重试也尚无真实 Claude 信任提示后的同状态目录复验。不能用模拟测试替代这项验收。
2. 公开上游 `YW1975/Ralph-Lisa-Loop` 的 `main` 为 `7440e29e4134bf8905e079b7d44c5e659a99ef4c`，fork 的 `main` 为 `6fb94b3c0eec8ce138be8c36f09eb9749f7ed835`；两者在核对时均无 `integrations/herdr/herdr-plugin.toml`。现有可安装包只在 fork 的 `feat/herdr-s4-server-epoch-fence` 分支。上游尚无针对该分支的 PR，fork 的 GitHub topics 为空，尚未建立默认分支市场发现入口。
3. 前次 `HOST_BUSY` 的占锁者和 S4 的一次 `ACTIVE_SNAPSHOT_MISMATCH` 根因没有证实；后续真实验收应保存对应诊断证据，仍按原阻断条件处理不确定提交与接续。

下一阶段应在新的隔离 XDG、命名 Server 和临时项目中，从本轮最终完整 SHA 安装并核对构建、doctor、两席启动、重试和双向单次交接；每份候选继续单独经过人工来源确认。通过后再准备上游 PR、默认分支 manifest 与 `herdr-plugin` topic 的公开发布步骤。
