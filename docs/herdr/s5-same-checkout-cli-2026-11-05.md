# S5 Herdr 插件使用同仓 CLI

日期：2026-11-05。此实现位于隔离工作区，未操作真实 Herdr 会话。

## 决策与边界

Herdr 的 GitHub 插件安装支持从公开仓子目录读取清单，并在注册前执行清单中的 `[[build]]` 命令。插件清单现在构建仓库同一版本的 `cli/`，再运行发布包门禁。插件的四个 CLI 入口共用同一个解析函数，默认调用该源码构建出的 `cli/dist/cli.js`。显式 `rll_cli_argv` 仍优先；仅独立复制出的插件目录没有同仓 CLI 时才回退到 `PATH`。

源码存在但尚未构建时，调用会失败，不会静默运行缺少 `host` 命令的旧版全局 CLI。这样保留人工来源确认、候选提交和租约接续的原有门禁；本切片不改变这些流程。

## 验证范围

本地按清单的三个命令验证了依赖安装、构建和包内容；单元测试核对同仓优先、显式覆盖和独立目录回退。后续[真实 GitHub 安装验收](s5-real-github-install-2026-11-05.md)在隔离命名 Server 中确认了 `8d6f933` 的安装、同仓构建、注册、`doctor`、卸载和配置保留。已钉住版本的更新仅返回 `already up to date`；跨提交升级仍未验收。

## 公开仓克隆预检

从公开 fork 的 `feat/herdr-s4-server-epoch-fence` 克隆提交 `5947e431e17f33ba112336eaab1bbbba0ff04f70` 到独立临时目录。克隆中的 `integrations/herdr` 与 `cli/` 保持了清单要求的相对位置。从插件目录依次执行清单中的 `npm ci --prefix ../../cli --ignore-scripts --no-audit --no-fund`、`npm run build --prefix ../../cli`、`node ../../cli/scripts/verify-package.mjs`，均返回成功；校验包含 72 个发布文件。解析函数指向该克隆的 `cli/dist/cli.js`，它的 `host inspect --project /private/tmp --json` 返回 `status=ok`。

预检使用临时 npm 缓存以避开当前沙箱对用户缓存的写入限制。它验证了 GitHub 源码和构建命令，不验证 Herdr 安装器实际的工作目录或插件注册结果。
