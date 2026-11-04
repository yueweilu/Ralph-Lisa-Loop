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
- 人工来源审阅确认后，`resume` 返回 `active`；Lisa 的 `host commit` 返回 `committed`，带有上述两条策略警告。generation 从 `1` 变为 `2`，业务状态变为第 2 轮 Ralph。插件仅保存一份目标为 Ralph `w2:p1` 的 `accepted` 投递，真实 Claude Pane 显示匹配的回执 ID 并开始读取新一轮状态。
- 两次正式回执均可由 CLI 查询；各自只有一份目标席位正确的投递记录。插件 `stop` 返回 `stopped`，协调器 PID 退出；最终 CLI 快照为 `host_state=unclaimed`、`binding_state=stale`、generation `2`。命名 Herdr 测试会话已停止。

## 结果与边界

这次在真实 Herdr 0.9.4 中验证了 Ralph → Lisa `NEEDS_WORK` → Ralph 的回执驱动双席交接，以及暂停/恢复、重复抑制与显式停止。`host confirm-candidate` 持久记录 `human_asserted` 与 `reviewed_candidate_source`，两次候选都经过此人工门禁；`source_verification` 仍为 `unverified`，CLI 不能独立证明文件由对应 Agent 写入。因此当前结果是**人工确认下的真实交接**，不等于无人逐轮操作。样板未启用测试门禁，也没有验收 `PASS`、测试失败或发布路径。后续需设计可核验的候选来源与受控提交，不能由插件代签人工声明。
