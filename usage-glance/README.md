# Paseo 额度与 token 消耗速览

适用于 Paseo daemon 和客户端 **0.8.x**。本插件位于多插件仓库 [`lalaze/paseo-plugins`](https://github.com/lalaze/paseo-plugins) 的 [`usage-glance/`](.) 目录。电脑端的工作区右上角直接显示额度摘要，例如「Codex 余28%」。默认显示所有可用供应商中最低的剩余百分比，并标明供应商；点击展开后可把顶栏固定到某一个供应商，该选择保存在当前主机，刷新或重开工作区后仍有效。未固定时继续跟随最低剩余。在聊天、终端和文件标签之间切换时仍可查看。点击展开全部明细。顶部按钮宽度由 Paseo 限制为 160px，因此使用短名称；AGY 表示 Antigravity。窄窗口或顶部有多个其他插件按钮时，Paseo 可能将按钮放入更多菜单。

绿色表示充足，黄色表示剩余不超过 25%，红色表示剩余不超过 10%。统一通过顶部额度入口查看已返回剩余额度的供应商；没有额度明细的供应商不列出。手机端顶部仅显示图标，点击打开底部额度面板，桌面端打开弹层。

进度条统一表示**剩余**。同一账号有多个限额时，摘要使用最低剩余百分比，明细保留每个窗口和真实重置时间。Antigravity 明细分别展示 Gemini、Claude/GPT 额度组，使用同仓库 [`agy-quota`](../agy-quota/README.md) 读取器的数据。

## 本机 token 消耗

点击工作区顶部的额度入口，切换到 **「消耗」**。跟随当前主机 **Providers** 的启用开关，统计已启用来源在 daemon 主机上保留的用量记录，也包括在终端直接运行的 CLI 会话。

- 支持 **Codex、Claude Code、Kimi、Grok、Antigravity**。只有本机 Providers 中已启用的来源才会采集、显示和计入合计。例如关闭 Claude Code 后，即使磁盘上仍有其历史记录，这些记录也不会进入 Provider 或模型厂商的合计。已启用但尚未适配的 Provider（如 Pi）显示「暂不支持消耗统计」，不按零处理，也不计入已读取合计。
- 时间范围：今日、近 7 天、本月、自定义（最多 366 天），按查看页面的客户端时区归日，页面显示具体时区。
- 默认「按 Provider」分组，可切换「按模型厂商」。在 Claude Code 已启用时，其 GLM 记录可按厂商归到智谱，模型明细仍保留 Claude Code 来源。自定义中转的实际调用渠道无法仅凭模型名确认；未识别的模型单独展示。
- 总览直接显示输入、输出；来源列表通过占比条对比消耗。展开供应商可看缓存读取/写入、推理，以及每个模型和工具来源的精确 token 数。
- **总量 = 输入（含缓存）+ 输出（含推理）**。缓存和推理属于明细，不重复相加；后端没有提供的推理细分显示「未提供」。
- 打开消耗面板后按需读取，每分钟更新，支持手动刷新。后台最多同时读取两个来源，相同时间范围的请求共用一次扫描。点击底部「数据来源」查看各来源的状态、更新时间和统计说明；读取失败时保留该来源上次成功的数据，并标明不完整。异常和暂不支持的来源在收起时仍会提示。
- Providers 开关变化会触发刷新，移除已关闭来源的缓存显示和合计；服务端每次查询都重新核对启用列表。启用但暂未登录、探测中或不可用的来源仍可读取已有历史。`antigravity-acp`、`antigravity-hub` 对应同一份 Antigravity 用量，同时开启只计一次。

### 月度模型热力图

在「消耗」页选择 **「月度热力图」**：

- 用上一月、下一月或「本月」切换月份，月历按周一至周日排列，使用页面显示的时区；当前月份尚未到来的日期不计入合计。
- 默认显示全部已启用来源的模型，可搜索并选择单个模型。同名模型按 Provider 来源分别保留，便于查看它在具体工具中的用量。
- 日期颜色表示当天 token 总量，按当前选择在该月的单日峰值分成四档；切换月份或模型后重新分级。月合计、活跃天数和单日峰值一起展示。
- 点日期查看当天精确 token、输入/输出及模型来源，展开「token 明细」查看缓存和推理。月总览同时显示有记录天数和单日峰值。读取失败或尚未完整时使用「—」并提示，不把缺失记录显示成零。
- Provider 关闭后，对应模型、日用量和月合计会同步移除；原有「消耗汇总」视图仍可切回。

### 数据来源与边界

| 来源 | 默认记录位置 | 读取方式 |
| --- | --- | --- |
| Codex | `~/.codex/sessions`、`~/.codex/archived_sessions` | 固定版本 ccusage，读取 `token_count`，处理重复快照、归档和分支历史 |
| Claude Code | `~/.claude/projects`、`~/.config/claude/projects` | ccusage，读取消息 usage 并按消息去重 |
| Kimi | `~/.kimi-code/sessions`、`~/.kimi/sessions` | ccusage，支持当前 `usage.record` 和旧版 wire 记录，区分 turn/session 范围 |
| Grok | `~/.grok/sessions` | ccusage，读取 `updates.jsonl` 中已完成轮次的 usage；不再叠加 `usage.json` 会话总量 |
| Antigravity | `~/.gemini/antigravity*/conversations` 中支持的目录 | 插件只读解析 SQLite 的生成/步骤用量元数据，按响应标识去重 |

来源目录可通过 daemon 的环境变量 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`KIMI_DATA_DIR`、`GROK_HOME`、`ANTIGRAVITY_DATA_DIR` 指定。Antigravity 默认检查 `.gemini` 下的 `antigravity`、`antigravity-cli`、`antigravity-ide`、`antigravity-backup` 和 `~/.config/antigravity`；其覆盖变量支持逗号分隔的数据根目录或 `conversations` 目录。

消耗读取使用 **ccusage 20.0.20** 的离线、无费用模式。该发布版本尚未提供 Antigravity 命令，因此 Antigravity 使用独立适配器，参考来源见 [第三方声明](THIRD-PARTY-NOTICES.md)。读取不调用模型，不需要新增 API key，不读取登录凭证，也不向客户端传送聊天正文。Antigravity 的消耗统计不依赖额度补丁。

这是**当前保留记录的汇总**，不是账号账单：已删除、未记录、其他系统用户不可读的调用无法补回，复制到本机的历史也会进入统计。Grok 的中断轮次可能没有完成记录；新的上游日志格式需要继续维护适配。Antigravity 缺少调用时间时优先采用会话日期并提示，完全缺少日期的记录不计入。当前只缓存查询结果，不另外持久化一份消耗账本。

### 运行环境

使用 Node.js **22.13+**（Antigravity 读取依赖 `node:sqlite`）。ccusage 提供 Linux/macOS 的 x64、arm64，以及 Windows x64、arm64 可执行包；本次实测环境为 Linux x64、Node 24。安装时需保留 npm optional dependencies。

准备脚本会将锁定的本机平台采集器复制到 `$XDG_CACHE_HOME/paseo-usage-glance`（默认 `~/.cache/paseo-usage-glance`），按文件内容的 SHA-256 分目录保存，以适应 Paseo 移动 Git 安装目录。可用 `PASEO_USAGE_CACHE_DIR` 覆盖；配置需在安装/构建时生效。缓存只放采集器和空配置，不保存会话记录。删除缓存后需重新执行插件准备或更新；卸载插件不会自动删除可复用的采集器缓存。

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

返回 `running` 后重新打开聊天即可。安装到现有 daemon，不需要重启。额度视图通过 Paseo 官方 `providers.listUsage()` 读取已有额度补丁和原生额度数据；消耗视图通过插件 RPC 读取本机记录。顶栏固定的供应商写入该主机的插件设置，同一 daemon 的客户端共用。插件本身不读取凭证、不发送模型消息。

Paseo 沿用 5 分钟额度缓存，插件每分钟检查一次。手动刷新也遵循 daemon 缓存；界面显示数据实际更新时间。连接失败或数据过期时，标签显示「待更新」，概览明确标注上次数据。没有剩余窗口或余额的供应商不出现在顶栏和明细里，也不会被当成 0%。

`paseo plugin install` 会记录目录路径。移动本仓库后，需要重新安装从该路径装过的插件。`build` 使用当前 Node 安装中的 Paseo 官方编译器，也可通过 `PASEO_COMPILER` 指定 `compiler.js`。
