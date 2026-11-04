# S3 真实 Herdr 双席交接试验

日期：2026-11-04。分支：`feat/herdr-s4-server-epoch-fence`。

## 已完成的现场步骤

- 在独立 XDG 目录和命名 Herdr 0.9.4 Server 中建立一次性 RLL 项目；默认 Herdr 会话和已有项目未参与。`doctor` 返回 `ready`，确认公开 CLI 宿主契约、Claude/Codex 集成及登录状态。
- 插件 `start` 自动创建 Claude/Ralph 和 Codex/Lisa 两席、领取 RLL 租约、绑定席位、建立 generation `0`，并向 Ralph 投递一次初始任务。两席之后均处于可交互状态。
- 真实 Claude 在 Ralph Pane 中读取任务和状态，写出 `ralph-candidate.md`，并明确表示未自行运行提交命令。候选内容为 `[PLAN] Add a README with the sentence "Herdr handoff trial"` 和 `Test Plan: inspect README text`；未改应用源码或安装依赖。
- 公开 CLI 的 `host propose` 接受该候选；`host commit-check` 返回 `awaiting_source_confirmation`、`source_verification=unverified`、`human_confirmation=absent`、`commit_ready=false`，候选 SHA-256 为 `7da3945c8567d6a4b76733b2e01e390fd7bbaa15bcdc033cf9c2726536cd0e38`。策略检查通过，测试门禁按该样板的现有配置未启用。
- 已调用插件 `pause` 并收到 `paused`，generation 仍为 `0`；候选未正式提交，尚未触发 Ralph → Lisa 交接。

## 后续验收条件

`host confirm-candidate` 会持久记录 `human_asserted` 与 `reviewed_candidate_source`。只有人实际审阅候选及来源并明确确认后，才可调用此命令；Agent 或协调器不能代签。确认后需先恢复协调器，再提交候选并核对真实 Lisa 仅收到一次回执驱动提示；Lisa 的 `[NEEDS_WORK]` 候选也须经同样门禁，才能验证交回 Ralph。此试验目前**不是**真实双席交接通过的证据。
