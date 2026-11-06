# Herdr v0.1.2 固定提交真实启动重试与双向交接验收

日期：2026-11-06。结论：从 GitHub 固定提交 `a75cd3925220089de2dec2e383b151b7b4797544` 安装的 Herdr 插件，在隔离 macOS 会话中完成真实首次启动重试、两席绑定、初始任务单次投递，以及 Ralph→Lisa、Lisa→Ralph 各一次经人工来源确认的正式提交和交接。本次验证的是该有界场景，不是长期稳定性或 Server 重启接续。

## 环境与安装

- 隔离根目录 `/tmp/h7-F1pQxe`，临时项目 `/private/tmp/h7-F1pQxe/project`，命名 Herdr 0.9.4 Server `h7-f1pqxe`；独立 XDG 配置、状态和 npm 缓存。没有操作默认 Herdr 会话或 `super-rll`。
- 安装前隔离插件列表为空。`plugin install yueweilu/Ralph-Lisa-Loop/integrations/herdr --ref a75cd3925220089de2dec2e383b151b7b4797544 --yes` 成功，三条 manifest 构建命令完成；注册的 `requested_ref`、`resolved_commit`、托管 checkout HEAD 均为指定 SHA，插件版本 `0.1.2`、平台 `macos`。
- 插件设置仅指向临时项目，`settings.json` 的 SHA-256 在安装后与卸载后同为 `c2093e9528d75776f428f00369e03c8370cad0b859699ef1bb7dcd5ae9dea1c6`。同仓 `cli/dist/cli.js` 初始化项目；真实 `doctor` 返回 `ready`，Herdr、host contract、Claude/Codex 集成及登录检查通过。

## 首次启动失败后的同状态重试

| 阶段 | 只读或持久证据 |
|---|---|
| 首次 `start` | 插件创建 Workspace `w2` 和 Ralph Pane `w2:p1`。Claude 显示对新建临时项目的目录信任提示；行动日志先报 `AGENT_BLOCKED`，后以 `AGENT_READY_TIMEOUT` 停止。CLI 保持 `host_state=unclaimed`、`generation=null`、`candidate_count=0`；插件仅有失败 `record.json`，保存原 Workspace、Pane、Terminal ID，没有 lease 或初始投递文件。 |
| 目录信任 | 用户仅授权 `/private/tmp/h7-F1pQxe/project` 的 Claude 信任提示。确认后，原 `ralph` Agent 在 `w2:p1` 恢复为可交互，原生 Claude 会话引用出现。 |
| 第二次 `start` | 使用**同一 Server、同一插件状态目录**恢复原 Ralph Pane，随后在 `w2` 创建 Lisa Pane `w2:p2`。Codex 显示版本更新提示，选择 `Skip`，没有更新 Codex；本次在两席都准备好前返回 `AGENT_NOT_READY`，仍未领租约或投递初始任务。 |
| 第三次 `start` | 两席就绪后再次从同一记录恢复，未再创建 Workspace 或 Pane。CLI 领取租约并绑定 `w2:p1`、`w2:p2`，`generation=0`、`turn=ralph`；插件只有一份 `accepted` 初始投递，Ralph Pane 收到提示。提示中包含托管 checkout 的同仓 CLI 绝对命令。 |

本场景真实验证了 `AGENT_READY_TIMEOUT` 与 `AGENT_NOT_READY` 后的安全重试。`agent_pane_busy` 的限定重试仍只有模拟回归覆盖；旧版缺少 Terminal ID 的失败记录不能由此推断可重试。

## 候选、人工门禁与双向交接

| 轮次 | 来源与只读预检 | 单次正式提交与交接 |
|---|---|---|
| Ralph，generation 0 | Ralph/Claude 在自己的 Pane 写出 `[PLAN]`。首稿候选 `3a2604dc-818d-47ef-bcc6-d15eda4cc968` 得到非阻断的 `plan-test-plan` 警告，未提交。协调器暂停后，Ralph 在同 Pane 提议修订版 `50943e1a-971b-454e-aabc-7342b8b9cd1d`，SHA-256 `d36f59020946dfd1d5bbb7966bd2f7a0f1c81e029b012a5df5771efd26adbbe1`；协调器恢复 `active`。`commit-check=awaiting_source_confirmation`、`policy=pass`。 | 用户审阅修订版正文与摘要后单独接受来源并授权一次提交。请求 `ce29eceb-1bd4-472f-8ddf-8b29922a874b` 的 `confirm-candidate=human_asserted`；唯一一次 `host commit=committed`，游标 0→1、`turn=lisa`。插件对该请求只有一份指向 `w2:p2` 的 `accepted` 投递；Lisa Pane 收到交接并开始审查。 |
| Lisa，generation 1 | Lisa/Codex 在自己的 Pane 提议 `[NEEDS_WORK]` 候选 `cb4ef9f2-4181-40b0-af96-a165d024e458`，SHA-256 `c0e0c6ca6e87afc10a33bba8c0e6d56e674211c295df10646547925494a9771d`。内容要求明确 README 第二句话，并指出 Ralph 测试计划的句号/行数检查不能证明两句内容准确。`commit-check=awaiting_source_confirmation`、`policy=pass`。 | 用户对这份候选单独接受来源并授权一次提交。请求 `1ddcc6f8-ce06-4ed5-a28b-8f20d2ea4ff6` 的 `confirm-candidate=human_asserted`；唯一一次 `host commit=committed`，游标 1→2、`turn=ralph`、round 1→2。持久 `receipt` 为 `committed`；插件只有一份指向原 `w2:p1` 的 `accepted` 投递，Ralph Pane 显示该回执的交接提示一次。 |

两份正式提交的 `source_verification` 仍是 `unverified`，人工来源断言单独记录，没有冒充自动来源证明。测试门禁为 `not_enabled`。期间一次**只读** Lisa 回执查询短暂返回 `HOST_BUSY`，稍后只读复查得到持久 `committed`；没有重发正式提交。临时项目未创建 `README.md`，候选总数为 3（含未提交的 Ralph 首稿）。

## 停止与范围

- 插件 `start` 日志依次记录一条 `initial_prompted`、一条 `started`、分别对应两份回执的两条 `handed_off`、一条 `stopped`。`stop` 动作成功；最终 CLI 为 `host_state=unclaimed`、`binding_state=stale`、`generation=2`、`turn=ralph`、round 2。
- 隔离插件已卸载，注册表为空；命名 Server 已停止。`/tmp/h7-F1pQxe` 暂保留以便复核。本次只更新验收文档，不改插件代码、默认 Herdr 会话或 `super-rll`。
- 本次没有验证 Server 重启接续、长时间稳定性、真实 `agent_pane_busy` 触发、Linux Herdr 运行，也没有定位历史 `HOST_BUSY` 或 `ACTIVE_SNAPSHOT_MISMATCH` 的根因。发布到上游默认分支与 Marketplace 仍按[发布核对](s5-release-readiness-audit-2026-11-06.md)单独推进。
