# P2 受管理 Pane 启动试跑（2026-11-07）

## 本次范围

在 `feat/herdr-auto-task-launch` 的本地未提交 P2 代码上，以独立 XDG 目录、命名 Herdr Server `rll-cli-probe` 和新建 `/tmp/rll-p2-blocked-4bGrRs` 项目试跑 `ralph-lisa auto --host herdr --project ... "Write a README in this disposable project"`。插件是该分支的本地链接；没有操作默认 Herdr 会话或 `super-rll`。

## 直接观察

1. 外部 CLI 安全初始化 `.dual-agent`，写入正式任务、会话身份和不可变启动请求；创建目标 Workspace `w3`，根 Pane 为 `w3:p1`。受管理协调器在同一 Workspace 的独立 tab Pane `w3:p2` 运行。控制 Pane 不在 Agents 列表中。
2. Ralph/Claude 被启动在 `w3:p1`，Herdr 将其状态报告为 `blocked`。CLI 约 5 秒返回 `status=needs_input`、`code=AGENT_BLOCKED`、`blocked_role=ralph`、`blocked_pane_id=w3:p1`，没有把等待写成启动成功。
3. 只读 `host snapshot` 仍为 `host_state=unclaimed`、`generation=null`、`binding_state=unbound`；本次没有领租约、正式投递、候选或提交。没有确认这个新临时项目的 Claude 目录信任提示。
4. 同一隔离配置下，先行形态探针证实 Herdr 0.9.4 的 `workspace create` 返回 `result.workspace` 与 `result.root_pane`；`plugin pane open` 返回 `result.plugin_pane.pane`。实现已按真实返回结构读取 ID，而非猜测。
5. 命名 Server 已执行正常停止，`status server --json` 返回 `not_running`。临时项目和隔离配置暂保留供本切片核查；默认环境未操作。

## 已验证与未验证

- CLI 本地全套回归在接线前为 503/503；接线后插件 `actions.test.mjs` 9/9、协调器现有完整套件 23/23，以及随后针对本次改动的 legacy 启动和无效请求用例 2/2 通过。`node --check` 与 `git diff --check` 通过。
- 真实 Herdr 只验证了项目定址、受管理控制 Pane、Ralph 启动与信任阻断。Lisa 原生会话、两席绑定、首任务单次投递、协调器关闭后的租约状态和重启恢复仍待隔离真实验收。
- 本切片没有开启候选自动提交；`--full-auto` 参数当前只映射 Agent 启动权限。候选来源仍是 `unverified`，正式提交继续要求逐份人工确认。
- 旧 `start` action 保留兼容；上述真实试跑不是完整自动协作验收。
