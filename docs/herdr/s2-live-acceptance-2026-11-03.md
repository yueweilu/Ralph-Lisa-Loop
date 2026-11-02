# S2 Herdr 插件运行中验收清单

状态：**待执行**。2026-11-03 已在 Herdr 0.9.4 上完成隔离 `plugin link`，但尚未在运行中的 Herdr 服务内调用动作或打开控制 Pane。此清单用于补齐该验收；不能把动作启动回执当作动作执行成功，也不能把 S2 验收当作 S3 双 Agent 交接验收。

## 1. 隔离会话与前置条件

从普通终端以临时 XDG 目录启动专用 Herdr 测试会话；整个 Herdr 服务及后续 CLI 命令使用相同的 `XDG_CONFIG_HOME` 和 `XDG_STATE_HOME`。`HERDR_CONFIG_PATH` 单独设置不能隔离插件注册。默认用户环境不安装本插件。

```sh
HERDR_TEST_ROOT="$(mktemp -d)"
XDG_CONFIG_HOME="$HERDR_TEST_ROOT" XDG_STATE_HOME="$HERDR_TEST_ROOT" \
  herdr --session rll-s2
```

进入这个 Herdr 会话的窗格后，先执行 `test "${HERDR_ENV:-}" = 1`，并检查 Herdr 版本至少 0.9.4，以及 `XDG_CONFIG_HOME`、`XDG_STATE_HOME` 均指向刚才的临时目录。测试过程中只使用这个会话，不切换到用户的默认 Herdr 服务。

## 2. 样板项目与插件配置

使用新建的空目录作为 RLL 样板项目。先将 `RLL_CHECKOUT` 设为公开仓 `Ralph-Lisa-Loop-herdr` 的绝对路径，不能设为内部 `super-rll` 路径。

```sh
RLL_CHECKOUT="/absolute/path/to/Ralph-Lisa-Loop-herdr"
RLL_S2_PROJECT="$(mktemp -d)"
node "$RLL_CHECKOUT/cli/dist/cli.js" init --minimal "$RLL_S2_PROJECT"
herdr plugin link "$RLL_CHECKOUT/integrations/herdr"
herdr plugin list --json
herdr plugin action list --plugin ralph-lisa.loop
herdr plugin config-dir ralph-lisa.loop
```

预期：`plugin list` 含 `ralph-lisa.loop`；动作列表有 `doctor/status/start/pause/resume/stop`；manifest 含 `control` Pane。将 `settings.json` 放在 `plugin config-dir` 返回的目录，内容为：

```json
{
  "project": "<RLL_S2_PROJECT 的绝对路径>",
  "rll_cli_argv": ["node", "/absolute/path/to/Ralph-Lisa-Loop-herdr/cli/dist/cli.js"]
}
```

确认 `node "$RLL_CHECKOUT/cli/dist/cli.js" host snapshot --project "$RLL_S2_PROJECT" --json` 可读取该样板项目。不要在已有工作项目执行 `init`。

## 3. 真实动作与控制 Pane

在 Herdr 管理的窗格中调用：

```sh
herdr plugin action invoke ralph-lisa.loop.doctor
herdr plugin action invoke ralph-lisa.loop.status
herdr plugin log list --plugin ralph-lisa.loop --limit 10
herdr plugin pane open --plugin ralph-lisa.loop --entrypoint control --placement split --workspace "$HERDR_WORKSPACE_ID" --no-focus
```

`action invoke` 的 JSON 只证明 Herdr 接受并启动了命令。继续查看插件日志中的退出状态与完整 JSON 输出；`doctor/status` 各应输出一个 `schema: 1` 对象。如果 Claude/Codex 的 Herdr 集成仍是 `not installed`，`doctor` 应返回 `needs_setup`、`AGENT_INTEGRATIONS_REQUIRED`，而非 `ready`。已初始化样板项目的 `status` 应包含真实 `snapshot`，同时保留该集成缺失提示。控制 Pane 应能显示相同诊断和 RLL 轮次摘要。关闭测试 Pane 后，样板项目的 RLL 状态摘要应保持一致。

最后在**未设置临时 XDG 变量**的普通终端执行 `herdr plugin list --json`，确认默认环境未注册此插件。测试留下的临时目录与专用会话应记录位置，便于复现或清理。

## 4. 通过标准与后续边界

| 项目 | 通过标准 |
|---|---|
| 注册 | 隔离 Herdr 服务能列出准确的六个动作和一个控制 Pane；默认环境列表不含本插件 |
| 动作 | `doctor/status` 的启动回执、命令日志、退出码及 JSON 输出均已取得；当前环境的缺集成结果与日志一致。缺 CLI、未登录、版本不符由 `actions.test.mjs` 的隔离测试覆盖，不要求退出真实账号来测试 |
| 只读性 | `status` 前后样板项目的 `state_digest` 一致；没有宿主租约、提交或 Agent 启动副作用 |
| 界面 | `control` Pane 在 Herdr 中实际打开，显示诊断与样板项目状态，刷新后仍指向同一项目 |

满足以上条件才可标记 S2 运行中验收通过。`start/pause/resume/stop` 当前仍应返回 `S2_COORDINATOR_PENDING`；S3 才实现真实 Claude/Codex 双席启动、ID 绑定和自动交接。
