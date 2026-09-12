# paseo-plugins

Paseo 插件与配套扩展的多包仓库。先在目标主机 **Settings → Plugins** 开启插件。也可以按下面各节单独安装；更新、卸载和限制见各目录 README。

一键安装全部包（三个插件、额度补丁、Kimi 续期、Hub ACP）：

```bash
./install-all.sh
```

默认从本仓库本地目录安装，本目录需长期保留。`--git` 改为从 GitHub 装插件；`--replace` 会卸掉旧单仓库来源再装；`--dry-run` 只预览。`--skip-quota` / `--skip-kimi` / `--skip-hub` 可跳过对应项。

一键更新已安装的包：

```bash
./update-all.sh
```

会 `git pull`，再更新已从本仓库安装的项。未安装的跳过。`--skip-pull` 只更新不拉代码。

插件与补丁均在 daemon 用户权限下运行，安装前请阅读对应目录源码。

## [Director](director)

由你选择设计、执行和审核 AI，完成设计、实现、审核与验收协作。插件 ID：`paseo-director`。

```bash
paseo plugin add lalaze/paseo-plugins --path director
```

详细说明：[director/README.md](director/README.md)

## [额度速览](usage-glance)

工作区右上角显示额度摘要，可固定供应商并展开明细。插件 ID：`paseo-usage-glance`。Antigravity 额度需要另外安装下面的 [`agy-quota`](agy-quota) 补丁。

```bash
paseo plugin add lalaze/paseo-plugins --path usage-glance
```

详细说明：[usage-glance/README.md](usage-glance/README.md)

## [文件传输](file-upload)

工作区文件传输面板：浏览目录树，上传下载当前 daemon 主机上的文件。插件 ID：`paseo-file-upload`。

```bash
paseo plugin add lalaze/paseo-plugins --path file-upload
```

详细说明：[file-upload/README.md](file-upload/README.md)

## [Antigravity 额度补丁](agy-quota)

为 Plan usage 增加 Google Antigravity 额度读取，以及可选的 Kimi 按需续期。这是安装补丁，不是 `paseo plugin` 包。

```bash
git clone git@github.com:lalaze/paseo-plugins.git
cd paseo-plugins/agy-quota
node patch.mjs check && npm test && node patch.mjs apply
paseo daemon restart
```

详细说明：[agy-quota/README.md](agy-quota/README.md)

## [Antigravity Hub ACP](antigravity-hub)

把本机 Antigravity Hub 接到 Paseo ACP，支持模型选择、流式回复、工具进度和 Plan 模式。这是 ACP provider，不是 `paseo plugin` 包。

```bash
git clone git@github.com:lalaze/paseo-plugins.git
cd paseo-plugins/antigravity-hub
node hub.mjs check && npm test && node hub.mjs install
paseo reload
```

详细说明：[antigravity-hub/README.md](antigravity-hub/README.md)

## 从旧仓库迁移

原先单仓库已按目录并到这里。已安装的环境先卸载旧来源，再按上面命令安装：

- `paseo-sub-agnet` → [Director](director/README.md)
- `paseo-agy-quote` → [额度速览](usage-glance/README.md)、[额度补丁](agy-quota/README.md)、[Hub ACP](antigravity-hub/README.md)
- `paseo-file-upload` → [文件传输](file-upload/README.md)
