# S3 真实 Herdr 双席交接试验

日期：2026-11-04。分支：`feat/herdr-s4-server-epoch-fence`。

## 已完成的现场步骤

- 在独立 XDG 目录和命名 Herdr 0.9.4 Server 中建立一次性 RLL 项目；默认 Herdr 会话和已有项目未参与。`doctor` 返回 `ready`，确认公开 CLI 宿主契约、Claude/Codex 集成及登录状态。
- 插件 `start` 自动创建 Claude/Ralph 和 Codex/Lisa 两席、领取 RLL 租约、绑定席位、建立 generation `0`，并向 Ralph 投递一次初始任务。两席之后均处于可交互状态。
- 真实 Claude 在 Ralph Pane 中读取任务和状态，写出 `ralph-candidate.md`，并明确表示未自行运行提交命令。候选内容为 `[PLAN] Add a README with the sentence "Herdr handoff trial"` 和 `Test Plan: inspect README text`；未改应用源码或安装依赖。
- 公开 CLI 的 `host propose` 接受该候选；`host commit-check` 返回 `awaiting_source_confirmation`、`source_verification=unverified`、`human_confirmation=absent`、`commit_ready=false`，候选 SHA-256 为 `7da3945c8567d6a4b76733b2e01e390fd7bbaa15bcdc033cf9c2726536cd0e38`。策略检查通过，测试门禁按该样板的现有配置未启用。
- 首份候选通过人工来源审阅声明后，`host commit` 返回 `committed`，generation 从 `0` 变为 `1`，轮次转给 Lisa。插件为该回执只保存一份目标为 Lisa `w2:p2` 的 `accepted` 投递；真实 Codex Pane 显示相同回执 ID 并开始处理。RLL 业务快照也显示 `turn=lisa`、generation `1`。
- Lisa 在真实 Codex Pane 中写出 `lisa-candidate.md`，内容为 `[NEEDS_WORK] Please add a second sentence to the README after "Herdr handoff trial".`，并自行调用 `host propose`。首次尝试遇到瞬时 `HOST_BUSY`，核对短锁后重试成功。Lisa 的 `host commit-check` 返回 `awaiting_source_confirmation`，没有擅自确认来源或正式提交。该候选策略检查有“原因必填”和“文件行号”警告；测试门禁未启用。
- 再次调用插件 `pause` 并收到 `paused`；generation 仍为 `1`，仅有上述一份 Lisa 投递记录。

## 后续验收条件

`host confirm-candidate` 会持久记录 `human_asserted` 与 `reviewed_candidate_source`。只有人实际审阅候选及来源并明确确认后，才可调用此命令；Agent 或协调器不能代签。Lisa 的 `[NEEDS_WORK]` 候选仍需该确认，随后先恢复协调器，再正式提交并核对真实 Ralph 仅收到一次回执驱动提示。此试验已经验证 Ralph → Lisa，**尚未**验证 Lisa → Ralph 的完整闭环。
