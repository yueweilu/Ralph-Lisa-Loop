# S5 真实 GitHub 插件安装验收

日期：2026-11-05。基线 `8d6f9332c9ec3272c5bd972f0d45ee37bf291440`，来源 `yueweilu/Ralph-Lisa-Loop/integrations/herdr`。隔离根目录 `/tmp/rll-s5-install-20261105-0F6kai`，命名 Herdr 0.9.4 Server `rll-s5-install-0f6kai`。全程同时设置独立 `XDG_CONFIG_HOME`、`XDG_STATE_HOME` 和临时 npm 缓存；没有调用默认 Herdr 会话或修改 `super-rll`、S4 阻断逻辑。

| 检查 | 实际结果 |
| --- | --- |
| 安装前隔离 | 临时环境的 `plugin list --json` 为空，命名 Server 未运行；Herdr 报告的配置、日志和 socket 均在隔离根目录。启动命名 Server 后仍为空，socket 为该命名会话的临时路径。没有对默认环境做前后文件差异审计。 |
| GitHub 安装与构建 | `plugin install yueweilu/Ralph-Lisa-Loop/integrations/herdr --ref <完整 8d6f933 SHA> --yes` 退出 0。Herdr 预览并执行清单中的三条构建命令，报告安装成功；注册项的 `requested_ref`、`resolved_commit` 和托管 checkout 的 Git HEAD 都是同一完整 SHA。安装目录含 `cli/dist/cli.js`、插件清单和 `cli/LICENSE`；该 CLI 的 `host inspect --json` 返回 `status=ok`。 |
| 注册与 doctor | 隔离 `plugin list` 恰好一项，`enabled=true`、`source.kind=github`，清单为 10 个动作、4 个 Pane。真实插件 `doctor` 动作日志为 `succeeded`、输出 `ready`；Herdr 0.9.4、同仓 CLI `host_contract=true`、Claude/Codex 集成和登录检查均通过。此项未启动两席 Agent 或提交候选。 |
| 更新 | 写入仅指向临时项目的有效 `settings.json` 后，`plugin update ralph-lisa.loop --yes` 退出 0，返回 `already up to date`。注册 SHA 和配置文件 SHA-256 保持不变。由于安装源钉住该 SHA，本次没有发生跨提交版本替换或重新构建；实际升级路径尚未验收。 |
| 卸载与配置保留 | `plugin uninstall ralph-lisa.loop` 退出 0，隔离 `plugin list` 回到空列表。配置目录与 `settings.json` 保留，文件 SHA-256 未变。GitHub 托管 checkout 目录也仍存在，因此卸载只被验收为取消注册，不能称为清除全部安装文件。 |
| 重装复核与收尾 | 同一完整 SHA 再安装退出 0，生成新的托管 checkout；原配置目录和文件 SHA-256 仍不变，`doctor` 再次 `ready`。随后再次卸载，插件列表为空，命名 Server 正常停止。 |

配置文件的 SHA-256 在更新、首次卸载、重装和最终卸载后均为 `80c53f92f3d165b515fc5d39f6eeff0082c1104db89a03399884752ffd1dedd8`。本验收证明了隔离环境中的 GitHub 指定提交安装及配置保留；未验证实际跨提交更新、默认环境前后差异、长期运行或真实 Agent 交接。GitHub 安装从同仓源码构建 CLI，不代表 npm 已发布包已更新。
