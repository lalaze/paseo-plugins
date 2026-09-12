# Paseo 文件传输

为 **Paseo 0.8.0 / 0.8.x** 提供独立的「文件传输」工作区面板。文件位于当前工作区所属的 daemon 主机，上传来源和下载目的地是你正在使用的桌面端或浏览器。

本插件位于多插件仓库 [`lalaze/paseo-plugins`](https://github.com/lalaze/paseo-plugins) 的 [`file-upload/`](.) 目录。如果只是换电脑连接同一个 Paseo daemon，无需重复安装。

## 功能

- 以可展开、折叠的目录树浏览工作区，按需加载子目录；顶部显示实际路径。
- 从 Finder / 文件管理器拖入一个或多个文件；拖到文件夹行上传到该目录，目标行高亮；拖到文件行则上传到其所在目录。
- 点击「上传文件」选择文件，点击文件行「下载」保存到本机。
- 分块传输、进度、取消、多文件上传结果；同名文件报错，绝不自动覆盖。
- 上传完成后原子发布文件；取消或过期会话清理临时文件。
- RPC 通过现有 Paseo 连接传输，不需要额外服务或端口。

这是独立面板，不修改 Paseo 内置的「文件」「更改」列表。当前没有拖出到 Finder 的原生文件拖放接口，下载使用按钮。

打开一个工作区，按 **⌘K**（Windows / Linux 为 **Ctrl+K**），搜索 **文件传输：上传与下载**，默认在右侧 Explorer 面板打开。也可以在 Explorer 面板配置中添加 **文件传输**。插件仅在右侧 Explorer 承载，因此不会出现在中间标签栏的「＋」菜单中。

## 安装

每个独立 daemon 需要单独安装，daemon 和客户端均需为 **0.8.x**。插件 ID 为 `paseo-file-upload`。

在目标主机的 Paseo **Settings → Plugins** 开启插件，并确保该主机安装了 Git、npm，且运行 daemon 的用户有本仓库的 GitHub SSH 读取权限。然后在该主机执行：

```bash
paseo plugin add lalaze/paseo-plugins --path file-upload
paseo plugin ls paseo-file-upload --json
```

SSH 源：

```bash
paseo plugin install git@github.com:lalaze/paseo-plugins.git:file-upload --ref main
```

`--path file-upload` 或 `:file-upload` 指定本多插件仓库中的插件子目录。安装会自动运行锁定依赖的 `npm ci --include=dev --ignore-scripts` 和类型检查，再由 Paseo 编译加载。

显示 `running` 后，打开一个工作区，按 **⌘K** 搜索 **文件传输：上传与下载**。

## 更新

GitHub 源安装：

```bash
paseo plugin update paseo-file-upload
paseo plugin ls paseo-file-upload --json
```

本地目录安装不能使用 `paseo plugin update`。覆盖源码后：

```bash
npm ci --include=dev --ignore-scripts
npm run check
paseo plugin reload paseo-file-upload
```

如果之前通过本地目录或旧仓库 `paseo-file-upload` 安装，请先卸载再从本仓库安装：

```bash
paseo plugin remove paseo-file-upload
paseo plugin add lalaze/paseo-plugins --path file-upload
paseo plugin ls paseo-file-upload --json
```

## 卸载

```bash
paseo plugin remove paseo-file-upload
```

Paseo 0.8.0 的移除操作不会删除工作区里的文件。传输会话在插件退出时清理；daemon 被强制杀死时可能留下 `.paseo-upload-*` 临时文件，可确认无传输后手动删除。失败时查看：

```bash
paseo plugin logs paseo-file-upload
```

## 本地目录开发

如果已经克隆仓库，在 `file-upload` 目录运行：

```bash
npm ci --include=dev --ignore-scripts
npm run check
paseo plugin install "$PWD"
paseo plugin ls paseo-file-upload --json
```

`paseo plugin install` 会记录目录路径。移动本仓库后，需要重新安装从该路径装过的插件。

## 兼容性与限制

- 针对本机官方 SDK **0.8.0** 开发和编译验证，使用独立客户端、服务端入口；不兼容旧版 0.7。
- 桌面端 / Web 提供传输功能；iOS / Android 原生客户端显示使用提示。
- 单文件上限 **100 MiB**；下载在客户端内存中汇总后交给浏览器保存。浏览器设置决定保存位置。
- 当前只传输普通文件；文件夹请先压缩为 ZIP。符号链接、`.git`、插件临时文件不显示也不允许操作。
- 上传不会自动创建缺失目录，不支持覆盖、断点续传、目录打包下载或工作区内移动文件。
- 路径由服务端根据 workspace ID 获取，客户端不能指定任意根目录。对路径遍历和符号链接进行检查；这不是防御同机恶意进程并发替换目录的 OS 沙箱。
- 上传会话闲置 15 分钟后自动清理。正常插件退出也清理会话；daemon 被强制杀死时可能留下 `.paseo-upload-*` 临时文件，可确认无传输后手动删除。

## 开发与验证

```bash
npm ci --include=dev --ignore-scripts
npm run typecheck
npm test
npm run preview
```

预览使用真实文件传输后端和模拟 Paseo hooks，只操作自动创建的临时目录，不操作真实项目。退出预览时删除临时目录。默认绑定 `0.0.0.0:4173`，可使用 `PORT=4198 npm run preview` 更换端口。

验证范围：类型检查；二进制分块往返、空文件、路径限制、同名竞争、取消、文件变更检测、会话资源限制；浏览器拖到文件夹上传和下载字节比对。独立预览模拟宿主 hooks，不能替代安装到真实 daemon 后的验收。

目录：`index.client.tsx` / `index.server.ts` 注册贡献，`client/` 为面板，`shared/` 定义 RPC，`server/` 负责文件操作，`dev/` 为隔离预览，`tests/` 为回归测试。

接口依据：[Paseo 官方 v0.8 插件参考](https://github.com/getpaseo/paseo/blob/v0.8.0/public-docs/plugins/v0.8/reference.md)。
