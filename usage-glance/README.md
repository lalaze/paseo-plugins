# Paseo Token 消耗统计

适用于 Paseo daemon 和客户端 **0.8.x–0.11.x（含 beta）**。保留插件 ID `paseo-usage-glance`，已有安装可直接更新。插件专门统计已使用的 token，提供多主机汇总、Workspace/模型分类和月度热力图；账号剩余额度使用 Paseo 官方功能。

从 0.8.0 起恢复安装和更新，仅保留 Token 消耗功能，不再注册额度设置或 Antigravity 额度查询。

## 右上角今日消耗

Workspace 和会话的右上角显示 **「今日 12.34M」**，汇总当前客户端已加载主机的今日 token 消耗，按客户端时区归日，包含输入（含缓存）与输出（含推理）。点击进入「Token 消耗」页面查看明细。它复用每分钟更新的后台缓存，无需先打开统计页，也不会额外扫描记录；跨日自动切换。

- **绿色**：低于 1B（10 亿）token。
- **黄色**：达到 1B、低于 5B（50 亿）token。
- **红色**：达到 5B token。
- **灰色 /「—」**：尚无可读取的数据。断线或读取失败时保留今日缓存，数字后的 **`*`** 表示部分记录；悬停提示或无障碍标签包含精确数量、日期、时区和颜色分档。

颜色圆点代表已记录消耗量，不是剩余额度或费用预算。分档使用固定 token 阈值；支持的主机与统计边界和下方消耗页面一致。

Paseo 的紧凑布局会隐藏原生顶栏按钮的文字，仅保留颜色圆点，点击后查看今日数字；顶栏按钮较多时也可能由 Paseo 收入更多菜单。

## 独立消耗页面与多主机汇总

点击 Paseo **侧边栏「Token 消耗」**打开独立页面，也可在命令中心搜索「查看 Token 消耗」。桌面端和手机端均支持。页面提供消耗汇总和月度热力图，默认选择 **「全部主机」**；汇总依赖同一个客户端连接的各台主机已加载本插件：

- **消耗合计**：按相同日期范围和客户端时区汇总各主机的 token，可按 Provider、Workspace、模型、模型厂商或主机分组。每台主机独立遵循自己的 Providers 开关；例如只在 Mac 上启用 Claude Code，就只计入 Mac 的 Claude Code 记录。
- **主机切换**：页面右上方（手机端在标题下方）选择全部或单台主机，消耗汇总和月度热力图一起切换。同名模型在明细和热力图选择器中带有主机名称，便于区分。账号额度通过 Paseo 官方功能查看。
- **独立加载**：各主机并行读取，先展示已经返回的结果。断开连接或读取失败时，保留当前客户端会话内该主机、该日期范围的缓存，明确提示合计可能不完整；从未读取的范围显示「—」。

主机列表来自此插件在**当前客户端会话中已加载的各主机实例**。未安装、未更新，或本次打开客户端后始终未连接的主机不会自动出现。发现数量不代表账号的全部主机。

聚合复用 Paseo 已有的主机连接，无需额外服务、SSH 配置或 API key。当前适配 Paseo 0.8.x–0.11.x 的客户端插件加载方式；跨主机缓存不写入磁盘，刷新客户端后重新读取。

## token 消耗

打开侧边栏 **「Token 消耗」** 页面。分别跟随所选各主机 **Providers** 的启用开关，统计已启用来源在各 daemon 主机上保留的用量记录，也包括在终端直接运行的 CLI 会话。

- 支持 **Codex、Claude Code、Kimi、Grok、Antigravity、Pi、CodeBuddy**。只有本机 Providers 中已启用的来源才会采集、显示和计入合计。例如关闭 Claude Code 后，即使磁盘上仍有其历史记录，这些记录也不会进入 Provider 或模型厂商的合计。已启用但尚未适配的 Provider（如 Copilot）显示「暂不支持消耗统计」，不按零处理，也不计入已读取合计。
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
- Codex 使用会话元数据中的目录；Claude Code 使用项目目录标识；Kimi 使用会话 `state.json` 中的目录或 Paseo 会话关联；Grok 使用会话项目路径；Pi 使用会话头部目录；CodeBuddy 使用会话记录中的目录或 Paseo 会话关联；Antigravity 使用 Paseo 保存的会话 ID 与数据库名称关联。没有 Paseo 会话关联的 Antigravity 历史暂不能归属。
- 无法匹配、目录冲突、已移除工作区的记录进入 **「未归属 Workspace」**，仍计入总量。终端直接运行的 CLI 记录在目录能够匹配时也会归属；没有保留下来的元数据不会猜测分配。
- 会话分类逐模型核对输入、输出、缓存和推理是否与每日合计一致；发生差异时会重新读取每日统计，若用量发生变化且仍未对齐，再重读一次明细。每次扫描最多读取两次每日统计和两次明细，避免持续运行的会话导致无限重试。
- 对 Codex 同一会话的完整文件副本，在确认会话 ID、模型用量、文件内容一致且采集期间未变化后去重。仅有部分重叠、内容不同或仍在写入的文件不会按相同 token 数盲目合并；仍以每日统计核对最终总量。
- 无法对齐的模型分别显示为 **「用量更新中」**、**「待核对用量」** 或 **「归属读取失败」**，与缺少工作区匹配的记录分开。展开可查看会话明细、每日合计及输入/输出/缓存/推理的差异项。该模型暂按每日总量保留，其他核对成功的模型正常归属；不会按比例猜测分配差额。
- 首次切入此分类才按需读取，随后在页面打开期间每分钟刷新。它使用独立的日期范围缓存，不把整月的会话总量套用到今日或近 7 天；最多保留 8 组范围，每次最多同时读取两个来源。其余分类和热力图继续使用原来的每日缓存。跨主机查看需要在各主机更新插件。

这里展示的是项目已记录的 **token 消耗**；账号剩余额度请使用 Paseo 官方功能查看。

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
| CodeBuddy | `~/.codebuddy/projects`（跟随 `CODEBUDDY_CONFIG_DIR`） | 插件只读解析项目 JSONL 会话，按 `providerData.usage` 累计每个模型请求（每个 step 恰好一条记录携带 usage），去重文件副本 |
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

## 安装与更新

在每台需要统计的 daemon 主机上启用 **Settings → Plugins**，然后安装：

```bash
paseo plugin add git:lalaze/paseo-plugins --path usage-glance
```

已有 Git 安装直接更新：

```bash
paseo plugin update paseo-usage-glance
paseo plugin ls paseo-usage-glance --json
```

本仓库的 `install-all.sh` 和 `update-all.sh` 也会处理本插件。显示 `running` 后刷新客户端，从侧边栏「Token 消耗」或命令中心「查看 Token 消耗」进入。跨主机汇总需要各主机都安装插件并保持连接。安装会自动准备锁定依赖和采集器，不需要新增 API key。

如果之前已卸载旧额度插件，重新安装即可读取仍保留的历史记录；插件内存缓存会重新建立。

## 卸载

```bash
paseo plugin remove paseo-usage-glance
```

卸载会停止统计后台任务，不删除 CLI 历史记录或翻译账本，不影响 Paseo 官方额度功能。

## 本地开发

在 `usage-glance` 目录运行：

```bash
npm ci --include=dev --ignore-scripts
npm run check
paseo plugin install "$PWD"
```

已从此本地目录安装时，修改后执行 `paseo plugin reload paseo-usage-glance`。插件读取本机记录，不读取凭证或发送模型消息。`build` 使用当前 Node 安装中的 Paseo 官方编译器，也可通过 `PASEO_COMPILER` 指定 `compiler.js`。

手机运行时检查（在仓库根目录运行）：

```bash
HERMES_BIN=/path/to/hermes node scripts/check-mobile-runtime.mjs
HERMES_BIN=/path/to/hermes node usage-glance/scripts/check-consumption-hermes.mjs
```

检查动态加载后的统计入口、后台同步、主机注册和卸载清理；实际手机的页面布局和触控仍需在设备上验证。

## dot 可见文本估算

启用 dot Provider 时，统计数字账本 `paseo-dot-bridge/usage-estimates.json`（目录与 dot-bridge 共用 `PASEO_DOT_BRIDGE_DATA_DIR` 或 `$PASEO_HOME/paseo-dot-bridge`）。需同时更新、构建并重新加载 dot-bridge 与 usage-glance。

该来源标为「dot（估算）」，计入今日、日期范围、Workspace 和热力图；包含估算的合计显示 `≈`，汇总拆出已记录值与 dot 估算值。关闭 dot Provider 即排除。Workspace 优先使用账本工作区 ID，其次目录匹配。

算法 `visible-text-v1` 按每条新增可见消息的 ASCII 字符数 / 4 加非 ASCII Unicode 码点数后向上取整，分别估算用户输入和 dot 的回复、提问、进度文字。不计重复历史、图片、附件正文、工具、上下文重传或隐藏推理，也不猜测实际模型。它可能显著低于实际用量，只用于趋势，不能推算费用或剩余额度。缓存计数不包含未观测部分，推理细分为未提供。

账本由 bridge 的保留消息重建，使用稳定 ID 去重；没有聊天正文或凭证。尚未生成或读取失败会提示，不能把缺失记录解释为零。历史是否能恢复取决于 bridge 是否仍保留原消息。
