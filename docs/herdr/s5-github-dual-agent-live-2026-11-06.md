# S5 GitHub 安装版双 Agent 闭环验收

日期：2026-11-06。状态：真实 Ralph→Lisa 交接通过；Lisa→Ralph 因唯一一次提交返回 `HOST_BUSY` 而未通过，未重试提交。只使用短路径临时根目录 `/tmp/h5-KnJRCH`、项目 `/tmp/h5-KnJRCH/project`、独立 XDG 配置/状态和 npm 缓存、命名 Herdr 0.9.4 Server `h5-knjrch`。未操作默认会话或 `super-rll`。

## 安装与双席

- 安装前隔离注册表为空，命名 Server 未运行，socket 位于隔离目录。GitHub 安装 `yueweilu/Ralph-Lisa-Loop/integrations/herdr --ref 0db3d54f0eeb482cdd44bdd3dec1ba5a412fdc16 --yes` 退出码 0；注册 `source.kind=github`，`requested_ref`、`resolved_commit` 和托管 checkout HEAD 均为该固定提交，插件版本 `0.1.1`。安装预览列出 `npm ci`、`npm run build`、`verify-package.mjs` 三个构建命令。
- 用安装 checkout 的 `cli/dist/cli.js` 对临时项目执行 `init --minimal`。插件 `settings.json` 仅设置该项目绝对路径。`doctor` 动作日志 `plugin-log-1` 为 `succeeded`、退出码 0、`status=ready`；Herdr 版本、同仓 CLI host contract、Claude/Codex 集成与登录检查均通过。
- 项目 Workspace `w1` 中 Ralph/Claude 为 `w1:p1`，Lisa/Codex 为 `w1:p2`。用户仅授权本临时项目的 Claude 目录信任提示；Codex 更新提示选择跳过，未更新 CLI。Lisa 在一次不读写文件的就绪提示后形成原生会话引用。`seat-preflight` 动作日志 `plugin-log-2` 为 `succeeded`、退出码 0、`status=ready`，两席都有原生会话指纹；本文不保存原始原生会话 ID。

## 初始投递与候选门禁

- 从项目 Workspace 调用一次插件 `start`。CLI 快照为 `host_state=claimed`、`binding_state=bound`、generation 0、`turn=ralph`，两席已绑定。协调器记录为 `active`，`initial_status=accepted`；隔离插件状态目录只有一份 generation 0、目标 `w1:p1` 的 `accepted` 初始投递，消息 SHA-256 为 `bec06130f4e5fe44422fe276316c16b8effcb4830e3edba7edb21e141525fbb9`。Ralph Pane 实际显示 `Initial Ralph-Lisa task`，要求读取 `.dual-agent/task.md`、当前 RLL 状态、准备候选并遵守逐份人工确认门禁。Lisa Pane 未收到该任务。
- Ralph 在真实 Pane 写出首份草稿并从自己的工作状态调用 `candidate-propose.mjs`；候选 `c36723e2-b2da-4062-97a9-90ef18990240`、正文 SHA-256 `d1d498b4c0304dedaea02704cd1868bb77b00a2f4fd454c38be30b9dac6cf249`，返回 `candidate_observed`、`source_verification=unverified`、`commit_ready=false`。只读 `commit-check` 返回 `INVALID_SUBMISSION`：首行 `## [PLAN]` 不满足标签必须从行首开始的格式。该候选没有来源确认或正式提交。
- Ralph 在原 Pane 新建只移除首行 `## ` 前缀的草稿并再次从自己的工作状态提议。新候选 `6b9d88e5-7225-48be-8dcb-708897d9b877`、正文 SHA-256 `79c04685bbafd2fb5206ae9c75af09500f6926b3f3e43602bd98e742aff73896`，CLI `candidate-show` 返回完整正文和相同摘要。`commit-check` 退出码 0，状态 `awaiting_source_confirmation`，策略 `pass`，测试门禁 `not_enabled`，`source_verification=unverified`、`human_confirmation=absent`。向用户展示完整正文与摘要后，用户只对这份候选确认 Ralph Pane 来源并授权一次提交。复核正文、摘要、租约、generation 0、绑定代次 2 和预检状态未变；`confirm-candidate` 返回 `human_asserted`，随后唯一一次 `host commit` 返回 `committed`，generation 0→1、`turn=lisa`，策略 `pass`，测试门禁 `not_enabled`。同请求持久回执可由 `host receipt` 读回。人工断言不改变 `source_verification=unverified`。

## 真实交接与 Lisa 门禁

- 插件保存恰好一份 generation 1、目标 `w1:p2` 的 `accepted` 交接，消息 SHA-256 为 `387b6e1acd23354dad2dd54950e90c201450a8d87e39aa4ba408c0eb27d26f5f`。Lisa/Codex Pane 实际显示 `Ralph-Lisa committed handoff` 开头的提示，并读取当前 RLL 状态和 Ralph 计划；Codex 界面将长提示折叠，Pane 读取未完整显示其中的回执 ID。CLI 快照为 generation 1、`turn=lisa`，最新回执与 Ralph 提交相同。插件 `start` 最终日志 `plugin-log-3` 含一条 `handed_off`，目标 `w1:p2`。
- Lisa 在自己的真实 Pane 写出 `lisa-candidate.md` 并用公开仓 CLI 提议候选 `c30048ed-25e6-46e1-bf79-78bacc8e7230`，正文 SHA-256 为 `083015e490fff052d1e654b8eaff0863d3fa197ee989959aaccf26620b7e5fb6`。她发现全局 `ralph-lisa` 无 `host` 命令，转而使用公开仓构建 CLI；操作者随后用本次 GitHub 安装 checkout 的 CLI 独立读取完整候选并预检。`commit-check` 为 `awaiting_source_confirmation`、策略 `pass`、测试门禁 `not_enabled`。用户对这份完整正文及摘要单独确认 Lisa Pane 来源并授权一次提交；复核后 `confirm-candidate` 返回 `human_asserted`，再查 `commit-check` 为 `human_source_asserted`。
- 对 Lisa 请求只调用一次 `host commit`，返回退出码 4、`HOST_BUSY`，没有成功回执。按用户要求不重复提交；只读 `host receipt` 对该请求返回 `unknown`，命令锁检查为 `absent`。CLI 快照仍为 generation 1、`turn=lisa`，最新回执仍是 Ralph 那份；插件目录没有 generation 2 交接记录。因此 Lisa→Ralph 没有发生，本次不能称为完整双向闭环。没有伪造来源、跳过确认或修改 S4 阻断条件。

## 停止与清理

插件 `stop` 动作日志 `plugin-log-4` 为 `succeeded`、退出码 0、`status=stopped`；`start` 日志 `plugin-log-3` 最终为 `succeeded`，按顺序记录 `initial_prompted`、`started`、一次目标 Lisa 的 `handed_off`、`stopped`。停止后 CLI 快照为 `host_state=unclaimed`、`binding_state=stale`、generation 1、`turn=lisa`。第二请求回执再次只读确认为 `unknown`。隔离插件配置的 `settings.json` SHA-256 为 `44317e490c21bf684739730660c09264c1f135905b02c4eb89f61be079b0ab49`。

隔离插件 `uninstall` 退出码 0，隔离 `plugin list --json` 返回空列表；配置文件在卸载后仍为相同 SHA-256。命名 Server `server stop` 退出码 0，`status server` 确认为 `not running`。首次删除临时目录的工具调用被中断，随即只读检查证实目录仍在；仅对 `/tmp/h5-KnJRCH` 重试删除退出码 0，检查该路径已不存在。未操作默认会话或其他项目。
