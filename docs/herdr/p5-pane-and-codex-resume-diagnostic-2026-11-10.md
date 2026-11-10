# P5 后续核查：重绑 Pane 退出与 Codex resume 引用

日期：2026-11-10。基线 `dcfcb176734a4f6aba04bb6df70d3c8857c1581c`；Herdr 0.9.4。仅在新的 `/private/tmp/rp-8tJPOA`、XDG 隔离配置和命名 Server `rll-rp-8tjpoa` 运行；未操作默认会话、`super-rll` 或公开仓源码。承接 [固定 GitHub 安装验收](p5-fixed-github-restart-tmux-acceptance-2026-11-10.md)。

## 重绑 Pane：定位为测试调用错误

前次打开 `rebind` 插件 Pane 时给 `plugin pane open` 额外传了 `--cwd /private/tmp/hd6-JqpTZK/project`。插件清单的命令是相对路径 `node rebind.mjs`；`--cwd` 将进程工作目录改为项目目录，该目录没有 `rebind.mjs`。因此 Herdr 的“Pane 已打开”只表示终端已创建，子进程随即退出。

为区分此现象与 RLL 重绑逻辑，在独立命名 Server 链接只包含 `node hold.mjs` 的最小探针插件：

| 调用 | 观察 |
|---|---|
| `plugin pane open ... --placement tab --workspace w1 --cwd <项目目录>` | Herdr 先返回 Pane ID；Server 日志显示子进程约 0.11 秒后以退出码 1 结束；探针脚本未启动，Pane 自动消失。 |
| 相同命令去掉 `--cwd` | Pane 在插件根目录保持运行，打印 `PANE_PROBE_READY`；探针记录 `stdin.isTTY=true`，且 Herdr 注入了项目 Workspace 上下文、插件目录和命名 Server socket。 |

结论：此前把这次自动关闭列为插件界面问题不准确。应使用插件清单的默认工作目录，不向相对脚本命令覆盖 `--cwd`；项目由插件设置和 `HERDR_PLUGIN_CONTEXT_JSON` 定位。前次第二次重绑是同一固定 checkout 的协调器命令完成，**尚未在有效恢复证据下重新走一次正确打开的完整 `rebind` Pane**。此处没有产品源码修复。

## Codex resume：空闲时未上报原生引用

在同一命名 Server 的另一个临时 Workspace 启动 `codex --no-daemon`，明确清空测试 Pane 的继承 `CODEX_THREAD_ID`。启动后 `agent get` 显示 `idle`，但无 `agent_session`；第一条仅回复 OK 的提示后，Herdr 收到原生引用。用 Codex 自身的 `/exit` 正常退出，再以该 ID 执行 `codex resume <ID> --no-daemon --sandbox workspace-write --ask-for-approval never`。恢复后的 `agent start` 和等待约 5 秒的 `agent get` 均显示 `idle`、可交互，但**无** `agent_session`。一条只回复 RESUMED、不读写文件的诊断提示之后，Herdr 又上报与恢复前相同的引用。

这是 Herdr 0.9.4 与本机官方 Codex 集成在该启动时序下的实际观察；尚未证明 `SessionStart` 未执行、hook 输入字段缺失或 Herdr 服务端丢弃报告中的哪一项。不能凭进程命令行中的 resume ID 绕过插件的原生指纹检查，也不能把额外诊断提示算作 RLL 的旧交接重放。恢复时若引用仍缺失，应保持暂停并明确提示需要人工核查；后续可在隔离 hook/日志探针中定位具体原因。

测试 Server 已停止。该探针没有执行 RLL 候选提议、来源确认或正式提交；没有修改产品代码。
