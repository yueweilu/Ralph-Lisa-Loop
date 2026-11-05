# S5 跨提交更新验收清单

日期：2026-11-05。状态：待执行。此文档只为已安装的隔离插件准备更新目标，不代表更新已通过。

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
