# P0 实测：外部启动上下文与候选来源观察（2026-11-06）

## 范围与隔离

本次只验证 [一条命令启动实施方案](herdr-auto-task-launch-implementation-2026-11-06.md) 中两个待定问题：

1. 外部 CLI 能否把**指定项目和 Workspace**稳定交给长期运行的 Herdr 插件进程；
2. Agent Pane 的环境变量与 Herdr 实时查询能否证明候选确由该 Agent 产生。

环境为本机 Herdr `0.9.4`、新建 `/tmp/rh-DqWC8k`、独立 `XDG_CONFIG_HOME`/`XDG_STATE_HOME`、命名 Server `rll-probe-dqwc8k`。只链接临时探针插件 `rll.context-probe`；未安装或改动正式 Ralph-Lisa 插件，未初始化 RLL 业务会话、提议候选或提交回执，也未操作默认 Herdr 会话和 `super-rll`。真实 Codex 只执行只读探针和短时 `sleep`；其原生会话引用未记录在本文。

## 测试 1：外部 CLI 到插件

| 操作 | 直接观察 |
|---|---|
| 创建项目 Workspace `w1`，焦点位于 `w1`；从普通终端执行 `herdr --session rll-probe-dqwc8k plugin action invoke rll.context-probe.start` | action 收到 `workspace_id=w1`、目标项目 cwd；返回的是 `status=running` 的异步命令日志，非启动完成回执 |
| 再创建并聚焦另一个 Workspace `w2`，不改变命令，重复 invoke | action 收到 `workspace_id=w2` 和另一个 cwd；即使调用者原意仍是项目 `w1`，action 也取当前焦点 |
| 在 `w2` 保持焦点时，执行 `plugin pane open --plugin rll.context-probe --entrypoint helper --workspace w1 --no-focus` | helper Pane `w1:p4` 的 `HERDR_WORKSPACE_ID=w1`，`HERDR_PLUGIN_CONTEXT_JSON.workspace_cwd` 为目标项目 |
| 由该 helper 进程内部再执行 `herdr plugin action invoke rll.context-probe.start` | 新 action **仍收到 `w2`**，没有继承 helper 的 `w1` 调用上下文 |
| 在 `w2` 保持焦点时，以 `--workspace w1` 打开前台持续运行的受管理插件 Pane | 该 Pane 收到 `w1` 和项目上下文；独立心跳持续增长。关闭这个测试 Pane 后，它的进程退出，Pane ID 随即不可查询 |
| 使用 `plugin pane open ... --cwd <project>` 打开仍以相对路径 `node probe.mjs` 启动的探针 Pane | API 返回 Pane ID，但探针没有产生预期记录，Pane 很快消失。未取得该次子进程 stderr，**仅能确认这组参数未成功运行探针**；实施方案采用插件根目录默认 cwd 与显式 Workspace，不依赖这组参数 |

**结论：** 0.9.4 中 `plugin action invoke` 无指定 Workspace 参数，外部命令及 helper 内再次 invoke 都会取 Server 当前焦点。将“helper 转 action”作为项目绑定路径不安全。已实测的可定址路径是：外部 CLI 显式建立/选择目标 Workspace，使用 `plugin pane open --workspace <id>` 在其中启动**受管理、前台长期运行**的协调器 Pane；协调器必须核对启动意图、Workspace cwd 和 RLL 项目真实路径。关闭 Pane 会结束进程，但它能否在异常退出前释放 RLL 租约仍需实现和故障验收，不能由本次无业务状态探针推断。

本机 `herdr plugin pane open --help` 的 `--placement` 只列 `overlay/split/tab/zoomed`，**没有 `popup`**。官网当前插件文档描述 popup，但本机 0.9.4 不支持该 CLI 选项。因此首版任务输入使用 `overlay`；若之后升级 Herdr 并采用 popup，必须重新实测并提高 `min_herdr_version`。

## 测试 2：真实 Codex Pane 的来源观察

1. 在项目 Workspace 的 `w1:p1` 通过 Herdr `agent start --kind codex -- --no-daemon` 启动真实 Codex。首次出现 Codex 更新选择界面；仅按其提示跳过更新后，Agent 进入可交互状态，Herdr 返回可用原生会话引用。
2. 让该 Codex 从自己的工具进程运行只读 Node 探针。探针观察到 `HERDR_ENV=1`、`HERDR_WORKSPACE_ID=w1`、`HERDR_PANE_ID=w1:p1`、测试 socket 路径存在，Codex 进程标记存在；但从其工具进程调用 `herdr pane current --current` 退出码为 1，stderr 为 `PermissionDenied: Operation not permitted`。这是**本次 Codex 沙箱配置**下的结果，不能直接概括所有权限配置。
3. 在 Herdr Pane **外**的普通终端，仅设置相同的 `HERDR_ENV`、Workspace、Pane 和测试 socket 环境变量，调用 `herdr pane current --current` 成功返回 `w1:p1`。在 Codex 执行短时任务而 Herdr 状态为 `working` 时，外部伪造环境的只读查询同样返回该 Pane；独立 `agent get` 也显示 `working`。没有写候选或调用任何 RLL 提交命令。

**结论：** `HERDR_*` 环境变量可被同一用户的外部进程设置；`pane current --current` 加 `agent get=working` 只证明“指定 Pane 当前有这个 Agent”，不能证明**调用命令的进程就是该 Agent**，更不能证明候选正文由它编写。现有 `candidate-propose.mjs` 的 Pane 核对可保留用于定位和诊断，**不可升级成自动来源证明**。本次还观察到 Codex 工具进程可能因沙箱无法访问 Herdr socket，Agent 内调用适配器的可用性也要单独验证。

## 对实施方案的修正

1. CLI 启动优先采用“显式 Workspace + 受管理协调器 Pane”，避免焦点竞态；沿用现有 action 的人工入口时，不允许把外部 CLI 的焦点当项目选择证据。
2. Herdr 0.9.4 的任务输入用 `overlay`，不承诺 popup。
3. **不能**以 `bound_pane_observed` 自动解除当前逐份人工来源确认门禁。若产品要真正无人值守，须明确选择以下之一：
   - **会话级授权模式：** 用户在启动时授权该会话自动提交合格候选，明确记录 `source_verification=unverified`，并接受同一 OS 用户/项目进程可以请求候选的信任边界；RLL 策略和测试门禁仍执行。这是新的产品政策，不是“Herdr 已验证来源”。
   - **强来源模式：** 等 Herdr/Agent 提供可验证的调用者身份或签名事件，再设计自动来源证明；当前 0.9.4 的已测试 API 未提供所需证据，工期无法按旧估算承诺。
4. 如果两种模式均未得到产品决策，现有逐份人审路径保持不变；可交付“自动启动/交接”，不能宣传“完整无人值守”。

## 验证边界与收尾

本次没有运行 RLL 双席正式提交，没有测试新协调器在真实租约下的异常退出/重启，也没有证明长期稳定性。上述探针只验证 Herdr 上下文、进程和调用者观察能力。命名 Server 已正常停止；探针进程与 Codex Pane 均已结束。临时目录 `/tmp/rh-DqWC8k` 已删除，并以路径不存在复核；证据结论保存在本文，不保留含原生会话引用的临时 Server 状态文件。
