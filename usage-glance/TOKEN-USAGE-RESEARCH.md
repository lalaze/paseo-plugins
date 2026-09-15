# 本机 token 消耗统计：调研与实施记录

调研日期：2026-09-15。范围由用户确认：当前机器的实际 token 消耗，按供应商汇总。用户随后授权实现；实施结果如下，第 1–5 节保留初始调研时的证据和待验证事项。

## 实施结果（2026-09-15）

- 已在 `usage-glance` 实现「额度 / 消耗」页签、时间范围、供应商/工具分组、模型明细、数据来源状态和刷新。
- 固定使用 npm `ccusage@20.0.20` 读取 Codex、Claude Code、Kimi、Grok；真实本机数据均成功返回并通过每日/模型合计一致性校验。Codex 使用其 `token_count` 读取路线，不叠加同请求的 `token_usage_record`。
- **文档与发布包存在差异**：20.0.20 没有 Antigravity 命令。已参考上游提交 `0d220e060669c5e5b6eccfa8b64cc6f0e3539fcc` 实现独立 SQLite/protobuf 适配器并保留 MIT 声明。正常主机权限下，前述 171 个本机数据库全部成功读取；初始失败与执行沙箱权限有关。
- 固定版本可执行程序已用合成日志验证：Codex 同时存在两类记录、累计快照、归档副本和 fork 重放；Claude 缺少 requestId 及重复消息；Kimi turn/session 区分；Grok 重复完成事件及 `usage.json` 不重复累计。
- Antigravity 已用真实 SQLite 测试验证字段映射、重试、生成/步骤/备份去重和时区边界。服务测试覆盖并发限制、重复扫描、失败保留已有数据和不同范围缓存隔离。
- 桌面和手机（320/390px）、深浅色页面的交互与无横向溢出检查已通过。全新 `npm ci --ignore-scripts`、类型检查、安装目录迁移及 Paseo 官方编译后的服务端 RPC 均已实测；五家真实数据都返回 `ready`。
- 仅采集当前仍保留的记录，不构建持久账本，也不能证明复制来的历史发生于本机。实际调用渠道无法仅从模型名判断；界面明确标注供应商由模型识别。
- 根据用户补充要求，消耗范围改为本机 Providers 中**已启用**且支持采集的来源，默认按 Provider 展示；关闭来源后其历史记录不显示、不计入合计。启用状态以 Paseo 快照的 `enabled` 为准，并监听开关变化清理旧缓存。当前本机 Claude Code 已关闭，实际显示 Codex、Kimi、Grok、Antigravity；已启用的 Pi 尚未有采集适配。
- 后续新增月度模型热力图：按日历展示日消耗，可切换月份、筛选模型及查看单日明细；复用已按时区和 Provider 开关筛选的每日记录，缓存和推理不另行累计。

安装、使用和兼容性说明见 [README](README.md)。以下为实施前的调研记录。

## 结论

可以做，建议在现有「额度速览」增加「消耗」视图，复用入口，新增独立的服务端采集和汇总模块。

Codex、Claude Code、Kimi、Grok 的本地文件已实测找到非零 token 用量字段；Antigravity 已确认本机存在相应 SQLite 数据库，且开源工具 ccusage 有读取方案，但本次尚未完成其二进制字段解析和总量对账。无需为了采集前四类数据调用模型或新增账号凭证。Grok 在用户追问后补充核验，应纳入首版候选范围。

产品应将统计范围写为「本机已记录消耗」：这里的机器是运行 Paseo daemon 的主机，默认覆盖 daemon 用户可读的已接入 CLI 数据目录，也包括在终端直接运行这些 CLI 的会话。其他系统用户、没有记录用量的调用、已删除的历史，以及未接入的工具不会自动覆盖。跨机器复制来的历史也需要标记来源，不能仅凭文件在本机就证明消耗发生在本机。

## 1. 当前仓库能复用什么

| 位置 | 当前行为 | 对新功能的意义 |
| --- | --- | --- |
| [client/query.ts](client/query.ts) | 调用 `paseo.providers.listUsage()` | 提供账号额度，不能据此累计实际 token 消耗 |
| [index.server.ts](index.server.ts) | 只注册顶栏偏好设置 | 可以增加采集器、查询 RPC 和本地统计缓存 |
| [index.client.tsx](index.client.tsx) | 工作区顶栏按钮及弹层 | 可以复用额度入口，增加「额度 / 消耗」切换 |
| [Antigravity 额度读取器](../agy-quota/src/antigravity.js) | 返回剩余百分比、重置窗口，`balances` 为空 | 不能把额度百分比下降换算成 token |
| [Hub ACP 桥接](../antigravity-hub/src/hub/acp.mjs) | 目前未转发 token 用量 | 现有桥接不能直接提供消耗账本 |

本机安装的 Paseo 为 0.8.0。检查其 SDK 和服务端实现发现：

- `AgentUsage` 有输入、缓存输入、输出等字段；`agent.lastUsage` 是最近一次用量快照，不是统一的历史累计账本。
- Codex 适配器的 `toAgentUsage()` 读取 `tokenUsage.last`；直接把最后一条快照作为整个会话用量会漏计。
- 通用 ACP 的 `usage_update` 映射为上下文已用量、上下文容量和可选费用，没有统一的请求输入/输出 token 明细。
- 插件生命周期支持 `agent.turn_ended` 等事件，可用来触发刷新，但只监听这些事件会漏掉 Paseo 外的 CLI 会话和安装前的历史。

因此，主数据源应是各家本地用量记录，Paseo 事件可以辅助刷新和会话归属关联。

## 2. 各数据源的可行性与本机证据

### Codex：可行，已验证用量字段

默认检查 `~/.codex/sessions/**/*.jsonl` 和 `~/.codex/archived_sessions/**/*.jsonl`，并支持实际配置的数据目录。

本机抽样的 30 个近期文件均来自 CLI 0.153.2，同时包含两种记录：

- `token_usage_record`：`payload.usage` 是请求用量，另有 `response_id`、线程和轮次标识。
- `event_msg / token_count`：包含 `total_token_usage` 与 `last_token_usage`。

抽样时分别读到 729 条上述两种记录。**它们不能作为两份独立消耗相加。** 新格式可优先使用请求记录；旧格式需要根据累计值计算新增消耗，并识别继承的父会话历史、重放、归档副本和计数回退。

已看到输入、缓存输入、输出、推理输出和总 token 字段。样本满足总量等于输入加输出；缓存输入属于输入，推理输出属于输出，不能重复加算。模型可结合对应 `turn_context` 识别。

官方 App Server 也提供 `thread/tokenUsage/updated` 事件，可作为实时接入的补充。[OpenAI 官方文档](https://learn.chatgpt.com/docs/app-server)

### Claude Code：可行，已验证用量字段

默认检查 `~/.claude/projects/**/*.jsonl`，包含存在时的子代理记录；还需支持 `CLAUDE_CONFIG_DIR`。

本机两个会话样本的 assistant 消息中存在 `message.usage`，包括 `input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`，并有消息 ID 和模型字段。这两个样本实际使用 GLM 模型，证明不能把「Claude Code 客户端」直接等同于「Anthropic 供应商」。

相同消息的流式片段、更新记录、分支复制需要去重；缺少 `requestId` 时不能因此丢掉所有记录。本次样本较少，尚未验证全部流式和子代理情况。

官方文档确认本地 JSONL 存储位置，并说明历史默认会清理、也可以关闭持久化。因此只能回填仍然保留的数据。[Claude Code 会话文档](https://code.claude.com/docs/en/sessions)

若以后需要更完整地采集新增调用，可以评估官方 OpenTelemetry 计数器，它按输入、输出、缓存读取和缓存创建分类，并支持区分主会话、子代理及辅助请求；该方案需要额外启用采集。[Claude Code 监控文档](https://code.claude.com/docs/en/monitoring-usage)

### Kimi：可行，已验证当前格式；要兼容新旧版本

本机使用 `~/.kimi-code/sessions/`，当前目录下按会话、agent 保存 `wire.jsonl`。官方文档也描述了这一存储布局。[Kimi 会话文档](https://www.kimi.com/code/docs/kimi-code-cli/guides/sessions)

本机近期 30 个 JSONL 文件中找到 83 条 `usage.record`，本次样本的 `usageScope` 均为 `turn`，包含模型和时间，以及：

- `usage.inputOther`
- `usage.output`
- `usage.inputCacheRead`
- `usage.inputCacheCreation`

较早的 Kimi CLI 使用 `~/.kimi/sessions/` 和 `StatusUpdate.token_usage`，字段为 snake_case。旧协议明确区分未缓存输入与缓存输入。[Kimi Wire 文档](https://moonshotai.github.io/kimi-cli/en/customization/wire-mode.html)

适配器应区分版本、scope 和事件用途。`context_tokens`、`token_counting.turn_recorded.tokens` 属于上下文计数，不能当作请求消耗；累计的 session scope 也不能再与逐次用量相加。ccusage 的 Kimi 文档已说明新旧记录及 scope 的处理方式，其支持仍标记为实验性。[ccusage Kimi 数据源](https://ccusage.com/guide/kimi/)

### Grok Build：可行，已验证实际用量字段

本机已安装 Grok，命令链接指向 `grok-1.0.30-linux-x86_64`。默认会话目录为 `~/.grok/sessions/`，还需支持 `GROK_HOME`。

本次扫描发现 66 个 `updates.jsonl`，其中有 199 条 `turn_completed`，190 条带非零用量。记录位于 `params.update.usage`，包括 `inputTokens`、`outputTokens`、`totalTokens`、`cachedReadTokens`、`cacheCreationTokens`、`reasoningTokens`、`modelCalls`、`modelUsage` 等。样本模型为 `grok-4.6-build`。这是原始记录数量，未去重，也不是 API 调用次数或本机完整总量。

此外，找到 27 个 `usage.json`；抽样包含 `session` 汇总和带 `endedAt`、`turnNumber` 的 `turns` 明细。官方提供 `grok usage <session-id> [turn]`，返回上述结构的 JSON，并建议通过该命令读取持久化用量。官方同时说明会话总量包含 resume/fork 继承的历史，汇总多个会话时必须排除重复继承部分。[Grok 官方会话文档](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md)

ccusage 已提供 Grok 数据源和日/月/会话 JSON 报告，读取带完整 usage 的已结束轮次。其文档说明输入包含缓存、推理属于输出，以及未生成完成记录的中断轮次可能漏计。[ccusage Grok 数据源](https://ccusage.com/guide/grok/)

实施时应校验官方命令、`usage.json` 与 `turn_completed` 的对应关系，并选定主数据源；不能将三者相加。`signals.json` 的上下文占用和流中的 `_meta.totalTokens` 也不能未经语义核验就累计。当前已确认 Grok 可以接入；完整历史和异常退出覆盖仍需对账。

### Antigravity：有明确方案，本机仍需解析对账

本机发现：

- `~/.gemini/antigravity/conversations/` 中有 167 个 `.db`。
- `~/.gemini/antigravity-cli/conversations/` 中有 4 个 `.db`。
- 两个 CLI 数据库抽样成功只读打开，存在 `gen_metadata(idx, data, size)`、`steps`、`trajectory_metadata_blob` 等表；生成元数据分别有 1 和 10 行。

ccusage 的专用读取器从 SQLite 中解析 protobuf 用量数据，并处理模型、缓存、推理和重复记录，说明这条路线已有实现参考。[ccusage Antigravity 数据源](https://ccusage.com/guide/antigravity/)

本次没有完成 protobuf 数值解析；另有两个主 Antigravity 目录的数据库只读打开失败，原因尚未确认。实施前需要解决实际运行权限、SQLite WAL 并发读取和格式兼容，并抽样核对 token 总量。不能把存在数据库表当成已经验证了全部消耗，也不能把读取失败显示为零。

## 3. 推荐接入方案

### 优先验证复用 ccusage

ccusage 当前文档列出以上五类数据源，并提供日、周、月、会话汇总及 JSON 输出，适合用作采集后端候选。[项目说明](https://github.com/ccusage/ccusage)、[JSON 输出文档](https://ccusage.com/guide/json-output)

建议先固定一个发布版本，用本机真实样本核验新 Codex 请求记录、Kimi 当前格式、Grok 完成轮次与会话分支，以及 Antigravity 数据库，核验通过后由插件调用本地可执行文件并缓存汇总。使用离线模式，避免为了显示 token 而刷新价格。仅参考文档不足以确认所选发布版本已经包含所有支持，本次未安装或运行 ccusage。

| 方案 | 优点 | 代价 | 建议 |
| --- | --- | --- | --- |
| 固定版本 ccusage + 插件展示 | 多数据源适配已有基础，便于后续扩展 | 需要管理可执行文件、输出版本和扫描开销；仍需对账 | 优先做兼容性验证 |
| 插件自带各家解析器 | 精确控制增量扫描、归属和缓存 | 持续维护格式、去重和 Antigravity protobuf | 复用不能满足时再采用 |
| 只读 Paseo `lastUsage` | 接口简单 | 历史不完整，遗漏终端调用，各家语义不同 | 不适合当前范围 |

无论选择哪种读取器，建议把它封装为服务端适配层，界面只依赖统一统计结果。刷新可先按 30–60 秒调度，合并并发请求；实际间隔由本机扫描耗时决定。需要长期保留历史时，再持久化去重后的请求用量，而不是把每次扫描的累计结果反复相加。

## 4. 展示与统计口径

首版建议：

- 「今日 / 近 7 天 / 本月 / 自定义」时间范围，明确使用的时区。
- 默认按供应商或配置渠道汇总，支持展开模型；另保留客户端来源，例如 Codex、Claude Code、Kimi、Grok、Antigravity。
- 显示总 token、输入、输出，以及输入中的缓存读取/写入。推理 token 在有数据时作为输出明细展示。
- 显示数据来源、最近扫描时间，以及未识别、不可读、记录不完整的状态。
- 在顶栏额度弹层内增加消耗摘要，完整明细使用适合手机和桌面的面板。

建议统一为：`总 token = 输入总量（含缓存）+ 输出总量（含推理）`。Claude/Kimi 的新鲜输入需加上两类缓存输入才能得到输入总量；Codex 样本的输入已经包含缓存读取。各适配器负责转换，未知字段保留未知，不凭缺失值认定为零。

客户端、模型家族和实际请求渠道应分别保存。模型名只能辅助识别，不能证明请求最终由哪个服务商承接；自定义中转或别名缺少历史归属时显示「未知渠道」或用户配置的标签，不能用当前配置追溯猜测所有旧会话。

token 数来自上游记录，代表可观察到的消耗。请求失败、压缩、重试和辅助调用若有用量记录也应计入，但同一次调用的父/子会话副本或多种日志表示只能算一次。订阅额度与 API 费用采用不同口径；首版专注 token，后续费用功能需单独标记估算与实付。

## 5. 实施前的验收重点

1. 用上述四家本地 JSON/JSONL 与 Antigravity 数据库各选真实样本，对照原始字段确认映射和总量。
2. 同一批数据扫描两次、重启采集器、归档或复制日志后，总量不重复增加。
3. Codex 两种事件同时存在、子代理继承父历史、Claude 消息更新、Kimi 多 scope、Grok 分支继承与完成记录缺失、Antigravity 重试记录都有针对性校验。
4. 扫描跨日会话、模型切换和不同时区时，新增用量归到正确日期与模型。
5. 遇到半行 JSONL、日志截断、未知格式、数据库锁定时明确保留错误和已有结果，不能伪装为零。
6. 确认所选后端输出字段、安装方式及 Linux/macOS 兼容性，再接入插件展示。

当前可行性已确认；尚待实施阶段完成解析器选型、Antigravity 对账、去重校验和界面开发。
