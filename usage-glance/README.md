# Paseo 额度与 token 消耗速览

适用于 Paseo daemon 和客户端 **0.8.x / 0.9.x（含 beta）**。本插件位于多插件仓库 [`lalaze/paseo-plugins`](https://github.com/lalaze/paseo-plugins) 的 [`usage-glance/`](.) 目录。电脑端的工作区右上角直接显示额度摘要，例如「Codex 余28%」。默认显示所有可用供应商中最低的剩余百分比，并标明供应商；点击展开后可把顶栏固定到某一个供应商，该选择保存在当前主机，刷新或重开工作区后仍有效。未固定时继续跟随最低剩余。在聊天、终端和文件标签之间切换时仍可查看。点击展开全部明细。顶部按钮宽度由 Paseo 限制为 160px，因此使用短名称；AGY 表示 Antigravity。窄窗口或顶部有多个其他插件按钮时，Paseo 可能将按钮放入更多菜单。

绿色表示充足，黄色表示剩余不超过 25%，红色表示剩余不超过 10%。顶部额度入口只显示**当前工作区所在主机**已返回的剩余额度，没有额度明细的供应商不列出。明细不显示消耗页签和主机选择器；顶栏供应商设置默认收起，点击「顶栏显示设置」展开。点击顶部入口打开 Paseo 的额度明细对话框，手机端顶部仅显示图标。

进度条统一表示**剩余**。同一账号有多个限额时，摘要使用最低剩余百分比，明细保留每个窗口和真实重置时间。Antigravity 明细分别展示 Gemini、Claude/GPT 额度组，使用同仓库 [`agy-quota`](../agy-quota/README.md) 读取器的数据。

同一客户端只保留一个打开的额度对话框；在其他工作区或主机打开额度时，会关闭上一份。对话框由按钮点击控制，同一个工作区的顶栏即使被重复挂载也只显示一份；插件重载或卸载时清理对话框。0.7.3 修复了 0.7.2 通过弹层挂载互斥导致点击后立即关闭的回归。0.7.4 为手机 App 使用独立原生弹窗，内部只有一个滚动列表，避开 Paseo 0.8 底部菜单的手势和动态高度限制。0.7.5 修复手机 Hermes 运行时下，多工作区按钮回调错误引用最后一个工作区、导致点击无反应的问题。0.7.6 精简手机弹窗：移除重复标题和高亮边框，使用圆角分组卡片，周期和重置时间在左、剩余额度和短进度条在右。手机弹窗标题为「可用额度」，整体高度为窗口的 65%（最多 600），支持关闭按钮、点击遮罩和 Android 返回键关闭。

## 独立消耗页面与多主机汇总

点击 Paseo **侧边栏「Token 消耗」**打开独立页面，也可在命令中心搜索「查看 Token 消耗」。桌面端和手机端均支持。页面提供消耗汇总和月度热力图，默认选择 **「全部主机」**。在同一个客户端连接各台主机，并在**每台 daemon 主机**安装或更新本插件：

- **消耗合计**：按相同日期范围和客户端时区汇总各主机的 token，可按 Provider、Workspace、模型、模型厂商或主机分组。每台主机独立遵循自己的 Providers 开关；例如只在 Mac 上启用 Claude Code，就只计入 Mac 的 Claude Code 记录。
- **主机切换**：页面右上方（手机端在标题下方）选择全部或单台主机，消耗汇总和月度热力图一起切换。同名模型在明细和热力图选择器中带有主机名称，便于区分。额度始终在各自工作区的顶部入口查看。
- **独立加载**：各主机并行读取，先展示已经返回的结果。断开连接或读取失败时，保留当前客户端会话内该主机、该日期范围的缓存，明确提示合计可能不完整；从未读取的范围显示「—」。

主机列表来自此插件在**当前客户端会话中已加载的各主机实例**。未安装、未更新，或本次打开客户端后始终未连接的主机不会自动出现。发现数量不代表账号的全部主机。其他主机未出现时，请更新该主机插件并保持连接，必要时刷新客户端。

聚合复用 Paseo 已有的主机连接，无需额外服务、SSH 配置或 API key。当前适配 Paseo 0.8.x / 0.9.x 的客户端插件加载方式；跨主机缓存不写入磁盘，刷新客户端后重新读取。

## token 消耗

打开侧边栏 **「Token 消耗」** 页面。分别跟随所选各主机 **Providers** 的启用开关，统计已启用来源在各 daemon 主机上保留的用量记录，也包括在终端直接运行的 CLI 会话。

- 支持 **Codex、Claude Code、Kimi、Grok、Antigravity、Pi**。只有本机 Providers 中已启用的来源才会采集、显示和计入合计。例如关闭 Claude Code 后，即使磁盘上仍有其历史记录，这些记录也不会进入 Provider 或模型厂商的合计。已启用但尚未适配的 Provider（如 Copilot）显示「暂不支持消耗统计」，不按零处理，也不计入已读取合计。
- 另外计入同仓库 [`translate`](../translate/README.md) 插件的翻译 API 用量，来源名为「翻译」。它不是 Paseo Provider，没有开关：只要本机存在翻译用量账本目录就会列出并计入合计；未安装翻译插件或尚未翻译过的主机不显示该来源。翻译请求不属于任何 Agent 会话，在「按 Workspace」中归入「未归属 Workspace」。
- 时间范围：今日、近 7 天、本月、自定义（最多 366 天），按查看页面的客户端时区归日，页面显示具体时区。
- 默认「按 Provider」分组，可切换「按 Workspace」「按模型」「按模型厂商」或「按主机」。「按模型」按记录中的完整模型名称汇总，所选主机内的同名模型跨 Provider 合并，按消耗从高到低排列；展开可查看各主机、Provider 的精确用量。不同名称、版本或别名分别保留，缺少模型名的记录显示为「未记录模型」。手机端分类入口自动换行。
- 在 Claude Code 已启用时，其 GLM 记录可按厂商归到智谱，模型明细仍保留 Claude Code 来源。自定义中转的实际调用渠道无法仅凭模型名确认；未识别的模型单独展示。
- 总览直接显示输入、输出；来源列表通过占比条对比消耗。展开供应商可看缓存读取/写入、推理，以及每个模型和工具来源的精确 token 数。
- 简写统一使用 M（百万 token），达到一亿后使用「亿」（100M = 1亿），最多保留两位小数；不足 0.01M 的非零消耗显示「<0.01M」。总览下方和展开明细保留精确数量。
- **总量 = 输入（含缓存）+ 输出（含推理）**。缓存和推理属于明细，不重复相加；后端没有提供的推理细分显示「未提供」。
- 插件连接主机后自动准备常用范围，不需要先打开消耗页面。**daemon 每分钟在后台刷新**，关闭消耗页或客户端后仍继续；客户端连接期间也每分钟读取最新缓存。今日、近 7 天、本月至今和本月热力图共用一份按日结果，按所选日期精确筛选，避免重复扫描。后台最多同时读取两个来源。
- 页面优先展示已有缓存，后台更新时保留数字和真实更新时间；普通刷新不会反复显示加载状态。首次启动、新时区或尚未缓存的历史/自定义范围仍需等待首次扫描，支持手动刷新。点击底部「数据来源」查看各来源的状态、更新时间和统计说明；读取失败时保留该来源上次成功的数据，并标明不完整。异常和暂不支持的来源在收起时仍会提示。
- Providers 开关变化会触发刷新，移除已关闭来源的缓存显示和合计；服务端每次查询都重新核对启用列表。启用但暂未登录、探测中或不可用的来源仍可读取已有历史。`antigravity-acp`、`antigravity-hub` 对应同一份 Antigravity 用量，同时开启只计一次。

### 按 Workspace 查看项目用量

在「消耗汇总」选择 **「按 Workspace」**，按左侧工作区名称展示所选日期内的 token、占比和输入/输出，展开查看模型与 Provider 明细。Working 和 Done 中有用量的工作区均会显示；同名工作区按主机和工作区 ID 区分，下方显示主机及实际目录。工作区改名后，下次刷新使用新名称。

- 优先使用 Paseo 会话与工作区的关联；有明确原生目录时，匹配该主机实际工作区目录及其子目录，嵌套目录选最具体的一项。使用 worktree 自身目录，不把同一仓库的不同 worktree 合并。
- Codex 使用会话元数据中的目录；Claude Code 使用项目目录标识；Kimi 使用会话 `state.json` 中的目录或 Paseo 会话关联；Grok 使用会话项目路径；Pi 使用会话头部目录；Antigravity 使用 Paseo 保存的会话 ID 与数据库名称关联。没有 Paseo 会话关联的 Antigravity 历史暂不能归属。
- 无法匹配、目录冲突、已移除工作区的记录进入 **「未归属 Workspace」**，仍计入总量。终端直接运行的 CLI 记录在目录能够匹配时也会归属；没有保留下来的元数据不会猜测分配。
- 会话分类逐模型核对输入、输出、缓存和推理是否与每日合计一致；发生差异时会重新读取每日统计，若用量发生变化且仍未对齐，再重读一次明细。每次扫描最多读取两次每日统计和两次明细，避免持续运行的会话导致无限重试。
- 对 Codex 同一会话的完整文件副本，在确认会话 ID、模型用量、文件内容一致且采集期间未变化后去重。仅有部分重叠、内容不同或仍在写入的文件不会按相同 token 数盲目合并；仍以每日统计核对最终总量。
- 无法对齐的模型分别显示为 **「用量更新中」**、**「待核对用量」** 或 **「归属读取失败」**，与缺少工作区匹配的记录分开。展开可查看会话明细、每日合计及输入/输出/缓存/推理的差异项。该模型暂按每日总量保留，其他核对成功的模型正常归属；不会按比例猜测分配差额。
- 首次切入此分类才按需读取，随后在页面打开期间每分钟刷新。它使用独立的日期范围缓存，不把整月的会话总量套用到今日或近 7 天；最多保留 8 组范围，每次最多同时读取两个来源。其余分类和热力图继续使用原来的每日缓存。跨主机查看需要在各主机更新插件。

这里展示的是项目已记录的 **token 消耗**；账号剩余额度仍在顶栏额度入口查看。

### 月度模型热力图

在「Token 消耗」页选择 **「月度热力图」**：

- 用上一月、下一月或「本月」切换月份，月历按周一至周日排列，使用页面显示的时区；当前月份尚未到来的日期不计入合计。
- 默认显示所选主机全部已启用来源的模型，可按模型名、来源或主机名搜索并选择单个模型。同名模型按主机和 Provider 来源分别保留，便于查看它在具体机器、工具中的用量。
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
| Pi | `~/.pi/agent/sessions` | 插件只读解析 v1–v3 JSONL 会话中的 assistant usage 和已记录的压缩/分支摘要用量，去重分支及副本历史 |
| Antigravity | `~/.gemini/antigravity*/conversations` 中支持的目录 | 插件只读解析 SQLite 的生成/步骤用量元数据，按响应标识去重 |
| 翻译 | `~/.paseo/translate/usage/YYYY-MM.jsonl` | 插件只读解析 translate 插件追加的 JSONL 账本：每次 API 调用的时间、模型和返回的 token 用量；缺少 `usage` 的调用不计入并提示次数 |

来源目录可通过 daemon 的环境变量 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`KIMI_DATA_DIR`、`GROK_HOME`、`ANTIGRAVITY_DATA_DIR`、`PI_CODING_AGENT_DIR`、`PASEO_TRANSLATE_USAGE_DIR` 指定（翻译账本默认位于 `$PASEO_HOME/translate/usage`，两个插件读取同一规则）。Antigravity 默认检查 `.gemini` 下的 `antigravity`、`antigravity-cli`、`antigravity-ide`、`antigravity-backup` 和 `~/.config/antigravity`；其覆盖变量支持逗号分隔的数据根目录或 `conversations` 目录。

Pi 的 `PI_CODING_AGENT_DIR` 指向 agent 数据根目录（其下为 `sessions`），支持 `~` 展开；Pi CLI 用 `--session-dir` 保存到其他位置的记录需放在该扫描目录内才能统计。Pi 输入合计包含普通输入、缓存读取和缓存写入；推理属于输出子集，缺少细分时显示「未提供」。保留所有分支中实际发生的调用，分支复制的历史只计一次；日志中已记录的压缩与分支摘要 usage 也计入，缺少模型名时归到「未记录模型」。旧版未持久化的摘要调用无法补回。该接入提供 Token 消耗统计，账号剩余额度仍以 Paseo 返回的额度数据为准。格式参考 [Pi 会话源码](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts)。

Codex、Claude Code、Kimi、Grok 消耗读取使用 **ccusage 20.0.20** 的离线、无费用模式。该发布版本尚未提供 Antigravity 命令，因此 Antigravity 使用独立适配器，参考来源见 [第三方声明](THIRD-PARTY-NOTICES.md)。读取不调用模型，不需要新增 API key，不读取登录凭证，也不向客户端传送聊天正文。Antigravity 的消耗统计不依赖额度补丁。

这是**当前保留记录的汇总**，不是账号账单：已删除、未记录、其他系统用户不可读的调用无法补回，复制到本机的历史也会进入统计。**同一份历史复制到两台不同主机后，跨主机合计暂不能去重，会分别计入。** Grok 的中断轮次可能没有完成记录；新的上游日志格式需要继续维护适配。Antigravity 缺少调用时间时优先采用会话日期并提示，完全缺少日期的记录不计入。

当前只缓存查询结果，不另外持久化一份消耗账本。每台 daemon 内存最多缓存 8 组日期范围与时区；相同时区中已被缓存覆盖的日期范围直接筛选复用。客户端连接后，后台记住最近两个客户端时区，每分钟刷新覆盖本月和最近 7 天的记录，跨日、跨月自动调整；每轮重新检查本机 Providers。daemon 重启后需重新连接一次，卸载或停用插件会停止后台任务。

扫描期间保留旧结果；客户端在扫描时约每 1.5 秒查询进度，通常每分钟检查更新，即使关闭统计页面也继续同步。常用范围缓存跟随主机连接保留；其余未使用的客户端查询缓存保留 5 分钟，跨主机视图另保留每台主机最多 8 组已读取快照，用于当前客户端会话内的断线展示。新范围首次读取仍需扫描，刷新客户端或重启 daemon 不保证恢复内存缓存。

### 运行环境

使用 Node.js **22.13+**（Antigravity 读取依赖 `node:sqlite`）。ccusage 提供 Linux/macOS 的 x64、arm64，以及 Windows x64、arm64 可执行包；本次实测环境为 Linux x64、Node 24。安装时需保留 npm optional dependencies。

准备脚本会将锁定的本机平台采集器复制到 `$XDG_CACHE_HOME/paseo-usage-glance`（默认 `~/.cache/paseo-usage-glance`），按文件内容的 SHA-256 分目录保存，以适应 Paseo 移动 Git 安装目录。可用 `PASEO_USAGE_CACHE_DIR` 覆盖；配置需在安装/构建时生效。缓存只放采集器和空配置，不保存会话记录。删除缓存后需重新执行插件准备或更新；卸载插件不会自动删除可复用的采集器缓存。

## 安装

如果只是换一台电脑连接同一个 Paseo daemon，无需重复安装。每个独立 daemon 需要单独安装，daemon 和客户端均需为 **0.8.x / 0.9.x（含 beta）**。插件 ID 为 `paseo-usage-glance`。

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

要统一查看两台或更多主机，请在**每台 daemon 主机**分别执行上述更新命令；均显示 `running` 后刷新客户端，并保持这些主机连接。

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

Claude 可另外安装 [`claude-patch.mjs` 限频补丁](../agy-quota/README.md#claude-额度查询限频可选)，将外部查询降到每 15 分钟最多一次，并遵守 429 的 `Retry-After`。此时界面和 daemon 仍可读取本机缓存，Claude 数字的真实查询间隔为 15 分钟或更长；daemon 的总响应时间戳不代表 Claude 刚刚访问了远端。

`paseo plugin install` 会记录目录路径。移动本仓库后，需要重新安装从该路径装过的插件。`build` 使用当前 Node 安装中的 Paseo 官方编译器，也可通过 `PASEO_COMPILER` 指定 `compiler.js`。

手机回归检查需在构建后额外运行：

```bash
HERMES_BIN=/path/to/hermes node scripts/check-quota-hermes.mjs
```

该检查用官方 Hermes CLI 动态执行实际客户端 bundle，验证三个工作区的额度按钮分别能够打开、关闭和再次打开；只运行 Node 测试无法复现手机端的循环变量闭包问题。0.7.5 已在 Android 版 Paseo 0.8 上验证点击打开、限高、列表滚动、关闭及再次打开。手机弹窗居中显示，底部设置不再被系统导航栏遮挡。
