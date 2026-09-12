# Paseo 额度速览

适用于 Paseo daemon 和客户端 **0.8.x**。本插件位于多插件仓库 [`lalaze/paseo-plugins`](https://github.com/lalaze/paseo-plugins) 的 [`usage-glance/`](.) 目录。电脑端的工作区右上角直接显示额度摘要，例如「Codex 余28%」。默认显示所有可用供应商中最低的剩余百分比，并标明供应商；点击展开后可把顶栏固定到某一个供应商，该选择保存在当前主机，刷新或重开工作区后仍有效。未固定时继续跟随最低剩余。在聊天、终端和文件标签之间切换时仍可查看。点击展开全部明细。顶部按钮宽度由 Paseo 限制为 160px，因此使用短名称；AGY 表示 Antigravity。窄窗口或顶部有多个其他插件按钮时，Paseo 可能将按钮放入更多菜单。

绿色表示充足，黄色表示剩余不超过 25%，红色表示剩余不超过 10%。统一通过顶部额度入口查看已返回剩余额度的供应商；没有额度明细的供应商不列出。手机端顶部仅显示图标，点击打开底部额度面板，桌面端打开弹层。

进度条统一表示**剩余**。同一账号有多个限额时，摘要使用最低剩余百分比，明细保留每个窗口和真实重置时间。Antigravity 明细分别展示 Gemini、Claude/GPT 额度组，使用同仓库 [`agy-quota`](../agy-quota/README.md) 读取器的数据。

## 安装

如果只是换一台电脑连接同一个 Paseo daemon，无需重复安装。每个独立 daemon 需要单独安装，daemon 和客户端均需为 **0.8.x**。插件 ID 为 `paseo-usage-glance`。

在目标主机的 Paseo **Settings → Plugins** 开启插件，并确保该主机安装了 Git、npm，且运行 daemon 的用户有本仓库的 GitHub SSH 读取权限。然后在该主机执行：

```bash
paseo plugin add lalaze/paseo-plugins --path usage-glance
paseo plugin ls paseo-usage-glance --json
```

SSH 源：

```bash
paseo plugin install git@github.com:lalaze/paseo-plugins.git:usage-glance --ref main
```

`--path usage-glance` 或 `:usage-glance` 指定本多插件仓库中的插件子目录。安装会自动运行锁定依赖的 `npm ci --include=dev --ignore-scripts` 和类型检查，再由 Paseo 编译加载；不需要手动克隆或构建。失败时保留已安装的版本。

显示 `running` 后，刷新客户端或重新打开工作区，即可在顶部看到额度。新机器读取的是该机器上已登录账号的额度；Antigravity 需要在该机器另外安装 [`agy-quota`](../agy-quota/README.md) 额度读取补丁，展示插件不会自动安装它。

## 更新

GitHub 源安装：

```bash
paseo plugin update paseo-usage-glance
paseo plugin ls paseo-usage-glance --json
```

本地目录安装不能使用 `paseo plugin update`。覆盖源码后：

```bash
npm ci --include=dev --ignore-scripts
npm run check
paseo plugin reload paseo-usage-glance
```

如果之前通过本地目录或旧仓库 `paseo-agy-quote` 安装，请先卸载再从本仓库安装：

```bash
paseo plugin remove paseo-usage-glance
paseo plugin add lalaze/paseo-plugins --path usage-glance
```

## 卸载

```bash
paseo plugin remove paseo-usage-glance
```

只移除展示扩展，原有额度读取补丁继续工作，顶栏固定的供应商选择也不再使用。失败时查看：

```bash
paseo plugin logs paseo-usage-glance
```

## 本地目录开发

如果已经克隆仓库，在 `usage-glance` 目录运行：

```bash
npm ci --include=dev --ignore-scripts
npm run check
paseo plugin install "$PWD"
paseo plugin ls paseo-usage-glance --json
```

返回 `running` 后重新打开聊天即可。安装到现有 daemon，不需要重启。客户端通过当前主机连接调用 Paseo 官方 `providers.listUsage()`，自动读取已有额度补丁和原生额度数据。顶栏固定的供应商写入该主机的插件设置，同一 daemon 的客户端共用。插件本身不读取凭证、不发送模型消息。

Paseo 沿用 5 分钟额度缓存，插件每分钟检查一次。手动刷新也遵循 daemon 缓存；界面显示数据实际更新时间。连接失败或数据过期时，标签显示「待更新」，概览明确标注上次数据。没有剩余窗口或余额的供应商不出现在顶栏和明细里，也不会被当成 0%。

`paseo plugin install` 会记录目录路径。移动本仓库后，需要重新安装从该路径装过的插件。`build` 使用当前 Node 安装中的 Paseo 官方编译器，也可通过 `PASEO_COMPILER` 指定 `compiler.js`。
