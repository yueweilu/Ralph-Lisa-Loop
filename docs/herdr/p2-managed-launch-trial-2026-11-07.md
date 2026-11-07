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

## 同日补充：复用 Workspace 与输入 overlay

在同一命名测试 Server 中，对尚未初始化、但已有 Workspace `w1` 的临时项目使用短命令并显式传入复用 Workspace ID。CLI 在 `w1` 下创建 Ralph tab 和控制 tab，返回 `workspace_id=w1`、`blocked_role=ralph`；只读 Workspace 列表仍只有原有 `w1/w2/w3`，没有为这个项目新建另一个 Workspace。未确认 Claude 信任提示，Server 再次停止。

插件 manifest `0.1.4` 已声明 `start-task` 为 `overlay`，输入脚本将所选 Workspace 项目和任务转交同一个 `herdr-rll` 启动服务。脚本测试覆盖无 Workspace 上下文拒绝、已有会话拒绝覆盖。**headless 命名 Server 不能验证 overlay 的屏幕呈现**：从 Server 外调用 `plugin pane open --placement overlay`，即使显式指定 Workspace 和目标 Pane，Herdr 0.9.4 仍返回 `invalid_params: overlay and popup plugin panes target the active pane`。因此 overlay 的 TUI 内点击、任务输入与实际启动仍待可见客户端验收；不能把这次 headless 错误写成插件 UI 已通过。
