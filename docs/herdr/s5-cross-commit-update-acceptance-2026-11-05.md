# S5 跨提交更新验收清单

日期：2026-11-05。状态：隔离环境内的真实跨提交更新已通过；清理结果见下文。未运行双 Agent。

## 已保留的起点

- 独立 XDG 根目录：`/tmp/r5-z21b2I`；命名 Server：`rll-s5-z21b2i`。首次尝试的较长临时路径因 Unix socket 路径过长失败；本起点来自短路径的新隔离目录。
- GitHub 来源：`yueweilu/Ralph-Lisa-Loop/integrations/herdr`。安装时的 `requested_ref` 是可移动分支 `feat/herdr-s4-server-epoch-fence`，`resolved_commit`、托管 checkout HEAD 和当时远端 HEAD 均为 `f66ce124c424699c457f5bd901d87bb90f1ad772`。
- 插件 `ralph-lisa.loop` 已启用，Server 仍运行；未更新、卸载或启动双 Agent。隔离配置文件 `settings.json` 的 SHA-256 为 `63eed426a95f8139de4c78a67b25594d625a1634bc9ba2b7c277fc690eb49f82`，仅指向隔离测试项目。

## 本次目标与检查

后续提交将插件 manifest 版本从 `0.1.0` 升至 `0.1.1`，作为真实跨提交更新的可见标记；不改变任务状态、人工来源确认或交接逻辑。该提交推送并通过 CI 后，在**同一个隔离 XDG 环境**中执行一次 `plugin update ralph-lisa.loop --yes`。更新前后分别保存只读 `plugin list --json`、配置摘要及托管 checkout HEAD，并核对：

1. 更新不是 `already up to date`；注册项仍为 `enabled=true`、`source.kind=github`，`requested_ref` 仍是上述分支。
2. `resolved_commit` 与新托管 checkout HEAD 均为新的远端分支 SHA；manifest 版本为 `0.1.1`，构建命令成功，同仓 `cli/dist/cli.js` 的 `host inspect --json` 返回 `status=ok`。
3. `settings.json` 的路径、内容摘要和仅指向隔离测试项目的约束不变；真实插件 `doctor` 再次返回 `ready`。
4. 更新结果、旧/新托管目录、动作日志和任何失败写入本文档。没有已运行的插件 Pane，因此此次不验证旧进程持续运行；也不启动双 Agent 或提交候选。

如更新结果不确定，先只读核对注册项、checkout、配置和日志，不重复发起更新。验收完成后仅清理本次隔离插件与命名 Server，确认插件列表为空；不得操作默认 Herdr 环境。默认环境前后文件差异、干净机器安装和长期运行仍另行验收。

## 实际执行结果

全程使用 `XDG_CONFIG_HOME=/tmp/r5-z21b2I/config`、`XDG_STATE_HOME=/tmp/r5-z21b2I/state`、`npm_config_cache=/tmp/r5-z21b2I/npm-cache`，并指定 `--session rll-s5-z21b2i`。更新前只读检查：唯一注册项 `ralph-lisa.loop` 已启用，版本 `0.1.0`，`source.kind=github`，`requested_ref=feat/herdr-s4-server-epoch-fence`，`resolved_commit=f66ce124c424699c457f5bd901d87bb90f1ad772`。旧 checkout `/tmp/r5-z21b2I/config/herdr/plugins/github-installations/ralph-lisa.loop-aa85a31010d8/82884-0/checkout` 的 HEAD 同为 `f66ce124c424699c457f5bd901d87bb90f1ad772`。`settings.json` 仅含 `project=/tmp/r5-z21b2I/project`，SHA-256 为 `63eed426a95f8139de4c78a67b25594d625a1634bc9ba2b7c277fc690eb49f82`。远端分支 HEAD 为 `6c3a672221f2366f88ba331b3542c2d7bd5eca32`。

只执行一次 `plugin update ralph-lisa.loop --yes`，退出码 0，输出 `Updated ralph-lisa.loop`，并列出三条构建命令：`npm ci`、`npm run build`、`verify-package.mjs`。更新后只读检查：唯一注册项仍已启用，`source.kind=github`，`requested_ref` 仍为 `feat/herdr-s4-server-epoch-fence`，版本 `0.1.1`，`resolved_commit=6c3a672221f2366f88ba331b3542c2d7bd5eca32`。新 checkout `/tmp/r5-z21b2I/config/herdr/plugins/github-installations/ralph-lisa.loop-aa85a31010d8/87452-0/checkout` 的 HEAD 同为该 SHA。同仓 `cli/dist/cli.js host inspect --project /tmp/r5-z21b2I/project --json` 退出码 0，返回 `status=ok`；该临时项目未初始化，因此 `initialized=false`，此检查只证明 CLI 命令可运行。

真实插件 `doctor` 动作日志 `plugin-log-1` 为 `succeeded`、退出码 0、输出 `status=ready`；Herdr 0.9.4、同仓 CLI host contract、Claude/Codex 集成及登录检查均通过。更新后 `settings.json` SHA-256 仍为 `63eed426a95f8139de4c78a67b25594d625a1634bc9ba2b7c277fc690eb49f82`。没有运行插件 Pane、双 Agent 或候选流程；此结果不证明真实会话接续、默认环境无文件差异、干净机器安装或长期稳定性。

清理：仅在该隔离环境执行 `plugin uninstall ralph-lisa.loop`，退出码 0；随后 `plugin list --json` 返回空列表，配置文件在卸载后仍保持同一 SHA-256。`server stop` 退出码 0，`status server` 确认为 `not running`。最后删除 `/tmp/r5-z21b2I`，检查该路径已不存在。未操作默认会话。
