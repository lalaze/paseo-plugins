> **已归档：请勿按本文安装或更新旧插件。** 协作已迁入 Paseo 内置功能；停用旧插件并保留协作数据，见 [归档说明](README.md)。以下为历史安装文档。

# 在其他机器安装 Paseo AI 协作

插件安装在运行 Paseo daemon 的主机上。如果另一台电脑只是连接同一个 daemon，直接打开 AI 协作即可，不需要再安装。

## 准备目标主机

- Paseo daemon 和客户端均为 **0.8.x**；当前版本已在 **0.8.0** 上验证。
- 已安装 Node.js、npm 和 Git。项目要求 Node.js **22.13+**，实际验证使用 **24.18.0**。
- 在目标主机安装并登录准备使用的 AI 工具，让它们在 Paseo 中可用。
- 在 Paseo 的 **Settings → Plugins → Enable plugins** 开启目标主机的插件功能；已经开启的无需重复操作。

## 从 GitHub 安装

在目标主机执行，运行 Paseo daemon 的用户需要有多插件仓库的 GitHub SSH 读取权限：

```bash
paseo plugin add lalaze/paseo-plugins --path director
paseo plugin ls paseo-director --json
```

SSH 源：

```bash
paseo plugin install git@github.com:lalaze/paseo-plugins.git:director --ref main
```

安装需要联网访问 GitHub 和 npm。Paseo 会拉取 `paseo-plugins` 的 `main` 分支，只安装 `director` 子目录：先锁定依赖并做类型检查，再编译插件。安装后的插件 ID 是 `paseo-director`。

状态为 `running` 后，进入已有工作区，在 Agent 输入框发送 `/director` 打开面板，再进入 **协作设置**，选择并保存设计、执行和审核 AI（审核可沿用设计 AI）。之后可在同一输入框直接发送任务：

```text
/director 为这个项目增加登录功能，并补齐测试
```

「新建工作区」页面不支持插件命令，在那里发送 `/director` 会进入普通 AI 聊天。请先进入已有 Git 工作区，再用 `/director` 或工作区命令中心的 **AI 协作：安排任务** 打开面板；默认在当前工作区执行，不额外增加侧栏工作区条目。只有选择「新建独立工作区」才需要填写项目路径，并新增独立工作区。进入已有工作区后，输入 `/dir` 应能看到 `/director` 候选。

## 更新

GitHub 源安装：

```bash
paseo plugin update paseo-director
paseo plugin ls paseo-director --json
```

更新读取 GitHub 上 `main` 的新提交，并重新加载插件；不会自动上传本机的代码修改或同步团队配置。建议在没有进行中的协作任务时更新。

本地目录或源码包安装不能使用 `paseo plugin update`。把新源码覆盖到原安装目录后：

```bash
npm ci --include=dev --ignore-scripts
npm run typecheck
npm run build
paseo plugin reload paseo-director
paseo plugin ls paseo-director --json
```

不需要重启整个 Paseo daemon。安装或重载失败时查看：

```bash
paseo plugin logs paseo-director
```

## 从目录安装切换到 GitHub

通过源码目录安装的插件不能直接使用 `paseo plugin update`。确认没有进行中的协作任务后，移除旧安装登记，再从 GitHub 安装同一个插件 ID：

```bash
paseo plugin remove paseo-director
paseo plugin add lalaze/paseo-plugins --path director
paseo plugin ls paseo-director --json
```

Paseo 0.8.0 的移除操作不会删除原来的源码目录或 AI 协作数据目录。同一 daemon、同一 AI 协作数据目录下重新安装，会继续使用已保存的团队配置和任务记录。

## 从源码包安装（备选）

1. 把 `paseo-director-0.1.0.zip` 复制到目标主机。
2. 解压到长期保留的目录，例如 macOS / Linux 的 `~/paseo-plugins/director`。不要在临时解压目录安装后又删除它：目录安装会直接引用这个文件夹。
3. 在目标主机的终端进入解压后的 `director` 目录，逐条运行：

   ```bash
   npm ci --include=dev --ignore-scripts
   npm run typecheck
   npm run build
   paseo plugin install "$PWD"
   paseo plugin ls paseo-director --json
   ```

   需要联网下载 npm 依赖。某一步失败时，先处理错误再继续。安装参数必须是目标主机上的绝对路径，`"$PWD"` 表示当前目录；不要直接写 `.`。安装命令应连接这台目标主机的 daemon；若 CLI 配置了其他默认主机，请先切换到目标主机。

4. 确认插件状态为 `running`，然后进入已有工作区，发送 `/director` 打开面板，再进入 **协作设置**，选择并保存设计、执行和审核 AI（审核可沿用设计 AI）。
5. 进入已经创建的 Git 项目工作区（不是「新建工作区」页面），在 Agent 输入框发送：

   ```text
   /director 为这个项目增加登录功能，并补齐测试
   ```

源码包可在不同系统上解压；新主机需重新安装依赖。当前实测环境为 Linux，macOS / Windows 尚未单独验证。

## 配置

团队配置保存在各自 daemon 主机上，从 GitHub 或源码包安装都不会同步原主机的配置或任务。新主机需要重新选择 AI 分工；同一主机的其他项目可复用已保存的分工。

源码包仅包含插件源码、依赖锁定文件和文档，不包含 AI 登录信息、团队配置、任务数据库或工作区代码。

## 卸载

```bash
paseo plugin remove paseo-director
```

移除只取消安装登记，不会删除原来的源码目录、`$PASEO_HOME/director` 数据目录或工作区代码。同一 daemon、同一 AI 协作数据目录下重新安装，会继续使用已保存的团队配置和任务记录。

失败时查看：

```bash
paseo plugin logs paseo-director
```
