# S5 CLI 发布包检查与安装依赖

日期：2026-11-05。此切片在与 S4 协调器工作分离的临时工作区完成，不触碰真实 Herdr 会话。

## 已核对

- 公开仓根目录为 MIT 许可证。此前从 `cli/` 干净构建后执行 `npm pack --dry-run --json --ignore-scripts`，包内有 `dist/cli.js` 和运行模板，但没有许可证正文。现在 `cli/LICENSE` 与仓库根许可证逐字相同，打包清单包含该文件。
- CI 在构建和单元测试后执行 `cli/scripts/verify-package.mjs`，检查包名、版本、许可证一致性、可执行入口、模板，以及源码、测试和依赖目录没有误入发布包。此检查基于真实 `npm pack` 文件清单，不发布包或运行 Agent。
- 从 npm registry 下载已发布的 `ralph-lisa-loop@0.3.13`，运行其包内 CLI 的 `host inspect --project /private/tmp --json`，返回 `Unknown command: host`。因此这个公开版本不满足当前 Herdr 插件所需的 S1 宿主契约。仓库源码当前也仍声明 `0.3.13`；发布前须决定新的 CLI 版本与分发方式，不能把本地源码构建等同于 npm 已发布内容。

## 后续发布门禁

1. 插件已选择由 Herdr GitHub 安装构建并引用同一源码版本，详见 [同仓 CLI 构建方案](s5-same-checkout-cli-2026-11-05.md)。本地构建门禁通过不等于 GitHub 安装验收；仍须在 Herdr 管理环境中验证。
2. 在隔离用户目录中验证 GitHub 子目录安装、更新、卸载与配置保留；再用一台干净环境核对 Herdr、Node、Claude、Codex 和真实宿主契约。`plugin link` 仅证明本地清单可链接，不能代替 GitHub 安装验收。
3. 在发布前复查许可证、依赖、构建清单、README 示例、版本号和公开仓内容。Marketplace 收录还需要原仓默认分支上的清单及 `herdr-plugin` topic；开发 fork 的 CI 成功不等于上架。

本切片只补齐 CLI 包的许可证和自动打包门禁。尚未发布 npm 新版本，也未完成 Herdr GitHub 安装、更新或卸载验收。

后续隔离环境的[真实 GitHub 安装验收](s5-real-github-install-2026-11-05.md)已通过指定提交的安装、构建、`doctor`、卸载和配置保留；更新只返回 `already up to date`，尚未验证跨提交升级，npm 新版本仍未发布。
