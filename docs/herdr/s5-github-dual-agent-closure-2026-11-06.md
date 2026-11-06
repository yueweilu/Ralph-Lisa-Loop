# S5 GitHub 安装版双向交接复验

日期：2026-11-06。结论：在一次新的隔离真实 Herdr 会话中，Ralph→Lisa 与 Lisa→Ralph 均按人工来源确认门禁完成单次提交和单次交接。Lisa 的正式提交只调用一次并返回 `committed`。这证明本次有界场景通过，不证明前次 `HOST_BUSY` 的占锁者、长期稳定性或重启接续。

承接 [首次双席试验](s5-github-dual-agent-live-2026-11-06.md) 和 [提交短锁竞争缓解](s5-commit-lock-contention-2026-11-06.md)。本次只使用 `/tmp/h6-c8b5oN` 内的隔离 XDG 配置、状态和 npm 缓存、临时项目 `/private/tmp/h6-c8b5oN/project`、命名 Herdr 0.9.4 Server；没有操作默认 Herdr 会话或 `super-rll`。公开仓源码在验收期间保持干净。

## 安装、启动与隔离

- 安装前隔离插件列表为空。从 GitHub 的 `yueweilu/Ralph-Lisa-Loop/integrations/herdr` 安装固定提交 `41593890dae22d99a2c85b6bfa2c98efb617e09b`；注册的 `requested_ref`、`resolved_commit` 和托管 checkout HEAD 一致。插件版本 `0.1.1`，构建成功；真实 `doctor` 动作返回 `ready`，Herdr、同仓 CLI host contract、Claude/Codex 集成和登录检查通过。项目由该 checkout 的 `cli/dist/cli.js init --minimal` 初始化，插件配置仅指向该临时项目。
- 第一次命名 Server `h6-c8b5on` 的 `start` 在 Claude 目录信任提示期间报告 `AGENT_BLOCKED`，之后以 `agent_pane_busy` 结束。用户只授权对这个临时项目确认信任。只读快照显示 `host_state=unclaimed`、`generation=null`、`candidate_count=0`，没有初始投递。保留失败记录并停止该 Server，没有重试其不确定状态。
- 使用相同临时项目、独立状态目录和新命名 Server `h6-retry` 复验。先创建同一 Workspace 的两个 Pane，再启动 Ralph/Claude 与 Lisa/Codex；Codex 使用 `--no-daemon`，跳过更新提示，未更新 Codex。两席可交互后，插件 `seat-preflight` 返回 `ready`，随后 `start` 领取租约，绑定 `w1:p1`/`w1:p2`，generation 0、`turn=ralph`。一份 `accepted` 初始投递使 Ralph Pane 收到任务。Lisa 的原生会话引用在实际收到交接并工作后出现；前置检查时其指纹仍为 `null`，所以本试验不宣称验证重启接续。

## 两份候选与单次交接

| 阶段 | 不变证据 | 正式提交和交接 |
|---|---|---|
| Ralph `[PLAN]` | 候选 `6ccda5f0-1db9-471f-aea7-622bd6949209`；SHA-256 `5afae655d2c4fb682461b483ac2afde227fcc6ffe88413cb3d96484b469a1e2f`；请求 `cb89372f-4784-45db-8e96-ad79c3200f10` | Ralph 在自己 Pane 写出并提议；`commit-check=awaiting_source_confirmation`、策略 `pass`。用户审阅完整正文和摘要后单独接受来源并授权一次提交。`confirm-candidate=human_asserted`，一次 `host commit=committed`，generation 0→1、`turn=lisa`。插件只有一份该请求的 `accepted` 投递，Lisa Pane 收到交接。 |
| Lisa `[NEEDS_WORK]` | 候选 `8c4a53d4-bb91-45b6-9fc1-32e5c637d174`；SHA-256 `057e78a6418f3669255a304ff8e516a6b0c266385830678c1de8a3e7e278c434`；请求 `9159d23b-98da-4bb5-9744-428e6221d641` | Lisa 在自己 Pane 写出并提议，要求明确 README 第二句话；`.dual-agent/task.md:3` 和 `.dual-agent/work.md:28-29` 支持该理由。`commit-check=awaiting_source_confirmation`、策略 `pass`。用户审阅完整正文和摘要后单独确认来源并授权一次提交。`confirm-candidate=human_asserted`，一次 `host commit=committed`，generation 1→2、`turn=ralph`、round 1→2。插件只有一份该请求的 `accepted` 投递；Ralph Pane 的最近输出中，该回执的交接提示出现一次。 |

两份候选的 CLI `source_verification` 均保持 `unverified`；人工来源断言作为独立门禁记录，未冒充自动来源证明。Lisa 的 `NEEDS_WORK` 候选没有给出第二句话，也没有创建 `README.md`。这轮只验证双向任务交接，不把未指定的产品内容当作已完成实现。

## 短锁竞争观察与停止

- 活跃协调器期间，少数**只读** `snapshot`、`candidate-show` 或 `receipt` 查询短暂返回 `HOST_BUSY`；命令锁检查显示短锁可消退，随后只读复查成功。没有对不确定的正式提交盲目重发。Lisa 的正式 `host commit` 只执行一次并成功；本次没有捕获前次失败瞬间的占锁者证据，不能据此断言旧问题根因已修复。
- Lisa 回执的持久查询返回 `committed`。插件 `start` 最终日志依次记录 `initial_prompted`、`started`、两条分别对应 Ralph→Lisa 和 Lisa→Ralph 的 `handed_off`、`stopped`；`stop` 动作返回成功。停止后快照为 `host_state=unclaimed`、`binding_state=stale`、generation 2、`turn=ralph`、round 2。两个命名测试 Server 的 `status server` 均为 `not running`。
- 本次没有修改 S4 阻断条件，也没有执行 Server 重启接续、长时间稳定性试验或默认环境前后差异审计。隔离目录暂保留以便复核；验收文档提交后可单独清理。
